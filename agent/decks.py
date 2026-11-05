"""Live view of a Mixxx deck: bridge feedback + the analysed track, with time extrapolation."""

from __future__ import annotations

import time

from agent.bridge import Bridge
from agent.catalog import Catalog, Track

FOCUS_SIDEBAR, FOCUS_TRACKS = 2, 3
SORT_TITLE = 2


class Deck:
    def __init__(self, bridge: Bridge, name: str, catalog: Catalog) -> None:
        self.bridge = bridge
        self.name = name
        self.catalog = catalog
        self.track: Track | None = None
        self._last_pos_s = 0.0
        self._last_pos_wall = time.monotonic()
        bridge.on_change(self._on_change)

    # ---- raw state ------------------------------------------------------
    def _on_change(self, scope: str, key: str, value: float) -> None:
        if scope != self.name:
            return
        if key == "position":
            self._last_pos_s = value * self.duration_s
            self._last_pos_wall = time.monotonic()

    @property
    def state(self) -> dict[str, float]:
        return self.bridge.state[self.name]

    @property
    def playing(self) -> bool:
        return self.state.get("play", 0.0) > 0.5

    @property
    def loaded(self) -> bool:
        return self.state.get("loaded", 0.0) > 0.5

    @property
    def duration_s(self) -> float:
        return self.state.get("duration", 0.0)

    @property
    def bpm(self) -> float:
        return self.state.get("bpm", 0.0)

    @property
    def file_bpm(self) -> float:
        return self.state.get("file_bpm", 0.0)

    @property
    def rate(self) -> float:
        """Playback speed relative to the file (1.0 = original tempo)."""
        return self.bpm / self.file_bpm if self.file_bpm else 1.0

    def position_s(self) -> float:
        """Current position in track seconds, extrapolated between two feedback messages."""
        pos = self._last_pos_s
        if self.playing:
            pos += (time.monotonic() - self._last_pos_wall) * self.rate
        return pos

    # ---- musical time ---------------------------------------------------
    def bar(self) -> float:
        return self.track.bar_at(self.position_s()) if self.track else 0.0

    def seconds_until_bar(self, bar: float) -> float:
        """Wall-clock seconds until the deck reaches `bar` (negative if already past)."""
        if not self.track:
            return 0.0
        return (self.track.bar_time(bar) - self.position_s()) / (self.rate or 1.0)

    def wait_for_bar(self, bar: float, lead_s: float = 0.0) -> None:
        """Block until `lead_s` before the deck reaches `bar`."""
        while True:
            remaining = self.seconds_until_bar(bar) - lead_s
            if remaining <= 0:
                return
            time.sleep(min(remaining, 0.01) if remaining < 0.2 else min(remaining - 0.15, 0.5))

    # ---- actions --------------------------------------------------------
    def identify_loaded(self) -> Track | None:
        if not self.loaded:
            return None
        key = self.state.get("file_key", self.state.get("key", 0.0))
        return self.catalog.identify(self.duration_s, self.file_bpm, round(key))

    def load(self, track: Track, attempts: int = 10, log=None) -> bool:
        """Load `track` through the visible track table, verified by what Mixxx reports afterwards.

        Uses [Playlist] selection controls, which work whatever widget has the keyboard focus
        (the [Library] ones are ignored while the Mixxx window is not active). The table must
        show the whole library ("Tracks") sorted by title: the sort is forced here, the view
        is left alone and any mismatch is corrected from what actually got loaded.
        """
        b = self.bridge
        order = self.catalog.by_title_order()
        target_idx = next(i for i, t in enumerate(order) if t.id == track.id)
        b.set("master", "lib_sort_column", SORT_TITLE / 127)
        b.note("master", "lib_sort_desc", False)
        time.sleep(0.4)
        seen: list[str | None] = []
        for attempt in range(attempts):
            before = (self.duration_s, self.file_bpm, self.loaded)
            b.press(self.name, "load")
            time.sleep(0.8)
            current = self.identify_loaded()
            if log:
                log(f"  load attempt {attempt + 1}: deck {self.name} has {current} (loaded={self.loaded}, {self.duration_s:.1f}s, {self.file_bpm:.1f} bpm)")
            if current and current.id == track.id:
                self.track = track
                return True
            seen.append(current.id if current else None)
            if current is None or (self.duration_s, self.file_bpm, self.loaded) == before:
                delta = 1  # nothing selected, unknown or ambiguous track: step down one row and look again
            elif len(seen) >= 2 and seen[-1] == seen[-2]:
                delta = 3  # stuck on the same wrong track: our view of the order is off, jump further
            else:
                delta = target_idx - next(i for i, t in enumerate(order) if t.id == current.id)
            while delta:
                step = max(-64, min(63, delta))
                b.set("master", "lib_select_track", (step + 64) / 127)
                b.set("master", "lib_select_track", 64 / 127)  # back to 0: Mixxx ignores repeated values
                delta -= step
                time.sleep(0.2)
        return False

    def seek_bar(self, bar: float) -> None:
        assert self.track
        self.bridge.set(self.name, "seek", self.track.bar_time(bar) / self.duration_s)
