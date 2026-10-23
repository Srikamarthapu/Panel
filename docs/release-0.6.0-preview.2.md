# Panel 0.6.0-preview.2

This preview fixes reply finalization when an installed Hermes runtime substitutes its own ACP agent implementation during construction.

- Panel preserves its configured ACP adapter and completion hooks when Hermes uses a factory constructor.
- Missing authoritative results remain scoped to reply finalization instead of replacing the response with unrelated setup guidance.
- Streamed assistant text remains as an explicitly interrupted response when the final result is unavailable, and the error remains visible instead of the reply disappearing after the run ends.

The release retains the model-routing, persistent-shell, and neutral-interface changes from `0.6.0-preview.1`. Verification uses isolated and mocked runtime fixtures; it does not establish live provider availability.
