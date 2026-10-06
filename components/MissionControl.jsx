import ModelsWorkspace from "@/components/control/ModelsWorkspace.jsx";
import { getMemory } from "@/lib/hermes";
import { LearningPanel } from "@/components/InteractivePanels";
import NewShell from "@/components/shell/Shell.jsx";
import VoiceSettingsPage from "@/components/voice/VoiceSettingsPage.jsx";

export function OverviewPage() {
  return <NewShell active="overview" />;
}

export function ModelsPage() {
  return (
    <NewShell active="models">
      <section className="tabPage">
        <header className="tabPage__head">
          <span className="tabPage__eyebrow">Models</span>
          <h1>Your models</h1>
          <p>Your agent, your connections. Choose the right model for each kind of work.</p>
        </header>
        <ModelsWorkspace />
      </section>
    </NewShell>
  );
}

export function MemoryPage() {
  const memory = getMemory();
  return (
    <NewShell active="memory">
      <section className="tabPage">
        <header className="tabPage__head">
          <span className="tabPage__eyebrow">Memory</span>
          <h1>Learning trail</h1>
          <p>What Hermes has learned, indexed, and retained.</p>
        </header>
        <section className="tabPage__panel glass">
          <LearningPanel memory={memory} />
        </section>
      </section>
    </NewShell>
  );
}

export function VoicePage() {
  return (
    <NewShell active="voice">
      <VoiceSettingsPage />
    </NewShell>
  );
}
