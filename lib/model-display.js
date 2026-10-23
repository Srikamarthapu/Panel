const SPECIAL = Object.freeze({
  deepseek: "DeepSeek",
  nemotron: "Nemotron",
  qwen: "Qwen",
  kimi: "Kimi",
  glm: "GLM",
  gpt: "GPT",
  vl: "VL",
  instruct: "Instruct",
  flash: "Flash",
  pro: "Pro",
  super: "Super",
  mini: "Mini",
  nano: "Nano",
});

export function formatModelDisplayName(value) {
  const raw = typeof value === "string" ? value.trim().split("/").at(-1) || "" : "";
  if (!raw) return "Model not configured";
  return raw.split(/[-_]+/).filter(Boolean).map(token => {
    const lower = token.toLocaleLowerCase();
    if (SPECIAL[lower]) return SPECIAL[lower];
    if (/^[akv]\d+(?:\.\d+)?b?$/i.test(token)) return token.toLocaleUpperCase();
    if (/^\d+(?:\.\d+)?b$/i.test(token)) return token.toLocaleUpperCase();
    if (/^\d+(?:\.\d+)*$/.test(token)) return token;
    return `${token.charAt(0).toLocaleUpperCase()}${token.slice(1)}`;
  }).join(" ");
}
