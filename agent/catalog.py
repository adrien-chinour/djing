"""The analysed library (analysis/*.json) with lookups used by the mixer."""

from __future__ import annotations

import json
import locale
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ANALYSIS_DIR = ROOT / "analysis"


@dataclass
class Track:
    id: str
    title: str
    artist: str
    bpm: float
    key_id: int | None
    camelot: str | None
    duration_s: float
    path: str
    structure: dict

    @property
    def bar_s(self) -> float:
        return self.structure["bar_s"]

    @property
    def first_downbeat_s(self) -> float:
        return self.structure["first_downbeat_s"]

    def bar_time(self, bar: float) -> float:
        return self.first_downbeat_s + bar * self.bar_s

    def bar_at(self, t: float) -> float:
        return (t - self.first_downbeat_s) / self.bar_s if self.bar_s else 0.0

    def phrase_start_at_or_after(self, bar: float, phrase_bars: int = 8) -> int:
        off = self.structure["phrase_offset_bars"]
        rel = (bar - off) % phrase_bars
        return int(round(bar + (phrase_bars - rel) % phrase_bars)) if rel else int(round(bar))

    def signature(self) -> tuple[int, int, int]:
        return round(self.duration_s), round(self.bpm * 10), self.key_id or 0

    def __str__(self) -> str:
        return f"{self.artist} - {self.title} ({self.bpm:.0f} bpm, {self.camelot})"


class Catalog:
    def __init__(self, analysis_dir: Path = ANALYSIS_DIR) -> None:
        self.tracks: list[Track] = []
        for f in sorted(analysis_dir.glob("*.json")):
            if f.name == "index.json":
                continue
            d = json.loads(f.read_text())
            self.tracks.append(Track(d["id"], d["title"], d["artist"], d["bpm"], d.get("key_id"), d.get("camelot"),
                                     d["duration_s"], d["path"], d["structure"]))
        if not self.tracks:
            raise SystemExit("no analysis found: run 'make analyze' first")

    def find(self, text: str) -> Track:
        text = text.lower()
        hits = [t for t in self.tracks if text in t.title.lower() or text in f"{t.artist} {t.title}".lower()]
        if len(hits) != 1:
            raise SystemExit(f"'{text}' matches {len(hits)} tracks: {[t.title for t in hits]}")
        return hits[0]

    def by_title_order(self) -> list[Track]:
        """Tracks in the order Mixxx shows them when sorted by title (locale aware, ascending)."""
        try:
            locale.setlocale(locale.LC_COLLATE, "")
        except locale.Error:
            pass
        return sorted(self.tracks, key=lambda t: locale.strxfrm(t.title.lower()))

    def identify(self, duration_s: float, file_bpm: float, key_id: int, tolerance_s: float = 1.5) -> Track | None:
        """Which track matches what Mixxx reports for a deck."""
        best, best_score = None, 1e9
        for t in self.tracks:
            if abs(t.duration_s - duration_s) > tolerance_s:
                continue
            score = abs(t.duration_s - duration_s) + (0 if abs(t.bpm - file_bpm) < 0.6 else 5) + (0 if (t.key_id or 0) == key_id else 2)
            if score < best_score:
                best, best_score = t, score
        return best
