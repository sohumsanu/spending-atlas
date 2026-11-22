#!/bin/sh
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null 2>&1; then
    printf '%s\n' 'Spending Atlas requires Python 3.10 or newer. See START-HERE.md.'
    exit 1
fi
exec python3 app.py serve --open
