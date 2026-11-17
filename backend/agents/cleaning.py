"""Agent 2 — Cleaning.

Fixes the everyday problems in real CSVs and keeps a plain-language log of
every change, plus a 0–100 data quality score.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

CURRENCY = r"[,\s$€£₨%]|Rs\.?|PKR|AED|SAR"


def clean(df: pd.DataFrame, profile: dict) -> tuple[pd.DataFrame, dict]:
    log: list[dict] = []
    df = df.copy()
    start_rows, start_cols = df.shape
    types = {c["name"]: c["type"] for c in profile["schema"]}

    # 1. Empty rows and columns
    empty_cols = [c for c in df.columns if df[c].isna().all()]
    if empty_cols:
        df = df.drop(columns=empty_cols)
        log.append({"action": "Removed empty columns", "detail": ", ".join(empty_cols), "count": len(empty_cols)})
    before = len(df)
    df = df.dropna(how="all")
    if before - len(df):
        log.append({"action": "Removed empty rows", "detail": "Rows with no values at all", "count": before - len(df)})

    # 2. Tidy text: trim spaces and fix inconsistent capitalisation
    fixed_text = 0
    for col in df.columns:
        if types.get(col) == "categorical" and not pd.api.types.is_numeric_dtype(df[col]):
            original = df[col].astype("string")
            stripped = original.str.strip()
            counts = stripped.value_counts()
            canon: dict[str, str] = {}
            for value in counts.index:  # most frequent spelling wins
                canon.setdefault(value.lower(), value)
            df[col] = stripped.map(lambda v: canon.get(v.lower(), v) if isinstance(v, str) else v)
            fixed_text += int((original != df[col].astype("string")).fillna(False).sum())
    if fixed_text:
        log.append({"action": "Standardised text values", "detail": "Trimmed spaces and unified capitalisation", "count": fixed_text})

    # 3. Duplicates
    dups = int(df.duplicated().sum())
    if dups:
        df = df.drop_duplicates()
        log.append({"action": "Removed duplicate rows", "detail": "Exact copies of other rows", "count": dups})

    # 4. Convert number-like text and dates
    for col in df.columns:
        kind = types.get(col)
        if kind in ("numeric", "boolean") and not pd.api.types.is_numeric_dtype(df[col]):
            df[col] = pd.to_numeric(df[col].astype(str).str.replace(CURRENCY, "", regex=True), errors="coerce")
            log.append({"action": "Converted text to numbers", "detail": col, "count": 1})
        elif kind == "datetime":
            df[col] = pd.to_datetime(df[col], errors="coerce", format="mixed")
            bad = int(df[col].isna().sum())
            if bad:
                log.append({"action": "Unreadable dates set aside", "detail": col, "count": bad})

    # 5. Missing values
    filled = 0
    for col in df.columns:
        miss = int(df[col].isna().sum())
        if not miss:
            continue
        kind = types.get(col)
        if kind == "numeric":
            df[col] = df[col].fillna(df[col].median())
            log.append({"action": "Filled missing numbers with the median", "detail": col, "count": miss})
            filled += miss
        elif kind in ("categorical", "boolean"):
            df[col] = df[col].fillna("Unknown")
            log.append({"action": "Labelled missing categories as Unknown", "detail": col, "count": miss})
            filled += miss

    # 6. Outliers (flagged, not removed, so nothing real gets deleted)
    outliers = {}
    for col in df.select_dtypes(include=[np.number]).columns:
        if types.get(col) != "numeric":
            continue
        q1, q3 = df[col].quantile([0.25, 0.75])
        iqr = q3 - q1
        if iqr <= 0:
            continue
        n = int(((df[col] < q1 - 3 * iqr) | (df[col] > q3 + 3 * iqr)).sum())
        if n:
            outliers[col] = n
    if outliers:
        log.append({
            "action": "Flagged extreme values (kept in data)",
            "detail": ", ".join(f"{k}: {v}" for k, v in outliers.items()),
            "count": sum(outliers.values()),
        })

    # Quality score
    total_cells = max(start_rows * start_cols, 1)
    missing_share = profile["missing_cells"] / total_cells
    dup_share = profile["duplicates"] / max(start_rows, 1)
    out_share = sum(outliers.values()) / max(len(df) * max(len(outliers), 1), 1)
    score = 100 - missing_share * 120 - dup_share * 150 - out_share * 40 - min(fixed_text / max(start_rows, 1), 0.2) * 30
    score = int(max(35, min(100, round(score))))

    return df, {
        "log": log,
        "rows_before": int(start_rows),
        "rows_after": int(len(df)),
        "quality_score": score,
        "outliers": outliers,
        "missing_filled": filled,
    }
