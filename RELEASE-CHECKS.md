# Release checks

This checklist applies to the `0.6.0-preview.3` local source release. Hermes Agent is the default full-capability runtime. Direct API mode supports durable Chat and Talk conversations with OpenAI, OpenRouter, or DeepSeek using a server-side key, but it does not provide tools, file or web access, delegation, or workspace planning.

The supported public distribution is source plus the loopback browser app. The experimental Tauri wrapper is excluded. No signed or notarized native installer is provided.

## Publication record

For a published tag, use its GitHub release and associated CI run as the acceptance record for the exact exported source. Installed-app testflights and earlier local builds can inform a release, but they do not replace clean-export verification. Keep exact counts and live-provider observations in the GitHub release record rather than copying results from a different candidate into this durable checklist.

## Clean-checkout gate

Use Node.js 22 or newer on macOS. Run release checks from a clean exported checkout with no `.env` file, existing Panel data, or Hermes installation in the test roots:

```sh
npm ci
npm run release:manifest:verify
node scripts/release/check.mjs .
npm test
npm run test:browser-server
npx playwright install chromium
npm run test:e2e
npm run test:smoke
npm run build
npm audit --omit=dev
```

`npm test` includes Node unit and property suites plus portable Python adapter checks. Tests that import a live installed Hermes runtime are explicitly skipped and are not passes. `npm run test:py:host` intentionally exits before starting Hermes until a fully sandboxed host fixture exists.

Playwright creates an isolated production build and owned loopback server by default. Use `PANEL_TEST_URL` only when intentionally testing an external server. `npm run test:browser-server` is the smaller fake-executable lifecycle check; it does not replace the production-build browser suites.

CI runs the release source check, approved-manifest verification, dependency install, portable tests, the fake-executable browser-server lifecycle check, Chromium browser suites, and the production build on `macos-latest`. Manifest verification rejects source drift from the reviewed export; the browser-server check covers interrupted builds and owned process-group cleanup without replacing the production browser suites. A green workflow verifies that checkout and environment; it does not verify a user's provider credentials, live Hermes installation, microphone, speakers, or model quality.

## Source-export gate

Never publish the development checkout or its Git history directly. The reviewed manifest is the boundary for the public source export:

```sh
npm run release:manifest:prepare -- /tmp/panel-source-candidate.json
npm run release:manifest:review -- /tmp/panel-source-candidate.json
npm run release:manifest:approve -- /tmp/panel-source-candidate.json
npm run release:manifest:verify
npm run release:export -- /new/empty/export/path
node scripts/release/check.mjs /new/empty/export/path
```

Review the candidate before approval. The exporter refuses changed hashes, newly eligible files, symlinks, and missing local Python dependencies. Scan the exported directory again before publication. Do not include environment files, provider credentials, Panel or Hermes data, transcripts, recordings, agent profiles, launch agents, built applications, or private Git history.

## Manual acceptance

On the exported checkout:

1. Start Panel with no provider configuration and confirm the welcome guide explains Hermes and Direct API choices without exposing host paths.
2. Configure one execution mode. Run `npm run doctor`; it must not contact a model provider or print credentials.
3. Send one small Chat message when willing to consume provider usage. Confirm streaming reaches a terminal state and **Review work** distinguishes summaries, tool receipts, file claims, and execution evidence.
4. In Hermes mode, exercise any release-critical tool or saved-agent flow with the intended approval settings. Direct mode must continue to describe itself as tool-free.
5. Check keyboard navigation, focus, form validation, horizontal overflow, console errors, and reduced motion at representative desktop and narrow widths.
6. Confirm the listener is loopback-only and foreign hosts/origins are rejected.
7. Verify a stop request leaves completed side effects intact and presents interrupted or unfinished work honestly.

Record exact commands, counts, environment, skipped checks, and any live-provider calls in the release notes. Do not reuse historical counts as evidence for a changed candidate.

## Preview limitations

This preview does not establish compatibility with every Hermes revision, provider, plugin, model, or voice setup. Automated browser tests use synthetic or mocked media and do not prove physical microphone-to-speaker quality. A successful provider call does not prove billing behavior, long-session reliability, or model availability for another account.

Restricted saved teammates cannot delegate because their policy is not yet carried into native children. Direct API mode remains tool-free. Custom workspace layouts are validated Panel-native data; arbitrary generated HTML or scripts are not executed. Model-generated sites, designs, code, and other deliverables still require human review for correctness, accessibility, security, licensing, and professional quality.

Panel is a local single-user application. Do not expose it through a public tunnel, reverse proxy, or shared host. See [SECURITY.md](SECURITY.md) and the [0.6.0-preview.3 release notes](docs/release-0.6.0-preview.3.md).
