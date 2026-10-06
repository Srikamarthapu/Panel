// Friendly, conversational labels for Hermes tool calls and tool results.
// Used by the voice "VOICE ACTIONS" panel so it can say what Hermes is
// actually doing right now (e.g. "Querying Notion") instead of UI chrome.

const MAX_SUMMARY = 180;
const MAX_QUOTE = 140;

/**
 * Best-effort JSON parse. Returns the raw value untouched on failure.
 * @param {unknown} value
 * @returns {any}
 */
function safeParse(value) {
  if (value == null) return {};
  if (typeof value === "object") return value;
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return {};
  if (trimmed[0] !== "{" && trimmed[0] !== "[") return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

/**
 * Strip control characters, collapse whitespace, cap length.
 * @param {unknown} value
 * @param {number} [max=MAX_SUMMARY]
 */
function sanitize(value, max = MAX_SUMMARY) {
  if (value == null) return "";
  const text = String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!max || text.length <= max) return text;
  return text.slice(0, Math.max(1, max - 1)).trimEnd() + "…";
}

/**
 * Truncate a quoted snippet for embedding in a sentence (~140 chars).
 * @param {unknown} value
 */
function truncateQuote(value) {
  return sanitize(value, MAX_QUOTE);
}

/**
 * Pretty-print a small args object as either `key=value` pairs or fall
 * back to compact JSON. Capped to 140 chars.
 * @param {unknown} args
 */
function compactArgs(args) {
  const parsed = safeParse(args);
  if (parsed == null) return "";
  if (typeof parsed === "string") return sanitize(parsed, MAX_QUOTE);
  if (typeof parsed !== "object") return sanitize(String(parsed), MAX_QUOTE);

  if (Array.isArray(parsed)) {
    try {
      return sanitize(JSON.stringify(parsed), MAX_QUOTE);
    } catch {
      return "";
    }
  }

  const preferred = ["path", "file", "url", "query", "command", "text", "name", "action"];
  const seen = new Set();
  const parts = [];
  for (const key of preferred) {
    if (parsed[key] != null && parsed[key] !== "") {
      parts.push(`${key}=${formatScalar(parsed[key])}`);
      seen.add(key);
    }
  }
  for (const [k, v] of Object.entries(parsed)) {
    if (seen.has(k)) continue;
    if (v == null || v === "") continue;
    parts.push(`${k}=${formatScalar(v)}`);
    if (parts.join(" ").length > MAX_QUOTE) break;
  }
  if (parts.length === 0) {
    try {
      return sanitize(JSON.stringify(parsed), MAX_QUOTE);
    } catch {
      return "";
    }
  }
  return sanitize(parts.join(" "), MAX_QUOTE);
}

function formatScalar(value) {
  if (value == null) return "";
  if (typeof value === "string") {
    return value.length > 60 ? value.slice(0, 59) + "…" : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    const json = JSON.stringify(value);
    return json.length > 60 ? json.slice(0, 59) + "…" : json;
  } catch {
    return "";
  }
}

function firstLine(text) {
  if (!text) return "";
  const idx = String(text).indexOf("\n");
  return idx >= 0 ? String(text).slice(0, idx) : String(text);
}

function hostFromUrl(url) {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
}

// ---------------------------------------------------------------------------
// Per-tool label builders. Each receives a parsed args object and returns
// `{ title, summary, target? }`. Keep prose plain, no emojis, no markdown.
// ---------------------------------------------------------------------------

function labelSkillView(args) {
  const name = args?.name || args?.skill || "skill";
  const file = args?.file_path;
  if (file) {
    return {
      title: "Loading skill",
      summary: `Reading ${sanitize(file, MAX_QUOTE)} from the ${sanitize(name, 60)} playbook.`,
      target: String(name),
    };
  }
  return {
    title: "Loading skill",
    summary: `Reading the ${sanitize(name, 60)} playbook.`,
    target: String(name),
  };
}

function labelSkillManage(args) {
  const name = args?.name || "skill";
  const action = args?.action || "edit";
  return {
    title: "Updating skill",
    summary: `Editing the ${sanitize(name, 60)} playbook (${sanitize(action, 40)}).`,
    target: String(name),
  };
}

function labelComputerUse(args) {
  const action = args?.action || args?.type || "";
  switch (action) {
    case "capture": {
      const focus = args?.app || args?.application || args?.window || "the desktop";
      return {
        title: "Looking at the screen",
        summary: `Capturing a screenshot of ${sanitize(focus, 80)}.`,
        target: String(focus),
      };
    }
    case "click": {
      const element = args?.element || args?.label || args?.target;
      if (element) {
        return {
          title: "Clicking the Mac",
          summary: `Tapping element ${sanitize(element, 80)} in the active window.`,
          target: String(element),
        };
      }
      const x = args?.x ?? args?.coordinates?.x;
      const y = args?.y ?? args?.coordinates?.y;
      if (x != null && y != null) {
        return {
          title: "Clicking the Mac",
          summary: `Tapping at ${x}, ${y} in the active window.`,
        };
      }
      return { title: "Clicking the Mac", summary: "Tapping in the active window." };
    }
    case "type": {
      const text = args?.text || args?.value || "";
      return {
        title: "Typing on the Mac",
        summary: `Entering "${truncateQuote(text)}".`,
      };
    }
    case "key":
    case "keys":
    case "hotkey": {
      const keys = Array.isArray(args?.keys) ? args.keys.join("+") : args?.keys || args?.key || "";
      return {
        title: "Pressing keys",
        summary: `Sending the ${sanitize(keys, 60) || "keyboard"} shortcut.`,
        target: String(keys || ""),
      };
    }
    case "scroll": {
      const direction = args?.direction || "down";
      return {
        title: "Scrolling",
        summary: `Scrolling ${sanitize(direction, 30)} in the active window.`,
      };
    }
    case "focus_app":
    case "focus": {
      const app = args?.app || args?.application || args?.name || "an app";
      return {
        title: "Switching apps",
        summary: `Focusing ${sanitize(app, 80)}.`,
        target: String(app),
      };
    }
    case "get_window_state":
    case "window_state": {
      return {
        title: "Reading window state",
        summary: "Inspecting the active app's accessibility tree.",
      };
    }
    default: {
      const label = action ? sanitize(action, 60) : "the Mac";
      return {
        title: "Using the Mac",
        summary: `Running computer_use ${label}.`,
      };
    }
  }
}

function labelTerminal(args) {
  const command = args?.command || args?.cmd || "";
  const head = sanitize(firstLine(command), MAX_QUOTE) || "(empty command)";
  const summary = args?.workdir
    ? `${head} (in ${sanitize(args.workdir, 60)})`
    : head;
  return {
    title: "Running terminal command",
    summary: sanitize(summary, MAX_SUMMARY),
    target: head,
  };
}

function labelWebSearch(args) {
  const query = args?.query || args?.q || "";
  return {
    title: "Searching the web",
    summary: `Looking up "${truncateQuote(query)}".`,
    target: String(query || ""),
  };
}

function labelWebExtract(args) {
  const urls = Array.isArray(args?.urls) ? args.urls : args?.url ? [args.url] : [];
  const first = urls[0] || "";
  const more = urls.length > 1 ? ` (+${urls.length - 1} more)` : "";
  return {
    title: "Reading a webpage",
    summary: `${hostFromUrl(first) || "a page"}${more}.`,
    target: String(first),
  };
}

function labelBrowserNavigate(args) {
  const url = args?.url || "";
  return {
    title: "Opening a webpage",
    summary: `${sanitize(url, MAX_QUOTE) || "a new page"}.`,
    target: String(url),
  };
}

function labelBrowserClick(args) {
  const ref = args?.ref || args?.element || "an element";
  return {
    title: "Clicking in the browser",
    summary: `Tapping ${sanitize(ref, 60)}.`,
    target: String(ref),
  };
}

function labelBrowserType(args) {
  const ref = args?.ref || "a field";
  return {
    title: "Typing in the browser",
    summary: `Entering text into ${sanitize(ref, 60)}.`,
    target: String(ref),
  };
}

function labelBrowserSnapshot(args) {
  return {
    title: "Reading the page",
    summary: args?.full
      ? "Taking a full snapshot of the current page."
      : "Taking a compact snapshot of the current page.",
  };
}

function labelBrowserConsole(args) {
  if (args?.expression) {
    return {
      title: "Running browser JS",
      summary: `Evaluating ${sanitize(args.expression, MAX_QUOTE)}.`,
    };
  }
  return { title: "Reading the browser console", summary: "Pulling recent console output." };
}

function labelBrowserPress(args) {
  const key = args?.key || "a key";
  return {
    title: "Pressing keys in the browser",
    summary: `Sending ${sanitize(key, 40)}.`,
    target: String(key),
  };
}

function labelBrowserScroll(args) {
  return {
    title: "Scrolling the browser",
    summary: `Scrolling ${sanitize(args?.direction || "down", 30)} on the page.`,
  };
}

function labelBrowserGetImages() {
  return {
    title: "Listing page images",
    summary: "Collecting images visible on the current page.",
  };
}

function labelBrowserVision(args) {
  const question = args?.question || "the page";
  return {
    title: "Looking at the browser",
    summary: `Asking vision about "${truncateQuote(question)}".`,
  };
}

function labelBrowserBack() {
  return { title: "Going back in the browser", summary: "Navigating to the previous page." };
}

function labelNotion(args) {
  const action = args?.action || args?.endpoint || "";
  switch (action) {
    case "data_source_query":
    case "database_query":
    case "query": {
      const db = args?.database_name || args?.data_source_name || args?.title || "a database";
      return {
        title: "Querying Notion",
        summary: `Looking up entries in ${sanitize(db, 80)}.`,
        target: String(db),
      };
    }
    case "page_update":
    case "update_page": {
      const id = args?.page_id || args?.title || "a page";
      return {
        title: "Updating Notion",
        summary: `Saving changes to ${sanitize(id, 80)}.`,
        target: String(id),
      };
    }
    case "page_create":
    case "create_page": {
      const title = args?.title || args?.parent || "a new page";
      return {
        title: "Creating Notion page",
        summary: `Adding ${sanitize(title, 80)}.`,
        target: String(title),
      };
    }
    case "search":
      return {
        title: "Searching Notion",
        summary: `Looking up "${truncateQuote(args?.query || "")}".`,
      };
    case "block_append":
      return { title: "Updating Notion", summary: "Appending blocks to a page." };
    case "page_retrieve":
    case "retrieve_page":
      return { title: "Reading Notion", summary: "Fetching page details." };
    default:
      return {
        title: "Working in Notion",
        summary: action
          ? `Running ${sanitize(action, 60)}.`
          : compactArgs(args) || "Talking to Notion.",
      };
  }
}

function labelAppleNotes(args) {
  const action = args?.action || "";
  if (action === "create" || action === "create_note") {
    return {
      title: "Saving an Apple Note",
      summary: `Creating ${sanitize(args?.title || "a note", 80)}.`,
    };
  }
  if (action === "search") {
    return {
      title: "Searching Apple Notes",
      summary: `Looking for "${truncateQuote(args?.query || "")}".`,
    };
  }
  if (action === "update" || action === "edit") {
    return { title: "Updating an Apple Note", summary: "Editing an existing note." };
  }
  return { title: "Using Apple Notes", summary: compactArgs(args) || "Working with your notes." };
}

function labelAppleReminders(args) {
  const action = args?.action || "";
  if (action === "create" || action === "add") {
    return {
      title: "Adding a reminder",
      summary: `Setting up ${sanitize(args?.title || "a reminder", 80)}.`,
    };
  }
  if (action === "list") {
    return { title: "Reading reminders", summary: "Pulling your reminder list." };
  }
  if (action === "complete") {
    return { title: "Updating reminders", summary: "Marking a reminder complete." };
  }
  return {
    title: "Using Apple Reminders",
    summary: compactArgs(args) || "Working with your reminders.",
  };
}

function labelIMessage(args) {
  const action = args?.action || "";
  if (action === "send") {
    const to = args?.to || args?.recipient || "someone";
    return {
      title: "Sending an iMessage",
      summary: `Texting ${sanitize(to, 60)}.`,
      target: String(to),
    };
  }
  if (action === "search") {
    return {
      title: "Searching iMessage",
      summary: `Looking for "${truncateQuote(args?.query || "")}".`,
    };
  }
  return { title: "Using iMessage", summary: compactArgs(args) || "Working with your messages." };
}

function labelFindMy(args) {
  const action = args?.action || "";
  if (action === "locate" || action === "find") {
    const target = args?.name || args?.device || "someone";
    return {
      title: "Checking Find My",
      summary: `Locating ${sanitize(target, 60)}.`,
      target: String(target),
    };
  }
  return { title: "Using Find My", summary: compactArgs(args) || "Looking up locations." };
}

function labelFileRead(args) {
  const path = args?.path || args?.file || args?.target_file || "";
  return {
    title: "Reading a file",
    summary: `${sanitize(path, MAX_QUOTE) || "(no path)"}.`,
    target: String(path),
  };
}

function labelFileWrite(args) {
  const path = args?.path || args?.file || args?.target_file || "";
  return {
    title: "Writing a file",
    summary: `${sanitize(path, MAX_QUOTE) || "(no path)"}.`,
    target: String(path),
  };
}

function labelFileEdit(args) {
  const path = args?.path || args?.file || args?.target_file || "";
  return {
    title: "Editing a file",
    summary: `${sanitize(path, MAX_QUOTE) || "(no path)"}.`,
    target: String(path),
  };
}

function labelGithub(toolName, args) {
  const action = toolName.replace(/^github[_-]/i, "").replace(/_/g, " ").trim();
  const repo = args?.repo || args?.repository || args?.owner;
  return {
    title: "Using GitHub",
    summary: action
      ? `${action[0].toUpperCase()}${action.slice(1)}${repo ? ` in ${sanitize(repo, 60)}` : ""}.`
      : compactArgs(args) || "Talking to GitHub.",
    target: repo ? String(repo) : undefined,
  };
}

function labelMemory(toolName, args) {
  if (/search/i.test(toolName)) {
    return {
      title: "Searching memory",
      summary: `Looking for "${truncateQuote(args?.query || args?.q || "")}".`,
    };
  }
  if (/save|add|write|update|replace|remove/i.test(toolName) || args?.action) {
    const action = args?.action || "save";
    return {
      title: "Updating memory",
      summary: `Running ${sanitize(action, 40)}${args?.target ? ` on ${sanitize(args.target, 40)}` : ""}.`,
    };
  }
  return { title: "Using memory", summary: compactArgs(args) || "Working with stored notes." };
}

function labelSessionSearch(args) {
  return {
    title: "Searching past sessions",
    summary: `Looking for "${truncateQuote(args?.query || "")}".`,
  };
}

function labelTodo(args) {
  if (Array.isArray(args?.todos) && args.todos.length) {
    return {
      title: "Updating the todo list",
      summary: `Writing ${args.todos.length} task${args.todos.length === 1 ? "" : "s"}.`,
    };
  }
  return { title: "Reading the todo list", summary: "Checking current tasks." };
}

function labelDelegate(args) {
  if (Array.isArray(args?.tasks) && args.tasks.length) {
    return {
      title: "Delegating tasks",
      summary: `Spawning ${args.tasks.length} subagent${args.tasks.length === 1 ? "" : "s"}.`,
    };
  }
  const goal = args?.goal || "a task";
  return { title: "Delegating a task", summary: `Goal: ${truncateQuote(goal)}.` };
}

function labelClarify(args) {
  return {
    title: "Asking a question",
    summary: `Question: ${truncateQuote(args?.question || "")}.`,
  };
}

function labelTextToSpeech(args) {
  return {
    title: "Speaking",
    summary: `Saying "${truncateQuote(args?.text || "")}".`,
  };
}

function labelVisionAnalyze(args) {
  const url = args?.image_url || "";
  return {
    title: "Analyzing an image",
    summary: `Looking at ${hostFromUrl(url) || sanitize(url, 80) || "an image"}.`,
    target: String(url),
  };
}

function labelSendMessage(args) {
  if (args?.action === "list") {
    return { title: "Listing message targets", summary: "Reading available channels." };
  }
  return {
    title: "Sending a message",
    summary: `To ${sanitize(args?.target || "the home channel", 60)}.`,
    target: String(args?.target || ""),
  };
}

function labelCronJob(args) {
  const action = args?.action || "list";
  switch (action) {
    case "create":
      return {
        title: "Scheduling a cron job",
        summary: `Creating ${sanitize(args?.name || "a job", 60)}.`,
      };
    case "list":
      return { title: "Listing cron jobs", summary: "Pulling scheduled jobs." };
    case "remove":
      return { title: "Removing a cron job", summary: `Deleting ${sanitize(args?.job_id || "a job", 60)}.` };
    case "run":
      return { title: "Running a cron job", summary: `Triggering ${sanitize(args?.job_id || "a job", 60)} now.` };
    case "update":
      return { title: "Updating a cron job", summary: `Editing ${sanitize(args?.job_id || "a job", 60)}.` };
    case "pause":
      return { title: "Pausing a cron job", summary: `Pausing ${sanitize(args?.job_id || "a job", 60)}.` };
    case "resume":
      return { title: "Resuming a cron job", summary: `Resuming ${sanitize(args?.job_id || "a job", 60)}.` };
    default:
      return { title: "Managing cron jobs", summary: `Action ${sanitize(action, 40)}.` };
  }
}

function labelProcess(args) {
  const action = args?.action || "list";
  return {
    title: "Managing background processes",
    summary: `Action ${sanitize(action, 40)}${args?.session_id ? ` on ${sanitize(args.session_id, 40)}` : ""}.`,
  };
}

function labelSearchFiles(args) {
  const target = args?.target === "files" ? "filenames" : "file contents";
  return {
    title: "Searching the workspace",
    summary: `Looking through ${target} for "${truncateQuote(args?.pattern || "")}".`,
  };
}

function labelExecuteCode(args) {
  const head = sanitize(firstLine(args?.code || ""), MAX_QUOTE) || "(empty script)";
  return {
    title: "Running a script",
    summary: head,
  };
}

function labelPatch(args) {
  if (args?.mode === "patch" || args?.patch) {
    return { title: "Applying a patch", summary: "Running a multi-file patch." };
  }
  const path = args?.path || "";
  return {
    title: "Editing a file",
    summary: `${sanitize(path, MAX_QUOTE) || "(no path)"}.`,
    target: String(path),
  };
}

// ---------------------------------------------------------------------------
// Dispatch table
// ---------------------------------------------------------------------------

const TOOL_LABELERS = {
  skill_view: labelSkillView,
  skill_manage: labelSkillManage,
  skills_list: () => ({ title: "Listing skills", summary: "Loading available skills." }),

  computer_use: labelComputerUse,

  terminal: labelTerminal,
  process: labelProcess,
  execute_code: labelExecuteCode,

  web_search: labelWebSearch,
  web_extract: labelWebExtract,

  browser_navigate: labelBrowserNavigate,
  browser_click: labelBrowserClick,
  browser_type: labelBrowserType,
  browser_snapshot: labelBrowserSnapshot,
  browser_console: labelBrowserConsole,
  browser_press: labelBrowserPress,
  browser_scroll: labelBrowserScroll,
  browser_get_images: labelBrowserGetImages,
  browser_vision: labelBrowserVision,
  browser_back: labelBrowserBack,

  notion: labelNotion,
  "apple-notes": labelAppleNotes,
  apple_notes: labelAppleNotes,
  "apple-reminders": labelAppleReminders,
  apple_reminders: labelAppleReminders,
  imessage: labelIMessage,
  findmy: labelFindMy,

  file_read: labelFileRead,
  read: labelFileRead,
  read_file: labelFileRead,

  file_write: labelFileWrite,
  write: labelFileWrite,
  write_file: labelFileWrite,
  fs_write: labelFileWrite,

  file_edit: labelFileEdit,
  edit: labelFileEdit,
  str_replace: labelFileEdit,
  patch: labelPatch,

  search_files: labelSearchFiles,
  session_search: labelSessionSearch,

  memory: (args) => labelMemory("memory", args),
  memory_save: (args) => labelMemory("memory_save", args),
  memory_search: (args) => labelMemory("memory_search", args),
  memory_remove: (args) => labelMemory("memory_remove", args),

  todo: labelTodo,
  delegate_task: labelDelegate,
  clarify: labelClarify,
  text_to_speech: labelTextToSpeech,
  vision_analyze: labelVisionAnalyze,
  send_message: labelSendMessage,
  cronjob: labelCronJob,
};

export const KNOWN_TOOL_NAMES = Object.keys(TOOL_LABELERS);

/**
 * Build a friendly label for an assistant tool call.
 * @param {string} toolName
 * @param {object|string} args
 * @returns {{ title: string, summary: string, target?: string }}
 */
export function labelForToolCall(toolName, args) {
  const name = String(toolName || "").trim();
  const parsed = safeParse(args);

  // Direct hit.
  const direct = TOOL_LABELERS[name];
  if (direct) {
    const out = direct(parsed) || {};
    return cleanLabel(out, name, parsed);
  }

  // Prefix-based fallbacks for related tools.
  if (/^github[_-]/i.test(name)) return cleanLabel(labelGithub(name, parsed), name, parsed);
  if (/^memory/i.test(name)) return cleanLabel(labelMemory(name, parsed), name, parsed);
  if (/^browser_/i.test(name)) {
    return cleanLabel(
      { title: "Using the browser", summary: compactArgs(parsed) || `Running ${name}.` },
      name,
      parsed,
    );
  }
  if (/^notion/i.test(name)) return cleanLabel(labelNotion(parsed), name, parsed);
  if (/^apple[-_]notes/i.test(name)) return cleanLabel(labelAppleNotes(parsed), name, parsed);
  if (/^apple[-_]reminders/i.test(name)) return cleanLabel(labelAppleReminders(parsed), name, parsed);

  // Unknown.
  return cleanLabel(
    {
      title: `Calling ${name || "tool"}`,
      summary: compactArgs(parsed) || "(no arguments)",
    },
    name,
    parsed,
  );
}

function cleanLabel(out, name, parsed) {
  return {
    title: sanitize(out.title || `Calling ${name || "tool"}`, 80),
    summary: sanitize(out.summary || compactArgs(parsed) || "", MAX_SUMMARY),
    ...(out.target ? { target: sanitize(out.target, 120) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Tool result labels
// ---------------------------------------------------------------------------

/**
 * Detect noisy tool outputs (browser snapshots, screen-of-Mind blobs) and
 * collapse them to a short summary like "12 elements detected".
 */
function summarizeNoisyResult(toolName, parsed, raw) {
  if (!parsed || typeof parsed !== "object") return null;

  if (toolName === "computer_use") {
    if (Array.isArray(parsed.elements)) {
      return `${parsed.elements.length} on-screen elements detected.`;
    }
    if (parsed.som || parsed.screen || parsed.image_path) {
      return "Screen captured.";
    }
  }

  if (toolName === "browser_snapshot" || toolName === "browser_navigate") {
    if (typeof parsed.snapshot === "string") {
      return `Snapshot ready (${parsed.snapshot.length} chars).`;
    }
    if (Array.isArray(parsed.elements)) {
      return `${parsed.elements.length} interactive elements detected.`;
    }
  }

  if (toolName === "web_search" && Array.isArray(parsed?.data?.web)) {
    return `${parsed.data.web.length} web result${parsed.data.web.length === 1 ? "" : "s"} returned.`;
  }

  if (toolName === "web_extract" && Array.isArray(parsed?.results)) {
    return `${parsed.results.length} page${parsed.results.length === 1 ? "" : "s"} extracted.`;
  }

  if (toolName === "search_files" && Array.isArray(parsed?.matches)) {
    return `${parsed.matches.length} match${parsed.matches.length === 1 ? "" : "es"} found.`;
  }

  if (parsed.success === true && parsed.message) {
    return sanitize(String(parsed.message), MAX_QUOTE);
  }
  if (parsed.success === false && parsed.error) {
    return `Error: ${sanitize(String(parsed.error), MAX_QUOTE)}`;
  }

  void raw;
  return null;
}

/**
 * Build a "Done" entry for a tool result.
 * @param {string} toolName
 * @param {string} content
 * @returns {{ title: string, summary: string }}
 */
export function labelForToolResult(toolName, content) {
  const name = String(toolName || "").trim();
  const raw = content == null ? "" : String(content);
  const parsed = safeParse(raw);

  let summary = "";
  const noisy = summarizeNoisyResult(name, typeof parsed === "object" ? parsed : null, raw);
  if (noisy) {
    summary = noisy;
  } else if (raw.trim() === "") {
    summary = "(no output)";
  } else if (typeof parsed === "object" && parsed && parsed !== raw) {
    summary = compactArgs(parsed) || sanitize(raw, MAX_QUOTE);
  } else {
    summary = sanitize(raw, MAX_QUOTE);
  }

  return {
    title: sanitize(`Got result from ${name || "tool"}`, 80),
    summary: sanitize(summary, MAX_SUMMARY),
  };
}

// Internal helpers exported for tests / debugging.
export const __internal = {
  safeParse,
  sanitize,
  truncateQuote,
  compactArgs,
  firstLine,
  hostFromUrl,
};
