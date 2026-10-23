// Reject invisible characters that can conceal or reorder reviewed instructions.
// Joiners and variation selectors remain valid for ordinary language and emoji.
const UNSAFE_REVIEW_TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u{E0000}-\u{E007F}]/u;

export function hasUnsafeReviewText(value) {
  return typeof value === "string" && UNSAFE_REVIEW_TEXT.test(value);
}
