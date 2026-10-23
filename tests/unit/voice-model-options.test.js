import test from "node:test";
import assert from "node:assert/strict";
import { voiceModelLabel } from "../../components/voice/voiceModelOptions.js";

test("conversation model labels distinguish inherited and pinned choices", () => {
  assert.equal(voiceModelLabel({}), "Following main model");
  assert.equal(voiceModelLabel({ voiceModelProvider: "provider", voiceModel: "exact-id" }), "provider / exact-id");
});
