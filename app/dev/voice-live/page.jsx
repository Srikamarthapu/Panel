import { notFound } from "next/navigation";
import VoiceLiveFixture from "./voice-live-fixture.jsx";

export const dynamic = "force-dynamic";

export default function VoiceLiveFixturePage() {
  if (process.env.NODE_ENV === "production" && process.env.HERMES_VOICE_FIXTURE !== "1") notFound();
  return <VoiceLiveFixture />;
}
