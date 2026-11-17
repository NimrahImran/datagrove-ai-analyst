"""Datagrove API (FastAPI) — deployed as a Vercel Python function.

Routes
  GET  /api/health    service status
  POST /api/analyze   upload a CSV, stream the 5-agent pipeline (NDJSON)
  POST /api/chat      chat with your data
  POST /api/contact   send the contact form by email
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi import FastAPI, File, HTTPException, UploadFile  # noqa: E402
from fastapi.responses import JSONResponse, StreamingResponse  # noqa: E402
from pydantic import BaseModel, Field  # noqa: E402

from backend import llm  # noqa: E402
from backend.chat import answer, answer_stream  # noqa: E402
from backend.contact import ContactError, send_message  # noqa: E402
from backend.pipeline import run_pipeline  # noqa: E402

MAX_BYTES = 4 * 1024 * 1024  # Vercel request limit is 4.5 MB

app = FastAPI(title="Datagrove API", version="1.0.0", docs_url="/api/docs", openapi_url="/api/openapi.json")


@app.get("/api/health")
def health():
    return {"status": "ok", "ai": "gemini" if llm.is_configured() else "rules"}


@app.post("/api/analyze")
async def analyze(file: UploadFile = File(...)):
    name = file.filename or "data.csv"
    if not name.lower().endswith((".csv", ".tsv", ".txt")):
        raise HTTPException(status_code=400, detail="Please upload a .csv file.")
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="The file is empty.")
    if len(raw) > MAX_BYTES:
        raise HTTPException(status_code=413, detail="The file is larger than 4 MB.")
    return StreamingResponse(
        run_pipeline(raw, name),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


class ChatTurn(BaseModel):
    role: str
    text: str


class ChatRequest(BaseModel):
    question: str = Field(..., max_length=500)
    context: dict
    history: list[ChatTurn] = []


@app.post("/api/chat")
def chat(req: ChatRequest):
    """Streams the reply as NDJSON: {"type":"delta","text":...} then {"type":"done",...}."""
    return StreamingResponse(
        answer_stream(req.question, req.context, [h.model_dump() for h in req.history]),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


@app.post("/api/chat/complete")
def chat_complete(req: ChatRequest):
    """Non-streaming version of /api/chat (handy for scripts and tests)."""
    return answer(req.question, req.context, [h.model_dump() for h in req.history])


class ContactRequest(BaseModel):
    name: str = Field(..., max_length=120)
    email: str = Field(..., max_length=200)
    subject: str = Field("", max_length=200)
    message: str = Field(..., max_length=5000)
    website: str = ""  # honeypot: bots fill this, people never see it


@app.get("/api/contact-config")
def contact_config():
    """Public form key for the browser backup (Web3Forms keys are meant to be public)."""
    key = (os.getenv("WEB3FORMS_ACCESS_KEY") or "").strip()
    return {"web3forms_key": key or None}


@app.post("/api/contact")
def contact(req: ContactRequest):
    if req.website:
        return {"ok": True}
    try:
        send_message(req.name, req.email, req.subject, req.message)
    except ContactError as exc:
        return JSONResponse(status_code=400, content={"ok": False, "error": str(exc)})
    return {"ok": True}
