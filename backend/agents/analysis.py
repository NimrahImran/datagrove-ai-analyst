"""Agent 3 — Analysis.

Finds the story in the data: key totals, trends over time, which groups
lead, how columns relate, and a short forecast.
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def _r(x, n=2):
    try:
        if x is None or (isinstance(x, float) and np.isnan(x)):
            return None
        return round(float(x), n)
    except (TypeError, ValueError):
        return None


def holt_forecast(values: np.ndarray, horizon: int = 3) -> dict:
    """Holt's linear trend method with a small grid search.

    Returns point forecasts and an approximate 80% band.
    """
    y = np.asarray(values, dtype=float)
    if len(y) < 4:
        return {"forecast": [], "lower": [], "upper": []}
    best = None
    for a in (0.2, 0.35, 0.5, 0.65, 0.8):
        for b in (0.05, 0.15, 0.3):
            level, trend = y[0], y[1] - y[0]
            sse, fitted = 0.0, []
            for t in range(1, len(y)):
                pred = level + trend
                fitted.append(pred)
                sse += (y[t] - pred) ** 2
                new_level = a * y[t] + (1 - a) * (level + trend)
                trend = b * (new_level - level) + (1 - b) * trend
                level = new_level
            if best is None or sse < best[0]:
                best = (sse, level, trend, np.array(fitted))
    sse, level, trend, fitted = best
    resid_sd = float(np.std(y[1:] - fitted)) if len(fitted) > 1 else 0.0
    fc, lo, hi = [], [], []
    for h in range(1, horizon + 1):
        p = max(level + h * trend, 0.0) if y.min() >= 0 else level + h * trend
        band = 1.28 * resid_sd * np.sqrt(h)
        fc.append(p)
        lo.append(max(p - band, 0.0) if y.min() >= 0 else p - band)
        hi.append(p + band)
    return {"forecast": fc, "lower": lo, "upper": hi}


def _pick_freq(dates: pd.Series) -> tuple[str, str]:
    """Pick the finest period that still has enough rows in each period."""
    span = max((dates.max() - dates.min()).days, 1)
    rows = len(dates)
    if span > 540 or rows / (span / 30.4) < 2:
        return "MS", "month"
    if span > 120 or rows / span < 1.5:
        return "W-MON", "week"
    return "D", "day"


def analyze(df: pd.DataFrame, profile: dict, metric: str | None) -> dict:
    by_type = profile["by_type"]
    numeric = [c for c in by_type.get("numeric", []) if c in df.columns]
    cats = [
        c for c in by_type.get("categorical", [])
        if c in df.columns and 2 <= df[c].nunique() <= 60
    ]
    cats.sort(key=lambda c: (df[c].nunique() < 4, df[c].nunique()))
    dates = [c for c in by_type.get("datetime", []) if c in df.columns and df[c].notna().sum() > 3]
    date_col = dates[0] if dates else None

    result: dict = {"metric": metric, "date_col": date_col, "categories": cats[:4], "numeric": numeric[:8]}
    facts: list[str] = []

    # KPIs
    kpis = [{"label": "Rows analyzed", "value": int(len(df)), "format": "int"}]
    if metric:
        total, avg = float(df[metric].sum()), float(df[metric].mean())
        kpis.append({"label": f"Total {metric}", "value": _r(total), "format": "num"})
        kpis.append({"label": f"Average {metric}", "value": _r(avg), "format": "num"})
        facts.append(f"Total {metric} is {total:,.2f} across {len(df):,} rows (average {avg:,.2f}).")
    if date_col:
        d = df[date_col].dropna()
        kpis.append({"label": "Time span", "value": f"{d.min():%b %Y} – {d.max():%b %Y}", "format": "text"})
    elif cats:
        kpis.append({"label": f"Unique {cats[0]}", "value": int(df[cats[0]].nunique()), "format": "int"})
    result["kpis"] = kpis[:4]

    # Trend + forecast
    if date_col and metric:
        freq, unit = _pick_freq(df[date_col].dropna())
        series = df.dropna(subset=[date_col]).set_index(date_col)[metric].resample(freq).sum()
        if len(series) > 2:
            # drop a trailing partial period so the trend is not misleading
            last_date = df[date_col].max()
            if unit == "month" and last_date.day < 25:
                series = series.iloc[:-1]
            fc = holt_forecast(series.values, horizon=3)
            first, last = float(series.iloc[0]), float(series.iloc[-1])
            prev = float(series.iloc[-2]) if len(series) > 1 else last
            change = (last - prev) / abs(prev) * 100 if prev else 0.0
            overall = (last - first) / abs(first) * 100 if first else 0.0
            best_i, worst_i = int(series.values.argmax()), int(series.values.argmin())
            result["trend"] = {
                "unit": unit,
                "last_change_pct": _r(change, 1),
                "overall_change_pct": _r(overall, 1),
                "best_period": series.index[best_i].strftime("%b %Y" if unit == "month" else "%d %b %Y"),
                "best_value": _r(series.iloc[best_i]),
                "worst_period": series.index[worst_i].strftime("%b %Y" if unit == "month" else "%d %b %Y"),
                "worst_value": _r(series.iloc[worst_i]),
                "forecast_next": [_r(v) for v in fc["forecast"]],
            }
            facts.append(
                f"{metric} per {unit} changed {change:+.1f}% in the latest {unit} and {overall:+.1f}% from the first to the latest {unit}."
            )
            fmt_d = "%b %Y" if unit == "month" else "%d %b %Y"
            facts.append(f"Best {unit}: {series.index[best_i].strftime(fmt_d)} ({series.iloc[best_i]:,.0f}); weakest: {series.index[worst_i].strftime(fmt_d)} ({series.iloc[worst_i]:,.0f}).")
            if fc["forecast"]:
                facts.append(f"Forecast for the next 3 {unit}s: " + ", ".join(f"{v:,.0f}" for v in fc["forecast"]) + ".")

    # Category breakdowns
    breakdowns = []
    for c in cats[:3]:
        if metric:
            g = df.groupby(c)[metric].sum().sort_values(ascending=False)
        else:
            g = df[c].value_counts()
        share = float(g.iloc[0] / g.sum() * 100) if g.sum() else 0
        breakdowns.append({
            "column": c,
            "top": str(g.index[0]),
            "top_share_pct": _r(share, 1),
            "bottom": str(g.index[-1]),
            "values": {str(k): _r(v) for k, v in g.head(10).items()},
        })
        label = metric or "rows"
        facts.append(f"By {c}, '{g.index[0]}' leads with {share:.1f}% of {label}; '{g.index[-1]}' is lowest.")
    result["breakdowns"] = breakdowns

    # Correlations
    corr_pairs = []
    if len(numeric) >= 2:
        cm = df[numeric[:8]].corr(numeric_only=True)
        for i, a in enumerate(cm.columns):
            for b in cm.columns[i + 1:]:
                v = cm.loc[a, b]
                if pd.notna(v) and abs(v) >= 0.3:
                    corr_pairs.append({"a": a, "b": b, "r": _r(v)})
        corr_pairs.sort(key=lambda p: -abs(p["r"]))
        for p in corr_pairs[:3]:
            word = "rise together" if p["r"] > 0 else "move in opposite directions"
            facts.append(f"{p['a']} and {p['b']} {word} (correlation {p['r']}).")
    result["correlations"] = corr_pairs[:6]

    # Distributions
    dist = {}
    for c in numeric[:6]:
        s = df[c].dropna()
        if s.empty:
            continue
        dist[c] = {
            "mean": _r(s.mean()), "median": _r(s.median()), "std": _r(s.std()),
            "min": _r(s.min()), "max": _r(s.max()), "skew": _r(s.skew()),
        }
    result["distributions"] = dist
    result["facts"] = facts
    return result
