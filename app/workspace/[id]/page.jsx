import Shell from "@/components/shell/Shell.jsx";
import WorkspaceTabView from "@/components/workspace/WorkspaceTabView.jsx";

export const dynamic = "force-dynamic";

export default async function Page({ params }) {
  const { id } = await params;
  return <Shell active="workspace"><WorkspaceTabView id={id} /></Shell>;
}
