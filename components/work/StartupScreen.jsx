"use client";

import { useEffect, useRef } from "react";
import MissionOrb from "@/components/MissionOrb.jsx";
import { useInterfacePreferences } from "@/components/preferences/InterfacePreferencesProvider.jsx";
import styles from "./StartupScreen.module.css";

export default function StartupScreen({ loading = true, error = "", onRetry, loadingMessage = "Loading your saved sessions…" }) {
  const { avatar } = useInterfacePreferences();
  const retry = useRef(null);
  const failed = !loading && !!error;
  useEffect(() => { if (failed) retry.current?.focus(); }, [failed]);

  return <main className={styles.screen} aria-labelledby="startup-title" data-startup-state={failed ? "error" : "loading"}>
    <div className={styles.content}>
      <div className={styles.presence} aria-hidden="true" aria-busy={loading}>
        <MissionOrb size="hero" avatar={avatar} activity={{ state: failed ? "offline" : "idle", label: failed ? "Workspace unavailable" : "Opening workspace" }} />
      </div>
      <span className={styles.brand}>Panel</span>
      <h1 id="startup-title">{failed ? "Couldn’t open your workspace" : "Opening your workspace"}</h1>
      <p className={styles.status} role={failed ? "alert" : "status"}>{failed ? error : loadingMessage}</p>
      {failed && onRetry && <button ref={retry} type="button" className={styles.retry} onClick={onRetry}>Try again</button>}
    </div>
  </main>;
}
