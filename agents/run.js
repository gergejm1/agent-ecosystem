/*
  Agent runner — executes one marketing agent headlessly via the Claude Code CLI
  and feeds its output into the ecosystem (events.jsonl + drafts/pending/).

  Usage:
    node agents/run.js vector                  # real run (uses claude CLI, costs tokens)
    node agents/run.js quill "topic or path"   # agents that take an input get it as $TASK
    node agents/run.js vector --mock           # replay agents/mock/vector.json, no CLI call

  The agent's spec lives in agents/<name>.md. Its output contract: final message
  is ONE JSON object {"events":[...],"drafts":[...]} — validated here before
  anything touches disk. Drafts are never published; they await human approval.
*/
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { sanitizeEvent, appendEvent, writeDraft } = require("./lib.js");

const AGENT_DIR = __dirname;
const name = (process.argv[2] || "").toLowerCase();
const extra = process.argv.slice(3).filter(a => a !== "--mock").join(" ");
const mock = process.argv.includes("--mock");

const specPath = path.join(AGENT_DIR, name + ".md");
if (!name || !fs.existsSync(specPath)) {
  console.error("Usage: node agents/run.js <vector|sentinel|quill|echo|ledger|hunter|scope|envoy> [task] [--mock]");
  process.exit(1);
}

const STATION_OF = { vector: "trend", sentinel: "listen", quill: "foundry", echo: "relay", ledger: "analytics", hunter: "listen", scope: "listen", envoy: "relay" };
const AGENT_ID = name.toUpperCase();
const station = STATION_OF[name] || "hub";

function emit(kind, text, tokens) {
  appendEvent(sanitizeEvent({ agent: AGENT_ID, station, kind, text, tokens }));
}

function extractJson(s) {
  try { return JSON.parse(s); } catch {}
  // string-aware balanced-brace scan: braces inside JSON strings must not move the depth counter
  const start = s.indexOf("{");
  for (let i = start; i >= 0 && i < s.length; i = s.indexOf("{", i + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (esc) { esc = false; continue; }
      if (c === "\\") { if (inStr) esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) {
        try { return JSON.parse(s.slice(i, j + 1)); } catch {} break;
      } }
    }
  }
  return null;
}

let output;
if (mock) {
  const mockPath = path.join(AGENT_DIR, "mock", name + ".json");
  if (!fs.existsSync(mockPath)) { console.error("No mock fixture at " + mockPath); process.exit(1); }
  output = JSON.parse(fs.readFileSync(mockPath, "utf8"));
  console.log(`[${AGENT_ID}] mock run — replaying ${mockPath}`);
} else {
  const spec = fs.readFileSync(specPath, "utf8");
  const prompt = [
    spec,
    extra ? `\n## TASK INPUT\n${extra}` : "",
    `\n## OUTPUT CONTRACT (STRICT)
Your FINAL message must be ONE JSON object and nothing else — no markdown fences, no prose:
{"events":[{"agent":"${AGENT_ID}","station":"${station}","kind":"info|warn|crit","text":"...","tokens":0}],
 "drafts":[{"kind":"BLOG|LINKEDIN|CAROUSEL|REPLY|PEOPLE|DM","app":"SEATCMP","title":"...","body":"one-line summary","content":"full draft text/markdown"}]}
Events: 3-8 concise, source-backed findings. Drafts: only if your role produces them. Omit "tokens" (the runner records real usage).`,
  ].join("\n");

  console.log(`[${AGENT_ID}] launching headless Claude run… (this uses your Claude Code account)`);
  emit("info", `RUN START: ${AGENT_ID} tasked${extra ? ` — "${extra.slice(0, 80)}"` : ""}`);

  // one static command string (prompt goes via stdin) — avoids DEP0190 shell-arg concatenation
  const res = spawnSync(
    "claude -p --output-format json --model opus --max-turns 50 --allowedTools WebSearch,WebFetch,Read,Grep,Glob",
    { input: prompt, encoding: "utf8", shell: true, maxBuffer: 32 * 1024 * 1024, timeout: 15 * 60 * 1000 });

  if (res.error || res.status !== 0) {
    const msg = (res.error && res.error.message) || (res.stderr || "").slice(0, 300) || `exit ${res.status}`;
    emit("crit", `RUN FAILED: ${AGENT_ID} — ${msg}`);
    console.error(`[${AGENT_ID}] FAILED:`, msg);
    process.exit(1);
  }

  let cli;
  try { cli = JSON.parse(res.stdout); } catch { cli = null; }
  // A CLI-level failure can exit 0 (max-turns, is_error) — never fall back to parsing the
  // envelope itself, or a failed run masquerades as a successful empty one.
  if (!cli || cli.is_error || typeof cli.result !== "string") {
    const why = !cli ? "unparseable CLI output" : (cli.subtype || "CLI reported an error");
    emit("crit", `RUN FAILED: ${AGENT_ID} — ${why}`);
    console.error(`[${AGENT_ID}] FAILED: ${why}. stdout head:\n` + res.stdout.slice(0, 400));
    process.exit(1);
  }
  output = extractJson(cli.result);
  if (!output || (!Array.isArray(output.events) && !Array.isArray(output.drafts))) {
    emit("crit", `RUN FAILED: ${AGENT_ID} returned no parseable {events,drafts} JSON`);
    console.error(`[${AGENT_ID}] no valid output contract. Result head:\n` + cli.result.slice(0, 400));
    process.exit(1);
  }
  // record real token usage: on the first event, else carried onto the RUN COMPLETE line
  const used = cli.usage ? (cli.usage.input_tokens || 0) + (cli.usage.output_tokens || 0) : 0;
  if (used && Array.isArray(output.events) && output.events[0] && typeof output.events[0] === "object") output.events[0].tokens = used;
  else if (used) output._unattributedTokens = used;
}

let nEvents = 0, nDrafts = 0;
for (const raw of Array.isArray(output.events) ? output.events : []) {
  const evt = sanitizeEvent({ agent: AGENT_ID, station, ...raw });
  if (evt && appendEvent(evt)) nEvents++;
}
for (const d of Array.isArray(output.drafts) ? output.drafts : []) {
  if (!d || typeof d !== "object" || !d.title) continue;
  const id = writeDraft({ agent: AGENT_ID, ...d });
  emit("draft", `${(d.kind || "DRAFT").toUpperCase()} filed to Approval Gate — "${String(d.title).slice(0, 120)}" [${d.app || "SEATCMP"}]`);
  nDrafts++;
  console.log(`[${AGENT_ID}] draft → drafts/pending/${id}.json`);
}
emit("info", `RUN COMPLETE: ${AGENT_ID} — ${nEvents} findings, ${nDrafts} draft(s) filed`, output._unattributedTokens || 0);
console.log(`[${AGENT_ID}] done: ${nEvents} events, ${nDrafts} drafts.`);
