"""SQLite storage, imports and report queries."""
import csv
import hashlib
import io
import json
import os
import sqlite3
import unicodedata
from collections import Counter, defaultdict
from contextlib import contextmanager
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path

from intelligence import (CATEGORIES, FOOD_MEMO, NON_EXPENSE_CATEGORIES, TRANSFER_CATEGORIES, UNVERIFIED_CATEGORIES,
                          classify, credit_candidates, days, food_peer_default, is_venmo, meal_match, model_category,
                          normalize, on_location, travel_anchor, trip_candidates)

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("FINANCE_DATA_DIR", ROOT / ".finance-data")).expanduser().resolve()
DB = DATA / "ledger.sqlite3"
SCHEMA = """
CREATE TABLE IF NOT EXISTS accounts (
 id TEXT PRIMARY KEY, label TEXT NOT NULL, source TEXT NOT NULL, fresh TEXT NOT NULL,
 coverage TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS trips (
 id INTEGER PRIMARY KEY, name TEXT NOT NULL, destination TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('automatic','suggested','confirmed','dismissed')), reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tx (
 id TEXT PRIMARY KEY, account TEXT NOT NULL REFERENCES accounts(id), date TEXT NOT NULL, merchant TEXT NOT NULL,
 description TEXT NOT NULL, amount INTEGER NOT NULL, currency TEXT NOT NULL, source_category TEXT NOT NULL,
 source_detail TEXT NOT NULL, source_confidence TEXT NOT NULL, city TEXT NOT NULL, region TEXT NOT NULL,
 country TEXT NOT NULL, channel TEXT NOT NULL, memo TEXT NOT NULL, linked_transfer INTEGER NOT NULL,
 travel_date TEXT NOT NULL, category TEXT NOT NULL, kind TEXT NOT NULL, reason TEXT NOT NULL,
 review INTEGER NOT NULL, manual_category INTEGER NOT NULL DEFAULT 0,
 trip INTEGER REFERENCES trips(id), manual_trip INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS tx_date ON tx(date, currency);
CREATE INDEX IF NOT EXISTS tx_trip ON tx(trip);
CREATE TABLE IF NOT EXISTS statement_amounts (
 tx TEXT PRIMARY KEY REFERENCES tx(id), upstream_amount INTEGER NOT NULL, posted_amount INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS statement_descriptions (
 tx TEXT PRIMARY KEY REFERENCES tx(id), description TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS statement_card_masks (
 tx TEXT PRIMARY KEY REFERENCES tx(id), last_four TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS shopping_subcategories (
 tx TEXT PRIMARY KEY REFERENCES tx(id), subcategory TEXT NOT NULL, reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transaction_display (
 tx TEXT PRIMARY KEY REFERENCES tx(id), label TEXT, date TEXT, merchant TEXT
);
CREATE TABLE IF NOT EXISTS costco_receipts (
 id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, date TEXT NOT NULL, amount INTEGER NOT NULL,
 transaction_id TEXT REFERENCES tx(id), status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transaction_context (
 tx TEXT PRIMARY KEY REFERENCES tx(id), event_at TEXT NOT NULL, counterpart TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS amazon_matches (
 tx TEXT PRIMARY KEY REFERENCES tx(id), order_ref TEXT NOT NULL UNIQUE, items TEXT NOT NULL,
 match_basis TEXT NOT NULL DEFAULT 'card_exact'
);
CREATE TABLE IF NOT EXISTS amazon_order_cache (
 order_ref TEXT PRIMARY KEY, order_date TEXT NOT NULL, total INTEGER NOT NULL, currency TEXT NOT NULL, items TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS amazon_order_payment (
 order_ref TEXT PRIMARY KEY REFERENCES amazon_order_cache(order_ref), last_four TEXT NOT NULL, amount INTEGER NOT NULL,
 paid_on TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS amazon_payment_exclusions (
 order_ref TEXT PRIMARY KEY REFERENCES amazon_order_cache(order_ref)
);
CREATE TABLE IF NOT EXISTS amazon_eligible_cards (
 account TEXT PRIMARY KEY REFERENCES accounts(id), last_four TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS amazon_browser_job (
 singleton INTEGER PRIMARY KEY CHECK (singleton=1), job_id TEXT NOT NULL, state TEXT NOT NULL,
 updated TEXT NOT NULL, result TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS rules (merchant TEXT PRIMARY KEY, category TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS expected_accounts (id TEXT PRIMARY KEY, label TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS coverage_windows (
 account TEXT NOT NULL REFERENCES expected_accounts(id), start TEXT NOT NULL, end TEXT NOT NULL,
 PRIMARY KEY (account,start,end)
);
CREATE TABLE IF NOT EXISTS allocations (
 credit TEXT NOT NULL REFERENCES tx(id), purchase TEXT NOT NULL REFERENCES tx(id), amount INTEGER NOT NULL CHECK(amount > 0),
 PRIMARY KEY(credit, purchase)
);
CREATE INDEX IF NOT EXISTS allocations_purchase ON allocations(purchase);
CREATE TABLE IF NOT EXISTS dismissed_credits (credit TEXT PRIMARY KEY REFERENCES tx(id));
CREATE TABLE IF NOT EXISTS credit_assignments (
 credit TEXT PRIMARY KEY REFERENCES tx(id), category TEXT NOT NULL, treatment TEXT NOT NULL
 CHECK(treatment IN ('apply','unassigned','exclude')), source TEXT NOT NULL, reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trip_suggestions (
 trip INTEGER NOT NULL REFERENCES trips(id), tx TEXT NOT NULL REFERENCES tx(id), PRIMARY KEY(trip, tx)
);
CREATE TABLE IF NOT EXISTS trip_date_exclusions (
 trip INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
 tx TEXT NOT NULL REFERENCES tx(id) ON DELETE CASCADE,
 PRIMARY KEY(trip, tx)
);
CREATE INDEX IF NOT EXISTS trip_date_exclusions_tx ON trip_date_exclusions(tx);
CREATE TABLE IF NOT EXISTS reference_trips (
 trip INTEGER PRIMARY KEY REFERENCES trips(id), label TEXT NOT NULL UNIQUE, booking INTEGER NOT NULL
);
"""
SOURCE_FIELDS = ("account", "date", "merchant", "description", "amount", "currency", "source_category",
                 "source_detail", "source_confidence", "city", "region", "country", "channel", "memo",
                 "linked_transfer", "travel_date")
EXPENSE_CATEGORIES = set(CATEGORIES) - NON_EXPENSE_CATEGORIES
CATEGORY_KINDS = {
    "income": "income",
    "credits": "credit",
    **dict.fromkeys(TRANSFER_CATEGORIES, "transfer"),
    **dict.fromkeys(UNVERIFIED_CATEGORIES, "uncertain"),
}
SHOPPING_SUBCATEGORIES = {
    "home": "Home & household", "electronics": "Electronics", "clothing": "Clothing & accessories",
    "health_wellness": "Health & wellness", "hobbies": "Hobbies & recreation", "gifts": "Gifts",
    "general": "Unspecified & mixed",
}

@contextmanager
def connect(write=False):
    DATA.mkdir(mode=0o700, parents=True, exist_ok=True)
    db = sqlite3.connect(DB, timeout=30)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA foreign_keys=ON")
        if write:
            db.execute("BEGIN IMMEDIATE")
        yield db
        db.commit()
    except BaseException:
        db.rollback()
        raise
    finally:
        db.close()

def initialize():
    with connect() as db:
        db.executescript(SCHEMA)
        if not any(col["name"] == "paid_on" for col in db.execute("PRAGMA table_info(amazon_order_payment)")):
            db.execute("ALTER TABLE amazon_order_payment ADD COLUMN paid_on TEXT NOT NULL DEFAULT ''")
        if not any(col["name"] == "match_basis" for col in db.execute("PRAGMA table_info(amazon_matches)")):
            db.execute("ALTER TABLE amazon_matches ADD COLUMN match_basis TEXT NOT NULL DEFAULT 'card_exact'")
        if not any(col["name"] == "merchant" for col in db.execute("PRAGMA table_info(transaction_display)")):
            db.execute("ALTER TABLE transaction_display ADD COLUMN merchant TEXT")
    DB.chmod(0o600)

def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

def setting(db, key):
    row = db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
    return row["value"] if row else ""

def iso_date(value):
    value = str(value or "").strip()
    try:
        return date.fromisoformat(value).isoformat()
    except ValueError:
        for pattern in ("%m/%d/%Y", "%m/%d/%y"):
            try:
                return datetime.strptime(value, pattern).date().isoformat()
            except ValueError:
                continue
    raise ValueError("Use a date like YYYY-MM-DD or MM/DD/YYYY.")

def cents(value):
    value = str(value).strip().replace(",", "").replace("$", "")
    if value.startswith("(") and value.endswith(")"):
        value = "-" + value[1:-1]
    try:
        number = Decimal(value) * 100
        if not number.is_finite() or abs(number) > 10**13 or number != number.to_integral_value():
            raise ValueError
        return int(number)
    except (InvalidOperation, ValueError, OverflowError):
        raise ValueError("Amounts must be numbers with up to two decimal places.") from None

def normalize_row(raw, account):
    currency = str(raw.get("currency") or "USD").upper().strip()
    if len(currency) != 3 or not currency.isascii() or not currency.isalpha():
        raise ValueError("Use a three-letter currency code.")
    row = {key: str(raw.get(key) or "").strip()[:500] for key in SOURCE_FIELDS}
    row.update(account=account, date=iso_date(raw.get("date")), amount=cents(raw.get("amount")), currency=currency,
               linked_transfer=int(bool(raw.get("linked_transfer"))), channel=row["channel"].lower(),
               travel_date=iso_date(row["travel_date"]) if row["travel_date"] else "")
    if not row["merchant"] and not row["description"]:
        raise ValueError("Each transaction needs a merchant or description.")
    return row

def finance_payload(payload):
    accounts, rows = [], []
    if not isinstance(payload, list):
        raise ValueError("Invalid Finances snapshot.")
    for item in payload:
        account = item["account"]
        accounts.append(("finances:" + account["id"], account["label"], "ChatGPT Finances", item["coverage"]))
        for raw in item["rows"]:
            rows.append({**raw, "account": "finances:" + account["id"], "id": "finances:" + raw["id"]})
    return accounts, rows

def csv_payload(content, label, convention):
    if not label.strip() or len(label) > 120:
        raise ValueError("Enter a short, consistent account name.")
    if convention not in {"debits_positive", "debits_negative"}:
        raise ValueError("Choose the amount convention used by the statement.")
    account = "csv:" + normalize(label)
    reader = csv.DictReader(io.StringIO(content.lstrip("\ufeff")))
    reader.fieldnames = [key.strip().lower().replace(" ", "_") for key in reader.fieldnames or []]
    if not {"date", "amount"}.issubset(reader.fieldnames) or not {"merchant", "description"}.intersection(reader.fieldnames):
        raise ValueError("CSV requires Date, Amount, and either Merchant or Description columns.")
    entries = []
    occurrences = Counter()
    for raw in reader:
        if not any(raw.values()):
            continue
        try:
            if convention == "debits_negative":
                raw["amount"] = format(Decimal(-cents(raw["amount"])) / 100, "f")
            row = normalize_row(raw, account)
        except ValueError as error:
            raise ValueError(f"CSV line {reader.line_num}: {error}") from None
        if row["amount"] == 0:
            continue
        fingerprint = json.dumps([row[k] for k in ("date", "amount", "currency", "merchant", "description")])
        occurrences[fingerprint] += 1
        reference = str(raw.get("id") or raw.get("transaction_id") or f"{fingerprint}:{occurrences[fingerprint]}")
        key = hashlib.sha256(f"{account}:{reference}".encode()).hexdigest()
        entries.append({**raw, "account": account, "id": "csv:" + key})
    if not entries:
        raise ValueError("The CSV does not contain any transactions with a nonzero amount.")
    return [(account, label.strip(), "CSV statement", "Statement import. Coverage depends on the file.")], entries

def inferred_category(db, row, use_model, counterpart=""):
    merchant = normalize(row["merchant"] or row["description"])
    saved = db.execute("SELECT category FROM rules WHERE merchant=?", (merchant,)).fetchone()
    account = db.execute("SELECT label FROM accounts WHERE id=?", (row["account"],)).fetchone()
    peer = counterpart and db.execute("""SELECT tx.amount,accounts.label FROM tx JOIN accounts ON accounts.id=tx.account
        WHERE tx.id=? AND tx.account<>? AND ABS(tx.amount)=ABS(?)
        AND currency=? AND ABS(julianday(date)-julianday(?))<=3""",
        (counterpart, row["account"], row["amount"], row["currency"], row["date"])).fetchone()
    label = account["label"] if account else ""
    if peer and row["amount"] > 0 and peer["amount"] == row["amount"] and (
        "venmo" in peer["label"].casefold() and "venmo" not in label.casefold()
    ):
        return "transfers", "transfer", "The bank funded the linked Venmo debit, which is counted once on Venmo.", 0
    paired = bool(peer and peer["amount"] == -row["amount"])
    result = classify(row, saved["category"] if saved else None, label, paired,
                      owner=setting(db, "owner_name"), own_labels=setting(db, "owned_transfer_labels").split(","),
                      peer_food=setting(db, "peer_food_default") == "1")
    if not use_model:
        return result
    history = [item["category"] for item in db.execute(
        "SELECT DISTINCT category FROM tx WHERE LOWER(merchant)=LOWER(?) AND manual_category=1 AND kind='purchase' LIMIT 5",
        (row["merchant"],),
    )] if row["merchant"] else []
    return model_category(row, result, history)

def verified_statement_overlap(db, row):
    return db.execute("""SELECT 1 FROM tx t LEFT JOIN transaction_context c ON c.tx=t.id
        LEFT JOIN statement_amounts s ON s.tx=t.id
        LEFT JOIN statement_descriptions d ON d.tx=t.id
        LEFT JOIN transaction_display v ON v.tx=t.id
        WHERE t.account=? AND t.currency=? AND (t.amount=? OR s.upstream_amount=?)
        AND ((t.id LIKE 'statement:%' AND
              (abs(julianday(t.date)-julianday(?))<=4 OR substr(c.event_at,1,10)=?))
             OR (s.tx IS NOT NULL AND abs(julianday(t.date)-julianday(?))<=4)
             OR (d.tx IS NOT NULL AND v.date=?)) LIMIT 1""",
        (row["account"], row["currency"], row["amount"], row["amount"],
         row["date"], row["date"], row["date"], row["date"])).fetchone() is not None


def import_transactions(accounts, records, use_model=True, *, verify=None):
    prepared = [(raw, normalize_row(raw, raw["account"])) for raw in records]
    changes = Counter()
    with connect(write=True) as db:
        if verify is not None:
            verify(db)
        for account, label, source, coverage in accounts:
            db.execute("""INSERT INTO accounts VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                label=excluded.label, fresh=excluded.fresh, coverage=excluded.coverage""",
                (account, label, source, now(), coverage))
        for raw, row in prepared:
            identifier = raw["id"]
            existing = db.execute("SELECT * FROM tx WHERE id=?", (identifier,)).fetchone()
            if not existing and identifier.startswith("finances:") and verified_statement_overlap(db, row):
                raise ValueError("A new feed transaction may overlap a verified statement entry. Reconcile the two records before importing.")
            statement = existing and db.execute("SELECT * FROM statement_amounts WHERE tx=?", (identifier,)).fetchone()
            if statement and row["amount"] == statement["upstream_amount"]:
                row["amount"] = statement["posted_amount"]
            bank_description = existing and db.execute(
                "SELECT description FROM statement_descriptions WHERE tx=?", (identifier,)).fetchone()
            if bank_description:
                row["description"] = bank_description["description"]
                if "***" in row["merchant"] or normalize(row["merchant"]) in {"", "card transaction"}:
                    row["merchant"] = bank_description["description"]
            if existing and all(existing[key] == row[key] for key in SOURCE_FIELDS):
                record_context(db, raw)
                changes["unchanged"] += 1
                continue
            result = inferred_category(db, row, use_model, str(raw.get("counterpart") or ""))
            matched_amazon = existing and db.execute("SELECT match_basis FROM amazon_matches WHERE tx=?", (identifier,)).fetchone()
            if matched_amazon:
                if all(existing[key] == row[key] for key in ("amount", "date", "currency")):
                    if matched_amazon["match_basis"] != "date_amount":
                        result = (existing["category"], existing["kind"], existing["reason"], existing["review"])
                else:
                    db.execute("DELETE FROM amazon_matches WHERE tx=?", (identifier,))
            if existing and existing["manual_category"]:
                result = (existing["category"], existing["kind"], existing["reason"], existing["review"])
            elif existing and existing["kind"] == "credit" and row["amount"] < 0 and db.execute(
                "SELECT 1 FROM credit_assignments WHERE credit=? AND source IN ('manual','reference','statement')", (identifier,)
            ).fetchone():
                result = (existing["category"], existing["kind"], existing["reason"], existing["review"])
            if existing and (existing["amount"] != row["amount"] or existing["currency"] != row["currency"] or
                             (not existing["manual_category"] and existing["kind"] != result[1])):
                db.execute("DELETE FROM allocations WHERE credit=? OR purchase=?", (identifier, identifier))
                db.execute("DELETE FROM dismissed_credits WHERE credit=?", (identifier,))
                db.execute("DELETE FROM credit_assignments WHERE credit=? AND source<>'manual'", (identifier,))
            fields = (*SOURCE_FIELDS, "category", "kind", "reason", "review")
            columns = ", ".join(("id", *fields))
            marks = ", ".join("?" for _ in range(len(fields) + 1))
            updates = ", ".join(f"{key}=excluded.{key}" for key in fields)
            db.execute(f"INSERT INTO tx ({columns}) VALUES ({marks}) ON CONFLICT(id) DO UPDATE SET {updates}",
                       (identifier, *(row[key] for key in SOURCE_FIELDS), *result))
            record_context(db, raw)
            changes["updated" if existing else "added"] += 1
        if changes["added"] or changes["updated"]:
            rebuild_trips(db)
        categorize_credits(db)
    return {key: changes[key] for key in ("added", "updated", "unchanged")}

def record_context(db, raw):
    event_at = str(raw.get("event_at") or "")
    counterpart = str(raw.get("counterpart") or "")
    if event_at or counterpart:
        db.execute("""INSERT INTO transaction_context VALUES (?,?,?)
            ON CONFLICT(tx) DO UPDATE SET event_at=excluded.event_at,counterpart=excluded.counterpart""",
            (raw["id"], event_at[:45], counterpart[:180]))

def in_trip_dates(row, start, end):
    day = row["travel_date"] or row["reporting_date"] or row["date"]
    return (not start or start <= day) and (not end or day <= end)


def rebuild_trips(db):
    rows = [dict(row) for row in db.execute("""SELECT tx.*, td.date AS reporting_date FROM tx
             LEFT JOIN transaction_display td ON td.tx=tx.id WHERE kind='purchase' AND amount>0 ORDER BY tx.date""")]
    by_id = {row["id"]: row for row in rows}
    candidates = trip_candidates(rows, setting(db, "home"))
    db.execute("DELETE FROM trip_suggestions")
    db.execute("UPDATE tx SET trip=NULL WHERE manual_trip=0 AND trip IN (SELECT id FROM trips WHERE status='automatic')")
    imported_trips = {r["trip"] for r in db.execute("SELECT trip FROM reference_trips")}
    reference_ids = {r["id"] for r in rows if r["trip"] in imported_trips}
    seen = set()
    for candidate in candidates:
        if reference_ids.intersection(candidate["ids"]):
            continue
        matching = db.execute("""SELECT * FROM trips WHERE destination=? AND start<=? AND end>=?
            ORDER BY CASE status WHEN 'confirmed' THEN 0 WHEN 'dismissed' THEN 1 ELSE 2 END, id LIMIT 1""",
            (candidate["destination"], candidate["end"], candidate["start"])).fetchone()
        status = "automatic" if candidate["strong"] else "suggested"
        if matching:
            trip_id = matching["id"]
            if matching["status"] == "dismissed":
                continue
            if matching["status"] != "confirmed":
                status = "automatic" if matching["status"] == "automatic" else status
                db.execute("UPDATE trips SET start=?, end=?, status=?, reason=? WHERE id=?",
                    (min(matching["start"], candidate["start"]), max(matching["end"], candidate["end"]),
                    status, candidate["reason"], trip_id))
            else:
                status = "confirmed"
        else:
            trip_id = db.execute("INSERT INTO trips(name,destination,start,end,status,reason) VALUES(?,?,?,?,?,?)",
                    (candidate["destination"].split(",")[0], candidate["destination"], candidate["start"],
                    candidate["end"], status, candidate["reason"])).lastrowid
        seen.add(trip_id)
        if status == "suggested":
            db.executemany("INSERT OR IGNORE INTO trip_suggestions VALUES(?,?)", ((trip_id, key) for key in candidate["ids"]))
        else:
            db.executemany("UPDATE tx SET trip=? WHERE id=? AND manual_trip=0 AND trip IS NULL",
                           ((trip_id, key) for key in candidate["ids"] if status != "confirmed" or
                            in_trip_dates(by_id[key], matching["start"], matching["end"])))
    stale = [r["id"] for r in db.execute("""SELECT id FROM trips WHERE status IN ('automatic','suggested')
             AND NOT EXISTS (SELECT 1 FROM tx WHERE tx.trip=trips.id)""") if r["id"] not in seen]
    db.executemany("DELETE FROM trips WHERE id=?", ((i,) for i in stale))

def reclassify_local():
    with connect(write=True) as db:
        rows = db.execute("""SELECT * FROM tx WHERE manual_category=0 AND NOT EXISTS
                            (SELECT 1 FROM credit_assignments WHERE credit=tx.id AND source IN ('manual','reference','statement'))
                            AND NOT EXISTS (SELECT 1 FROM amazon_matches WHERE amazon_matches.tx=tx.id
                                            AND amazon_matches.match_basis<>'date_amount')""").fetchall()
        changed = 0
        for row in rows:
            if db.execute("SELECT 1 FROM allocations WHERE credit=? OR purchase=? LIMIT 1", (row["id"], row["id"])).fetchone():
                continue
            result = inferred_category(db, row, False)
            if result == tuple(row[key] for key in ("category", "kind", "reason", "review")):
                continue
            db.execute("UPDATE tx SET category=?,kind=?,reason=?,review=? WHERE id=?", (*result, row["id"]))
            changed += 1
            if result[1] != "purchase":
                db.execute("UPDATE tx SET trip=NULL WHERE id=?", (row["id"],))
        rebuild_trips(db)
        return changed

def patch_transaction(db, identifier, data, *, category_reason="You set this category.", category_needs_review=False):
    row = require_transaction(db, identifier)
    if {"display_name", "reporting_date", "assigned_merchant"} & data.keys():
        previous = db.execute("SELECT label,date,merchant FROM transaction_display WHERE tx=?", (identifier,)).fetchone()
        label = data.get("display_name", previous["label"] if previous else None)
        date = data.get("reporting_date", previous["date"] if previous else None)
        merchant = data.get("assigned_merchant", previous["merchant"] if previous else None)
        if label is not None and (not isinstance(label, str) or not 1 <= len(label.strip()) <= 150):
            raise ValueError("Enter a transaction name of up to 150 characters.")
        if merchant is not None:
            if not isinstance(merchant, str) or not 1 <= len(merchant.strip()) <= 150:
                raise ValueError("Enter a merchant name of up to 150 characters.")
            merchant = " ".join(merchant.split())
        db.execute("INSERT OR REPLACE INTO transaction_display(tx,label,date,merchant) VALUES (?,?,?,?)",
                   (identifier, label.strip() if label else None, iso_date(date) if date is not None else None, merchant))
    if "category" in data:
        category = data["category"]
        if not isinstance(category, str) or category not in CATEGORIES:
            raise ValueError("Choose a valid category.")
        amount = row["amount"]
        allowed = {"income", "credits", *TRANSFER_CATEGORIES} if amount < 0 else set(CATEGORIES) - {"income", "credits"}
        if category not in allowed:
            raise ValueError("Choose a category consistent with the transaction direction.")
        kind = CATEGORY_KINDS.get(category, "purchase")
        if kind != row["kind"]:
            db.execute("DELETE FROM allocations WHERE credit=? OR purchase=?", (identifier, identifier))
            db.execute("DELETE FROM dismissed_credits WHERE credit=?", (identifier,))
            db.execute("DELETE FROM credit_assignments WHERE credit=?", (identifier,))
            if kind != "purchase":
                db.execute("UPDATE tx SET trip=NULL WHERE id=?", (identifier,))
                db.execute("DELETE FROM trip_date_exclusions WHERE tx=?", (identifier,))
        db.execute("UPDATE tx SET category=?,kind=?,reason=?,review=?,manual_category=1 WHERE id=?",
                   (category, kind, category_reason, int(category_needs_review or kind == "uncertain"), identifier))
        if data.get("remember") and kind == "purchase":
            merchant = normalize(row["merchant"] or row["description"])
            db.execute("INSERT OR REPLACE INTO rules VALUES(?,?)", (merchant, category))
    if "shopping_subcategory" in data:
        subcategory = data["shopping_subcategory"]
        current = require_transaction(db, identifier)
        if (not isinstance(subcategory, str) or subcategory not in SHOPPING_SUBCATEGORIES or
                current["kind"] != "purchase" or current["category"] not in {"shopping", "health_wellness"}):
            raise ValueError("Choose a subcategory for a shopping purchase.")
        db.execute("INSERT OR REPLACE INTO shopping_subcategories VALUES(?,?,?)",
                   (identifier, subcategory, "You set this subcategory."))
    if "trip" in data:
        trip = data["trip"]
        if trip is not None and (require_transaction(db, identifier)["kind"] != "purchase" or
            not db.execute("SELECT 1 FROM trips WHERE id=? AND status IN ('automatic','confirmed')", (trip,)).fetchone()):
            raise ValueError("Choose an active trip and a purchase.")
        db.execute("UPDATE tx SET trip=?,manual_trip=1 WHERE id=?", (trip, identifier))
        db.execute("DELETE FROM trip_date_exclusions WHERE tx=?", (identifier,))

def require_transaction(db, identifier):
    row = db.execute("SELECT * FROM tx WHERE id=?", (identifier,)).fetchone()
    if row is None:
        raise ValueError("Transaction was not found.")
    return row


def reconcile_trip_dates(db, trip_id, name, destination, start, end):
    def location_text(value):
        return normalize("".join(c for c in unicodedata.normalize("NFKD", value) if not unicodedata.combining(c)))

    places = f" {location_text(name + ' ' + destination)} "
    rows = db.execute("""SELECT tx.*, td.date AS reporting_date,
                        EXISTS(SELECT 1 FROM trip_date_exclusions e WHERE e.tx=tx.id AND e.trip=?) AS was_on_trip,
                        EXISTS(SELECT 1 FROM trip_date_exclusions e WHERE e.tx=tx.id) AS removed_by_dates,
                        EXISTS(SELECT 1 FROM trip_suggestions s WHERE s.tx=tx.id AND s.trip=?) AS suggested
                        FROM tx LEFT JOIN transaction_display td ON td.tx=tx.id
                        WHERE tx.kind='purchase' AND tx.amount>0 AND (tx.trip=? OR tx.trip IS NULL)""",
                      (trip_id, trip_id, trip_id)).fetchall()
    removed, added = [], []
    for row in rows:
        identifier = row["id"]
        if not in_trip_dates(row, start, end):
            if row["trip"] == trip_id:
                removed.append(identifier)
            continue
        if row["trip"] == trip_id:
            continue
        if row["was_on_trip"]:
            added.append(identifier)
            continue
        if (row["manual_trip"] and not row["removed_by_dates"]) or not (start and end):
            continue
        city = location_text(row["city"])
        location_match = city and f" {city} " in places and (
            on_location(row) or (row["travel_date"] and travel_anchor(row)))
        if row["category"] not in {"housing", "shared_expenses"} and (row["suggested"] or location_match):
            added.append(identifier)

    db.executemany("INSERT OR IGNORE INTO trip_date_exclusions VALUES(?,?)",
                   ((trip_id, identifier) for identifier in removed))
    db.executemany("UPDATE tx SET trip=NULL,manual_trip=1 WHERE id=?", ((identifier,) for identifier in removed))
    db.executemany("UPDATE tx SET trip=?,manual_trip=1 WHERE id=?", ((trip_id, identifier) for identifier in added))
    db.executemany("DELETE FROM trip_date_exclusions WHERE trip=? AND tx=?",
                   ((trip_id, identifier) for identifier in added))
    db.execute("DELETE FROM trip_suggestions WHERE trip=?", (trip_id,))
    return {"added": len(added), "removed": len(removed)}

def manage_trip(db, data):
    trip_id = data.get("id")
    action = data.get("action")
    if trip_id is None:
        old = None
    else:
        old = db.execute("SELECT * FROM trips WHERE id=?", (trip_id,)).fetchone()
        if not old:
            raise ValueError("Trip was not found.")
    if action == "dismiss" and old:
        db.execute("UPDATE trips SET status='dismissed' WHERE id=?", (trip_id,))
        db.execute("UPDATE tx SET trip=NULL,manual_trip=1 WHERE trip=?", (trip_id,))
        db.execute("DELETE FROM trip_date_exclusions WHERE trip=?", (trip_id,))
        return
    if action == "merge" and old:
        target = data.get("target")
        other = db.execute("SELECT * FROM trips WHERE id=? AND status IN ('automatic','confirmed')", (target,)).fetchone()
        if not other or target == trip_id or old["status"] not in {"automatic", "confirmed"}:
            raise ValueError("Choose a different active trip.")
        db.execute("UPDATE tx SET trip=?,manual_trip=1 WHERE trip=?", (target, trip_id))
        db.execute("UPDATE trips SET status='dismissed' WHERE id=?", (trip_id,))
        db.execute("DELETE FROM trip_date_exclusions WHERE trip=?", (trip_id,))
        db.execute("UPDATE trips SET status='confirmed', start=?, end=? WHERE id=?",
                   (min(old["start"], other["start"]), max(old["end"], other["end"]), target))
        return
    if old and old["status"] == "dismissed":
        raise ValueError("This trip was dismissed.")
    name = str(data.get("name", old["name"] if old else "")).strip()
    destination = str(data.get("destination", old["destination"] if old else "")).strip()[:150]
    start_value = data.get("start", old["start"] if old else "")
    end_value = data.get("end", old["end"] if old else "")
    start, end = (iso_date(start_value) if start_value else "", iso_date(end_value) if end_value else "")
    if not name or len(name) > 100 or (start and end and start > end):
        raise ValueError("Enter a trip name and a valid date range.")
    if old is None:
        new_id = db.execute("INSERT INTO trips(name,destination,start,end,status,reason) VALUES(?,?,?,?,'confirmed','Created by you.')",
                            (name, destination, start, end)).lastrowid
        if action == "split":
            source, ids = data.get("source"), data.get("ids")
            if not isinstance(ids, list) or not 1 <= len(ids) <= 500:
                raise ValueError("Select purchases to move into the new trip.")
            for row_id in ids:
                if require_transaction(db, row_id)["trip"] != source or source is None:
                    raise ValueError("Select purchases from the original trip.")
                patch_transaction(db, row_id, {"trip": new_id})
        return
    db.execute("UPDATE trips SET name=?,destination=?,start=?,end=?,status='confirmed' WHERE id=?",
               (name, destination, start, end, trip_id))
    if name != old["name"]:
        promoted = db.execute("UPDATE reference_trips SET booking=0 WHERE trip=? AND booking=1", (trip_id,))
        if promoted.rowcount:
            db.execute("UPDATE trips SET reason='You named and confirmed this trip.' WHERE id=?", (trip_id,))
    if (start, end) != (old["start"], old["end"]):
        return reconcile_trip_dates(db, trip_id, name, destination, start, end)
    db.execute("""UPDATE tx SET trip=? WHERE id IN (SELECT tx FROM trip_suggestions WHERE trip=?)
               AND trip IS NULL AND manual_trip=0 AND kind='purchase'""", (trip_id, trip_id))

def allocate(db, data, *, system=False):
    credit_key, purchase_key = data.get("credit"), data.get("purchase")
    credit = require_transaction(db, credit_key)
    if credit["kind"] != "credit":
        raise ValueError("The incoming transaction must be a refund or reimbursement.")
    if data.get("action") == "assign":
        category = data.get("category")
        if category in TRANSFER_CATEGORIES:
            patch_transaction(db, credit_key, {"category": category})
            save_credit_assignment(db, credit_key, "", "exclude", "manual", "You classified this as a transfer or card payment.")
            return
        if not isinstance(category, str) or category not in EXPENSE_CATEGORIES | {"unassigned", "exclude"}:
            raise ValueError("Choose a spending category or a treatment.")
        treatment = "apply" if category in EXPENSE_CATEGORIES else category
        db.execute("DELETE FROM allocations WHERE credit=?", (credit_key,))
        db.execute("DELETE FROM dismissed_credits WHERE credit=?", (credit_key,))
        save_credit_assignment(db, credit_key, category if treatment == "apply" else "", treatment,
                               "manual", "You set this treatment.")
        return
    if data.get("action") == "dismiss":
        db.execute("INSERT OR IGNORE INTO dismissed_credits VALUES (?)", (credit_key,))
        return
    if data.get("action") == "restore":
        db.execute("DELETE FROM dismissed_credits WHERE credit=?", (credit_key,))
        return
    if data.get("action") == "remove":
        db.execute("DELETE FROM allocations WHERE credit=? AND purchase=?", (credit_key, purchase_key))
        save_credit_assignment(db, credit_key, "", "unassigned", "manual", "You removed a purchase allocation.")
        return
    purchase = require_transaction(db, purchase_key)
    amount = cents(data.get("amount"))
    if purchase["kind"] != "purchase" or credit["currency"] != purchase["currency"] or amount <= 0:
        raise ValueError("Choose a purchase in the same currency and a positive amount.")
    credit_remaining = -credit["amount"] - db.execute(
        "SELECT COALESCE(SUM(amount),0) FROM allocations WHERE credit=? AND purchase<>?", (credit_key, purchase_key)).fetchone()[0]
    purchase_remaining = purchase["amount"] - db.execute(
        "SELECT COALESCE(SUM(amount),0) FROM allocations WHERE purchase=? AND credit<>?", (purchase_key, credit_key)).fetchone()[0]
    if amount > min(credit_remaining, purchase_remaining):
        raise ValueError("The allocation is larger than the unallocated credit or purchase balance.")
    db.execute("INSERT OR REPLACE INTO allocations VALUES (?,?,?)", (credit_key, purchase_key, amount))
    db.execute("DELETE FROM dismissed_credits WHERE credit=?", (credit_key,))
    if not system:
        save_credit_assignment(db, credit_key, "", "unassigned", "manual", "You assigned this credit to a purchase.")

def save_credit_assignment(db, identifier, category, treatment, source, reason):
    db.execute("INSERT OR REPLACE INTO credit_assignments VALUES (?,?,?,?,?)",
               (identifier, category, treatment, source, reason))

def categorize_credits(db):
    peer_food = setting(db, "peer_food_default") == "1"
    purchases = [dict(r) for r in db.execute("""SELECT tx.*,accounts.label AS account_label,
                COALESCE(tc.event_at,'') AS event_at, amount-COALESCE((SELECT SUM(amount)
                FROM allocations WHERE purchase=tx.id),0) AS available FROM tx
                JOIN accounts ON accounts.id=tx.account LEFT JOIN transaction_context tc ON tc.tx=tx.id
                WHERE kind='purchase'""")]
    rows = db.execute("""SELECT tx.*,ca.source AS decision_source,accounts.label AS account_label,
                      COALESCE(tc.event_at,'') AS event_at FROM tx LEFT JOIN credit_assignments AS ca ON ca.credit=tx.id
                      JOIN accounts ON accounts.id=tx.account LEFT JOIN transaction_context tc ON tc.tx=tx.id
                      WHERE tx.kind='credit' AND (ca.credit IS NULL OR (ca.source='automatic' AND ca.treatment='unassigned')
                      OR (ca.source='reference' AND ca.treatment='apply'))
                      AND NOT EXISTS (SELECT 1 FROM allocations WHERE credit=tx.id)
                      AND NOT EXISTS (SELECT 1 FROM dismissed_credits WHERE credit=tx.id) ORDER BY tx.date,tx.id""").fetchall()
    purchase_lookup = {r["id"]: r for r in purchases}
    assigned = 0
    for row in rows:
        row = dict(row)
        name = normalize(row["merchant"] or row["description"])
        description = normalize(row["merchant"] + " " + row["description"] + " " + row["memo"])
        category = row["source_category"]
        if is_venmo(row, row["account_label"]) and FOOD_MEMO.search(description):
            meal = meal_match(row, purchases)
            if meal:
                value = -row["amount"]
                allocate(db, {"credit": row["id"], "purchase": meal, "amount": Decimal(value)/100}, system=True)
                purchase_lookup[meal]["available"] -= value
                save_credit_assignment(db, row["id"], "", "unassigned", "automatic",
                    "Closest preceding meal within three days, with a payment close to half the bill.")
            else:
                save_credit_assignment(db, row["id"], "dining_drinks", "apply", "automatic",
                    "The Venmo memo identifies a meal. No reliable individual purchase match was found.")
            assigned += 1
            continue
        matches = credit_candidates(row, purchases)
        exact = [m for m in matches if m["score"] >= 10 and m["amount"] == -row["amount"]
                 and normalize(purchase_lookup[m["id"]]["merchant"] or purchase_lookup[m["id"]]["description"]) == name]
        transfer_like = category in (*TRANSFER_CATEGORIES, "income") or any(token in description for token in
            ("zelle", "venmo", "cash app", "paypal", "cash reward", "statement credit", "reward redemption", "payroll"))
        if len(name) >= 4 and len(exact) == 1 and not transfer_like:
            match = exact[0]
            allocate(db, {"credit": row["id"], "purchase": match["id"], "amount": Decimal(match["amount"]) / 100},
                     system=True)
            purchase_lookup[match["id"]]["available"] -= match["amount"]
            save_credit_assignment(db, row["id"], "", "unassigned", row["decision_source"] or "automatic",
                                   "Matched the same merchant and amount.")
            assigned += 1
        elif row["decision_source"] == "reference":
            continue
        elif name == "amazon" and "amazon refund" in description:
            save_credit_assignment(db, row["id"], "shopping", "apply", "automatic",
                                   "The posted transaction explicitly identifies an Amazon refund.")
            assigned += 1
        elif peer_food and (food := food_peer_default(row, row["account_label"])):
            save_credit_assignment(db, row["id"], food, "apply", "automatic",
                                   "Your food reimbursement default for an ordinary Venmo or Zelle receipt.")
            assigned += 1
        elif category in EXPENSE_CATEGORIES - {"other"} and not transfer_like and (
            row["source_confidence"].casefold() in {"high", "very_high"} or
            any(token in description for token in ("refund", "reimbursement", "return credit"))):
            save_credit_assignment(db, row["id"], category, "apply", "automatic",
                                   "The merchant credit carries the source spending category.")
            assigned += 1
        else:
            save_credit_assignment(db, row["id"], "", "unassigned", "automatic",
                                   "The source gives insufficient evidence of a spending category.")
    return assigned

def data_view(db):
    accounts = [dict(r) for r in db.execute("""SELECT accounts.*, MIN(tx.date) AS first, MAX(tx.date) AS last,
                COUNT(tx.id) AS transactions FROM accounts LEFT JOIN tx ON tx.account=accounts.id
                GROUP BY accounts.id ORDER BY label""")]
    rows = [dict(r) for r in db.execute("""SELECT tx.*, COALESCE((SELECT SUM(amount) FROM allocations
                                        WHERE purchase=tx.id),0) AS offset FROM tx ORDER BY date DESC, id""")]
    trips = [dict(r) for r in db.execute("""SELECT trips.*, COALESCE(reference_trips.booking,0) AS booking,
                 (SELECT COUNT(*) FROM trip_suggestions WHERE trip_suggestions.trip=trips.id) AS suggested_count
                 FROM trips LEFT JOIN reference_trips ON reference_trips.trip=trips.id
                 WHERE status<>'dismissed' ORDER BY start DESC, trips.id DESC""")]
    purchase_rows = []
    for row in rows:
        if row["kind"] == "purchase":
            purchase_rows.append({**row, "available": row["amount"] - row["offset"]})
    links = defaultdict(list)
    purchase_credits = defaultdict(list)
    for row in db.execute("SELECT * FROM allocations"):
        links[row["credit"]].append(dict(row))
        purchase_credits[row["purchase"]].append({"credit": row["credit"], "amount": row["amount"]})
    dismissed = {r["credit"] for r in db.execute("SELECT * FROM dismissed_credits")}
    decisions = {r["credit"]: dict(r) for r in db.execute("SELECT * FROM credit_assignments")}
    amazon = {r["tx"]: {
        "reference": r["order_ref"], "items": json.loads(r["items"]),
        "date": r["order_date"], "total": r["total"], "currency": r["currency"],
        "payment_date": r["paid_on"], "payment_amount": r["payment_amount"], "last_four": r["last_four"],
        "match_basis": r["match_basis"],
    } for r in db.execute("""SELECT m.tx,m.order_ref,m.items,m.match_basis,c.order_date,c.total,c.currency,
                            p.paid_on,p.amount AS payment_amount,p.last_four
                            FROM amazon_matches m
                            LEFT JOIN amazon_order_cache c ON c.order_ref=m.order_ref
                            LEFT JOIN amazon_order_payment p ON p.order_ref=m.order_ref""")}
    receipts = [dict(r) for r in db.execute("SELECT id,date,amount,transaction_id,status FROM costco_receipts ORDER BY date DESC")]
    shopping = {r["tx"]: dict(r) for r in db.execute("SELECT * FROM shopping_subcategories")}
    for row in rows:
        if row["kind"] == "purchase" and row["category"] in {"shopping", "health_wellness"}:
            entry = shopping.get(row["id"])
            row["shopping_subcategory"] = entry["subcategory"] if entry else (
                "health_wellness" if row["category"] == "health_wellness" else "general")
            if entry:
                row["shopping_subcategory_reason"] = entry["reason"]
        if row["id"] in amazon:
            row["amazon_items"] = amazon[row["id"]]["items"]
            row["amazon_order"] = amazon[row["id"]]
        if row["id"] in purchase_credits:
            row["applied_credits"] = purchase_credits[row["id"]]
        if row["kind"] == "credit":
            row["links"] = links[row["id"]]
            row["remaining"] = -row["amount"] - sum(link["amount"] for link in row["links"])
            row["dismissed"] = row["id"] in dismissed
            row["assignment"] = decisions.get(row["id"])
            row["direct_offset"] = (row["remaining"] if row["assignment"] and
                                    row["assignment"]["treatment"] == "apply" and not row["dismissed"] else 0)
            if row["direct_offset"]:
                row["remaining"] = 0
            row["matches"] = (credit_candidates(row, purchase_rows)
                              if not row["dismissed"] and row["remaining"] > 0 and
                              (not row["assignment"] or row["assignment"]["treatment"] != "exclude") else [])
    display = {row["tx"]: dict(row) for row in db.execute("SELECT * FROM transaction_display")}
    for row in rows:
        if override := display.get(row["id"]):
            if override.get("merchant"):
                row["assigned_merchant"] = override["merchant"]
            if override["label"]:
                row["posted_merchant"] = row["merchant"] or row["description"]
                row["merchant"] = override["label"]
            if override["date"]:
                row["posted_date"] = row["date"]
                row["date"] = override["date"]
    if display:
        rows.sort(key=lambda row: row["date"], reverse=True)
    return {"accounts": accounts, "transactions": rows, "trips": trips, "categories": CATEGORIES,
            "transfer_categories": TRANSFER_CATEGORIES, "unverified_categories": UNVERIFIED_CATEGORIES,
            "shopping_subcategories": SHOPPING_SUBCATEGORIES,
            "amazon_count": len(amazon), "costco_receipts": receipts,
            "home": setting(db, "home"), "model": bool(os.environ.get("FINANCE_OLLAMA_MODEL"))}
