/** Collect the text transport without speech-oriented formatting or length
 * reduction. The iterator is closed at the display ceiling, bounding memory
 * and avoiding work for tokens the client cannot display. */
import { publicReplyTokens } from "./publicReply.js";
import { MAX_ASSISTANT_TEXT } from "./conversation-limits.js";

export async function collectFormattedTextReply(tokens, maxChars = MAX_ASSISTANT_TEXT) {
  let response = "";
  for await (const token of publicReplyTokens(tokens)) {
    if (typeof token !== "string") continue;
    response += token.slice(0, maxChars - response.length);
    if (response.length >= maxChars) break;
  }
  // Do not leave half an emoji if a token crosses the UTF-16 length ceiling.
  return response.replace(/[\uD800-\uDBFF]$/, "");
}
