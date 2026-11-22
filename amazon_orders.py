"""Match Amazon order exports to posted card charges without using browser credentials."""
import csv
import io
import json
import re
import secrets
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

from intelligence import days, normalize
from ledger import cents, connect, iso_date, now, setting

MAX_BYTES = 25_000_000
AMAZON = re.compile(r"\b(amazon|amzn|amazon com|amazon marketplace)\b")
NON_RETAIL = re.compile(r"\b(prime|digital|audible|aws|web services|kindle unlimited)\b")

def amount_tolerance(amount):
    return min(150, max(10, amount // 100))

def product_category(title):
    if re.search(r"\b(pet food|dog food|cat food|cat litter|dog treats|pet supplies)\b", title):
        return "pets"
    if re.search(r"\b(thermometer|glucose meter|blood pressure monitor|prescription|medical device)\b", title):
        return "medical"
    if re.search(r"\b(shampoo|conditioner|toothpaste|toothbrush|mouthwash|sunscreen|razor|vitamins?|supplements?|"
                 r"detergent|dish soap|cleaning wipes|paper towels?|toilet paper|hand soap|household cleaner|"
                 r"skin care|skincare|deodorant|moisturizer|face wash|body wash)\b", title):
        return "health_wellness"
    if re.search(r"\b(coffee beans|ground coffee|cereal|snack bars?|tea bags?|pasta sauce|olive oil|grocery)\b", title):
        return "groceries"
    return "shopping"

def order_date(value):
    try:
        return iso_date(value[:10])
    except ValueError:
        for pattern in ("%B %d, %Y", "%b %d, %Y"):
            try:
                return datetime.strptime(value, pattern).date().isoformat()
            except ValueError:
                continue
    raise ValueError("Invalid Amazon order or payment date.")

def parse_orders(data, filename):
    suffix = Path(filename).suffix.lower()
    if suffix == ".zip":
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            candidates = [m for m in archive.infolist() if m.filename.lower().endswith(".csv") and
                          "retail.orderhistory" in m.filename.lower()]
            if len(candidates) != 1 or candidates[0].file_size > MAX_BYTES:
                raise ValueError("The archive must contain one supported Retail.OrderHistory CSV.")
            data = archive.read(candidates[0])
            suffix = ".csv"
    if suffix == ".json":
        rows = json.loads(data)
        if not isinstance(rows, list):
            raise ValueError("Expected a JSON array of orders.")
    elif suffix == ".csv":
        reader = csv.DictReader(io.StringIO(data.decode("utf-8-sig")))
        fields = {normalize(field) for field in (reader.fieldnames or [])}
        if not {"order id", "order date"}.issubset(fields) or not fields.intersection({"total owed", "order total", "total"}):
            raise ValueError("The order CSV needs Order ID, Order Date, and Total Owed or Order Total.")
        rows = []
        for raw in reader:
            row = {normalize(key): str(value or "").strip() for key, value in raw.items()}
            rows.append({"id": row.get("order id"), "date": row.get("order date"),
                         "total": row.get("order total") or row.get("total owed") or row.get("total"),
                         "currency": row.get("currency"),
                         "items": [row.get("product name") or row.get("title") or ""],
                         "cancelled": "cancel" in (row.get("order status", "") + row.get("shipment status", "")).lower()})
    else:
        raise ValueError("Use an Amazon retail order CSV, ZIP, or normalized JSON.")
    grouped = defaultdict(list)
    payment_evidence = set()
    for raw in rows:
        if not isinstance(raw, dict):
            raise ValueError("Each order must be an object.")
        identifier = str(raw.get("id") or "").strip()
        if not identifier or len(identifier) > 80 or raw.get("cancelled") or not raw.get("date") or not raw.get("total"):
            continue
        items = raw.get("items")
        if not isinstance(items, list):
            raise ValueError("Order items must be a list of product titles.")
        total = cents(raw["total"])
        payment = raw.get("payment")
        if payment is not None:
            payment_evidence.add(identifier)
        last_four = str(payment.get("last_four") or "") if isinstance(payment, dict) else ""
        paid = cents(payment["amount"]) if re.fullmatch(r"[0-9]{4}", last_four) and payment.get("amount") else None
        if total > 0:
            grouped[identifier].append((order_date(str(raw["date"])), total,
                                       str(raw.get("currency") or "USD").upper().strip(),
                                       [str(title).strip()[:300] for title in items if title],
                                       (last_four, paid, order_date(payment["date"]))
                                       if paid and paid > 0 and abs(paid - total) <= amount_tolerance(total)
                                       and payment.get("date") else None))
    orders = []
    for identifier, entries in grouped.items():
        # Exports may repeat an order total on every item. Conflicting amounts may
        # be item or shipment totals, so leave those orders out of automatic matching.
        signatures = {(d, total, currency) for d, total, currency, _, _ in entries}
        if len(signatures) != 1:
            continue
        date, total, currency = signatures.pop()
        items = list(dict.fromkeys(title for _, _, _, titles, _ in entries for title in titles if title))
        payments = {payment for *_, payment in entries if payment}
        if items:
            payment = payments.pop() if len(payments) == 1 else None
            orders.append({"id": identifier, "date": date, "total": total, "currency": currency, "items": items,
                           "payment": payment, "payment_excluded": identifier in payment_evidence and payment is None})
    if not orders:
        raise ValueError("No readable orders with product titles and a consistent total were found.")
    return orders

def read_orders(path):
    path = Path(path)
    if path.stat().st_size > MAX_BYTES:
        raise ValueError("The order export exceeds 25 MB.")
    try:
        return parse_orders(path.read_bytes(), path.name)
    except zipfile.BadZipFile as error:
        raise ValueError("The file is not a valid Amazon order ZIP.") from error

def stage_orders(rows):
    data = json.dumps(rows, ensure_ascii=False).encode()
    if len(data) > MAX_BYTES:
        raise ValueError("The order snapshot exceeds 25 MB.")
    orders = parse_orders(data, "chrome.json")
    with connect(write=True) as db:
        return save_orders(db, orders)

def save_orders(db, orders):
    for row in orders:
        db.execute("""DELETE FROM amazon_order_payment WHERE order_ref=? AND EXISTS
                      (SELECT 1 FROM amazon_order_cache WHERE order_ref=? AND
                       (order_date<>? OR total<>? OR currency<>?))""",
                   (row["id"], row["id"], row["date"], row["total"], row["currency"]))
    db.executemany("""INSERT INTO amazon_order_cache VALUES(?,?,?,?,?) ON CONFLICT(order_ref) DO UPDATE SET
                   order_date=excluded.order_date,total=excluded.total,currency=excluded.currency,items=excluded.items""",
                   ((r["id"], r["date"], r["total"], r["currency"], json.dumps(r["items"])) for r in orders))
    db.executemany("INSERT OR REPLACE INTO amazon_order_payment VALUES(?,?,?,?)",
                   ((row["id"], *row["payment"]) for row in orders if row["payment"]))
    db.executemany("DELETE FROM amazon_payment_exclusions WHERE order_ref=?",
                   ((row["id"],) for row in orders if row["payment"]))
    excluded = [(row["id"],) for row in orders if row.get("payment_excluded")]
    db.executemany("DELETE FROM amazon_order_payment WHERE order_ref=?", excluded)
    db.executemany("INSERT OR IGNORE INTO amazon_payment_exclusions VALUES(?)", excluded)
    db.execute("INSERT OR REPLACE INTO settings VALUES('amazon_capture_at',?)", (now(),))
    return {"received": len(orders), "cached": db.execute("SELECT COUNT(*) FROM amazon_order_cache").fetchone()[0]}

def browser_orders():
    with connect() as db:
        return [{"id": r["order_ref"], "date": r["order_date"], "total": r["total"],
                 "currency": r["currency"], "items": json.loads(r["items"]),
                 "payment": (r["last_four"], r["paid"], r["paid_on"]) if r["last_four"] and r["paid_on"] else None,
                 "payment_excluded": bool(r["excluded"])}
                for r in db.execute("""SELECT amazon_order_cache.*,last_four,amount AS paid,paid_on,excluded FROM amazon_order_cache
                    LEFT JOIN amazon_order_payment USING(order_ref)
                    LEFT JOIN (SELECT order_ref,1 AS excluded FROM amazon_payment_exclusions) USING(order_ref)
                    ORDER BY order_date DESC""")]

def stage_payments(db, rows):
    by_order = defaultdict(list)
    for row in rows:
        if not isinstance(row, dict):
            raise ValueError("Each payment must be an object.")
        order = str(row.get("id") or "")
        last_four = str(row.get("last_four") or "")
        if re.fullmatch(r"[0-9]{3}-[0-9]{7}-[0-9]{7}", order) and re.fullmatch(r"[0-9]{4}", last_four):
            by_order[order].append((last_four, cents(row["amount"]), order_date(str(row["date"])), row.get("currency")))
    saved = 0
    for order, payments in by_order.items():
        record = db.execute("SELECT total,currency FROM amazon_order_cache WHERE order_ref=?", (order,)).fetchone()
        if not record:
            continue
        if len(payments) == 1:
            last_four, amount, paid_on, currency = payments[0]
            if amount > 0 and abs(amount - record["total"]) <= amount_tolerance(record["total"]) and currency == record["currency"]:
                db.execute("INSERT OR REPLACE INTO amazon_order_payment VALUES(?,?,?,?)", (order,last_four,amount,paid_on))
                db.execute("DELETE FROM amazon_payment_exclusions WHERE order_ref=?", (order,))
                saved += 1
                continue
        db.execute("DELETE FROM amazon_order_payment WHERE order_ref=?", (order,))
        db.execute("INSERT OR IGNORE INTO amazon_payment_exclusions VALUES(?)", (order,))
    return {"payments_seen": sum(map(len, by_order.values())), "payments_verified": saved}

def browser_status(db):
    info = dict(db.execute("""SELECT COUNT(*) AS orders, MIN(order_date) AS first_order,
                              MAX(order_date) AS last_order FROM amazon_order_cache""").fetchone())
    info["captured_at"] = setting(db, "amazon_capture_at")
    info["completed_payment_records"] = db.execute("SELECT COUNT(*) FROM amazon_order_payment").fetchone()[0]
    info["browser_ready"] = {mode: recent(setting(db, "amazon_browser_seen_" + mode), 15)
                             for mode in ("orders", "payments")}
    job = db.execute("SELECT state,updated,result FROM amazon_browser_job").fetchone()
    info["job"] = {**dict(job), "result": json.loads(job["result"])} if job else None
    return info

def recent(value, seconds):
    return bool(value and (datetime.now(timezone.utc) - datetime.fromisoformat(value)).total_seconds() < seconds)

def request_browser_sync(mode):
    if mode not in ("orders", "payments"):
        raise ValueError("Unknown Amazon sync mode.")
    with connect(write=True) as db:
        if not recent(setting(db, "amazon_browser_seen_" + mode), 15):
            raise ValueError(f"Connect the signed-in Amazon {mode.title()} tab in the Chrome connector.")
        current = db.execute("SELECT state,updated,result FROM amazon_browser_job").fetchone()
        if current and current["state"] in {"queued", "running"} and recent(current["updated"], 120):
            return {"state": current["state"], "mode": json.loads(current["result"])["mode"]}
        db.execute("INSERT OR REPLACE INTO amazon_browser_job VALUES(1,?,'queued',?,?)",
                   (secrets.token_urlsafe(24), now(), json.dumps({"mode": mode})))
        return {"state": "queued", "mode": mode}

def browser_bridge(data):
    action = data.get("action")
    mode = data.get("mode")
    if action not in ("poll", "finish") or mode not in ("orders", "payments"):
        raise ValueError("Unknown browser connector action.")
    with connect(write=True) as db:
        if action == "poll":
            db.execute("INSERT OR REPLACE INTO settings VALUES(?,?)", ("amazon_browser_seen_" + mode, now()))
            row = db.execute("SELECT job_id,updated,result FROM amazon_browser_job WHERE state='queued'").fetchone()
            if row and recent(row["updated"], 60) and json.loads(row["result"])["mode"] == mode:
                db.execute("UPDATE amazon_browser_job SET state='running',updated=? WHERE singleton=1", (now(),))
                return {"job": row["job_id"]}
            return {"job": None}
        job = db.execute("SELECT job_id,updated,result FROM amazon_browser_job WHERE state='running'").fetchone()
        if (not job or job["job_id"] != data.get("job") or not recent(job["updated"], 120)
                or json.loads(job["result"])["mode"] != mode):
            raise ValueError("There is no active browser sync for this result.")
        rows = data.get("rows")
        if not isinstance(rows, list) or len(rows) > 2500:
            raise ValueError("Expected up to 2,500 Amazon records.")
        counts = {}
        if rows:
            counts = stage_payments(db, rows) if mode == "payments" else save_orders(
                db, parse_orders(json.dumps(rows).encode(), "chrome.json"))
        state = "complete" if data.get("complete") is True and counts else "partial" if counts else "blocked"
        result = {**counts, "state": state, "mode": mode}
        db.execute("UPDATE amazon_browser_job SET state=?,updated=?,result=? WHERE singleton=1",
                   (state, now(), json.dumps(result)))
        return result

def amazon_charges(db):
    by_amount = defaultdict(list)
    for result in db.execute("""SELECT id,tx.account,date,currency,amount,merchant,description,manual_category,
        COALESCE(statement_card_masks.last_four, amazon_eligible_cards.last_four) AS last_four,
        (SELECT order_ref FROM amazon_matches WHERE tx=tx.id) AS recorded_order FROM tx
        JOIN amazon_eligible_cards ON amazon_eligible_cards.account=tx.account
        LEFT JOIN statement_card_masks ON statement_card_masks.tx=tx.id
        WHERE amount>0 AND kind='purchase'"""):
        if AMAZON.search(normalize(result["merchant"] + " " + result["description"])):
            by_amount[result["currency"], result["amount"]].append(dict(result))
    return by_amount

def reconcile_orders(orders, apply=False):
    with connect(write=apply) as db:
        charges = [row for bucket in amazon_charges(db).values() for row in bucket]
        card_history = defaultdict(set)
        for account, mask in db.execute("""SELECT account,last_four FROM amazon_eligible_cards
            UNION SELECT tx.account,statement_card_masks.last_four FROM statement_card_masks
            JOIN tx ON tx.id=statement_card_masks.tx JOIN amazon_eligible_cards ON amazon_eligible_cards.account=tx.account"""):
            card_history[account].add(mask)
        existing = {r["order_ref"] for r in db.execute("SELECT order_ref FROM amazon_matches")}
        reserved = {row["id"] for row in charges if row["recorded_order"]}
        tiers = {"card_exact": {}, "card_fuzzy": {}, "date_amount": {}}
        count = Counter({"orders_read": len(orders), "amazon_charges": len(charges)})
        for order in orders:
            if order["id"] in existing:
                count["previously_matched"] += 1
                continue
            if order.get("payment_excluded"):
                count["split_or_unverified_payment"] += 1
                continue
            rows = [row for row in charges if row["currency"] == order["currency"]]
            if order.get("payment"):
                last_four, amount, paid_on = order["payment"]
                nearby = [row for row in rows if -1 <= days(paid_on, row["date"]) <= 4]
                exact = [row for row in nearby if row["amount"] == amount and last_four in card_history[row["account"]]]
                near = [row for row in nearby if row["last_four"] == last_four and
                        abs(row["amount"] - amount) <= amount_tolerance(amount)]
                if not exact and not near:
                    count["unmatched_or_ambiguous_card"] += 1
                    continue
                tier, candidates = ("card_exact", exact) if exact else ("card_fuzzy", near)
            else:
                tier = "date_amount"
                candidates = []
                for row in rows:
                    if NON_RETAIL.search(normalize(row["merchant"] + " " + row["description"])):
                        continue
                    delta = abs(row["amount"] - order["total"])
                    lag = days(order["date"], row["date"])
                    if (delta == 0 and -1 <= lag <= 7) or (delta <= 25 and 0 <= lag <= 2):
                        candidates.append(row)
                if not candidates:
                    count["no_candidate_charge"] += 1
                    continue
            tiers[tier][order["id"]] = (order, candidates)
        for basis, candidates_by_order in tiers.items():
            claims = Counter(row["id"] for _, candidates in candidates_by_order.values() for row in candidates)
            for order, candidates in candidates_by_order.values():
                if len(candidates) != 1 or claims[candidates[0]["id"]] != 1:
                    count["competing_orders"] += 1
                    continue
                row = candidates[0]
                if row["id"] in reserved:
                    count["conflicting_existing_match" if row["recorded_order"] else "competing_orders"] += 1
                    continue
                count["matched"] += 1
                count[basis] += 1
                categories = {product_category(normalize(title)) for title in order["items"]}
                category = next(iter(categories)) if len(categories) == 1 else None
                count["mixed"] += category is None
                categorize = basis != "date_amount" and not row["manual_category"]
                count["categorized"] += bool(category and categorize)
                if apply:
                    db.execute("INSERT INTO amazon_matches(tx,order_ref,items,match_basis) VALUES(?,?,?,?)",
                               (row["id"], order["id"], json.dumps(order["items"]), basis))
                    if category and categorize:
                        reason = "Matched the completed Amazon payment to the same card and a nearby posting."
                        db.execute("UPDATE tx SET category=?,reason=?,review=0 WHERE id=?", (category, reason, row["id"]))
                    elif categorize:
                        db.execute("UPDATE tx SET reason=?,review=1 WHERE id=?",
                                   ("Matched an Amazon order with items from several categories.", row["id"]))
            # A weaker match cannot claim a charge with stronger, even conflicting, evidence.
            reserved.update(claims)
        return dict(count)
