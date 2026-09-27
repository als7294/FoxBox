"""`fvwks-engine` entry point (owned by S3).

Electron spawns `<engine>/.venv/bin/fvwks-engine --port 0 --token T --data-dir D --exit-with-parent`, then reads
stdout for the line `FVWKS_ENGINE_READY port=<n>`. The engine binds 127.0.0.1 only. With --exit-with-parent it
exits when stdin closes, i.e. when the parent dies.
"""

from __future__ import annotations

import argparse
import logging
import os
import socket
import sys
import threading

import uvicorn

from .app import create_app
from .config import VERSION, Config

READY_LINE = "FVWKS_ENGINE_READY port={port}"


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="fvwks-engine")
    ap.add_argument("--port", type=int, default=int(os.environ.get("FVWKS_PORT", "0")), help="0 = pick a free port")
    ap.add_argument("--token", default=None, help="Bearer token required on every request (env FVWKS_TOKEN)")
    ap.add_argument("--data-dir", default=None, help="default: ./.devdata/data (env FVWKS_DATA_DIR)")
    ap.add_argument("--export-dir", default=None,
                    help="default export root (env FVWKS_EXPORT_DIR); Settings.export_dir overrides it")
    ap.add_argument("--allow-origin", action="append", default=[], help="CORS origin (dev only; the app proxies via IPC)")
    ap.add_argument("--exit-with-parent", action="store_true", help="exit when stdin closes")
    ap.add_argument("--log-level", default=os.environ.get("FVWKS_LOG_LEVEL", "warning"))
    ap.add_argument("--version", action="version", version=f"fvwks-engine {VERSION}")
    args = ap.parse_args(argv)

    logging.basicConfig(level=args.log_level.upper(), stream=sys.stderr,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    config = Config.from_env(args.data_dir, args.export_dir, args.token, args.allow_origin)
    if not config.token:
        print("fvwks-engine: WARNING no --token given; every local process can call the API (dev only)",
              file=sys.stderr, flush=True)
    app = create_app(config)
    service = app.state.service
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", args.port))  # never 0.0.0.0: the engine is local-only
    sock.listen(128)
    port = sock.getsockname()[1]
    if args.exit_with_parent:
        def watch() -> None:
            try:
                while sys.stdin.read(1):
                    pass
            finally:
                os._exit(0)

        threading.Thread(target=watch, name="parent-watch", daemon=True).start()
    service.start()
    print(READY_LINE.format(port=port), flush=True)
    server = uvicorn.Server(uvicorn.Config(app, log_level=args.log_level.lower()))
    server.run(sockets=[sock])


if __name__ == "__main__":
    main()
