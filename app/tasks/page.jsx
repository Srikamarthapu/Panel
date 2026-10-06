import Shell from "@/components/shell/Shell.jsx";
import TasksWorkspace from "@/components/work/TasksWorkspace.jsx";

export const dynamic = "force-dynamic";

export default function Page() {
  return <Shell active="tasks"><TasksWorkspace /></Shell>;
}
