# AI_Agent — Marketing Agent Ecosystem

Building an AI-agent marketing system for the user's LLC (web apps / SaaS): AI agents that do trend research, SEO/blog drafting, and social content (X, TikTok, reddit) with a human approval gate — visualized as a retro CRT "facility" simulation.

- **Phase 1 (current):** `agent-ecosystem.html` — self-contained simulation. MockEngine generates events; `window.ECOSYS.ingest(event)` + `ECOSYS.setMode("LIVE")` are the seam where real agents plug in later. Event schema is documented in the file header. Apps are placeholders in `CONFIG.apps` until the user names their real products.
- **Phase 2 (LIVE, built 2026-08-29):** `node server.js` → http://localhost:4242 serves the dashboard in LIVE mode (mock engine muted, `MODE: LIVE` badge). Real agents run headlessly via `node agents/run.js <vector|sentinel|quill|echo|ledger|hunter|scope|envoy> [task] [--mock]` — each reads its spec in `agents/<name>.md`, calls the Claude CLI (`--model opus`, tools: WebSearch/WebFetch/Read/Grep/Glob), and its validated output lands in `events.jsonl` (feed) and `drafts/pending/` (approval queue). Approve/reject in the dashboard moves draft files to `drafts/approved|rejected/` — approval NEVER auto-publishes; the founder posts approved content manually. Shared validation in `agents/lib.js` mirrors `ECOSYS.ingest()` — keep them in sync. Runtime data (`events.jsonl`, `drafts/`) is gitignored. **Never edit `events.jsonl` with PowerShell Get-Content/Set-Content** — it is BOM-less UTF-8 and PS 5.1 reads it as Latin-1, corrupting every non-ASCII character (this happened; it also broke a line's JSON). Modify it only via node scripts using `agents/lib.js`.

## Sprint protocol — MANDATORY loop

Work proceeds in sprints (one coherent chunk of feature work). A sprint is NOT done until this loop completes:

1. **Build** the sprint's feature(s).
2. **Review:** launch the `code-reviewer` subagent on the sprint's diff (`git diff` against the last sprint commit). Fix every CRITICAL finding, then re-run the reviewer until its verdict is PASS. Do not skip the re-run.
3. **Visual check:** launch the `gergur` subagent to open the changed page(s) in the user's Gergur browser and verify what actually renders. Fix anything visually broken (and re-run step 2 if fixes were nontrivial).
4. **Commit** as `sprint-N: <summary>` and report both the reviewer verdict and the gergur findings (with screenshot) to the user.

Run steps 2 and 3 in parallel when the diff is already stable. Never declare a sprint complete without both checks passing.

## Products being marketed

**SeatCompress** (`SEATCMP`) — seatcompress.com — SaaS spend-optimization analytics for CFOs ("AI agents replace SaaS seats"). Repo: `C:\Users\gergu\Desktop\out_the_mud2\seat-compression`; rich memory bank at `~/.claude/projects/C--Users-gergu-Desktop-out-the-mud2-seat-compression/memory/` (READ IT before writing SeatCompress content). Hard content rules from the founder's past corrections:
1. Enterprise anchor only: 5K–50K employees / $20M+ SaaS spend. Never "200–2,000 mid-market."
2. Every number must reconcile against the product catalog (`prisma/seed.ts`). No invented vendor pricing. Run the arithmetic on worked examples.
3. Never pitch AI-agent-compresses-AI-product stories; compression targets traditional SaaS seats only.
Existing assets: 64 blog posts in `content/blog/` (48 live, M/W drip), editorial rules in `Blog_guidelines.md`, free ROI calculator at /calculator. Marketing brief: `research/seatcompress-marketing-brief.md`.

**Outbound policy (2026-08-29):** HUNTER researches prospects (public sources only — G2 reviews, archived case studies, job postings; never logged-in LinkedIn scraping) and drafts complete outreach kits (connection note + DM + follow-up) into the approval queue. **The founder sends everything by hand.** Never build or suggest LinkedIn send-automation — it violates LinkedIn ToS and risks the account that IS the channel. One-to-one founder emails (guest pitches, intros) may be sent via Gmail tools WITH per-send approval.

**Channel scope (founder-set, 2026-08-29): LinkedIn + SEO only.** The founder (Ejmen Gerguri, co-founder) already posts on LinkedIn — both a SeatCompress company page and their personal profile. No X, no TikTok for SeatCompress. ECHO drafts LinkedIn content (personal-profile posts prioritized over company-page — ~8× reach); Reddit/communities only as value-first listening via SENTINEL.

## Two modes: local (real) and cloud (demo)

**Local is the real system and must stay free.** Agents run through the Claude Code CLI on the founder's Max subscription. Never introduce a per-token Anthropic API dependency into the local path, and never make local behavior depend on the cloud being reachable.

**Cloud is a public portfolio demo running synthetic data.** `drafts/` holds real named third-party prospects and outreach copy; it must never be committed, containerized, or served. The deployed container boots from `seed/seed.js`, which generates an equivalent dataset using fictional companies (Contoso, Fabrikam, Northwind, Adventure Works, Woodgrove, Tailspin) and invented people.

Behavior is env-gated; **all unset = today's local behavior exactly**:

| Env | Unset (local) | Set (cloud) |
|---|---|---|
| `ECOSYS_TOKEN` | no auth at all | `Authorization: Bearer <token>` required on writes; `/api/config` reports `demo:true` and the dashboard renders the queue read-only |
| `ECOSYS_BIND` | `127.0.0.1` | `0.0.0.0` |
| `ECOSYS_PORT` | 4242 | Container Apps `targetPort` |
| `ECOSYS_DATA_DIR` | repo root | `/data` in the container; a temp dir in tests |

**If you gate writes, gate the UI too.** The dashboard asks `/api/config` before rendering approve buttons. Adding auth without that produces buttons that silently 401 — the approval gate looks alive and is dead.

Two safety properties in `server.js` that must survive any edit:
1. **Static serving is an exact-match allowlist** (`STATIC_ALLOW`). The repo root holds private material — never serve a path built from the request.
2. **A non-loopback bind with no token refuses to start.** This is what prevents ever publishing an unauthenticated, state-mutating API.

Do not add a `process.env.PORT` fallback — dev tooling sets `PORT` and would silently move the local server off 4242.

Docker is not installed on this machine; the image is built and smoke-tested by `.github/workflows/deploy.yml`, which is the Dockerfile's real validation.

## Conventions

- Test command: `node tests/run-tests.js` — unit coverage of the shared helpers (XSS escaping, event sanitization, slug safety) plus integration tests that spawn real servers and assert the static allowlist, the bind interlock, token strength, CSRF rejection, security headers, and authenticated approve/reject actually moving files. **Every spawned server and the test process itself run in their own temp `ECOSYS_DATA_DIR`, so the suite never touches real runtime data.** The dashboard's own suite runs at `http://localhost:4242/?selftest=1`. Run both before committing pipeline changes.

- The simulation stays a single self-contained HTML file (no build step, no external deps) until Phase 2 forces a server.
- Timestamps in the sim are sim-time (`S.time`), not wall-clock.
- Keep the CRT aesthetic: identity via labels/glyphs (never color-alone), status colors always paired with text tags.
