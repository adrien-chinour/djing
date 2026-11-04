"""CLI: analyse every track of the Mixxx library, write one JSON per track + an index.

    uv run python -m agent.analysis.analyze            # all tracks, skips existing JSON
    uv run python -m agent.analysis.analyze --force    # redo everything
    uv run python -m agent.analysis.analyze --limit 3  # first N tracks (quick check)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

from agent.analysis import camelot, mixxxdb
from agent.analysis.features import beat_features, beat_grid, load_audio
from agent.analysis.structure import analyse

ROOT = Path(__file__).resolve().parent.parent.parent
OUT_DIR = ROOT / "analysis"


def track_id(path: str) -> str:
    return hashlib.sha1(path.encode()).hexdigest()[:12]


def analyse_track(t: mixxxdb.MixxxTrack) -> dict:
    y, sr = load_audio(t.path)
    duration = len(y) / sr
    bpm = t.bpm if t.bpm > 0 else 0.0
    if not bpm:
        import librosa
        bpm = float(librosa.feature.tempo(y=y, sr=sr)[0])
    grid = beat_grid(duration, bpm, t.first_beat_s)
    feats = beat_features(y, sr, grid)
    structure = analyse(feats)
    return {
        "id": track_id(t.path),
        "mixxx_id": t.id,
        "path": t.path,
        "title": t.title,
        "artist": t.artist,
        "duration_s": round(duration, 3),
        "bpm": round(bpm, 3),
        "key": t.key,
        "camelot": camelot.camelot(t.key_id),
        "first_beat_s": t.first_beat_s,
        "mixxx_cues": {k: [round(v[0], 3), round(v[1], 3) if v[1] is not None else None] for k, v in t.cues.items()},
        "structure": structure.to_dict(),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()
    OUT_DIR.mkdir(exist_ok=True)
    tracks = mixxxdb.load_tracks()
    if args.limit:
        tracks = tracks[:args.limit]
    index = []
    for n, t in enumerate(tracks, 1):
        out = OUT_DIR / f"{track_id(t.path)}.json"
        if out.exists() and not args.force:
            data = json.loads(out.read_text())
        else:
            t0 = time.time()
            try:
                data = analyse_track(t)
            except Exception as exc:  # keep going on a broken file
                print(f"[{n}/{len(tracks)}] FAILED {t.title}: {exc}", file=sys.stderr)
                continue
            out.write_text(json.dumps(data, indent=1, ensure_ascii=False))
            s = data["structure"]
            print(f"[{n}/{len(tracks)}] {t.artist} - {t.title} | {data['bpm']:.0f} bpm {data['camelot']} | "
                  f"{s['bars']} bars, {len(s['sections'])} sections, in @bar {s['mix_in_bar']} out @bar {s['mix_out_bar']} "
                  f"({time.time() - t0:.1f}s)", flush=True)
        index.append({k: data[k] for k in ("id", "title", "artist", "bpm", "camelot", "duration_s", "path")}
                     | {"mix_in_s": data["structure"]["mix_in_s"], "mix_out_s": data["structure"]["mix_out_s"]})
    (OUT_DIR / "index.json").write_text(json.dumps(index, indent=1, ensure_ascii=False))
    print(f"index: {len(index)} tracks -> {OUT_DIR / 'index.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
