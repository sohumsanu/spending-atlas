"use strict";

async function collectAmazonOrders() {
  const amazon = "https://www.amazon.com";
  const ordersPaths = new Set(["/your-orders/orders", "/gp/your-account/order-history"]);
  if (location.origin !== amazon || !ordersPaths.has(location.pathname)) {
    throw Error("Open Your Orders in your signed-in Amazon tab before connecting.");
  }

  function allowed(href, paths) {
    if (!href) return null;
    const target = new URL(href, location.href);
    return target.origin === amazon && paths.has(target.pathname) && !target.username && !target.password ? target : null;
  }

  async function getPage(url, paths) {
    if (!allowed(url, paths)) return null;
    try {
      const response = await fetch(url, {
        method: "GET", credentials: "same-origin", cache: "no-store", redirect: "follow",
        signal: AbortSignal.timeout(9000),
      });
      if (!response.ok || !allowed(response.url, paths) || !response.headers.get("content-type")?.includes("text/html")) return null;
      return new DOMParser().parseFromString(await response.text(), "text/html");
    } catch (_) {
      return null;
    }
  }

  function orderCards(doc) {
    return [...doc.querySelectorAll(".js-order-card")].flatMap(card => {
      const header = card.querySelector(".order-header");
      const fields = [...(header?.querySelectorAll(".order-header__header-list-item") || [])];
      const field = label => fields.find(item => item.firstElementChild?.textContent.trim() === label)?.lastElementChild?.textContent.trim();
      const date = field("Order placed");
      const total = field("Total")?.match(/^\$([\d,.]+)$/)?.[1];
      const id = header?.querySelector(".yohtmlc-order-id")?.textContent.match(/\d{3}-\d{7}-\d{7}/)?.[0];
      const items = [...new Set([...card.querySelectorAll('a[href*="/dp/"]')].map(a =>
        a.textContent.trim() || a.querySelector("img[alt]")?.alt.trim())
        .filter(title => title && title.length > 2).map(title => title.replace(/^product image\s*:\s*/i, "")))];
      const cancelled = /\b(?:order cancel(?:l?ed|ation)|payment revision needed)\b/i.test(card.textContent);
      return id && date && total && items.length && !cancelled ? [{id, date, total, currency: "USD", items}] : [];
    });
  }

  const pages = new Set();
  const rows = new Map();
  const first = [...document.querySelectorAll(".a-pagination a")].find(a => a.textContent.trim() === "1");
  const root = allowed(first?.getAttribute("href"), ordersPaths);
  const current = new URL(location.href);
  const filter = current.searchParams.get("timeFilter") || document.querySelector('select[name="timeFilter"]')?.value;
  const restart = root && root.searchParams.get("timeFilter") === filter;
  let doc = restart ? await getPage(root, ordersPaths) : document;
  let currentPage = restart ? root.href : current.href;

  for (let page = 0; doc && !pages.has(currentPage) && page < 40; page++) {
    if (!doc.querySelector(".js-order-card .order-header")) return {orders: [...rows.values()], complete: false};
    pages.add(currentPage);
    for (const order of orderCards(doc)) rows.set(order.id, order);
    const next = allowed(doc.querySelector(".a-pagination .a-last a")?.getAttribute("href"), ordersPaths);
    if (!next) return {orders: [...rows.values()], complete: true};
    if (next.searchParams.get("timeFilter") !== filter) break;
    currentPage = next.href;
    doc = await getPage(next, ordersPaths);
  }
  return {orders: [...rows.values()], complete: false};
}

async function collectAmazonPayments() {
  if (location.origin !== "https://www.amazon.com" || location.pathname !== "/cpe/yourpayments/transactions") {
    throw Error("Open Amazon Payments → Transactions in the connected tab.");
  }
  function charges() {
    return [...document.querySelectorAll("a")].flatMap(anchor => {
      const line = anchor.innerText.replace(/\s+/g, " ").trim();
      if (!/\bCharged\b/.test(line)) return [];
      const id = line.match(/Order #\s*(\d{3}-\d{7}-\d{7})/i)?.[1];
      const date = line.match(/^([A-Za-z]{3,9}\.? \d{1,2}, \d{4})\b/)?.[1];
      const last_four = line.match(/(?:[•*]{4}|ending in)\s*(\d{4})\b/i)?.[1];
      const amount = line.match(/[-−]\s*\$([\d,]+\.\d{2})\b/)?.[1];
      return id && date && last_four && amount ? [{id, date, last_four, amount, currency: "USD"}] : [];
    });
  }
  const observed = new Map();
  function remember(rows) {
    const seen = new Map();
    for (const row of rows) {
      const key = JSON.stringify(row);
      seen.set(key, (seen.get(key) || 0) + 1);
      if ((observed.get(key)?.count || 0) < seen.get(key)) {
        observed.set(key, {row, count: seen.get(key)});
      }
    }
  }
  const allRows = () => [...observed.values()].flatMap(({row, count}) => Array(count).fill(row));
  let rows = charges();
  remember(rows);
  // The Payments page uses a visible control, when available, to request more
  // rows. Let Amazon's own client make that request using its current session.
  for (let i = 0; i < 35; i++) {
    const more = [...document.querySelectorAll("button")].find(button => !button.disabled &&
      /^(?:load more|show more transactions)$/i.test(button.innerText.trim()) && button.getClientRects().length);
    const last = [...document.querySelectorAll("a")].filter(anchor => anchor.getClientRects().length && /\bCharged\b/.test(anchor.innerText)).at(-1);
    if (!more && !last) return {rows: allRows(), complete: rows.length > 0};
    const previous = JSON.stringify(rows);
    const extended = await new Promise(resolve => {
      const observer = new MutationObserver(() => {
        const latest = charges();
        if (latest.length && JSON.stringify(latest) !== previous) {
          clearTimeout(timer);
          observer.disconnect();
          resolve(latest);
        }
      });
      const timer = setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, 6000);
      observer.observe(document.body, {childList: true, subtree: true});
      if (more) more.click();
      else last.scrollIntoView({block: "end"});
    });
    if (!extended) return {rows: allRows(), complete: !more && rows.length > 0};
    rows = extended;
    remember(rows);
  }
  return {rows: allRows(), complete: false};
}
