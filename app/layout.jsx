import "./styles.css";
import "./mission.css";
import "./control-center.css";
import "./voice-refinement.css";
import "./tools-refinement.css";
import "./conversation.css";
import "./work.css";
import "./models-refinement.css";
import "./preferences.css";
import "./workspace-refinement.css";
import WorkSessionProvider from "@/components/work/WorkSessionProvider.jsx";
import InterfacePreferencesProvider from "@/components/preferences/InterfacePreferencesProvider.jsx";

export const metadata = {
  title: "Panel",
  description: "A local workspace for talking and working with your AI agent."
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <InterfacePreferencesProvider><WorkSessionProvider>{children}</WorkSessionProvider></InterfacePreferencesProvider>
      </body>
    </html>
  );
}
