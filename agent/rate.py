"""Rate the last transition (1 to 5, halves allowed): uv run python -m agent.rate 3.5 "amorce inutile" """

import sys

from agent import feedback


def main() -> int:
    try:
        score = float(sys.argv[1].replace(",", "."))
    except (IndexError, ValueError):
        print(__doc__); return 2
    if not 1 <= score <= 5:
        print(__doc__); return 2
    e = feedback.rate_last(score, " ".join(sys.argv[2:]))
    if not e:
        print("no transition logged yet"); return 1
    print(f"rated {e['rating']}/5: {e['a']} -> {e['b']} [{e['pattern']}/{e['entry']}] {e.get('comment', '')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
