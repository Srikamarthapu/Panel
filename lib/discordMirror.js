// Discord webhook mirror for voice conversations.
//
// Posts each user/Hermes turn to a separate webhook so the channel reads
// like a chat log: one webhook posts as "You", the other as "Hermes",
// with their own avatars/usernames per Discord's webhook override.
//
// Webhook URLs come from the voice config (see lib/voice.js). Empty/missing
// URLs make this module a no-op so the voice flow never blocks on Discord.

const HERMES_AVATAR =
  "https://raw.githubusercontent.com/twitter/twemoji/master/assets/72x72/1f9ad.png"; // octopus
const USER_AVATAR =
  "https://raw.githubusercontent.com/twitter/twemoji/master/assets/72x72/1f3a4.png"; // microphone

// Discord caps message content at 2000 chars; trim conservatively.
const MAX_CONTENT_CHARS = 1900;

function truncate(text) {
  const s = String(text == null ? "" : text);
  if (s.length <= MAX_CONTENT_CHARS) return s;
  return s.slice(0, MAX_CONTENT_CHARS - 1) + "…";
}

function isValidWebhookUrl(url) {
  return (
    typeof url === "string" &&
    /^https:\/\/discord\.com\/api\/webhooks\/\d+\/[\w-]+/i.test(url)
  );
}

async function postWebhook(url, payload) {
  if (!isValidWebhookUrl(url)) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      // 10s budget — webhooks normally answer in <1s; if Discord stalls we
      // don't want to hold up the voice response.
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    // Silently swallow — voice mirroring must never break the conversation.
  }
}

/**
 * Send the user's transcribed turn to the "You" webhook.
 */
export function mirrorUserTurn({ webhookUrl, text }) {
  const content = truncate(text);
  if (!content) return;
  return postWebhook(webhookUrl, {
    content,
    username: "You",
    avatar_url: USER_AVATAR,
    allowed_mentions: { parse: [] },
  });
}

/**
 * Send Hermes' reply to the "Hermes" webhook.
 */
export function mirrorHermesTurn({ webhookUrl, text }) {
  const content = truncate(text);
  if (!content) return;
  return postWebhook(webhookUrl, {
    content,
    username: "Hermes",
    avatar_url: HERMES_AVATAR,
    allowed_mentions: { parse: [] },
  });
}
