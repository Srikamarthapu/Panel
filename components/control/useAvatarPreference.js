"use client";
import { useCallback, useEffect, useState } from "react";

// One preference across Talk and Chat, including other windows on this device.
const key = "hermes.talk.avatar";
const eventName = "panel-avatar-change";
export default function useAvatarPreference() {
  const [avatar, setAvatar] = useState("orb");
  useEffect(() => {
    const read = event => {
      if (["orb", "bloub"].includes(event?.detail)) { setAvatar(event.detail); return; }
      if (event?.type === "storage" && event.key !== key && event.key !== null) return;
      try { setAvatar(localStorage.getItem(key) === "bloub" ? "bloub" : "orb"); } catch { /* private browsing */ }
    };
    read();
    window.addEventListener(eventName, read);
    window.addEventListener("storage", read);
    return () => { window.removeEventListener(eventName, read); window.removeEventListener("storage", read); };
  }, []);
  const choose = useCallback(next => {
    if (!["orb", "bloub"].includes(next)) return false;
    setAvatar(next);
    let persisted = true;
    try { localStorage.setItem(key, next); } catch { persisted = false; }
    window.dispatchEvent(new CustomEvent(eventName, { detail: next }));
    return persisted;
  }, []);
  return [avatar, choose];
}
