"use client";

import { useState } from "react";
import Link from "next/link";
import MissionOrb from "@/components/MissionOrb.jsx";
import { AVATAR_PALETTES } from "@/lib/interface-preferences.js";
import { useInterfacePreferences } from "./InterfacePreferencesProvider.jsx";
import OnboardingReplayButton from "@/components/onboarding/OnboardingReplayButton.jsx";

function ChoiceGroup({ label, value, options, onChange }) {
  return <div className="preferenceChoices" role="group" aria-label={label}>
    {options.map(option => <button type="button" key={option.value} aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}

function PreferenceRow({ title, description, children }) {
  return <div className="preferenceRow"><div className="preferenceRow__copy"><h3>{title}</h3><p>{description}</p></div><div className="preferenceRow__control">{children}</div></div>;
}

export default function InterfaceSettings() {
  const { preferences, updatePreferences, resetPreferences, avatar, setAvatar, reducedMotion, persistent } = useInterfacePreferences();
  const [notice, setNotice] = useState("");
  const update = patch => { updatePreferences(patch); setNotice(""); };
  const reset = () => { resetPreferences(); setNotice("Appearance restored to the defaults."); };

  return <section className="preferencesPage">
    <header className="preferencesHeading"><span className="workEyebrow">YOUR WORKSPACE</span><h1>Make Panel yours.</h1><p>Choose how your companion moves and how conversations read. Changes apply immediately and stay on this device.</p></header>
    <div className="preferencesLayout">
      <div className="preferencesControls">
        <section className="preferenceSection" aria-labelledby="companion-heading">
          <h2 id="companion-heading">Companion</h2>
          <PreferenceRow title="Avatar" description="The same companion follows you between Talk and Chat.">
            <ChoiceGroup label="Avatar" value={avatar} options={[{ value: "orb", label: "Orb" }, { value: "bloub", label: "Bloub" }]} onChange={value => { setAvatar(value); setNotice(""); }} />
          </PreferenceRow>
          <PreferenceRow title="Color" description="An accent for your workspace and companion.">
            <div className="preferenceColors" role="group" aria-label="Avatar color">{Object.entries(AVATAR_PALETTES).map(([value, palette]) => <button type="button" key={value} aria-pressed={preferences.avatarColor === value} aria-label={palette.label} onClick={() => update({ avatarColor: value })}><span style={{ background: palette.color }} aria-hidden="true" /><span>{palette.label}</span></button>)}</div>
          </PreferenceRow>
          <PreferenceRow title="Motion" description="Follow your Mac’s accessibility setting, or choose the amount of motion here.">
            <ChoiceGroup label="Avatar motion" value={preferences.motion} options={[{ value: "system", label: "System" }, { value: "full", label: "Full" }, { value: "reduced", label: "Reduced" }]} onChange={motion => update({ motion })} />
          </PreferenceRow>
          <PreferenceRow title="Follow cursor" description={reducedMotion ? "Saved for when full motion is enabled. Reduced motion keeps the avatar still." : "Bloub looks toward the pointer while it’s idle."}>
            <button type="button" role="switch" aria-checked={preferences.pointerFollowing} aria-label="Follow cursor" className="preferenceSwitch" onClick={() => update({ pointerFollowing: !preferences.pointerFollowing })}><span aria-hidden="true" /><span>{preferences.pointerFollowing ? "On" : "Off"}</span></button>
          </PreferenceRow>
        </section>
        <section className="preferenceSection" aria-labelledby="reading-heading">
          <h2 id="reading-heading">Reading</h2>
          <PreferenceRow title="Text size" description="Larger type for conversations, forms, and navigation.">
            <ChoiceGroup label="Text size" value={preferences.textSize} options={[{ value: "default", label: "Default" }, { value: "larger", label: "Larger" }]} onChange={textSize => update({ textSize })} />
          </PreferenceRow>
          <PreferenceRow title="Conversation spacing" description="Keep room between replies, or fit more of the conversation on screen.">
            <ChoiceGroup label="Conversation spacing" value={preferences.conversationSpacing} options={[{ value: "comfortable", label: "Comfortable" }, { value: "compact", label: "Compact" }]} onChange={conversationSpacing => update({ conversationSpacing })} />
          </PreferenceRow>
        </section>
        <section className="preferenceSection" aria-labelledby="setup-heading">
          <h2 id="setup-heading">Setup guide</h2>
          <PreferenceRow title="Workspace tour" description="Review Hermes readiness, models, optional voice, and where local data is stored.">
            <OnboardingReplayButton className="workButton workButton--quiet" />
          </PreferenceRow>
        </section>
        <footer className="preferencesFooter"><button type="button" className="workButton workButton--quiet" onClick={reset}>Reset appearance</button><span role="status">{notice || (persistent ? "Saved automatically on this device." : "Applied for this window. Local storage is unavailable.")}</span></footer>
      </div>
      <aside className="preferencesPreview" aria-label="Companion preview">
        <div className="preferencesPreview__avatar"><MissionOrb avatar={avatar} voiceState="idle" /></div>
        <h2>Your companion.</h2><p>{avatar === "bloub" && preferences.pointerFollowing && !reducedMotion ? "Try moving your cursor around the preview." : "See your appearance choices as you make them."}</p>
        <div className="preferencesPreview__links"><Link href="/voice">Voice settings <span aria-hidden="true">↗</span></Link><Link href="/models">Models and routing <span aria-hidden="true">↗</span></Link></div>
      </aside>
    </div>
  </section>;
}
