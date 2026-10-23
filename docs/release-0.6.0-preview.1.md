# Panel 0.6.0-preview.1

This preview implements the first Panel roadmap slice: consistent model selection, persistent workspace navigation, and neutral interface surfaces. It does not complete the roadmap or add monetization.

- Chat and Talk resolve their next model through the same server function used by execution. The conversation picker shows the model and why it was selected.
- Changing Main offers a choice to update separately pinned surfaces. Existing shared conversation pins are preserved as explicit Chat and Talk pins; new unconfigured surfaces follow Main until a model is chosen.
- Teammate model assignments and Direct API connections retain precedence. Runtime receipts warn when a reported route differs from the requested route.
- Voice settings link to Models instead of maintaining a second model editor.
- The sidebar retains its state across navigation and reloads. Command/Ctrl+B toggles it outside editable fields and dialogs; collapsed controls have keyboard tooltips.
- Neutral surfaces and navigation use a gray scale, with companion colors retained for deliberate accents.

Model routing checks use isolated configuration and fake runtime fixtures. They do not establish live provider availability or Bluetooth audio quality. The Hermes updater, broader Work/settings reorganization, and richer verification receipts remain later milestones.
