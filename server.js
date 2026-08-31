/*
  ECOSYS server — turns agent-ecosystem.html into live mission control.
  Zero dependencies. Run:  node server.js   →  http://localhost:4242

  API:
    GET  /healthz                       → "ok" (never authenticated; probes can't send headers)
    GET  /api/events?since=N            → { events: [...], next: M }
    POST /api/events                    → append validated event(s)            [auth]
    GET  /api/drafts                    → pending drafts (metadata, no content)
    GET  /api/drafts/<id>               → one full draft incl. content
    GET  /draft/<id>                    → human-readable HTML view
    POST /api/drafts/<id>/approve       → move to drafts/approved + feed event  [auth]
    POST /api/drafts/<id>/reject        → move to drafts/rejected + feed event  [auth]

  Agents (agents/run.js) append events + write drafts directly to disk;
  the dashboard polls this server. Approving a draft does NOT publish it —
  it moves the file to drafts/approved/ for the founder to post manually.

  ENV (all unset = local mode, behaves exactly as it always has):
    ECOSYS_PORT      listen port                     (default 4242)
    ECOSYS_BIND      bind address                    (default 127.0.0.1)
    ECOSYS_TOKEN     when set, [auth] routes require `Authorization: Bearer <token>`
                     and the dashboard renders the queue read-only via /api/config
    ECOSYS_DATA_DIR  where events.jsonl and drafts/ live (default: repo root).
                     Tests point this at a temp dir; the container points it at /data.

  Two safety properties worth preserving if you edit this file:
    1. Static serving is an exact-match allowlist (STATIC_ALLOW). The repo root
       holds private material; never serve a path built from the request.
    2. A non-loopback bind without ECOSYS_TOKEN refuses to start.
*/
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { sanitizeEvent, appendEvent, escHtml, linkify, EVENTS_FILE, DRAFTS } = require("./agents/lib.js");

const ROOT = __dirname;
// Deliberately NOT process.env.PORT — lots of dev tooling sets that, and it would
// silently move the local server off 4242 and break the ?selftest=1 workflow.
const PORT = process.env.ECOSYS_PORT ? Number(process.env.ECOSYS_PORT) : 4242;
const BIND = process.env.ECOSYS_BIND || "127.0.0.1";
const TOKEN = process.env.ECOSYS_TOKEN || "";

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`REFUSING TO START: ECOSYS_PORT must be an integer 1-65535, got "${process.env.ECOSYS_PORT}".`);
  process.exit(1);
}

// Interlock: a non-loopback bind with no token would publish an unauthenticated,
// state-mutating API. Refuse to start rather than let that ever happen by accident.
// "localhost" is deliberately NOT trusted here — it is a name, and a hosts entry
// could point it at a routable address while satisfying the check.
const LOOPBACK = new Set(["127.0.0.1", "::1"]);
if (!LOOPBACK.has(BIND) && !TOKEN) {
  console.error(`REFUSING TO START: ECOSYS_BIND is non-loopback (${BIND}) but ECOSYS_TOKEN is unset.\n` +
    "That would expose an unauthenticated, state-mutating API to the network. Set ECOSYS_TOKEN.");
  process.exit(1);
}
if (!LOOPBACK.has(BIND) && TOKEN.length < 32) {
  console.error(`REFUSING TO START: ECOSYS_TOKEN is ${TOKEN.length} chars; a network-reachable ` +
    "deployment requires at least 32. Generate one with: openssl rand -hex 24");
  process.exit(1);
}

/* Constant-time bearer check. SHA-256 both sides first: timingSafeEqual throws
   on length mismatch, which would otherwise leak length via an exception. */
function authorized(req) {
  if (!TOKEN) return true; // no token configured = local mode, unchanged behavior
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  if (!m) return false;
  const a = crypto.createHash("sha256").update(m[1]).digest();
  const b = crypto.createHash("sha256").update(TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

/* CSRF guard for mutating routes. A no-header `fetch(url,{method:"POST"})` is a
   CORS *simple* request, so it is sent without preflight — meaning any page the
   operator visits could otherwise approve drafts on localhost:4242. Server-to-
   server callers (the digest job, curl) send neither header and pass. */
function sameOriginRequest(req) {
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) return false; }
    catch { return false; }
  }
  return true;
}

// Applied to both HTML responses, in every mode, so a CSP mistake surfaces in
// local testing rather than after deployment. The dashboard and the draft view
// are both single self-contained files with inline script and style.
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
};

// Exactly what the static handler will serve. The dashboard has zero external
// asset references, so a one-entry allowlist costs nothing and removes any
// possibility of serving CLAUDE.md, jobhunt/, research/, or agent prompts.
const STATIC_ALLOW = new Set(["agent-ecosystem.html"]);

for (const d of [DRAFTS.pending, DRAFTS.approved, DRAFTS.rejected]) fs.mkdirSync(d, { recursive: true });

function readEventLines() {
  if (!fs.existsSync(EVENTS_FILE)) return [];
  return fs.readFileSync(EVENTS_FILE, "utf8").split(/\r?\n/).filter(Boolean);
}

function listDrafts() {
  return fs.readdirSync(DRAFTS.pending).filter(f => f.endsWith(".json")).map(f => {
    try {
      // content stays on disk — the dashboard list only needs the metadata
      const { content, ...meta } = JSON.parse(fs.readFileSync(path.join(DRAFTS.pending, f), "utf8"));
      return { id: path.basename(f, ".json"), ...meta, contentChars: (content || "").length };
    } catch { console.warn("skipping corrupt draft file: " + f); return null; }
  }).filter(Boolean);
}

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", ...SECURITY_HEADERS });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => { data += c; if (data.length > 1e6) { reject(new Error("body too large")); req.destroy(); } });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json",
  ".css": "text/css", ".png": "image/png", ".md": "text/plain; charset=utf-8", ".svg": "image/svg+xml" };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  console.log(`${new Date().toISOString().slice(11, 19)} ${req.method} ${p}`);

  try {
    // Unauthenticated by design: container liveness/readiness probes cannot send headers.
    if (p === "/healthz" && (req.method === "GET" || req.method === "HEAD")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end(req.method === "HEAD" ? "" : "ok");
    }

    // Lets the dashboard know writes are gated, so it renders the approval queue
    // read-only instead of showing buttons that would 401. Without this the
    // deployed approval gate looks functional and silently fails.
    if (p === "/api/config" && req.method === "GET") {
      return json(res, 200, { demo: !!TOKEN, writesRequireAuth: !!TOKEN });
    }

    if (p === "/api/events" && req.method === "GET") {
      // parse only the lines past the cursor — the log grows forever, polls are every 5s
      const lines = readEventLines();
      const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
      const events = lines.slice(since).map(l => {
        try { return JSON.parse(l); } catch { console.warn("skipping corrupt event line"); return null; }
      }).filter(Boolean);
      return json(res, 200, { events, next: lines.length });
    }
    if (p === "/api/events" && req.method === "POST") {
      if (!sameOriginRequest(req)) return json(res, 403, { error: "cross-origin request refused" });
      if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: "invalid JSON" }); }
      const list = Array.isArray(body) ? body : [body];
      const accepted = [];
      for (const raw of list) {
        const evt = sanitizeEvent(raw);
        if (evt) { appendEvent(evt); accepted.push(evt); }
      }
      if (!accepted.length) return json(res, 400, { error: "no valid events" });
      return json(res, 200, { ok: true, accepted: accepted.length });
    }
    if (p === "/api/drafts" && req.method === "GET") {
      return json(res, 200, listDrafts());
    }
    const md = p.match(/^\/api\/drafts\/([\w-]+)$/);
    if (md && req.method === "GET") { // full draft incl. content, so the founder can read before approving
      const f = path.join(DRAFTS.pending, md[1] + ".json");
      if (!path.resolve(f).startsWith(path.resolve(DRAFTS.pending) + path.sep)) return json(res, 403, { error: "bad id" });
      if (!fs.existsSync(f)) return json(res, 404, { error: "draft not found" });
      try { return json(res, 200, { id: md[1], ...JSON.parse(fs.readFileSync(f, "utf8")) }); }
      catch { return json(res, 500, { error: "draft file is corrupt" }); }
    }
    const mv = p.match(/^\/draft\/([\w-]+)$/);
    if (mv && req.method === "GET") { // human-readable draft view (any status) with clickable links
      const escH = escHtml;
      for (const [status, dir] of [["PENDING", DRAFTS.pending], ["APPROVED", DRAFTS.approved], ["REJECTED", DRAFTS.rejected]]) {
        const f = path.join(dir, mv[1] + ".json");
        if (!path.resolve(f).startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(f)) continue;
        let d;
        try { d = JSON.parse(fs.readFileSync(f, "utf8")); }
        catch { res.writeHead(500, { "Content-Type": "text/plain" }); return res.end("draft file is corrupt"); }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...SECURITY_HEADERS });
        return res.end(`<!doctype html><title>${escH(d.title)}</title>
<style>body{background:#04100a;color:#b8f4cc;font-family:ui-monospace,Consolas,monospace;max-width:860px;margin:30px auto;padding:0 16px;line-height:1.55}
a{color:#41ff8a}h1{color:#eafff1;font-size:20px;margin:6px 0}pre{white-space:pre-wrap;border:1px solid #14522e;background:#071710;padding:16px;margin-top:14px;font:inherit}</style>
<body><div style="color:#41855e;letter-spacing:.14em;font-size:12px">${escH(d.kind || "DRAFT")} · ${escH(d.app || "")} · by ${escH(d.agent || "")} · ${status}</div>
<h1>${escH(d.title)}</h1>
<div style="color:#6bcb90;font-style:italic">${escH(d.body || "")}</div>
<pre>${linkify(d.content || "(no content)")}</pre>
<div style="color:#41855e;font-size:11px">links open in a new tab · close this tab to return to mission control</div></body>`);
      }
      res.writeHead(404); return res.end("draft not found");
    }
    const m = p.match(/^\/api\/drafts\/([\w-]+)\/(approve|reject)$/);
    if (m && req.method === "POST") {
      if (!sameOriginRequest(req)) return json(res, 403, { error: "cross-origin request refused" });
      if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
      const [, id, action] = m;
      const src = path.join(DRAFTS.pending, id + ".json");
      // defense-in-depth: the regex should make escape impossible, but assert containment anyway
      if (!path.resolve(src).startsWith(path.resolve(DRAFTS.pending) + path.sep)) return json(res, 403, { error: "bad id" });
      if (!fs.existsSync(src)) return json(res, 404, { error: "draft not found" });
      let draft = { title: id, agent: "agent" };
      try { draft = JSON.parse(fs.readFileSync(src, "utf8")); }
      catch { console.warn("corrupt draft " + id + " — moving it anyway"); }
      const destDir = action === "approve" ? DRAFTS.approved : DRAFTS.rejected;
      fs.renameSync(src, path.join(destDir, id + ".json"));
      appendEvent(sanitizeEvent(action === "approve"
        ? { agent: "GATE", station: "uplink", kind: "pub",
            text: `APPROVED: "${draft.title}" → drafts/approved/${id}.json — ready for the founder to post` }
        : { agent: "GATE", station: "approval", kind: "warn",
            text: `REJECTED: "${draft.title}" → returned to ${draft.agent || "agent"} (drafts/rejected/${id}.json)` }));
      return json(res, 200, { ok: true });
    }

    // Static files: exact-match allowlist only. No path is ever built from user
    // input, so traversal is not merely blocked — it is unrepresentable.
    if (req.method === "GET") {
      const file = p === "/" ? "agent-ecosystem.html" : p.slice(1);
      if (STATIC_ALLOW.has(file)) {
        const full = path.join(ROOT, file);
        if (fs.existsSync(full) && fs.statSync(full).isFile()) {
          res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream", ...SECURITY_HEADERS });
          return res.end(fs.readFileSync(full));
        }
      }
    }
    res.writeHead(404); res.end("not found");
  } catch (err) {
    // Detail stays server-side: err.message can carry filesystem paths.
    console.error("ERROR", req.method, p, err.message);
    json(res, 500, { error: "internal error" });
  }
});

// Loopback by default; a non-loopback bind is gated on ECOSYS_TOKEN by the interlock above.
server.listen(PORT, BIND, () => {
  console.log(`ECOSYS mission control → http://${LOOPBACK.has(BIND) ? "localhost" : BIND}:${PORT}`);
  console.log(`bind: ${BIND} · auth: ${TOKEN ? "bearer token required on writes" : "none (local mode)"}`);
  console.log(`events: ${EVENTS_FILE}`);
  console.log(`drafts: ${DRAFTS.pending}`);
});
