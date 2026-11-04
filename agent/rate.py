"""Rate the last transition: uv run python -m agent.rate 4 "parfait mais amorce inutile" """

import sys

from agent import feedback


def main() -> int:
    if len(sys.argv) < 2 or not sys.argv[1].isdigit():
        print(__doc__); return 2
    e = feedback.rate_last(int(sys.argv[1]), " ".join(sys.argv[2:]))
    if not e:
        print("no transition logged yet"); return 1
    print(f"rated {e['rating']}/5: {e['a']} -> {e['b']} [{e['pattern']}/{e['entry']}] {e.get('comment', '')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
