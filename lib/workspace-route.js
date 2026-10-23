const ROUTE_KEYS = Object.freeze({
  "/": "overview",
  "/chat": "chat",
  "/tasks": "tasks",
  "/sessions": "sessions",
  "/agents": "agents",
  "/memory": "memory",
  "/models": "models",
  "/tools": "tools",
  "/voice": "voice",
  "/settings": "settings",
});

export function workspaceRouteKey(pathname) {
  if (typeof pathname !== "string") return "overview";
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (normalized.startsWith("/workspace/")) return "workspace";
  return ROUTE_KEYS[normalized] || "overview";
}
