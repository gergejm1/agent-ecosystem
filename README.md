# Agent Ecosystem

An AI agent orchestration platform with a human approval gate, visualized as a retro CRT mission-control dashboard.

Nine specialized agents research, write, and prospect. Everything they produce lands in an approval queue. **Nothing is ever published automatically** — a person reads each draft and decides.

![mode: live](https://img.shields.io/badge/mode-LIVE-41ff8a?style=flat-square) ![zero dependencies](https://img.shields.io/badge/dependencies-0-41ff8a?style=flat-square) ![tests](https://img.shields.io/badge/tests-34%20passing-41ff8a?style=flat-square)

---

## What it does

Each agent is a markdown spec plus a headless LLM run. The runner enforces a strict output contract (`{events, drafts}`), validates everything before it touches disk, and writes to an append-only event log plus a draft queue.

| Agent | Role |
|---|---|
| **ATLAS** | Orchestrator |
| **VECTOR** | Trend and market scanning |
| **SENTINEL** | Listening — mentions, communities, competitor moves |
| **QUILL** | Long-form content drafting |
| **ECHO** | Social repurposing |
| **HUNTER** | Prospect research from public sources |
| **SCOPE** | Named-person identification, evidence-linked |
| **ENVOY** | Conversation reply drafting |
| **LEDGER** | Pipeline analytics (pure code — see `agents/digest.js`) |

The dashboard renders the event log as a live facility map. In LIVE mode agents stand at their stations and move **only** when a real event arrives, so motion on the map is information rather than decoration.

## Design decisions worth explaining

**The approval gate is the product.** Agents draft; humans send. There is deliberately no auto-publish path, and no automation of LinkedIn connection requests or messages — that violates platform terms and risks the account the whole strategy depends on.

**Privacy is enforced in the prompts, not just the code.** The people-finder agent is restricted to public professional footprint, is forbidden from collecting contact details, and is required to say "no confident identification" rather than guess. In a real run it correctly refused to name anyone at one company after discovering the obvious candidate had changed jobs — a stale-title error that would have burned the sender's credibility.

**The deployed instance runs synthetic data.** Real runs produce named third-party prospects, so the public demo boots from `seed/seed.js` — fictional companies and invented people, identical schema. Real data never enters the container image.

**Local and cloud are one codebase, separated by environment.** With no env vars set the server behaves exactly as it always has: loopback-only, no auth. Set `ECOSYS_TOKEN` and writes require a bearer token, `/api/config` reports demo mode, and the dashboard renders the queue read-only instead of showing buttons that would silently fail.

## Security properties

Two invariants that must survive any edit to `server.js`:

1. **Static serving is an exact-match allowlist.** The repo root holds private material; no path is ever constructed from a request, so traversal is unrepresentable rather than merely blocked.
2. **A non-loopback bind without a strong token refuses to start.** This makes it structurally impossible to accidentally publish an unauthenticated, state-mutating API.

Also enforced: CSRF rejection on every mutation (a header-less `POST` is a CORS *simple* request, so localhost is reachable from any page you visit), constant-time token comparison, CSP and `nosniff` on every response, and a generic 500 body so filesystem paths never leak.

## Running it

```bash
node server.js          # http://localhost:4242
node tests/run-tests.js  # 34 assertions
```

Open `http://localhost:4242/?selftest=1` for the dashboard's own 16-assertion in-browser suite.

Agents run headlessly, one command each:

```bash
node agents/run.js vector        # real run
node agents/run.js vector --mock # replay a fixture, no LLM call
node agents/digest.js            # pipeline analytics, no LLM call
```

### Deploying

`azure/RUNBOOK.md` walks through an Azure Container Apps deployment on the free tier. CI builds the image, smoke-tests it (health, dashboard, allowlist, write auth, demo flag, synthetic seed), and **only publishes if every assertion passes** — so a broken image never reaches the registry.

## Stack

Zero runtime dependencies. Node's standard library, a single self-contained HTML file with a canvas renderer, an append-only JSONL event log, and JSON files for the draft queue. Containerized on `node:22-alpine`, built and tested by GitHub Actions.

## License

MIT
