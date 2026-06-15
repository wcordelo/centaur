#!/usr/bin/env python3
"""Smoke-test a local vLLM OpenAI endpoint for Gemma 4 tool + reasoning + JSON schema.

No third-party deps — stdlib only. Example:

  python3 contrib/scripts/test-local-vllm-gemma4.py \\
    --base-url http://127.0.0.1:8000/v1 \\
    --model gemma
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.error
import urllib.request
from typing import Any

CHANNEL_LEAK_RE = re.compile(r"<\|?channel\|?>|<channel\|>", re.IGNORECASE)
TOOL_LEAK_RE = re.compile(r"<\|tool_call>|<tool_call\|>", re.IGNORECASE)

WEATHER_TOOL = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get the current weather for a location",
        "parameters": {
            "type": "object",
            "properties": {
                "location": {
                    "type": "string",
                    "description": "City name, e.g. San Francisco",
                },
                "unit": {
                    "type": "string",
                    "enum": ["celsius", "fahrenheit"],
                },
            },
            "required": ["location"],
        },
    },
}

CITY_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "city": {"type": "string"},
        "country": {"type": "string"},
        "population": {"type": "integer"},
    },
    "required": ["city", "country", "population"],
}


class VllmClient:
    def __init__(self, base_url: str, api_key: str, timeout: float) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    def request(self, method: str, path: str, body: dict[str, Any] | None = None) -> Any:
        url = f"{self.base_url}{path}"
        data = None
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        if body is not None:
            data = json.dumps(body).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"HTTP {exc.code} {path}: {detail}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"request failed {path}: {exc.reason}") from exc
        if not raw.strip():
            return None
        return json.loads(raw)

    def chat_completions(self, payload: dict[str, Any]) -> dict[str, Any]:
        result = self.request("POST", "/chat/completions", payload)
        assert isinstance(result, dict)
        return result


def first_model_id(models_payload: dict[str, Any]) -> str | None:
    data = models_payload.get("data")
    if not isinstance(data, list) or not data:
        return None
    first = data[0]
    if isinstance(first, dict) and isinstance(first.get("id"), str):
        return first["id"]
    return None


def message_from_response(response: dict[str, Any]) -> dict[str, Any]:
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices:
        raise RuntimeError("chat completion missing choices")
    choice = choices[0]
    if not isinstance(choice, dict):
        raise RuntimeError("invalid choice shape")
    message = choice.get("message")
    if not isinstance(message, dict):
        raise RuntimeError("choice missing message")
    return message


def assert_no_control_token_leaks(text: str, label: str) -> None:
    if CHANNEL_LEAK_RE.search(text):
        raise RuntimeError(f"{label}: channel control tokens leaked in output")
    if TOOL_LEAK_RE.search(text):
        raise RuntimeError(f"{label}: tool-call markup leaked in output")


def run_check(name: str, fn: Any) -> bool:
    try:
        fn()
    except Exception as exc:  # noqa: BLE001 — smoke script reports all failures
        print(f"FAIL  {name}: {exc}", file=sys.stderr)
        return False
    print(f"OK    {name}")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--base-url",
        default="http://127.0.0.1:8000/v1",
        help="OpenAI-compatible base URL (default: %(default)s)",
    )
    parser.add_argument(
        "--model",
        default="",
        help="Model id (default: first model from /v1/models)",
    )
    parser.add_argument("--api-key", default="local", help="Bearer token (default: local)")
    parser.add_argument("--timeout", type=float, default=120.0, help="HTTP timeout seconds")
    parser.add_argument(
        "--skip-thinking",
        action="store_true",
        help="Skip reasoning / enable_thinking check",
    )
    parser.add_argument(
        "--skip-tools",
        action="store_true",
        help="Skip tool-calling check",
    )
    parser.add_argument(
        "--skip-json-schema",
        action="store_true",
        help="Skip response_format json_schema check",
    )
    args = parser.parse_args()

    client = VllmClient(args.base_url, args.api_key, args.timeout)

    models_payload = client.request("GET", "/models")
    if not isinstance(models_payload, dict):
        raise SystemExit("unexpected /models payload")
    model = args.model.strip() or first_model_id(models_payload) or ""
    if not model:
        raise SystemExit("no model id — pass --model or fix /v1/models")

    print(f"==> base_url={args.base_url} model={model}")
    passed = 0
    total = 0

    def check(name: str, fn: Any) -> None:
        nonlocal passed, total
        total += 1
        if run_check(name, fn):
            passed += 1

    def test_models() -> None:
        if first_model_id(models_payload) is None:
            raise RuntimeError("empty models list")

    def test_chat() -> None:
        response = client.chat_completions(
            {
                "model": model,
                "messages": [
                    {
                        "role": "user",
                        "content": "Reply with exactly PONG and nothing else.",
                    }
                ],
                "max_tokens": 32,
                "temperature": 0,
                "stream": False,
            }
        )
        message = message_from_response(response)
        content = str(message.get("content") or "").strip()
        if "PONG" not in content.upper():
            raise RuntimeError(f"expected PONG in content, got: {content!r}")
        assert_no_control_token_leaks(content, "chat")

    def test_tools() -> None:
        response = client.chat_completions(
            {
                "model": model,
                "messages": [
                    {
                        "role": "user",
                        "content": "What is the weather in Tokyo today?",
                    }
                ],
                "tools": [WEATHER_TOOL],
                "max_tokens": 256,
                "temperature": 0,
                "stream": False,
            }
        )
        message = message_from_response(response)
        tool_calls = message.get("tool_calls")
        if not isinstance(tool_calls, list) or not tool_calls:
            content = str(message.get("content") or "")
            raise RuntimeError(
                "no tool_calls in response; enable --tool-call-parser gemma4 on the server. "
                f"content={content[:200]!r}"
            )
        first = tool_calls[0]
        if not isinstance(first, dict):
            raise RuntimeError("invalid tool_calls[0]")
        function = first.get("function")
        if not isinstance(function, dict):
            raise RuntimeError("tool call missing function")
        name = function.get("name")
        if name != "get_weather":
            raise RuntimeError(f"expected get_weather, got {name!r}")
        arguments = function.get("arguments")
        if not isinstance(arguments, str):
            raise RuntimeError("tool arguments must be a JSON string")
        parsed = json.loads(arguments)
        if not isinstance(parsed.get("location"), str) or not parsed["location"].strip():
            raise RuntimeError(f"tool args missing location: {parsed!r}")
        if "trutrue" in arguments:
            raise RuntimeError("boolean corruption in tool args (streaming parser bug?)")

    def test_thinking() -> None:
        response = client.chat_completions(
            {
                "model": model,
                "messages": [
                    {
                        "role": "user",
                        "content": "What is 17 * 23? Think step by step, then give the final number.",
                    }
                ],
                "max_tokens": 512,
                "temperature": 0,
                "stream": False,
                "chat_template_kwargs": {"enable_thinking": True},
            }
        )
        message = message_from_response(response)
        content = str(message.get("content") or "")
        reasoning = message.get("reasoning")
        if isinstance(reasoning, str) and reasoning.strip():
            assert_no_control_token_leaks(reasoning, "reasoning")
        assert_no_control_token_leaks(content, "thinking content")
        if "391" not in content and "391" not in str(reasoning or ""):
            raise RuntimeError("expected 391 in answer or reasoning")

    def test_json_schema() -> None:
        response = client.chat_completions(
            {
                "model": model,
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            "Extract city facts as JSON with integer population for Paris, France."
                        ),
                    },
                    {"role": "user", "content": "Tell me about Paris, France."},
                ],
                "response_format": {
                    "type": "json_schema",
                    "json_schema": {
                        "name": "city-info",
                        "schema": CITY_JSON_SCHEMA,
                    },
                },
                "max_tokens": 256,
                "temperature": 0,
                "stream": False,
            }
        )
        message = message_from_response(response)
        content = str(message.get("content") or "").strip()
        if not content:
            raise RuntimeError("empty json_schema content")
        data = json.loads(content)
        if data.get("city") != "Paris":
            raise RuntimeError(f"unexpected city field: {data!r}")
        if not isinstance(data.get("population"), int):
            raise RuntimeError(f"population must be integer, got: {data!r}")

    check("GET /v1/models", test_models)
    check("chat completion (PONG)", test_chat)
    if not args.skip_tools:
        check("tool calling (get_weather)", test_tools)
    if not args.skip_thinking:
        check("reasoning / enable_thinking", test_thinking)
    if not args.skip_json_schema:
        check("json_schema structured output", test_json_schema)

    print(f"\n{passed}/{total} checks passed")
    return 0 if passed == total else 1


if __name__ == "__main__":
    raise SystemExit(main())
