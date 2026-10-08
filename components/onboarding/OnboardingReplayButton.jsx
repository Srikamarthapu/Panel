"use client";

import { ONBOARDING_REPLAY_EVENT } from "@/lib/onboarding-state.js";

export default function OnboardingReplayButton({ className = "" }) {
  return <button type="button" className={className} onClick={event => window.dispatchEvent(new CustomEvent(ONBOARDING_REPLAY_EVENT, { detail: { trigger: event.currentTarget } }))}>Replay setup guide</button>;
}
