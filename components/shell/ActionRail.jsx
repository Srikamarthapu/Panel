"use client";

// Client component. Ambient activity feed.
// Implements Requirements 4.1–4.12, 8.6; Properties 8, 9, 10, 24.

import { useEffect, useMemo, useReducer, useRef } from "react";
import {
  motion,
  AnimatePresence,
  LayoutGroup,
  useReducedMotion,
} from "motion/react";

const POLL_BASE_MS = 5000;
const POLL_JITTER_MS = 500;
const POLL_BACKOFF_CAP_MS = 60000;
const POLL_TIMEOUT_MS = 8000;
const RESUME_BUDGET_MS = 1000;
const TICK_INTERVAL_MS = 30000;
const MAX_VISIBLE = 50;

// Use prototype-less objects so inherited keys (toString, valueOf, …) don't
// leak through `obj[kind]` and shadow the slate fallback. Property 8.
const KIND_TO_TONE = Object.assign(Object.create(null), {
  memory: "var(--tone-memory)",
  skill: "var(--tone-skill)",
  task: "var(--tone-task)",
  log: "var(--tone-log)",
  search: "var(--tone-search)",
});
const FALLBACK_TONE = "var(--tone-slate)";

const KIND_TO_GLYPH = Object.assign(Object.create(null), {
  memory: "✻",
  skill: "❖",
  task: "◑",
  log: "≡",
  search: "⌕",
});

function toneFor(kind) {
  if (typeof kind !== "string") return FALLBACK_TONE;
  return KIND_TO_TONE[kind] ?? FALLBACK_TONE;
}
function glyphFor(kind) {
  if (typeof kind !== "string") return "•";
  return KIND_TO_GLYPH[kind] ?? "•";
}

function truncate(s, n) {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, Math.max(0, n - 1)) + "…" : str;
}

function sortAndCap(activity) {
  const list = Array.isArray(activity) ? activity : [];
  return list
    .slice()
    .sort((a, b) => {
      const ua = a?.updatedAt ?? "";
      const ub = b?.updatedAt ?? "";
      if (ub > ua) return 1;
      if (ub < ua) return -1;
      const ia = String(a?.id ?? "");
      const ib = String(b?.id ?? "");
      if (ib > ia) return 1;
      if (ib < ia) return -1;
      return 0;
    })
    .slice(0, MAX_VISIBLE);
}

function relativeTime(updatedAt, now) {
  if (!updatedAt) return "—";
  const t = new Date(updatedAt).getTime();
  if (!Number.isFinite(t)) return "—";
  const diffSec = Math.max(0, Math.floor((now - t) / 1000));
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

function jitteredBaseDelay() {
  // 5000ms ± 500ms jitter (Req 4.4).
  return POLL_BASE_MS + Math.round((Math.random() - 0.5) * 2 * POLL_JITTER_MS);
}

function backoffDelay(failureCount) {
  // min(60000, 5000 * 2^(n-1)) (Req 4.6).
  if (failureCount <= 0) return POLL_BASE_MS;
  const exp = POLL_BASE_MS * Math.pow(2, failureCount - 1);
  return Math.min(POLL_BACKOFF_CAP_MS, exp);
}

const POLL_INITIAL = (initialActivity, initialUpdatedAt) => ({
  activity: sortAndCap(initialActivity),
  failureCount: 0,
  isStale: false,
  lastSuccessAt: initialUpdatedAt || null,
  nextDelayMs: POLL_BASE_MS,
  status: "idle_polling",
});

function pollReducer(state, action) {
  switch (action.type) {
    case "FETCH_START":
      return { ...state, status: "fetching" };
    case "FETCH_OK":
      return {
        ...state,
        activity: sortAndCap(action.activity),
        failureCount: 0,
        isStale: false,
        lastSuccessAt: action.updatedAt || new Date().toISOString(),
        nextDelayMs: jitteredBaseDelay(),
        status: "ok",
      };
    case "FETCH_FAIL": {
      const nextFailures = state.failureCount + 1;
      return {
        ...state,
        failureCount: nextFailures,
        isStale: true,
        nextDelayMs: backoffDelay(nextFailures),
        status: "stale",
      };
    }
    case "WAITING":
      return {
        ...state,
        status: state.isStale ? "waiting_backoff" : "waiting",
      };
    case "PAUSED":
      return { ...state, status: "paused" };
    default:
      return state;
  }
}

export default function ActionRail({
  initialActivity = [],
  initialUpdatedAt,
}) {
  const [state, dispatch] = useReducer(pollReducer, null, () =>
    POLL_INITIAL(initialActivity, initialUpdatedAt),
  );
  const reduceMotion = useReducedMotion();

  // Refs that survive the polling closure so visibility resume + backoff
  // schedules see the *current* failureCount/nextDelayMs rather than the
  // values captured on first render.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const timeoutRef = useRef(null);
  const abortRef = useRef(null);
  const stoppedRef = useRef(false);

  // Single shared 30s ticker that bumps a counter to refresh relative
  // timestamps without re-running the polling effect (Req 4.3).
  const [, forceTick] = useReducer((x) => x + 1, 0);
  useEffect(() => {
    const id = setInterval(() => forceTick(), TICK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    stoppedRef.current = false;

    const scheduleNext = (delay) => {
      if (stoppedRef.current) return;
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        dispatch({ type: "PAUSED" });
        return;
      }
      dispatch({ type: "WAITING" });
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(runFetch, Math.max(0, delay));
    };

    const runFetch = async () => {
      if (stoppedRef.current) return;
      const controller = new AbortController();
      abortRef.current = controller;
      const timeoutId = setTimeout(
        () => controller.abort(),
        POLL_TIMEOUT_MS,
      );
      dispatch({ type: "FETCH_START" });
      try {
        const res = await fetch("/api/mission-control", {
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`status_${res.status}`);
        const json = await res.json();
        if (stoppedRef.current) return;
        dispatch({
          type: "FETCH_OK",
          activity: Array.isArray(json?.activity) ? json.activity : [],
          updatedAt: json?.updatedAt ?? new Date().toISOString(),
        });
        scheduleNext(jitteredBaseDelay());
      } catch {
        if (stoppedRef.current) return;
        dispatch({ type: "FETCH_FAIL" });
        // Use the *next* failure count (current + 1) since the dispatch
        // above hasn't been committed when we compute the delay here.
        const nextFailures = (stateRef.current?.failureCount ?? 0) + 1;
        scheduleNext(backoffDelay(nextFailures));
      } finally {
        clearTimeout(timeoutId);
        if (abortRef.current === controller) abortRef.current = null;
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        if (timeoutRef.current) {
          clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
        }
        dispatch({ type: "PAUSED" });
      } else {
        // Resume within RESUME_BUDGET_MS (Req 4.5).
        const next = Math.min(
          stateRef.current?.nextDelayMs ?? POLL_BASE_MS,
          RESUME_BUDGET_MS,
        );
        scheduleNext(next);
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    // First cycle starts after one base interval so the SSR snapshot is
    // visible without flicker.
    scheduleNext(POLL_BASE_MS);

    return () => {
      stoppedRef.current = true;
      document.removeEventListener("visibilitychange", onVisibility);
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const items = useMemo(() => sortAndCap(state.activity), [state.activity]);
  const now = Date.now();

  return (
    <section
      className="actionRail glass"
      role="region"
      aria-label="Hermes activity feed"
      aria-live="polite"
      aria-relevant="additions"
    >
      <header className="actionRail__head">
        <div className="actionRail__title">
          <span className="actionRail__eyebrow">Live</span>
          <strong>Hermes actions</strong>
        </div>
        {state.isStale ? (
          <span
            className="actionRail__stale"
            role="status"
            aria-label="Live feed delayed"
            title="Live feed delayed"
          />
        ) : null}
      </header>

      {items.length === 0 ? (
        <div className="actionRail__empty">
          <strong>No live activity yet.</strong>
          <p>
            Memory writes, skill updates, task moves, and searches will stream
            here as Hermes works.
          </p>
        </div>
      ) : (
        <LayoutGroup>
          <ul className="actionRail__list">
            <AnimatePresence initial={false}>
              {items.map((item) => (
                <motion.li
                  key={item.id}
                  className="actionRail__item"
                  layout={reduceMotion ? false : "position"}
                  initial={reduceMotion ? false : { opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
                  transition={
                    reduceMotion
                      ? { duration: 0 }
                      : { duration: 0.24, ease: [0.2, 0, 0, 1] }
                  }
                  style={{ "--tone": toneFor(item.kind) }}
                >
                  <span className="actionRail__glyph" aria-hidden="true">
                    {glyphFor(item.kind)}
                  </span>
                  <div className="actionRail__body">
                    <strong
                      className="actionRail__itemTitle"
                      title={item.title}
                    >
                      {truncate(item.title, 60)}
                    </strong>
                    <p className="actionRail__itemSummary">
                      {truncate(item.summary, 120)}
                    </p>
                    <div className="actionRail__meta">
                      <span className="actionRail__source">{item.source}</span>
                      <time dateTime={item.updatedAt}>
                        {relativeTime(item.updatedAt, now)}
                      </time>
                    </div>
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </LayoutGroup>
      )}

      <footer className="actionRail__foot">
        <span className="actionRail__viewAll">tools, tasks, memory, and screen actions</span>
      </footer>
    </section>
  );
}
