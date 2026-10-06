import Shell from "@/components/shell/Shell.jsx";
import SessionsWorkspace from "@/components/work/SessionsWorkspace.jsx";

export const dynamic = "force-dynamic";
export default function Page() { return <Shell active="sessions"><SessionsWorkspace /></Shell>; }
