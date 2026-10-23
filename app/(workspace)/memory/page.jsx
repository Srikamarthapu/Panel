import MemoryWorkspace from "@/components/work/MemoryWorkspace.jsx";

export const dynamic = "force-dynamic";

export default function Page() {
  return <section className="tabPage"><header className="tabPage__head"><span className="tabPage__eyebrow">Memory</span><h1>Assistant memory</h1><p>Shared long-term memory, profile roles, current work, and conversation history.</p></header><section className="tabPage__panel glass"><MemoryWorkspace /></section></section>;
}
