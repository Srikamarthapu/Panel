import test from "node:test";
import assert from "node:assert/strict";

import { selectEarlyVoiceFeedback, selectProgressVoiceFeedback } from "../../components/voice/voiceFeedback.js";

test("early voice feedback is specific to an explicit retrieval intent", () => {
  assert.equal(selectEarlyVoiceFeedback("Can you check my calendar tomorrow?"), "I’ll check your calendar.");
  assert.equal(selectEarlyVoiceFeedback("What's on my agenda tomorrow?"), "I’ll check your calendar.");
  assert.equal(selectEarlyVoiceFeedback("What do I have today?"), "I’ll check your calendar.");
  assert.equal(selectEarlyVoiceFeedback("I've already authorized it. Try opening the calendar."), "I’ll check your calendar.");
  assert.equal(selectEarlyVoiceFeedback("Please stop mumbling and summarize that better."), "I’ll make that clearer.");
  assert.equal(selectEarlyVoiceFeedback("Look up the weather this afternoon"), "I’ll check the weather.");
  assert.equal(selectEarlyVoiceFeedback("Find my latest unread email"), "I’ll check your messages.");
  assert.equal(selectEarlyVoiceFeedback("Search Notion for the launch plan."), "I’ll search Notion now.");
  assert.equal(selectEarlyVoiceFeedback("Could you find the onboarding note in my Notion workspace?"), "I’ll search Notion now.");
  assert.equal(selectEarlyVoiceFeedback("Please open the relevant Notion page."), "I’ll open the relevant Notion page now.");
});

test("greetings, quick conversation, and ambiguous work do not get filler speech", () => {
  for (const prompt of ["Hi", "Thanks!", "How are you?", "Am I audible?", "Explain photosynthesis", "Do that for me", "What is a calendar?", "What is weather?", "What is Notion?", "Can you explain how to search Notion?", "Don't check my calendar", "Don’t check my calendar", "Repeat: check my calendar tomorrow"]) {
    assert.equal(selectEarlyVoiceFeedback(prompt), null);
  }
  assert.equal(selectEarlyVoiceFeedback("Don't summarize this."), null);
  assert.equal(selectEarlyVoiceFeedback("What does opening a calendar mean?"), null);
});

test("progress speech only maps a concrete safe tool stage", () => {
  assert.equal(selectProgressVoiceFeedback("Searching the web"), "I’m checking the sources now.");
  assert.equal(selectProgressVoiceFeedback("Reading a file"), "I’m reading the relevant file now.");
  assert.equal(selectProgressVoiceFeedback("Thinking through your request…"), null);
  assert.equal(selectProgressVoiceFeedback("Composing a reply…"), null);
  assert.equal(selectProgressVoiceFeedback("Calling unknown_private_tool"), null);
  assert.equal(selectProgressVoiceFeedback("Writing a file"), null);
  assert.equal(selectProgressVoiceFeedback("Sending a message"), null);
});
