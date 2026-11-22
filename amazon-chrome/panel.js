"use strict";

const form = document.querySelector("form");
const status = document.querySelector("#status");
const disconnect = document.querySelector("#disconnect");
let session;

async function bridge(key, data) {
  const response = await fetch("http://127.0.0.1:8765/api/amazon/bridge", {
    method: "POST", headers: {"Content-Type": "application/json", Authorization: "Bearer " + key},
    body: JSON.stringify(data), signal: AbortSignal.timeout(9000),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "Could not reach Spending Atlas.");
  return result;
}

async function sync(active, job) {
  const func = active.mode === "orders" ? collectAmazonOrders : collectAmazonPayments;
  const [response] = await chrome.scripting.executeScript({target: {tabId: active.tab}, func});
  const result = response?.result;
  if (!result) throw Error("The Amazon tab is unavailable. Sign in and reopen the requested page.");
  if (active !== session) return;
  const saved = await bridge(active.key, {action: "finish", mode: active.mode, job,
    rows: result.orders || result.rows, complete: result.complete});
  const count = saved.received ?? saved.payments_seen ?? 0;
  status.textContent = count + (active.mode === "orders" ? " orders staged." : " completed charges read.") +
    (result.complete ? " Preview the card matches in your MCP client." : " Amazon interrupted part of the sync.");
}

async function poll(active) {
  if (session !== active) return;
  let job;
  try {
    ({job} = await bridge(active.key, {action: "poll", mode: active.mode}));
    if (job && session === active) {
      status.textContent = "Reading Amazon through this signed-in tab…";
      await sync(active, job);
    }
  } catch (error) {
    if (job && session === active) {
      try { await bridge(active.key, {action: "finish", mode: active.mode, job, rows: [], complete: false}); } catch (_) {}
    }
    if (session === active) {
      status.textContent = error.message;
      session = undefined;
      disconnect.disabled = true;
    }
    return;
  }
  if (session === active) setTimeout(() => poll(active), 2000);
}

form.addEventListener("submit", async event => {
  event.preventDefault();
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  const key = new FormData(form).get("key").trim();
  const url = tab?.url && new URL(tab.url);
  const mode = url?.origin === "https://www.amazon.com" ?
    ["/your-orders/orders", "/gp/your-account/order-history"].includes(url.pathname) ? "orders" :
      url.pathname === "/cpe/yourpayments/transactions" ? "payments" : "" : "";
  if (!mode) {
    status.textContent = "Open Amazon Your Orders or Payments → Transactions and click the extension there.";
    return;
  }
  session = {tab: tab.id, key, mode};
  disconnect.disabled = false;
  status.textContent = "Connected. Run sync_amazon_" + mode + " in your MCP client.";
  await poll(session);
});
disconnect.addEventListener("click", () => {
  session = undefined;
  form.elements.key.value = "";
  disconnect.disabled = true;
  status.textContent = "Disconnected.";
});
