import { getVoiceConfig, saveVoiceConfig } from "@/lib/voice";
import { probeAllKeys, reviveKey, maskKey } from "@/lib/elevenlabs";

/**
 * GET  /api/voice/keys                  → probe every configured key, return
 *                                          [{ masked, ok, used, limit, remaining,
 *                                             tier, reason, dead, active }]
 * POST /api/voice/keys  { action, key }
 *   action="set-active"   → mark `key` as the preferred (primary) key
 *   action="revive"       → clear the in-process "dead" flag on `key`
 */
export async function GET() {
  const config = getVoiceConfig();
  const probes = await probeAllKeys(config);
  const active = (config.elevenlabsActiveKey || "").trim();
  return Response.json({
    keys: probes.map((p) => ({
      ...p,
      // Don't ship full keys back to the client — only masked previews
      // plus the masked active flag.
      key: undefined,
      active: p.key === active,
    })),
    activeMasked: active ? maskKey(active) : null,
    voiceId: config.elevenlabsVoiceId || null,
    model: config.elevenlabsModel || null,
  });
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const action = String(body.action || "").trim();
  const target = String(body.key || body.masked || "").trim();
  if (!action) return Response.json({ error: "action required" }, { status: 400 });

  const config = getVoiceConfig();
  const keys = Array.isArray(config.elevenlabsApiKeys)
    ? config.elevenlabsApiKeys.map((k) => String(k || "").trim()).filter(Boolean)
    : [];

  // The UI only ever sees masked keys. Resolve the masked value back to the
  // real key by matching the same masking we ship out.
  const resolveKey = (input) => {
    if (!input) return "";
    if (keys.includes(input)) return input;
    return keys.find((k) => maskKey(k) === input) || "";
  };

  const realKey = resolveKey(target);

  if (action === "set-active") {
    if (!realKey) return Response.json({ error: "Unknown key" }, { status: 404 });
    saveVoiceConfig({ elevenlabsActiveKey: realKey });
    return Response.json({ ok: true, activeMasked: maskKey(realKey) });
  }

  if (action === "revive") {
    if (!realKey) return Response.json({ error: "Unknown key" }, { status: 404 });
    const cleared = reviveKey(realKey);
    return Response.json({ ok: true, cleared });
  }

  return Response.json({ error: `Unknown action: ${action}` }, { status: 400 });
}
