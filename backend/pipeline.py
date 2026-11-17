"""Orchestrator: runs the five agents in order and streams progress.

Each step yields a small event, so the browser can show live agent
activity while the work happens.
"""
from __future__ import annotations

import json
import time
from typing import Iterator

from backend.agents.analysis import analyze
from backend.agents.cleaning import clean
from backend.agents.report import write_report
from backend.agents.understanding import pick_primary_metric, read_csv, understand
from backend.agents.visualization import plan_charts

AGENTS = ["understand", "clean", "analyze", "visualize", "report"]


def _event(**kw) -> str:
    return json.dumps(kw, default=str) + "\n"


def run_pipeline(raw: bytes, filename: str) -> Iterator[str]:
    name = filename.rsplit(".", 1)[0].replace("_", " ").replace("-", " ").strip().title() or "Your data"
    t0 = time.time()
    try:
        # 1. Understanding
        yield _event(type="agent", agent="understand", status="running", message="Reading your file and learning its columns")
        df = read_csv(raw)
        profile = understand(df)
        numeric = profile["by_type"].get("numeric", [])
        metric = pick_primary_metric(df, numeric)
        counts = ", ".join(f"{len(v)} {k}" for k, v in profile["by_type"].items())
        yield _event(type="agent", agent="understand", status="done",
                     message=f"{profile['rows']:,} rows and {profile['columns']} columns ({counts})",
                     detail={"schema": profile["schema"], "metric": metric})

        # 2. Cleaning
        yield _event(type="agent", agent="clean", status="running", message="Fixing missing values, duplicates and messy text")
        cleaned, cleaning = clean(df, profile)
        fixes = sum(item["count"] for item in cleaning["log"])
        yield _event(type="agent", agent="clean", status="done",
                     message=f"{fixes:,} fixes applied. Quality score {cleaning['quality_score']}/100",
                     detail={"log": cleaning["log"]})

        # 3. Analysis
        yield _event(type="agent", agent="analyze", status="running", message="Finding trends, leaders and relationships")
        analysis = analyze(cleaned, profile, metric)
        yield _event(type="agent", agent="analyze", status="done",
                     message=f"{len(analysis['facts'])} key findings, {len(analysis['correlations'])} strong links",
                     detail={"facts": analysis["facts"]})

        # 4. Visualization
        yield _event(type="agent", agent="visualize", status="running", message="Choosing the best charts for your data")
        charts, data = plan_charts(cleaned, analysis)
        yield _event(type="agent", agent="visualize", status="done",
                     message=f"{len(charts)} interactive charts planned",
                     detail={"charts": [c["title"] for c in charts]})

        # 5. Report
        yield _event(type="agent", agent="report", status="running", message="Writing insights and recommendations")
        report = write_report(name, profile, cleaning, analysis)
        yield _event(type="agent", agent="report", status="done",
                     message=f"{len(report.get('insights', []))} insights and {len(report.get('recommendations', []))} recommendations ready")

        yield _event(
            type="result",
            name=name,
            seconds=round(time.time() - t0, 1),
            profile={k: profile[k] for k in ("rows", "columns", "schema", "by_type", "duplicates", "missing_cells")},
            cleaning=cleaning,
            analysis=analysis,
            charts=charts,
            data=data,
            report=report,
        )
    except ValueError as exc:
        yield _event(type="error", message=str(exc))
    except Exception:
        yield _event(type="error", message="Something went wrong while analyzing this file. Please check it is a valid CSV and try again.")
