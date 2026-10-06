# Security

Panel is a local, single-user application that can ask an installed Hermes runtime to execute tools with your permissions. Bind it to loopback, use your own credentials, and review Hermes's tool approval settings. It is not designed to be exposed through a public tunnel, reverse proxy, or shared server.

Do not put secrets or private transcripts in public issue reports. If you discover an exposure, stop the local server, preserve a minimal redacted reproduction, and contact the repository maintainer privately before posting details. This project has not yet published a dedicated security contact.

Never publish the development workspace wholesale. The release export uses an allowlist and excludes Git history, local state, environment files, launch agents, recordings, and built apps. Review the export and scan it again before publishing. A pattern scanner reduces accidental leakage but cannot prove the absence of all private data.
