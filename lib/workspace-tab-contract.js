export const WORKSPACE_PLAN_FENCE = /```panel-plan\s*([\s\S]*?)```/i;
const WORKSPACE_REVIEW_JSON_FENCE = /```json\s*([\s\S]*?)```/i;
export const WORKSPACE_TAB_FENCE = /```panel-tab\s*([\s\S]*?)```/i;
export const MAX_TAB_SPEC_BYTES = 80_000;

const BLOCK_TYPES = new Set(["text", "field", "notes", "checklist", "table", "action"]);
const FIELD_KINDS = new Set(["text", "textarea", "number", "date", "select"]);
const RESERVED_BLOCK_IDS = new Set(["__proto__", "constructor", "prototype"]);
const UNSAFE_TEXT = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const plainObject = value => value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const fail = () => { throw new Error("Hermes did not return a valid Panel tab. Keep the current version and ask it to try again."); };
function exactKeys(value, allowed, required = allowed) {
  if (!plainObject(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail();
}
function boundedString(value, max, { empty = false } = {}) {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim()) || UNSAFE_TEXT.test(value)) fail();
  return value.trim();
}
function boundedList(value, maxItems, maxString) {
  if (!Array.isArray(value) || !value.length || value.length > maxItems) fail();
  return value.map(item => boundedString(item, maxString));
}

function normalizeWorkspacePlan(value) {
  const line = (item, max) => typeof item === "string" && item.trim() && item.length <= max ? item.trim() : null;
  const list = key => Array.isArray(value[key]) && value[key].length <= 8 ? value[key].map(item => line(item, 300)).filter(Boolean) : [];
  const plan = { title: line(value.title, 60), outcome: line(value.outcome, 1000), features: list("features"), connections: list("connections"), boundaries: list("boundaries"), checks: list("checks") };
  return plan.title && plan.outcome && plan.features.length && plan.checks.length ? plan : null;
}

export function parseWorkspacePlan(text) {
  try {
    const match = String(text || "").match(WORKSPACE_PLAN_FENCE);
    if (!match) return null;
    return normalizeWorkspacePlan(JSON.parse(match[1]));
  } catch { return null; }
}

export function parseWorkspaceReviewPlan(text) {
  const exact = parseWorkspacePlan(text);
  if (exact) return exact;
  try {
    const match = String(text || "").match(WORKSPACE_REVIEW_JSON_FENCE);
    return match ? normalizeWorkspacePlan(JSON.parse(match[1])) : null;
  } catch { return null; }
}

export function planningMessageText(text, { review = false } = {}) {
  return String(text || "").replace(WORKSPACE_PLAN_FENCE, "").replace(review ? WORKSPACE_REVIEW_JSON_FENCE : /$^/, "").trim();
}

export function parseWorkspaceSpec(value) {
  exactKeys(value, ["title", "description", "blocks"]);
  const spec = { title: boundedString(value.title, 80), description: boundedString(value.description, 300, { empty: true }), blocks: [] };
  if (!Array.isArray(value.blocks) || !value.blocks.length || value.blocks.length > 20) fail();
  const ids = new Set();
  for (const input of value.blocks) {
    if (!plainObject(input) || !BLOCK_TYPES.has(input.type)) fail();
    const id = boundedString(input.id, 40);
    if (!/^[A-Za-z0-9_-]+$/.test(id) || RESERVED_BLOCK_IDS.has(id) || ids.has(id)) fail();
    ids.add(id);
    const common = { id, type: input.type, title: boundedString(input.title, 100) };
    let block;
    if (input.type === "text") {
      exactKeys(input, ["id", "type", "title", "text"]);
      block = { ...common, text: boundedString(input.text, 4000, { empty: true }) };
    } else if (input.type === "field") {
      exactKeys(input, input.kind === "select" ? ["id", "type", "title", "label", "kind", "options"] : ["id", "type", "title", "label", "kind"]);
      const kind = boundedString(input.kind, 20);
      if (!FIELD_KINDS.has(kind)) fail();
      block = { ...common, label: boundedString(input.label, 120), kind };
      if (kind === "select") {
        const options = boundedList(input.options, 20, 120);
        if (new Set(options).size !== options.length) fail();
        block.options = options;
      }
    } else if (input.type === "notes") {
      exactKeys(input, ["id", "type", "title", "label"]);
      block = { ...common, label: boundedString(input.label, 120) };
    } else if (input.type === "checklist") {
      exactKeys(input, ["id", "type", "title", "items"]);
      block = { ...common, items: boundedList(input.items, 40, 240) };
    } else if (input.type === "table") {
      exactKeys(input, ["id", "type", "title", "columns"]);
      const columns = boundedList(input.columns, 12, 80);
      if (new Set(columns).size !== columns.length) fail();
      block = { ...common, columns };
    } else {
      exactKeys(input, ["id", "type", "title", "label", "prompt"]);
      block = { ...common, label: boundedString(input.label, 120), prompt: boundedString(input.prompt, 12_000) };
    }
    spec.blocks.push(block);
  }
  for (const block of spec.blocks) {
    if (block.type !== "action") continue;
    const references = [...block.prompt.matchAll(/{{([A-Za-z0-9_-]{1,40})}}/g)].map(match => match[1]);
    if (references.some(id => !ids.has(id))) fail();
    if (block.prompt.replace(/{{[A-Za-z0-9_-]{1,40}}}/g, "").includes("{{") || block.prompt.replace(/{{[A-Za-z0-9_-]{1,40}}}/g, "").includes("}}")) fail();
  }
  if (new TextEncoder().encode(JSON.stringify(spec)).byteLength > MAX_TAB_SPEC_BYTES) fail();
  return spec;
}

export function extractWorkspaceSpec(text) {
  try {
    const match = String(text || "").match(WORKSPACE_TAB_FENCE);
    if (!match) fail();
    return parseWorkspaceSpec(JSON.parse(match[1]));
  } catch (error) {
    if (error?.message?.startsWith("Hermes did not return a valid Panel tab")) throw error;
    fail();
  }
}

export function workspaceTurnInstructions({ mode = "plan", plan } = {}) {
  const common = "You are helping the user create a custom tab in Panel, a local Hermes workspace. This is a design conversation with tools disabled. Do not run tools, place trades, connect accounts, claim an integration is connected, or change files. Never request passwords or API keys in chat. Secrets belong in the existing provider's secure setup. A custom tab is rendered by Panel from a small set of native blocks: text, field, notes, checklist, table, and reviewed action. It stores small local JSON state. It cannot execute code, access the network, parent page, credentials, or filesystem. An action block can only propose a Hermes task which the user reviews before running. External data or actions require that reviewed Hermes task and a configured Hermes tool. Be explicit about this boundary and anything unavailable; never fabricate live prices, balances, rows, completed actions, or connected services.";
  if (mode === "build") return `${common}\n\nThe user has approved this plan: ${JSON.stringify(plan)}\n\nReturn the complete tab as ONE fenced panel-tab JSON object with no extra prose. Use exactly this schema: {"title":"Short tab title","description":"What this tab helps with","blocks":[{"id":"intro","type":"text","title":"Overview","text":"Helpful text"},{"id":"goal","type":"field","title":"Goal","label":"Current goal","kind":"text"},{"id":"notes","type":"notes","title":"Notes","label":"Working notes"},{"id":"steps","type":"checklist","title":"Steps","items":["First step"]},{"id":"results","type":"table","title":"Results","columns":["Item","Status"]},{"id":"review","type":"action","title":"Ask Hermes","label":"Review my work","prompt":"Review this goal: {{goal}} and these notes: {{notes}}"}]}. Every block needs a unique id using letters, numbers, underscore or hyphen. Use at most 20 blocks. Field kind is text, textarea, number, date, or select; select also needs a non-empty options string array. Tables define columns only: never provide initial rows or model-generated data. Action prompts may reference block state as {{blockId}}, must be concrete and bounded, and always require host review before Hermes runs. All content must be plain text. Do not include HTML, Markdown rendering, JavaScript, URLs, executable code, unknown fields, initial values, fake activity, or sample or live data. Build only the agreed local interactions and use clear labels and useful empty-state text.`;
  if (mode === "review") return `${common}\n\nPrepare the plan for review now from the requirements already discussed. Do not ask another optional question. If one essential requirement is genuinely missing, state only that missing requirement. Otherwise give a short plain-language summary followed by exactly ONE fenced panel-plan JSON object with this shape: {"title":"Short title","outcome":"Concrete user outcome","features":["Native Panel behavior"],"connections":["Required external connection, or None"],"boundaries":["Honest limitation"],"checks":["Observable acceptance check"]}. Include every key. Keep each array to at most eight concrete strings. The review card is not approval to build; Panel will ask the user separately.`;
  return `${common}\n\nAsk one or two useful questions at a time to clarify the outcome, information needed, actions, update cadence, and what success looks like. Explain which native Panel blocks fit the request. Do not jump into implementation. For a market or trading request, distinguish research, alerts, paper trading and real execution; identify data or brokerage connections and human approval boundaries without recommending investments or asking for credentials. Explain what this tab can actually support. After at least two user turns and after open requirements are resolved, summarize the agreed plan, then include a fenced panel-plan JSON object with {title,outcome,features:[...],connections:[...],boundaries:[...],checks:[...]}. Every field must be concrete; checks are acceptance criteria. If the user changes the requirements, discuss the change and issue an updated plan only when ready. Do not claim the user has approved it: Panel provides an explicit Build preview button.`;
}
