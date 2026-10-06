// Keep conversation storage independent from the amount read aloud.
export const MAX_USER_TEXT = 32000;
export const MAX_ASSISTANT_TEXT = 64000;
export const MAX_TRANSCRIPT_ENTRIES = 100;
export const MAX_SPOKEN_TEXT = 6000;

export function spokenExcerpt(text) {
  const value = String(text || "");
  if (value.length <= MAX_SPOKEN_TEXT) return value;
  const excerpt = value.slice(0, MAX_SPOKEN_TEXT - 70);
  const sentence = Math.max(excerpt.lastIndexOf(". "), excerpt.lastIndexOf("! "), excerpt.lastIndexOf("? "));
  return `${excerpt.slice(0, sentence > excerpt.length / 2 ? sentence + 1 : excerpt.lastIndexOf(" "))} The full answer is available in Chat.`;
}
