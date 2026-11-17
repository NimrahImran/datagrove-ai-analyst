"""Agent 4 — Visualization.

Chooses which charts tell the story best and prepares a compact copy of
the cleaned data, so the browser can draw interactive charts (hover,
filters, date range, zoom, drill-down) without another server call.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

MAX_ROWS = 15000


def plan_charts(df: pd.DataFrame, analysis: dict) -> tuple[list[dict], dict]:
    metric = analysis.get("metric")
    date_col = analysis.get("date_col")
    cats = analysis.get("categories", [])
    numeric = analysis.get("numeric", [])
    charts: list[dict] = []

    if date_col and metric:
        charts.append({
            "id": "trend", "type": "trend", "x": date_col, "y": metric,
            "title": f"{metric} over time, with forecast",
            "why": "Shows the direction of the business and what may come next.",
        })
    drill = None
    if len(cats) > 1:
        # prefer a column nested inside the first one (e.g. Category -> Sub-Category)
        for cand in cats[1:]:
            parents = df.groupby(cand)[cats[0]].nunique()
            if len(parents) and (parents == 1).mean() > 0.9:
                drill = cand
                break
        drill = drill or cats[1]
    if cats:
        charts.append({
            "id": "category", "type": "bar", "x": cats[0], "y": metric, "drill": drill,
            "title": f"{metric or 'Rows'} by {cats[0]}",
            "why": "Compares groups. Click a bar to drill down." if drill else "Compares groups side by side.",
        })
    if len(cats) > 1:
        options = [c for c in cats if c not in (cats[0], drill) and df[c].nunique() <= 8]
        share_col = options[0] if options else drill
        charts.append({
            "id": "share", "type": "donut", "x": share_col, "y": metric,
            "title": f"Share by {share_col}",
            "why": "Shows how the total splits across groups.",
        })
    if metric:
        charts.append({
            "id": "dist", "type": "histogram", "x": metric,
            "title": f"How {metric} is spread",
            "why": "Reveals typical values and unusual ones.",
        })
    corr = analysis.get("correlations") or []
    if corr:
        top = corr[0]
        charts.append({
            "id": "scatter", "type": "scatter", "x": top["a"], "y": top["b"], "color": cats[0] if cats else None,
            "title": f"{top['a']} vs {top['b']}",
            "why": f"The strongest relationship in your data (r = {top['r']}).",
        })
    if len(numeric) >= 3:
        charts.append({
            "id": "heatmap", "type": "heatmap", "columns": numeric[:7],
            "title": "How numeric columns relate",
            "why": "Darker olive means stronger positive link.",
        })

    # Compact data for the browser
    keep = []
    for c in [date_col, *cats[:4], *numeric[:7]]:
        if c and c not in keep and c in df.columns:
            keep.append(c)
    data = df[keep]
    sampled = False
    if len(data) > MAX_ROWS:
        data = data.sample(MAX_ROWS, random_state=42)
        sampled = True
    if date_col:
        data = data.sort_values(date_col)
    out = data.copy()
    for c in out.columns:
        if pd.api.types.is_datetime64_any_dtype(out[c]):
            out[c] = out[c].dt.strftime("%Y-%m-%d")
        elif pd.api.types.is_float_dtype(out[c]):
            out[c] = out[c].round(4)
    out = out.replace({np.nan: None})
    payload = {
        "columns": list(out.columns),
        "rows": out.values.tolist(),
        "sampled": sampled,
        "total_rows": int(len(df)),
    }
    return charts, payload
