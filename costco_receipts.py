"""Index locally captured Costco receipts against the existing ledger."""
import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

from intelligence import days, normalize
from ledger import DATA, cents, connect, initialize, iso_date

ROOT = DATA / "imports" / "costco"
FILE_NAME = re.compile(r"(\d{4}-\d{2}-\d{2})_([\d.]+)_\d+\.txt")

def is_costco(row):
    descriptor = normalize(row["merchant"] + " " + row["description"])
    return bool(re.search(r"\bcostco\b", descriptor))

def inspect_receipts(db):
    purchases = [r for r in db.execute("SELECT id,date,amount,merchant,description FROM tx WHERE kind='purchase' AND currency='USD'")
                 if is_costco(r)]
    receipts = {}
    for entry in sorted(ROOT.glob("*/*.txt")):
        parts = FILE_NAME.fullmatch(entry.name)
        if not parts:
            continue
        path = entry.resolve()
        if not path.is_relative_to(ROOT.resolve()) or path.stat().st_size > 1_000_000:
            raise ValueError("Receipt path or file size is outside the local archive.")
        data = path.read_bytes()
        if b"costco" not in data.lower() and b"in-warehouse receipt" not in data.lower():
            raise ValueError(f"Receipt text is not recognized in {path.name}.")
        date, total = iso_date(parts[1]), cents(parts[2])
        candidates = [r for r in purchases if r["amount"] == total and abs(days(date,r["date"])) <= 4]
        key = hashlib.sha256(data).hexdigest()
        receipts.setdefault(key, (key, str(path.relative_to(ROOT.resolve())), date, total, candidates))
    claims = Counter(c[0]["id"] for *_, c in receipts.values() if len(c) == 1)
    return [(*values, candidates[0]["id"] if len(candidates) == 1 and claims[candidates[0]["id"]] == 1 else None,
             "matched" if len(candidates) == 1 and claims[candidates[0]["id"]] == 1 else "ambiguous" if candidates else "unmatched")
            for *values, candidates in receipts.values()]

def update_index(*, apply=False):
    with connect(write=apply) as db:
        rows = inspect_receipts(db)
        if apply:
            db.execute("DELETE FROM costco_receipts")
            db.executemany("INSERT INTO costco_receipts VALUES(?,?,?,?,?,?)", rows)
        return {"receipts": len(rows), **Counter(row[-1] for row in rows)}

def receipt_file(identifier):
    if not re.fullmatch(r"[a-f0-9]{64}", identifier):
        return None
    with connect() as db:
        record = db.execute("SELECT path FROM costco_receipts WHERE id=?", (identifier,)).fetchone()
    if not record:
        return None
    root = ROOT.resolve()
    path = (root / Path(record["path"])).resolve()
    if not path.is_relative_to(root) or path.suffix != ".txt" or not path.is_file() or path.stat().st_size > 1_000_000:
        return None
    return path

if __name__ == "__main__":
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--apply", action="store_true")
    initialize()
    print(json.dumps(update_index(apply=cli.parse_args().apply)))
