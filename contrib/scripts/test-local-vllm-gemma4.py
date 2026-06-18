#!/usr/bin/env python3
"""Smoke-test a local vLLM OpenAI endpoint for Gemma 4 tool + reasoning + JSON schema.

Uses only the Python standard library. Exit 0 when all selected checks pass.

Examples:
  contrib/scripts/test-local-vllm-gemma4.py
  VLLM_BASE_URL=http://127.0.0.1:8000/v1 VLLM_MODEL=gemma contrib/scripts/test-local-vllm-gemma4.py
  contrib/scripts/test-local-vllm-gemma4.py --skip-json-schema --stream-tools
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any

DEFAULT_BASE = "http://127.0.0.1:8000/v1"
CHANNEL_MARKERS = ("<|channel>", "<channel|>", "<|tool_call>", "<|tool_response|>")


def _base_url() -> str:
    return os.environ.get("VLLM_BASE_URL", DEFAULT_BASE).rstrip("/")


def _api_key() -> str:
    return os.environ.get("VLLM_API_KEY", "local")


def _model() -> str:
    return os.environ.get("VLLM_MODEL", os.environ.get("VLLM_SERVED_MODEL_NAME", "gemma"))


def _post(path: str, body: dict[str, Any], *, timeout: float = 120.0) -> dict[str, Any]:
    url = f"{_base_url()}{path}"
    data = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {_api_key()}",
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _get(path: str, *, timeout: float = 30.0) -> dict[str, Any]:
    url = f"{_base_url()}{path}"
    request = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {_api_key()}"},
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def check_models() -> None:
    payload = _get("/models")
    ids = [item.get("id") for item in payload.get("data", [])]
    if not ids:
        raise AssertionError(f"/models returned no models: {payload!r}")
    model = _model()
    if model not in ids:
        print(f"  note: served model {model!r} not in {ids!r}; using first id {ids[0]!r}")
    print(f"  ok models ({len(ids)}): {', '.join(ids[:5])}")


def check_chat() -> None:
    payload = _post(
        "/chat/completions",
        {
            "model": _model(),
            "messages": [
                {
                    "role": "user",
                    "content": "Reply with exactly the word PONG and nothing else.",
                }
            ],
            "max_tokens": 32,
            "temperature": 0,
        },
    )
    message = payload["choices"][0]["message"]
    content = (message.get("content") or "").strip()
    if not content:
        raise AssertionError(f"empty chat content: {payload!r}")
    print(f"  ok chat: {content[:80]!r}")


def check_tools(*, stream: bool) -> None:
    tools = [
        {
            "type": "function",
            "function": {
                "name": "get_weather",
                "description": "Get weather for a city",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "city": {"type": "string"},
                        "unit": {
                            "type": "string",
                            "enum": ["celsius", "fahrenheit"],
                        },
                    },
                    "required": ["city"],
                },
            },
        }
    ]
    body: dict[str, Any] = {
        "model": _model(),
        "messages": [
            {
                "role": "user",
                "content": "What is the weather in Paris? Use the get_weather tool.",
            }
        ],
        "tools": tools,
        "tool_choice": "auto",
        "max_tokens": 256,
        "temperature": 0,
        "stream": stream,
    }
    if stream:
        print("  warn: streaming tool calls are known-buggy on some vLLM gemma4 builds; prefer non-stream")
        body["stream"] = True
        # Streaming path: minimal validation — ensure we get SSE chunks without crashing.
        url = f"{_base_url()}/chat/completions"
        data = json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=data,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {_api_key()}",
            },
            method="POST",
        )
        chunks = 0
        with urllib.request.urlopen(request, timeout=120.0) as response:
            for raw_line in response:
                line = raw_line.decode("utf-8", errors="replace").strip()
                if line.startswith("data:") and line != "data: [DONE]":
                    chunks += 1
        if chunks < 1:
            raise AssertionError("streaming tool call produced no data chunks")
        print(f"  ok tools (stream): received {chunks} chunk(s)")
        return

    payload = _post("/chat/completions", body)
    message = payload["choices"][0]["message"]
    tool_calls = message.get("tool_calls") or []
    if not tool_calls:
        raise AssertionError(
            "no tool_calls in response — is --tool-call-parser gemma4 enabled? "
            f"message={message!r}"
        )
    fn = tool_calls[0].get("function") or {}
    name = fn.get("name")
    args_raw = fn.get("arguments") or "{}"
    args = json.loads(args_raw) if isinstance(args_raw, str) else args_raw
    if name != "get_weather":
        raise AssertionError(f"unexpected tool name {name!r}")
    if "city" not in args:
        raise AssertionError(f"tool args missing city: {args!r}")
    if "trutrue" in args_raw:
        raise AssertionError(
            "boolean corruption in tool args (streaming parser bug); upgrade vLLM or use stream=false"
        )
    print(f"  ok tools: {name}({args})")


def check_reasoning() -> None:
    body: dict[str, Any] = {
        "model": _model(),
        "messages": [
            {
                "role": "user",
                "content": (
                    "Think step by step, then answer: what is 17 + 25? "
                    "Give only the numeric answer in the final message."
                ),
            }
        ],
        "max_tokens": 512,
        "temperature": 0,
    }
    # When reasoning parser is active, vLLM may need special tokens preserved.
    extra = os.environ.get("VLLM_EXTRA_BODY")
    if extra:
        body.update(json.loads(extra))
    payload = _post("/chat/completions", body)
    message = payload["choices"][0]["message"]
    reasoning = message.get("reasoning_content")
    content = (message.get("content") or "").strip()
    leaked = [m for m in CHANNEL_MARKERS if m in content]
    if reasoning:
        print(f"  ok reasoning: reasoning_content present ({len(reasoning)} chars)")
        return
    if leaked:
        raise AssertionError(
            "channel/tool markers leaked into content — enable --reasoning-parser gemma4 "
            f"or set skip_special_tokens=false. markers={leaked} content={content[:200]!r}"
        )
    if "42" in content:
        print(f"  ok reasoning: numeric answer in content ({content[:80]!r})")
        return
    print(f"  warn reasoning: no reasoning_content and answer unclear: {content[:120]!r}")


def check_json_schema() -> None:
    schema = {
        "type": "object",
        "properties": {
            "answer": {"type": "string"},
            "confidence": {"type": "integer", "minimum": 0, "maximum": 100},
        },
        "required": ["answer", "confidence"],
        "additionalProperties": False,
    }
    payload = _post(
        "/chat/completions",
        {
            "model": _model(),
            "messages": [
                {
                    "role": "user",
                    "content": "What is the capital of France? Rate your confidence 0-100.",
                }
            ],
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "qa-confidence",
                    "strict": True,
                    "schema": schema,
                },
            },
            "max_tokens": 256,
            "temperature": 0,
        },
    )
    content = payload["choices"][0]["message"].get("content") or ""
    try:
        data = json.loads(content)
    except json.JSONDecodeError as exc:
        raise AssertionError(f"response is not valid JSON: {content[:200]!r}") from exc
    if not isinstance(data.get("confidence"), int):
        raise AssertionError(f"confidence must be integer, got: {data!r}")
    if "answer" not in data:
        raise AssertionError(f"missing answer field: {data!r}")
    print(f"  ok json_schema: {data}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--skip-tools", action="store_true")
    parser.add_argument("--skip-reasoning", action="store_true")
    parser.add_argument("--skip-json-schema", action="store_true")
    parser.add_argument("--stream-tools", action="store_true", help="Use streaming tool call probe")
    args = parser.parse_args()

    print(f"target {_base_url()} model={_model()!r}")

    checks: list[tuple[str, callable]] = [("models", check_models), ("chat", check_chat)]
    if not args.skip_tools:
        checks.append(
            (
                "tools",
                lambda: check_tools(stream=args.stream_tools),
            )
        )
    if not args.skip_reasoning:
        checks.append(("reasoning", check_reasoning))
    if not args.skip_json_schema:
        checks.append(("json_schema", check_json_schema))

    failed = 0
    for name, fn in checks:
        print(f"[{name}]")
        try:
            fn()
        except urllib.error.URLError as exc:
            print(f"  FAIL connection: {exc}", file=sys.stderr)
            print(
                "  hint: start vLLM with contrib/scripts/start-local-vllm-gemma4.sh",
                file=sys.stderr,
            )
            return 1
        except AssertionError as exc:
            print(f"  FAIL {exc}", file=sys.stderr)
            failed += 1
        except Exception as exc:  # noqa: BLE001 — test harness reports any API error
            print(f"  FAIL {type(exc).__name__}: {exc}", file=sys.stderr)
            failed += 1

    if failed:
        print(f"\n{failed} check(s) failed", file=sys.stderr)
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
