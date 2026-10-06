export function selectEarlyVoiceFeedback(text) {
  const prompt = String(text || "").trim();
  if (!prompt) return null;
  if (/\b(say|quote|repeat|translate)\b/i.test(prompt)) return null;
  const clarityAction = /(?:^|[.!?]\s*|\b(?:please|just|can you|could you|would you)\s+)(?:stop\s+[^.!?]{0,60}\s+)?(?:just\s+)?(?:summari[sz]e|rewrite|rephrase|make (?:that|it|this) clearer|be clearer)\b/i;
  if (clarityAction.test(prompt) && !/\b(?:don['’]t|do not|never)\s+(?:\w+\s+){0,3}(?:summari[sz]e|rewrite|rephrase|make|be clearer)\b/i.test(prompt)) return "I’ll make that clearer.";
  if (/\b(don['’]t|do not|never|without)\b/i.test(prompt)) return null;
  if (/^(hi|hello|hey|thanks|thank you|good (morning|afternoon|evening))[.!?\s]*$/i.test(prompt)) return null;
  const notionAction = /^(?:please\s+|can you\s+|could you\s+|would you\s+|i need you to\s+|help me\s+)?(search|look|find|read|open|check|query)\b/i.exec(prompt)
    || /\b(?:please|can you|could you|would you|i need you to|help me)\s+(search|look|find|read|open|check|query)\b/i.exec(prompt);
  if (notionAction) {
    const action = notionAction[1];
    const directTarget = new RegExp(`\\b${action}\\b\\s+(?:(?:in|on|from|through|my|the|relevant|matching|requested|specific)\\s+){0,3}notion\\b`, "i").test(prompt);
    const locatedTarget = new RegExp(`\\b${action}\\b.{0,80}\\b(?:in|on|within|from)\\s+(?:my\\s+|the\\s+)?notion\\b`, "i").test(prompt);
    if (directTarget || locatedTarget) {
      if (/^(read|open)$/i.test(action)) return "I’ll open the relevant Notion page now.";
      if (/^(search|look|find|query)$/i.test(action)) return "I’ll search Notion now.";
      return "I’ll check Notion now.";
    }
  }
  if (/\b(my|today|tomorrow|this week|next week)\b/i.test(prompt) && /\b(calendar|schedule|availability|appointment|meeting)\b/i.test(prompt) && /\b(check|show|open|find|what(?:'s| is) on|do i have|am i free|when is)\b/i.test(prompt)) return "I’ll check your calendar.";
  if (/\b(?:please|try|can you|could you|would you)\s+(?:try\s+)?(?:open|opening|show|check)(?:ing)?\s+(?:my|the)\s+calendar\b/i.test(prompt) || /^(?:open|show|check)\s+(?:my|the)\s+calendar\b/i.test(prompt)) return "I’ll check your calendar.";
  if (/\b(what (?:do )?i have|what(?:'s| is) on my agenda)\b/i.test(prompt) && /\b(today|tomorrow|this week|next week)\b/i.test(prompt)) return "I’ll check your calendar.";
  if (/\b(weather|forecast|temperature|rain|snow)\b/i.test(prompt) && /\b(today|tomorrow|this (morning|afternoon|evening|week)|in [a-z][a-z .'-]+|for [a-z][a-z .'-]+|will it|what(?:'s| is) the)\b/i.test(prompt)) return "I’ll check the weather.";
  if (/\b(my|inbox|unread|latest|recent)\b/i.test(prompt) && /\b(email|inbox|mail|messages?)\b/i.test(prompt) && /\b(check|show|open|find|search|read)\b/i.test(prompt)) return "I’ll check your messages.";
  if (/\b(my|the)\b/i.test(prompt) && /\b(file|document|note|notes)\b/i.test(prompt) && /\b(find|look for|search|open|check)\b/i.test(prompt)) return "I’ll look for that file.";
  if (/\b(search (?:the )?web|look up|find online|research)\b/i.test(prompt)) return "I’ll look that up.";
  return null;
}

export function selectProgressVoiceFeedback(statusLabel) {
  const label = String(statusLabel || "").trim();
  const safe = new Map([
    ["Searching the web", "I’m checking the sources now."],
    ["Searching the workspace", "I’m searching the relevant files now."],
    ["Reading a file", "I’m reading the relevant file now."],
    ["Searching Notion", "I’m searching Notion now."],
    ["Reading Notion", "I’m reading the relevant Notion page now."],
    ["Searching Apple Notes", "I’m searching your notes now."],
    ["Searching memory", "I’m checking the saved context now."],
  ]);
  return safe.get(label) || null;
}
