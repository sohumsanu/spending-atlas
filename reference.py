"""Reconcile purchase evidence from a saved ChatGPT spending dashboard."""
import json
from collections import Counter, defaultdict

from intelligence import normalize
from ledger import cents, connect, iso_date, rebuild_trips

BOOKING_MARKERS = ("unconfirmed", "unassigned", "cancelled", "canceled")

def read_dashboard(text):
    marker = "const ORIGINAL="
    if marker not in text:
        raise ValueError("This file has no supported spending dashboard transaction table.")
    rows, _ = json.JSONDecoder().raw_decode(text.split(marker, 1)[1].lstrip())
    if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
        raise ValueError("The reference transaction table is invalid.")
    return rows

def reconcile_dashboard(rows):
    report = Counter()
    groups = defaultdict(list)
    with connect(write=True) as db:
        for raw in rows:
            if not raw.get("date") or not raw.get("id") or not raw.get("source"):
                continue
            date = iso_date(raw["date"])
            amount = cents(raw["source"])
            tx = db.execute("SELECT * FROM tx WHERE id=? AND date=? AND amount=? AND currency='USD'",
                            ("finances:" + str(raw["id"]), date, amount)).fetchone()
            if not tx:
                report["unmatched_dated_rows"] += 1
                continue
            if raw.get("treatment") != "Include" or amount <= 0:
                continue
            if raw.get("category") == "Housing & deposits" and not tx["manual_category"]:
                if (tx["category"], tx["kind"]) != ("housing", "purchase"):
                    note = str(raw.get("note") or "").strip()
                    reason = "Classified as a housing outlay in the reference dashboard."
                    if "split is unknown" in note.lower():
                        reason += " The split between rent and refundable deposit is unknown."
                    db.execute("""UPDATE tx SET category='housing',kind='purchase',review=0,manual_category=1,reason=?
                                  WHERE id=?""", (reason, tx["id"]))
                    report["housing_restored"] += 1
                    report["housing_restored_cents"] += tx["amount"]
            label = str(raw.get("trip") or "").strip()[:150]
            if label and tx["kind"] == "purchase":
                groups[label].append(tx)

        for label, transactions in groups.items():
            booking = int(any(marker in normalize(label).split() for marker in BOOKING_MARKERS))
            existing = db.execute("SELECT trip FROM reference_trips WHERE label=?", (label,)).fetchone()
            if existing:
                trip_id = existing["trip"]
            else:
                dates = sorted(tx["date"] for tx in transactions)
                destination = label.split(" · ", 1)[0] if not booking else ""
                reason = "Matched to the reference dashboard by transaction ID, date, and amount."
                if booking:
                    reason = "Booking group from the reference dashboard. Trip or purpose is unconfirmed, unassigned, or cancelled."
                trip_id = db.execute("""INSERT INTO trips(name,destination,start,end,status,reason)
                    VALUES(?,?,?,?,'confirmed',?)""", (label, destination, dates[0], dates[-1], reason)).lastrowid
                db.execute("INSERT INTO reference_trips VALUES(?,?,?)", (trip_id, label, booking))
            report["booking_groups" if booking else "trips"] += 1
            for tx in transactions:
                if tx["manual_trip"]:
                    continue
                db.execute("UPDATE tx SET trip=?,manual_trip=1 WHERE id=?", (trip_id, tx["id"]))
                report["assigned_purchases"] += 1
        rebuild_trips(db)
    return dict(report)

def reconcile_credits(rows):
    """Import expense credit categories, leaving uncertain receipts visible."""
    from ledger import categorize_credits, save_credit_assignment

    category_map = {
        "Travel": "travel", "Shopping": "shopping", "Housing & deposits": "housing",
        "Services & subscriptions": "services", "Fees & interest": "financial",
        "Transportation": "transportation", "Other purchases": "other",
    }
    non_expense = {"Own-account transfers", "Card repayments", "Income / rewards", "Income & rewards"}
    counts = Counter()
    with connect(write=True) as db:
        for raw in rows:
            if not raw.get("date") or not raw.get("id") or not raw.get("source"):
                continue
            amount = cents(raw["source"])
            if amount >= 0:
                continue
            identifier = "finances:" + str(raw["id"])
            category = category_map.get(raw.get("category"))
            include = category and raw.get("treatment") == "Include"
            exclude = raw.get("treatment") == "Exclude" and raw.get("category") in non_expense
            if not include and not exclude:
                continue
            row = db.execute("SELECT * FROM tx WHERE id=? AND date=? AND amount=? AND currency='USD'",
                             (identifier, iso_date(raw["date"]), amount)).fetchone()
            if not row or row["manual_category"] or db.execute(
                "SELECT 1 FROM credit_assignments WHERE credit=?", (identifier,)
            ).fetchone() or db.execute("SELECT 1 FROM allocations WHERE credit=?", (identifier,)).fetchone():
                continue
            if include:
                if row["kind"] != "credit":
                    db.execute("UPDATE tx SET kind='credit',category='credits',reason=? WHERE id=?",
                               ("Classified as a spending credit in the reference dashboard.", identifier))
                if raw.get("match") and raw.get("allocated"):
                    save_credit_assignment(db, identifier, "", "unassigned", "reference",
                                           "The reference documents a purchase allocation or an unallocated remainder.")
                    continue
                save_credit_assignment(db, identifier, category, "apply", "reference",
                                       "The reference dashboard attributes this receipt to this expense category.")
                counts["reference_category_credits"] += 1
            elif row["kind"] == "credit":
                save_credit_assignment(db, identifier, "", "exclude", "reference",
                                       "The reference identifies this as " + raw["category"].lower() + ".")
                counts["reference_exclusions"] += 1
        counts["automatic_credits"] = categorize_credits(db)
    return dict(counts)

def reconcile_transfers(rows):
    """Use verified transfer labels without overriding app edits or purchase allocations."""
    labels = {"Own-account transfers": "transfers", "Card repayments": "card_payments"}
    counts = Counter()
    with connect(write=True) as db:
        for raw in rows:
            category = labels.get(raw.get("category"))
            if not category or raw.get("treatment") != "Exclude" or not raw.get("date") or not raw.get("source"):
                continue
            key = "finances:" + str(raw["id"])
            row = db.execute("""SELECT * FROM tx WHERE id=? AND date=? AND amount=? AND currency='USD'
                                AND manual_category=0 AND NOT EXISTS (
                                SELECT 1 FROM allocations WHERE credit=tx.id OR purchase=tx.id)
                                AND NOT EXISTS (
                                SELECT 1 FROM credit_assignments WHERE credit=tx.id AND source='manual')""",
                             (key, iso_date(raw["date"]), cents(raw["source"]))).fetchone()
            if row and (row["kind"], row["category"], row["review"]) != ("transfer", category, 0):
                db.execute("""UPDATE tx SET kind='transfer',category=?,review=0,reason=?,manual_category=1,trip=NULL
                              WHERE id=?""", (category, "Verified as " + raw["category"].lower() + " in the reference dashboard.", key))
                counts[category] += 1
    return dict(counts)
