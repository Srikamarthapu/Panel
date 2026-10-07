// Public API fixtures: histories live here, outside the page, so a reload must
// hydrate the server response instead of succeeding through legacy storage.
export async function mockWorkspace(page, { sessions = [{ id: "qa-main", name: "QA session" }], tasks = [], agents = [], delegations = [] } = {}) {
  const timestamp = new Date().toISOString();
  const records = new Map(sessions.map(item => [item.id, {
    session: { workingDirectory: null, pinned: false, archivedAt: null, createdAt: timestamp, updatedAt: timestamp, ...item, messages: undefined, activeRun: undefined, lastRun: undefined },
    messages: [...(item.messages || [])], activeRun: item.activeRun || null,
    lastRun: item.lastRun || item.activeRun || null,
  }]));
  const queue = tasks.map(task => ({ createdAt: timestamp, runAt: timestamp, ...task }));
  const agentProfiles = new Map(agents.map(agent => [agent.id, {
    provider: "", model: "", soul: "", archivedAt: null, createdAt: timestamp, updatedAt: timestamp, sessionId: `qa-agent-session-${agent.id}`,
    workingDirectory: `/QA/agents/${agent.id}/workspace`, ...agent,
  }]));
  const delegated = delegations.map(agent => ({ ...agent }));
  const requests = { createdSessions: [], sessionPatches: [], queuedTasks: [], cancellations: [], adoptedSessions: [], stoppedRuns: [], createdAgents: [], updatedAgents: [], agentRuns: [], stoppedDelegations: [] };
  let nextId = 0;
  for (const agent of agentProfiles.values()) if (!records.has(agent.sessionId)) {
    const session = { id: agent.sessionId, name: agent.name, workingDirectory: agent.workingDirectory, agentId: agent.id, pinned: false, archivedAt: agent.archivedAt || null, createdAt: agent.createdAt, updatedAt: agent.updatedAt };
    records.set(agent.sessionId, { session, messages: [...(agent.messages || [])], activeRun: agent.activeRun || null, lastRun: agent.lastRun || agent.activeRun || null });
  }
  const sessionSummary = record => ({ ...record.session, activeRun: record.activeRun, lastRun: record.lastRun });
  await page.route("**/api/sessions**", async route => {
    const request = route.request(), url = new URL(request.url());
    const id = decodeURIComponent(url.pathname.split("/")[3] || "");
    const method = request.method();
    if (id === "adopt" && method === "POST") {
      const body = request.postDataJSON(); requests.adoptedSessions.push(body);
      if (!records.has(body.sessionId)) {
        records.set(body.sessionId, { session: { id: body.sessionId, name: "Previous conversation", workingDirectory: null, pinned: false, archivedAt: null, createdAt: timestamp, updatedAt: timestamp }, messages: body.messages, activeRun: null, lastRun: null });
      }
      return route.fulfill({ json: { session: sessionSummary(records.get(body.sessionId)) } });
    }
    if (!id && method === "GET") return route.fulfill({ json: { sessions: [...records.values()].map(sessionSummary) } });
    if (!id && method === "POST") {
      const body = request.postDataJSON(); requests.createdSessions.push(body);
      const session = { id: `qa-new-${++nextId}`, name: body.name, workingDirectory: body.workingDirectory || null, pinned: false, archivedAt: null, createdAt: timestamp, updatedAt: timestamp };
      records.set(session.id, { session, messages: [], activeRun: null, lastRun: null });
      return route.fulfill({ json: { session } });
    }
    const record = records.get(id);
    if (!record) return route.fulfill({ status: 404, json: { error: "Session not found" } });
    if (method === "PATCH") {
      const patch = request.postDataJSON();
      requests.sessionPatches.push({ id, patch });
      if (Object.hasOwn(patch, "name")) record.session.name = patch.name;
      if (Object.hasOwn(patch, "workingDirectory")) record.session.workingDirectory = patch.workingDirectory || null;
      if (Object.hasOwn(patch, "pinned")) record.session.pinned = patch.pinned;
      if (Object.hasOwn(patch, "archived")) record.session.archivedAt = patch.archived ? timestamp : null;
      record.session.updatedAt = new Date().toISOString();
      return route.fulfill({ json: { session: sessionSummary(record) } });
    }
    return route.fulfill({ json: { session: sessionSummary(record), messages: record.messages, activeRun: record.activeRun } });
  });
  await page.route("**/api/tasks**", route => {
    const method = route.request().method();
    if (method === "GET") return route.fulfill({ json: { tasks: queue, worker: { running: true } } });
    const body = route.request().postDataJSON();
    if (method === "POST") {
      requests.queuedTasks.push(body);
      const task = { id: `qa-task-${++nextId}`, state: "queued", runAt: timestamp, createdAt: timestamp, ...body };
      queue.push(task); return route.fulfill({ json: { task } });
    }
    if (method === "PATCH") {
      requests.cancellations.push(body);
      const task = queue.find(item => item.id === body.id); task.state = "cancelled";
      return route.fulfill({ json: { task } });
    }
    return route.fulfill({ status: 405 });
  });
  const publicAgent = agent => {
    const session = records.get(agent.sessionId);
    const run = session?.activeRun || session?.lastRun || null;
    const { soul = "", ...profile } = agent;
    return { ...profile,
      description: soul.split("\n").find(line => line.trim() && !line.startsWith("#"))?.slice(0, 240) || "Give this agent a role in SOUL.md.",
      activeRun: run && ["queued", "active"].includes(run.state) ? run : null,
      lastRun: run,
      lastResult: run?.response || "",
    };
  };
  await page.route("**/api/agents**", async route => {
    const request = route.request(), url = new URL(request.url()), parts = url.pathname.split("/").filter(Boolean);
    const method = request.method();
    if (parts.length === 2 && method === "GET") {
      const includeArchived = url.searchParams.get("archived") === "true";
      const listed = [...agentProfiles.values()].filter(agent => includeArchived || !agent.archivedAt).map(publicAgent);
      return route.fulfill({ json: { agents: listed, delegations: delegated } });
    }
    if (parts.length === 2 && method === "POST") {
      const body = request.postDataJSON(); requests.createdAgents.push(body);
      const id = body.id || `qa-agent-${++nextId}`;
      const previous = agentProfiles.get(id);
      if (previous) return route.fulfill({ status: 201, json: { agent: { ...previous, soul: previous.soul } } });
      const sessionId = `qa-agent-session-${++nextId}`;
      const workingDirectory = body.workingDirectory || `/QA/agents/${id}/workspace`;
      const profile = { id, name: body.name, soul: body.soul || `# ${body.name}\n\nYou are ${body.name}.`, provider: body.provider || "", model: body.model || "", workingDirectory, sessionId, createdAt: timestamp, updatedAt: timestamp, archivedAt: null };
      agentProfiles.set(id, profile);
      const session = { id: sessionId, name: body.name, workingDirectory, agentId: id, pinned: false, archivedAt: null, createdAt: timestamp, updatedAt: timestamp };
      records.set(sessionId, { session, messages: [], activeRun: null, lastRun: null });
      return route.fulfill({ status: 201, json: { agent: { ...profile } } });
    }
    if (parts[2] === "delegations" && method === "DELETE") {
      const body = request.postDataJSON(); requests.stoppedDelegations.push(body);
      const index = delegated.findIndex(agent => agent.sessionId === body.sessionId && agent.runId === body.runId && agent.id === body.agentId && agent.canStop);
      if (index < 0) return route.fulfill({ status: 404, json: { error: "This delegated agent is no longer available to stop." } });
      delegated[index] = { ...delegated[index], status: "cancelled", statusLabel: "Stopped", canStop: false };
      return route.fulfill({ json: { ok: true } });
    }
    if (parts[2] === "delegations" && method === "GET") return route.fulfill({ json: { delegations: delegated } });
    const agent = agentProfiles.get(parts[2]);
    if (!agent) return route.fulfill({ status: 404, json: { error: "Agent not found." } });
    if (parts.length === 3 && method === "GET") return route.fulfill({ json: { agent: { ...agent } } });
    if (parts.length === 3 && method === "PATCH") {
      const patch = request.postDataJSON(); requests.updatedAgents.push({ id: agent.id, patch });
      Object.assign(agent, patch, { updatedAt: new Date().toISOString() });
      if (Object.hasOwn(patch, "workingDirectory")) agent.workingDirectory ||= `/QA/agents/${agent.id}/workspace`;
      const record = records.get(agent.sessionId);
      if (record) {
        if (Object.hasOwn(patch, "name")) record.session.name = patch.name;
        if (Object.hasOwn(patch, "workingDirectory")) record.session.workingDirectory = patch.workingDirectory || `/QA/agents/${agent.id}/workspace`;
        if (Object.hasOwn(patch, "archived")) record.session.archivedAt = patch.archived ? agent.updatedAt : null;
      }
      if (Object.hasOwn(patch, "archived")) agent.archivedAt = patch.archived ? agent.updatedAt : null;
      return route.fulfill({ json: { agent: { ...agent } } });
    }
    if (parts[3] === "runs" && method === "POST") {
      const body = request.postDataJSON(); requests.agentRuns.push({ id: agent.id, sessionId: agent.sessionId, text: body.text, actionId: body.actionId });
      const record = records.get(agent.sessionId);
      const run = { id: body.actionId || `qa-agent-run-${++nextId}`, sessionId: agent.sessionId, state: "active", statusLabel: "Working", textOnly: true, prompt: body.text, createdAt: timestamp };
      if (record) { record.activeRun = run; record.lastRun = run; }
      return route.fulfill({ status: 202, json: { agentId: agent.id, sessionId: agent.sessionId, run } });
    }
    if (parts[3] === "runs" && method === "DELETE") {
      const body = request.postDataJSON();
      const record = records.get(agent.sessionId);
      if (!record?.activeRun || record.activeRun.id !== body.runId) return route.fulfill({ status: 404, json: { error: "Request not found." } });
      record.lastRun = { ...record.activeRun, state: "cancelled", statusLabel: "Stopped" };
      record.activeRun = null;
      return route.fulfill({ json: { agentId: agent.id, sessionId: agent.sessionId, run: record.lastRun } });
    }
    return route.fulfill({ status: 405, json: { error: "Unsupported agent request." } });
  });
  await page.route("**/api/capabilities", route => route.fulfill({ json: {
    skills: [{ id: "qa-research", name: "Research notebook", description: "Check primary sources and preserve evidence.", source: "user", category: "research" }, { id: "qa-review", name: "Patch review", description: "Review changes before release.", source: "repository", category: "engineering" }],
    plugins: [{ id: "qa-search", name: "Search connector", description: "Search workspace documents.", source: "user", version: "2.4.0", status: "enabled" }],
    runtime: { configurationFound: true, environmentFound: true, home: "/QA/hermes-home", repository: "/QA/Hermes-runtime" },
    warnings: [], scope: "Read from installed Hermes manifests.",
  } }));
  await page.route("**/api/models/catalog**", route => route.fulfill({ json: { ok: true, providers: [
    { id: "provider-a", label: "Provider A", configured: true, models: ["model-a", "model-a-2"] },
    { id: "provider-b", label: "Provider B", configured: true, models: ["model-b"] },
  ] } }));
  await page.route("**/api/control-center", route => route.fulfill({ json: { model: { provider: "test", model: "test-model" }, gateway: { online: true, running: true, state: "running", platforms: {} }, activity: [], tasks: {} } }));
  await page.route("**/api/voice/status**", route => route.fulfill({ json: { status: "running", config: { autoSpeak: false, enabled: true } } }));
  await page.route("**/api/voice/runtime", route => route.fulfill({ json: { ok: true, ready: true, status: "ready" } }));
  await page.route("**/api/voice/activity**", route => route.fulfill({ json: { events: [] } }));
  await page.route("**/api/voice/runs**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === "DELETE") {
      const body = request.postDataJSON(); requests.stoppedRuns.push(body);
      const record = records.get(body.sessionId);
      const run = record?.activeRun;
      if (record && run?.id === body.actionId) {
        record.activeRun = null;
        record.lastRun = { ...run, state: "cancelled", statusLabel: "Stopped", executionCancelRequestedAt: timestamp };
      }
      return route.fulfill({ json: { run: record?.lastRun || null } });
    }
    const record = records.get(url.searchParams.get("sessionId"));
    const actionId = url.searchParams.get("actionId");
    const run = record?.activeRun || (record?.lastRun?.id === actionId ? record.lastRun : null);
    return route.fulfill({ json: { run: run || null } });
  });
  await page.route("**/api/voice/chat", route => route.fulfill({ status: 503, json: { error: "Unexpected model request in deterministic browser test" } }));
  await page.route("**/api/voice/tts", route => route.fulfill({ status: 503, json: { error: "No speech provider in browser tests" } }));
  return { records, queue, requests, agents: agentProfiles, delegations: delegated };
}
