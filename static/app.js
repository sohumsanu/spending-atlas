"use strict";

const $ = (selector, root = document) => root.querySelector(selector);
const main = $("#main");
const modal = $("#modal");
const names = {overview: "Overview", transactions: "Transactions", months: "Months", categories: "Categories", merchants: "Merchants", trips: "Trips", reimbursements: "Reimbursements", review: "Review", data: "Data & backup", setup: "Setup"};
const monthNames = Array.from({length: 12}, (_, i) => new Intl.DateTimeFormat("en", {month: "long", timeZone: "UTC"}).format(new Date(Date.UTC(2020, i))));
const monthRanges = [3, 6, 12];
const monthScenarios = {
  total: "Total spending",
  withoutLoans: "Excluding student loans",
  withoutRent: "Excluding rent",
  withoutBoth: "Excluding student loans & rent",
};
const monthReportKey = "spending-atlas.month-report.v1";
const state = {data: null, year: "", currency: "", selected: new Set(), search: "", page: 1, sorts: new Map(), creditFilter: "all", account: "", chartMode: "breakdown", tripOrder: "date", monthReport: loadMonthReport()};
let toastTimer;
let currentAccountMap = new Map();
let currentRowMap = new Map();
let currentCategoryContext = null;
let dashboardChatContext = null;
let setupYear = "";
const categoryChats = new Map();
const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[ch]);
const fmt = (cents, currency = state.currency) => new Intl.NumberFormat("en-US", {style: "currency", currency: currency || "USD"}).format(cents / 100);
const labelDate = date => date ? new Intl.DateTimeFormat("en-US", {month:"short", day:"numeric", year:"numeric", timeZone:"UTC"}).format(new Date(`${date.slice(0, 10)}T00:00:00Z`)) : "—";
const monthKey = (year, i) => `${year}-${String(i + 1).padStart(2, "0")}`;
const monthName = key => monthNames[Number(key.slice(5)) - 1];
const monthLabel = key => `${monthName(key).slice(0, 3)} ${key.slice(0, 4)}`;
const route = () => {
  try { return location.hash.slice(1).split("/").map(part => decodeURIComponent(part)); }
  catch (_) { return ["overview"]; }
};
const sum = (rows, prop) => rows.reduce((total, row) => total + row[prop], 0);
const net = row => row.amount - row.offset;
const merchant = row => row.merchant || row.description;
const normalizeMerchant = name => name.normalize("NFC").toLowerCase().trim().replace(/\s+/g, " ");
const merchantKey = row => {
  if (row.assigned_merchant) return normalizeMerchant(row.assigned_merchant);
  const label = normalizeMerchant(merchant(row));
  if (/\bcostco\b/.test(label)) return "costco";
  if (/\b(?:amazon|amzn)\b/.test(label)) return "amazon";
  return label;
};
const merchantLabel = (key, row) => row?.assigned_merchant ||
  (key === "costco" ? "Costco" : key === "amazon" ? "Amazon" : row ? merchant(row) : key);
const hasMerchantHistory = row => Boolean(row.assigned_merchant) || ["purchase", "credit"].includes(row.kind);
const merchantHref = key => "#merchants/" + encodeURIComponent(key);
const receiptHref = receipt => "/api/costco-receipt/" + encodeURIComponent(receipt.id);

const category = key => state.data.categories[key] || key;
const paths = {
  atlas: '<circle cx="12" cy="12" r="8"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
  overview: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  transactions: '<path d="M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4"/>',
  months: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  categories: '<path d="M3 3h8l10 10-8 8L3 11z"/><circle cx="7.5" cy="7.5" r="1"/>',
  trips: '<rect x="4" y="7" width="16" height="14" rx="3"/><path d="M9 7V4h6v3m-5 6v4m4-4v4"/>',
  merchants: '<path d="M4 10v10h16V10M3 6l2-3h14l2 3v4H3zm6 14v-6h6v6"/>',
  reimbursements: '<path d="M8 4 4 8l4 4M4 8h11a5 5 0 0 1 0 10h-5"/>',
  review: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="m8 12 3 3 5-6"/>',
  data: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  wallet: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M15 11h6v4h-6z"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6m-6 4h6"/>',
};
const icon = key => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[key] || paths.receipt}</svg>`;
document.querySelectorAll("[data-icon]").forEach(element => { element.innerHTML = icon(element.dataset.icon); });
const empty = message => `<p class="placeholder">${esc(message)}</p>`;
const button = (text, action, value = "", extra = "") => `<button type="button" class="btn ${extra}" data-action="${action}" data-value="${esc(value)}">${text}</button>`;
const badge = (text, color = "") => `<span class="badge ${color}">${esc(text)}</span>`;

function toast(message) {
  const element = $("#toast");
  clearTimeout(toastTimer);
  element.textContent = message;
  element.hidden = false;
  toastTimer = setTimeout(() => {element.hidden = true;}, 4500);
}

async function request(path, value) {
  const response = await fetch(path, value === undefined ? {} : {
    method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(value),
  });
  const returned = await response.json();
  if (!response.ok) throw Error(returned.error || "The request could not be completed.");
  return returned;
}

async function refresh() {
  state.data = await request("/api/data");
  state.data.transfer_categories ??= ["transfers", "card_payments"];
  state.data.unverified_categories ??= [];
  if (!location.hash && !state.data.setup.done && !state.data.accounts.length) {
    history.replaceState(null, "", "#setup");
  }
  currentRowMap = new Map(state.data.transactions.map(row => [row.id, row]));
  currentAccountMap = new Map(state.data.accounts.map(row => [row.id, row]));
  const thisYear = String(new Date().getFullYear());
  const years = [...new Set([thisYear, ...state.data.transactions.map(row => row.date.slice(0, 4))])].sort().reverse();
  const currencies = [...new Set(state.data.transactions.map(row => row.currency))].sort();
  if (!years.includes(state.year)) state.year = thisYear;
  if (!currencies.includes(state.currency)) state.currency = currencies.includes("USD") ? "USD" : (currencies[0] || "USD");
  $("#year").innerHTML = years.map(y => `<option${y === state.year ? " selected" : ""}>${esc(y)}</option>`).join("");
  $("#currency").innerHTML = (currencies.length ? currencies : ["USD"]).map(c => `<option${c === state.currency ? " selected" : ""}>${esc(c)}</option>`).join("");
  render();
}

function reportRows() {
  return state.data.transactions.filter(row => row.date.startsWith(state.year) && row.currency === state.currency);
}

function spendingRows(rows) {
  return rows.flatMap(row => {
    if (row.amount > 0 && row.kind !== "transfer") return [row];
    if (!row.direct_offset) return [];
    return [{...row, amount: 0, offset: row.direct_offset, category: row.assignment.category, kind: "category_credit"}];
  });
}

function sortedRows(rows, scope, fields, defaults = ["date", -1]) {
  const [key, direction] = state.sorts.get(scope) || defaults;
  const value = fields[key];
  if (!value) return rows;
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    return direction * (typeof x === "number" ? x - y : String(x || "").localeCompare(String(y || ""), undefined, {numeric: true}));
  });
}

function sortHeading(label, key, scope, defaults = ["date", -1], numeric = false) {
  const [active, direction] = state.sorts.get(scope) || defaults;
  const sorting = active === key;
  const status = sorting ? ` aria-sort="${direction === 1 ? "ascending" : "descending"}"` : "";
  return `<th scope="col" class="${numeric ? "num" : ""}"${status}><button type="button" class="sort-button" data-action="sort"
    data-value="${esc(JSON.stringify([scope, key, sorting ? -direction : (["date", "amount"].includes(key) ? -1 : 1)]))}">${esc(label)}
    <span aria-hidden="true">${sorting ? direction === 1 ? "↑" : "↓" : "↕"}</span></button></th>`;
}

function amounts(purchases) {
  const gross = sum(purchases, "amount");
  const credits = sum(purchases, "offset");
  return {gross, credits, total: gross - credits};
}

function metrics(purchases, note = "") {
  const {gross, credits, total} = amounts(purchases);
  return `<div class="metrics">
    <section class="metric lead"><div class="metric-heading"><span class="metric-icon">${icon("wallet")}</span><div class="label">Net spending</div></div><div class="metric-value numeric">${fmt(total)}</div><small>${esc(note || "After refunds and reimbursements")}</small></section>
    <section class="metric"><div class="metric-heading"><span class="metric-icon">${icon("transactions")}</span><div class="label">Gross outflows</div></div><div class="metric-value numeric">${fmt(gross)}</div><small>${purchases.filter(row => row.amount > 0).length.toLocaleString()} posted debits counted</small></section>
    <section class="metric"><div class="metric-heading"><span class="metric-icon credit-icon">${icon("reimbursements")}</span><div class="label">refunds/<wbr>reimbursements</div></div><div class="metric-value numeric">${fmt(credits)}</div><small>Deducted from gross outflows</small></section>
  </div>`;
}

function heading(title, caption, action = "", eyebrow = "") {
  return `<div class="page-head"><div>${eyebrow ? `<div class="eyebrow">${esc(eyebrow)}</div>` : ""}<h1>${esc(title)}</h1><p>${esc(caption)}</p></div>${action}</div>`;
}

function panel(title, content, note = "", action = "") {
  return `<section class="panel"><div class="panel-head"><div><h2>${esc(title)}</h2>${note ? `<p class="section-note">${esc(note)}</p>` : ""}</div>${action}</div>${content}</section>`;
}

function byCategory(purchases) {
  const groups = new Map();
  for (const row of purchases) {
    const group = row.category === "health_wellness" ? "shopping" : row.category;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(row);
  }
  return [...groups].map(([key, rows]) => ({key, rows, ...amounts(rows)})).sort((a, b) => b.total - a.total);
}

function categoryList(purchases, limit = Infinity, href = key => "#categories/" + encodeURIComponent(key)) {
  const groups = byCategory(purchases);
  const max = Math.max(groups[0]?.total || 0, 1);
  return groups.slice(0, limit).map((group, i) => `<a class="category-row" href="${esc(href(group.key))}">
    <span class="left"><strong>${esc(category(group.key))}</strong><span class="progress"><i style="--bar-color:${categoryColors[i % categoryColors.length]};--fill:${Math.max(0, group.total / max * 100)}%"></i></span></span>
    <b class="numeric">${fmt(group.total)}</b></a>`).join("") || empty("No posted purchases in this period.");
}

const categoryColors = ["#6446d5", "#9b80eb", "#44a693", "#efa674", "#6486d8", "#bc6da1"];
const shareLabel = new Intl.NumberFormat("en", {style: "percent", maximumFractionDigits: 1});

function categoryMix(purchases) {
  const positive = byCategory(purchases).filter(group => group.total > 0);
  if (!positive.length) return empty("No positive category spending in this period.");
  const groups = positive.slice(0, 4);
  if (positive.length > 4) groups.push({key: "", total: sum(positive.slice(4), "total")});
  const total = sum(groups, "total");
  let angle = -Math.PI / 2;
  const point = radians => `${120 + 96 * Math.cos(radians)} ${120 + 96 * Math.sin(radians)}`;
  const slices = groups.map(({key, total: value}, i) => {
    const fraction = value / total;
    const start = point(angle);
    angle += fraction * 2 * Math.PI;
    const path = groups.length === 1
      ? '<circle cx="120" cy="120" r="96"/>'
      : `<path d="M ${start} A 96 96 0 ${fraction > .5 ? 1 : 0} 1 ${point(angle)}"/>`;
    return {name: key ? category(key) : "Other categories", href: key ? "#categories/" + encodeURIComponent(key) : "#categories/all",
      path, amount: fmt(value), color: categoryColors[i], share: shareLabel.format(fraction)};
  });
  return `<div class="category-mix" data-mix-total="${fmt(total)}">
    <div class="spending-ring">
      <svg viewBox="0 0 240 240" aria-label="Spending share by category">
        ${slices.map(({href, name, path, color, share}, i) => `<a href="${href}" class="mix-slice" data-mix-index="${i}" aria-label="${esc(name)} · ${share}">
          <g style="--swatch:${color}">${path}</g></a>`).join("")}
      </svg>
      <div class="mix-center" aria-hidden="true"><small data-mix-title>Chart total</small><strong class="numeric" data-mix-value>${fmt(total)}</strong></div>
    </div>
    <div class="mix-legend">${slices.map(({href, name, amount, color, share}, i) => `<a href="${href}" data-mix-index="${i}" data-mix-name="${esc(name)}" data-mix-share="${share}">
      <span class="mix-name"><i style="--swatch:${color}"></i>${esc(name)}</span>
      <span class="mix-amount"><small class="numeric mix-share">${share}</small><strong class="numeric">${amount}</strong></span></a>`).join("")}</div></div>`;
}

function monthlyTotals(purchases) {
  return monthNames.map((name, i) => {
    const key = monthKey(state.year, i);
    const rows = purchases.filter(row => row.date.startsWith(key));
    return {name, key, rows, ...amounts(rows)};
  });
}

function monthlyChart(months, {breakdown = state.chartMode === "breakdown", rolling = false} = {}) {
  const high = Math.max(100, ...months.map(item => breakdown ? item.gross : item.total));
  const low = Math.max(0, ...months.map(item => -item.total));
  const target = Math.max(high, low) / 4;
  const unit = 10 ** Math.floor(Math.log10(target));
  const interval = [1, 2, 5, 10].map(step => unit * step).find(step => step >= target);
  const upper = Math.ceil(high / interval);
  const lower = Math.ceil(low / interval);
  const divisions = upper + lower;
  const pct = cents => cents / (divisions * interval) * 100;
  const scale = new Intl.NumberFormat("en", {style: "currency", currency: state.currency, notation: "compact", maximumFractionDigits: 1});
  const ticks = Array.from({length: divisions + 1}, (_, i) => `<span style="top:${i / divisions * 100}%">${scale.format((upper - i) * interval / 100)}</span>`).join("");
  const bars = months.map(({name, key, rows, gross, credits, total, recorded = rows.length > 0}) => {
    const period = rolling ? monthLabel(key) : name;
    const label = recorded ? `${period}: ${fmt(total)} net, ${fmt(gross)} gross, ${fmt(credits)} credited` : `${period}: no records`;
    return `<a class="bar-link" href="#months/${key}" aria-label="${esc(label)}" title="${esc(label)}">
      <span class="bar" aria-hidden="true" style="--gross:${pct(breakdown ? gross : 0)}%;--net:${pct(Math.max(0, total))}%;--below:${pct(Math.max(0, -total))}%"><i></i><b></b></span>
      <span class="bar-month" aria-hidden="true">${name.slice(0, 3)}</span><span class="chart-tip" aria-hidden="true">${recorded ? `${fmt(total)} net` : "No records"}</span></a>`;
  }).join("");
  return `<div class="chart-shell${rolling ? " rolling-chart" : ""}" style="--zero:${lower / divisions * 100}%;--chart-step:${100 / divisions}%;--month-count:${months.length}">
    <div class="chart-scale" aria-hidden="true">${ticks}</div><div class="chart-plot">${bars}</div></div>
    <div class="legend"><span>Net spending</span>${breakdown ? "<span>refunds/reimbursements</span>" : ""}${low ? '<span class="net-credit">Net credit</span>' : ""}</div>`;
}

function chartControl() {
  return `<label class="chart-control"><span class="sr-only">Spending chart view</span><select id="chart-mode">
    <option value="breakdown"${state.chartMode === "breakdown" ? " selected" : ""}>Net + refunds</option>
    <option value="net"${state.chartMode === "net" ? " selected" : ""}>Net only</option></select></label>`;
}

function topPurchases(rows, limit = 5) {
  return rows.filter(row => row.kind === "purchase").sort((a, b) => net(b) - net(a)).slice(0, limit).map(row => {
    const trip = state.data.trips.find(item => item.id === row.trip);
    return `<div class="list-row">
    <div><button class="text-button" data-action="transaction" data-value="${esc(row.id)}"><strong>${esc(merchant(row))}</strong></button>
    <small class="muted">${esc(category(row.category))} · ${labelDate(row.date)}${trip ? ` · <a class="text-button" href="#trips/${trip.id}">${esc(trip.name)} trip</a>` : ""}</small></div>
    <div class="purchase-amount"><strong class="numeric">${fmt(net(row), row.currency)}</strong>${creditAmountNote(row)}</div></div>`;
  }).join("") || empty("No posted purchases in this period.");
}

function overview() {
  const reporting = reportRows();
  const purchases = spendingRows(reporting);
  const postedDebits = sum(reporting.filter(row => row.amount > 0), "amount");
  const excluded = sum(reporting.filter(row => row.amount > 0 && row.kind === "transfer"), "amount");
  const unverifiedDebits = sum(reporting.filter(row => row.amount > 0 && row.kind === "uncertain"), "amount");
  const studentLoanPayments = sum(purchases.filter(row => row.category === "student_loan_payments"), "amount");
  const year = state.year;
  const ytd = year === String(new Date().getFullYear());
  const latest = reporting.map(row => row.date).sort().at(-1);
  return heading("Spending overview", latest ? `Posted activity through ${labelDate(latest)}` : "No activity in this period", '<a class="btn" href="#transactions">Browse transactions</a>', `${year} ${ytd ? "year to date" : "calendar year"}`) +
    coverageNotice(year) + metrics(purchases) +
    `<div class="overview-grid overview-report">${panel("Spending over time", monthlyChart(monthlyTotals(purchases)), "Select a month to see its transactions.", chartControl())}
    ${panel("Where it went", categoryMix(purchases), "Share of categories with positive net spending", '<a class="quiet-link" href="#categories">All categories</a>')}</div>
    <details class="panel gross-detail"><summary>How gross outflows add up</summary><div class="list-row"><span>All posted debits</span><strong class="numeric">${fmt(postedDebits)}</strong></div>
    <div class="list-row"><span>Money movements excluded</span><strong class="numeric">${fmt(excluded)}</strong></div>
    ${studentLoanPayments ? `<div class="list-row"><span>Student loan payments included</span><strong class="numeric">${fmt(studentLoanPayments)}</strong></div>` : ""}
    <div class="list-row"><span>Unverified outflows included</span><strong class="numeric">${fmt(unverifiedDebits)}</strong></div></details>`;
}

function loadMonthReport() {
  const defaults = {range: 12, includeCurrent: true, scenario: "total", rentLabels: "", loanLabels: ""};
  try {
    const prefs = JSON.parse(localStorage.getItem(monthReportKey));
    if (!prefs || typeof prefs !== "object") return defaults;
    return {
      range: monthRanges.includes(prefs.range) ? prefs.range : defaults.range,
      includeCurrent: typeof prefs.includeCurrent === "boolean" ? prefs.includeCurrent : defaults.includeCurrent,
      scenario: Object.hasOwn(monthScenarios, prefs.scenario) ? prefs.scenario : defaults.scenario,
      rentLabels: typeof prefs.rentLabels === "string" ? prefs.rentLabels.slice(0, 1000) : "",
      loanLabels: typeof prefs.loanLabels === "string" ? prefs.loanLabels.slice(0, 1000) : "",
    };
  } catch (_) {
    return defaults;
  }
}

function saveMonthReport(updates) {
  Object.assign(state.monthReport, updates);
  try {
    localStorage.setItem(monthReportKey, JSON.stringify(state.monthReport));
  } catch (_) {
    // The report remains usable for this session when browser storage is unavailable.
  }
}

function monthReportLabel(value) {
  return normalizeMerchant(value).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function monthReportLabels(value) {
  return new Set(value.split("\n").map(monthReportLabel).filter(Boolean));
}

function monthReportExpenseType(row, rentLabels, loanLabels) {
  const descriptions = [row.description, row.posted_merchant, row.merchant, row.assigned_merchant].filter(Boolean).map(monthReportLabel);
  const detail = String(row.source_detail || "").toLowerCase();
  const words = descriptions.join(" ");
  if (row.category === "student_loan_payments" || descriptions.some(label => loanLabels.has(label))) return "loans";
  if (descriptions.some(label => rentLabels.has(label))) return "rent";
  if (/(?:^|_)student_loans?(?:_|$)/.test(detail) || /\bstudent loans?\b|\bdept education student ln\b/.test(words)) return "loans";
  if (detail === "housing_rent") return "rent";
  if (row.category === "housing" && /\brent\b/.test(words) && !/\b(deposit|insurance|late fee)\b/.test(words)) return "rent";
  return "";
}

function monthReportData(transactions, today, currency, prefs) {
  const [year, month] = today.split("-").map(Number);
  const end = month - (prefs.includeCurrent ? 1 : 2);
  const keys = Array.from({length: prefs.range}, (_, i) => new Date(Date.UTC(year, end - prefs.range + 1 + i, 1)).toISOString().slice(0, 7));
  const buckets = new Map(keys.map(key => [key, []]));
  for (const row of transactions) {
    if (row.currency === currency && row.date <= today) buckets.get(row.date.slice(0, 7))?.push(row);
  }
  const rentLabels = monthReportLabels(prefs.rentLabels);
  const loanLabels = monthReportLabels(prefs.loanLabels);
  const months = keys.map(key => {
    const records = buckets.get(key);
    const rows = spendingRows(records);
    const typed = rows.map(row => ({row, type: monthReportExpenseType(row, rentLabels, loanLabels)}));
    const scenarios = {
      total: rows,
      withoutLoans: typed.filter(item => item.type !== "loans").map(item => item.row),
      withoutRent: typed.filter(item => item.type !== "rent").map(item => item.row),
      withoutBoth: typed.filter(item => !item.type).map(item => item.row),
    };
    const totals = Object.fromEntries(Object.entries(scenarios).map(([id, group]) => [id, amounts(group)]));
    return {name: monthName(key), key, recorded: records.length > 0, rows, totals,
      categories: new Map(byCategory(rows).map(group => [group.key, group.total]))};
  });
  const recorded = months.filter(month => month.recorded).length;
  return {months, recorded, categories: byCategory(months.flatMap(month => month.rows))};
}

function monthReportOptions() {
  const prefs = state.monthReport;
  openDialog("Report settings", `<div class="fields">
    <p class="section-note">Add exact merchant names or statement descriptions to recognize payments the report misses. Enter one per line.</p>
    <label>Additional rent labels<textarea name="rentLabels" rows="3" maxlength="1000" spellcheck="false">${esc(prefs.rentLabels)}</textarea></label>
    <label>Additional student loan labels<textarea name="loanLabels" rows="3" maxlength="1000" spellcheck="false">${esc(prefs.loanLabels)}</textarea></label>
    <small class="muted">Settings are saved in this browser and only affect this report.</small></div>`, form => {
    const rentLabels = form.get("rentLabels").trim();
    const loanLabels = form.get("loanLabels").trim();
    const loans = monthReportLabels(loanLabels);
    if ([...monthReportLabels(rentLabels)].some(label => loans.has(label))) {
      throw Error("Use each payment label for either rent or student loans.");
    }
    saveMonthReport({rentLabels, loanLabels});
    render();
    requestAnimationFrame(() => $("#month-report-settings")?.focus());
  });
}

function monthList() {
  const prefs = state.monthReport;
  const today = state.data.setup.today;
  const {months, recorded, categories} = monthReportData(state.data.transactions, today, state.currency, prefs);
  const columns = [...months].reverse();
  const range = `${monthLabel(months[0].key)} – ${monthLabel(months.at(-1).key)}`;
  const controls = `<div class="month-report-controls">
    <label>Period <select id="month-report-range">${monthRanges.map(n => `<option value="${n}"${n === prefs.range ? " selected" : ""}>${n} months</option>`).join("")}</select></label>
    <label class="check"><input id="month-report-current" type="checkbox"${prefs.includeCurrent ? " checked" : ""}> Include month to date</label>
    <button id="month-report-settings" type="button" class="btn small" data-action="month-report-settings" aria-haspopup="dialog">Report settings</button></div>`;
  const scenarioControl = `<label class="chart-control"><span class="sr-only">Chart spending view</span><select id="month-report-scenario">
    ${Object.entries(monthScenarios).map(([id, label]) => `<option value="${id}"${id === prefs.scenario ? " selected" : ""}>${esc(label)}</option>`).join("")}</select></label>`;
  const moneyCell = (value, href) => {
    if (value === undefined) return '<td class="num month-report-missing"><span aria-hidden="true">—</span><span class="sr-only">No records</span></td>';
    const text = fmt(value);
    const tone = value < 0 ? " positive" : value === 0 && !href ? " muted" : "";
    return `<td class="num numeric${tone}">${href ? `<a class="text-button" href="${href}">${text}</a>` : text}</td>`;
  };
  const headers = columns.map(({key, recorded}) => `<th scope="col" class="num"><a class="text-button" href="#months/${key}">${monthLabel(key)}</a>
    ${!recorded ? "<small>No records</small>" : key === today.slice(0, 7) ? "<small>To date</small>" : ""}</th>`).join("");
  const reportRow = (label, values, categoryKey) => {
    const total = values.reduce((sum, {amount}) => sum + (amount ?? 0), 0);
    return `<tr><th scope="row">${esc(label)}</th>${moneyCell(total / recorded)}${moneyCell(total)}
      ${values.map(({key, amount, drilldown}) => moneyCell(amount, categoryKey && drilldown ? `#months/${key}/${encodeURIComponent(categoryKey)}` : "")).join("")}</tr>`;
  };
  const summary = Object.entries(monthScenarios).map(([id, label]) => reportRow(label, columns.map(month => ({key: month.key,
    amount: month.recorded ? month.totals[id].total : undefined})))).join("");
  const breakdown = categories.map(group => reportRow(category(group.key), columns.map(month => ({key: month.key,
    amount: month.recorded ? month.categories.get(group.key) ?? 0 : undefined, drilldown: month.categories.has(group.key)})), group.key)).join("");
  const table = `<div class="table-wrap monthly-report" role="region" aria-label="Monthly spending by category" tabindex="0"><table>
    <thead><tr><th scope="col">Category</th><th scope="col" class="num">Monthly average</th><th scope="col" class="num">Period total</th>${headers}</tr></thead>
    <tbody class="monthly-report-totals">${summary}</tbody><tbody>${breakdown}</tbody></table></div>`;
  const note = `Net of applied refunds and reimbursements. Averages use ${recorded} ${recorded === 1 ? "month" : "months"} with records. Scroll for earlier months.`;
  const chart = monthlyChart(months.map(month => ({...month, ...month.totals[prefs.scenario]})), {breakdown: false, rolling: true});
  return heading("Monthly spending", range, '<a class="btn" href="#setup/coverage">Check data coverage</a>') + controls +
    (recorded ? `<div class="stack">${panel("Spending by category", table, note)}${panel("Spending over time", chart, "", scenarioControl)}</div>` :
      panel("No records in this period", '<p>Choose a different period or <a class="text-button" href="#setup/start">import transactions</a>.</p>'));
}

function monthDetail(key) {
  const today = state.data.setup.today;
  const current = state.data.transactions.filter(row => row.currency === state.currency && row.date.startsWith(key) && row.date <= today);
  const purchases = spendingRows(current);
  const isCurrent = key === today.slice(0, 7);
  const received = current.filter(row => row.amount < 0 && ["credit", "income"].includes(row.kind));
  const selected = route()[2];
  const activity = selected ? purchases.filter(row => row.category === selected || (selected === "shopping" && row.category === "health_wellness")) : purchases;
  const creditEntries = purchases.flatMap(row => row.kind === "category_credit"
    ? [{credit: row.id, amount: row.offset, detail: category(row.category) + " · category credit"}]
    : (row.applied_credits || []).map(link => ({...link, detail: "Applied to " + merchant(row)})));
  const credits = creditEntries.map(({credit, amount, detail}) => {
    const receipt = currentRowMap.get(credit);
    if (!receipt) return "";
    return `<a class="list-row" href="#reimbursements/${encodeURIComponent(credit)}"><span><strong>${esc(merchant(receipt))}</strong>
      <small class="muted">${labelDate(receipt.date)} · ${esc(detail)}</small></span><b class="numeric">${fmt(amount)}</b></a>`;
  }).join("");
  const actions = `<div class="actions">${button("View transactions", "jump", "spending-activity")}
    ${credits ? button("View refunds/reimbursements", "jump", "spending-credits") : ""}</div>`;
  return '<a class="back" href="#months">All months</a>' +
    heading(`${monthName(key)} ${key.slice(0, 4)}`, "See spending, largest purchases, and credits for the month.", actions) + metrics(purchases, isCurrent ? "Month to date" : "") +
    `<div class="stack">${panel("Spending by category", categoryList(purchases, Infinity, group => `#months/${key}/${encodeURIComponent(group)}`), "Select a category to filter the transactions.")}
    ${panel("Largest purchases", `<div class="purchase-strip">${topPurchases(purchases)}</div>`, "Ranked by net cost.")}
    <div id="spending-activity" tabindex="-1">${panel(selected ? category(selected) + " activity" : "Purchases & category credits", transactionTable(activity, true, "spending"),
      selected ? `${monthName(key)} ${key.slice(0, 4)} · ${fmt(amounts(activity).total)} net` : "", selected ? `<a class="btn small" href="#months/${key}">Show all</a>` : "")}</div>
    ${credits ? `<div id="spending-credits" tabindex="-1">${panel("Refunds/reimbursements applied this month", `<div class="month-credit-list">${credits}</div>`, `${fmt(sum(creditEntries, "amount"))} reduced spending in ${monthName(key)}. Receipt dates may differ.`)}</div>` : ""}
    ${panel("Credits & income received", transactionTable(received, false, "received"), "Shown in the month the money arrived. Credits linked to purchases reduce spending in the original purchase month.")}
    </div>`;
}

function shoppingGroup(row) {
  if (row.kind === "category_credit") return row.category === "health_wellness" ? "health_wellness" : "category_credits";
  return row.shopping_subcategory || (row.category === "health_wellness" ? "health_wellness" : "general");
}

function shoppingLabel(key) {
  if (key === "category_credits") return "Category-only credits";
  return Object.hasOwn(state.data.shopping_subcategories, key) ? state.data.shopping_subcategories[key] : "";
}

function shoppingBreakdown(purchases) {
  const groups = new Map();
  for (const row of purchases) {
    const key = shoppingGroup(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const entries = [...groups].map(([key, rows]) => ({key, rows, ...amounts(rows)}))
    .sort((a, b) => b.total - a.total);
  const scale = Math.max(1, ...entries.map(row => Math.abs(row.total)));
  return entries.map(({key, rows, total, credits}, index) => `<a class="category-row shopping-row" href="#categories/shopping/${key}">
    <span class="left"><strong>${esc(shoppingLabel(key))}</strong>
    <small class="muted">${rows.filter(row => row.kind === "purchase").length} purchases${credits ? ` · ${fmt(credits)} credited` : ""}</small>
    <span class="progress" aria-hidden="true"><i style="--bar-color:${total < 0 ? "#287969" : categoryColors[index % categoryColors.length]};--fill:${Math.abs(total) / scale * 100}%"></i></span></span>
    <b class="numeric ${total < 0 ? "positive" : ""}">${fmt(total)}</b></a>`).join("") || empty("No shopping transactions in this period.");
}

function categoryInsights(rows, excluded = false) {
  const debits = rows.filter(row => row.amount > 0);
  const total = amounts(debits);
  const large = debits.filter(row => row.amount > 10000);
  const largeAmount = sum(large, "amount");
  const merchantTotals = new Map();
  for (const row of debits) {
    const key = merchantKey(row);
    merchantTotals.set(key, (merchantTotals.get(key) || 0) + net(row));
  }
  const topMerchant = [...merchantTotals.entries()].sort((a, b) => b[1] - a[1])[0];
  const topMonth = monthlyTotals(excluded ? debits : rows).sort((a, b) => b.total - a.total)[0];
  const unit = excluded ? "transfer" : "purchase";
  const largeShare = total.gross ? shareLabel.format(largeAmount / total.gross) : "0%";
  const cards = total.gross ? `
    <article><h3>${excluded ? "Transfers" : "Purchases"} over ${fmt(10000)}</h3>
      <strong class="numeric">${largeShare}</strong><small>${large.length} ${unit}${large.length === 1 ? "" : "s"} · ${fmt(largeAmount)} of gross outflows</small></article>
    ${topMerchant?.[1] > 0 ? `<article><h3>${excluded ? "Top counterparty" : "Top merchant"}</h3><strong>${esc(merchantLabel(topMerchant[0], debits.find(row => merchantKey(row) === topMerchant[0])))}</strong>
      <small>${fmt(topMerchant[1])} · ${shareLabel.format(topMerchant[1] / total.total)} of ${excluded ? "outgoing transfers" : "net purchases before category-only credits"}</small></article>` : ""}
    ${topMonth.total > 0 ? `<article><h3>Highest-cost month</h3><strong>${topMonth.name}</strong>
      <small>${fmt(topMonth.total)} ${excluded ? "moved out" : "net"}</small></article>` : ""}` : "";
  return panel("Insights", cards ? `<div class="insight-grid">${cards}</div>` : empty("No posted debits to analyze in this view."));
}

function chatContext(scope) {
  const key = JSON.stringify([scope.category, scope.subcategory || "", scope.tripId || null, scope.tripId ? null : state.year, state.currency]);
  if (!categoryChats.has(key)) {
    categoryChats.set(key, {draft: "", messages: [], pending: false, collapsed: false, error: ""});
  }
  return {...scope, year: state.year, currency: state.currency, chat: categoryChats.get(key)};
}

function chatWorkspace(scope, overview, transactions) {
  currentCategoryContext = chatContext(scope);
  const {chat} = currentCategoryContext;
  return `<div class="category-workspace${chat.collapsed ? " chat-collapsed" : ""}">
    <div class="category-overview stack">${overview}</div>
    <aside id="category-assistant" data-codex-chat class="panel" aria-labelledby="category-chat-title">${categoryChatPanel(currentCategoryContext)}</aside>
    <div class="category-transactions">${transactions}</div></div>`;
}

function categoryChatPanel(context) {
  const {name, year, currency, chat} = context;
  const dashboard = context.category === "" && !context.tripId;
  const prefix = dashboard ? "dashboard" : "category";
  const transcript = chat.messages.map(categoryChatMessage).join("");
  return `<div class="category-chat-header"><h2 id="${prefix}-chat-title">Ask Codex</h2>
    ${dashboard ? `<button type="button" class="icon-button" data-chat-close aria-label="Close Ask Codex">${icon("close")}</button>` :
      `<button id="category-chat-toggle" type="button" class="btn small" data-chat-toggle aria-expanded="${!chat.collapsed}" aria-controls="category-chat-body">${chat.collapsed ? "Expand" : "Collapse"}</button>`}</div>
    <div id="category-chat-body"${chat.collapsed ? " hidden" : ""}>
      <p class="category-chat-scope">${esc(name)} · ${esc(context.dates || year)} · ${esc(currency)}</p>
      <form data-chat-form>
        <label for="${prefix}-query" class="sr-only">Question about ${esc(name)}</label>
        <textarea id="${prefix}-query" data-chat-input rows="2" maxlength="4000" placeholder="Ask about spending or request an edit"${chat.pending ? " disabled" : ""}>${esc(chat.draft)}</textarea>
        <div class="chat-actions">
          <button data-chat-send type="submit" class="btn primary small"${chat.pending || !chat.draft.trim() ? " disabled" : ""}>Send</button>
          <button type="button" class="text-button" data-chat-clear${chat.messages.length && !chat.pending ? "" : " hidden"}>New chat</button>
        </div>
      </form>
      <p class="category-chat-note">Sends this view’s data to your signed-in Codex. Requested edits are saved to your local ledger.</p>
      <p class="category-chat-status" role="status"${chat.pending ? "" : " hidden"}>Codex is working…</p>
      <p class="category-chat-error" role="alert"${chat.error ? "" : " hidden"}>${esc(chat.error)}</p>
      <div class="category-chat-log" role="log" aria-label="Codex conversation" aria-relevant="additions" aria-busy="${chat.pending}">${transcript}</div>
    </div>`;
}

function categoryChatMessage({role, text}) {
  return `<article class="chat-message ${role}"><h3>${role === "user" ? "You" : "Codex"}</h3><p>${esc(text)}</p></article>`;
}

const dashboardAssistant = $("#dashboard-assistant");

function renderChat(root, context, focusSelector) {
  if (!root || !context) return;
  root.closest(".category-workspace")?.classList.toggle("chat-collapsed", context.chat.collapsed);
  root.innerHTML = categoryChatPanel(context);
  if (focusSelector) $(focusSelector, root)?.focus({preventScroll: true});
}

$("#codex-open").addEventListener("click", () => {
  if (!state.data) return;
  dashboardChatContext = chatContext({category: "", name: "Dashboard"});
  renderChat(dashboardAssistant, dashboardChatContext);
  dashboardAssistant.showModal();
  $("[data-chat-input]:enabled", dashboardAssistant)?.focus();
});

function chatFor(root) {
  return root === dashboardAssistant ? dashboardChatContext : currentCategoryContext;
}

function updateChatTurn(root, chat, message, failed = false) {
  if (root !== dashboardAssistant) root = $("#category-assistant");
  if (!root || chatFor(root)?.chat !== chat) return;
  const composer = $("[data-chat-input]", root);
  const transcript = $(".category-chat-log", root);
  const error = $(".category-chat-error", root);
  composer.disabled = chat.pending;
  composer.value = chat.draft;
  $("[data-chat-send]", root).disabled = chat.pending || !chat.draft.trim();
  $("[data-chat-clear]", root).hidden = chat.pending || !chat.messages.length;
  $(".category-chat-status", root).hidden = !chat.pending;
  error.hidden = !chat.error;
  error.textContent = chat.error;
  if (failed) transcript.lastElementChild?.remove();
  if (message) transcript.insertAdjacentHTML("beforeend", categoryChatMessage(message));
  transcript.setAttribute("aria-busy", String(chat.pending));
  transcript.scrollTop = transcript.scrollHeight;
}

function categoriesPage(key) {
  const rowsForYear = reportRows();
  const transfers = rowsForYear.filter(row => row.kind === "transfer");
  const purchases = spendingRows(rowsForYear);
  if (state.data.transfer_categories.includes(key)) {
    const rows = transfers.filter(row => row.category === key);
    return '<a class="back" href="#categories">All categories</a>' +
      heading(category(key), "Money movements excluded from spending totals.", "", state.year) +
      chatWorkspace({category: key, name: category(key)}, categoryInsights(rows, true),
        panel("Transactions", transactionTable(rows), "Positive amounts moved out and negative amounts moved in."));
  }
  if (key === "shopping" || key === "health_wellness") {
    const shopping = purchases.filter(row => ["shopping", "health_wellness"].includes(row.category));
    const requested = key === "health_wellness" ? "health_wellness" : route()[2];
    const selected = requested && shoppingLabel(requested) ? requested : "";
    const rows = selected ? shopping.filter(row => shoppingGroup(row) === selected) : shopping;
    const name = selected ? shoppingLabel(selected) : "Shopping";
    return `<a class="back" href="#categories${selected ? "/shopping" : ""}">${selected ? "All shopping" : "All categories"}</a>` +
      heading(name, selected ? "Shopping · transaction details" : "See where your shopping went after credits.", "", state.year) +
      metrics(rows) + chatWorkspace({category: "shopping", subcategory: selected, name},
        categoryInsights(rows) + (selected ? "" : panel("Shopping breakdown", shoppingBreakdown(shopping), "Select a subcategory to see its transactions.")),
        panel("Transactions", transactionTable(rows, true, "spending")));
  }
  if (key && state.data.categories[key]) {
    const rows = purchases.filter(row => row.category === key);
    const total = amounts(rows).total;
    const positiveTotal = sum(byCategory(purchases).filter(group => group.total > 0), "total");
    const share = total > 0 && positiveTotal ? `${shareLabel.format(total / positiveTotal)} of positive net category spending · ${state.year}` : "";
    return '<a class="back" href="#categories">All categories</a>' + heading(category(key), share || "Review and recategorize individual transactions.", "", state.year) +
      metrics(rows) + chatWorkspace({category: key, name: category(key)}, categoryInsights(rows),
        panel("Transactions", transactionTable(rows, true, "spending")));
  }
  const groups = byCategory(purchases);
  const positiveTotal = sum(groups.filter(group => group.total > 0), "total");
  const rows = groups.map(group => `<tr><td><a class="text-button" href="#categories/${encodeURIComponent(group.key)}">${esc(category(group.key))}</a></td>
    <td class="num numeric">${fmt(group.gross)}</td><td class="num numeric">${fmt(group.credits)}</td><td class="num numeric"><strong>${fmt(group.total)}</strong></td>
    <td class="num numeric">${group.total > 0 ? shareLabel.format(group.total / positiveTotal) : "—"}</td></tr>`).join("");
  const excluded = state.data.transfer_categories.map(key => {
    const count = transfers.filter(row => row.category === key).length;
    return `<a class="tile" href="#categories/${key}"><h2>${esc(category(key))}</h2><p class="muted">${count} posted entries</p></a>`;
  }).join("");
  return heading("Categories", "See what you spend on and drill into any category.", "", state.year) +
    `<div class="stack"><div class="category-report">${panel("Spending mix", categoryMix(purchases), "Share of categories with positive net spending")}</div>
    <div id="category-breakdown" tabindex="-1">${panel("Category breakdown", rows ? `<div class="table-wrap"><table><thead><tr><th scope="col">Category</th><th scope="col" class="num">Gross</th><th scope="col" class="num">Credits</th><th scope="col" class="num">Net</th><th scope="col" class="num">Share</th></tr></thead><tbody>${rows}</tbody></table></div>` : empty("No posted purchases in this year."), "Net is gross spending minus refunds and reimbursements applied to spending.")}</div>
    ${panel("Excluded from spending", `<div class="tile-grid">${excluded}</div>`)}</div>`;
}

function merchantsPage(key) {
  const rows = reportRows().filter(hasMerchantHistory);
  if (key) {
    const activity = rows.filter(row => merchantKey(row) === key);
    const purchases = spendingRows(activity);
    const receipts = key === "costco" ? (state.data.costco_receipts || []).filter(r =>
      r.date.startsWith(state.year) && state.currency === "USD") : [];
    const receiptList = receipts.map(receipt => `<div class="list-row">
      <div><button class="text-button" type="button" data-action="costco-receipt" data-value="${esc(receipt.id)}">${labelDate(receipt.date)} receipt</button>
      <small class="muted">${receiptStatus(receipt)}</small></div>
      <strong class="numeric">${fmt(receipt.amount)}</strong></div>`).join("");
    return '<a class="back" href="#merchants">All merchants</a>' +
      heading(merchantLabel(key, activity.find(row => row.assigned_merchant) || activity[0]), "Browse purchases, credits, and available receipt details.", "", state.year) +
      metrics(purchases) + `<div class="stack">${receipts.length ? panel("Saved Costco receipts", receiptList) : ""}
      ${panel("Transactions", transactionTable(activity, true, "merchant"))}</div>`;
  }
  const groups = new Map();
  for (const row of rows) {
    const group = merchantKey(row);
    if (!group) continue;
    if (!groups.has(group)) groups.set(group,{key:group,label:merchantLabel(group,row),count:0,gross:0});
    const entry = groups.get(group);
    if (row.assigned_merchant && !entry.assigned) {
      entry.label = row.assigned_merchant;
      entry.assigned = true;
    }
    entry.count++;
    if (row.amount > 0 && row.kind !== "transfer") entry.gross += row.amount;
  }
  const search = state.search.trim().toLowerCase();
  const scope = "merchant-list";
  const matching = [...groups.values()].filter(row => !search || row.label.toLowerCase().includes(search));
  const visible = sortedRows(matching, scope, {merchant: row => row.label, amount: row => row.gross, count: row => row.count}, ["amount", -1]);
  const pages = Math.max(1, Math.ceil(visible.length / 25));
  state.page = Math.min(pages, state.page);
  const entries = visible.slice((state.page - 1) * 25, state.page * 25)
    .map(row => `<tr><td><a class="text-button" href="${esc(merchantHref(row.key))}">${esc(row.label)}</a></td>
      <td class="num numeric">${row.count}</td><td class="num numeric"><strong>${fmt(row.gross)}</strong></td></tr>`).join("");
  return heading("Merchants", "Find all purchases and refunds for a merchant.", '<div class="actions"><a class="btn" href="#merchants/costco">Costco</a><a class="btn" href="#merchants/amazon">Amazon</a></div>', state.year) +
    panel("Merchant directory", `<div class="toolbar"><input id="tx-search" type="search" aria-label="Search merchants" placeholder="Search merchants" value="${esc(state.search)}"><small>${matching.length} merchants</small></div>
    ${entries ? `<div class="table-wrap"><table><thead><tr>${sortHeading("Merchant", "merchant", scope, ["amount", -1])}
      ${sortHeading("Transactions", "count", scope, ["amount", -1], true)}${sortHeading("Gross purchases", "amount", scope, ["amount", -1], true)}</tr></thead><tbody>${entries}</tbody></table></div>${pagination(pages)}` : empty("No merchants found.")}`);
}

function receiptStatus(receipt) {
  if (receipt.status === "matched") return "Matched to a ledger purchase";
  if (receipt.status === "ambiguous") return "Multiple possible ledger matches";
  return "No matching ledger charge";
}

const transactionFilters = [
  ["all", "All activity"], ["purchases", "Purchases"], ["credits", "Reimbursements"],
  ["transfers", "Transfers"], ["income", "Income"],
];

function transactionsPage(key) {
  const active = transactionFilters.some(([value]) => value === key) ? key : "all";
  const rows = reportRows().filter(row => !state.account || row.account === state.account).filter(row => {
    if (active === "all") return true;
    if (active === "purchases") return row.amount > 0 && row.kind !== "transfer";
    return row.kind === {credits: "credit", transfers: "transfer", income: "income"}[active];
  });
  const tabs = transactionFilters.map(([id, label]) => `<a class="view-tab" href="#transactions${id === "all" ? "" : "/" + id}" ${active === id ? 'aria-current="page"' : ""}>${label}</a>`).join("");
  const account = `<label class="account-filter"><span class="sr-only">Filter by account</span><select id="transaction-account"><option value="">All accounts</option>
    ${state.data.accounts.map(a => `<option value="${esc(a.id)}"${a.id === state.account ? " selected" : ""}>${esc(a.label)}</option>`).join("")}</select></label>`;
  return heading("Transactions", "Search and filter your posted activity.", "", state.year) +
    panel(transactionFilters.find(([id]) => id === active)[1], `<div class="list-filters"><nav class="view-tabs" aria-label="Transaction types">${tabs}</nav>${account}</div>
      ${transactionTable(rows, true, "ledger")}`);
}

function tableAmount(row, scope) {
  if (row.kind === "category_credit") return -row.offset;
  if (row.kind === "purchase") return net(row);
  if (scope.endsWith(":ledger")) return Math.abs(row.amount);
  return row.kind === "transfer" || scope.endsWith(":merchant") ? row.amount : Math.abs(row.amount);
}

function creditAmountNote(row) {
  return row.kind === "purchase" && row.offset ? `<small class="muted">${fmt(row.offset, row.currency)} credited</small>` : "";
}

function pagination(pages) {
  if (pages <= 1) return "";
  return `<div class="toolbar page-controls"><small class="muted">Page ${state.page} of ${pages}</small><div class="actions">
    ${state.page > 1 ? button("Previous", "page", state.page - 1, "small") : ""}
    ${state.page < pages ? button("Next", "page", state.page + 1, "small") : ""}</div></div>`;
}

function transactionTable(rows, controls = true, section = "activity") {
  if (!rows.length) return empty("No transactions to show.");
  const scope = route().join("/") + ":" + section;
  const needle = controls ? state.search.trim().toLowerCase() : "";
  const found = rows.filter(row => !needle || [
    merchant(row), row.assigned_merchant, row.description, row.date, category(row.category), currentAccountMap.get(row.account)?.label, fmt(Math.abs(row.amount), row.currency),
  ].some(value => value?.toLowerCase().includes(needle)));
  const filtered = sortedRows(found, scope, {
    merchant, date: row => row.date, category: row => category(row.category), amount: row => tableAmount(row, scope),
  });
  if (!controls) return tableBody(filtered.slice(0, 15), false, scope, filtered.length > 15 ?
    `<p class="section-note">Showing 15 of ${filtered.length} in the selected order.</p>` : "");
  const pageCount = Math.max(1, Math.ceil(filtered.length / 25));
  state.page = Math.min(state.page, pageCount);
  const start = (state.page - 1) * 25;
  const displayed = filtered.slice(start, start + 25);
  const footer = pagination(pageCount);
  const standalone = filtered.filter(row => row.kind === "category_credit").length;
  const count = standalone ? `${filtered.length - standalone} debits · ${standalone} category ${standalone === 1 ? "credit" : "credits"}` : `${filtered.length} found`;
  return `<div class="toolbar"><input id="tx-search" type="search" aria-label="Search transactions" placeholder="Merchant, amount, date or account" value="${esc(state.search)}">
    <div class="actions"><small class="muted">${count}${state.selected.size ? ` · ${state.selected.size} selected` : ""}</small>
    ${state.selected.size ? button("Change category", "bulk", "", "small") + button("Assign merchant", "bulk-merchant", "", "small") + button("Assign trip", "bulk-trip", "", "small") : ""}</div></div>${displayed.length ? tableBody(displayed, true, scope, footer) : empty("No matching transactions.")}`;
}

function tableBody(rows, controls, scope, footer = "") {
  return `<div class="table-wrap"><table><thead><tr>${controls ? '<th scope="col" aria-label="Select"></th>' : ""}
    ${sortHeading("Transaction", "merchant", scope)}${sortHeading("Date", "date", scope)}
    ${sortHeading("Category", "category", scope)}${sortHeading(scope.endsWith(":spending") ? "Net amount" : "Amount", "amount", scope, undefined, true)}</tr></thead>
    <tbody>${rows.map(row => {
    const direct = row.kind === "category_credit";
    const ledger = scope.endsWith(":ledger");
    const incoming = ledger && row.amount < 0;
    const direction = incoming ? (row.kind === "transfer" ? "Moved in" : "Received") :
      ledger && row.kind === "transfer" ? "Moved out" : "";
    const action = direct || (row.kind === "credit" && /:(merchant|ledger)$/.test(scope)) ? `<a class="text-button" href="#reimbursements/${encodeURIComponent(row.id)}">${esc(merchant(row))}</a>` :
      `<button class="text-button" data-action="transaction" data-value="${esc(row.id)}">${esc(merchant(row))}</button>`;
    return `<tr>${controls ? `<td>${!direct ? `<input data-select="${esc(row.id)}" type="checkbox" aria-label="Select ${esc(merchant(row))}" ${state.selected.has(row.id) ? "checked" : ""}>` : ""}</td>` : ""}
    <td><div class="table-entity"><span class="entity-icon">${icon(row.kind === "credit" || direct ? "reimbursements" : row.kind === "transfer" ? "transactions" : "receipt")}</span><div>${action}<small>${esc(currentAccountMap.get(row.account)?.label || "")}
    ${row.amazon_items?.length ? (row.amazon_order?.match_basis === "date_amount" ? " · Likely order match" : " · Order details available") : ""}</small>
    ${row.assigned_merchant && !scope.endsWith(":merchant") ? `<small><a href="${esc(merchantHref(merchantKey(row)))}">${esc(row.assigned_merchant)}</a></small>` : ""}
    ${row.amazon_items?.length && scope.endsWith(":merchant") ? `<small class="order-preview">${esc(row.amazon_items[0])}${row.amazon_items.length > 1 ? ` · +${row.amazon_items.length - 1} more` : ""}</small>` : ""}</div></div></td>
    <td class="numeric">${labelDate(row.date)}</td><td>${esc(category(row.category))}
    ${row.shopping_subcategory ? `<small>${esc(shoppingLabel(row.shopping_subcategory))}</small>` : ""}</td>
    <td class="num numeric ${direct || incoming ? "positive" : ""}">${fmt(tableAmount(row, scope), row.currency)}${direct ? "<small>Category credit</small>" : creditAmountNote(row)}
      ${direction ? `<small>${direction}</small>` : ""}</td></tr>`;
  }).join("")}</tbody></table></div>${footer}`;
}

function tripRows(id) {
  return state.data.transactions.filter(row => row.kind === "purchase" && row.trip === id && row.currency === state.currency);
}

function tripDates(trip) {
  const start = trip.start || trip.end;
  const end = trip.end || start;
  if (!start) return "No recorded dates";
  const format = new Intl.DateTimeFormat("en", {month: "short", day: "numeric", year: "numeric", timeZone: "UTC"});
  return format.formatRange(new Date(start), new Date(end));
}

function tripTimeline(trips) {
  const yearStart = Date.parse(monthKey(state.year, 0) + "-01");
  const yearEnd = Date.parse(`${Number(state.year) + 1}-01-01`);
  const position = date => Math.min(100, Math.max(0, (date - yearStart) / (yearEnd - yearStart) * 100));
  const ticks = monthNames.map((name, i) =>
    `<span style="--at:${position(Date.parse(monthKey(state.year, i) + "-01"))}%">${name.slice(0, 3)}</span>`).join("");
  const entries = trips.map(trip => {
    const rows = tripRows(trip.id);
    return {trip, count: rows.length, ...amounts(rows)};
  });
  if (state.tripOrder === "cost") entries.sort((a, b) => b.total - a.total);
  return `<div class="trip-timeline"><div class="trip-timeline-head"><span>Trip</span><div class="trip-ticks" aria-hidden="true">${ticks}</div><span>Net cost</span></div>
    ${entries.map(({trip, count, total, credits}) => {
      const start = Date.parse(trip.start || trip.end);
      const end = Date.parse(trip.end || trip.start) + 86400000;
      const bar = Number.isFinite(start)
        ? `<i style="--at:${position(start)}%;--duration:${position(end) - position(start)}%"></i>` : "";
      return `<a class="trip-timeline-row" href="#trips/${trip.id}">
        <div><strong>${esc(trip.name)}</strong><small>${tripDates(trip)} · ${count} ${count === 1 ? "purchase" : "purchases"}</small></div>
        <div class="trip-track" aria-hidden="true">${ticks}${bar}</div>
        <div class="trip-cost"><strong class="numeric">${fmt(total)}</strong>
          ${credits ? `<small>${fmt(credits)} credited</small>` : ""}</div></a>`;
    }).join("")}</div>`;
}

function tripInsights(rows) {
  if (!rows.length) return panel("Insights", empty("No purchases to analyze for this trip."));
  const {gross, credits, total} = amounts(rows);
  const top = byCategory(rows)[0];
  const daily = new Map();
  for (const row of rows) {
    const day = row.travel_date || row.date;
    daily.set(day, (daily.get(day) || 0) + net(row));
  }
  const [day, dayNet] = [...daily].sort((a, b) => b[1] - a[1])[0];
  return panel("Insights", `<div class="insight-grid">
    ${top.total > 0 ? `<article><h3>Top spending category</h3><strong>${esc(category(top.key))}</strong>
      <small>${fmt(top.total)} · ${shareLabel.format(top.total / total)} of net trip cost</small></article>` : ""}
    ${dayNet > 0 ? `<article><h3>Highest-cost day</h3><strong>${labelDate(day)}</strong><small>${fmt(dayNet)} net</small></article>` : ""}
    <article><h3>Refunds &amp; reimbursements</h3><strong class="numeric">${fmt(credits)}</strong>
      <small>${gross ? shareLabel.format(credits / gross) : "0%"} of gross spending credited</small></article>
  </div>`);
}

function tripsPage(id) {
  const trips = state.data.trips.filter(t => ["automatic", "confirmed"].includes(t.status));
  const trip = trips.find(t => String(t.id) === id);
  if (trip) {
    const purchases = tripRows(trip.id);
    const selected = route()[2];
    const activity = selected ? purchases.filter(row => row.category === selected || (selected === "shopping" && row.category === "health_wellness")) : purchases;
    const caption = trip.booking ? "Booking group" : "Purchase activity";
    return '<a class="back" href="#trips">All trips</a>' + heading(trip.name, caption + " · " + tripDates(trip),
      button("Edit trip", "trip-edit", trip.id) + " " + button("Merge", "trip-merge", trip.id)) +
      metrics(purchases) + chatWorkspace({category: "", tripId: trip.id, name: trip.name, dates: tripDates(trip)},
      tripInsights(purchases) +
      (purchases.length ? panel("Spending by category", categoryList(purchases, Infinity, group => `#trips/${trip.id}/${encodeURIComponent(group)}`), "Select a category to filter the transactions.") : ""),
      `<div id="spending-activity" tabindex="-1">${panel(selected ? category(selected) + " activity" : trip.booking ? "Booking purchases" : "Trip purchases", transactionTable(activity, true, "spending"), "", `<div class="actions">
      ${selected ? `<a class="btn small" href="#trips/${trip.id}">Show all</a>` : ""}${state.selected.size ? button("Split selected", "trip-split", trip.id) : ""}${button("Add purchases", "trip-add", trip.id)}</div>`)}</div>`);
  }
  const selected = trips.filter(t => (!t.start && !t.end) ||
    ((t.start || t.end).slice(0, 4) <= state.year && (t.end || t.start).slice(0, 4) >= state.year));
  const itineraries = selected.filter(t => !t.booking);
  const bookings = selected.filter(t => t.booking);
  const tripOrder = `<label class="chart-control"><span class="sr-only">Order trips</span><select id="trip-order">
    <option value="date"${state.tripOrder === "date" ? " selected" : ""}>By date</option><option value="cost"${state.tripOrder === "cost" ? " selected" : ""}>By net cost</option></select></label>`;
  return heading("Trips", "See when each trip took place and compare what it cost.",
    button("Create trip", "trip-edit", "", "primary"), state.year) +
    `<div class="stack">${panel("Trip timeline", itineraries.length ? tripTimeline(itineraries) : empty("No trips in this year."), "", itineraries.length ? tripOrder : "")}
    ${bookings.length ? panel("Other travel bookings", tripTimeline(bookings), "Unassigned, unconfirmed, and cancelled bookings.") : ""}</div>` +
    `<p class="section-note"><a class="text-button" href="#review/trips">Review suggested trips</a> · <a class="text-button" href="#data">Set your home city</a></p>`;
}

function creditStatus(row) {
  if (row.dismissed || row.assignment?.treatment === "exclude") return ["Excluded", "excluded"];
  if (row.remaining > 0) return row.links.length ? ["Partly applied", "unassigned"] : ["Unassigned", "unassigned"];
  return [row.links.length ? "Linked to purchase" : "Category only", "applied"];
}

function creditCategory(row) {
  if (row.direct_offset) return category(row.assignment.category);
  const categories = [...new Set(row.links.map(link => category(currentRowMap.get(link.purchase)?.category)))];
  return categories.length ? categories.join(", ") : "—";
}

function reimbursementsPage(id) {
  const item = currentRowMap.get(id);
  if (item?.kind === "credit") {
    return '<a class="back" href="#reimbursements">All reimbursements</a>' +
      heading(merchant(item), "Review the category, payment, and any purchase links.",
        `<div class="actions">${button("Assign merchant", "assign-merchant", item.id)}${button("Change category", "assign-credit", item.id, "primary")}</div>`) +
      (item.assigned_merchant ? `<p class="section-note"><a href="${esc(merchantHref(merchantKey(item)))}">${esc(item.assigned_merchant)}</a></p>` : "") +
      panel("Receipt details", creditCard(item), item.assignment?.reason || "Incoming credit.");
  }
  const rows = reportRows().filter(row => row.kind === "credit");
  const scope = "reimbursements";
  const needle = state.search.trim().toLowerCase();
  const filtered = sortedRows(rows.filter(row => (state.creditFilter === "all" || creditStatus(row)[1] === state.creditFilter) &&
    (!needle || [merchant(row), row.assigned_merchant, row.description, creditCategory(row), row.date].some(value => value?.toLowerCase().includes(needle)))),
  scope, {merchant, date: row => row.date, amount: row => -row.amount, category: creditCategory, status: row => creditStatus(row)[0]});
  const pageCount = Math.max(1, Math.ceil(filtered.length / 25));
  state.page = Math.min(state.page, pageCount);
  const visible = filtered.slice((state.page - 1) * 25, state.page * 25);
  const applied = rows.reduce((sum, row) => sum + row.direct_offset + row.links.reduce((n, link) => n + link.amount, 0), 0);
  const unassigned = rows.filter(row => creditStatus(row)[1] === "unassigned");
  const toolbar = `<div class="toolbar"><div class="inline">
    <input id="tx-search" type="search" aria-label="Search reimbursements" placeholder="Search merchant, category or date" value="${esc(state.search)}">
    <label class="inline">Treatment <select id="credit-filter">${[["all","All"],["applied","Applied"],["unassigned","Unassigned"],["excluded","Excluded"]].map(([key,label]) => `<option value="${key}" ${state.creditFilter === key ? "selected" : ""}>${label}</option>`).join("")}</select></label>
    </div><small class="muted">${filtered.length} receipts</small></div>`;
  const table = visible.length ? `<div class="table-wrap"><table><thead><tr>
    ${sortHeading("Receipt", "merchant", scope)}${sortHeading("Date", "date", scope)}
    ${sortHeading("Category", "category", scope)}${sortHeading("Amount received", "amount", scope, undefined, true)}
    ${sortHeading("Treatment", "status", scope)}<th scope="col">Edit</th>
    </tr></thead><tbody>${visible.map(row => {
      const [label, status] = creditStatus(row);
      return `<tr><td><a class="text-button" href="#reimbursements/${encodeURIComponent(row.id)}"><strong>${esc(merchant(row))}</strong></a>
        <small>${esc(currentAccountMap.get(row.account)?.label || "")}</small></td><td class="numeric">${labelDate(row.date)}</td>
        <td>${esc(creditCategory(row))}</td><td class="num numeric">${fmt(-row.amount, row.currency)}</td>
        <td>${badge(label, status === "applied" ? "mint" : status === "unassigned" ? "amber" : "")}
        ${row.assignment?.source === "manual" ? "<small>Edited by you</small>" : ""}</td>
        <td>${button("Reassign", "assign-credit", row.id, "small")}</td></tr>`;
    }).join("")}</tbody></table></div>` : empty("No receipts match this filter.");
  const footer = pageCount > 1 ? `<div class="toolbar"><small class="muted">Page ${state.page} of ${pageCount}</small><div class="actions">
    ${state.page > 1 ? button("Previous", "page", state.page - 1, "small") : ""}
    ${state.page < pageCount ? button("Next", "page", state.page + 1, "small") : ""}</div></div>` : "";
  return heading("Reimbursements", "See what came back, how it was applied, and change any assignment.", "", state.year) +
    `<div class="metrics"><section class="metric lead"><div class="label">Applied to spending</div><div class="metric-value numeric">${fmt(applied)}</div><small>For receipts posted in ${state.year}</small></section>
    <section class="metric"><div class="label">Unassigned</div><div class="metric-value numeric">${fmt(sum(unassigned, "remaining"))}</div><small>${unassigned.length} receipts with an unapplied balance</small></section>
    <section class="metric"><div class="label">Receipts tracked</div><div class="metric-value numeric">${rows.length}</div><small>Includes excluded receipts</small></section></div>` +
    panel("Refunds & reimbursements", toolbar + table + footer, "Linked credits follow the purchase date. Category-only credits apply on the date received.");
}

const reviewCategories = () => reportRows().filter(row => row.review);
const reviewTrips = () => state.data.trips.filter(t => t.status === "suggested" && (t.start.startsWith(state.year) || t.end.startsWith(state.year)));
function reviewPage(which) {
  const tab = which === "trips" ? "trips" : "categories";
  const categories = reviewCategories();
  const trips = reviewTrips();
  const tabList = [["categories", "Categories", categories.length], ["trips", "Trips", trips.length]];
  const tabs = tabList.map(([key, title, count]) => `<a class="btn ${tab === key ? "primary" : ""}" href="#review/${key}" ${tab === key ? 'aria-current="page"' : ""}>${title} (${count})</a>`).join("");
  const content = tab === "trips" ? trips.map(t => `<div class="review-item"><div class="inline"><h3>${esc(t.name)}</h3>${badge(t.suggested_count + " purchases", "amber")}</div>
    <small class="muted">${labelDate(t.start)} – ${labelDate(t.end)} · ${esc(t.reason)}</small>
    <div class="inline">${button("Review trip", "trip-edit", t.id, "small")}${button("Dismiss", "trip-dismiss", t.id, "small")}</div></div>`).join("") : transactionTable(categories);
  return heading("Review", "Check uncertain purchase categories and suggested trips.", '<a class="btn" href="#reimbursements">See reimbursements</a>', state.year) +
    `<div class="tabs">${tabs}</div>` + panel(tab === "trips" ? "Trips" : "Categories", content || empty("Nothing to review here."));
}

function creditCard(row) {
  const matches = row.matches.map(match => {
    const purchase = currentRowMap.get(match.id);
    if (!purchase) return "";
    return `<div class="match"><div class="inline"><strong>${esc(merchant(purchase))}</strong> <small>${labelDate(purchase.date)}</small></div>
      <small>${esc(match.reason)} · ${fmt(Math.min(match.amount, row.remaining), row.currency)} proposed</small>
      ${button("Review match", "match", JSON.stringify([row.id, match.id]), "small")}</div>`;
  }).join("");
  const links = row.links.map(link => `<div class="match"><div class="inline"><button type="button" class="text-button" data-action="transaction" data-value="${esc(link.purchase)}"><strong>${esc(merchant(currentRowMap.get(link.purchase)))}</strong></button> <small>${fmt(link.amount, row.currency)} applied</small></div>
    ${button("Edit allocation", "match", JSON.stringify([row.id, link.purchase]), "small")}
    ${button("Undo", "undo-match", JSON.stringify([row.id, link.purchase]), "small")}</div>`).join("");
  return `<article class="review-item"><div class="inline">${button("View original transaction", "transaction", row.id, "small")}<span class="credit-amount numeric">${fmt(-row.amount, row.currency)}</span></div>
    <small class="muted">${labelDate(row.date)} · ${esc(currentAccountMap.get(row.account)?.label || "")} · ${fmt(row.remaining, row.currency)} unallocated</small>
    ${row.direct_offset ? `<small class="muted">${esc(creditCategory(row))} · ${fmt(row.direct_offset, row.currency)} applied on receipt date</small>` : ""}
    ${matches}${links ? `<div class="credit-links"><h3>Linked purchases</h3>${links}</div>` : ""}<div class="inline">${button("Find purchase", "match", JSON.stringify([row.id]), "small")}</div></article>`;
}

function dataPage() {
  const accounts = state.data.accounts;
  const latest = accounts.map(a => a.fresh).sort().at(-1);
  const table = accounts.length ? `<div class="table-wrap"><table><thead><tr><th>Account</th><th>Source</th><th>First record</th><th>Last record</th><th class="num">Posted</th></tr></thead><tbody>
    ${accounts.map(a => `<tr><td><strong>${esc(a.label)}</strong><small>${esc(a.coverage)}</small></td><td>${esc(a.source)}</td><td>${labelDate(a.first)}</td><td>${labelDate(a.last)}</td><td class="num numeric">${a.transactions}</td></tr>`).join("")}</tbody></table></div>` : empty("No accounts have been imported.");
  return heading("Data & backup", "Check your account coverage, add statements, and save a copy of your ledger.",
    button("Import CSV", "import", "", "primary")) + `<div class="stack">
    ${panel("Account coverage", table, latest ? "Last import " + labelDate(latest) + ". Date ranges show the records currently stored and may include gaps." : "")}
    <div class="grid">${panel("Trip detection", `<p class="section-note">Home city: ${esc(state.data.home || "Inferred from recurring in-person purchases")}</p>
    <p class="section-note">${state.data.model ? "A local model is enabled for purchase classification." : "Local rules classify new purchases and group trip activity."}</p>`, "", button("Set home city", "home", "", "small"))}
    ${panel("SQLite backup", '<p class="section-note">Includes transaction history, category edits, trips, and confirmed allocations. Store the downloaded copy in a private, encrypted location.</p>', "", button("Download backup", "backup", "", "small"))}</div>
    ${panel("Amazon orders", `<p class="section-note">${state.data.amazon_sync.orders} orders captured from Chrome · ${state.data.amazon_count} matched card charges</p>
    <p class="section-note">Use the paired Chrome connector with the local Amazon MCP to sync the selected year.</p>`, "", button("Import order snapshot", "amazon-capture", "", "small"))}
    ${panel("Setup and sharing", '<p class="section-note">Share the GitHub setup link so someone can start their own Spending Atlas dashboard. The database backup contains your financial data.</p>', "", '<div class="inline"><a class="btn small" href="#setup/coverage">Check coverage</a><a class="btn primary small" href="https://github.com/sohumsanu/spending-atlas#start-with-codex" target="_blank" rel="noopener noreferrer">Share setup link</a></div>')}</div>`;
}

const coverageDay = value => Date.parse(value + "T00:00:00Z") / 86400000;
const coverageDate = value => new Date(value * 86400000).toISOString().slice(0, 10);

function coverageReport(year) {
  const setup = state.data.setup;
  const end = [year + "-12-31", setup.today].sort()[0];
  const start = year + "-01-01";
  const accounts = new Map(setup.expected.map(row => [row.id, row]));
  state.data.accounts.forEach(row => accounts.set(row.id, row));
  const rows = [...accounts.values()].sort((a, b) => a.label.localeCompare(b.label)).map(account => {
    const windows = setup.windows.filter(entry => entry.account === account.id);
    const gaps = [];
    let next = coverageDay(start);
    const last = coverageDay(end);
    for (const window of windows) {
      const from = coverageDay(window.start);
      const to = coverageDay(window.end);
      if (from > last) break;
      if (to < next) continue;
      if (from > next) gaps.push([coverageDate(next), coverageDate(from - 1)]);
      next = to + 1;
    }
    if (next <= last) gaps.push([coverageDate(next), end]);
    return {...account, windows, gaps};
  });
  const confirmed = setup.years_confirmed.includes(year);
  return {rows, start, end, confirmed, complete: confirmed && !!rows.length && rows.every(row => !row.gaps.length)};
}

function coverageNotice(year) {
  const report = coverageReport(year);
  if (report.complete) return "";
  const gaps = report.rows.filter(row => row.gaps.length).length;
  const message = [
    !report.confirmed && "Confirm the accounts you used.",
    gaps && `${gaps} account${gaps === 1 ? " has" : "s have"} unverified dates.`,
    !report.rows.length && "Add an account to start checking dates.",
  ].filter(Boolean).join(" ");
  return `<section class="coverage-notice" aria-labelledby="coverage-notice-title">
    <div><h2 id="coverage-notice-title">${year} coverage needs review</h2>
    <p>${message} Totals reflect the records imported so far.</p></div>
    <div class="inline"><a class="btn small" href="#setup/coverage/${year}">See coverage gaps</a>
    ${button("Get Codex help", "setup-prompt", JSON.stringify({mode:"setup-bank", year}), "small")}</div></section>`;
}

const safeAccountLabel = label => label.replace(/\d(?:[ -]?\d){4,}/g, value => "••" + value.replace(/\D/g, "").slice(-4));

function suggestedRetailers(year) {
  const groups = new Map();
  for (const row of state.data.transactions) {
    const label = row.merchant?.trim();
    if (row.kind !== "purchase" || row.amount <= 0 || row.currency !== state.currency || !row.date.startsWith(year) ||
        !["shopping", "groceries"].includes(row.category) || !label || label.length > 80) continue;
    const key = merchantKey(row);
    if (["amazon", "costco", "paypal", "venmo", "unknown", "card transaction"].includes(key)) continue;
    const group = groups.get(key) || {name: safeAccountLabel(label), count: 0, amount: 0};
    group.count++;
    group.amount += row.amount;
    groups.set(key, group);
  }
  return [...groups.values()].filter(group => group.count >= 2)
    .sort((a, b) => b.amount - a.amount || b.count - a.count).slice(0, 3);
}

function setupPrompt(mode, requestedYear, retailer) {
  const s = state.data.setup;
  const year = requestedYear || setupYear || state.year || s.today.slice(0, 4);
  const report = coverageReport(year);
  const local = "Work in my local Spending Atlas folder and read CODEX_SETUP.md. Keep all raw records and backups in .finance-data. Ask only for masked account labels. Keep credentials, cookies, and bank logins out of chat.";
  const gaps = report.rows.filter(row => row.gaps.length).map(row => "- " +
    safeAccountLabel(row.label) + " · " +
    row.gaps.map(range => range.join(" through ")).join(", "));
  if (mode === "setup-customize") return local + "\n\nWalk me through one decision at a time. Help me set my home city, choose which ambiguous peer payments should get a dining default, tune merchant categories and shopping subcategories, review internal transfers, link refunds and reimbursements, and name trips. Ask what I want first. Use the existing dashboard controls, saved rules, and Ask Codex on category pages. For anything requiring a code change, explain the effect, preserve the original bank records, make a private SQLite backup first, and verify the totals after edits.";
  if (mode === "setup-retail") {
    const common = ` Help me find receipts for ${year}, using my signed-in browser or local exports with my permission. Pause for me to complete sign-in, security checks, or authorization myself. Store only the relevant receipts and match report locally. Match to existing posted purchases using date, currency, amount and account evidence. Leave ambiguous matches unresolved. Keep bank spending unchanged and verify that no receipt creates a new debit.`;
    const sources = {
      Amazon: `Use Amazon Your Orders and Your Payments → Transactions. Use my completed charges and the cards I selected in Setup to separate my purchases from other people’s orders. Use the bundled connector only if I choose to pair it. See START-HERE.md. My local dashboard is at ${location.origin}.`,
      Costco: "Use Costco Orders & Purchases for online orders and the In-Warehouse tab for warehouse receipts. Follow START-HERE.md and preview the receipt index before applying it.",
    };
    const source = Object.hasOwn(sources, retailer) ? sources[retailer] : `Help me identify the official order-history or receipt-export page for this optional retailer: ${JSON.stringify(retailer)}. Ask me to confirm the retailer and accounts before reading. Use the retailer’s normal browser or export flows. If Spending Atlas has no receipt importer for this store, keep a local reconciliation report with the matched ledger rows and flag any missing evidence.`;
    return local + "\n\n" + source + common;
  }
  const scope = "Audit " + year + " from " + report.start + " through " + report.end + ".";
  return local + "\n\n" + scope + " Enumerate all bank, credit card, and payment accounts with me. Use my own ChatGPT Finances connection when available, including posted inflows, outflows, and transfers. Fetch every page and handle pending separately. Follow the Finances import instructions in START-HERE.md. Use authorized bank statements for missing history. Ask me to sign in directly if needed or give me exact download dates. Reconcile overlapping rows one to one before importing and reuse stable account identities. Reserve verified coverage for periods with source evidence, including empty statements, and show gaps and unlisted accounts. Verify gross less applied credits equals net and preserve any manual edits." +
    (gaps.length ? "\n\nUnverified date ranges from my checklist:\n" + gaps.join("\n") : "");
}

function setupPage(key) {
  const steps = [["start", "Add data"], ["coverage", "Check coverage"], ["receipts", "Optional receipts"], ["personalize", "Make it yours"]];
  const active = steps.some(([id]) => id === key) ? key : "start";
  const step = steps.findIndex(([id]) => id === active);
  const setup = state.data.setup;
  const year = setupYear || state.year || setup.today.slice(0, 4);
  const report = coverageReport(year);
  const progress = `<nav class="setup-steps" aria-label="Setup steps">${steps.map(([id, label], i) =>
    `<a href="#setup/${id}"${i === step ? ' aria-current="step"' : ""}><span>${i + 1}</span>${label}</a>`).join("")}</nav>`;
  let body;
  if (active === "start") {
    body = panel("How would you like to add your transactions?", `<div class="setup-options">
      <article><h3>Use files from your bank</h3><p class="section-note">Sign in to your bank yourself and download a transactions CSV. The import runs on this computer, with a preview before anything is saved.</p>
        ${button("Import a bank CSV", "import", "", "primary")}
        <details class="bank-download-help"><summary>Where to find a bank export</summary>
          <ol><li>Open one checking, savings, or credit card account in your bank’s website.</li>
          <li>Open its activity or transactions page. Look for <strong>Download transactions</strong>, <strong>Download</strong>, or <strong>Export</strong>.</li>
          <li>Choose a date range, select CSV, and include posted purchases, credits, and payments. Start with a recent month and repeat for each account.</li></ol>
          <ul><li><strong>Citi:</strong> In the card’s Transactions section, look for the download icon next to the date filter.</li>
          <li><strong>Bank of America:</strong> From the account’s Activity tab, use Download transactions.</li>
          <li><strong>Capital One:</strong> Open the account and use Download Transactions near its activity.</li></ul>
          <p class="section-note">Save PDF statements as evidence for the coverage check. Use a transaction CSV for the import.</p>
          <a class="text-button" href="/download/bank-csv-example">Download a CSV example</a></details></article>
      <article><h3>Use ChatGPT Finances</h3><p class="section-note">Bring in activity from banks already connected to your own ChatGPT account.</p>
        ${button("Get the Codex import prompt", "setup-prompt", "setup-bank", "primary")}${button("Import prepared snapshot", "setup-finances")}</article></div>
        ${state.data.accounts.length ? '<p><a class="btn" href="#overview">Open spending overview</a></p>' : ""}`,
      state.data.accounts.length ? `${state.data.accounts.length} imported accounts are available.` : "Choose either option. You can combine sources for separate accounts or uncovered dates.");
  } else if (active === "coverage") {
    const rows = report.rows.map(row => {
      const pending = currentAccountMap.has(row.id) ? "" :
        button("Link imported account", "setup-claim", row.id, "small") + button("Remove from checklist", "setup-remove-expected", row.id, "small");
      return `<article class="coverage-account"><div><h3>${esc(row.label)}</h3>
        <p class="section-note">${row.first ? "Stored records " + labelDate(row.first) + " to " + labelDate(row.last) : "No imported records"}</p></div>
        <strong class="${row.gaps.length ? "muted" : "positive"}">${row.gaps.length ? "Needs verification" : "Date range verified"}</strong>
        ${row.gaps.length ? `<p class="section-note">Unverified ${row.gaps.map(([a, b]) => labelDate(a) + " to " + labelDate(b)).join(" · ")}</p>` : ""}
        ${row.windows.length ? `<details><summary>Verified periods</summary><ul>${row.windows.map(w => `<li>${labelDate(w.start)} to ${labelDate(w.end)} ${button("Remove", "setup-remove-coverage", JSON.stringify(w), "small")}</li>`).join("")}</ul></details>` : ""}
        <div class="inline">${button("Add verified period", "setup-window", row.id, "small")}${pending}</div></article>`;
    }).join("");
    const title = report.complete ? "Coverage verified" : "Coverage needs review";
    body = panel(title, `<div class="setup-coverage-tools"><label>Audit year <input id="setup-year" type="number" min="1900" max="${setup.today.slice(0, 4)}" value="${year}"></label>
        ${button("Add an account to check", "setup-expect", "", "small")}<a class="btn small" href="#setup/start">Get another bank CSV</a>${button("Optional Codex coverage help", "setup-prompt", "setup-bank", "small")}</div>
      <label class="check"><input id="setup-inventory" type="checkbox"${report.confirmed ? " checked" : ""}> This checklist includes every account I used in ${year}</label>
      ${rows || empty("Add your bank accounts, cards, and payment apps to check whether you have the whole year.")}`,
      `Auditing ${labelDate(report.start)} to ${labelDate(report.end)}. Use statement or provider date ranges as evidence. First and last transaction dates alone can miss gaps.`);
  } else if (active === "receipts") {
    const cards = setup.amazon ? `<div class="coverage-account"><h3>Cards used for Amazon</h3>
      <p class="section-note">Select the specific cards you paid with so purchases from a shared account can be matched to you.</p>
      ${setup.amazon_cards.map(row => `<p>${esc(currentAccountMap.get(row.account)?.label)} · ••${esc(row.last_four)}
      ${button("Remove card", "setup-remove-card", row.account, "small")}</p>`).join("")}
      ${button("Add a card for Amazon", "setup-card", "", "small")}</div>` : "";
    const prompt = retailer => JSON.stringify({mode:"setup-retail", year, retailer});
    const retailerLink = (url, label) => `<a class="btn small" href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    const suggested = suggestedRetailers(year).map(({name,count,amount}) => `<div class="receipt-suggestion">
      <div><strong>${esc(name)}</strong><small>${count} purchases · ${fmt(amount)} gross</small></div>
      ${button("Ask Codex", "setup-prompt", prompt(name), "small")}</div>`).join("");
    body = panel("Add receipts if you want them", `<div class="setup-options">
      <article><h3>Amazon</h3><p class="section-note">Sign in on Amazon. Select the cards you used to match orders from a shared account.</p>
        <label class="check"><input type="checkbox" data-setup-preference="amazon"${setup.amazon ? " checked" : ""}> Add Amazon receipts</label>
        ${setup.amazon ? `<div class="inline">${retailerLink("https://www.amazon.com/your-orders/orders", "Open Your Orders")}
        ${retailerLink("https://www.amazon.com/cpe/yourpayments/transactions", "Open Payments")}
        ${button("Get Amazon Codex prompt", "setup-prompt", prompt("Amazon"), "primary small")}</div>${cards}` : ""}</article>
      <article><h3>Costco</h3><p class="section-note">Sign in on Costco, then open Orders &amp; Returns. For warehouse receipts, use In-Warehouse.</p>
        <label class="check"><input type="checkbox" data-setup-preference="costco"${setup.costco ? " checked" : ""}> Add Costco receipts</label>
        ${setup.costco ? `<div class="inline">${retailerLink("https://www.costco.com/", "Open Costco")}
        ${retailerLink("https://customerservice.costco.com/app/answers/detail/a_id/10306", "Receipt help")}
        ${button("Get Costco Codex prompt", "setup-prompt", prompt("Costco"), "primary small")}</div>` : ""}</article></div>
      <div class="receipt-suggestions"><h3>Another retailer</h3><p class="section-note">${suggested ? `Would you like receipts from these repeat merchants in your ${year} shopping or grocery spending?` : "You can ask Codex to help with another store."}</p>
      ${suggested}${button("Choose another retailer", "setup-other-retailer", String(year), "small")}</div>`,
      "Sign in directly on the retailer’s website. Then copy the prompt into Codex. You can skip receipts and continue with bank data.");
  } else {
    body = panel("Choose how your dashboard works", `<div class="setup-options"><article><h3>Local preferences</h3>
      <p class="section-note">Set your home city for trips, specify your own transfer names, and decide how ambiguous peer payments are handled.</p>
      ${button("Edit preferences", "setup-preferences")}</article><article><h3>Customize with Codex</h3>
      <p class="section-note">Get a guided conversation for categories, refunds, trips, and how you want to review spending.</p>
      ${button("Get the Codex customization prompt", "setup-prompt", "setup-customize")}</article></div>`,
      "You can return to Setup any time.");
  }
  const previous = step ? `<a class="btn" href="#setup/${steps[step - 1][0]}">Back</a>` : '<a class="text-button" href="#overview">Open dashboard</a>';
  const next = step < steps.length - 1 ? `<a class="btn primary" href="#setup/${steps[step + 1][0]}">Continue to ${steps[step + 1][1].toLowerCase()}</a>` :
    button("Finish and open overview", "setup-finish", "", "primary");
  return heading("Set up Spending Atlas", "Add your transactions and check what’s missing. Everything is saved as you go.", "", "YOUR PRIVATE DASHBOARD") +
    `<div class="setup-flow">${progress}${body}
    ${active === "personalize" && !report.complete ? `<p class="section-note">Coverage still needs review. You can finish setup now and <a class="text-button" href="#setup/coverage/${year}">check the missing dates</a> later.</p>` : ""}
    <div class="setup-footer">${previous}${next}</div></div>`;
}

function render() {
  if (!state.data) return;
  let [page, key, auditYear] = route();
  if (page === "setup" && key === "coverage" && /^\d{4}$/.test(auditYear || "") && auditYear >= "1900" && auditYear <= state.data.setup.today.slice(0, 4)) setupYear = auditYear;
  if (!Object.hasOwn(names, page)) page = "overview";
  document.querySelectorAll("#site-nav [data-page]").forEach(link => {
    if (link.dataset.page === page) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  $("#breadcrumb").textContent = names[page];
  $("#filters").hidden = page === "data" || page === "setup";
  const count = reviewCategories().length + reviewTrips().length;
  $("#review-count").textContent = count;
  $("#review-count").hidden = !count;
  const validMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(key || "");
  $("#year").parentElement.hidden = page === "months" && !validMonth;
  if (page === "months" && validMonth && [...$("#year").options].some(item => item.value === key.slice(0, 4))) {
    state.year = key.slice(0, 4);
    $("#year").value = state.year;
  }
  document.title = `${names[page]} · Spending Atlas`;
  const views = {overview, transactions: () => transactionsPage(key), months: () => validMonth ? monthDetail(key) : monthList(),
    categories: () => categoriesPage(key), merchants: () => merchantsPage(key), trips: () => tripsPage(key), reimbursements: () => reimbursementsPage(key), review: () => reviewPage(key), data: dataPage, setup: () => setupPage(key)};
  currentCategoryContext = null;
  main.innerHTML = views[page]();
  main.setAttribute("aria-busy", "false");
}

function openDialog(title, body, onSave, label = "Save changes") {
  modal.innerHTML = `<form><div class="dialog-heading"><h2 id="dialog-title">${esc(title)}</h2>
    <button type="button" class="icon-button" data-dialog-close aria-label="Close dialog">${icon("close")}</button></div>${body}
    <div class="dialog-error" role="alert" hidden></div><div class="actions"><button class="btn" type="button" data-cancel>Cancel</button>
    <button class="btn primary" type="submit">${esc(label)}</button></div></form>`;
  const form = $("form", modal);
  $("[data-cancel]", modal).onclick = () => modal.close();
  $("[data-dialog-close]", modal).onclick = () => modal.close();
  form.onsubmit = async event => {
    event.preventDefault();
    const submit = $('[type="submit"]', form);
    const error = $(".dialog-error", form);
    submit.disabled = true;
    error.hidden = true;
    try {
      if (await onSave(new FormData(form)) !== false) modal.close();
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
    } finally {
      submit.disabled = false;
    }
  };
  modal.showModal();
}

const searchDialog = $("#search-dialog");
const searchInput = $("#global-query");
const searchResults = $("#global-results");
const searchResult = (title, detail, target, key) => `<a class="search-result" href="${esc(target)}">
  <span class="entity-icon">${icon(key)}</span><span><strong>${esc(title)}</strong>${detail ? `<small>${esc(detail)}</small>` : ""}</span></a>`;
function updateSearch() {
  const query = searchInput.value.trim().toLowerCase();
  const pages = Object.entries(names).filter(([key, label]) => !query || label.toLowerCase().includes(query)).slice(0, query ? 4 : 6)
    .map(([key, label]) => searchResult(label, "", "#" + key, key));
  const groups = query ? Object.entries(state.data.categories).filter(([, label]) => label.toLowerCase().includes(query)).slice(0, 4)
    .map(([key, label]) => searchResult(label, "Category", "#categories/" + encodeURIComponent(key), "categories")) : [];
  const trips = query ? state.data.trips.filter(t => ["automatic", "confirmed"].includes(t.status) && (t.name + " " + t.destination).toLowerCase().includes(query))
    .slice(0, 4).map(t => searchResult(t.name, "Trip · " + tripDates(t), "#trips/" + t.id, "trips")) : [];
  const matching = query ? state.data.transactions.filter(row =>
    [merchant(row), row.assigned_merchant, row.description, row.date, currentAccountMap.get(row.account)?.label, fmt(Math.abs(row.amount), row.currency)]
      .some(item => item?.toLowerCase().includes(query))) : [];
  const merchantHits = new Map();
  for (const row of matching) {
    const key = merchantKey(row);
    if (row.date.startsWith(state.year) && row.currency === state.currency && key.includes(query) && !merchantHits.has(key) && hasMerchantHistory(row)) merchantHits.set(key, row);
    if (merchantHits.size >= 3) break;
  }
  const merchants = [...merchantHits].map(([key, row]) => searchResult(merchantLabel(key, row), "Merchant", merchantHref(key), "merchants"));
  const transactions = matching.slice(0, 8).map(row => {
    const detail = `${labelDate(row.date)} · ${fmt(Math.abs(row.amount), row.currency)}`;
    if (row.kind === "credit") return searchResult(merchant(row), detail, "#reimbursements/" + encodeURIComponent(row.id), "reimbursements");
    return `<button class="search-result" type="button" data-result-id="${esc(row.id)}"><span class="entity-icon">${icon("receipt")}</span>
      <span><strong>${esc(merchant(row))}</strong><small>${esc(detail)}</small></span></button>`;
  });
  const receiptMatches = query ? (state.data.costco_receipts || []).filter(r =>
    `costco receipt ${r.date} ${labelDate(r.date)} ${fmt(r.amount, "USD")}`.toLowerCase().includes(query)).slice(0, 8) : [];
  const receipts = receiptMatches.map(r => `<button class="search-result" type="button" data-receipt-id="${esc(r.id)}">
    <span class="entity-icon">${icon("receipt")}</span><span><strong>Costco receipt · ${labelDate(r.date)}</strong>
    <small>${fmt(r.amount, "USD")} · ${receiptStatus(r)}</small></span></button>`);
  const sections = [["Pages", pages], ["Categories", groups], ["Trips", trips], ["Merchants", merchants], ["Receipts", receipts], ["Transactions", transactions]];
  searchResults.innerHTML = sections.filter(([, entries]) => entries.length).map(([name, entries]) =>
    `<section><h3>${name}</h3>${entries.join("")}</section>`).join("") || empty("No results. Try a merchant, date or amount.");
}
function openSearch() {
  if (!state.data || modal.open || searchDialog.open) return;
  searchInput.value = "";
  updateSearch();
  searchDialog.showModal();
  searchInput.focus();
}

function categoryOptions(amount, selected) {
  const allowed = amount < 0 ? ["credits", "income", ...state.data.transfer_categories] :
    Object.keys(state.data.categories).filter(key => !["income", "credits"].includes(key));
  return allowed.map(key => `<option value="${esc(key)}" ${key === selected ? "selected" : ""}>${esc(category(key))}</option>`).join("");
}

function tripOptions(selected, excluded = null) {
  return state.data.trips.filter(t => ["automatic", "confirmed"].includes(t.status) && t.id !== excluded).map(t =>
    `<option value="${t.id}" ${t.id === selected ? "selected" : ""}>${esc(t.name)}${t.start ? " · " + labelDate(t.start) : ""}</option>`).join("");
}

async function save(path, data, message) {
  const result = await request(path, data);
  state.selected.clear();
  await refresh();
  toast(typeof message === "function" ? message(result) : message);
}

function merchantField(row) {
  const options = new Map();
  for (const entry of state.data.transactions) {
    if (!hasMerchantHistory(entry)) continue;
    const key = merchantKey(entry);
    if (key && (entry.assigned_merchant || !options.has(key))) options.set(key, merchantLabel(key, entry));
  }
  const choices = [...options.values()].sort((a, b) => a.localeCompare(b))
    .map(label => `<option value="${esc(label)}"></option>`).join("");
  return `<label>Merchant<input name="assigned_merchant" maxlength="150" list="merchant-options" value="${esc(row?.assigned_merchant)}"
    placeholder="${row ? esc(merchant(row)) : "Choose or type a merchant"}" autocomplete="off"></label>
    <datalist id="merchant-options">${choices}</datalist>
    <p class="section-note">Use the same merchant name to group transactions in Merchant history. Clear the field to use the original merchant.</p>`;
}

function merchantAssignmentDialog(ids, row) {
  openDialog("Assign merchant", `<div class="fields">${merchantField(row)}</div>`, async form => {
    const assigned_merchant = form.get("assigned_merchant").trim() || null;
    await save("/api/edit", {ids, assigned_merchant}, "Merchant assignment saved.");
  });
}

function transactionDialog(row) {
  if (!row) return;
  const tripAssignment = row.amount > 0 ? `<label>Trip<select name="trip"><option value="">No trip</option>${tripOptions(row.trip)}</select></label>` : "";
  const credited = row.kind === "purchase" && row.offset > 0;
  const amount = credited ? net(row) : Math.abs(row.amount);
  const amountLabel = credited ? "Net cost" : row.amount < 0 ? "Received" : "Original amount";
  const reason = row.reason.startsWith("The source categorized this purchase as ") ? "" : row.reason;
  const cards = (row.applied_credits || []).map(link => {
    const credit = currentRowMap.get(link.credit);
    if (!credit) return "";
    return `<a class="reimbursement-card" href="#reimbursements/${encodeURIComponent(credit.id)}">
      <span><strong>${esc(merchant(credit))}</strong><small>${labelDate(credit.date)} · ${esc(currentAccountMap.get(credit.account)?.label || "")}</small></span>
      <span class="reimbursement-card-amount"><strong class="numeric">${fmt(link.amount, credit.currency)}</strong><span aria-hidden="true">›</span></span></a>`;
  }).join("");
  const order = row.amazon_order;
  const amazon = row.amazon_items?.length ? `<section class="order-details"><h3>Amazon order details</h3>
    ${order?.match_basis === "date_amount" ? '<p class="section-note">Likely match based on the order amount and date. Card details were unavailable.</p>' : ""}
    ${order?.match_basis === "card_fuzzy" ? '<p class="section-note">Matched to the same card and a nearby payment with a small amount difference.</p>' : ""}
    ${order?.date ? `<p class="section-note">Ordered ${labelDate(order.date)} · Order total ${fmt(order.total, order.currency || row.currency)}</p>` : ""}
    ${order?.last_four ? `<p class="section-note">${fmt(order.payment_amount, row.currency)} paid on card ending ${esc(order.last_four)}${order.payment_date ? " · " + labelDate(order.payment_date) : ""}</p>` : ""}
    ${order?.reference ? `<p class="section-note">Order ${esc(order.reference)}</p>` : ""}
    <ul>${row.amazon_items.map(item => `<li>${esc(item)}</li>`).join("")}</ul></section>` :
    row.kind === "purchase" && merchantKey(row) === "amazon" ? '<p class="section-note">No verified Amazon order is linked to this charge.</p>' : "";
  openDialog(merchant(row), `<p class="section-note">${labelDate(row.date)} · ${esc(currentAccountMap.get(row.account)?.label || "")}</p>
    ${row.posted_date ? `<p class="section-note">Bank posting date ${labelDate(row.posted_date)}</p>` : ""}
    ${row.posted_merchant && row.posted_merchant !== row.description ? `<p class="section-note">Posted as ${esc(row.posted_merchant)}</p>` : ""}
    <div class="transaction-total"><small class="muted">${amountLabel}</small><strong class="numeric">${fmt(amount, row.currency)}</strong>
    ${credited ? `<small class="muted">Original charge ${fmt(row.amount, row.currency)} · refunds/reimbursements ${fmt(row.offset, row.currency)}</small>` : ""}</div>
    ${row.description && row.description !== merchant(row) ? `<p class="section-note">${esc(row.description)}</p>` : ""}
    ${reason ? `<p class="section-note">${esc(reason)}</p>` : ""}
    <p class="section-note"><a class="text-button" href="${esc(merchantHref(merchantKey(row)))}">${row.assigned_merchant ? `View ${esc(row.assigned_merchant)} history` : "View merchant history"}</a>
    ${(state.data.costco_receipts || []).filter(receipt => receipt.transaction_id === row.id).map(receipt =>
      ` · <button type="button" class="text-button" data-dialog-receipt="${esc(receipt.id)}">Open Costco receipt</button>`).join("")}</p>
    ${amazon}
    ${row.city ? `<p class="section-note">Merchant location: ${esc([row.city, row.region, row.country].filter(Boolean).join(", "))}</p>` : ""}
    ${cards ? `<section class="transaction-reimbursements"><h3>Reimbursements &amp; refunds</h3>${cards}</section>` : ""}
    <div class="fields">${merchantField(row)}<label>Display name<input name="display_name" maxlength="150" value="${row.posted_merchant ? esc(row.merchant) : ""}" placeholder="${esc(row.posted_merchant || merchant(row))}"></label>
    <label>Reporting date<input type="date" name="reporting_date" value="${row.posted_date ? esc(row.date) : ""}"></label>
    <label>Category<select name="category">${categoryOptions(row.amount, row.category)}</select></label>
    ${row.amount > 0 ? `<div data-shopping-field hidden><label>Shopping subcategory<select name="shopping_subcategory">
      ${Object.entries(state.data.shopping_subcategories).map(([key, name]) => `<option value="${key}"${key === (row.shopping_subcategory || "general") ? " selected" : ""}>${esc(name)}</option>`).join("")}
    </select></label>${row.shopping_subcategory_reason ? `<p class="section-note">${esc(row.shopping_subcategory_reason)}</p>` : ""}</div>` : ""}
    ${row.amount > 0 ? '<label class="check"><input name="remember" type="checkbox"> Use this category for future purchases from this merchant</label>' : ""}${tripAssignment}</div>`,
  async form => {
    const next = {ids: [row.id]};
    const proposedCategory = form.get("category");
    const proposedSubcategory = form.get("shopping_subcategory");
    const proposedTrip = form.get("trip") ? Number(form.get("trip")) : null;
    const assignedMerchant = form.get("assigned_merchant").trim() || null;
    if (assignedMerchant !== (row.assigned_merchant || null)) next.assigned_merchant = assignedMerchant;
    const displayName = form.get("display_name").trim() || null;
    const reportingDate = form.get("reporting_date") || null;
    if (displayName !== (row.posted_merchant ? row.merchant : null)) next.display_name = displayName;
    if (reportingDate !== (row.posted_date ? row.date : null)) next.reporting_date = reportingDate;
    if (proposedCategory !== row.category || (row.review && !("assigned_merchant" in next)) || form.has("remember")) {
      next.category = proposedCategory;
      next.remember = form.has("remember");
    }
    if (row.amount > 0 && proposedTrip !== row.trip) next.trip = proposedTrip;
    if (proposedSubcategory && proposedSubcategory !== row.shopping_subcategory) next.shopping_subcategory = proposedSubcategory;
    if (Object.keys(next).length > 1) await save("/api/edit", next, "Transaction updated.");
  });
  modal.querySelectorAll("[data-dialog-receipt]").forEach(control => {
    control.onclick = () => openCostcoReceipt(control.dataset.dialogReceipt, row);
  });
  const shoppingField = $("[data-shopping-field]", modal);
  if (shoppingField) {
    const categoryInput = $('[name="category"]', modal);
    const subcategoryInput = $("select", shoppingField);
    const showShopping = () => {
      const enabled = ["shopping", "health_wellness"].includes(categoryInput.value);
      if (enabled && !row.shopping_subcategory) {
        subcategoryInput.value = categoryInput.value === "health_wellness" ? "health_wellness" : "general";
      }
      shoppingField.hidden = !enabled;
      subcategoryInput.disabled = !enabled;
    };
    categoryInput.addEventListener("change", showShopping);
    showShopping();
  }
}

async function openCostcoReceipt(id, returnTo) {
  const receipt = state.data.costco_receipts.find(item => item.id === id);
  if (!receipt) return;
  modal.innerHTML = `<div class="dialog-heading"><h2 id="dialog-title">Costco receipt</h2>
    <button type="button" class="icon-button" data-dialog-close aria-label="Close receipt">${icon("close")}</button></div>
    <p class="section-note">${labelDate(receipt.date)} · ${fmt(receipt.amount, "USD")} · ${receiptStatus(receipt)}</p>
    <pre class="receipt-text" aria-live="polite">Loading receipt…</pre>
    <div class="actions"><button type="button" class="btn" data-receipt-done>${returnTo ? "Back to transaction" : "Close receipt"}</button></div>`;
  const done = () => {
    modal.close();
    if (returnTo) transactionDialog(returnTo);
  };
  $("[data-dialog-close]", modal).onclick = done;
  $("[data-receipt-done]", modal).onclick = done;
  if (!modal.open) modal.showModal();
  const body = $(".receipt-text", modal);
  try {
    const response = await fetch(receiptHref(receipt));
    if (!response.ok) throw Error("Receipt unavailable");
    body.textContent = await response.text();
  } catch {
    body.textContent = "Could not open this saved receipt.";
  }
}

function creditAssignmentDialog(row) {
  if (!row) return;
  const selected = row.assignment?.treatment === "apply" ? row.assignment.category :
    creditStatus(row)[1] === "excluded" ? "exclude" : "unassigned";
  const nonExpenses = ["income", "credits", ...state.data.transfer_categories, ...state.data.unverified_categories];
  const options = Object.entries(state.data.categories).filter(([key]) => !nonExpenses.includes(key))
    .map(([key, label]) => `<option value="${esc(key)}" ${key === selected ? "selected" : ""}>${esc(label)}</option>`).join("");
  const transferOptions = state.data.transfer_categories.map(key => `<option value="${esc(key)}">${esc(category(key))}</option>`).join("");
  const note = row.links.length ? "Changing the category replaces the current purchase links with a category credit dated when this receipt posted." :
    "The credit will reduce spending in the selected category on the date received.";
  openDialog("Reassign reimbursement", `<p class="section-note">${esc(merchant(row))} · ${fmt(-row.amount, row.currency)}</p>
    <div class="fields"><label>Category or treatment<select name="category">
    <option value="unassigned" ${selected === "unassigned" ? "selected" : ""}>Unassigned</option>
    <option value="exclude" ${selected === "exclude" ? "selected" : ""}>Exclude from spending</option>${transferOptions}${options}</select></label>
    <p class="section-note">${esc(note)}</p></div>`,
    async form => save("/api/credit", {credit: row.id, action: "assign", category: form.get("category")}, "Reimbursement assignment saved."));
}

function allocationDialog(credit, selected) {
  if (!credit) return;
  const purchases = state.data.transactions.filter(row => row.kind === "purchase" && row.currency === credit.currency && (row.amount > row.offset || row.id === selected));
  const header = `<p class="section-note">${esc(merchant(credit))} · ${fmt(credit.remaining + credit.direct_offset, credit.currency)} available to link</p>`;
  openDialog("Allocate credit", header + `<div class="fields">
    <label>Search purchases<input name="find" type="search" placeholder="Merchant or date"></label>
    <label>Purchase<select name="purchase" required size="5"></select></label>
    <label>Amount to apply<input name="amount" type="number" min="0.01" step="0.01" required></label>
    <p class="section-note">Linking a purchase replaces any category-only assignment. You can apply the rest to another purchase.</p></div>`,
  async form => save("/api/credit", {credit: credit.id, purchase: form.get("purchase"), amount: form.get("amount")}, "Credit allocation saved."), "Confirm allocation");
  const select = $('[name="purchase"]', modal);
  const amount = $('[name="amount"]', modal);
  const search = $('[name="find"]', modal);
  const fillAmount = () => {
    const row = currentRowMap.get(select.value);
    if (!row) {
      amount.value = "";
      return;
    }
    const old = credit.links.find(link => link.purchase === row.id)?.amount || 0;
    amount.max = (Math.min(credit.remaining + credit.direct_offset + old, row.amount - row.offset + old) / 100).toFixed(2);
    amount.value = old ? (old / 100).toFixed(2) : amount.max;
  };
  const fill = current => {
    const needle = search.value.trim().toLowerCase();
    const found = purchases.filter(row => `${merchant(row)} ${row.description} ${row.date}`.toLowerCase().includes(needle));
    if (current && !found.slice(0, 150).some(row => row.id === current)) {
      const selectedRow = purchases.find(row => row.id === current);
      if (selectedRow) found.unshift(selectedRow);
    }
    select.innerHTML = found.slice(0, 150).map(row => `<option value="${esc(row.id)}" ${row.id === current ? "selected" : ""}>${esc(merchant(row))} · ${labelDate(row.date)} · ${fmt(row.amount, row.currency)}</option>`).join("");
    if (!current) select.selectedIndex = -1;
    fillAmount();
  };
  fill(selected);
  select.onchange = fillAmount;
  search.oninput = () => fill();
}

function tripDialog(trip, split) {
  const suggested = trip?.status === "suggested";
  openDialog(split ? "Split into a new trip" : suggested ? "Review trip suggestion" : trip ? "Edit trip" : "Create trip",
    (trip?.booking ? '<p class="section-note">Give this booking a trip name to move it to the trip timeline.</p>' :
      trip?.reason ? `<p class="section-note">${esc(trip.reason)}</p>` : "") +
    (trip ? '<p class="section-note">Changing the dates updates the trip’s purchases and totals. The app adds matches for the destination and removes purchases outside the new dates.</p>' : "") +
    `<div class="fields"><label>Name<input name="name" required maxlength="100" value="${esc(trip?.name)}"></label>
    <label>Destination<input name="destination" maxlength="150" value="${esc(trip?.destination)}"></label>
    <div class="two"><label>Start<input name="start" type="date" value="${esc(trip?.start)}"></label>
    <label>End<input name="end" type="date" value="${esc(trip?.end)}"></label></div></div>`,
    async form => save("/api/trip", {id: trip?.id, ...split, ...Object.fromEntries(form)}, ({reconciliation}) => {
      if (reconciliation) return `Trip recalculated. ${reconciliation.added} added, ${reconciliation.removed} removed.`;
      return suggested || (trip?.booking && form.get("name").trim() !== trip.name) ? "Trip confirmed." : "Trip saved.";
    }),
    suggested ? "Confirm trip" : "Save trip");
}

function addToTrip(id) {
  openDialog("Add purchases to trip", '<div class="fields"><label>Search purchases<input type="search" name="search" placeholder="Merchant, date or category"></label><label>Purchases<select name="purchases" required multiple size="8"></select></label><p class="section-note">On desktop, hold Command or Ctrl to select several purchases.</p></div>',
    async form => save("/api/edit", {ids: form.getAll("purchases"), trip: id}, "Trip purchases updated."), "Add purchases");
  const search = $('[name="search"]', modal);
  const select = $('[name="purchases"]', modal);
  const fill = () => {
    const needle = search.value.trim().toLowerCase();
    const rows = state.data.transactions.filter(row => row.kind === "purchase" && row.trip !== id &&
      `${merchant(row)} ${row.date} ${category(row.category)}`.toLowerCase().includes(needle));
    select.innerHTML = rows.slice(0, 150).map(row => `<option value="${esc(row.id)}">${esc(merchant(row))} · ${labelDate(row.date)} · ${fmt(row.amount, row.currency)}</option>`).join("");
  };
  search.oninput = fill;
  fill();
}

function bankColumn(name, label, columns, suggestion, optional = false) {
  const blank = optional ? "None" : "Choose a column";
  return `<label>${label}<select name="column-${name}"><option value="">${blank}</option>
    ${columns.map((column, index) => `<option value="${index}"${index === suggestion ? " selected" : ""}>${esc(column || "Unnamed column")}</option>`).join("")}
  </select></label>`;
}

function bankPreview(plan) {
  const status = {new: "Will import", already_imported: "Already imported", review: "Held for review"};
  const totals = Object.entries(plan.totals).map(([currency, values]) =>
    `<li>${esc(currency)} · Outflows ${fmt(values.outflows, currency)} · Inflows ${fmt(values.inflows, currency)}</li>`).join("");
  const rows = plan.samples.map(row => `<tr><td>${labelDate(row.date)}</td><td>${esc(row.description)}</td>
    <td>${row.amount > 0 ? "Outflow" : "Inflow"} ${fmt(Math.abs(row.amount), row.currency)}</td><td>${status[row.status]}</td></tr>`).join("");
  return `<h3>Import preview</h3><p><strong>${esc(plan.account)}</strong> · ${labelDate(plan.first)} to ${labelDate(plan.last)}</p>
    <p>${plan.counts.new} new · ${plan.counts.already_imported} already imported · ${plan.counts.review} held for review</p>
    ${plan.pending || plan.zero ? `<p class="section-note">Skipped ${plan.pending} pending and ${plan.zero} zero-amount rows.</p>` : ""}
    ${totals ? `<ul aria-label="New transaction totals">${totals}</ul>` : ""}
    ${plan.counts.review ? '<p class="section-note">Held rows may overlap existing transactions or reuse an existing ID with different details. Compare them with the bank before adding them.</p>' : ""}
    <div class="table-wrap"><table><thead><tr><th>Date</th><th>Sample transaction</th><th>Amount</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="section-note">Check that purchases appear as outflows and refunds as inflows. Transaction dates help you find the records. Use your statement to verify complete coverage.</p>`;
}

function importDialog() {
  const existing = state.data.accounts.filter(account => account.id.startsWith("csv:"));
  let content, reviewed, selectedFile, revision = 0;
  openDialog("Import a bank CSV", `<p class="section-note">Choose a file with posted transactions from one account. You’ll map the columns and review a preview before saving.</p>
    <div class="fields"><label>Account<select name="saved-account"><option value="">Add an account</option>
      ${existing.map(account => `<option value="${esc(account.label)}">${esc(account.label)}</option>`).join("")}</select></label>
      <label id="bank-nickname">Account nickname<input name="account" maxlength="120" required placeholder="e.g. Everyday checking"></label>
      <label>Bank CSV file<input name="csv" type="file" accept=".csv,text/csv" required></label>
      <div id="bank-fields" class="fields"></div>
    </div><section id="bank-preview" aria-live="polite" tabindex="-1"></section>`, async form => {
    if (!content || !$('[name="amount-mode"]', modal)) throw Error("Choose a readable bank CSV before continuing.");
    const mapping = Object.fromEntries(Array.from(form).filter(([key, value]) => key.startsWith("column-") && value !== "")
      .map(([key, value]) => [key.slice(7), Number(value)]));
    const options = {content, account: form.get("saved-account") || form.get("account"),
      mode: form.get("amount-mode"), convention: form.get("convention"), currency: form.get("currency"), mapping};
    if (!reviewed) {
      const startedAt = revision;
      const plan = await request("/api/bank-import", {...options, action: "preview"});
      if (revision !== startedAt) return false;
      reviewed = plan;
      const preview = $("#bank-preview", modal);
      preview.innerHTML = bankPreview(plan);
      const submit = $('[type="submit"]', modal);
      submit.textContent = plan.counts.new ? `Import ${plan.counts.new} transactions` : "Done";
      preview.focus();
      return false;
    }
    if (!reviewed.counts.new) return;
    try {
      const result = await request("/api/bank-import", {...options, action: "commit", token: reviewed.token});
      await refresh();
      toast(`${result.added} added, ${result.already_imported} already imported, ${result.review} held for review.`);
    } catch (error) {
      resetPreview();
      throw error;
    }
  }, "Preview import");

  const form = $("form", modal);
  const submit = $('[type="submit"]', form);
  const fields = $("#bank-fields", form);
  function resetPreview() {
    revision++;
    reviewed = null;
    $("#bank-preview", form).replaceChildren();
    submit.textContent = "Preview import";
  }

  function syncFields() {
    const mode = $('[name="amount-mode"]', form)?.value;
    for (const region of form.querySelectorAll("[data-amount-mode]")) {
      const active = region.dataset.amountMode.split(" ").includes(mode);
      region.hidden = !active;
      region.querySelectorAll("select").forEach(select => { select.disabled = !active; });
    }
    const nickname = $("#bank-nickname", form);
    nickname.hidden = !!$('[name="saved-account"]', form).value;
    $("input", nickname).required = !nickname.hidden;
  }

  form.addEventListener("input", resetPreview);
  form.addEventListener("change", syncFields);
  $('[name="csv"]', form).onchange = async event => {
    const file = event.target.files[0];
    selectedFile = file;
    content = null;
    resetPreview();
    fields.replaceChildren();
    const error = $(".dialog-error", form);
    error.hidden = true;
    submit.disabled = true;
    try {
      if (!file?.size || file.size > 8_000_000) throw Error("Choose a CSV smaller than 8 MB.");
      const bytes = await file.arrayBuffer();
      let input;
      try { input = new TextDecoder("utf-8", {fatal: true}).decode(bytes); }
      catch { input = new TextDecoder("windows-1252").decode(bytes); }
      const {columns, mapping, mode} = await request("/api/bank-import", {action: "inspect", content: input});
      if (selectedFile !== file) return;
      content = input;
      const column = (key, title, optional = false) => bankColumn(key, title, columns, mapping[key], optional);
      fields.innerHTML = `${column("date", "Date column")}${column("description", "Merchant or description column")}
        <label>How the file lists amounts<select name="amount-mode">
          ${[["signed", "One signed amount column"], ["split", "Separate debit and credit columns"], ["typed", "Amount and transaction direction"]].map(([key, title]) =>
            `<option value="${key}"${mode === key ? " selected" : ""}>${title}</option>`).join("")}
        </select></label>
        <div class="fields" data-amount-mode="signed typed">${column("amount", "Amount column")}</div>
        <div class="fields" data-amount-mode="signed"><label>Sign of purchases and withdrawals<select name="convention">
          <option value="">Choose from your CSV</option><option value="debits_positive">Positive, e.g. 42.30</option>
          <option value="debits_negative">Negative, e.g. -42.30</option></select></label></div>
        <div class="fields" data-amount-mode="split">${column("debit", "Debit column")}${column("credit", "Credit column")}</div>
        <div class="fields" data-amount-mode="typed">${column("direction", "Direction or type column")}</div>
        <details><summary>Currency, transaction IDs, and status</summary><div class="fields">
          <label>Default currency<input name="currency" value="USD" maxlength="3" pattern="[A-Za-z]{3}" required></label>
          ${column("currency", "Currency column", true)}${column("reference", "Unique transaction ID column", true)}
          ${column("status", "Status column", true)}</div></details>`;
      syncFields();
    } catch (failure) {
      if (selectedFile !== file) return;
      error.textContent = failure.message;
      error.hidden = false;
    } finally {
      if (selectedFile === file) submit.disabled = false;
    }
  };
}

async function saveSetup(data) {
  await request("/api/setup", data);
  await refresh();
}

function showSetupPrompt(prompt) {
  openDialog("Continue in Codex", `<p class="section-note">Open this Spending Atlas folder in Codex. Paste the prompt below into a new chat.</p>
      <label>Codex prompt<textarea rows="10" readonly>${esc(prompt)}</textarea></label>`, async () => {
      try {
        await navigator.clipboard.writeText(prompt);
      } catch {
        $("textarea", modal).select();
        throw Error("Copy the selected text with your keyboard.");
      }
      toast("Prompt copied.");
    }, "Copy prompt");
}

function setupAction(action, value) {
  const setup = state.data.setup;
  const year = setupYear || state.year || setup.today.slice(0, 4);
  if (action === "setup-other-retailer") {
    openDialog("Pick a retailer", '<div class="fields"><label>Retailer name<input name="retailer" maxlength="80" required></label></div>', form => {
      const retailer = form.get("retailer").trim();
      if (!retailer) throw Error("Enter a retailer name.");
      modal.close();
      setTimeout(() => showSetupPrompt(setupPrompt("setup-retail", value, safeAccountLabel(retailer))), 0);
    }, "Get Codex prompt");
  } else if (action === "setup-prompt") {
    const {mode, year, retailer} = value.startsWith("{") ? JSON.parse(value) : {mode:value};
    showSetupPrompt(setupPrompt(mode, year, retailer));
  } else if (action === "setup-finances") {
    openDialog("Import a Finances snapshot", '<div class="fields"><label>Prepared JSON snapshot<input name="snapshot" type="file" accept=".json,application/json" required></label></div>',
      async form => {
        const file = form.get("snapshot");
        if (!file?.size || file.size > 8_000_000) throw Error("Choose a JSON snapshot smaller than 8 MB.");
        let batches;
        try { batches = JSON.parse(await file.text()); }
        catch { throw Error("Choose a valid Spending Atlas JSON snapshot."); }
        const result = await request("/api/import-finances", {batches});
        await refresh();
        toast(`${result.added} added, ${result.updated} updated, ${result.unchanged} unchanged.`);
      }, "Import snapshot");
  } else if (action === "setup-expect") {
    openDialog("Add an account to check", '<p class="section-note">Use a nickname or a bank name with the last four digits. Repeat this label on CSV imports for this account.</p><div class="fields"><label>Account label<input name="label" maxlength="120" required></label></div>',
      form => saveSetup({action: "expect", label: form.get("label")}), "Add account");
  } else if (action === "setup-window") {
    const scope = coverageReport(year);
    const account = scope.rows.find(row => row.id === value);
    const [start, end] = account.gaps[0] || [scope.start, scope.end];
    openDialog("Add a verified period", `<p class="section-note">${esc(account.label)}. Check the dates on your statement or verified source. If the account was closed or unopened for part of the year, document that period only when you have evidence of no activity.</p>
      <div class="fields"><label>From<input type="date" name="start" max="${setup.today}" value="${start}" required></label>
      <label>Through<input type="date" name="end" max="${setup.today}" value="${end}" required></label>
      <label class="check"><input type="checkbox" name="verified" required> I verified the full period, including any dates with no activity</label></div>`,
      form => saveSetup({action: "coverage", account: value, start: form.get("start"), end: form.get("end"), verified: form.has("verified")}), "Save period");
  } else if (action === "setup-remove-coverage") {
    return saveSetup({action: "remove_coverage", ...JSON.parse(value)});
  } else if (action === "setup-remove-expected") {
    openDialog("Remove account from checklist", "<p class=\"section-note\">This removes the checklist entry and its verified periods.</p>",
      () => saveSetup({action: "remove_expected", account: value}), "Remove account");
  } else if (action === "setup-claim" || action === "setup-card") {
    const options = state.data.accounts.map(a => `<option value="${esc(a.id)}">${esc(a.label)}</option>`).join("");
    const card = action === "setup-card";
    if (!options) throw Error("Import an account before using this option.");
    openDialog(card ? "Add a card used on Amazon" : "Link this checklist entry to an imported account",
      `<div class="fields"><label>Imported account<select name="account" required>${options}</select></label>
      ${card ? '<label>Last four digits<input name="last_four" pattern="[0-9]{4}" inputmode="numeric" maxlength="4" required></label>' : ""}</div>`,
      form => saveSetup(card ? {action: "amazon_card", account: form.get("account"), last_four: form.get("last_four")} :
        {action: "claim_expected", account: value, target: form.get("account")}));
  } else if (action === "setup-remove-card") {
    return saveSetup({action: "amazon_card", account: value, last_four: ""});
  } else if (action === "setup-preferences") {
    openDialog("Personalize your rules", `<div class="fields">
      <label>Home city for trip detection<input name="home" maxlength="120" value="${esc(state.data.home)}"></label>
      <label>Your name on transfers<input name="owner" maxlength="120" value="${esc(setup.owner)}"></label>
      <label>Other identifiers for your own transfers, separated by commas<input name="own_labels" maxlength="260" value="${esc(setup.own_labels)}"></label>
      <label class="check"><input name="peer_food" type="checkbox"${setup.peer_food ? " checked" : ""}> Default ambiguous small Venmo and Zelle payments to food</label></div>`,
      form => saveSetup({action: "preferences", home: form.get("home"), owner: form.get("owner"),
        own_labels: form.get("own_labels"), peer_food: form.has("peer_food")}));
  } else if (action === "setup-finish") {
    return saveSetup({action: "finish"}).then(() => {
      const years = [...new Set(state.data.transactions.map(row => row.date.slice(0, 4)))].sort();
      state.year = years.includes(year) ? year : (years.at(-1) || year);
      $("#year").value = state.year;
      location.hash = "overview";
    });
  }
}

main.addEventListener("change", async event => {
  const control = event.target;
  const pref = control.dataset.setupPreference;
  if (!pref && !["setup-year", "setup-inventory"].includes(control.id)) return;
  try {
    if (control.id === "setup-year") {
      if (!control.reportValidity()) return;
      setupYear = control.value;
      history.replaceState(null, "", "#setup/coverage/" + setupYear);
      render();
      $("#setup-year").focus();
    } else if (control.id === "setup-inventory") {
      await saveSetup({action: "inventory", year: setupYear || state.year || state.data.setup.today.slice(0, 4), complete: control.checked});
      $("#setup-inventory")?.focus();
    } else {
      await saveSetup({action: "preferences", [pref]: control.checked});
      $(`[data-setup-preference="${pref}"]`)?.focus();
    }
  } catch (error) {
    control.checked = !control.checked;
    toast(error.message);
  }
});

function amazonCaptureDialog() {
  openDialog("Import Amazon order snapshot", '<div class="fields"><label>Order snapshot JSON<textarea name="orders" rows="7" required spellcheck="false"></textarea></label></div>',
    async form => {
      let orders;
      try { orders = JSON.parse(form.get("orders")); }
      catch (_) { throw Error("Paste a valid JSON order snapshot."); }
      const result = await request("/api/amazon/capture", Array.isArray(orders) ? {orders} : orders);
      await refresh();
      toast(result.payments_seen === undefined ? result.received + " Amazon orders saved locally." :
        result.payments_verified + " completed card charges saved for matching.");
    }, "Save snapshot");
}

async function backup() {
  const response = await fetch("/api/backup", {method: "POST", headers: {"Content-Type": "application/json"}, body: "{}"});
  if (!response.ok) throw Error("Could not create a backup.");
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] || "spending-atlas.sqlite3";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("Backup ready to save.");
}

main.addEventListener("click", async event => {
  const control = event.target.closest("[data-action]");
  if (!control) return;
  const {action, value} = control.dataset;
  try {
    if (action === "month-report-settings") {
      monthReportOptions();
    } else if (action === "sort") {
      const [scope, key, direction] = JSON.parse(value);
      state.sorts.set(scope, [key, direction]);
      state.page = 1;
      render();
      [...main.querySelectorAll('[data-action="sort"]')].find(el => {
        const [nextScope, nextKey] = JSON.parse(el.dataset.value);
        return nextScope === scope && nextKey === key;
      })?.focus();
    } else if (action === "jump") {
      jumpTo(document.getElementById(value));
    } else if (action === "costco-receipt") {
      await openCostcoReceipt(value);
    } else if (action === "assign-credit") {
      creditAssignmentDialog(currentRowMap.get(value));
    } else if (action === "page") {
      state.page = Number(value);
      render();
    } else if (action === "transaction") {
      transactionDialog(currentRowMap.get(value));
    } else if (action === "trip-edit") {
      tripDialog(state.data.trips.find(t => String(t.id) === value));
    } else if (action === "trip-merge") {
      const id = Number(value);
      openDialog("Merge trips", `<div class="fields"><label>Move these purchases into<select name="target" required><option value="">Choose trip</option>${tripOptions(null, id)}</select></label></div>`,
        async form => {
          const target = Number(form.get("target"));
          await save("/api/trip", {action: "merge", id, target}, "Trips merged.");
          location.hash = `trips/${target}`;
        }, "Merge trips");
    } else if (action === "trip-add") {
      addToTrip(Number(value));
    } else if (action === "trip-split") {
      tripDialog(null, {action: "split", source: Number(value), ids: [...state.selected]});
    } else if (action === "trip-dismiss") {
      await save("/api/trip", {action: "dismiss", id: Number(value)}, "Trip suggestion dismissed.");
    } else if (action === "match" || action === "undo-match") {
      const [credit, purchase] = JSON.parse(value);
      if (action === "match") allocationDialog(currentRowMap.get(credit), purchase);
      else await save("/api/credit", {credit, purchase, action: "remove"}, "Allocation removed.");
    } else if (action === "dismiss-credit" || action === "restore-credit") {
      const next = action === "dismiss-credit" ? "dismiss" : "restore";
      await save("/api/credit", {credit: value, action: next}, next === "dismiss" ? "Credit dismissed." : "Credit returned to review.");
    } else if (action === "assign-merchant" || action === "bulk-merchant") {
      const row = action === "assign-merchant" ? currentRowMap.get(value) : null;
      merchantAssignmentDialog(row ? [row.id] : [...state.selected], row);
    } else if (action === "bulk" || action === "bulk-trip") {
      const selected = [...state.selected];
      if (action === "bulk" && new Set(selected.map(id => currentRowMap.get(id).amount < 0)).size > 1) {
        throw Error("Select purchases or incoming credits separately.");
      }
      if (action === "bulk") {
        const first = currentRowMap.get(selected[0]);
        openDialog("Change category", `<div class="fields"><label>Category<select name="category">${categoryOptions(first.amount, first.category)}</select></label></div>`,
          async form => save("/api/edit", {ids: selected, category: form.get("category")}, "Categories updated."));
      } else {
        openDialog("Assign trip", `<div class="fields"><label>Trip<select name="trip"><option value="">No trip</option>${tripOptions(null)}</select></label></div>`,
          async form => save("/api/edit", {ids: selected, trip: form.get("trip") ? Number(form.get("trip")) : null}, "Trip assignments updated."));
      }
    } else if (action === "import") {
      importDialog();
    } else if (action.startsWith("setup-")) {
      await setupAction(action, value);
    } else if (action === "amazon-capture") {
      amazonCaptureDialog();
    } else if (action === "backup") {
      await backup();
    } else if (action === "home") {
      openDialog("Set home city", `<p class="section-note">Local purchases are excluded from trip detection. Leave blank to infer home from recurring visits.</p><div class="fields"><label>City<input name="home" value="${esc(state.data.home)}" maxlength="120" placeholder="e.g. San Francisco"></label></div>`,
        async form => save("/api/settings", {home: form.get("home")}, "Trip detection updated."));
    }
  } catch (error) {
    toast(error.message);
  }
});

main.addEventListener("change", event => {
  const {id: controlId, value, checked} = event.target;
  if (["month-report-range", "month-report-current", "month-report-scenario"].includes(controlId)) {
    if (controlId === "month-report-range") saveMonthReport({range: Number(value)});
    if (controlId === "month-report-current") saveMonthReport({includeCurrent: checked});
    if (controlId === "month-report-scenario") saveMonthReport({scenario: value});
    render();
    document.getElementById(controlId)?.focus({preventScroll: true});
    return;
  }
  const filterKey = {"credit-filter": "creditFilter", "transaction-account": "account", "chart-mode": "chartMode", "trip-order": "tripOrder"}[event.target.id];
  if (filterKey) {
    state[filterKey] = event.target.value;
    state.page = 1;
    render();
    document.getElementById(event.target.id)?.focus();
    return;
  }
  const id = event.target.dataset.select;
  if (!id) return;
  if (event.target.checked) state.selected.add(id);
  else state.selected.delete(id);
  render();
  [...main.querySelectorAll("[data-select]")].find(item => item.dataset.select === id)?.focus();
});

main.addEventListener("input", event => {
  if (event.target.id !== "tx-search") return;
  state.search = event.target.value;
  state.page = 1;
  const cursor = event.target.selectionStart;
  render();
  const search = $("#tx-search");
  if (search) {
    search.focus();
    if (cursor !== null) search.setSelectionRange(cursor, cursor);
  }
});

document.addEventListener("input", event => {
  if (!event.target.matches("[data-chat-input]")) return;
  const root = event.target.closest("[data-codex-chat]");
  const {chat} = chatFor(root);
  chat.draft = event.target.value;
  $("[data-chat-send]", root).disabled = !chat.draft.trim();
});

document.addEventListener("click", event => {
  const root = event.target.closest("[data-codex-chat]");
  if (!root) return;
  const context = chatFor(root);
  const {chat} = context;
  if (event.target.closest("[data-chat-close]")) {
    dashboardAssistant.close();
  } else if (event.target.closest("[data-chat-toggle]")) {
    chat.collapsed = !chat.collapsed;
    renderChat(root, context, "[data-chat-toggle]");
  } else if (event.target.closest("[data-chat-clear]") && !chat.pending) {
    chat.messages = [];
    chat.error = "";
    chat.draft = "";
    renderChat(root, context, "[data-chat-input]");
  }
});

document.addEventListener("keydown", event => {
  if (event.target.matches?.("[data-chat-input]") && event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    event.target.form.requestSubmit();
  }
});

document.addEventListener("submit", async event => {
  if (!event.target.matches("[data-chat-form]")) return;
  const root = event.target.closest("[data-codex-chat]");
  event.preventDefault();
  const {category, subcategory, year, currency, tripId, chat} = chatFor(root);
  const question = $("[data-chat-input]", root).value.trim();
  if (!question || chat.pending) return;
  const history = chat.messages.slice(-8).map(({role, text}) => ({role, text: text.slice(0, 6000)}));
  const userMessage = {role: "user", text: question};
  chat.messages.push(userMessage);
  chat.draft = "";
  chat.error = "";
  chat.pending = true;
  updateChatTurn(root, chat, userMessage);
  try {
    const {reply, updated} = await request("/api/category-chat", {category, subcategory, year, currency, trip_id: tripId, question, history});
    const message = {role: "assistant", text: reply};
    chat.messages.push(message);
    chat.pending = false;
    updateChatTurn(root, chat, message);
    if (updated) {
      try {
        await refresh();
        const activeRoot = root === dashboardAssistant ? root : $("#category-assistant");
        if (activeRoot && chatFor(activeRoot)?.chat === chat) {
          const transcript = $(".category-chat-log", activeRoot);
          transcript.scrollTop = transcript.scrollHeight;
        }
        toast("Ledger updated.");
      } catch {
        toast("Ledger saved. Reload the page to see the updated figures.");
      }
    }
  } catch (error) {
    chat.messages.pop();
    chat.draft = question;
    chat.error = error.message;
    chat.pending = false;
    updateChatTurn(root, chat, null, true);
  }
});

function jumpTo(section) {
  if (!section) return;
  section.focus({preventScroll: true});
  section.scrollIntoView();
}

function showMixShare(chart, item) {
  const legendItem = item && chart.querySelector(`.mix-legend [data-mix-index="${item.dataset.mixIndex}"]`);
  chart.querySelector("[data-mix-title]").textContent = legendItem?.dataset.mixName || "Chart total";
  chart.querySelector("[data-mix-value]").textContent = legendItem?.dataset.mixShare || chart.dataset.mixTotal;
  chart.querySelectorAll("[data-mix-index]").forEach(entry => {
    entry.classList.toggle("mix-active", Boolean(item && entry.dataset.mixIndex === item.dataset.mixIndex));
  });
}

for (const entryEvent of ["pointerover", "focusin"]) {
  main.addEventListener(entryEvent, event => {
    const item = event.target.closest("[data-mix-index]");
    if (item && !item.contains(event.relatedTarget)) showMixShare(item.closest(".category-mix"), item);
  });
}
for (const exitEvent of ["pointerout", "focusout"]) {
  main.addEventListener(exitEvent, event => {
    const item = event.target.closest("[data-mix-index]");
    if (!item || item.contains(event.relatedTarget)) return;
    const chart = item.closest(".category-mix");
    const next = event.relatedTarget instanceof Element && event.relatedTarget.closest("[data-mix-index]");
    if (!next || !chart.contains(next)) showMixShare(chart, null);
  });
}

$("#year").onchange = event => {
  state.year = event.target.value;
  state.page = 1;
  state.selected.clear();
  if (route()[0] === "months" && route()[1]) location.hash = "months";
  else render();
};
$("#currency").onchange = event => {
  state.currency = event.target.value;
  state.page = 1;
  state.selected.clear();
  render();
};
modal.addEventListener("click", event => {if (event.target.closest('a[href^="#"]')) modal.close();});
$("#search-open").onclick = openSearch;
$("#search-close").onclick = () => searchDialog.close();
searchInput.addEventListener("input", updateSearch);
searchInput.addEventListener("keydown", event => {
  if (event.key !== "ArrowDown" && event.key !== "Enter") return;
  const first = $(".search-result", searchResults);
  if (!first) return;
  event.preventDefault();
  if (event.key === "Enter") first.click();
  else first.focus();
});
searchResults.addEventListener("click", event => {
  const result = event.target.closest(".search-result");
  if (!result) return;
  searchDialog.close();
  if (result.dataset.resultId) transactionDialog(currentRowMap.get(result.dataset.resultId));
  else if (result.dataset.receiptId) openCostcoReceipt(result.dataset.receiptId);
});
document.addEventListener("keydown", event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    openSearch();
  }
  if (event.key === "Escape" && $("#nav-toggle").getAttribute("aria-expanded") === "true") {
    $("#nav-toggle").click();
    $("#nav-toggle").focus();
  }
});
$("#nav-toggle").onclick = () => {
  const open = $("#sidebar").classList.toggle("nav-open");
  $("#nav-toggle").setAttribute("aria-expanded", String(open));
};
$(".skip-link").onclick = event => {
  event.preventDefault();
  $("#content-start").focus();
};
$("#site-nav").addEventListener("click", event => {
  if (event.target.closest("a")) {
    $("#sidebar").classList.remove("nav-open");
    $("#nav-toggle").setAttribute("aria-expanded", "false");
  }
});
window.addEventListener("hashchange", () => {
  state.search = "";
  state.page = 1;
  state.selected.clear();
  if (route()[0] !== "transactions") state.account = "";
  render();
  const [page, key, filter] = route();
  const activity = filter && (page === "months" || page === "trips") && $("#spending-activity");
  const target = page === "categories" && key === "all" ? $("#category-breakdown") : activity;
  if (target) jumpTo(target);
  else window.scrollTo(0, 0);
});

refresh().catch(error => {
  main.removeAttribute("aria-busy");
  main.innerHTML = panel("Could not load your ledger", `<p>${esc(error.message)}</p><a class="text-button" href="">Try again</a>`);
});
