// Public API fixtures: histories live here, outside the page, so a reload must
// hydrate the server response instead of succeeding through legacy storage.
export async function mockWorkspace(page, { sessions = [{ id: "qa-main", name: "QA session" }], tasks = [] } = {}) {
  const timestamp = new Date().toISOString();
  const records = new Map(sessions.map(item => [item.id, {
    session: { workingDirectory: null, pinned: false, archivedAt: null, createdAt: timestamp, updatedAt: timestamp, ...item, messages: undefined, activeRun: undefined, lastRun: undefined },
    messages: [...(item.messages || [])], activeRun: item.activeRun || null,
    lastRun: item.lastRun || item.activeRun || null,
  }]));
  const queue = tasks.map(task => ({ createdAt: timestamp, runAt: timestamp, ...task }));
  const requests = { createdSessions: [], sessionPatches: [], queuedTasks: [], cancellations: [], adoptedSessions: [], stoppedRuns: [] };
  let nextId = 0;
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
  await page.route("**/api/capabilities", route => route.fulfill({ json: {
    skills: [{ id: "qa-research", name: "Research notebook", description: "Check primary sources and preserve evidence.", source: "user", category: "research" }, { id: "qa-review", name: "Patch review", description: "Review changes before release.", source: "repository", category: "engineering" }],
    plugins: [{ id: "qa-search", name: "Search connector", description: "Search workspace documents.", source: "user", version: "2.4.0", status: "enabled" }],
    runtime: { configurationFound: true, environmentFound: true, home: "/QA/hermes-home", repository: "/QA/Hermes-runtime" },
    warnings: [], scope: "Read from installed Hermes manifests.",
  } }));
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
  return { records, queue, requests };
}
