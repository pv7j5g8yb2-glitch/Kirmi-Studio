"use strict";
/* Kirmi Control Centre — operations console.
   Deliberately dependency-free: this is a tool for staff, not a showcase. */

const $ = (s) => document.querySelector(s);
const el = (t, cls, txt) => { const n = document.createElement(t); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };
const esc = (s) => String(s ?? "");

const state = { user: null, tenants: [], tenantId: null, tab: "inbox", conversationId: null, timer: null };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: opts.body ? { "content-type": "application/json" } : {},
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { showLogin(); throw new Error("unauthenticated"); }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return data;
}

function money(minor, currency = "AED") {
  return new Intl.NumberFormat("en-AE", {
    style: "currency", currency,
    minimumFractionDigits: minor % 100 ? 2 : 0, maximumFractionDigits: 2,
  }).format((minor ?? 0) / 100);
}
const when = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : "—");
const chip = (v) => { const c = el("span", `chip c-${v}`, String(v).replace(/_/g, " ")); return c; };

/* ---------------------------------------------------------------- auth ---- */
function showLogin() {
  $("#app").hidden = true;
  $("#login").hidden = false;
  if (state.timer) { clearInterval(state.timer); state.timer = null; }
}

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#loginError");
  err.hidden = true;
  try {
    await api("/api/auth/login", { method: "POST", body: { email: $("#email").value, password: $("#password").value } });
    await boot();
  } catch (e2) {
    err.textContent = e2.message === "unauthenticated" ? "Invalid email or password" : e2.message;
    err.hidden = false;
  }
});

$("#logout").addEventListener("click", async () => {
  await api("/api/auth/logout", { method: "POST" }).catch(() => {});
  showLogin();
});

/* ---------------------------------------------------------------- boot ---- */
async function boot() {
  const me = await api("/api/me");
  state.user = me.user;
  state.tenants = me.tenants;
  if (!state.tenants.length) { showLogin(); return; }
  state.tenantId = state.tenants[0].id;

  $("#login").hidden = true;
  $("#app").hidden = false;
  $("#who").textContent = `${me.user.name} · ${me.user.role.replace(/_/g, " ")}`;

  const pick = $("#tenantPick");
  pick.innerHTML = "";
  for (const t of state.tenants) {
    const o = el("option", null, `${t.name}${t.mode === "demo" ? " (demo)" : ""}`);
    o.value = t.id;
    pick.appendChild(o);
  }
  pick.onchange = () => { state.tenantId = pick.value; state.conversationId = null; refresh(); };

  await refresh();
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(() => { refreshStats(); if (state.tab === "inbox") loadInbox(); }, 10000);
}

$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  state.tab = b.dataset.tab;
  for (const x of $("#tabs").children) x.classList.toggle("on", x === b);
  for (const p of document.querySelectorAll("[data-panel]")) p.hidden = p.dataset.panel !== state.tab;
  refresh();
});

async function refresh() { await refreshStats(); await loadTab(); }

async function refreshStats() {
  if (!state.tenantId) return;
  try {
    const { stats } = await api(`/api/tenants/${state.tenantId}/overview`);
    const strip = $("#stats");
    strip.innerHTML = "";
    const items = [
      ["AI handling", stats.ai_active], ["Needs a person", stats.needs_human],
      ["Enquiries 24h", stats.enquiries_24h], ["Open bookings", stats.open_reservations],
      ["Queued sends", stats.outbox_pending], ["Failed sends", stats.outbox_dead],
      ["Follow-ups due", stats.followups_due],
    ];
    for (const [label, v] of items) {
      const d = el("div", "stat");
      d.appendChild(el("b", null, String(v ?? 0)));
      d.appendChild(el("span", null, label));
      strip.appendChild(d);
    }
  } catch { /* stats are best-effort */ }
}

function loadTab() {
  const t = state.tab;
  if (t === "inbox") return loadInbox();
  if (t === "bookings") return loadBookings();
  if (t === "fleet") return loadFleet();
  if (t === "integrations") return loadIntegrations();
  if (t === "report") return loadReport();
  if (t === "audit") return loadAudit();
}

/* --------------------------------------------------------------- inbox ---- */
async function loadInbox() {
  const list = $("#convList");
  const convs = await api(`/api/tenants/${state.tenantId}/conversations`);
  list.innerHTML = "";
  if (!convs.length) { list.appendChild(el("p", "muted pad", "No conversations yet.")); return; }
  for (const c of convs) {
    const row = el("div", "row" + (c.id === state.conversationId ? " on" : ""));
    const who = el("div", "who");
    who.appendChild(el("span", "nm", c.customer.displayName || c.customer.phoneE164 || c.customer.instagramId || "Unknown"));
    who.appendChild(chip(c.state));
    row.appendChild(who);
    row.appendChild(el("div", "pv", c.lastBody || "—"));
    const meta = el("div", "pv muted", `${c.channel} · ${when(c.lastMessageAt)}${c.withinServiceWindow ? "" : " · outside 24h window"}`);
    row.appendChild(meta);
    row.onclick = () => { state.conversationId = c.id; loadInbox(); openThread(c.id); };
    list.appendChild(row);
  }
  if (state.conversationId) openThread(state.conversationId);
}

async function openThread(id) {
  const box = $("#thread");
  const { conversation, messages } = await api(`/api/tenants/${state.tenantId}/conversations/${id}`);
  box.innerHTML = "";

  const head = el("div", "thead");
  head.appendChild(chip(conversation.state));
  head.appendChild(el("span", "muted", conversation.channel));
  head.appendChild(el("span", "grow"));
  if (conversation.state === "ai_active") {
    const b = el("button", "btn ghost sm", "Take over");
    b.onclick = async () => { await api(`/api/tenants/${state.tenantId}/conversations/${id}/takeover`, { method: "POST" }); openThread(id); loadInbox(); };
    head.appendChild(b);
  } else if (conversation.state === "human_active") {
    const b = el("button", "btn ghost sm", "Hand back to Kirmi");
    b.onclick = async () => { await api(`/api/tenants/${state.tenantId}/conversations/${id}/release`, { method: "POST" }); openThread(id); loadInbox(); };
    head.appendChild(b);
  }
  box.appendChild(head);

  const msgs = el("div", "msgs");
  for (const m of messages) {
    const d = el("div", `msg ${m.direction === "inbound" ? "in" : "out"}`);
    d.appendChild(document.createTextNode(esc(m.body)));
    d.appendChild(el("div", "meta", `${m.author} · ${when(m.createdAt)} · ${m.status}`));
    msgs.appendChild(d);
  }
  box.appendChild(msgs);

  const composer = el("div", "composer");
  const ta = el("textarea");
  ta.placeholder = conversation.state === "human_active" ? "Reply as an operator…" : "Take over first to reply";
  ta.disabled = conversation.state !== "human_active";
  ta.id = "replyBox";
  const send = el("button", "btn sm", "Send");
  send.disabled = conversation.state !== "human_active";
  send.onclick = async () => {
    if (!ta.value.trim()) return;
    send.disabled = true;
    try {
      await api(`/api/tenants/${state.tenantId}/conversations/${id}/reply`, { method: "POST", body: { text: ta.value.trim() } });
      ta.value = "";
      await openThread(id);
    } finally { send.disabled = false; }
  };
  composer.appendChild(ta);
  composer.appendChild(send);
  box.appendChild(composer);
  msgs.scrollTop = msgs.scrollHeight;
}

/* ------------------------------------------------------------ bookings ---- */
function table(headers, rows) {
  const box = el("div", "wrapbox");
  const t = el("table");
  const thead = el("thead");
  const hr = el("tr");
  for (const h of headers) hr.appendChild(el("th", null, h));
  thead.appendChild(hr);
  t.appendChild(thead);
  const tb = el("tbody");
  for (const cells of rows) {
    const tr = el("tr");
    for (const c of cells) {
      const td = el("td");
      if (c instanceof Node) td.appendChild(c); else td.textContent = String(c ?? "—");
      tr.appendChild(td);
    }
    tb.appendChild(tr);
  }
  t.appendChild(tb);
  box.appendChild(t);
  return box;
}

async function loadBookings() {
  const host = $("#bookings");
  host.innerHTML = "";
  const rows = await api(`/api/tenants/${state.tenantId}/reservations`);
  host.appendChild(el("h2", null, "Bookings"));
  if (!rows.length) { host.appendChild(el("p", "muted", "No reservations yet.")); return; }
  host.appendChild(table(
    ["Vehicle", "Customer", "Dates", "State", "Confirmed by", "Total", ""],
    rows.map((r) => {
      const act = el("span");
      if (["held", "documents_pending", "payment_pending"].includes(r.state)) {
        const c = el("button", "btn ghost sm", "Confirm");
        c.title = "Records you as the operator who confirmed this booking";
        c.onclick = async () => {
          if (!confirm("Confirm this booking on your authority?")) return;
          await api(`/api/tenants/${state.tenantId}/reservations/${r.id}/confirm`, { method: "POST", body: { reason: "confirmed in console" } });
          loadBookings();
        };
        act.appendChild(c);
      }
      return [r.vehicle, r.customerName || r.customerPhone, `${r.startsAt.slice(0, 10)} → ${r.endsAt.slice(0, 10)}`,
        chip(r.state), r.confirmationSource || "—", money(r.total, r.currency), act];
    }),
  ));
}

/* --------------------------------------------------------------- fleet ---- */
async function loadFleet() {
  const host = $("#fleet");
  host.innerHTML = "";
  const [vehicles, rules] = await Promise.all([
    api(`/api/tenants/${state.tenantId}/vehicles`),
    api(`/api/tenants/${state.tenantId}/rules`),
  ]);
  host.appendChild(el("h2", null, "Fleet"));
  host.appendChild(el("div", "note",
    `Rules in force: minimum age ${rules.minAge}, up to ${rules.maxDrivers} driver(s), VAT ${rules.vatPercent}%, ` +
    `deposit default ${money(rules.depositDefault)}. Availability is ` +
    (rules.inventoryAuthoritative ? "authoritative." : "NOT authoritative — quotes say “subject to confirmation”.")));
  host.appendChild(table(
    ["Vehicle", "Category", "Daily", "Weekly", "Monthly", "Deposit", "Km/day", "Min days"],
    vehicles.map((v) => [`${v.make} ${v.model}${v.year ? " " + v.year : ""}`, v.category,
      money(v.dailyRate), v.weeklyRate ? money(v.weeklyRate) : "—", v.monthlyRate ? money(v.monthlyRate) : "—",
      money(v.deposit), v.dailyKm ?? "—", v.minDays]),
  ));
}

/* -------------------------------------------------------- integrations ---- */
async function loadIntegrations() {
  const host = $("#integrations");
  host.innerHTML = "";
  const [list, settings] = await Promise.all([
    api(`/api/tenants/${state.tenantId}/integrations`),
    api(`/api/tenants/${state.tenantId}/settings`),
  ]);
  host.appendChild(el("h2", null, "Integrations"));
  host.appendChild(el("div", "note", "BUILT is not CONNECTED. Anything below marked NOT_CONNECTED has working code and is waiting on credentials or approval."));

  for (const i of list) {
    const card = el("div", "kpi");
    const head = el("div", "who");
    head.style.display = "flex";
    head.style.justifyContent = "space-between";
    head.appendChild(el("strong", null, i.channel));
    head.appendChild(chip(i.state));
    card.appendChild(head);
    if (i.detail) card.appendChild(el("p", "muted", i.detail));
    if (i.requirements?.length) {
      const ul = el("ul", "req");
      for (const r of i.requirements) ul.appendChild(el("li", null, r));
      card.appendChild(ul);
    }
    host.appendChild(card);
  }

  const oq = settings["open_questions"];
  if (oq?.value?.length) {
    host.appendChild(el("h3", null, "Open questions for the client"));
    const ul = el("ul", "req");
    for (const q of oq.value) ul.appendChild(el("li", null, q));
    host.appendChild(ul);
  }

  host.appendChild(el("h3", null, "Configuration provenance"));
  host.appendChild(table(
    ["Setting", "How we know it"],
    Object.entries(settings).map(([k, v]) => [k, chip(v.provenance)]),
  ));
}

/* -------------------------------------------------------------- report ---- */
async function loadReport() {
  const host = $("#report");
  host.innerHTML = "";
  const r = await api(`/api/tenants/${state.tenantId}/report`);
  host.appendChild(el("h2", null, "This month"));
  const grid = el("div", "grid2");
  const kpis = [
    ["Enquiries", r.enquiries], ["Quotes sent", r.quotes],
    ["Bookings confirmed", r.reservationsConfirmed],
    ["Confirmed revenue", money(r.confirmedRevenue, r.currency)],
    ["Conversion", `${r.conversionRatePct}%`],
    ["Median first reply", r.medianFirstResponseSeconds == null ? "—" : `${r.medianFirstResponseSeconds}s`],
    ["Recovered bookings", r.recoveredBookings],
    ["Recovered revenue", money(r.recoveredRevenue, r.currency)],
    ["Handled by Kirmi", `${r.aiHandledPct}%`],
    ["Escalations", r.escalations],
  ];
  for (const [label, v] of kpis) {
    const k = el("div", "kpi");
    k.appendChild(el("b", null, String(v)));
    k.appendChild(el("span", null, label));
    grid.appendChild(k);
  }
  host.appendChild(grid);
  host.appendChild(el("div", "note", "Revenue counts confirmed bookings only. Quotes and holds are never reported as revenue."));
  if (r.byChannel.length) {
    host.appendChild(el("h3", null, "By channel"));
    host.appendChild(table(["Channel", "Enquiries", "Confirmed"], r.byChannel.map((c) => [c.channel, c.enquiries, c.confirmed])));
  }
}

/* --------------------------------------------------------------- audit ---- */
async function loadAudit() {
  const host = $("#audit");
  host.innerHTML = "";
  const rows = await api(`/api/tenants/${state.tenantId}/audit`);
  host.appendChild(el("h2", null, "Audit log"));
  host.appendChild(table(
    ["When", "Actor", "Action", "Entity"],
    rows.map((r) => [when(r.at), r.actor, r.action, r.entity ? `${r.entity} ${String(r.entityId ?? "").slice(0, 8)}` : "—"]),
  ));
}

/* ---------------------------------------------------------------- init ---- */
boot().catch(() => showLogin());
