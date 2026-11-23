"""Preview and import a bank CSV locally, one account at a time."""
import csv
import hashlib
import io
import json
import re
from collections import Counter, defaultdict
from datetime import date
from decimal import Decimal

from ledger import cents, connect, csv_payload, import_transactions, normalize, normalize_row

ALIASES = {
    "date": ("posting date", "posted date", "date posted", "date", "transaction date", "trans date", "booking date"),
    "description": ("description", "transaction description", "merchant", "merchant name", "payee", "name", "details"),
    "amount": ("amount", "transaction amount", "signed amount", "net amount"),
    "debit": ("debit", "debits", "debit amount", "withdrawal", "withdrawals", "money out", "charges"),
    "credit": ("credit", "credits", "credit amount", "deposit", "deposits", "money in"),
    "direction": ("transaction type", "debit credit", "credit debit", "direction", "type"),
    "currency": ("currency", "currency code", "iso currency code"),
    "reference": ("transaction id", "transaction identifier", "id", "fitid"),
    "status": ("status", "transaction status", "posting status"),
}
OUTFLOW = {"debit", "withdrawal", "purchase", "outflow", "dr"}
INFLOW = {"credit", "deposit", "refund", "inflow", "cr"}
EXTRA_FIELDS = ("city", "region", "country", "channel", "travel_date", "memo",
                "source_category", "source_detail", "source_confidence")


def read_bank_csv(content):
    if not isinstance(content, str) or not content.strip() or len(content) > 8_000_000:
        raise ValueError("Choose a CSV file under 8 MB.")
    content = content.lstrip("\ufeff")
    if "\x00" in content or content.startswith(("%PDF", "PK\x03\x04")):
        raise ValueError("Download transactions as a CSV from your bank. PDF statements and spreadsheets need a CSV export first.")
    fallback = None
    for delimiter in (",", ";", "\t"):
        reader = csv.reader(io.StringIO(content, newline=""), delimiter=delimiter, strict=True)
        try:
            lines = [(reader.line_num, row) for row in reader]
        except csv.Error:
            continue
        for index, (_, row) in enumerate(lines[:20]):
            if len(row) < 3:
                continue
            names = [re.sub(r"[^a-z0-9]+", " ", cell.casefold()).strip() for cell in row]
            hints = {key: next((names.index(alias) for alias in aliases if alias in names), None)
                     for key, aliases in ALIASES.items()}
            recognized = (hints["date"] is not None and hints["description"] is not None and
                          (hints["amount"] is not None or hints["debit"] is not None or hints["credit"] is not None))
            if recognized:
                if len(lines) - index - 1 > 30_000 or len(row) > 100:
                    raise ValueError("Use a CSV with at most 30,000 transactions and 100 columns.")
                return row, hints, lines[index + 1:]
            if index == 0 and len(set(names) - {""}) >= 3 and len(row) <= 100 and len(lines) <= 30_001:
                if any(len(item) == len(row) for _, item in lines[1:21]):
                    fallback = fallback or (row, hints, lines[1:])
    if fallback:
        return fallback
    raise ValueError("I couldn’t find a CSV header. Export transaction activity with column names and one account per file.")


def inspect(content):
    columns, hints, _ = read_bank_csv(content)
    mode = "split" if hints["debit"] is not None and hints["credit"] is not None else (
        "typed" if hints["direction"] is not None and hints["amount"] is not None else "signed")
    return {"columns": columns, "mapping": hints, "mode": mode}


def records_for(data):
    columns, _, entries = read_bank_csv(data.get("content"))
    account = data.get("account")
    mapping = data.get("mapping")
    mode = data.get("mode")
    convention = data.get("convention")
    currency = data.get("currency") or "USD"
    if not isinstance(account, str) or not normalize(account) or len(account.strip()) > 120:
        raise ValueError("Choose or enter an account nickname, using at most the last four account digits.")
    if not isinstance(mapping, dict) or mode not in {"signed", "split", "typed"}:
        raise ValueError("Choose how the file lists amounts.")
    if mode == "signed" and convention not in {"debits_positive", "debits_negative"}:
        raise ValueError("Select whether purchases and withdrawals are positive or negative in the CSV.")
    if not isinstance(currency, str) or not re.fullmatch(r"[A-Za-z]{3}", currency):
        raise ValueError("Enter a three-letter currency such as USD or CAD.")
    required = {"date", "description"} | ({"debit", "credit"} if mode == "split" else {"amount"})
    if mode == "typed":
        required.add("direction")
    for key in required | {"reference", "currency", "status"}:
        column = mapping.get(key)
        if column is None and key not in required:
            continue
        if type(column) is not int or not 0 <= column < len(columns):
            raise ValueError("Choose a column for " + key + ".")
    if len({mapping[key] for key in required}) != len(required):
        raise ValueError("Select a different column for each required field.")

    normalized = io.StringIO()
    fields = ("date", "amount", "description", "merchant", "currency", "transaction_id", *EXTRA_FIELDS)
    writer = csv.DictWriter(normalized, fieldnames=fields)
    writer.writeheader()
    references, file_accounts, zeros, pending, count = set(), set(), 0, 0, 0
    account_column = next((index for index, name in enumerate(columns)
                           if normalize(name) in {"account", "account name", "account number"}), None)
    canonical = {name.strip().casefold().replace(" ", "_"): index for index, name in enumerate(columns)}
    merchant_field = columns[mapping["description"]].strip().casefold() == "merchant"
    for line, row in entries:
        if not any(cell.strip() for cell in row):
            continue
        if account_column is not None and account_column < len(row) and row[account_column].strip():
            file_accounts.add(row[account_column].strip())
            if len(file_accounts) > 1:
                raise ValueError("This file contains more than one account. Download each account separately.")
        def read(key):
            index = mapping.get(key)
            return row[index].strip() if index is not None and index < len(row) else ""

        def extra(key):
            index = canonical.get(key)
            return row[index].strip() if index is not None and index < len(row) else ""

        try:
            if read("status").casefold() in {"pending", "authorized", "authorised", "processing", "temporary"}:
                pending += 1
                continue
            if mode == "split":
                debit, credit = abs(cents(read("debit") or "0")), abs(cents(read("credit") or "0"))
                if debit and credit:
                    raise ValueError("Both debit and credit have amounts.")
                amount = debit - credit
            else:
                amount = cents(read("amount"))
                if mode == "typed":
                    direction = read("direction").casefold()
                    if direction not in OUTFLOW | INFLOW:
                        raise ValueError("Direction must say debit, credit, withdrawal, deposit, purchase or refund.")
                    amount = abs(amount) if direction in OUTFLOW else -abs(amount)
                elif convention == "debits_negative":
                    amount = -amount
            description = read("description")
            item = {"date": read("date"), "amount": format(Decimal(amount) / 100, "f"),
                    "merchant": description if merchant_field else extra("merchant"),
                    "description": extra("description") if merchant_field else description,
                    "currency": read("currency") or currency, "transaction_id": read("reference"),
                    **{key: extra(key) for key in EXTRA_FIELDS}}
            normalize_row(item, "")
            if item["transaction_id"] and item["transaction_id"] in references:
                raise ValueError("This transaction ID appears twice. Export one account at a time or leave the unique ID field blank.")
            if item["transaction_id"]:
                references.add(item["transaction_id"])
        except ValueError as error:
            raise ValueError(f"CSV row {line}: {error}") from None
        if amount:
            writer.writerow(item)
            count += 1
        else:
            zeros += 1
    if not count:
        raise ValueError("The file contains no nonzero posted transactions.")
    accounts, records = csv_payload(normalized.getvalue(), account, "debits_positive")
    return accounts, records, zeros, pending


def make_plan(db, accounts, records, zeros, pending):
    account, label, *_ = accounts[0]
    if any(r["id"] != account and normalize(r["label"]) == normalize(label)
           for r in db.execute("SELECT id,label FROM accounts")):
        raise ValueError("That nickname is already used by a different source. For overlapping dates, reconcile with the existing account first.")
    saved = {r["id"]: r for r in db.execute("SELECT * FROM tx WHERE account=?", (account,))}
    by_amount = defaultdict(list)
    for row in saved.values():
        by_amount[row["amount"], row["currency"]].append(row)

    statuses, samples, new, totals = [], [], [], defaultdict(lambda: {"outflows": 0, "inflows": 0})
    days = []
    for item in records:
        row = normalize_row(item, account)
        original = saved.get(item["id"])
        if original:
            status = "already_imported" if all(original[k] == row[k] for k in (
                "date", "amount", "currency", "merchant", "description")) else "review"
        else:
            # Legacy CSV IDs skip exact repeats. Hold changed descriptions or close-date
            # matches for review, including when an overlapping export has extra repeats.
            status = "review" if any(
                candidate["date"] == row["date"] or
                (normalize(candidate["merchant"] or candidate["description"]) ==
                 normalize(row["merchant"] or row["description"]) and
                 abs((date.fromisoformat(candidate["date"]) - date.fromisoformat(row["date"])).days) <= 3)
                for candidate in by_amount[row["amount"], row["currency"]]
            ) else "new"
        statuses.append((item["id"], status))
        days.append(row["date"])
        if status == "new":
            new.append(item)
            totals[row["currency"]]["outflows" if row["amount"] > 0 else "inflows"] += abs(row["amount"])
        if len(samples) < 6 or (status == "review" and sum(s["status"] == "review" for s in samples) < 4):
            samples.append({"date": row["date"], "description": row["merchant"] or row["description"],
                            "amount": row["amount"], "currency": row["currency"], "status": status})
    token_data = json.dumps([accounts, records, statuses, zeros, pending], sort_keys=True, ensure_ascii=False)
    token = hashlib.sha256(token_data.encode()).hexdigest()
    counts = Counter(status for _, status in statuses)
    return {"token": token, "account": label, "first": min(days), "last": max(days), "zero": zeros, "pending": pending,
            "counts": {key: counts[key] for key in ("new", "already_imported", "review")},
            "totals": dict(totals), "samples": samples}, new


def handle(data):
    action = data.get("action")
    if action == "inspect":
        return inspect(data.get("content"))
    if action not in {"preview", "commit"}:
        raise ValueError("Choose a bank import step.")
    accounts, records, zeros, pending = records_for(data)
    with connect() as db:
        db.execute("BEGIN")
        plan, new = make_plan(db, accounts, records, zeros, pending)
    if action == "preview":
        return plan
    reviewed = data.get("token")
    if reviewed != plan["token"]:
        raise ValueError("The file settings or ledger have changed. Preview the import again.")
    if not new:
        return {**plan["counts"], "added": 0}

    def verify(db):
        current, _ = make_plan(db, accounts, records, zeros, pending)
        if current["token"] != reviewed:
            raise ValueError("The ledger changed. Preview the import again.")

    result = import_transactions(accounts, new, use_model=False, verify=verify)
    return {**plan["counts"], **result}
