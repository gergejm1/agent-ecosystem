/*
  LEDGER digest — pipeline self-analytics, computed in plain code.

  This is deliberately NOT an LLM agent. agents/ledger.md's v1 scope is file
  analysis (count runs, flag stale drafts, report throughput), so implementing it
  as code makes it a real recurring cloud workload that costs nothing to run on a
  schedule. That is what lets the Azure deployment run a genuine cron job without
  a per-token API bill.

  Two sources, chosen by env:

    Local   node agents/digest.js
              reads events.jsonl + drafts/ directly, appends events via lib.js

    Remote  ECOSYS_REMOTE_URL + ECOSYS_TOKEN set
              READS the server's /api/events and /api/drafts, and POSTs back to
              /api/events. This matters: as an Azure Container Apps Job it runs in
              its own container with its own empty filesystem, so a local read
              would report "the pipeline is idle" every single morning.

  Dedupe is log-based, not file-based: it compares against the most recent DIGEST
  block already in the event log. A container job has an ephemeral filesystem, so
  a state file would never survive to suppress the next run.
*/
"use strict";
const fs = require("fs");
const path = require("path");
const { sanitizeEvent, appendEvent, EVENTS_FILE, DRAFTS, PIPELINE_AGENTS } = require("./lib.js");

const REMOTE = (process.env.ECOSYS_REMOTE_URL || "").replace(/\/+$/, "");
const TOKEN = process.env.ECOSYS_TOKEN || "";
const DAY = 24 * 60 * 60 * 1000;
const force = process.argv.includes("--force");

const isDigestEvent = e =>
  e && e.agent === "LEDGER" && typeof e.text === "string" && e.text.startsWith("DIGEST:");

/* ---------------- sources ---------------- */

async function remoteJson(pathname) {
  const res = await fetch(REMOTE + pathname, {
    headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`GET ${pathname} → ${res.status}`);
  return res.json();
}

async function loadLocal() {
  const events = fs.existsSync(EVENTS_FILE)
    ? fs.readFileSync(EVENTS_FILE, "utf8").split(/\r?\n/).filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  const count = dir => { try { return fs.readdirSync(dir).filter(f => f.endsWith(".json")).length; } catch { return 0; } };
  const cutoff = Date.now() - 3 * DAY;
  let stale3d = 0;
  try {
    for (const f of fs.readdirSync(DRAFTS.pending).filter(f => f.endsWith(".json"))) {
      try { if (fs.statSync(path.join(DRAFTS.pending, f)).mtimeMs < cutoff) stale3d++; } catch { /* skip */ }
    }
  } catch { /* no dir yet */ }
  return { events, pending: count(DRAFTS.pending), approved: count(DRAFTS.approved),
    rejected: count(DRAFTS.rejected), stale3d };
}

async function loadRemote() {
  const { events } = await remoteJson("/api/events?since=0");
  const drafts = await remoteJson("/api/drafts");
  const cutoff = Date.now() - 3 * DAY;
  const stale3d = drafts.filter(d => {
    const t = Date.parse(d.created);
    return Number.isFinite(t) && t < cutoff;
  }).length;
  // approved/rejected are not exposed as folders over HTTP, so derive them from
  // the gate's own audit trail — which is the authoritative record anyway.
  const gate = events.filter(e => e.agent === "GATE");
  return {
    events,
    pending: drafts.length,
    approved: gate.filter(e => typeof e.text === "string" && e.text.startsWith("APPROVED:")).length,
    rejected: gate.filter(e => typeof e.text === "string" && e.text.startsWith("REJECTED:")).length,
    stale3d,
  };
}

/* ---------------- analysis ---------------- */

function build(src) {
  // Exclude the digest's own past output, or every snapshot differs from the last
  // and the "emit only on change" guard can never fire.
  const events = src.events.filter(e => !isDigestEvent(e));
  const weekAgo = Date.now() - 7 * DAY;
  const tsOf = e => { const t = Date.parse(e.ts); return Number.isFinite(t) ? t : 0; };
  const recent = events.filter(e => tsOf(e) >= weekAgo);

  const runs = recent.filter(e => typeof e.text === "string" && e.text.startsWith("RUN COMPLETE"));
  const runsByAgent = {};
  for (const r of runs) runsByAgent[r.agent] = (runsByAgent[r.agent] || 0) + 1;

  const lastSeen = {};
  for (const e of events) {
    const t = tsOf(e);
    if (t && (!lastSeen[e.agent] || t > lastSeen[e.agent])) lastSeen[e.agent] = t;
  }
  // ATLAS orchestrates and LEDGER is this script — neither is "idle" in the sense
  // that matters, which is an agent that stopped producing work.
  const idleAgents = PIPELINE_AGENTS.filter(a => a !== "ATLAS" && a !== "LEDGER"
    && (!lastSeen[a] || lastSeen[a] < weekAgo));

  return {
    total: events.length,
    runs7d: runs.length,
    runsByAgent,
    failures7d: recent.filter(e => e.kind === "crit").length,
    tokens7d: recent.reduce((n, e) => n + (Number.isFinite(e.tokens) ? e.tokens : 0), 0),
    pending: src.pending, approved: src.approved, rejected: src.rejected,
    stale3d: src.stale3d, idleAgents,
  };
}

function lines(s) {
  const byAgent = Object.entries(s.runsByAgent).sort((a, b) => b[1] - a[1])
    .map(([a, n]) => `${a} ${n}`).join(" · ") || "none";
  const out = [
    ["info", `DIGEST: ${s.runs7d} agent run(s) in the last 7 days (${byAgent}) · ` +
      `${s.tokens7d.toLocaleString("en-US")} tokens · ${s.total} events logged total`],
    ["info", `DIGEST: approval queue — ${s.pending} pending · ${s.approved} approved · ${s.rejected} rejected`],
  ];
  if (s.stale3d > 0) out.push(["warn",
    `DIGEST: ${s.stale3d} draft(s) pending more than 3 days — the review queue is aging`]);
  if (s.failures7d > 0) out.push(["warn",
    `DIGEST: ${s.failures7d} agent run(s) failed in the last 7 days — check the feed for RUN FAILED lines`]);
  if (s.idleAgents.length) out.push(["warn",
    `DIGEST: no activity in 7+ days from ${s.idleAgents.join(", ")} — schedule a run or retire them`]);
  if (s.runs7d === 0) out.push(["warn",
    "DIGEST: no agent runs at all in the last 7 days — the pipeline is idle"]);
  return out;
}

/* Log-based dedupe: the trailing DIGEST block in the log IS the previous run's
   state. Works identically on an ephemeral container filesystem. */
function unchanged(allEvents, newTexts) {
  const prior = [];
  for (let i = allEvents.length - 1; i >= 0; i--) {
    if (isDigestEvent(allEvents[i])) prior.unshift(allEvents[i].text);
    else if (prior.length) break;
  }
  // Consecutive quiet-then-emit cycles leave several digest blocks adjacent at the
  // end of the log, so compare against the LAST block-sized slice, not all of them.
  const tail = prior.slice(-newTexts.length);
  return tail.length === newTexts.length && tail.every((t, i) => t === newTexts[i]);
}

async function publish(events) {
  if (!REMOTE) {
    for (const e of events) appendEvent(e);
    return "local file";
  }
  const res = await fetch(REMOTE + "/api/events", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify(events),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`POST /api/events → ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
  return REMOTE + "/api/events";
}

(async () => {
  const src = REMOTE ? await loadRemote() : await loadLocal();
  const texts = lines(build(src)).map(([, t]) => t);

  if (!force && unchanged(src.events, texts)) {
    console.log("digest: nothing changed since the last digest — emitting nothing (use --force to override)");
    return;
  }

  const events = lines(build(src))
    .map(([kind, text]) => sanitizeEvent({ agent: "LEDGER", station: "analytics", kind, text }))
    .filter(Boolean);

  const via = await publish(events);
  console.log(`digest: emitted ${events.length} event(s) via ${via}`);
  for (const e of events) console.log("  " + e.text);
})().catch(err => {
  console.error("digest: FAILED —", err.message);
  process.exitCode = 1;
});
