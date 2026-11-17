"""Chat with your data.

The model answers in plain words and may ask for a chart. The chart is a
small spec (type, x, y, aggregation) that the browser computes from the
real data, so numbers in charts are always exact.
"""
from __future__ import annotations

import json
import re

from backend import llm

SYSTEM = (
    "You are Datagrove, a friendly data analyst. Answer questions about the user's dataset "
    "using ONLY the context given. Keep answers short (2-4 sentences), simple and specific. "
    "If a chart helps, include a chart spec using real column names from the schema. "
    "If the question cannot be answered from the data, say so kindly. Return JSON only."
)

PROMPT = """Dataset context:
{context}

Recent conversation:
{history}

User question: {question}

Return JSON:
{{
  "answer": "string",
  "chart": null or {{"type": "bar|line|donut|scatter", "x": "column", "y": "numeric column or null", "agg": "sum|mean|count", "top": 10, "title": "short title"}}
}}"""

CHART_TYPES = {"bar", "line", "donut", "scatter"}
AGGS = {"sum", "mean", "count"}


def _validate_chart(chart, columns: list[str]):
    if not isinstance(chart, dict):
        return None
    if chart.get("type") not in CHART_TYPES or chart.get("x") not in columns:
        return None
    if chart.get("y") not in columns:
        chart["y"] = None
        chart["agg"] = "count"
    if chart.get("agg") not in AGGS:
        chart["agg"] = "sum" if chart.get("y") else "count"
    try:
        chart["top"] = max(3, min(int(chart.get("top") or 10), 20))
    except (TypeError, ValueError):
        chart["top"] = 10
    chart["title"] = str(chart.get("title") or f"{chart.get('y') or 'Count'} by {chart['x']}")[:80]
    return chart


def _fallback(question: str, ctx: dict) -> dict:
    q = question.lower()
    metric = ctx.get("metric")
    cats = ctx.get("categories") or []
    date_col = ctx.get("date_col")
    breakdowns = ctx.get("breakdowns") or []
    trend = ctx.get("trend")

    if date_col and metric and re.search(r"trend|over time|month|week|growth|forecast|future|next", q):
        msg = f"Here is {metric} over time."
        if trend:
            msg += f" It changed {trend.get('overall_change_pct'):+}% overall, and the forecast for the next {trend.get('unit')}s is around {', '.join(f'{v:,.0f}' for v in trend.get('forecast_next', []) if v is not None)}."
        return {"answer": msg, "chart": {"type": "line", "x": date_col, "y": metric, "agg": "sum", "top": 10, "title": f"{metric} over time"}}
    for b in breakdowns:
        if b["column"].lower() in q:
            return {
                "answer": f"'{b['top']}' leads {b['column']} with {b['top_share_pct']}% of {metric or 'rows'}, and '{b['bottom']}' is lowest.",
                "chart": {"type": "bar", "x": b["column"], "y": metric, "agg": "sum" if metric else "count", "top": 10, "title": f"{metric or 'Rows'} by {b['column']}"},
            }
    if re.search(r"top|best|highest|most|lead|worst|lowest", q) and breakdowns:
        b = breakdowns[0]
        return {
            "answer": f"By {b['column']}, '{b['top']}' is on top with {b['top_share_pct']}% of {metric or 'rows'}. The lowest is '{b['bottom']}'.",
            "chart": {"type": "bar", "x": b["column"], "y": metric, "agg": "sum" if metric else "count", "top": 10, "title": f"{metric or 'Rows'} by {b['column']}"},
        }
    if re.search(r"average|mean|typical", q) and metric:
        for k in ctx.get("kpis", []):
            if k["label"].startswith("Average"):
                return {"answer": f"The {k['label'].lower()} is {k['value']:,.2f}.", "chart": None}
    if re.search(r"total|sum|how much", q) and metric:
        for k in ctx.get("kpis", []):
            if k["label"].startswith("Total"):
                return {"answer": f"The {k['label'].lower()} is {k['value']:,.2f}.", "chart": None}
    facts = ctx.get("facts") or []
    tip = f" Try asking about {cats[0]}, the trend, or the average {metric}." if cats and metric else ""
    return {"answer": (facts[0] if facts else "I could not find that in your data.") + tip, "chart": None}


def answer(question: str, ctx: dict, history: list[dict]) -> dict:
    question = (question or "").strip()[:500]
    if not question:
        return {"answer": "Please type a question about your data.", "chart": None}
    columns = [c["name"] for c in ctx.get("schema", [])]
    if not llm.is_configured():
        out = _fallback(question, ctx)
    else:
        hist = "\n".join(f"{h.get('role')}: {str(h.get('text'))[:300]}" for h in history[-6:]) or "none"
        try:
            out = llm.generate_json(SYSTEM, PROMPT.format(context=json.dumps(ctx, default=str)[:9000], history=hist, question=question), temperature=0.3, budget=40.0)
            if not isinstance(out, dict) or "answer" not in out:
                raise ValueError
        except Exception:
            out = _fallback(question, ctx)
    out["chart"] = _validate_chart(out.get("chart"), columns)
    out["answer"] = str(out.get("answer", ""))[:1500]
    return out
