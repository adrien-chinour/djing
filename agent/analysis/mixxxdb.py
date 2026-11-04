"""Read-only access to the Mixxx library (SQLite): tracks, beat grids, cues."""

from __future__ import annotations

import os
import sqlite3
import struct
from dataclasses import dataclass, field

DB_PATH = os.path.expanduser("~/.mixxx/mixxxdb.sqlite")
CUE_MAIN, CUE_INTRO, CUE_OUTRO, CUE_AUDIBLE = 2, 6, 7, 8


@dataclass
class MixxxTrack:
    id: int
    path: str
    title: str
    artist: str
    bpm: float
    key_id: int | None
    key: str | None
    duration: float
    samplerate: int
    channels: int
    first_beat_s: float | None  # from BeatGrid-2.0
    cues: dict[str, tuple[float, float | None]] = field(default_factory=dict)  # name -> (start_s, end_s)


def _varint(buf: bytes, i: int) -> tuple[int, int]:
    result, shift = 0, 0
    while True:
        b = buf[i]
        i += 1
        result |= (b & 0x7F) << shift
        if not b & 0x80:
            return result, i
        shift += 7


def parse_beatgrid(blob: bytes) -> tuple[int | None, float | None]:
    """Minimal protobuf parse of Mixxx BeatGrid-2.0: (first beat frame position, bpm)."""
    frame, bpm, i = None, None, 0
    while i < len(blob):
        tag, i = _varint(blob, i)
        fnum, wtype = tag >> 3, tag & 7
        if wtype == 2:
            length, i = _varint(blob, i)
            sub = blob[i:i + length]
            i += length
            j = 0
            while j < len(sub):
                stag, j = _varint(sub, j)
                sf, st = stag >> 3, stag & 7
                # BeatGrid { Bpm bpm = 1 { double bpm = 1 }; Beat first_beat = 2 { int32 frame_position = 1 } }
                if st == 0:
                    val, j = _varint(sub, j)
                    if fnum == 2 and sf == 1:
                        frame = val
                elif st == 1:
                    if fnum == 1 and sf == 1:
                        bpm = struct.unpack("<d", sub[j:j + 8])[0]
                    j += 8
                elif st == 2:
                    ln, j = _varint(sub, j)
                    j += ln
                elif st == 5:
                    j += 4
        elif wtype == 0:
            _, i = _varint(blob, i)
        elif wtype == 1:
            i += 8
        elif wtype == 5:
            i += 4
    return frame, bpm


def load_tracks(db_path: str = DB_PATH) -> list[MixxxTrack]:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    rows = conn.execute(
        """select l.id, tl.location, l.title, l.artist, l.bpm, l.key_id, l.key, l.duration,
                  l.samplerate, l.channels, l.beats, l.beats_version
           from library l join track_locations tl on tl.id = l.location
           where l.mixxx_deleted = 0 and tl.fs_deleted = 0 order by l.id""").fetchall()
    tracks = []
    for (tid, path, title, artist, bpm, key_id, key, duration, sr, ch, beats, beats_version) in rows:
        first_beat_s = None
        if beats and beats_version and beats_version.startswith("BeatGrid"):
            frame, grid_bpm = parse_beatgrid(beats)
            if frame is not None and sr:
                first_beat_s = frame / sr
            if grid_bpm:
                bpm = grid_bpm
        track = MixxxTrack(tid, path, title or os.path.basename(path), artist or "", float(bpm or 0),
                           key_id, key, float(duration or 0), int(sr or 44100), int(ch or 2), first_beat_s)
        for ctype, position, length in conn.execute(
                "select type, position, length from cues where track_id = ?", (tid,)):
            # cue positions are stored in interleaved stereo samples
            start = position / (2 * track.samplerate) if position >= 0 else None
            end = (position + length) / (2 * track.samplerate) if length and position >= 0 else None
            name = {CUE_MAIN: "main", CUE_INTRO: "intro", CUE_OUTRO: "outro", CUE_AUDIBLE: "audible"}.get(ctype)
            if name and start is not None:
                track.cues[name] = (start, end)
        tracks.append(track)
    conn.close()
    return tracks
