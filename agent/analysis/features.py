"""Audio features on the beat grid: energy, kick presence, novelty, per beat and per bar."""

from __future__ import annotations

from dataclasses import dataclass

import librosa
import numpy as np
import soundfile as sf

SR = 22050
HOP = 512
LOW_MAX_HZ = 150.0  # kick / sub band
MID_MIN_HZ = 400.0


@dataclass
class BeatFeatures:
    beat_times: np.ndarray      # seconds, grid from Mixxx (or librosa fallback)
    rms: np.ndarray             # per beat, 0..1 normalised
    low: np.ndarray             # low-band energy per beat, 0..1
    mid_high: np.ndarray        # rest of spectrum per beat, 0..1
    onset_low: np.ndarray       # low-band onset strength at the beat, 0..1
    duration: float


def load_audio(path: str) -> tuple[np.ndarray, int]:
    y, sr = sf.read(path, dtype="float32", always_2d=True)
    y = y.mean(axis=1)
    if sr != SR:
        y = librosa.resample(y, orig_sr=sr, target_sr=SR)
    return y, SR


def beat_grid(duration: float, bpm: float, first_beat_s: float | None) -> np.ndarray:
    period = 60.0 / bpm
    start = first_beat_s if first_beat_s is not None else 0.0
    start = start - period * np.floor(start / period)  # first beat >= 0 on the grid
    return np.arange(start, duration, period)


def beat_features(y: np.ndarray, sr: int, beat_times: np.ndarray) -> BeatFeatures:
    S = np.abs(librosa.stft(y, n_fft=2048, hop_length=HOP)) ** 2
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    low_band = S[freqs <= LOW_MAX_HZ].sum(axis=0)
    mid_band = S[freqs >= MID_MIN_HZ].sum(axis=0)
    total = S.sum(axis=0)
    onset_low = librosa.onset.onset_strength(S=librosa.power_to_db(S[freqs <= LOW_MAX_HZ] + 1e-10), sr=sr, hop_length=HOP)

    frames = librosa.time_to_frames(beat_times, sr=sr, hop_length=HOP)
    frames = np.clip(frames, 0, total.shape[0] - 1)
    bounds = np.append(frames, total.shape[0])

    def per_beat(curve: np.ndarray, reducer=np.mean) -> np.ndarray:
        out = np.zeros(len(frames))
        for i in range(len(frames)):
            seg = curve[bounds[i]:max(bounds[i] + 1, bounds[i + 1])]
            out[i] = reducer(seg) if len(seg) else 0.0
        return out

    def norm(v: np.ndarray) -> np.ndarray:
        top = np.percentile(v, 98) or 1.0
        return np.clip(v / top, 0, 1)

    # onset at the beat: max over a small window around the beat frame
    onset_at_beat = np.array([onset_low[max(0, f - 1):f + 3].max() if f < len(onset_low) else 0.0 for f in frames])
    return BeatFeatures(
        beat_times=beat_times,
        rms=norm(np.sqrt(per_beat(total))),
        low=norm(np.sqrt(per_beat(low_band))),
        mid_high=norm(np.sqrt(per_beat(mid_band))),
        onset_low=norm(onset_at_beat),
        duration=len(y) / sr,
    )
