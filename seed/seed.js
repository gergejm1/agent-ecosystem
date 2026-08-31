/*
  Synthetic demo dataset generator.

  The deployed container MUST NOT ship real pipeline data: drafts/ contains
  named third-party prospects and outreach copy. This generates an equivalent
  dataset with entirely fictional companies and people so the public demo is
  safe to read without authentication.

  Companies are Microsoft's canonical sample names (Contoso, Fabrikam,
  Northwind, Adventure Works, Woodgrove, Tailspin) — unmistakably fictional,
  and a fitting in-joke for an Azure deployment. People are invented.

  Run:  node seed/seed.js            # writes only if events.jsonl is absent
        node seed/seed.js --force    # overwrite

  Timestamps are generated relative to now, so the demo always looks current.
*/
"use strict";
const fs = require("fs");
const path = require("path");

// Respects ECOSYS_DATA_DIR the same way agents/lib.js does, so seeding a mounted
// volume works without special-casing.
const DATA_DIR = process.env.ECOSYS_DATA_DIR || path.join(__dirname, "..");
const EVENTS = path.join(DATA_DIR, "events.jsonl");
const PENDING = path.join(DATA_DIR, "drafts", "pending");
const APPROVED = path.join(DATA_DIR, "drafts", "approved");
const force = process.argv.includes("--force");

if (fs.existsSync(EVENTS) && fs.statSync(EVENTS).size > 0 && !force) {
  console.log("seed: events.jsonl already present, leaving it alone (use --force to overwrite)");
  process.exit(0);
}

const now = Date.now();
const min = 60 * 1000;
const at = m => new Date(now - m * min).toISOString();

/* ---------------- events ---------------- */
const events = [
  ["ATLAS", "hub", "info", 0, 240, "BOOT: DEMO fleet online — 9 units · synthetic dataset (no real customer or prospect data)"],
  ["ATLAS", "hub", "info", 0, 238, "DIRECTIVE: weekly cycle — trend scan, content drafting, prospect research"],

  ["VECTOR", "trend", "info", 38400, 200, "HOOK: Contoso Ltd announced a 14% seat-price increase effective next quarter — timely renewal-math angle [https://example.com/contoso-pricing]"],
  ["VECTOR", "trend", "info", 0, 199, "HOOK: analyst note projects ~20% of enterprise software spend exposed to agent substitution by 2030 — anchor stat for the thesis pillar [https://example.com/analyst-note]"],
  ["VECTOR", "trend", "warn", 0, 198, "COMPETITOR: Fabrikam Industries shipped a licensing-analytics module — overlaps the visibility story, not the substitution story [https://example.com/fabrikam-launch]"],
  ["VECTOR", "trend", "info", 0, 196, "RUN COMPLETE: VECTOR — 3 findings, 0 draft(s) filed"],

  ["QUILL", "foundry", "info", 51200, 165, "Drafted the enterprise renewal-math piece; every figure reconciled against the product catalog before filing"],
  ["QUILL", "approval", "draft", 0, 164, 'BLOG filed to Approval Gate — "The renewal math nobody runs before signing" [DEMO]'],
  ["QUILL", "foundry", "warn", 0, 163, "EXCLUDED: one vendor list price could not be verified from a primary source — left out rather than estimated"],
  ["QUILL", "foundry", "info", 0, 162, "RUN COMPLETE: QUILL — 2 findings, 1 draft(s) filed"],

  ["ECHO", "relay", "info", 22100, 120, "Repurposed the renewal-math piece into two posts, split between founder voice and company page"],
  ["ECHO", "approval", "draft", 0, 119, 'LINKEDIN filed to Approval Gate — "Most teams renew on autopilot. Here is the 4-line check." [DEMO]'],
  ["ECHO", "approval", "draft", 0, 118, 'CAROUSEL filed to Approval Gate — "6 slides: where per-seat spend actually leaks" [DEMO]'],
  ["ECHO", "relay", "info", 0, 117, "RUN COMPLETE: ECHO — 1 findings, 2 draft(s) filed"],

  ["HUNTER", "listen", "info", 41800, 85, "Premise verified from two independent sources before prospecting began"],
  ["HUNTER", "listen", "info", 0, 84, "Verified headcounts: Northwind Logistics ~18,400 · Adventure Works ~9,200 · Woodgrove Bank ~11,700 · Tailspin Toys ~1,150"],
  ["HUNTER", "listen", "warn", 0, 83, "ICP flag: Tailspin Toys (~1,150 employees) sits below the enterprise anchor — filed but ranked last"],
  ["HUNTER", "approval", "draft", 0, 82, 'DM filed to Approval Gate — "Northwind Logistics — VP Finance" [DEMO]'],
  ["HUNTER", "approval", "draft", 0, 81, 'DM filed to Approval Gate — "Adventure Works — Director, IT Asset Management" [DEMO]'],
  ["HUNTER", "listen", "info", 0, 80, "RUN COMPLETE: HUNTER — 3 findings, 2 draft(s) filed"],

  ["SCOPE", "listen", "info", 29400, 55, "Northwind Logistics: 2 candidates identified from public conference bios; both HIGH confidence"],
  ["SCOPE", "listen", "warn", 0, 54, "Woodgrove Bank: no confident public identification — the sourcing role appears to be vacant. Recommending a manual search rather than guessing a name"],
  ["SCOPE", "approval", "draft", 0, 53, 'PEOPLE filed to Approval Gate — "Northwind Logistics — people to connect with" [DEMO]'],
  ["SCOPE", "listen", "info", 0, 52, "RUN COMPLETE: SCOPE — 2 findings, 1 draft(s) filed"],

  ["GATE", "uplink", "pub", 0, 40, 'APPROVED: "The renewal math nobody runs before signing" → drafts/approved — ready for the founder to post'],
  ["GATE", "approval", "warn", 0, 35, 'REJECTED: "6 slides: where per-seat spend actually leaks" → returned to ECHO'],

  ["LEDGER", "analytics", "info", 0, 12, "DIGEST: 5 agent runs in the last 7 days · 6 drafts filed · 1 approved · 1 rejected · 4 pending"],
  ["LEDGER", "analytics", "warn", 0, 11, "DIGEST: 2 drafts have been pending more than 3 days — review queue is aging"],
].map(([agent, station, kind, tokens, minsAgo, text]) =>
  ({ ts: at(minsAgo), agent, station, kind, text, tokens }));

/* ---------------- drafts ---------------- */
const drafts = [
  {
    id: "demo-0001-linkedin-renewal-autopilot",
    agent: "ECHO", kind: "LINKEDIN", app: "DEMO",
    title: "Most teams renew on autopilot. Here is the 4-line check.",
    body: "[PERSONAL] contrarian text post — repurposed from the renewal-math article",
    content: `Most enterprise software renewals are approved by someone who has never seen the usage data.

Not because they are careless. Because the renewal lands as a line item three weeks before it auto-renews, and the only number attached to it is last year's number.

Four lines, before you sign anything:

1. How many seats are provisioned, and how many were active in the last 30 days?
2. What is the per-seat cost at the current tier, and what is it at the tier below?
3. What is the auto-renewal notice window, and has it already closed?
4. Which of these seats still needs a human in it at all?

The fourth one is new. It is also the one that moves the number.`,
  },
  {
    id: "demo-0002-dm-northwind-vp-finance",
    agent: "HUNTER", kind: "DM", app: "DEMO",
    title: "Northwind Logistics — VP Finance",
    body: "~18,400 employees; published a conference talk on software spend governance. Strong enterprise fit.",
    content: `WHY NOW
- Northwind Logistics (~18,400 employees) presented on software spend governance at a public industry conference this year. Source: https://example.com/conference-agenda
- Their published case study describes managing several hundred SaaS applications across regional offices. Source: https://example.com/northwind-case-study

WHO
- Primary: VP Finance or the FinOps lead who owns renewal justification.
- Verify the current holder from public bios, bylines, or talks before sending. Do not assume a name.

CONNECTION NOTE (<=280)
Saw your conference talk on software spend governance at Northwind. The part about defending renewals with usage data rather than last year's invoice stuck with me. Would value connecting and comparing notes. No pitch.

FIRST DM (after accept)
Thanks for connecting. Not selling anything today. I am mapping how large operators are rebuilding renewal justification now that usage data and headcount assumptions are both moving. Happy to share what I am seeing, or just trade notes.

IF NO REPLY
One gentle follow-up in 1-2 weeks with a genuinely useful breakdown, then stop.`,
  },
  {
    id: "demo-0003-dm-adventureworks-itam",
    agent: "HUNTER", kind: "DM", app: "DEMO",
    title: "Adventure Works — Director, IT Asset Management",
    body: "~9,200 employees; public job posting signals an active software-asset program. Clean ICP fit.",
    content: `WHY NOW
- Adventure Works (~9,200 employees) posted a Director of IT Asset Management role, which signals an active and funded software-asset program. Source: https://example.com/adventureworks-careers
- Public earnings commentary referenced a cost-optimization program covering software spend. Source: https://example.com/adventureworks-earnings

WHO
- Primary: Director of IT Asset Management. Secondary: the finance partner who signs renewals.
- Confirm the current holder from public sources before sending.

CONNECTION NOTE (<=280)
Noticed Adventure Works is building out IT asset management. I spend most of my time on the renewal-math side of that problem and would value comparing notes as you stand the function up. No pitch.

FIRST DM (after accept)
Thanks for connecting. Standing up an ITAM function is mostly a data problem before it is a tooling problem, and the sequencing choices people make early tend to decide what the program can prove later. Happy to share what I have seen work, or just compare notes.

IF NO REPLY
One follow-up in 1-2 weeks, then stop.`,
  },
  {
    id: "demo-0004-people-northwind",
    agent: "SCOPE", kind: "PEOPLE", app: "DEMO",
    title: "Northwind Logistics — people to connect with",
    body: "2 candidates · VP Finance + Manager, Software Asset Management",
    content: `Two candidates identified from public professional footprint only. No contact details collected.

=== CANDIDATE 1 ===
NAME: Dana Whitfield — VP Finance @ Northwind Logistics
WHY THEM: Owns the renewal-approval chain described in the company's public spend-governance talk.
EVIDENCE: conference speaker page — https://example.com/conference-agenda
LINKEDIN: search "Dana Whitfield Northwind Logistics" (no clean public profile URL surfaced; do not assume one)
CONFIDENCE: HIGH — named on a dated conference agenda with an explicit current title.
NOTE (<=280): Dana — your talk on defending renewals with usage data rather than last year's invoice was sharp. Would value connecting and comparing notes on how that holds up as headcount assumptions shift. No pitch.

=== CANDIDATE 2 ===
NAME: Marcus Bell — Manager, Software Asset Management @ Northwind Logistics
WHY THEM: Administers the software-asset program; the person who feels usage-data gaps first.
EVIDENCE: authored a published industry article — https://example.com/marcus-bell-article
LINKEDIN: search "Marcus Bell Northwind software asset"
CONFIDENCE: MEDIUM — article is 14 months old; verify the current title on their profile before sending.
NOTE (<=280): Marcus — read your piece on reconciling entitlement data against actual usage. The reconciliation problem you described is exactly where I spend my time. Would enjoy connecting. No pitch.`,
  },
];

/* ---------------- write ---------------- */
fs.mkdirSync(PENDING, { recursive: true });
fs.mkdirSync(APPROVED, { recursive: true });
fs.writeFileSync(EVENTS, events.map(e => JSON.stringify(e)).join("\n") + "\n");

for (const d of drafts) {
  const { id, ...rest } = d;
  fs.writeFileSync(path.join(PENDING, id + ".json"),
    JSON.stringify({ ...rest, created: at(90) }, null, 2));
}

// one already-approved draft so the approved lane is not empty in the demo
fs.writeFileSync(path.join(APPROVED, "demo-0005-blog-renewal-math.json"), JSON.stringify({
  agent: "QUILL", kind: "BLOG", app: "DEMO",
  title: "The renewal math nobody runs before signing",
  body: "~1,600 words · enterprise worked example · every figure reconciled against the catalog",
  content: "Full article body omitted from the demo dataset. In the live pipeline this field holds the complete draft, which the operator reads in the /draft view before approving.",
  created: at(150),
}, null, 2));

console.log(`seed: wrote ${events.length} events, ${drafts.length} pending drafts, 1 approved draft`);
console.log("seed: all companies and people are fictional");
