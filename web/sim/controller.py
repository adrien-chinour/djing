"""Simulated Hercules DJControl Inpulse 300 MK2 (MIDI side).

Opens an ALSA virtual port pair whose name contains "Inpulse", so web/midi.js binds to it like the
real controller. Reads one command per line on stdin, prints one JSON object per line on stdout:
{"ready": ...} at start, {"led": [status, number, value]} for every message the page sends back.

Commands (deck is A or B, values in 0..1 unless stated):
  press A play|cue|pfl        button down then up
  hold A play|cue|pfl on|off  button down or up only
  touch A on|off              jog wheel touch
  knob A volume|filter|low|mid|high|gain 0.8
  rate A -1..1                pitch fader, sent as 14-bit MSB + LSB
  jog A <ticks> [touched]     ticks signed, one message per tick
  xfader 0.2                  crossfader
  note 91 07 7f               note message: hex status, number, value
  cc b1 00 40                 control change: hex status, number, value
  pad A hotcue 1 [shift]      performance pad down then up; modes: hotcue, roll, slicer,
                              sampler, toneplay, fx, slicerloop, beatjump; pads 1..8
  raw 91 07 7f                any message, hex bytes
  leds                        print the last value of every LED received
  quit
"""

from __future__ import annotations

import json
import sys
import time

import rtmidi

PORT_NAME = "DJControl Inpulse 300 Mk2 (simulation)"

NOTE_STATUS = {"A": 0x91, "B": 0x92}
CC_STATUS = {"A": 0xB1, "B": 0xB2}
NOTES = {"play": 0x07, "cue": 0x06, "pfl": 0x0C, "touch": 0x08}
KNOBS = {"volume": 0x00, "filter": 0x01, "low": 0x02, "mid": 0x03, "high": 0x04, "gain": 0x05}
# Performance pads (mixxx/controllers/Hercules_DJControl_Inpulse_300_MK2.midi.xml): one status per
# deck, a base number per pad mode, pads 1..8 from there, +8 with SHIFT.
PAD_STATUS = {"A": 0x96, "B": 0x97}
PAD_MODES = {
    "hotcue": 0x00,
    "roll": 0x10,
    "slicer": 0x20,
    "sampler": 0x30,
    "toneplay": 0x40,
    "fx": 0x50,
    "slicerloop": 0x60,
    "beatjump": 0x70,
}


def to7(value: float) -> int:
    return round(min(1.0, max(0.0, value)) * 127)


class SimController:
    def __init__(self, name: str = PORT_NAME) -> None:
        self.out = rtmidi.MidiOut(rtmidi.API_LINUX_ALSA, name=name)
        self.out.open_virtual_port(name)
        self.inp = rtmidi.MidiIn(rtmidi.API_LINUX_ALSA, name=name)
        self.inp.open_virtual_port(name)
        self.leds: dict[str, int] = {}
        self.inp.set_callback(self._on_message)

    def _on_message(self, event, _data=None) -> None:
        msg, _delta = event
        self.leds[" ".join(f"{b:02x}" for b in msg[:2])] = msg[2] if len(msg) > 2 else 0
        emit({"led": list(msg)})

    def send(self, *data: int) -> None:
        self.out.send_message(list(data))

    def hold(self, deck: str, button: str, down: bool) -> None:
        self.send(NOTE_STATUS[deck], NOTES[button], 0x7F if down else 0x00)

    def press(self, deck: str, button: str) -> None:
        self.hold(deck, button, True)
        time.sleep(0.02)
        self.hold(deck, button, False)

    def pad(self, deck: str, mode: str, pad: int, shift: bool = False) -> None:
        if not 1 <= pad <= 8:
            raise ValueError(f"pad must be 1..8, got {pad}")
        number = PAD_MODES[mode] + pad - 1 + (8 if shift else 0)
        self.send(PAD_STATUS[deck], number, 0x7F)
        time.sleep(0.02)
        self.send(PAD_STATUS[deck], number, 0x00)

    def knob(self, deck: str, name: str, value: float) -> None:
        self.send(CC_STATUS[deck], KNOBS[name], to7(value))

    def rate(self, deck: str, value: float) -> None:
        raw14 = round((min(1.0, max(-1.0, value)) + 1) * 8191.5)
        raw14 = min(16383, raw14)
        self.send(CC_STATUS[deck], 0x08, raw14 >> 7)
        self.send(CC_STATUS[deck], 0x28, raw14 & 0x7F)

    def jog(self, deck: str, ticks: int, touched: bool = False) -> None:
        number = 0x0A if touched else 0x09
        for _ in range(abs(ticks)):
            self.send(CC_STATUS[deck], number, 0x01 if ticks > 0 else 0x7F)
            time.sleep(0.002)

    def xfader(self, value: float) -> None:
        self.send(0xB0, 0x00, to7(value))

    def run(self, line: str) -> bool:
        words = line.split()
        if not words:
            return True
        cmd, args = words[0], words[1:]
        if cmd == "quit":
            return False
        if cmd == "press":
            self.press(args[0], args[1])
        elif cmd == "hold":
            self.hold(args[0], args[1], args[2] == "on")
        elif cmd == "touch":
            self.hold(args[0], "touch", args[1] == "on")
        elif cmd == "knob":
            self.knob(args[0], args[1], float(args[2]))
        elif cmd == "rate":
            self.rate(args[0], float(args[1]))
        elif cmd == "jog":
            self.jog(args[0], int(args[1]), len(args) > 2 and args[2] == "touched")
        elif cmd == "xfader":
            self.xfader(float(args[0]))
        elif cmd in ("note", "cc"):
            if len(args) != 3:
                raise ValueError(f"{cmd} takes status, number and value")
            status = int(args[0], 16)
            if status >> 4 != (0x9 if cmd == "note" else 0xB):
                raise ValueError(f"status {args[0]} is not a {cmd} status")
            self.send(status, int(args[1], 16), int(args[2], 16))
        elif cmd == "pad":
            if len(args) > 3 and args[3] != "shift":
                raise ValueError(f"unexpected argument: {args[3]}")
            self.pad(args[0], args[1], int(args[2]), len(args) > 3)
        elif cmd == "raw":
            self.send(*(int(b, 16) for b in args))
        elif cmd == "leds":
            emit({"leds": self.leds})
        else:
            emit({"error": f"unknown command: {cmd}"})
            return True
        emit({"ok": line.strip()})
        return True


def emit(obj: dict) -> None:
    print(json.dumps(obj), flush=True)


def main() -> None:
    sim = SimController()
    emit({"ready": PORT_NAME})
    for line in sys.stdin:
        try:
            if not sim.run(line):
                break
        except (IndexError, KeyError, ValueError) as err:
            emit({"error": f"{line.strip()}: {err!r}"})


if __name__ == "__main__":
    main()
