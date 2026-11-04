"""Owns the virtual MIDI port for good and serves it over a Unix socket.

Mixxx binds to a MIDI device when it scans (startup or Controllers preferences); a port
that disappears leaves it with a dead handle. So the port must belong to a long-lived
process: this daemon. Tools (mix, audition, demo) connect to the socket through
agent.remote.RemoteBridge, which mirrors the Bridge API.

Protocol, JSON lines both ways:
  client -> daemon : {"cmd": "note", "scope": "B", "name": "play", "on": true}
                     {"cmd": "set", "scope": "A", "name": "volume", "value": 0.8}
                     {"cmd": "resync"}
  daemon -> client : {"ev": "state", "scope": "A", "name": "bpm", "value": 160.0}
                     {"ev": "snapshot", "state": {...}, "mapping_loaded": true}  (on connect)
"""

from __future__ import annotations

import importlib
import json
import os
import signal
import socket
import sys
import threading
import time

from agent import bridge as bridge_module
from agent import protocol
from agent.bridge import Bridge

SOCKET_PATH = os.environ.get("DJING_SOCKET", "/tmp/djing-agent.sock")


class Daemon:
    def __init__(self) -> None:
        self.bridge = Bridge()
        self.clients: list[socket.socket] = []
        self.lock = threading.Lock()
        self.bridge.on_change(self._broadcast)

    def _broadcast(self, scope: str, name: str, value: float) -> None:
        line = (json.dumps({"ev": "state", "scope": scope, "name": name, "value": value}) + "\n").encode()
        with self.lock:
            dead = []
            for c in self.clients:
                try:
                    c.sendall(line)
                except OSError:
                    dead.append(c)
            for c in dead:
                self.clients.remove(c)

    def _serve_client(self, conn: socket.socket) -> None:
        with self.lock:
            snapshot = {k: dict(v) for k, v in self.bridge.state.items()}
            conn.sendall((json.dumps({"ev": "snapshot", "state": snapshot,
                                      "mapping_loaded": self.bridge.mapping_loaded}) + "\n").encode())
            self.clients.append(conn)
        buf = b""
        try:
            while True:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if line.strip():
                        self._handle(json.loads(line))
        except (OSError, json.JSONDecodeError):
            pass
        finally:
            with self.lock:
                if conn in self.clients:
                    self.clients.remove(conn)
            conn.close()

    def _handle(self, msg: dict) -> None:
        cmd = msg.get("cmd")
        try:
            if cmd == "note":
                self.bridge.note(msg["scope"], msg["name"], bool(msg["on"]))
            elif cmd == "set":
                self.bridge.set(msg["scope"], msg["name"], float(msg["value"]))
            elif cmd == "resync":
                self.bridge.resync()
            elif cmd == "reload":
                # protocol changed on disk (new commands): rebuild tables without losing the port
                importlib.reload(protocol)
                bridge_module.build_tables()
                print(time.strftime("%H:%M:%S"), "protocol reloaded", flush=True)
        except Exception as exc:  # a bad command must not kill the client connection
            print(time.strftime("%H:%M:%S"), f"command error {msg}: {exc!r}", flush=True)

    def run(self) -> None:
        if os.path.exists(SOCKET_PATH):
            os.unlink(SOCKET_PATH)
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(SOCKET_PATH)
        server.listen(8)
        print(f"djing daemon: MIDI port 'djing-agent' up, socket {SOCKET_PATH}", flush=True)

        def shutdown(*_):
            print("djing daemon: stopping", flush=True)
            server.close()
            self.bridge.close()
            if os.path.exists(SOCKET_PATH):
                os.unlink(SOCKET_PATH)
            sys.exit(0)
        signal.signal(signal.SIGTERM, shutdown)
        signal.signal(signal.SIGINT, shutdown)

        def heartbeat():
            while True:
                time.sleep(2.0)
                if not self.bridge.mapping_loaded:
                    self.bridge.resync()
        threading.Thread(target=heartbeat, daemon=True).start()
        self.bridge.on_change(lambda s, n, v: print(time.strftime("%H:%M:%S"), f"mapping {'loaded' if v else 'unloaded'}", flush=True)
                              if (s, n) == ("master", "mapping") else None)

        while True:
            conn, _ = server.accept()
            threading.Thread(target=self._serve_client, args=(conn,), daemon=True).start()


if __name__ == "__main__":
    Daemon().run()
