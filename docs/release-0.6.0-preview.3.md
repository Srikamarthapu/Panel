# Panel 0.6.0-preview.3

This preview improves saved-agent specialization, concurrent permission handling, and the accuracy of completed-work receipts discovered during a bounded local testflight.

## Install and run

Panel is distributed as source for local macOS use and requires Node.js 22 or newer:

```sh
npm ci
npm run build
npm start
```

Open `http://127.0.0.1:3000`, then choose either an existing configured Hermes Agent installation or Direct API mode with your own OpenAI, OpenRouter, or DeepSeek key. Hermes provides tools, permissions, delegation, and workspace planning. Direct API mode provides durable streaming conversation only. See the [README](../README.md) for setup and privacy details.

## Changes

- Updated Next.js to 16.4.2 and added a production dependency audit to CI after the fresh-install release check found newly published security advisories.
- The main Hermes assistant can create saved Panel teammates with explicit tool and skill allowlists. Later profile listings now report whether access is legacy unrestricted, explicitly empty or selected, or unavailable because a stored policy is malformed, so the assistant can choose a specialist from configured capabilities.
- Main-created teammates may use an explicitly selected existing work folder or inherit the current conversation folder. Profile listings return that configured folder, and action-specific field guidance states which profile and run identifiers are required.
- Restricted teammate policies remain fail-closed across tool discovery, direct registry dispatch, parsed tool calls, skill listing and loading, and workspace skill auto-loads. Restricted teammates cannot delegate because Panel does not yet carry their policy into native children.
- Concurrent native permission requests are queued per active run instead of replacing one another. Foreign-session and stale decisions are rejected, cancellation clears the public prompt and owned response file, and the next request is presented only after the prior request resolves.
- Terminal runs clear stale permission and tool-progress state while preserving the run and outcome evidence needed to understand completed actions.
- Outcome review labels terminal tool receipts that never reached completion as unfinished, instead of presenting their last in-progress state as current activity.
- General work guidance now asks the assistant to discover deferred configured tools before declaring a needed capability unavailable, then exercise interactive controls, focus, form validation, overflow, and console states at relevant rendered sizes when browser tools are configured. It also asks for inspection of real visual-artifact bounds and colors, with unavailable checks reported explicitly.
- Visual-artifact guidance now requires generated SVG and XML parsing, local image decoding with nonzero natural dimensions, visibility checks against each presentation background, actual rendered specimen-size measurements, and print notes that distinguish live text from outlined artwork.
- Hermes `web_extract` receipts now use their structured result envelope, including the native untrusted-result wrapper. A null `error` remains a genuine success, while top-level, per-page, mixed, and malformed errors remain failures instead of being classified from incidental text.

## Evidence and limits

Release acceptance uses portable Node and Python checks, isolated production browser tests, source-manifest verification, and bounded local provider runs. Exact candidate counts belong to the publication record for the final exported checkout; historical counts are not reused as proof for a changed candidate.

For the published prerelease, the associated GitHub release record and CI run are the acceptance record for the exact exported source. Earlier installed-app testflight evidence informed these changes but is not a substitute for the clean-export gate.

Direct API mode remains tool-free and does not exercise Hermes capability enforcement or delegation. The testflight does not establish readiness for every provider, plugin, physical audio setup, scheduled restricted profile, or native-child policy inheritance. Generated websites and brand assets improved substantially after reviewer feedback but still fell below the evaluation's unattended professional-design threshold; Panel should be treated as a reviewable work surface, not a guarantee of professional output from every model or prompt.

No signed or notarized native application is included. The supported release is the local source/browser app. See [release checks](../RELEASE-CHECKS.md) for the reproducible gate and remaining limitations.
