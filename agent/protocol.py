"""Single source of truth for the MIDI protocol between the agent and Mixxx.

Channels 1 and 2 (0-based 0 and 1) address deck A and deck B, channel 3 (index 2)
addresses the master section and the library. The same table generates the Mixxx
mapping (XML + JS lookup table) and drives the Python side, so both stay in sync.

Commands (agent -> Mixxx)
- note on, velocity 127 = press / set 1, velocity 0 = release / set 0
- CC 7-bit: 0..127 -> parameter 0..1
- CC 14-bit: MSB on controller n, LSB on controller n + 32, sent in that order

Feedback (Mixxx -> agent) uses the same encodings on the same channels.
"""

from dataclasses import dataclass

DECK_CHANNEL = {"A": 0, "B": 1}
MASTER_CHANNEL = 2
HELLO_NOTE = 0x7F  # sent by the mapping on channel 3 when it (un)loads
RESYNC_NOTE = 0x7E  # sent by the agent on channel 3: the mapping re-sends the whole state
LSB_OFFSET = 32


@dataclass(frozen=True)
class NoteCommand:
    name: str
    num: int
    key: str
    mode: str  # "set": value follows velocity; "press": momentary; "trigger": 1 then 0 on press
    group: str | None = None  # None = the deck group


@dataclass(frozen=True)
class CcCommand:
    name: str
    num: int
    key: str
    bits: int  # 7 or 14
    param: bool = True  # True: engine.setParameter 0..1 ; False: setValue(min + v * (max - min))
    group: str | None = None
    min: float = 0.0
    max: float = 1.0


@dataclass(frozen=True)
class Feedback:
    name: str
    num: int
    key: str
    kind: str  # "note", "cc7", "cc14"
    group: str | None = None
    param: bool = False  # True: send engine.getParameter 0..1
    scale: float = 1.0  # raw value * scale -> 0..127 (cc7) or 0..16383 (cc14)


DECK_NOTES = [
    NoteCommand("play", 0x01, "play", "set"),
    NoteCommand("cue", 0x02, "cue_default", "press"),
    NoteCommand("cue_play", 0x03, "cue_gotoandplay", "trigger"),
    NoteCommand("cue_stop", 0x04, "cue_gotoandstop", "trigger"),
    NoteCommand("sync", 0x05, "sync_enabled", "set"),
    NoteCommand("beatsync", 0x06, "beatsync", "trigger"),
    NoteCommand("keylock", 0x07, "keylock", "set"),
    NoteCommand("pfl", 0x08, "pfl", "set"),
    NoteCommand("load", 0x09, "LoadSelectedTrack", "trigger"),
    NoteCommand("eject", 0x0A, "eject", "trigger"),
    NoteCommand("quantize", 0x0B, "quantize", "set"),
    NoteCommand("loop", 0x0C, "beatloop_activate", "trigger"),
    NoteCommand("reloop", 0x0D, "reloop_toggle", "trigger"),
    NoteCommand("loop_halve", 0x0E, "loop_halve", "trigger"),
    NoteCommand("loop_double", 0x0F, "loop_double", "trigger"),
    *[NoteCommand(f"hotcue_{i}", 0x10 + i - 1, f"hotcue_{i}_activate", "press") for i in range(1, 9)],
    NoteCommand("beatjump_forward", 0x18, "beatjump_forward", "trigger"),
    NoteCommand("beatjump_backward", 0x19, "beatjump_backward", "trigger"),
    NoteCommand("slip", 0x1A, "slip_enabled", "set"),
]

DECK_CCS = [
    CcCommand("volume", 0x00, "volume", 14),
    CcCommand("rate", 0x01, "rate", 14),
    CcCommand("eq_high", 0x02, "parameter3", 7, group="[EqualizerRack1_{deck}_Effect1]"),
    CcCommand("eq_mid", 0x03, "parameter2", 7, group="[EqualizerRack1_{deck}_Effect1]"),
    CcCommand("eq_low", 0x04, "parameter1", 7, group="[EqualizerRack1_{deck}_Effect1]"),
    CcCommand("filter", 0x05, "super1", 14, group="[QuickEffectRack1_{deck}]"),
    CcCommand("gain", 0x06, "pregain", 7),
    CcCommand("seek", 0x07, "playposition", 14, param=False, min=0.0, max=1.0),
]

MASTER_NOTES = [
    NoteCommand("lib_up", 0x01, "MoveUp", "trigger", group="[Library]"),
    NoteCommand("lib_down", 0x02, "MoveDown", "trigger", group="[Library]"),
    NoteCommand("lib_focus", 0x03, "MoveFocusForward", "trigger", group="[Library]"),
    NoteCommand("lib_go", 0x04, "GoToItem", "trigger", group="[Library]"),
    NoteCommand("lib_sort_desc", 0x05, "sort_order", "set", group="[Library]"),  # 0 ascending, 1 descending
    NoteCommand("lib_clear_search", 0x06, "clear_search", "trigger", group="[Library]"),
    NoteCommand("autodj", 0x10, "enabled", "set", group="[AutoDJ]"),
    NoteCommand("autodj_fade", 0x11, "fade_now", "trigger", group="[AutoDJ]"),
    NoteCommand("autodj_skip", 0x12, "skip_next", "trigger", group="[AutoDJ]"),
]

MASTER_CCS = [
    CcCommand("crossfader", 0x00, "crossfader", 14, group="[Master]"),
    CcCommand("master_gain", 0x01, "gain", 7, group="[Master]"),
    # raw integer controls: 7-bit value v -> min + v/127 * (max - min)
    CcCommand("lib_move", 0x02, "MoveVertical", 7, param=False, group="[Library]", min=-64, max=63),
    CcCommand("lib_sort_column", 0x03, "sort_column", 7, param=False, group="[Library]", min=0, max=127),
    CcCommand("lib_focus_widget", 0x04, "focused_widget", 7, param=False, group="[Library]", min=0, max=127),
]

DECK_FEEDBACK = [
    Feedback("beat", 0x01, "beat_active", "note"),
    Feedback("play", 0x02, "play", "note"),
    Feedback("loaded", 0x03, "track_loaded", "note"),
    Feedback("sync", 0x04, "sync_enabled", "note"),
    Feedback("keylock", 0x05, "keylock", "note"),
    Feedback("pfl", 0x06, "pfl", "note"),
    Feedback("loop", 0x07, "loop_enabled", "note"),
    Feedback("end_of_track", 0x08, "end_of_track", "note"),
    Feedback("volume", 0x00, "volume", "cc14", param=True),
    Feedback("rate", 0x01, "rate", "cc14", param=True),
    Feedback("bpm", 0x02, "bpm", "cc14", scale=10.0),
    Feedback("position", 0x03, "playposition", "cc14", scale=16383.0),
    Feedback("duration", 0x04, "duration", "cc14", scale=1.0),
    Feedback("file_bpm", 0x05, "file_bpm", "cc14", scale=10.0),
    Feedback("filter", 0x06, "super1", "cc14", group="[QuickEffectRack1_{deck}]", param=True),
    Feedback("key", 0x07, "key", "cc7", scale=1.0),
    Feedback("vu", 0x08, "VuMeter", "cc7", scale=127.0),
    Feedback("loop_size", 0x09, "beatloop_size", "cc14", scale=1.0),
]

MASTER_FEEDBACK = [
    Feedback("crossfader", 0x00, "crossfader", "cc14", group="[Master]", param=True),
    Feedback("autodj", 0x10, "enabled", "note", group="[AutoDJ]"),
]


def deck_group(deck: str) -> str:
    return f"[Channel{DECK_CHANNEL[deck] + 1}]"


def resolve_group(template: str | None, deck: str | None) -> str:
    if template is None:
        return deck_group(deck)
    return template.replace("{deck}", deck_group(deck)) if deck else template
