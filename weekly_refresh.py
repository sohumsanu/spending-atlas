"""Prepare a paged Finances import and audit a Spending Atlas refresh."""
import argparse
import json
import os
import sqlite3
from collections import defaultdict
from datetime import date
from pathlib import Path

from ledger import cents, connect, data_view, iso_date, verified_statement_overlap


def prepare(folder, destination):
    source = sorted(folder.glob("finance-*.json"))
    if not source:
        raise ValueError("Save the Finances pages before preparing an import.")
    with connect() as db:
        db.execute("BEGIN")
        return prepare_rows(db, source, destination)


def prepare_rows(db, source, destination):
    transactions = {row["id"]: row for row in db.execute("SELECT * FROM tx")}
    corrected = {row["tx"]: row["upstream_amount"] for row in db.execute("SELECT * FROM statement_amounts")}
    known = {row["id"]: row for row in db.execute("SELECT * FROM accounts")}
    statement_amounts = defaultdict(list)
    for row in transactions.values():
        if not row["id"].startswith("finances:"):
            statement_amounts[row["account"], row["amount"], row["currency"]].append(row["date"])

    batches, report = [], []
    accounts, ids = set(), set()
    for file in source:
        document = json.loads(file.read_text())
        account, pages = document["account"], document["pages"]
        identifier = account["id"]
        if identifier in accounts or not isinstance(pages, list) or not pages or any(
            not isinstance(page, dict) or not isinstance(page.get("has_more"), bool) or
            page["has_more"] != (i < len(pages) - 1) or
            (page["has_more"] and (not isinstance(page.get("next_cursor"), str) or not page["next_cursor"]))
            for i, page in enumerate(pages)
        ):
            raise ValueError("An account is duplicated or its pagination is incomplete.")
        if any(not isinstance(page.get("items"), list) or any(not isinstance(row, dict) for row in page["items"])
               for page in pages):
            raise ValueError("A Finances page has no inline items. Fetch that account again with a smaller page size.")
        cursors = [page["next_cursor"] for page in pages if page["has_more"]]
        if len(set(cursors)) != len(cursors):
            raise ValueError("A Finances pagination cursor was repeated. Fetch that account again.")
        accounts.add(identifier)
        local_id = "finances:" + identifier
        label = known[local_id]["label"] if local_id in known else account["label"]
        raw = [row for page in pages for row in page["items"]]
        dates = [iso_date(row["date"]) for row in raw]
        first, last = (min(dates), max(dates)) if dates else (None, None)
        complete = all((page.get("coverage") or {}).get("is_complete_for_query") is True for page in pages)
        counts = {"matched": 0, "new": 0, "zero": 0, "pending": 0, "unresolved": []}
        additions = []
        for row, day in zip(raw, dates):
            key = row["transaction_id"]
            if row["account_id"] != identifier or not key or key in ids:
                raise ValueError("A transaction belongs to another account or appears more than once.")
            ids.add(key)
            if row.get("pending") is True:
                counts["pending"] += 1
                continue
            amount = cents(row["amount"])
            if amount == 0:
                counts["zero"] += 1
                continue
            currency = row.get("iso_currency_code")
            tx_id = "finances:" + key
            existing = transactions.get(tx_id)
            if existing:
                if (existing["account"], existing["date"], existing["currency"]) != (local_id, day, currency) or (
                    amount not in {existing["amount"], corrected.get(tx_id)}
                ):
                    counts["unresolved"].append({"id": key, "reason": "Source transaction fields disagree with the saved row."})
                else:
                    counts["matched"] += 1
                continue
            verified_overlap = verified_statement_overlap(db, {
                "account": local_id, "currency": currency, "amount": amount, "date": day})
            if (not currency or not (row.get("merchant_name") or row.get("name")) or verified_overlap or any(
                abs((date.fromisoformat(day) - date.fromisoformat(posted)).days) <= 4
                for posted in statement_amounts[local_id, amount, currency]
            )):
                counts["unresolved"].append({"id": key, "reason": "Missing posting fields or possible statement overlap."})
                continue
            category = row.get("personal_finance_category") or {}
            location = row.get("location") or {}
            counterparties = {item["name"] for item in row.get("counterparties") or [] if item.get("name")}
            additions.append({"id": key, "date": day, "amount": row["amount"], "currency": currency,
                              "merchant": row.get("merchant_name"), "description": row.get("name"),
                              "source_category": category.get("primary"), "source_detail": category.get("detailed"),
                              "source_confidence": category.get("confidence_level"), "channel": row.get("payment_channel"),
                              "city": location.get("city"), "region": location.get("region"), "country": location.get("country"),
                              "event_at": row.get("datetime"), "counterpart": next(iter(counterparties)) if len(counterparties) == 1 else "",
                              "linked_transfer": bool(row.get("transfer_transaction_id") or row.get("transfer_to_account_id"))})
            counts["new"] += 1
        arrival = f"Finances pull returned {len(raw)} rows, {first or 'no posting dates'} through {last or 'no posting dates'}."
        coverage = known[local_id]["coverage"] if local_id in known else arrival
        batches.append({"account": {"id": identifier, "label": label}, "rows": additions, "coverage": coverage})
        report.append({"account": label, "pages": len(pages), "fetched": len(raw), "first": first, "last": last,
                       "provider_marked_complete": complete, **counts})
    with destination.open("x", encoding="utf-8") as output:
        json.dump(batches, output, ensure_ascii=False)
    return report


def audit(db):
    if [row[0] for row in db.execute("PRAGMA integrity_check")] != ["ok"] or db.execute("PRAGMA foreign_key_check").fetchone():
        raise ValueError("Ledger integrity checks failed.")
    if db.execute("""SELECT 1 FROM allocations a JOIN tx c ON c.id=a.credit JOIN tx p ON p.id=a.purchase
        WHERE c.kind<>'credit' OR c.amount>=0 OR p.kind<>'purchase' OR p.amount<=0 OR c.currency<>p.currency
        OR p.amount<(SELECT SUM(amount) FROM allocations WHERE purchase=p.id)
        OR -c.amount<(SELECT SUM(amount) FROM allocations WHERE credit=c.id) LIMIT 1""").fetchone():
        raise ValueError("An allocation exceeds its balance or uses incompatible transactions.")
    totals = defaultdict(lambda: [0, 0, 0])
    view = data_view(db)
    for row in view["transactions"]:
        direct = row.get("direct_offset", 0)
        if direct:
            gross, credits, category = 0, direct, row["assignment"]["category"]
        elif row["amount"] > 0 and row["kind"] != "transfer":
            gross, credits, category = row["amount"], row["offset"], row["category"]
        else:
            continue
        for group in ("year:" + row["date"][:4], "month:" + row["date"][:7], "category:" + row["date"][:4] + ":" + category):
            values = totals[row["currency"] + ":" + group]
            values[0] += gross
            values[1] += credits
            values[2] += gross - credits
    return {"transactions": len(view["transactions"]), "allocations": db.execute("SELECT COUNT(*) FROM allocations").fetchone()[0],
            "account_coverage": [{k: row[k] for k in ("label", "first", "last", "transactions")} for row in view["accounts"]],
            "totals_in_cents_gross_credits_net": dict(sorted(totals.items()))}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    stage = commands.add_parser("prepare")
    stage.add_argument("folder", type=Path)
    stage.add_argument("destination", type=Path)
    verify = commands.add_parser("audit")
    verify.add_argument("database", type=Path, nargs="?")
    args = parser.parse_args()
    if args.command == "prepare":
        result = prepare(args.folder, args.destination)
    elif args.database:
        with sqlite3.connect(args.database.resolve().as_uri() + "?mode=ro", uri=True) as db:
            db.row_factory = sqlite3.Row
            result = audit(db)
    else:
        with connect() as db:
            db.execute("BEGIN")
            result = audit(db)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
