import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

test("NVIDIA discovery admits new models, excludes known non-chat and hosted deprecations without rejecting self-hosted IDs", () => {
  const output = execFileSync("python3", ["-c", `
import importlib.util, json
spec = importlib.util.spec_from_file_location("catalog", "scripts/models/hermes-catalog.py")
catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog)
ids = ["new-provider/new-chat-model", "nvidia/nemotron-3-embed-1b", "meta/llama-3.3-70b-instruct"]
print(json.dumps({"hosted": catalog.nvidia_chat_models(ids), "selfHosted": catalog.nvidia_chat_models(ids, False), "saved": catalog.selection_model("unknown/private-model", "nvidia"), "deprecated": catalog.selection_model("deepseek-ai/deepseek-v4-flash", "nvidia")}))
`], { cwd: process.cwd(), encoding: "utf8" });
  const data = JSON.parse(output);
  assert.deepEqual(data.hosted, ["new-provider/new-chat-model"]);
  assert.deepEqual(data.selfHosted, ["new-provider/new-chat-model", "meta/llama-3.3-70b-instruct"]);
  assert.equal(data.saved.availability, "not-listed");
  assert.equal(data.saved.available, undefined);
  assert.equal(data.deprecated.available, false);
  assert.equal(data.deprecated.availability, "deprecated");
});
