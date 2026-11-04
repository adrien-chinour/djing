"""Client side of agent.daemon: same surface as agent.bridge.Bridge, over the Unix socket."""

from __future__ import annotations

import json
import socket
import threading
import time
from collections import defaultdict
from collections.abc import Callable

from agent.daemon import SOCKET_PATH


class RemoteBridge:
    def __init__(self, path: str = SOCKET_PATH) -> None:
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            self.sock.connect(path)
        except OSError as exc:
            raise SystemExit(f"djing daemon not running ({path}): start it with 'make daemon'") from exc
        self.state: dict[str, dict[str, float]] = defaultdict(dict)
        self.mapping_loaded = False
        self._listeners: list[Callable[[str, str, float], None]] = []
        self._ready = threading.Event()
        self._lock = threading.Lock()
        threading.Thread(target=self._reader, daemon=True).start()
        self._ready.wait(2.0)

    def _reader(self) -> None:
        buf = b""
        f = self.sock.makefile("rb")
        for raw in f:
            msg = json.loads(raw)
            if msg.get("ev") == "snapshot":
                with self._lock:
                    for scope, values in msg["state"].items():
                        self.state[scope].update(values)
                self.mapping_loaded = msg["mapping_loaded"]
                self._ready.set()
            elif msg.get("ev") == "state":
                scope, name, value = msg["scope"], msg["name"], msg["value"]
                if (scope, name) == ("master", "mapping"):
                    self.mapping_loaded = value > 0.5
                with self._lock:
                    self.state[scope][name] = value
                for listener in list(self._listeners):
                    listener(scope, name, value)

    def _send(self, msg: dict) -> None:
        self.sock.sendall((json.dumps(msg) + "\n").encode())

    # Bridge API
    def note(self, scope: str, name: str, on: bool) -> None:
        self._send({"cmd": "note", "scope": scope, "name": name, "on": on})

    def press(self, scope: str, name: str, hold: float = 0.0) -> None:
        self.note(scope, name, True)
        if hold:
            time.sleep(hold)
        self.note(scope, name, False)

    def set(self, scope: str, name: str, value: float) -> None:
        self._send({"cmd": "set", "scope": scope, "name": name, "value": min(1.0, max(0.0, value))})

    def ramp(self, scope: str, name: str, start: float, end: float, seconds: float, steps: int = 200) -> None:
        dt = seconds / max(1, steps)
        for i in range(steps + 1):
            self.set(scope, name, start + (end - start) * i / steps)
            time.sleep(dt)

    def resync(self) -> None:
        self._send({"cmd": "resync"})

    def reload_protocol(self) -> None:
        """Make the daemon re-read agent/protocol.py (after 'make agent-mapping')."""
        self._send({"cmd": "reload"})

    def on_change(self, listener: Callable[[str, str, float], None]) -> None:
        self._listeners.append(listener)

    def wait_for_mapping(self, timeout: float) -> bool:
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

    def wait_for_reload(self, timeout: float) -> bool:
        """True once Mixxx (re)loads the mapping after this call: needed when the mapping
        files changed and Mixxx must pick them up (Preferences > Controllers > Apply)."""
        seen = threading.Event()
        self._listeners.append(lambda s, n, v: seen.set() if (s, n, v) == ("master", "mapping", 1.0) else None)
        return seen.wait(timeout)

    def close(self) -> None:
        self.sock.close()
