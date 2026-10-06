// /voice route — repurposed as the Voice settings surface (no primary mic).
// Implements Requirement 3.13, 10.4; Property 34.
import Shell from "@/components/shell/Shell.jsx";
import VoiceSettingsPage from "@/components/voice/VoiceSettingsPage.jsx";

export const dynamic = "force-dynamic";

export default function Page() {
  return (
    <Shell active="voice">
      <VoiceSettingsPage />
    </Shell>
  );
}
