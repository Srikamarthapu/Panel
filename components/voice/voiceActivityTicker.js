const MAX_TICKER_ITEMS = 3;
const TITLE_LIMIT = 64;
const SUMMARY_LIMIT = 80;

export function truncateTickerText(value, limit) {
  const str = String(value ?? "").replace(/\s+/g, " ").trim();
  if (str.length <= limit) return str;
  return `${str.slice(0, Math.max(0, limit - 1))}…`;
}

function cleanTickerText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

// Generic runtime log lines ("Hermes runtime signal" / "Hermes error signal")
// are synthesized with `now`-anchored timestamps upstream, so they always sort
// newest and would otherwise dominate the ticker. The user asked to see "what we
// discussed" — mission progress and Hermes activity — not raw log noise. So the
// ticker treats `kind: "log"` events as filler: they appear only when there are
// fewer substantive events than the ticker can show.
const FILLER_TICKER_KINDS = new Set(["log"]);

function isSubstantiveTickerEvent(item) {
  return !FILLER_TICKER_KINDS.has(String(item?.kind || ""));
}

function sortTickerEventsNewestFirst(a, b) {
  const ua = a?.updatedAt ?? "";
  const ub = b?.updatedAt ?? "";
  if (ub > ua) return 1;
  if (ub < ua) return -1;
  const ia = String(a?.id ?? "");
  const ib = String(b?.id ?? "");
  if (ib > ia) return 1;
  if (ib < ia) return -1;
  return 0;
}

export function selectTickerEvents(activity, limit = MAX_TICKER_ITEMS) {
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : MAX_TICKER_ITEMS;
  const valid = (Array.isArray(activity) ? activity : [])
    .filter((item) => item && typeof item === "object" && String(item.title || "").trim());

  const substantive = valid.filter(isSubstantiveTickerEvent).sort(sortTickerEventsNewestFirst);
  if (substantive.length >= max) return substantive.slice(0, max);

  // Backfill remaining slots with log filler only when real events run short.
  const filler = valid.filter((item) => !isSubstantiveTickerEvent(item)).sort(sortTickerEventsNewestFirst);
  return substantive.concat(filler).slice(0, max);
}

export function relativeTickerTime(updatedAt, now = Date.now()) {
  if (!updatedAt) return "";
  const ts = new Date(updatedAt).getTime();
  if (!Number.isFinite(ts)) return "";
  const diffSec = Math.max(0, Math.floor((now - ts) / 1000));
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

export function formatTickerEvent(item, now = Date.now()) {
  if (!item || typeof item !== "object") return "";
  const label = cleanTickerText(item.label || item.kind || "Activity");
  const title = cleanTickerText(item.title || "");
  const summary = cleanTickerText(item.summary || "");
  const when = relativeTickerTime(item.updatedAt, now);
  const source = cleanTickerText(item.source || "");
  const detail = [summary, source, when].filter(Boolean).join(" | ");
  return detail ? `${label}: ${title} - ${detail}` : `${label}: ${title}`;
}

export const tickerLimits = {
  maxItems: MAX_TICKER_ITEMS,
  title: TITLE_LIMIT,
  summary: SUMMARY_LIMIT,
};

// ── Live status (T-0008 fix C) ──────────────────────────────────────────────
//
// While a detached action/data run is in flight, the dock should show what
// Hermes is doing RIGHT NOW ("Checking your calendar…", "Opening Notion…")
// instead of rotating historical events. The runner emits present-tense labels
// as the title of queued/active events keyed by the run's actionId; on finish
// it emits a matching complete/failed event. A run is "live" when it has a
// queued or active event and no complete/failed event yet. This pure selector
// returns the newest live run's present-tense label, or null when nothing is
// in flight (dock falls back to normal T-0007 rotation).
const LIVE_STATUS_SOURCES = new Set(["voice/action", "voice/data"]);
const LIVE_STATES = new Set(["queued", "active"]);
const DONE_STATES = new Set(["complete", "error"]);

function runIdOf(event) {
  // Events are keyed `${actionId}` (queued), `${actionId}:running`,
  // `${actionId}:complete`, `${actionId}:failed`. Strip the suffix to group
  // all lifecycle events of one run.
  return String(event?.id ?? "").replace(/:(running|complete|failed)$/, "");
}

export function selectLiveStatus(activity, { sessionId } = {}) {
  const list = (Array.isArray(activity) ? activity : []).filter(
    (item) => item && typeof item === "object" && LIVE_STATUS_SOURCES.has(String(item.source || "")),
  );
  const scoped = sessionId
    ? list.filter((item) => String(item.sessionId || "") === String(sessionId))
    : list;

  // Which runs have finished (have a complete/failed event).
  const finished = new Set();
  for (const item of scoped) {
    if (DONE_STATES.has(String(item.state || ""))) finished.add(runIdOf(item));
  }

  // Newest-first among live (queued/active) events whose run hasn't finished.
  const live = scoped
    .filter((item) => LIVE_STATES.has(String(item.state || "")) && !finished.has(runIdOf(item)))
    .sort(sortTickerEventsNewestFirst);

  const top = live[0];
  if (!top) return null;
  const label = cleanTickerText(top.title || "");
  if (!label) return null;
  return { label, runId: runIdOf(top), state: String(top.state || ""), source: String(top.source || "") };
}
