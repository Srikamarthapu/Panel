# Third-party notices

Panel uses React, Next.js, Lucide, Motion, Thinking Orbs, VAD Web, and ONNX Runtime through npm. Their licenses are included in their packages and recorded in the lockfile.

- **Bloub** by Jérémy Perret: MIT. Vendored engine and exact upstream provenance are in `components/avatar/bloub/vendor/UPSTREAM.md`; preserve `LICENSE.bloub` alongside it. The upstream's license covers its code; it does not grant endorsement or branding rights.
- **Silero VAD**, **VAD Web**, and **ONNX Runtime** assets: license files accompany the redistributed assets in `public/voice-vad/`.
- **Thinking Orbs** by Jakub Antalik: original animation engine from the `thinking-orbs` package.
- **Hermes Agent** is a separate user-installed project. Panel does not bundle its source, credentials, or user data.

Model providers, speech services, and TypeSafe/Jev are external services governed by their own terms. API usage is billed by the provider. Panel does not supply service credentials.
