"""Agent 1 — Understanding.

Reads the raw CSV, figures out its delimiter and encoding, and works out
what every column means: date, number, category, free text or ID.
"""
from __future__ import annotations

import csv
import io
import re

import numpy as np
import pandas as pd

ID_HINTS = re.compile(r"(^id$|_id$|\bid\b|uuid|code|number|no\.?$|#)", re.I)
METRIC_HINTS = re.compile(
    r"(revenue|sales|amount|total|profit|price|income|cost|spend|value|gmv|turnover|quantity|qty|units|sold|count)",
    re.I,
)
DATE_HINTS = re.compile(r"(date|time|day|month|year|period|timestamp|created|updated)", re.I)


def read_csv(raw: bytes) -> pd.DataFrame:
    """Decode bytes and parse a CSV with a sniffed delimiter."""
    text = None
    for enc in ("utf-8-sig", "utf-8", "cp1252", "latin-1"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if text is None or not text.strip():
        raise ValueError("The file is empty or could not be read as text.")

    sample = text[:20000]
    try:
        delimiter = csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
    except csv.Error:
        delimiter = ","
    df = pd.read_csv(io.StringIO(text), sep=delimiter, low_memory=False)
    if df.shape[1] < 2:
        raise ValueError("We found only one column. Please upload a CSV with at least two columns.")
    df.columns = [str(c).strip() or f"Column {i + 1}" for i, c in enumerate(df.columns)]
    return df


def _looks_numeric(s: pd.Series) -> float:
    cleaned = s.dropna().astype(str).str.replace(r"[,\s$€£₨%]|Rs\.?|PKR|AED|SAR", "", regex=True)
    if cleaned.empty:
        return 0.0
    return pd.to_numeric(cleaned, errors="coerce").notna().mean()


def _looks_date(s: pd.Series, name: str) -> float:
    sample = s.dropna().astype(str).head(300)
    if sample.empty:
        return 0.0
    if pd.api.types.is_numeric_dtype(s) and not DATE_HINTS.search(name):
        return 0.0
    if not sample.str.contains(r"[-/:]|\d{4}", regex=True).mean() > 0.8:
        return 0.0
    parsed = pd.to_datetime(sample, errors="coerce", format="mixed")
    return parsed.notna().mean()


def classify_column(s: pd.Series, name: str, n_rows: int) -> str:
    non_null = s.dropna()
    unique = non_null.nunique()
    if non_null.empty:
        return "empty"
    if _looks_date(s, name) > 0.85:
        return "datetime"
    numeric_share = 1.0 if pd.api.types.is_numeric_dtype(s) else _looks_numeric(s)
    if numeric_share > 0.9:
        if ID_HINTS.search(name) and unique > 0.9 * len(non_null):
            return "id"
        if unique <= 2:
            return "boolean"
        return "numeric"
    if ID_HINTS.search(name) and unique > 0.9 * len(non_null):
        return "id"
    if len(non_null) >= 5 and unique > 0.9 * len(non_null):
        return "text" if non_null.astype(str).str.len().mean() > 40 else "id"
    if unique <= max(30, int(0.05 * n_rows)) or unique / max(len(non_null), 1) < 0.2:
        return "categorical"
    avg_len = non_null.astype(str).str.len().mean()
    if avg_len > 40:
        return "text"
    return "id" if unique > 0.9 * len(non_null) else "categorical"


def understand(df: pd.DataFrame) -> dict:
    n_rows, n_cols = df.shape
    columns = []
    for name in df.columns:
        s = df[name]
        kind = classify_column(s, name, n_rows)
        columns.append(
            {
                "name": name,
                "type": kind,
                "missing": int(s.isna().sum()),
                "missing_pct": round(float(s.isna().mean() * 100), 1),
                "unique": int(s.nunique(dropna=True)),
                "example": None if s.dropna().empty else str(s.dropna().iloc[0])[:40],
            }
        )

    by_type: dict[str, list[str]] = {}
    for c in columns:
        by_type.setdefault(c["type"], []).append(c["name"])

    return {
        "rows": int(n_rows),
        "columns": int(n_cols),
        "schema": columns,
        "by_type": by_type,
        "memory_kb": round(float(df.memory_usage(deep=True).sum() / 1024), 1),
        "duplicates": int(df.duplicated().sum()),
        "missing_cells": int(df.isna().sum().sum()),
    }


def pick_primary_metric(df: pd.DataFrame, numeric_cols: list[str]) -> str | None:
    """Choose the column the business most likely cares about."""
    if not numeric_cols:
        return None
    priority = ["revenue", "sales", "amount", "total", "profit", "income", "value", "price", "units", "quantity", "sold", "count"]
    for word in priority:
        for col in numeric_cols:
            if word in col.lower():
                return col
    variances = {c: float(np.nanstd(df[c])) / (abs(float(np.nanmean(df[c]))) + 1e-9) for c in numeric_cols}
    return max(variances, key=variances.get)
