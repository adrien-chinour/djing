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
        return self.catalog.identify(self.duration_s, self.file_bpm, round(self.state.get("key", 0.0)))

    def load(self, track: Track, attempts: int = 6) -> bool:
        """Load `track` through library navigation, verified by what Mixxx reports afterwards."""
        b = self.bridge
        order = self.catalog.by_title_order()
        target_idx = next(i for i, t in enumerate(order) if t.id == track.id)
        b.set("master", "lib_focus_widget", FOCUS_SIDEBAR / 127)
        b.set("master", "lib_move", (-64 + 64) / 127)  # -64 rows: top of the sidebar = "Tracks"
        time.sleep(0.3)
        b.set("master", "lib_focus_widget", FOCUS_TRACKS / 127)
        b.set("master", "lib_sort_column", SORT_TITLE / 127)
        b.note("master", "lib_sort_desc", False)
        time.sleep(0.3)
        for attempt in range(attempts):
            before = (self.duration_s, self.file_bpm)
            b.press(self.name, "load")
            time.sleep(0.6)
            current = self.identify_loaded()
            if current and current.id == track.id:
                self.track = track
                return True
            if current is None and (self.duration_s, self.file_bpm) == before and attempt == 0:
                delta = 1  # nothing was selected: select the first row and look again
            elif current is None:
                delta = 1
            else:
                delta = target_idx - next(i for i, t in enumerate(order) if t.id == current.id)
            while delta:
                step = max(-64, min(63, delta))
                b.set("master", "lib_move", (step + 64) / 127)
                delta -= step
                time.sleep(0.15)
        return False

    def seek_bar(self, bar: float) -> None:
        assert self.track
        self.bridge.set(self.name, "seek", self.track.bar_time(bar) / self.duration_s)
