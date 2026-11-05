"""Offline sanity checks, no Mixxx needed: catalog, identification, patterns on every pair."""

import itertools
import sys

from agent.catalog import Catalog
from agent.patterns import proposals


def main() -> int:
    c = Catalog()
    errors = 0
    # identification: every track must be found back from its own signature, or declared ambiguous
    for t in c.tracks:
        found = c.identify(t.duration_s, t.bpm, t.key_id or 0)
        if found is not None and found.id != t.id:
            print(f"[KO] identify({t.title}) -> {found.title}"); errors += 1
    # patterns: every proposal must be consistent
    n = 0
    for a, b in itertools.permutations(c.tracks, 2):
        for p in proposals(a, b, 0.0, a.bpm):
            n += 1
            ok = (0 <= p.b_start_bar < b.structure["bars"] and p.a_start_bar <= p.a_cut_bar <= a.structure["bars"]
                  and p.entry in ("bass", "tops", "teaser", "none") and (p.overlap > 0 or p.entry == "none"))
            if not ok:
                print(f"[KO] {p.pattern} {a.title} -> {b.title}: {p}"); errors += 1
    print(f"{len(c.tracks)} tracks, {n} plans over all pairs, {errors} errors")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
