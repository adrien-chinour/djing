"""Virtual MIDI bridge to Mixxx.

Creates an ALSA virtual port pair named "djing-agent" (input + output, paired by
Mixxx under that name), sends commands from agent/protocol.py and keeps a live copy of
the state Mixxx streams back. Mixxx only scans MIDI devices at startup and when the
Controllers preferences page opens, so start the bridge first.
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict
from collections.abc import Callable

import rtmidi

from agent import protocol as p

PORT_NAME = "djing-agent"

_DECK_NOTES: dict[str, p.NoteCommand] = {}
_DECK_CCS: dict[str, p.CcCommand] = {}
_MASTER_NOTES: dict[str, p.NoteCommand] = {}
_MASTER_CCS: dict[str, p.CcCommand] = {}
_FEEDBACK_BY_MSG: dict[tuple[str, int, int], p.Feedback] = {}


def build_tables() -> None:
    """(Re)build the lookup tables from agent.protocol; called at import and on reload."""
    _DECK_NOTES.clear(); _DECK_NOTES.update({c.name: c for c in p.DECK_NOTES})
    _DECK_CCS.clear(); _DECK_CCS.update({c.name: c for c in p.DECK_CCS})
    _MASTER_NOTES.clear(); _MASTER_NOTES.update({c.name: c for c in p.MASTER_NOTES})
    _MASTER_CCS.clear(); _MASTER_CCS.update({c.name: c for c in p.MASTER_CCS})
    _FEEDBACK_BY_MSG.clear()
    for _deck, _ch in p.DECK_CHANNEL.items():
        for _fb in p.DECK_FEEDBACK:
            _FEEDBACK_BY_MSG[("note" if _fb.kind == "note" else "cc", _ch, _fb.num)] = _fb
    for _fb in p.MASTER_FEEDBACK:
        _FEEDBACK_BY_MSG[("note" if _fb.kind == "note" else "cc", p.MASTER_CHANNEL, _fb.num)] = _fb


build_tables()


class Bridge:
    def __init__(self, name: str = PORT_NAME) -> None:
        self.midi_in = rtmidi.MidiIn(rtmidi.API_LINUX_ALSA, name=name)
        self.midi_in.open_virtual_port(name)
        self.midi_out = rtmidi.MidiOut(rtmidi.API_LINUX_ALSA, name=name)
        self.midi_out.open_virtual_port(name)
        # state[scope][name]: scope is "A", "B" or "master"
        self.state: dict[str, dict[str, float]] = defaultdict(dict)
        self.mapping_loaded = False
        self._pending_msb: dict[tuple[int, int], int] = {}
        self._listeners: list[Callable[[str, str, float], None]] = []
        self._lock = threading.Lock()
        self.midi_in.ignore_types(sysex=True, timing=True, active_sense=True)
        self.midi_in.set_callback(self._on_message)

    # ---- commands -------------------------------------------------------

    def _send(self, data: list[int]) -> None:
        self.midi_out.send_message(data)

    def note(self, scope: str, name: str, on: bool) -> None:
        cmd, ch = self._note_cmd(scope, name)
        self._send([0x90 | ch, cmd.num, 0x7F if on else 0x00])

    def press(self, scope: str, name: str, hold: float = 0.0) -> None:
        """Press then release (momentary and trigger commands)."""
        self.note(scope, name, True)
        if hold:
            time.sleep(hold)
        self.note(scope, name, False)

    def set(self, scope: str, name: str, value: float) -> None:
        """Set a continuous control; value in 0..1 (center is 0.5 for rate, EQ, crossfader)."""
        cmd, ch = self._cc_cmd(scope, name)
        value = min(1.0, max(0.0, value))
        if cmd.bits == 14:
            n = round(value * 16383)
            self._send([0xB0 | ch, cmd.num, n >> 7])
            self._send([0xB0 | ch, cmd.num + p.LSB_OFFSET, n & 0x7F])
        else:
            self._send([0xB0 | ch, cmd.num, round(value * 127)])

    def ramp(self, scope: str, name: str, start: float, end: float, seconds: float, steps: int = 200) -> None:
        """Move a continuous control linearly from start to end over `seconds`."""
        dt = seconds / max(1, steps)
        for i in range(steps + 1):
            self.set(scope, name, start + (end - start) * i / steps)
            time.sleep(dt)

    @staticmethod
    def _note_cmd(scope: str, name: str) -> tuple[p.NoteCommand, int]:
        if scope == "master":
            return _MASTER_NOTES[name], p.MASTER_CHANNEL
        return _DECK_NOTES[name], p.DECK_CHANNEL[scope]

    @staticmethod
    def _cc_cmd(scope: str, name: str) -> tuple[p.CcCommand, int]:
        if scope == "master":
            return _MASTER_CCS[name], p.MASTER_CHANNEL
        return _DECK_CCS[name], p.DECK_CHANNEL[scope]

    # ---- feedback -------------------------------------------------------

    def on_change(self, listener: Callable[[str, str, float], None]) -> None:
        """listener(scope, name, value) is called from the MIDI thread on every update."""
        self._listeners.append(listener)

    def resync(self) -> None:
        """Ask the mapping to resend the whole state (and a hello)."""
        self._send([0x90 | p.MASTER_CHANNEL, p.RESYNC_NOTE, 0x7F])

    def wait_for_mapping(self, timeout: float) -> bool:
        """True once the mapping answered; asks for a resync every 2 s in case Mixxx was already up."""
        deadline = time.monotonic() + timeout
        next_ping = 0.0
        while time.monotonic() < deadline:
            if self.mapping_loaded:
                return True
            if time.monotonic() >= next_ping:
                self.resync()
                next_ping = time.monotonic() + 2.0
            time.sleep(0.1)
        return False

    def _on_message(self, event, _data=None) -> None:
        data, _delta = event
        if len(data) < 3:
            return
        status, d1, d2 = data[0], data[1], data[2]
        kind, ch = status & 0xF0, status & 0x0F
        if kind in (0x90, 0x80):
            if ch == p.MASTER_CHANNEL and d1 == p.HELLO_NOTE:
                self.mapping_loaded = kind == 0x90 and d2 > 0
                self._emit("master", "mapping", 1.0 if self.mapping_loaded else 0.0)
                return
            fb = _FEEDBACK_BY_MSG.get(("note", ch, d1))
            if fb:
                self._emit(self._scope(ch), fb.name, 1.0 if (kind == 0x90 and d2 > 0) else 0.0)
        elif kind == 0xB0:
            if d1 >= p.LSB_OFFSET and d1 < 2 * p.LSB_OFFSET:
                msb = self._pending_msb.pop((ch, d1 - p.LSB_OFFSET), None)
                fb = _FEEDBACK_BY_MSG.get(("cc", ch, d1 - p.LSB_OFFSET))
                if msb is None or fb is None:
                    return
                raw = (msb << 7) | d2
                self._emit(self._scope(ch), fb.name, raw / 16383 if fb.param else raw / fb.scale)
            else:
                fb = _FEEDBACK_BY_MSG.get(("cc", ch, d1))
                if fb is None:
                    return
                if fb.kind == "cc14":
                    self._pending_msb[(ch, d1)] = d2
                else:
                    self._emit(self._scope(ch), fb.name, d2 / 127 if fb.param else d2 / fb.scale)

    @staticmethod
    def _scope(ch: int) -> str:
        if ch == p.MASTER_CHANNEL:
            return "master"
        return next(d for d, c in p.DECK_CHANNEL.items() if c == ch)

    def _emit(self, scope: str, name: str, value: float) -> None:
        with self._lock:
            self.state[scope][name] = value
        for listener in self._listeners:
            listener(scope, name, value)

    def close(self) -> None:
        self.midi_in.close_port()
        self.midi_out.close_port()
