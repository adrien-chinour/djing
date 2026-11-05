"""Transition log and listener ratings (analysis/transitions.jsonl)."""

from __future__ import annotations

import json
import time
from pathlib import Path

from agent.catalog import ANALYSIS_DIR

LOG = ANALYSIS_DIR / "transitions.jsonl"


def log_transition(entry: dict) -> str:
    entry = {"id": time.strftime("%Y%m%d-%H%M%S"), "ts": time.time(), **entry}
    with LOG.open("a") as f:
        f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return entry["id"]


def load() -> list[dict]:
    if not LOG.exists():
        return []
    return [json.loads(l) for l in LOG.read_text().splitlines() if l.strip()]


def rate_last(score: float, comment: str) -> dict | None:
    entries = load()
    if not entries:
        return None
    entries[-1]["rating"] = score
    entries[-1]["comment"] = comment
    LOG.write_text("".join(json.dumps(e, ensure_ascii=False) + "\n" for e in entries))
    return entries[-1]


def pattern_bias() -> dict[str, float]:
    """Mean rating per (pattern/entry) mapped to a score bonus in [-0.2, +0.2]; unrated = 0."""
    sums: dict[str, list[float]] = {}
    for e in load():
        if "rating" in e:
            sums.setdefault(f"{e['pattern']}/{e['entry']}", []).append(e["rating"])
            sums.setdefault(e["pattern"], []).append(e["rating"])
    return {k: (sum(v) / len(v) - 3) * 0.1 for k, v in sums.items()}
