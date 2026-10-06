"""Bounded, non-generative System One transport with a total wall-clock deadline."""
import json
import threading
import hashlib
from .diagnostics import record_transport

ENDPOINT = "https://api.typesafe.ai/v1/systemone"
MODEL = "jev-latest"
_transport_slot = threading.BoundedSemaphore(1)


class DecisionUnavailable(Exception):
    def __init__(self, reason):
        self.reason = reason
        super().__init__(reason)


def request_decisions(state, questions, config):
    if not config.get("apiKey"):
        raise DecisionUnavailable("not_configured")
    encoded = json.dumps({"model": MODEL, "state": state, "questions": questions}, ensure_ascii=False)
    if len(encoded) > 100_000:
        raise DecisionUnavailable("decision_too_large")
    if not _transport_slot.acquire(blocking=False):
        raise DecisionUnavailable("previous_request_pending")
    record_transport("attempt")
    done = threading.Event()
    output = {}
    timeout = config.get("timeoutMs", 1200) / 1000

    def request():
        try:
            import httpx
            with httpx.Client(timeout=timeout, follow_redirects=False) as client:
                with client.stream("POST", ENDPOINT, content=encoded.encode(), headers={
                    "Authorization": "Bearer " + config["apiKey"],
                    "Content-Type": "application/json", "Accept": "application/json",
                }) as response:
                    if response.status_code != 200:
                        output["error"] = "authentication" if response.status_code in (401, 403) else "unavailable"
                        record_transport("failure")
                        return
                    body = bytearray()
                    for chunk in response.iter_bytes():
                        body.extend(chunk)
                        if len(body) > 512_000:
                            output["error"] = "invalid_response"
                            record_transport("failure")
                            return
                    payload = json.loads(body)
                    if not isinstance(payload, dict) or not isinstance(payload.get("answers"), dict):
                        output["error"] = "invalid_response"
                        record_transport("failure")
                        return
                    output["payload"] = payload
                    receipt = {}
                    request_id = response.headers.get("x-request-id") or response.headers.get("request-id") or ""
                    if request_id:
                        receipt["requestIdHash"] = hashlib.sha256(request_id.encode()).hexdigest()[:12]
                    usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
                    for source, target in (("input_tokens", "inputTokens"), ("output_tokens", "outputTokens"), ("total_tokens", "totalTokens")):
                        value = usage.get(source)
                        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
                            receipt[target] = value
                    record_transport("success", receipt)
        except Exception:
            # No provider body, key, prompt, or exception text enters logs.
            output["error"] = "unavailable"
            record_transport("failure")
        finally:
            _transport_slot.release()
            done.set()

    threading.Thread(target=request, name="jev-decision", daemon=True).start()
    if not done.wait(timeout):
        record_transport("timeout")
        raise DecisionUnavailable("timeout")
    if "payload" not in output:
        raise DecisionUnavailable(output.get("error", "unavailable"))
    return output["payload"]
