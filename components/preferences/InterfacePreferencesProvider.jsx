"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import useAvatarPreference from "@/components/control/useAvatarPreference.js";
import {
  AVATAR_PALETTES,
  DEFAULT_INTERFACE_PREFERENCES,
  INTERFACE_PREFERENCES_EVENT,
  INTERFACE_PREFERENCES_KEY,
  getEffectiveReducedMotion,
  normalizeInterfacePreferences,
  parseInterfacePreferences,
} from "@/lib/interface-preferences.js";

const InterfacePreferencesContext = createContext(null);

export default function InterfacePreferencesProvider({ children }) {
  const [preferences, setPreferences] = useState({ ...DEFAULT_INTERFACE_PREFERENCES });
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [persistent, setPersistent] = useState(true);
  // Start with a still avatar until the actual OS preference is available.
  const [systemReducedMotion, setSystemReducedMotion] = useState(true);
  const [avatar, chooseAvatar] = useAvatarPreference();
  const setAvatar = useCallback(next => { setPersistent(chooseAvatar(next)); }, [chooseAvatar]);

  useEffect(() => {
    const read = () => {
      try { setPreferences(parseInterfacePreferences(window.localStorage.getItem(INTERFACE_PREFERENCES_KEY))); }
      catch { setPersistent(false); }
      finally { setPreferencesLoaded(true); }
    };
    const onStorage = event => { if (event.key === INTERFACE_PREFERENCES_KEY || event.key === null) read(); };
    const onChange = event => {
      if (event.detail) setPreferences(normalizeInterfacePreferences(event.detail));
      else read();
    };
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onMediaChange = () => setSystemReducedMotion(media.matches);
    read();
    onMediaChange();
    window.addEventListener("storage", onStorage);
    window.addEventListener(INTERFACE_PREFERENCES_EVENT, onChange);
    media.addEventListener("change", onMediaChange);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(INTERFACE_PREFERENCES_EVENT, onChange);
      media.removeEventListener("change", onMediaChange);
    };
  }, []);

  const updatePreferences = useCallback(patch => {
    // Read the latest persisted value before merging so another window's
    // appearance change is not overwritten by a stale closure.
    let current = preferences;
    try {
      const saved = window.localStorage.getItem(INTERFACE_PREFERENCES_KEY);
      if (saved !== null) current = parseInterfacePreferences(saved);
    } catch { /* In-memory preferences remain usable. */ }
    const next = normalizeInterfacePreferences({ ...current, ...patch });
    setPreferences(next);
    try { window.localStorage.setItem(INTERFACE_PREFERENCES_KEY, JSON.stringify(next)); setPersistent(true); }
    catch { setPersistent(false); }
    window.dispatchEvent(new CustomEvent(INTERFACE_PREFERENCES_EVENT, { detail: next }));
  }, [preferences]);

  const reducedMotion = getEffectiveReducedMotion(preferences, systemReducedMotion);
  const palette = AVATAR_PALETTES[preferences.avatarColor];

  useEffect(() => {
    // The head script has already applied saved appearance. Do not replace it
    // with server defaults while the initial storage read is still pending.
    if (!preferencesLoaded) return;
    const root = document.documentElement;
    root.dataset.panelMotion = reducedMotion ? "reduced" : "full";
    root.dataset.panelMotionPreference = preferences.motion;
    root.dataset.panelTextSize = preferences.textSize;
    root.dataset.panelConversationSpacing = preferences.conversationSpacing;
    root.dataset.panelAccent = preferences.avatarColor;
    root.style.setProperty("--panel-avatar-color", palette.color);
  }, [preferences, palette, reducedMotion, preferencesLoaded]);

  const resetPreferences = useCallback(() => {
    updatePreferences(DEFAULT_INTERFACE_PREFERENCES);
    setAvatar("orb");
  }, [updatePreferences, setAvatar]);
  const value = useMemo(() => ({ preferences, updatePreferences, resetPreferences, avatar, setAvatar, reducedMotion, palette, persistent }),
    [preferences, updatePreferences, resetPreferences, avatar, setAvatar, reducedMotion, palette, persistent]);

  return <InterfacePreferencesContext.Provider value={value}>{children}</InterfacePreferencesContext.Provider>;
}

export function useInterfacePreferences() {
  const context = useContext(InterfacePreferencesContext);
  if (!context) throw new Error("useInterfacePreferences requires InterfacePreferencesProvider");
  return context;
}
