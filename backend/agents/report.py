"""Agent 5 — Report.

Turns the findings into an executive summary, insights and
recommendations. Uses Gemini when a key is set, otherwise a careful
rule-based writer, so a report is always produced.
"""
from __future__ import annotations

import json

from backend import llm

SYSTEM = (
    "You are a senior data analyst writing for a busy business owner. "
    "Use simple, clear English. Only use numbers that appear in the facts. "
    "Never invent columns or values. Return valid JSON only."
)

PROMPT = """Dataset: {name}
Rows: {rows}, columns: {cols}. Main metric: {metric}.
Data quality score: {score}/100. Cleaning done: {cleaning}

Facts found by the analysis agent:
{facts}

Return JSON with exactly these keys:
{{
  "title": "short report title (max 8 words)",
  "summary": "3-4 sentence executive summary",
  "insights": [{{"title": "max 6 words", "detail": "1-2 sentences with a number"}}],   // 5 items
  "recommendations": [{{"title": "max 6 words", "detail": "1-2 sentences, practical action"}}],   // 4 items
  "data_notes": "one sentence about data quality or limits"
}}"""


def _fallback(name: str, profile: dict, cleaning: dict, analysis: dict) -> dict:
    metric = analysis.get("metric") or "rows"
    insights, recs = [], []
    trend = analysis.get("trend")
    if trend:
        direction = "growing" if (trend["overall_change_pct"] or 0) > 0 else "declining"
        insights.append({
            "title": f"{metric} is {direction}",
            "detail": f"From the first to the latest {trend['unit']}, {metric} changed {trend['overall_change_pct']:+}%.",
        })
        insights.append({
            "title": f"Peak {trend['unit']} identified",
            "detail": f"The strongest {trend['unit']} was {trend['best_period']} at {trend['best_value']:,.0f}.",
        })
        recs.append({
            "title": "Plan stock around the forecast",
            "detail": f"The next {trend['unit']}s are forecast near {', '.join(f'{v:,.0f}' for v in trend['forecast_next'])}. Plan inventory and staff for this level.",
        })
    for b in analysis.get("breakdowns", [])[:2]:
        insights.append({
            "title": f"{b['top']} leads {b['column']}",
            "detail": f"'{b['top']}' brings {b['top_share_pct']}% of {metric}, while '{b['bottom']}' is the lowest.",
        })
        recs.append({
            "title": f"Grow from {b['top']}",
            "detail": f"Double down on what works in '{b['top']}' and test a small campaign to lift '{b['bottom']}'.",
        })
    for p in analysis.get("correlations", [])[:1]:
        insights.append({
            "title": f"{p['a']} links to {p['b']}",
            "detail": f"These two columns move {'together' if p['r'] > 0 else 'oppositely'} (correlation {p['r']}).",
        })
    recs.append({
        "title": "Keep data clean at source",
        "detail": f"We fixed {sum(l['count'] for l in cleaning['log'])} issues. Using dropdowns and required fields when collecting data will prevent most of them.",
    })
    return {
        "title": f"{name} analysis report",
        "summary": " ".join(analysis.get("facts", [])[:3]) or f"We analyzed {profile['rows']:,} rows.",
        "insights": insights[:5],
        "recommendations": recs[:4],
        "data_notes": f"Data quality score is {cleaning['quality_score']}/100. {sum(l['count'] for l in cleaning['log']):,} fixes were applied and {cleaning['rows_before'] - cleaning['rows_after']:,} rows were removed.",
        "engine": "rules",
    }


def write_report(name: str, profile: dict, cleaning: dict, analysis: dict) -> dict:
    if not llm.is_configured():
        return _fallback(name, profile, cleaning, analysis)
    prompt = PROMPT.format(
        name=name,
        rows=profile["rows"],
        cols=profile["columns"],
        metric=analysis.get("metric") or "none",
        score=cleaning["quality_score"],
        cleaning="; ".join(f"{l['action']} ({l['count']})" for l in cleaning["log"]) or "none needed",
        facts="\n".join(f"- {f}" for f in analysis.get("facts", [])) + "\nBreakdowns: " + json.dumps(analysis.get("breakdowns", []))[:3000],
    )
    try:
        out = llm.generate_json(SYSTEM, prompt)
        if not isinstance(out, dict) or "summary" not in out:
            raise ValueError("unexpected shape")
        out.setdefault("insights", [])
        out.setdefault("recommendations", [])
        out["engine"] = "gemini"
        return out
    except Exception:
        return _fallback(name, profile, cleaning, analysis)
