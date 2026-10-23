import test from "node:test";
import assert from "node:assert/strict";
import { hasUnsafeReviewText } from "../../lib/text-safety.js";

test("review text rejects hidden controls and Unicode tags", () => {
  for (const character of [
    "\u0000", "\u0008", "\u000B", "\u000C", "\u001F", "\u007F", "\u0080", "\u0085", "\u009B", "\u009F", "\u00AD",
    "\u061C", "\u180E", "\u200B", "\u200E", "\u200F", "\u202A", "\u202E",
    "\u2060", "\u2064", "\u206A", "\u206F", "\uFEFF", "\u{E0000}", "\u{E007F}",
  ]) assert.equal(hasUnsafeReviewText(`before${character}after`), true, character.codePointAt(0).toString(16));
});

test("review text preserves ordinary language, whitespace, joiners, and variation selectors", () => {
  for (const value of [
    "line one\tline two\nline three\rline four",
    "combining grapheme joiner a\u034Fb",
    "می‌خواهم این متن حفظ شود",
    "Mongolian variation ᠠ\u180B ᠠ\u180C ᠠ\u180D",
    "family 👨‍👩‍👧‍👦 and airplane ✈️",
    `supplemental variation A\u{E0100}`,
    "日本語の通常の文章",
  ]) assert.equal(hasUnsafeReviewText(value), false, value);
});
