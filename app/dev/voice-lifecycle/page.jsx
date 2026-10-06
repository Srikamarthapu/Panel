import { notFound } from "next/navigation";
import VoiceLifecycleFixture from "./voice-lifecycle-fixture.jsx";

export const dynamic = "force-dynamic";

export default function VoiceLifecycleFixturePage() {
  if (process.env.NODE_ENV === "production" && process.env.HERMES_VOICE_FIXTURE !== "1") notFound();
  return <VoiceLifecycleFixture />;
}
