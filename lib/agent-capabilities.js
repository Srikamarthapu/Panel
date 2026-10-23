import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inputError } from "./work-store.js";

export const AGENT_POLICY_VERSION = 1;

// These are concrete Hermes tool names, not suggested behavior. Keep this list
// deliberately smaller than Hermes' internal registry: delegation and generic
// skill-management surfaces need policy inheritance that Panel does not yet
// provide, so restricted profiles never receive them.
export const AGENT_TOOL_CAPABILITIES = Object.freeze([
  { id: "web_search", name: "Web search", group: "Research", description: "Search the public web." },
  { id: "web_extract", name: "Read web pages", group: "Research", description: "Fetch and extract content from a URL." },
  { id: "read_file", name: "Read files", group: "Files and code", description: "Read files available to the Hermes process." },
  { id: "search_files", name: "Search files", group: "Files and code", description: "Find files and search their contents." },
  { id: "write_file", name: "Write files", group: "Files and code", description: "Create or replace files available to the Hermes process." },
  { id: "patch", name: "Patch files", group: "Files and code", description: "Apply targeted edits to files." },
  { id: "terminal", name: "Terminal", group: "System", description: "Run shell commands with the same host permissions as Hermes. This is broad access." },
  { id: "process_manage", name: "Manage processes", group: "System", description: "Inspect and control processes started through Hermes." },
  { id: "browser_navigate", name: "Open web pages", group: "Browser", description: "Navigate the managed browser." },
  { id: "browser_snapshot", name: "Read browser page", group: "Browser", description: "Read the current browser page structure." },
  { id: "browser_click", name: "Click in browser", group: "Browser", description: "Activate controls in the managed browser." },
  { id: "browser_type", name: "Type in browser", group: "Browser", description: "Enter text in the managed browser." },
  { id: "browser_scroll", name: "Scroll browser", group: "Browser", description: "Scroll the managed browser page." },
  { id: "browser_back", name: "Browser back", group: "Browser", description: "Return to the previous browser page." },
  { id: "browser_press", name: "Browser keys", group: "Browser", description: "Send keyboard input to the managed browser." },
  { id: "browser_get_images", name: "Read page images", group: "Browser", description: "Inspect images from the current browser page." },
  { id: "browser_vision", name: "See browser page", group: "Browser", description: "Analyze the rendered browser page visually." },
  { id: "browser_console", name: "Browser console", group: "Browser", description: "Inspect browser console output." },
  { id: "vision_analyze", name: "Analyze images", group: "Media", description: "Inspect supplied images." },
  { id: "image_generate", name: "Generate images", group: "Media", description: "Create images with the configured image provider." },
  { id: "text_to_speech", name: "Text to speech", group: "Media", description: "Generate spoken audio." },
  { id: "computer_use", name: "Computer control", group: "System", description: "Control the desktop through Hermes computer use. This is broad access." },
  { id: "todo_list", name: "Task list", group: "Organization", description: "Maintain an in-session task list." },
  { id: "memory", name: "Shared memory", group: "Organization", description: "Read and update the shared Hermes long-term memory." },
  { id: "session_search", name: "Conversation search", group: "Organization", description: "Search Hermes conversation history." },
  { id: "clarify", name: "Ask a question", group: "Organization", description: "Pause to request a concise answer from the user." },
  { id: "manage_connections", name: "Connections", group: "Services", description: "Inspect and authorize configured service connections." },
]);

const TOOL_IDS = new Set(AGENT_TOOL_CAPABILITIES.map(item => item.id));
const cleanLine = value => String(value || "").trim().replace(/^['"]|['"]$/g, "").slice(0, 600);

function skillMetadata(file, root) {
  try {
    if (fs.statSync(file).size > 256 * 1024) return null;
    const source = fs.readFileSync(file, "utf8");
    const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (source.startsWith("---") && !frontmatter) return null;
    const front = frontmatter?.[1] || "";
    const field = key => cleanLine(front.match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]);
    const relative = path.relative(root, path.dirname(file));
    const id = field("name") || path.basename(path.dirname(file));
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,199}$/.test(id)) return null;
    return { id, name: id, description: field("description") || "Installed Hermes skill.", group: relative.includes(path.sep) ? relative.split(path.sep)[0] : "General", path: relative };
  } catch { return null; }
}

export function listAgentSkills() {
  const root = path.join(process.env.HERMES_HOME || path.join(os.homedir(), ".hermes"), "skills");
  const found = [];
  function walk(directory, depth = 0) {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    const skill = entries.find(entry => entry.isFile() && entry.name === "SKILL.md");
    if (skill) {
      const metadata = skillMetadata(path.join(directory, skill.name), root);
      if (metadata) found.push(metadata);
      return;
    }
    for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith(".") && !["node_modules", "__pycache__"].includes(entry.name)) walk(path.join(directory, entry.name), depth + 1);
  }
  walk(root);
  const grouped = new Map();
  for (const skill of found) grouped.set(skill.id, [...(grouped.get(skill.id) || []), skill]);
  return [...grouped.values()].map(matches => matches.length === 1 ? { ...matches[0], available: true } : { ...matches[0], available: false, description: `Unavailable: ${matches.length} installed skills use this name. Rename one before assigning it.`, ambiguous: true }).sort((a, b) => a.name.localeCompare(b.name));
}

export function emptyAgentPolicy() {
  return { version: AGENT_POLICY_VERSION, tools: { mode: "allow", ids: [] }, skills: { mode: "allow", ids: [] } };
}

function scope(value, label, allowed, { validateAvailability = true } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.mode !== "allow" || !Array.isArray(value.ids)) throw inputError(`${label} access must be an explicit allowlist.`);
  const ids = [...new Set(value.ids)];
  if (ids.length > 500 || ids.some(id => typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9:_-]{0,199}$/.test(id))) throw inputError(`${label} access contains an invalid capability ID.`);
  if (validateAvailability && ids.some(id => !allowed.has(id))) throw inputError(`${label} access contains an unavailable capability. Refresh the list and choose again.`);
  return { mode: "allow", ids: ids.sort() };
}

export function sanitizeAgentPolicy(value, { allowLegacy = false, validateAvailability = true } = {}) {
  if (value === undefined || value === null) {
    if (allowLegacy) return null;
    return emptyAgentPolicy();
  }
  if (typeof value !== "object" || Array.isArray(value) || value.version !== AGENT_POLICY_VERSION || Object.keys(value).some(key => !["version", "tools", "skills"].includes(key))) throw inputError("Agent capability policy is invalid. Refresh the profile and try again.");
  const tools = validateAvailability ? new Set([...installedToolNames()].filter(id => TOOL_IDS.has(id))) : TOOL_IDS;
  const skills = new Set(listAgentSkills().filter(item => item.available).map(item => item.id));
  return { version: AGENT_POLICY_VERSION, tools: scope(value.tools, "Tool", tools, { validateAvailability }), skills: scope(value.skills, "Skill", skills, { validateAvailability }) };
}

export function readStoredAgentPolicy(value) {
  if (value === undefined || value === null) return { policy: null, error: null };
  try {
    const policy = sanitizeAgentPolicy(value, { allowLegacy: false, validateAvailability: false });
    const tools = installedToolNames();
    const skills = new Set(listAgentSkills().filter(item => item.available).map(item => item.id));
    const unavailable = [...policy.tools.ids.filter(id => !tools.has(id)), ...policy.skills.ids.filter(id => !skills.has(id))];
    return {
      policy,
      error: unavailable.length ? `This profile selects unavailable capabilities (${unavailable.join(", ")}). Edit its access before starting work.` : null,
    };
  }
  catch { return { policy: emptyAgentPolicy(), error: "This saved capability policy is invalid. No capabilities will be granted until you review and save it." }; }
}

function installedToolNames() {
  const repo = process.env.HERMES_REPO || path.join(process.env.HERMES_HOME || path.join(os.homedir(), ".hermes"), "hermes-agent");
  try {
    const source = fs.readFileSync(path.join(repo, "toolsets.py"), "utf8");
    return new Set([...source.matchAll(/["']([a-z][a-z0-9_]{1,100})["']/g)].map(match => match[1]));
  } catch { return new Set(); }
}

export function agentCapabilityCatalog() {
  const installed = installedToolNames();
  return {
    version: AGENT_POLICY_VERSION,
    tools: AGENT_TOOL_CAPABILITIES.map(item => ({ ...item, available: installed.has(item.id) })),
    skills: listAgentSkills(),
    notes: {
      inherited: "Older profiles without a saved policy keep the existing workspace tool and skill access until you edit them.",
      empty: "An empty selection means this teammate receives no tools or skills.",
      workingDirectory: "A working folder sets the starting location. It is not a filesystem sandbox.",
      skillBoundary: "Skill choices limit Hermes skill discovery and loading. A separately allowed file or terminal tool may still read the same files.",
      delegation: "Restricted teammates cannot delegate to other agents yet because child-policy inheritance is not available.",
      runtime: "Explicit allowlists use the persistent Hermes runtime. Legacy CLI and scheduled launches are blocked until those paths can carry the same policy.",
    },
  };
}
