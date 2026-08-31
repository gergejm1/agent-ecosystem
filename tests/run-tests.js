/* Test suite for the shared helpers AND the server's security surface.
   Run:  node tests/run-tests.js   (exit code 0 = all pass)

   Every spawned server gets its OWN temp ECOSYS_DATA_DIR, so no test can read,
   write, or corrupt the real events.jsonl / drafts/. Ports are allocated by the
   OS, so concurrent runs cannot collide. Every child is killed in a finally. */
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

// Point THIS process's lib.js at a temp dir before requiring it. Isolation today
// holds only because no unit test happens to call appendEvent/writeDraft; this
// makes it structural, so the next test added cannot write to the real event log.
process.env.ECOSYS_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ecosys-unit-"));
const { escHtml, linkify, sanitizeEvent, slug } = require("../agents/lib.js");

const ROOT = path.join(__dirname, "..");
let pass = 0, fail = 0;
function record(ok, name, err) {
  if (ok) { pass++; console.log("PASS  " + name); }
  else { fail++; process.exitCode = 1; console.error("FAIL  " + name + " — " + (err && err.message)); }
}
function t(name, fn) { try { fn(); record(true, name); } catch (e) { record(false, name, e); } }
async function at(name, fn) { try { await fn(); record(true, name); } catch (e) { record(false, name, e); } }

/* ================= UNIT: escHtml / linkify (the /draft view XSS barrier) ================= */
t("escHtml escapes all five dangerous characters", () => {
  assert.strictEqual(escHtml(`<a href="x" onload='y'>&`),
    "&lt;a href=&quot;x&quot; onload=&#39;y&#39;&gt;&amp;");
});
t("linkify wraps a plain URL in a safe anchor", () => {
  const o = linkify("see https://example.com/path?a=1 now");
  assert(o.includes('<a href="https://example.com/path?a=1" target="_blank" rel="noopener">'), o);
});
t("linkify neutralizes attribute-breakout payload", () => {
  const o = linkify('https://x.com"onmouseover="alert(1)');
  assert(o.includes("&quot;onmouseover="), "payload should be entity-escaped: " + o);
  assert(!/[^;]"onmouseover/.test(o), "raw-quote breakout before onmouseover: " + o);
  const rawQuotes = o.split('"').length - 1;
  const attrQuotes = (o.match(/(href|target|rel)="[^"]*"/g) || []).length * 2;
  assert.strictEqual(rawQuotes, attrQuotes, "every raw quote must belong to a known attribute: " + o);
});
t("linkify never emits raw markup from content", () => {
  const o = linkify("<script>alert(1)</script> then https://ok.com done");
  assert(!o.includes("<script"), "script must be escaped");
  assert(o.includes("&lt;script&gt;"));
  assert(o.includes('<a href="https://ok.com"'));
});
t("linkify pins the scheme (no javascript: smuggling)", () => {
  const o = linkify("javascript:alert(1) and https://real.com");
  assert(!o.includes('href="javascript:'), o);
});

/* ================= UNIT: sanitizeEvent (the ingest seam) ================= */
t("sanitizeEvent rejects null/empty/non-text", () => {
  assert.strictEqual(sanitizeEvent(null), null);
  assert.strictEqual(sanitizeEvent({}), null);
  assert.strictEqual(sanitizeEvent({ text: 123 }), null);
  assert.strictEqual(sanitizeEvent("x"), null);
});
t("sanitizeEvent whitelists agent/station/kind and caps fields", () => {
  const e = sanitizeEvent({ agent: "NOBODY", station: "nope", kind: "nope", text: "x".repeat(700), tokens: "99" });
  assert.strictEqual(e.agent, "SYS");
  assert.strictEqual(e.station, "hub");
  assert.strictEqual(e.kind, "info");
  assert.strictEqual(e.text.length, 600);
  assert.strictEqual(e.tokens, 0);
});
t("sanitizeEvent passes clean events through", () => {
  const e = sanitizeEvent({ agent: "SCOPE", station: "listen", kind: "warn", text: "ok", tokens: 42.7 });
  assert.strictEqual(e.agent, "SCOPE");
  assert.strictEqual(e.station, "listen");
  assert.strictEqual(e.kind, "warn");
  assert.strictEqual(e.tokens, 43);
});

/* ================= UNIT: slug (draft-id safety) ================= */
t("slug output stays within the draft-id charset", () => {
  assert.strictEqual(slug("Hello, World! — ok"), "hello-world-ok");
  assert(/^[\w-]*$/.test(slug('..\\..\\weird/../path"<>')));
});

/* ================= INTEGRATION HARNESS ================= */
const STRONG_TOKEN = "t".repeat(40); // network binds require >= 32 chars

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/* Spawns a server with an isolated data directory. ECOSYS_BIND is pinned rather
   than inherited: a developer with ECOSYS_BIND exported would otherwise bind the
   test server to every interface, or trip the interlock and fail confusingly. */
async function startServer(env = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecosys-test-"));
  fs.mkdirSync(path.join(dataDir, "drafts", "pending"), { recursive: true });
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: {
      ...process.env,
      ECOSYS_DATA_DIR: dataDir,
      ECOSYS_BIND: "127.0.0.1",
      ECOSYS_PORT: String(port),
      ECOSYS_TOKEN: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  let exited = false;
  child.stderr.on("data", d => { stderr += d; });
  child.stdout.on("data", () => {});
  child.on("exit", () => { exited = true; });
  return {
    child, dataDir, port,
    base: `http://127.0.0.1:${port}`,
    getStderr: () => stderr,
    hasExited: () => exited,
  };
}

async function waitForHealth(srv, ms = 8000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Fail fast with the child's own error instead of burning the full timeout.
    if (srv.hasExited()) throw new Error("server exited during startup: " + srv.getStderr().slice(0, 300));
    try { if ((await fetch(srv.base + "/healthz")).ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("server did not become healthy in time: " + srv.getStderr().slice(0, 300));
}

function waitForExit(child, ms = 8000) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("process did not exit in time")), ms);
    child.once("exit", code => { clearTimeout(timer); resolve(code); });
  });
}

async function stopServer(srv) {
  srv.child.kill("SIGKILL");
  try { await waitForExit(srv.child, 5000); } catch { /* already gone */ }
  try { fs.rmSync(srv.dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/* ================= INTEGRATION TESTS ================= */
(async () => {
  /* ---- interlock ---- */
  {
    const srv = await startServer({ ECOSYS_BIND: "0.0.0.0", ECOSYS_TOKEN: "" });
    try {
      await at("interlock: public bind with no token refuses to start", async () => {
        const code = await waitForExit(srv.child);
        assert.notStrictEqual(code, 0, "should exit non-zero");
        assert(/REFUSING TO START/.test(srv.getStderr()), "should explain why: " + srv.getStderr());
      });
    } finally { await stopServer(srv); } // never leave a public tokenless server alive
  }
  {
    const srv = await startServer({ ECOSYS_BIND: "0.0.0.0", ECOSYS_TOKEN: "short" });
    try {
      await at("interlock: public bind with a weak token refuses to start", async () => {
        const code = await waitForExit(srv.child);
        assert.notStrictEqual(code, 0);
        assert(/at least 32/.test(srv.getStderr()), srv.getStderr());
      });
    } finally { await stopServer(srv); }
  }
  {
    const srv = await startServer({ ECOSYS_PORT: "not-a-port" });
    try {
      await at("invalid ECOSYS_PORT refuses to start with a clear message", async () => {
        const code = await waitForExit(srv.child);
        assert.notStrictEqual(code, 0);
        assert(/ECOSYS_PORT must be an integer/.test(srv.getStderr()), srv.getStderr());
      });
    } finally { await stopServer(srv); }
  }

  /* ---- authenticated (cloud-shaped) mode ---- */
  {
    const srv = await startServer({ ECOSYS_TOKEN: STRONG_TOKEN });
    try {
      await waitForHealth(srv);

      await at("healthz is reachable without a token", async () => {
        const r = await fetch(srv.base + "/healthz");
        assert.strictEqual(r.status, 200);
        assert.strictEqual((await r.text()).trim(), "ok");
      });

      await at("config reports demo mode when writes are gated", async () => {
        const c = await (await fetch(srv.base + "/api/config")).json();
        assert.strictEqual(c.demo, true);
        assert.strictEqual(c.writesRequireAuth, true);
      });

      await at("dashboard is served with security headers", async () => {
        const r = await fetch(srv.base + "/");
        assert.strictEqual(r.status, 200);
        assert((await r.text()).includes("AGENT ECOSYSTEM"));
        assert(/script-src/.test(r.headers.get("content-security-policy") || ""), "CSP missing");
        assert.strictEqual(r.headers.get("x-content-type-options"), "nosniff");
        assert.strictEqual(r.headers.get("x-frame-options"), "DENY");
      });

      for (const leak of ["CLAUDE.md", "agents/lib.js", "agents/hunter.md", "package.json", "server.js"]) {
        await at(`static allowlist refuses /${leak}`, async () => {
          assert.strictEqual((await fetch(`${srv.base}/${leak}`)).status, 404);
        });
      }

      await at("POST /api/events without a token is rejected", async () => {
        const r = await fetch(srv.base + "/api/events", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent: "SYS", text: "unauthorized probe" }),
        });
        assert.strictEqual(r.status, 401);
      });

      await at("POST /api/events with a wrong token is rejected", async () => {
        const r = await fetch(srv.base + "/api/events", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + "x".repeat(40) },
          body: JSON.stringify({ agent: "SYS", text: "wrong token probe" }),
        });
        assert.strictEqual(r.status, 401);
      });

      await at("POST /api/events with the correct token is accepted and persisted", async () => {
        const r = await fetch(srv.base + "/api/events", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${STRONG_TOKEN}` },
          body: JSON.stringify({ agent: "SYS", station: "hub", kind: "info", text: "integration-test event" }),
        });
        assert.strictEqual(r.status, 200);
        assert.strictEqual((await r.json()).accepted, 1);
        const log = fs.readFileSync(path.join(srv.dataDir, "events.jsonl"), "utf8");
        assert(log.includes("integration-test event"), "event should be on disk in the TEMP dir");
      });

      await at("cross-origin mutation is refused before auth is even considered", async () => {
        const r = await fetch(srv.base + "/api/events", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${STRONG_TOKEN}`,
            Origin: "https://evil.example",
          },
          body: JSON.stringify({ agent: "SYS", text: "csrf probe" }),
        });
        assert.strictEqual(r.status, 403);
      });

      /* the happy path the previous suite never covered: an authenticated approve
         must actually move the file and append a GATE event */
      await at("authenticated approve moves the draft and logs a GATE event", async () => {
        const id = "test-draft-approve-me";
        const pending = path.join(srv.dataDir, "drafts", "pending", id + ".json");
        fs.writeFileSync(pending, JSON.stringify({
          agent: "QUILL", kind: "BLOG", app: "TEST", title: "approve me", body: "b", content: "c",
        }));

        const denied = await fetch(`${srv.base}/api/drafts/${id}/approve`, { method: "POST" });
        assert.strictEqual(denied.status, 401, "must require a token");
        assert(fs.existsSync(pending), "rejected request must not move the file");

        const ok = await fetch(`${srv.base}/api/drafts/${id}/approve`, {
          method: "POST", headers: { Authorization: `Bearer ${STRONG_TOKEN}` },
        });
        assert.strictEqual(ok.status, 200);
        assert(!fs.existsSync(pending), "draft should have left pending/");
        assert(fs.existsSync(path.join(srv.dataDir, "drafts", "approved", id + ".json")), "should be in approved/");
        const log = fs.readFileSync(path.join(srv.dataDir, "events.jsonl"), "utf8");
        assert(/"agent":"GATE"[^\n]*"kind":"pub"/.test(log), "a GATE pub event should be appended");
      });

      await at("authenticated reject moves the draft to rejected/", async () => {
        const id = "test-draft-reject-me";
        fs.writeFileSync(path.join(srv.dataDir, "drafts", "pending", id + ".json"),
          JSON.stringify({ agent: "ECHO", kind: "LINKEDIN", app: "TEST", title: "reject me", body: "b", content: "c" }));

        assert.strictEqual((await fetch(`${srv.base}/api/drafts/${id}/reject`, { method: "POST" })).status, 401);
        const ok = await fetch(`${srv.base}/api/drafts/${id}/reject`, {
          method: "POST", headers: { Authorization: `Bearer ${STRONG_TOKEN}` },
        });
        assert.strictEqual(ok.status, 200);
        assert(fs.existsSync(path.join(srv.dataDir, "drafts", "rejected", id + ".json")));
      });
    } finally { await stopServer(srv); }
  }

  /* ---- local mode: no token, no auth, exactly as before ---- */
  {
    const srv = await startServer({ ECOSYS_TOKEN: "" });
    try {
      await waitForHealth(srv);
      await at("local mode reports demo:false", async () => {
        assert.strictEqual((await (await fetch(srv.base + "/api/config")).json()).demo, false);
      });
      await at("local mode leaves writes unauthenticated", async () => {
        const r = await fetch(srv.base + "/api/drafts/does-not-exist/approve", { method: "POST" });
        assert.strictEqual(r.status, 404, "should reach the handler and 404, not 401");
      });
      await at("local mode still refuses non-allowlisted files", async () => {
        assert.strictEqual((await fetch(srv.base + "/CLAUDE.md")).status, 404);
      });
      await at("local mode still refuses cross-origin mutations", async () => {
        const r = await fetch(srv.base + "/api/drafts/does-not-exist/approve", {
          method: "POST", headers: { Origin: "https://evil.example" },
        });
        assert.strictEqual(r.status, 403);
      });
    } finally { await stopServer(srv); }
  }

  /* ---- digest: emits on change, stays quiet otherwise ---- */
  {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ecosys-digest-"));
    fs.mkdirSync(path.join(dataDir, "drafts", "pending"), { recursive: true });
    fs.mkdirSync(path.join(dataDir, "drafts", "approved"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "events.jsonl"),
      JSON.stringify({ ts: new Date().toISOString(), agent: "VECTOR", station: "trend",
        kind: "info", text: "RUN COMPLETE: VECTOR — 3 findings, 0 draft(s) filed", tokens: 1234 }) + "\n");
    fs.writeFileSync(path.join(dataDir, "drafts", "pending", "d1.json"),
      JSON.stringify({ agent: "ECHO", kind: "LINKEDIN", title: "t", body: "b", content: "c" }));

    const runDigest = () => new Promise(resolve => {
      const c = spawn(process.execPath, [path.join(ROOT, "agents", "digest.js")], {
        env: { ...process.env, ECOSYS_DATA_DIR: dataDir, ECOSYS_REMOTE_URL: "", ECOSYS_TOKEN: "" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      c.stdout.on("data", d => { out += d; });
      c.stderr.on("data", d => { out += d; });
      c.on("exit", code => resolve({ code, out }));
    });

    try {
      await at("digest emits a summary on first run", async () => {
        const r = await runDigest();
        assert.strictEqual(r.code, 0, r.out);
        assert(/DIGEST: 1 agent run/.test(r.out), r.out);
        assert(/1 pending/.test(r.out), r.out);
      });

      await at("digest stays silent when nothing changed", async () => {
        const r = await runDigest();
        assert.strictEqual(r.code, 0, r.out);
        assert(/nothing changed/.test(r.out), "second run must not emit: " + r.out);
      });

      await at("digest speaks again when a draft actually moves", async () => {
        fs.renameSync(path.join(dataDir, "drafts", "pending", "d1.json"),
          path.join(dataDir, "drafts", "approved", "d1.json"));
        const r = await runDigest();
        assert.strictEqual(r.code, 0, r.out);
        assert(/0 pending · 1 approved/.test(r.out), r.out);
      });

      await at("digest does not count its own output (no feedback loop)", async () => {
        // Its own DIGEST lines are now in the log; a third identical run must be quiet.
        const r = await runDigest();
        assert(/nothing changed/.test(r.out), "digest is counting its own events: " + r.out);
      });
    } finally {
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exitCode = 1;
})();
