import ModelsWorkspace from "@/components/control/ModelsWorkspace.jsx";
import { getMemory } from "@/lib/hermes";
import { LearningPanel } from "@/components/InteractivePanels";
import VoiceSettingsPage from "@/components/voice/VoiceSettingsPage.jsx";

export function OverviewPage() {
  return null;
}

export function ModelsPage() {
  return (
    <section className="tabPage">
        <header className="tabPage__head">
          <span className="tabPage__eyebrow">Models</span>
          <h1>Your models</h1>
          <p>Your agent, your connections. Choose the right model for each kind of work.</p>
        </header>
        <ModelsWorkspace />
    </section>
  );
}

export function MemoryPage() {
  const memory = getMemory();
  return (
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
  );
}

export function VoicePage() {
  return (
    <VoiceSettingsPage />
  );
}
