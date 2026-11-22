"""Run the private, loopback-only Spending Atlas web app."""
import argparse
import json
import mimetypes
import os
import re
import secrets
import sqlite3
import tempfile
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit

from ledger import (DATA, ROOT, allocate, connect, csv_payload, data_view, finance_payload,
                    import_transactions, initialize, manage_trip, now, patch_transaction, rebuild_trips,
                    reclassify_local, setting)

from reference import read_dashboard, reconcile_credits, reconcile_dashboard, reconcile_transfers
from amazon_orders import (browser_bridge, browser_orders, browser_status, read_orders, reconcile_orders,
                           stage_orders, stage_payments)
from costco_receipts import receipt_file
from category_chat import ChatError, answer_category
from onboarding import export_starter, save_setup, setup_view

STATIC = {"/": "index.html", "/style.css": "style.css", "/app.js": "app.js"}
EXTENSION_ORIGIN = re.compile(r"chrome-extension://[a-p]{32}")

def snapshot(destination):
    with connect() as source, sqlite3.connect(destination) as target:
        source.backup(target)
    Path(destination).chmod(0o600)

def backup_bytes():
    with tempfile.TemporaryDirectory(dir=DATA) as directory:
        destination = Path(directory) / "spending-atlas.sqlite3"
        snapshot(destination)
        return destination.read_bytes()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def response(self, status, content, content_type, download=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'")
        origin = self.headers.get("Origin", "")
        if urlsplit(self.path).path == "/api/amazon/bridge" and EXTENSION_ORIGIN.fullmatch(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        if download:
            self.send_header("Content-Disposition", f'attachment; filename="{download}"')
        self.end_headers()
        self.wfile.write(content)

    def json(self, status, value):
        self.response(status, json.dumps(value).encode(), "application/json; charset=utf-8")

    def valid_host(self):
        return self.headers.get("Host") in {f"localhost:{self.server.server_port}", f"127.0.0.1:{self.server.server_port}"}

    def do_OPTIONS(self):
        origin = self.headers.get("Origin", "")
        if (not self.valid_host() or urlsplit(self.path).path != "/api/amazon/bridge" or
                not EXTENSION_ORIGIN.fullmatch(origin) or self.headers.get("Access-Control-Request-Method") != "POST"):
            return self.json(403, {"error": "Unknown connector origin."})
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Methods", "POST")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Vary", "Origin")
        self.end_headers()

    def do_GET(self):
        if not self.valid_host():
            return self.json(403, {"error": "Open the app using its local URL."})
        path = urlsplit(self.path).path
        if path == "/healthz":
            return self.json(200, {"app": "spending-atlas", "instance": os.getenv("SPENDING_ATLAS_INSTANCE", "")})
        if path == "/api/data":
            with connect() as db:
                db.execute("BEGIN")
                data = data_view(db)
                data["amazon_sync"] = browser_status(db)
                data["setup"] = setup_view(db)
                return self.json(200, data)
        if path == "/download/starter":
            return self.response(200, export_starter(), "application/zip", "Spending-Atlas-Starter.zip")
        if path.startswith("/api/costco-receipt/"):
            file = receipt_file(path.removeprefix("/api/costco-receipt/"))
            if file is not None:
                return self.response(200, file.read_bytes(), "text/plain; charset=utf-8")
            return self.json(404, {"error": "Receipt not found."})
        if path in STATIC:
            file = ROOT / "static" / STATIC[path]
            return self.response(200, file.read_bytes(), mimetypes.guess_type(file)[0] + "; charset=utf-8")
        return self.json(404, {"error": "Page not found."})

    def do_POST(self):
        path = urlsplit(self.path).path
        origin = self.headers.get("Origin", "")
        same_origin = origin == f"http://{self.headers.get('Host')}"
        if not self.valid_host() or (not same_origin and not self.amazon_extension(path, origin)):
            return self.json(403, {"error": "Open the local app or pair your Chrome connector."})
        try:
            length = int(self.headers.get("Content-Length", 0))
            if not 0 < length <= 16_000_000 or self.headers.get_content_type() != "application/json":
                raise ValueError("Expected a JSON request under 16 MB.")
            data = json.loads(self.rfile.read(length))
            if not isinstance(data, dict):
                raise ValueError("Expected an object.")
            if path == "/api/category-chat":
                return self.json(200, answer_category(data))
            if path == "/api/import-finances":
                try:
                    accounts, records = finance_payload(data.get("batches"))
                    if not accounts or len({item[0] for item in accounts}) != len(accounts) or len({row["id"] for row in records}) != len(records):
                        raise ValueError("Use a snapshot with distinct accounts and transaction IDs.")
                    if any(not row["id"].removeprefix("finances:") for row in records):
                        raise ValueError("Every transaction needs its original source ID.")
                except (KeyError, TypeError) as error:
                    raise ValueError("Choose a prepared Spending Atlas Finances snapshot.") from error
                return self.json(200, import_transactions(accounts, records, use_model=False))
            if path == "/api/amazon/capture":
                if "payments" in data:
                    payments = data["payments"]
                    if not isinstance(payments, list) or not 1 <= len(payments) <= 2500:
                        raise ValueError("Expected between 1 and 2,500 completed card charges.")
                    with connect(write=True) as db:
                        return self.json(200, stage_payments(db, payments))
                rows = data.get("orders")
                if not isinstance(rows, list) or not 1 <= len(rows) <= 2500:
                    raise ValueError("Expected between 1 and 2,500 Amazon orders.")
                return self.json(200, stage_orders(rows))
            if path == "/api/amazon/bridge":
                if not self.amazon_extension(path, origin):
                    return self.json(403, {"error": "Pair your Chrome connector before syncing."})
                return self.json(200, browser_bridge(data))
            if path == "/api/import":
                content, account = data.get("content"), data.get("account")
                if not isinstance(content, str) or not isinstance(account, str):
                    raise ValueError("Choose a CSV and enter its account name.")
                accounts, records = csv_payload(content, account, data.get("convention"))
                return self.json(200, import_transactions(accounts, records))
            if path == "/api/backup":
                filename = "spending-atlas-" + now()[:10] + ".sqlite3"
                return self.response(200, backup_bytes(), "application/vnd.sqlite3", filename)
            with connect(write=True) as db:
                if path == "/api/edit":
                    ids = data.get("ids")
                    if not isinstance(ids, list) or not 1 <= len(ids) <= 500 or any(not isinstance(i, str) for i in ids):
                        raise ValueError("Choose between one and 500 transactions.")
                    for identifier in ids:
                        patch_transaction(db, identifier, data)
                    if "category" in data:
                        rebuild_trips(db)
                elif path == "/api/trip":
                    manage_trip(db, data)
                elif path == "/api/credit":
                    allocate(db, data)
                elif path == "/api/setup":
                    save_setup(db, data)
                elif path == "/api/settings":
                    home = str(data.get("home", "")).strip()[:120]
                    db.execute("INSERT OR REPLACE INTO settings VALUES ('home',?)", (home,))
                    rebuild_trips(db)
                else:
                    return self.json(404, {"error": "Action not found."})
            return self.json(200, {"ok": True})
        except ChatError as error:
            return self.json(error.status, {"error": str(error)})
        except (ValueError, TypeError, OverflowError, sqlite3.IntegrityError) as error:
            return self.json(400, {"error": str(error)})

    def amazon_extension(self, path, origin):
        if path != "/api/amazon/bridge" or not EXTENSION_ORIGIN.fullmatch(origin):
            return False
        candidate = self.headers.get("Authorization", "")
        if not candidate.isascii():
            return False
        with connect() as db:
            key = setting(db, "amazon_pairing_key")
        return bool(key and secrets.compare_digest(candidate, "Bearer " + key))

def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command")
    serve = commands.add_parser("serve")
    serve.add_argument("--port", type=int, default=8765)
    serve.add_argument("--open", action="store_true", help="Open Spending Atlas in your default browser.")
    export = commands.add_parser("export-starter", help="Export the app without your private ledger or settings.")
    export.add_argument("path", type=Path)
    load = commands.add_parser("import-finances")
    load.add_argument("path", type=Path)
    load.add_argument("--local-rules", action="store_true", help="Use the deterministic rules for this import.")
    commands.add_parser("reclassify-local", help="Refresh automatic classification with the local rules.")
    reconcile = commands.add_parser("import-dashboard-assignments")
    reconcile.add_argument("path", type=Path)
    credits = commands.add_parser("import-dashboard-credits")
    credits.add_argument("path", type=Path)
    if (ROOT / "review_rules.py").is_file():
        review = commands.add_parser("reconcile-review")
        review.add_argument("--reference", type=Path)
    amazon = commands.add_parser("import-amazon-orders")
    amazon.add_argument("path", nargs="?", type=Path)
    amazon.add_argument("--apply", action="store_true")
    pairing = commands.add_parser("amazon-pair", help="Get the key for the local Chrome connector.")
    pairing.add_argument("--rotate", action="store_true")
    save = commands.add_parser("backup")
    save.add_argument("path", type=Path)
    args = parser.parse_args()
    if args.command == "export-starter":
        archive = export_starter()
        with args.path.open("xb") as target:
            target.write(archive)
        print(f"Saved {args.path}")
        return
    initialize()
    if args.command == "import-finances":
        accounts, records = finance_payload(json.loads(args.path.read_text()))
        print(json.dumps(import_transactions(accounts, records, use_model=not args.local_rules)))
    elif args.command == "import-dashboard-assignments":
        report = reconcile_dashboard(read_dashboard(args.path.read_text()))
        print(json.dumps(report))
    elif args.command == "import-dashboard-credits":
        rows = read_dashboard(args.path.read_text())
        print(json.dumps({**reconcile_transfers(rows), **reconcile_credits(rows)}))
    elif args.command == "reconcile-review":
        from review_rules import reconcile_review

        print(json.dumps(reconcile_review(read_dashboard(args.reference.read_text()) if args.reference else ())))
    elif args.command == "import-amazon-orders":
        print(json.dumps(reconcile_orders(read_orders(args.path) if args.path else browser_orders(), args.apply)))
    elif args.command == "amazon-pair":
        with connect(write=True) as db:
            key = setting(db, "amazon_pairing_key")
            if not key or args.rotate:
                key = secrets.token_urlsafe(32)
                db.execute("INSERT OR REPLACE INTO settings VALUES('amazon_pairing_key',?)", (key,))
        print(key)
    elif args.command == "reclassify-local":
        print(f"Updated {reclassify_local()} classifications.")
    elif args.command == "backup":
        descriptor = os.open(args.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        os.close(descriptor)
        try:
            snapshot(args.path)
        except BaseException:
            args.path.unlink()
            raise
        print(f"Saved {args.path}")
    else:
        port = getattr(args, "port", 8765)
        with ThreadingHTTPServer(("127.0.0.1", port), Handler) as server:
            print(f"Spending Atlas is running at http://127.0.0.1:{server.server_port}", flush=True)
            if args.open:
                webbrowser.open(f"http://127.0.0.1:{server.server_port}")
            try:
                server.serve_forever()
            except KeyboardInterrupt:
                pass

if __name__ == "__main__":
    main()
