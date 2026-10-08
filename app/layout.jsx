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
import OnboardingGate from "@/components/onboarding/OnboardingGate.jsx";
import { INTERFACE_PREFERENCES_KEY } from "@/lib/interface-preferences.js";

export const metadata = {
  title: "Panel",
  description: "A local workspace for talking and working with your AI agent."
};

// Apply saved appearance before first paint so a non-sage palette does not
// flash sage while the preferences provider hydrates.
const appearanceScript = `try{var p=JSON.parse(localStorage.getItem(${JSON.stringify(INTERFACE_PREFERENCES_KEY)})||"{}"),d=document.documentElement;if(["blue","peach","lilac"].indexOf(p.avatarColor)>-1)d.dataset.panelAccent=p.avatarColor;if(p.textSize==="larger")d.dataset.panelTextSize="larger";if(p.conversationSpacing==="compact")d.dataset.panelConversationSpacing="compact"}catch(e){}`;

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: appearanceScript }} /></head>
      <body>
        <InterfacePreferencesProvider><OnboardingGate><WorkSessionProvider>{children}</WorkSessionProvider></OnboardingGate></InterfacePreferencesProvider>
      </body>
    </html>
  );
}
