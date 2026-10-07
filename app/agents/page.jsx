import Shell from "@/components/shell/Shell.jsx";
import AgentsPane from "@/components/work/AgentsPane.jsx";
export const dynamic = "force-dynamic";
export default function Page() { return <Shell active="agents"><AgentsPane standalone /></Shell>; }
