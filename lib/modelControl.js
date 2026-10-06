import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const hermesHome = process.env.HERMES_HOME || path.join(os.homedir(), ".hermes");
const envPath = path.join(hermesHome, ".env");
const configPath = path.join(hermesHome, "config.yaml");

export const MODEL_OPTIONS = [
  {
    id: "nvidia-kimi-k2-6",
    label: "Kimi K2.6",
    provider: "nvidia",
    model: "moonshotai/kimi-k2.6",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    envKey: "NVIDIA_API_KEY",
    notes: "Current primary. Strong general agent model when NVIDIA is not under load."
  },
  {
    id: "nvidia-deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    provider: "nvidia",
    model: "deepseek-ai/deepseek-v4-pro",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    envKey: "NVIDIA_API_KEY",
    notes: "NVIDIA-hosted DeepSeek V4 Pro. Try this before spending the paid DeepSeek balance."
  },
  {
    id: "nvidia-deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    provider: "nvidia",
    model: "deepseek-ai/deepseek-v4-flash",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    envKey: "NVIDIA_API_KEY",
    notes: "NVIDIA-hosted fast DeepSeek option for lighter Discord turns and quick checks."
  },
  {
    id: "nvidia-glm-5-1",
    label: "GLM 5.1",
    provider: "nvidia",
    model: "z-ai/glm-5.1",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    envKey: "NVIDIA_API_KEY",
    notes: "NVIDIA-hosted flagship GLM model for agentic workflows, coding, and long-horizon reasoning."
  },
  {
    id: "nvidia-qwen3-397b",
    label: "Qwen 3.5 397B A17B",
    provider: "nvidia",
    model: "qwen/qwen3.5-397b-a17b",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    envKey: "NVIDIA_API_KEY",
    notes: "Large NVIDIA-hosted option to try when Kimi has pressure."
  },
  {
    id: "paid-deepseek-v4-pro",
    label: "DeepSeek V4 Pro (paid)",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    baseUrl: "https://api.deepseek.com/v1",
    envKey: "DEEPSEEK_API_KEY",
    notes: "Paid fallback. Use deliberately because this draws from the small paid balance."
  }
];

export function readHermesEnv() {
  const env = {};
  try {
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      if (!line || line.trim().startsWith("#") || !line.includes("=")) continue;
      const index = line.indexOf("=");
      const key = line.slice(0, index).trim();
      let value = line.slice(index + 1).trim();
      value = value.replace(/^["']|["']$/g, "");
      if (key) env[key] = value;
    }
  } catch {
    return env;
  }
  return env;
}

export function redactedModelOptions(currentModel) {
  const env = readHermesEnv();
  return MODEL_OPTIONS.map((option) => ({
    ...option,
    configured: Boolean(env[option.envKey]),
    activePrimary: option.provider === currentModel.provider && option.model === currentModel.model,
    activeFallback: currentModel.fallback?.some((fallback) => fallback.provider === option.provider && fallback.model === option.model) || false
  }));
}

function replaceTopLevelBlock(text, key, lines) {
  const sourceLines = text.split(/\r?\n/);
  const start = sourceLines.findIndex((line) => line.trim() === `${key}:`);
  const replacement = [`${key}:`, ...lines.map((line) => `  ${line}`)];
  if (start === -1) return `${text.trimEnd()}\n${replacement.join("\n")}\n`;

  let end = start + 1;
  while (end < sourceLines.length && (sourceLines[end] === "" || /^\s/.test(sourceLines[end]))) end += 1;
  return [...sourceLines.slice(0, start), ...replacement, ...sourceLines.slice(end)].join("\n");
}

export function updateModelConfig(optionId, role) {
  const option = MODEL_OPTIONS.find((candidate) => candidate.id === optionId);
  if (!option) throw new Error("Unknown model option.");
  const config = fs.readFileSync(configPath, "utf8");
  const backupPath = `${configPath}.mission-control.bak`;
  if (!fs.existsSync(backupPath)) fs.writeFileSync(backupPath, config);

  const next =
    role === "fallback"
      ? replaceTopLevelBlock(config, "fallback_model", [`provider: ${option.provider}`, `model: ${option.model}`])
      : replaceTopLevelBlock(config, "model", [
          `default: ${option.model}`,
          `provider: ${option.provider}`,
          `base_url: ${option.baseUrl}`
        ]);

  const tmp = `${configPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, next);
  fs.renameSync(tmp, configPath);
  return option;
}

export async function probeModel(option, signal) {
  const env = readHermesEnv();
  const key = env[option.envKey];
  const startedAt = Date.now();
  if (!key) {
    return { id: option.id, ok: false, status: "missing_key", latencyMs: 0, detail: `${option.envKey} is not configured.` };
  }

  try {
    const response = await fetch(`${option.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: option.model,
        messages: [{ role: "user", content: "Reply with OK." }],
        max_tokens: 2,
        temperature: 0
      }),
      signal
    });

    const latencyMs = Date.now() - startedAt;
    if (response.ok) return { id: option.id, ok: true, status: "available", latencyMs, detail: "Probe completed." };
    const text = await response.text();
    if (response.status === 429) return { id: option.id, ok: false, status: "rate_limited", latencyMs, detail: "Provider returned 429 rate limit." };
    if (response.status === 401 || response.status === 403) return { id: option.id, ok: false, status: "auth_error", latencyMs, detail: "API key was rejected." };
    if (response.status === 404) return { id: option.id, ok: false, status: "not_found", latencyMs, detail: "Model was not found at this provider." };
    return { id: option.id, ok: false, status: "error", latencyMs, detail: text.slice(0, 240) || `HTTP ${response.status}` };
  } catch (error) {
    return {
      id: option.id,
      ok: false,
      status: error.name === "AbortError" ? "timeout" : "error",
      latencyMs: Date.now() - startedAt,
      detail: error.name === "AbortError" ? "Probe timed out." : error.message
    };
  }
}
