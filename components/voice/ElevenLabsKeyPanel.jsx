"use client";

import { useCallback, useState } from "react";

function formatNumber(value) {
  return value == null ? "—" : new Intl.NumberFormat("en-US").format(value);
}

function formatReset(timestamp) {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function statusLabel(row) {
  if (row.ok && row.remaining === 0) return "Quota empty";
  if (row.dead) return "Paused";
  if (row.ok) return row.reason === "tts-only" ? "Speech available" : "Available";
  return {
    missing_permissions: "Needs permissions",
    invalid: "Invalid key",
    quota: "Quota exhausted",
    timeout: "Timed out",
    network: "Connection failed",
  }[row.reason] || "Unavailable";
}

function statusTone(row) {
  if (row.dead || !row.ok) return "bad";
  if (row.remaining != null && row.limit && row.remaining / row.limit < 0.1) return "warn";
  return "ok";
}

export default function ElevenLabsKeyPanel() {
  const [rows, setRows] = useState([]);
  const [voiceMeta, setVoiceMeta] = useState({ voiceId: null, model: null });
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [checkedAt, setCheckedAt] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  // Probing each provider key is an explicit action, never a mount effect.
  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/voice/keys", { cache: "no-store", signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error("unavailable");
      const data = await response.json();
      setRows(Array.isArray(data.keys) ? data.keys : []);
      setVoiceMeta({ voiceId: data.voiceId, model: data.model });
      setLoaded(true);
      setCheckedAt(new Date());
    } catch {
      setError("The keys could not be checked. Confirm your connection and try again. Existing voice settings are still in place.");
    } finally {
      setLoading(false);
    }
  }, []);

  const act = useCallback(async (action, masked) => {
    setBusy(`${action}:${masked}`);
    setError("");
    try {
      const response = await fetch("/api/voice/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, masked }),
      });
      if (!response.ok) {
        setError(response.status === 404
          ? "This key is no longer configured. Check keys again to update the list."
          : "The change could not be saved. Check your connection and try again.");
        return;
      }
      if (action === "set-active") {
        setRows((current) => current.map((row) => ({ ...row, active: row.masked === masked })));
      } else {
        await refresh();
      }
    } catch {
      setError("The change could not be saved. Check your connection and try again.");
    } finally {
      setBusy("");
    }
  }, [refresh]);

  return (
    <article className="elevenKeys">
      <header className="elevenKeys__head">
        <div>
          <h3>Provider keys</h3>
          <p className="elevenKeys__meta">{loaded ? `${rows.length} configured · ${rows.filter((row) => row.active).length ? "preferred key selected" : "automatic key selection"}` : "Check availability and credits when you need them."}</p>
        </div>
        <button type="button" className="elevenKeys__refresh" onClick={refresh} disabled={loading || !!busy}>{loading ? "Checking…" : loaded ? "Refresh" : "Check keys"}</button>
      </header>
      {error ? <p className="elevenKeys__error" role="alert">{error}</p> : null}
      {!loaded && !loading && !error ? <p className="elevenKeys__empty">Credentials stay masked. Checking keys contacts ElevenLabs for current availability and usage.</p> : null}
      {loading ? <p className="elevenKeys__empty" role="status">Checking provider keys…</p> : null}
      {loaded && rows.length === 0 ? <p className="elevenKeys__empty">No ElevenLabs keys are configured. Add a key in your local voice configuration to enable speech.</p> : null}

      <ul className="elevenKeys__list" aria-label="ElevenLabs provider keys">
        {rows.map((row) => {
          const tone = statusTone(row);
          const usedPercent = row.used != null && row.limit ? Math.min(100, Math.max(0, row.used / row.limit * 100)) : null;
          return (
            <li key={row.masked} className={`elevenKeys__row${row.active ? " is-active" : ""}`} data-tone={tone}>
              <div className="elevenKeys__identity">
                <div className="elevenKeys__rowHead"><code className="elevenKeys__keyMask">{row.masked}</code>{row.active ? <span className="elevenKeys__activeBadge">Preferred</span> : null}</div>
                <span className={`elevenKeys__status elevenKeys__status--${tone}`}>{statusLabel(row)}{row.tier ? ` · ${row.tier}` : ""}</span>
              </div>
              <div className="elevenKeys__usage">
                <div className="elevenKeys__stats"><span>{row.remaining == null ? "Usage unavailable" : `${formatNumber(row.remaining)} characters left`}</span>{row.resetAt ? <small>Resets {formatReset(row.resetAt)}</small> : null}</div>
                {usedPercent != null ? <div className="elevenKeys__bar" role="meter" aria-label={`Usage for ${row.masked}`} aria-valuemin={0} aria-valuemax={row.limit} aria-valuenow={Math.min(row.limit, Math.max(0, row.used))} aria-valuetext={`${formatNumber(row.used)} of ${formatNumber(row.limit)} characters used`}><span className="elevenKeys__barFill" style={{ width: `${usedPercent}%` }} /></div> : null}
              </div>
              <div className="elevenKeys__rowActions">
                <button type="button" className="elevenKeys__btn" onClick={() => act("set-active", row.masked)} disabled={row.active || !!busy || loading}>{busy === `set-active:${row.masked}` ? "Saving…" : row.active ? "Selected" : "Use key"}</button>
                {row.dead || (row.ok && row.remaining === 0) ? <button type="button" className="elevenKeys__btn" onClick={() => act("revive", row.masked)} disabled={!!busy || loading} title="Clear the paused flag and check this key again">{busy === `revive:${row.masked}` ? "Retrying…" : "Retry"}</button> : null}
              </div>
              {row.note ? <p className="elevenKeys__note">{row.note}</p> : null}
            </li>
          );
        })}
      </ul>
      {checkedAt ? <p className="elevenKeys__footnote">Checked {checkedAt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}{voiceMeta.model ? ` · ${voiceMeta.model}` : ""}</p> : null}
    </article>
  );
}
