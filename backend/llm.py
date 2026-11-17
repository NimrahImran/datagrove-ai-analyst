"""Small Gemini client used by the Report and Chat agents.

Uses the public REST endpoint directly (no heavy SDK) so the serverless
bundle stays small. If no API key is configured, callers fall back to
rule-based output, so the app keeps working without a key.
"""
from __future__ import annotations

import json
import os
import re
import time
from typing import Any

import httpx
import logging

log = logging.getLogger("datagrove.llm")
logging.getLogger("httpx").setLevel(logging.WARNING)  # never log request URLs

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
DEFAULT_MODELS = ("gemini-3.8-flash", "gemini-flash-lite-latest", "gemini-flash-latest")


class LLMUnavailable(RuntimeError):
    """Raised when no key is set or every model call failed."""


def is_configured() -> bool:
    return bool(os.getenv("GEMINI_API_KEY"))


def _models() -> list[str]:
    preferred = os.getenv("GEMINI_MODEL")
    models = [preferred] if preferred else []
    models += [m for m in DEFAULT_MODELS if m not in models]
    return models


def _extract_json(text: str) -> Any:
    text = text.strip()
    fenced = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fenced:
        text = fenced.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start != -1 and end > start:
            return json.loads(text[start : end + 1])
        raise


def generate_json(system: str, prompt: str, temperature: float = 0.4, timeout: float = 35.0, budget: float = 85.0) -> Any:
    """Ask Gemini for a JSON answer. Raises LLMUnavailable on failure."""
    key = (os.getenv("GEMINI_API_KEY") or "").strip().strip('"').strip("'")
    if not key:
        raise LLMUnavailable("GEMINI_API_KEY is not set")

    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {
            "temperature": temperature,
            "responseMimeType": "application/json",
        },
    }
    last_error: Exception | None = None
    queue = _models()
    tried: set[str] = set()
    started = time.monotonic()
    attempts: dict[str, int] = {}
    no_thinking_cfg: set[str] = set()
    while queue and time.monotonic() - started < budget:
        model = queue.pop(0)
        if model in tried:
            continue
        attempts[model] = attempts.get(model, 0) + 1
        try:
            payload = json.loads(json.dumps(body))
            if model not in no_thinking_cfg:
                # fast answers: keep model "thinking" to a minimum
                payload["generationConfig"]["thinkingConfig"] = {"thinkingLevel": "minimal"}
            resp = httpx.post(
                GEMINI_URL.format(model=model),
                headers={"x-goog-api-key": key},
                json=payload,
                timeout=min(timeout, max(5.0, budget - (time.monotonic() - started))),
            )
            if resp.status_code == 400 and "thinking" in resp.text.lower() and model not in no_thinking_cfg:
                no_thinking_cfg.add(model)
                queue.insert(0, model)
                continue
            if resp.status_code in (429, 500, 503) and attempts[model] < 2:
                # busy or rate limited: wait a moment and try the same model once more
                print(f"[gemini] {model}: HTTP {resp.status_code}, retrying", flush=True)
                time.sleep(2.0)
                queue.insert(0, model)
                continue
            tried.add(model)
            if resp.status_code != 200:
                last_error = RuntimeError(f"{model}: HTTP {resp.status_code} {resp.text[:300]}")
                print(f"[gemini] {last_error}", flush=True)
                # Google names the replacement model when one is retired
                suggested = re.findall(r"models/(gemini-[\w.\-]+)", resp.text)
                queue = [m for m in suggested if m not in tried] + queue
                continue
            data = resp.json()
            text = data["candidates"][0]["content"]["parts"][0]["text"]
            return _extract_json(text)
        except Exception as exc:  # network, parsing or timeout errors
            tried.add(model)
            last_error = exc
            print(f"[gemini] {model}: {type(exc).__name__}: {str(exc)[:300]}", flush=True)
            continue
    raise LLMUnavailable(str(last_error) if last_error else "no model answered")


STREAM_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent"


def stream_text(system: str, prompt: str, temperature: float = 0.4, budget: float = 45.0):
    """Yield text chunks from Gemini as they are generated.

    Falls back to the next model only if nothing has been sent yet.
    Raises LLMUnavailable when no model produced any text.
    """
    key = (os.getenv("GEMINI_API_KEY") or "").strip().strip('"').strip("'")
    if not key:
        raise LLMUnavailable("GEMINI_API_KEY is not set")
    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": temperature, "thinkingConfig": {"thinkingLevel": "minimal"}},
    }
    started = time.monotonic()
    queue, tried = _models(), set()
    last_error = None
    while queue and time.monotonic() - started < budget:
        model = queue.pop(0)
        if model in tried:
            continue
        tried.add(model)
        sent_any = False
        try:
            with httpx.stream(
                "POST",
                STREAM_URL.format(model=model),
                params={"alt": "sse"},
                headers={"x-goog-api-key": key},
                json=body,
                timeout=httpx.Timeout(20.0, read=25.0),
            ) as resp:
                if resp.status_code != 200:
                    text = resp.read().decode("utf-8", "ignore")
                    if resp.status_code == 400 and "thinking" in text.lower() and "thinkingConfig" in body["generationConfig"]:
                        body["generationConfig"].pop("thinkingConfig")
                        tried.discard(model)
                        queue.insert(0, model)
                        continue
                    last_error = RuntimeError(f"{model}: HTTP {resp.status_code} {text[:200]}")
                    print(f"[gemini-stream] {last_error}", flush=True)
                    queue = [m for m in re.findall(r"models/(gemini-[\w.\-]+)", text) if m not in tried] + queue
                    continue
                for line in resp.iter_lines():
                    if not line.startswith("data:"):
                        continue
                    try:
                        data = json.loads(line[5:].strip())
                        parts = data["candidates"][0]["content"]["parts"]
                    except (KeyError, IndexError, json.JSONDecodeError):
                        continue
                    for part in parts:
                        if part.get("text") and not part.get("thought"):
                            sent_any = True
                            yield part["text"]
            if sent_any:
                return
        except Exception as exc:
            last_error = exc
            print(f"[gemini-stream] {model}: {type(exc).__name__}: {str(exc)[:200]}", flush=True)
            if sent_any:
                return  # keep what was already streamed
    raise LLMUnavailable(str(last_error) if last_error else "no model answered")
