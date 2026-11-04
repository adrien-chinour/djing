"""Camelot wheel helpers for Mixxx keys."""

# Mixxx ChromaticKey ids: 1..12 majors C, Db, D, Eb, E, F, Gb, G, Ab, A, Bb, B ; 13..24 minors Cm..Bm
_MAJOR = ["8B", "3B", "10B", "5B", "12B", "7B", "2B", "9B", "4B", "11B", "6B", "1B"]
_MINOR = ["5A", "12A", "7A", "2A", "9A", "4A", "11A", "6A", "1A", "8A", "3A", "10A"]


def camelot(key_id: int | None) -> str | None:
    if not key_id or key_id < 1 or key_id > 24:
        return None
    return _MAJOR[key_id - 1] if key_id <= 12 else _MINOR[key_id - 13]


def compatible(a: str | None, b: str | None) -> int:
    """0 = unknown, 3 = same key, 2 = neighbour or relative (classic harmonic mix), 1 = energy boost (+2), -1 = clash."""
    if not a or not b:
        return 0
    na, la = int(a[:-1]), a[-1]
    nb, lb = int(b[:-1]), b[-1]
    diff = (nb - na) % 12
    if a == b:
        return 3
    if la == lb and diff in (1, 11):
        return 2
    if la != lb and diff == 0:
        return 2
    if la == lb and diff in (2, 10):
        return 1
    return -1
