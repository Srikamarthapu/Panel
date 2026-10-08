const text = (value, max = 20000) => typeof value === "string" ? value.slice(0, max) : "";

export function emptyWorkspaceTabState() {
  return { fields: {}, notes: {}, checklists: {}, tables: {} };
}

export function normalizeWorkspaceTabState(spec, value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const next = emptyWorkspaceTabState();
  for (const block of spec?.blocks || []) {
    if (block.type === "field") {
      const current = text(source.fields?.[block.id], block.kind === "textarea" ? 20000 : 4000);
      next.fields[block.id] = block.kind === "select" && !block.options?.includes(current) ? "" : current;
    } else if (block.type === "notes") next.notes[block.id] = text(source.notes?.[block.id]);
    else if (block.type === "checklist") next.checklists[block.id] = block.items.map((_, index) => Boolean(source.checklists?.[block.id]?.[index]));
    else if (block.type === "table") {
      const rows = Array.isArray(source.tables?.[block.id]) ? source.tables[block.id].slice(0, 100) : [];
      next.tables[block.id] = rows.map(row => Object.fromEntries(block.columns.map(column => [column, text(row?.[column], 4000)])));
    }
  }
  return next;
}

export function workspaceActionPrompt(spec, state, template) {
  const blocks = new Map((spec?.blocks || []).map(block => [block.id, block]));
  return String(template || "").replace(/{{([a-zA-Z0-9_-]{1,40})}}/g, (_, id) => {
    const block = blocks.get(id);
    if (!block) return "";
    if (block.type === "field") return state.fields?.[id] || "";
    if (block.type === "notes") return state.notes?.[id] || "";
    if (block.type === "checklist") return block.items.filter((__, index) => state.checklists?.[id]?.[index]).join(", ");
    if (block.type === "table") return JSON.stringify(state.tables?.[id] || []);
    return "";
  }).trim();
}
