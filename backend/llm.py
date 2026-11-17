"""Small Gemini client used by the Report and Chat agents.

Uses the public REST endpoint directly (no heavy SDK) so the serverless
bundle stays small. If no API key is configured, callers fall back to
rule-based output, so the app keeps working without a key.
"""
from __future__ import annotations

import json
import os
import re
from typing import Any

import httpx

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
DEFAULT_MODELS = ("gemini-2.5-flash", "gemini-2.0-flash")


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


def generate_json(system: str, prompt: str, temperature: float = 0.4, timeout: float = 40.0) -> Any:
    """Ask Gemini for a JSON answer. Raises LLMUnavailable on failure."""
    key = os.getenv("GEMINI_API_KEY")
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
    for model in _models():
        try:
            resp = httpx.post(
                GEMINI_URL.format(model=model),
                params={"key": key},
                json=body,
                timeout=timeout,
            )
            if resp.status_code != 200:
                last_error = RuntimeError(f"{model}: HTTP {resp.status_code}")
                continue
            data = resp.json()
            text = data["candidates"][0]["content"]["parts"][0]["text"]
            return _extract_json(text)
        except Exception as exc:  # network, parsing or quota errors
            last_error = exc
            continue
    raise LLMUnavailable(str(last_error) if last_error else "no model answered")
