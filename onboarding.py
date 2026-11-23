"""Local setup preferences, evidence-backed coverage, and the distributable app."""
import io
import re
from datetime import date
from zipfile import ZIP_DEFLATED, ZipFile

from ledger import ROOT, iso_date, normalize, rebuild_trips, setting

SHARE_FILES = (
    ".gitignore", "START-HERE.md", "Start Spending Atlas.command", "Start Spending Atlas.bat",
    "app.py", "ledger.py", "intelligence.py", "onboarding.py", "bank_import.py", "reference.py", "category_chat.py",
    "amazon_orders.py", "amazon_mcp.py", "costco_receipts.py", "weekly_refresh.py",
    "static/index.html", "static/style.css", "static/app.js", "static/bank-format-example.csv",
    "docs/images/chatgpt-finances.jpg", "docs/images/chatgpt-connect-account.jpg",
    "amazon-chrome/manifest.json", "amazon-chrome/collector.js", "amazon-chrome/panel.html",
    "amazon-chrome/panel.css", "amazon-chrome/panel.js", "amazon-chrome/worker.js",
)


def export_starter():
    output = io.BytesIO()
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        for name in SHARE_FILES:
            archive.write(ROOT / name, "Spending Atlas/" + name)
    return output.getvalue()


def setup_view(db):
    return {
        "today": date.today().isoformat(),
        "done": setting(db, "setup_done") == "1",
        "owner": setting(db, "owner_name"),
        "own_labels": setting(db, "owned_transfer_labels"),
        "peer_food": setting(db, "peer_food_default") == "1",
        "amazon": setting(db, "setup_amazon") == "1",
        "costco": setting(db, "setup_costco") == "1",
        "years_confirmed": [r[0].removeprefix("inventory_") for r in db.execute(
            "SELECT key FROM settings WHERE key LIKE 'inventory_%' AND value='1'")],
        "expected": [dict(r) for r in db.execute("SELECT * FROM expected_accounts ORDER BY label")],
        "windows": [dict(r) for r in db.execute("SELECT * FROM coverage_windows ORDER BY start,end")],
        "amazon_cards": [dict(r) for r in db.execute("SELECT account,last_four FROM amazon_eligible_cards ORDER BY account")],
    }


def save_setup(db, data):
    action = data.get("action")
    if action == "preferences":
        fields = {"owner": ("owner_name", 120), "own_labels": ("owned_transfer_labels", 260), "home": ("home", 120)}
        if data.keys() - (fields.keys() | {"action", "amazon", "costco", "peer_food"}):
            raise ValueError("Choose valid setup preferences.")
        for key, (target, size) in fields.items():
            if key in data:
                value = data[key]
                if not isinstance(value, str) or len(value) > size:
                    raise ValueError("A setup preference is too long.")
                db.execute("INSERT OR REPLACE INTO settings VALUES (?,?)", (target, value.strip()))
        for key, target in (("amazon", "setup_amazon"), ("costco", "setup_costco"), ("peer_food", "peer_food_default")):
            if key in data:
                if type(data[key]) is not bool:
                    raise ValueError("Choose an on or off setting.")
                db.execute("INSERT OR REPLACE INTO settings VALUES (?,?)", (target, str(int(data[key]))))
        if "home" in data:
            rebuild_trips(db)
        return
    if action == "finish":
        db.execute("INSERT OR REPLACE INTO settings VALUES ('setup_done','1')")
        return
    if action == "inventory":
        year, complete = data.get("year"), data.get("complete")
        if not isinstance(year, str) or not re.fullmatch(r"[1-9]\d{3}", year) or type(complete) is not bool:
            raise ValueError("Choose a valid audit year.")
        db.execute("INSERT OR REPLACE INTO settings VALUES (?,?)", ("inventory_" + year, str(int(complete))))
        return
    if action == "expect":
        label = data.get("label")
        if not isinstance(label, str) or not normalize(label) or len(label) > 120:
            raise ValueError("Enter a short account label, such as Everyday Checking.")
        matching = [r for r in db.execute("SELECT id,label FROM accounts") if normalize(r["label"]) == normalize(label)]
        if len(matching) > 1:
            raise ValueError("More than one imported account uses that label.")
        key = matching[0]["id"] if matching else "csv:" + normalize(label)
        db.execute("INSERT OR IGNORE INTO expected_accounts VALUES (?,?)", (key, label.strip()))
        db.execute("UPDATE settings SET value='0' WHERE key LIKE 'inventory_%'")
        return
    if action not in {"coverage", "remove_coverage", "amazon_card", "remove_expected", "claim_expected"}:
        raise ValueError("Choose a setup action.")
    account = data.get("account")
    if not isinstance(account, str):
        raise ValueError("Choose an account.")
    imported = db.execute("SELECT label FROM accounts WHERE id=?", (account,)).fetchone()
    expected = db.execute("SELECT label FROM expected_accounts WHERE id=?", (account,)).fetchone()
    if not (imported or expected):
        raise ValueError("Choose an account from your checklist.")
    if action == "remove_expected":
        if imported or not expected:
            raise ValueError("Only unimported account checklist entries can be removed.")
        db.execute("DELETE FROM coverage_windows WHERE account=?", (account,))
        db.execute("DELETE FROM expected_accounts WHERE id=?", (account,))
        db.execute("UPDATE settings SET value='0' WHERE key LIKE 'inventory_%'")
    elif action == "claim_expected":
        target = data.get("target")
        if imported or not expected or not isinstance(target, str):
            raise ValueError("Select a checklist entry and its imported account.")
        linked = db.execute("SELECT label FROM accounts WHERE id=?", (target,)).fetchone()
        if not linked:
            raise ValueError("Select its imported account.")
        db.execute("INSERT OR IGNORE INTO expected_accounts VALUES (?,?)", (target, linked["label"]))
        db.execute("INSERT OR IGNORE INTO coverage_windows SELECT ?,start,end FROM coverage_windows WHERE account=?",
                   (target, account))
        db.execute("DELETE FROM coverage_windows WHERE account=?", (account,))
        db.execute("DELETE FROM expected_accounts WHERE id=?", (account,))
        db.execute("UPDATE settings SET value='0' WHERE key LIKE 'inventory_%'")
    elif action == "amazon_card":
        mask = data.get("last_four")
        if not imported or not isinstance(mask, str) or not re.fullmatch(r"[0-9]{4}|", mask):
            raise ValueError("Choose an imported account and enter the card’s last four digits.")
        if mask:
            db.execute("INSERT OR REPLACE INTO amazon_eligible_cards VALUES (?,?)", (account, mask))
        else:
            db.execute("DELETE FROM amazon_eligible_cards WHERE account=?", (account,))
    else:
        start, end = iso_date(data.get("start")), iso_date(data.get("end"))
        if start > end or end > date.today().isoformat():
            raise ValueError("Use a valid range ending today or earlier.")
        if action == "coverage":
            if data.get("verified") is not True:
                raise ValueError("Confirm that the source covers the entire date range.")
            if not expected:
                db.execute("INSERT INTO expected_accounts VALUES (?,?)", (account, imported["label"]))
            db.execute("INSERT OR IGNORE INTO coverage_windows VALUES (?,?,?)", (account, start, end))
        else:
            db.execute("DELETE FROM coverage_windows WHERE account=? AND start=? AND end=?", (account, start, end))
