import Shell from "@/components/shell/Shell.jsx";
import AgentsWorkspace from "@/components/work/AgentsWorkspace.jsx";
export const dynamic = "force-dynamic";
export default function Page() { return <Shell active="agents"><AgentsWorkspace /></Shell>; }
