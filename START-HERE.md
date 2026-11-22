# Get started with Spending Atlas

For the shortest path, use the [Codex setup prompt](README.md#2-start-with-codex). The instructions below are for manual setup.

1. Unzip the starter into a private folder on your computer. Open **Start Spending Atlas.command** on macOS or **Start Spending Atlas.bat** on Windows. Leave the launcher window open while using the dashboard.
2. Pick **ChatGPT Finances** or **Import a CSV**. Start with one bank or card. Bring other sources in when you’re ready.
3. Add all the accounts you used to **Check coverage**. Mark date ranges verified when statements or another reliable source cover the full period. The dashboard shows any remaining gaps.
4. Choose whether to add **Amazon** or **Costco**. Both are optional. Finish setup and open the Overview.

Your spending history, receipts, preferences, and backup stay in your own local `.finance-data` folder. When using Codex, the prompt and data selected for the request are processed through your signed-in account. Share the starter ZIP with friends. Save your SQLite backup in a private location.

## Launch from a terminal or Codex

You need Python 3.10 or newer. In the project folder, run `python3 bootstrap.py --open` or `py -3 bootstrap.py --open` to start in the background. For a foreground server, run `python3 app.py serve --open` on macOS or Linux, or `py -3 app.py serve --open` on Windows. Open [Spending Atlas](http://127.0.0.1:8765/) once the command is running. If your system blocks the downloaded launcher, use the terminal command instead. You can also open the folder in Codex and ask it to launch Spending Atlas.

## Getting your bank data

For a statement, use a CSV with **Date**, **Amount**, and **Merchant** or **Description**. Use the same account label every time and choose the correct sign convention. Include Currency if the statement contains a currency other than USD. While coverage is unverified, the Overview shows a link to the date ranges and a Codex help button. A bank export with different headers or split credit and debit columns can be normalized with Codex before import. Import only uncovered ranges from another source unless each overlapping row has been reconciled to an existing record.

For Finances, copy the dashboard’s prompt to Codex. It uses your own connection if available. Enumerate accounts and request paged posted transactions with both signs and transfers included. Preserve the provider's IDs, dates and signed amounts. Save one file per account as `finance-*.json` in a dated private directory, with `account` containing `id` and a masked `label`, and `pages` containing the transaction query results in cursor order. Record pending records separately. Run `python3 weekly_refresh.py prepare RUN_FOLDER RUN_FOLDER/finances-import.json`. Review the dispositions, then import that JSON through Setup or with `python3 app.py import-finances SNAPSHOT_PATH --local-rules`. If Finances is unavailable, start with CSVs.

In the coverage checklist, add an account you’re still waiting on. Link it to the imported account once its records arrive. Verified periods can be entered separately and combined. For a closed or newly opened account, confirm any inactive dates using account records. An account with a quiet month can still be fully verified using its statement.

## Optional receipts

- **Amazon** — Mark the cards you used in Setup. Use your own signed-in Chrome session and the bundled `amazon-chrome` connector. Load it from Chrome’s extensions page as an unpacked extension. Generate your own local pairing key with `python3 app.py amazon-pair`, then enter that key and the port from your dashboard address in the Chrome side panel. Connect Your Orders and Amazon Payments separately, using the sign-in links in Setup → Optional receipts. Use the bundled `amazon_mcp.py` stdio tool or have Codex help with the connector. Preview matches with `python3 app.py import-amazon-orders` before running that command with `--apply`. Wait for both sync jobs to complete before relying on fresh captures.
- **Costco** — Use receipts from your signed-in Orders & Purchases page. Codex can help save locally captured receipt text under `.finance-data/imports/costco/<capture-date>/` using filenames in the form `YYYY-MM-DD_25.00_01.txt`. Run `python3 costco_receipts.py` to check matches. Add `--apply` to publish the receipt links. Unmatched receipts remain separate from spending.

## Make it yours

Set your city and preferred default for ambiguous Venmo or Zelle payments in Setup. Open a transaction to change its category, save a future merchant rule, change its reporting date, or assign a trip. In any category, use **Ask Codex** to request supported ledger edits, including linking a refund. The panel requires the installed Codex CLI signed in with ChatGPT. For a guided setup conversation covering categories, travel, refunds, and report changes, copy the customization prompt from **Setup**.

Use **Data & backup → Download backup** for a private database snapshot. To audit values and credit balances, run `python3 weekly_refresh.py audit`. Use **Download shareable starter** to give someone else their own clean dashboard.
