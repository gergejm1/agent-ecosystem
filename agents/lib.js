/* Shared event validation + persistence for server.js and agents/run.js.
   Mirrors the dashboard's ECOSYS.ingest() contract — keep the two in sync. */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
// Where runtime data lives. Defaults to the repo root, so unset = today's behavior.
// Tests point this at a temp dir so they can never touch the real event log, and
// a container can point it at a mounted volume.
const DATA_DIR = process.env.ECOSYS_DATA_DIR || ROOT;
const EVENTS_FILE = path.join(DATA_DIR, "events.jsonl");
const DRAFTS = {
  pending: path.join(DATA_DIR, "drafts", "pending"),
  approved: path.join(DATA_DIR, "drafts", "approved"),
  rejected: path.join(DATA_DIR, "drafts", "rejected"),
};

// Renderable pipeline agents — mirrors the dashboard's AGENTS roster exactly.
const PIPELINE_AGENTS = ["ATLAS", "VECTOR", "QUILL", "ECHO", "SENTINEL", "LEDGER", "HUNTER", "SCOPE", "ENVOY"];
// System emitters (server/runner only; the dashboard renders them as plain labels).
const SYSTEM_AGENTS = ["GATE", "SYS", "UPLINK"];
const AGENTS = [...PIPELINE_AGENTS, ...SYSTEM_AGENTS];
const STATIONS = ["hub", "trend", "foundry", "approval", "uplink", "analytics", "relay", "listen"];
const KINDS = ["info", "warn", "crit", "draft", "pub"];

/* Returns a clean event object, or null if the input is unusable. */
function sanitizeEvent(raw) {
  if (!raw || typeof raw !== "object") return null;
  const text = typeof raw.text === "string" ? raw.text.slice(0, 600) : "";
  if (!text) return null;
  return {
    ts: new Date().toISOString(),
    agent: AGENTS.includes(raw.agent) ? raw.agent : "SYS",
    station: STATIONS.includes(raw.station) ? raw.station : "hub",
    kind: KINDS.includes(raw.kind) ? raw.kind : "info",
    text,
    tokens: Number.isFinite(raw.tokens) && raw.tokens > 0 ? Math.round(raw.tokens) : 0,
  };
}

function appendEvent(evt) {
  if (!evt) return false;
  fs.appendFileSync(EVENTS_FILE, JSON.stringify(evt) + "\n");
  return true;
}

/* HTML escaping + linkification for the /draft view. escHtml MUST run before
   linkify — the anchor is built from already-entity-escaped text, which is what
   makes attribute breakout impossible (no raw quotes/brackets survive). */
function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function linkify(s) {
  return escHtml(s).replace(/(https?:\/\/[^\s<)"\]]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "draft";
}

/* Writes a draft JSON into drafts/pending and returns its id. */
function writeDraft(d) {
  fs.mkdirSync(DRAFTS.pending, { recursive: true });
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${slug(d.title)}`;
  const clean = {
    agent: AGENTS.includes(d.agent) ? d.agent : "QUILL",
    kind: typeof d.kind === "string" ? d.kind.toUpperCase().slice(0, 16) : "DRAFT",
    app: typeof d.app === "string" ? d.app.slice(0, 16) : "SEATCMP",
    title: typeof d.title === "string" ? d.title.slice(0, 200) : "(untitled)",
    body: typeof d.body === "string" ? d.body.slice(0, 500) : "",
    content: typeof d.content === "string" ? d.content.slice(0, 20000) : "",
    created: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(DRAFTS.pending, id + ".json"), JSON.stringify(clean, null, 2));
  return id;
}

module.exports = { sanitizeEvent, appendEvent, writeDraft, slug, escHtml, linkify, DATA_DIR, EVENTS_FILE, DRAFTS, AGENTS, PIPELINE_AGENTS, STATIONS, KINDS };
