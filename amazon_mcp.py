"""Local stdio MCP for a trusted Amazon order export."""
import json
import os
import sys

from amazon_orders import browser_orders, browser_status, read_orders, reconcile_orders, request_browser_sync
from ledger import connect, initialize

TOOLS = [
    {"name": "sync_amazon_payments", "description": "Read completed card charges from your connected Amazon Payments tab. Requires the Chrome connector.",
     "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
     "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": True}},
    {"name": "sync_amazon_orders", "description": "Ask the paired signed-in Chrome tab to read the selected Amazon order-history pages. Poll get_amazon_sync_status for completion.",
     "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
     "annotations": {"readOnlyHint": False, "destructiveHint": False, "openWorldHint": True}},
    {"name": "get_amazon_sync_status", "description": "Check dates and order count in the Chrome sync cache.",
     "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
     "annotations": {"readOnlyHint": True, "openWorldHint": False}},
    {"name": "preview_amazon_order_matches", "description": "Count confident, ambiguous and mixed Amazon order matches in the local ledger.",
     "inputSchema": {"type": "object", "properties": {}, "additionalProperties": False},
     "annotations": {"readOnlyHint": True, "openWorldHint": False}},
    {"name": "import_amazon_order_matches", "description": "Save matches and categorize purchases from the signed-in Chrome capture or configured export.",
     "inputSchema": {"type": "object", "properties": {"confirm": {"type": "boolean", "const": True}},
                     "required": ["confirm"], "additionalProperties": False},
     "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}},
]

def respond(request):
    method = request["method"]
    params = request.get("params") or {}
    if method == "initialize":
        supported = {"2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"}
        proposed = params.get("protocolVersion")
        return {"protocolVersion": proposed if proposed in supported else "2025-11-25",
                "capabilities": {"tools": {}}, "serverInfo": {"name": "spending-atlas-amazon", "version": "1.0.0"}}
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method != "tools/call":
        raise KeyError(method)
    name = params.get("name")
    arguments = params.get("arguments") or {}
    apply = name == "import_amazon_order_matches"
    if name not in {tool["name"] for tool in TOOLS}:
        raise ValueError("Unknown tool.")
    try:
        if apply and (not isinstance(arguments, dict) or arguments.keys() != {"confirm"} or arguments["confirm"] is not True):
            raise ValueError("Confirm the local import after previewing the matches.")
        if not apply and arguments:
            raise ValueError("Preview takes no arguments.")
        initialize()
        if name in {"sync_amazon_orders", "sync_amazon_payments"}:
            result = request_browser_sync(name.removeprefix("sync_amazon_"))
        elif name == "get_amazon_sync_status":
            with connect() as db:
                result = browser_status(db)
        else:
            path = os.environ.get("AMAZON_ORDERS_FILE")
            orders = read_orders(path) if path else browser_orders()
            if not orders:
                raise ValueError("Sync Your Orders from Chrome or set AMAZON_ORDERS_FILE to an export.")
            result = reconcile_orders(orders, apply)
        return {"content": [{"type": "text", "text": json.dumps(result)}], "structuredContent": result}
    except (ValueError, OSError) as error:
        return {"content": [{"type": "text", "text": str(error)}], "isError": True}

def main():
    os.umask(0o077)
    for line in sys.stdin:
        identifier = None
        try:
            request = json.loads(line)
            identifier = request.get("id")
            if "id" not in request:
                continue
            result = {"result": respond(request)}
        except KeyError:
            result = {"error": {"code": -32601, "message": "Method not found."}}
        except (ValueError, TypeError, AttributeError, OSError):
            result = {"error": {"code": -32602, "message": "Invalid request."}}
        print(json.dumps({"jsonrpc": "2.0", "id": identifier, **result}), flush=True)

if __name__ == "__main__":
    main()
