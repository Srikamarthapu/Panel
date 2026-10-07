import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { AVATAR_PALETTES } from "../../lib/interface-preferences.js";

// Stylesheets imported by the current workspace routes. Legacy styles.css and
// mission.css carry their own semantic palette and are deliberately excluded.
const ACCENT_STYLESHEETS = [
  "app/control-center.css", "app/conversation.css", "app/models-refinement.css", "app/preferences.css",
  "app/tools-refinement.css", "app/voice-refinement.css", "app/work.css", "app/workspace-refinement.css",
  "components/control/JevRouterSettings.module.css", "components/work/StartupScreen.module.css",
];
// Status greens keep their meaning whatever the avatar color is.
const SEMANTIC_SELECTOR = /\b(ok|online|up)\b|--tone-task|\.statusDot\[data-tone=muted\]|\.providerConnectionDot\s*\{|\.liveIndicator(?=\s*\{|::before)|\.modelAccessBadge\[data-state=(?:tested|verified)\]|\.providerConnectionDot\[data-connected=true\]|\.liveIndicator\[data-live=true\]|\.status\[data-active\]/;
const LITERAL = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b|rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)/g;

function oklchOf(literal) {
  let rgb;
  if (literal[0] === "#") {
    const hex = literal.length === 4 ? [...literal.slice(1)].map(c => c + c).join("") : literal.slice(1);
    rgb = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
  } else rgb = literal.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number);
  const [r, g, b] = rgb.map(c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  return { chroma: Math.hypot(a, bb), hue: (Math.atan2(bb, a) * 180 / Math.PI + 360) % 360 };
}

test("workspace accent tints follow the chosen avatar palette instead of fixed sage", () => {
  const stray = [];
  for (const file of ACCENT_STYLESHEETS) {
    fs.readFileSync(file, "utf8").split("\n").forEach((line, index) => {
      for (const match of line.matchAll(LITERAL)) {
        const { chroma, hue } = oklchOf(match[0]);
        if (chroma < 0.008 || hue < 130 || hue > 200) continue;
        if (line.slice(Math.max(0, match.index - 11), match.index) === "oklch(from ") continue;
        if (SEMANTIC_SELECTOR.test(line.slice(0, match.index))) continue;
        stray.push(`${file}:${index + 1} ${match[0]}`);
      }
    });
  }
  assert.deepEqual(stray, [], "Wrap sage tints as oklch(from <sage> l calc(c * var(--accent-chroma)) calc(h + var(--accent-hue)))");
});

test("every non-default avatar palette re-hues the workspace accent", () => {
  const css = fs.readFileSync("app/control-center.css", "utf8");
  assert.match(css, /:root \{ --accent-hue:0; --accent-chroma:1; \}/);
  for (const key of Object.keys(AVATAR_PALETTES).filter(key => key !== "sage")) {
    assert.match(css, new RegExp(`html\\[data-panel-accent=${key}\\] \\{ --accent-hue:-?[\\d.]+; --accent-chroma:[\\d.]+; \\}`), key);
  }
});
