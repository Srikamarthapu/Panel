"""Provider-native requests/responses; the host still validates and dispatches tools."""
import copy
import json
import re
import time
import uuid
from types import SimpleNamespace as Obj

SUPPORTED = {"chat_completions", "anthropic_messages", "codex_responses"}
_DSML_ONLY = re.compile(
    r'^\s*<\s*[|｜\s]*DSML[|｜\s]*\s+(?:calls|function_calls|tool_calls)\s*>[\s\S]*'
    r'</\s*[|｜\s]*DSML[|｜\s]*\s+(?:calls|function_calls|tool_calls)\s*>\s*$',
    re.IGNORECASE,
)


def thinking_blocks_forced_tool(request, provider="", model=""):
    """True when the effective provider wire cannot combine thinking with a forced tool.

    The execution middleware receives the fully assembled request, including
    provider-profile ``extra_body`` fields. DeepSeek V4 also defaults thinking
    on when that field is absent, so provider/model identity is the fallback.
    """
    provider_name = str(provider or "").strip().lower()
    model_name = str(model or request.get("model") or "").strip().lower().rsplit("/", 1)[-1]
    deepseek_v4 = model_name.startswith("deepseek-v4") or model_name in {"deepseek-flash", "deepseek-v4-flash", "deepseek-v4-pro"}
    if provider_name not in {"deepseek", "deepseek-chat", "deep-seek"} or not deepseek_v4:
        return False
    containers = [request]
    if isinstance(request.get("extra_body"), dict):
        containers.append(request["extra_body"])
    explicit_disabled = False
    explicit_enabled = False
    for container in containers:
        thinking = container.get("thinking")
        if isinstance(thinking, dict):
            kind = str(thinking.get("type") or "").lower()
            explicit_disabled = explicit_disabled or kind == "disabled"
            explicit_enabled = explicit_enabled or kind in {"enabled", "adaptive"}
        reasoning = container.get("reasoning")
        if isinstance(reasoning, dict):
            if reasoning.get("enabled") is False:
                explicit_disabled = True
            elif reasoning.get("enabled") is True:
                explicit_enabled = True
    effort = str(request.get("reasoning_effort") or "").strip().lower()
    if effort and effort not in {"none", "off", "disabled"}:
        explicit_enabled = True
    if explicit_disabled:
        return False
    if explicit_enabled:
        return True
    return True


def _native_deepseek_v4(provider, model, request):
    provider_name = str(provider or "").strip().lower()
    model_name = str(model or request.get("model") or "").strip().lower().rsplit("/", 1)[-1]
    return provider_name in {"deepseek", "deepseek-chat", "deep-seek"} and (
        model_name.startswith("deepseek-v4") or model_name in {"deepseek-flash", "deepseek-v4-flash", "deepseek-v4-pro"}
    )


def malformed_dsml_only(response):
    """Detect a standalone textual tool call without reading or executing it."""
    choices = response.get("choices") if isinstance(response, dict) else getattr(response, "choices", None)
    if not isinstance(choices, list) or not choices:
        return False
    message = choices[0].get("message") if isinstance(choices[0], dict) else getattr(choices[0], "message", None)
    if message is None:
        return False
    tool_calls = message.get("tool_calls") if isinstance(message, dict) else getattr(message, "tool_calls", None)
    content = message.get("content") if isinstance(message, dict) else getattr(message, "content", None)
    return not tool_calls and isinstance(content, str) and _DSML_ONLY.fullmatch(content) is not None


def deepseek_protocol_correction(request, *, provider="", model=""):
    """Return a request-local one-shot correction, or None for other providers."""
    if not _native_deepseek_v4(provider, model, request):
        return None
    messages = request.get("messages")
    if not isinstance(messages, list):
        return None
    corrected = dict(request)
    corrected["messages"] = [*messages, {
        "role": "system",
        "content": ("Protocol correction: respond with a native tool call when another tool is needed, "
                    "or plain final prose when the work is complete. Do not emit textual tool markup and "
                    "do not repeat tools whose completed results are already present."),
    }]
    corrected["tool_choice"] = "auto"
    return corrected


def deepseek_finish_keeps_tools_available(request, *, provider="", model=""):
    """Whether FINISH should remain auto to avoid textual DeepSeek tool calls."""
    return _native_deepseek_v4(provider, model, request)


def tool_schemas(request, api_mode):
    tools = {}
    for raw in request.get("tools") or []:
        if not isinstance(raw, dict):
            continue
        if api_mode == "chat_completions":
            if raw.get("type") != "function":
                continue
            fn = raw.get("function") or {}
        elif api_mode == "anthropic_messages":
            if "input_schema" not in raw:
                continue
            fn = {**raw, "parameters": raw["input_schema"]}
        elif api_mode == "codex_responses":
            if raw.get("type") != "function":
                continue
            fn = raw
        else:
            continue
        name = fn.get("name")
        if isinstance(name, str) and name and isinstance(fn.get("parameters"), dict):
            tools[name] = {"name": name, "description": str(fn.get("description") or "")[:1200],
                           "parameters": fn["parameters"], "annotations": raw.get("annotations") or fn.get("annotations") or {}}
    return tools


def force_tool(request, name, api_mode, *, provider="", model=""):
    """Keep the stable tool catalog and message prefix byte-for-byte intact."""
    result = dict(request)
    if api_mode == "anthropic_messages":
        # Anthropic forbids forced tool use with active extended/adaptive thinking.
        if (request.get("thinking") or {}).get("type") in {"enabled", "adaptive"}:
            return None
        result["tool_choice"] = {"type": "tool", "name": name, "disable_parallel_tool_use": True} if name else {"type": "none"}
    elif api_mode == "chat_completions":
        if not name and _native_deepseek_v4(provider, model, request):
            return None
        if thinking_blocks_forced_tool(request, provider, model):
            # Native DeepSeek thinking rejects required/named tool choice. For a
            # confident Jev selection, disable thinking on this request only so
            # Hermes fills arguments for that exact tool without choosing again.
            # In practice DeepSeek V4 may emit textual tool markup when
            # thinking is combined with `tool_choice: none`. Keep the original
            # auto request for FINISH so Hermes can validate any remaining call.
            if not name or not _native_deepseek_v4(provider, model, request):
                return None
            extra_body = dict(request.get("extra_body") or {})
            extra_body["thinking"] = {"type": "disabled"}
            result["extra_body"] = extra_body
            result.pop("reasoning_effort", None)
        result["tool_choice"] = {"type": "function", "function": {"name": name}} if name else "none"
        result["parallel_tool_calls"] = False
    elif api_mode == "codex_responses":
        result["tool_choice"] = {"type": "function", "name": name} if name else "none"
        result["parallel_tool_calls"] = False
    else:
        return None
    return result


def tool_response(name, arguments, api_mode, model=""):
    call_id = "call_jev_" + uuid.uuid4().hex[:20]
    args = json.dumps(arguments, ensure_ascii=False)
    if api_mode == "chat_completions":
        call = Obj(id=call_id, type="function", function=Obj(name=name, arguments=args))
        return Obj(id="jev_" + uuid.uuid4().hex, object="chat.completion", created=int(time.time()), model=model,
                   choices=[Obj(index=0, finish_reason="tool_calls", message=Obj(role="assistant", content=None, tool_calls=[call]))],
                   usage=Obj(prompt_tokens=0, completion_tokens=0, total_tokens=0))
    if api_mode == "anthropic_messages":
        return Obj(id="msg_jev_" + uuid.uuid4().hex, type="message", role="assistant", model=model,
                   content=[Obj(type="tool_use", id=call_id, name=name, input=copy.deepcopy(arguments))],
                   stop_reason="tool_use", stop_sequence=None, usage=Obj(input_tokens=0, output_tokens=0))
    if api_mode == "codex_responses":
        return Obj(id="resp_jev_" + uuid.uuid4().hex, model=model, status="completed", output_text="",
                   output=[Obj(id="fc_" + uuid.uuid4().hex, call_id=call_id, type="function_call", name=name,
                               arguments=args, status="completed")], usage=Obj(input_tokens=0, output_tokens=0, total_tokens=0))
    raise ValueError("Unsupported response adapter")
