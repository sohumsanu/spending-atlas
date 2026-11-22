"""Create or resume a private Spending Atlas instance on this computer."""
import argparse
import json
import os
import secrets
import subprocess
import sys
import time
import webbrowser
from urllib.request import ProxyHandler, build_opener

from ledger import DATA, ROOT, initialize

STATE = DATA / "local-server.json"
OPENER = build_opener(ProxyHandler({}))


def healthy(port, instance):
    try:
        with OPENER.open(f"http://127.0.0.1:{port}/healthz", timeout=.6) as response:
            return json.load(response) == {"app": "spending-atlas", "instance": instance}
    except (OSError, ValueError):
        return False


def running_instance():
    try:
        data = json.loads(STATE.read_text())
        port, instance = data["port"], data["instance"]
        if type(port) is int and 0 < port <= 65535 and isinstance(instance, str) and healthy(port, instance):
            return port
    except (OSError, ValueError, KeyError, TypeError):
        pass
    return None


def start(port):
    instance = secrets.token_hex(16)
    log = DATA / f"server-{instance}.log"
    options = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {"start_new_session": True}
    with log.open("x", encoding="utf-8") as output:
        process = subprocess.Popen(
            [sys.executable, str(ROOT / "app.py"), "serve", "--port", str(port)],
            cwd=ROOT, env={**os.environ, "FINANCE_DATA_DIR": str(DATA), "SPENDING_ATLAS_INSTANCE": instance},
            stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, **options,
        )
    try:
        deadline = time.monotonic() + 12
        prefix = "Spending Atlas is running at http://127.0.0.1:"
        while time.monotonic() < deadline and process.poll() is None:
            for line in log.read_text(encoding="utf-8", errors="replace").splitlines():
                if line.startswith(prefix):
                    launched_port = int(line.removeprefix(prefix))
                    if healthy(launched_port, instance):
                        temporary = STATE.with_name(f"local-server-{instance}.json")
                        with temporary.open("x") as handle:
                            json.dump({"port": launched_port, "instance": instance, "pid": process.pid}, handle)
                        temporary.replace(STATE)
                        return launched_port
            time.sleep(.15)
    except BaseException:
        if process.poll() is None:
            process.terminate()
        raise
    if process.poll() is None:
        process.terminate()
    return None


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--open", action="store_true", help="Open the dashboard in the default browser.")
    parser.add_argument("--init-only", action="store_true", help="Initialize without starting a server.")
    args = parser.parse_args()
    initialize()
    if args.init_only:
        print("Private ledger initialized.")
        return
    port = running_instance() or start(8765) or start(0)
    if port is None:
        parser.exit(1, "Could not start the dashboard. Check the newest log in .finance-data.\n")
    url = f"http://127.0.0.1:{port}/"
    print(url)
    if args.open:
        webbrowser.open(url)


if __name__ == "__main__":
    main()
