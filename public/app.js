"use strict";

const el = (id) => document.getElementById(id);

const state = {
  todayET: null,
  activeDate: null
};

function showError(err) {
  const box = el("errorBox");
  const msg = typeof err === "string" ? err : (err && err.message ? err.message : String(err));
  box.textContent = msg;
  box.style.display = "block";
}

function clearError() {
  const box = el("errorBox");
  box.textContent = "";
  box.style.display = "none";
}

async function apiGet(url) {
  const res = await fetch(url, { headers: { "Accept": "application/json" } });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const detail = data && data.error ? data.error : text;
    throw new Error(`${res.status} ${res.statusText}: ${detail}`);
  }
  return data;
}

async function apiPost(url, bodyObj) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(bodyObj || {})
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const detail = data && data.error ? data.error : text;
    throw new Error(`${res.status} ${res.statusText}: ${detail}`);
  }
  return data;
}

function setMetaLine(text) {
  el("metaLine").textContent = text || "";
}

function renderQuickLinks(data) {
  const wrap = el("quickLinks");
  wrap.innerHTML = "";
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(data, null, 2);
  wrap.appendChild(pre);
}

function renderStatus(data) {
  const wrap = el("status");
  wrap.innerHTML = "";
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(data, null, 2);
  wrap.appendChild(pre);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function tableForLeaders(list, label) {
  const container = document.createElement("div");
  container.style.marginBottom = "14px";

  const h = document.createElement("div");
  h.textContent = label;
  h.style.fontWeight = "700";
  h.style.margin = "10px 0 6px";
  container.appendChild(h);

  const t = document.createElement("table");
  t.innerHTML = `
    <thead>
      <tr><th>#</th><th>Player</th><th>GP</th><th>Per Game</th></tr>
    </thead>
  `;
  const tb = document.createElement("tbody");

  list.forEach((r, i) => {
    const tr = document.createElement("tr");
    const name = r.playerName || r.playerId || "Unknown";
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${escapeHtml(name)}</td>
      <td>${r.gp ?? ""}</td>
      <td>${r.perGame ?? ""}</td>
    `;
    tb.appendChild(tr);
  });

  t.appendChild(tb);
  container.appendChild(t);
  return container;
}

function renderLeaders(data) {
  const wrap = el("leaders");
  wrap.innerHTML = "";

  const meta = document.createElement("div");
  meta.className = "muted";
  meta.textContent = data.cached ? `cached: true • ts: ${data.ts}` : "cached: false (computed on request)";
  wrap.appendChild(meta);

  const leaders = data.leaders;
  wrap.appendChild(tableForLeaders(leaders.points || [], "Points"));
  wrap.appendChild(tableForLeaders(leaders.rebounds || [], "Rebounds"));
  wrap.appendChild(tableForLeaders(leaders.assists || [], "Assists"));
  wrap.appendChild(tableForLeaders(leaders.threes || [], "3PT Made"));
}

function renderEdges(data) {
  const wrap = el("edges");
  wrap.innerHTML = "";

  const meta = document.createElement("div");
  meta.className = "muted";
  meta.textContent = `date: ${data.date} • gamesN: ${data.gamesN} • minEdge: ${data.minEdge} • total: ${data.counts.total}`;
  wrap.appendChild(meta);

  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(data.tiered, null, 2);
  wrap.appendChild(pre);
}

function renderSgoProps(data) {
  const wrap = el("sgoProps");
  wrap.innerHTML = "";

  const meta = document.createElement("div");
  meta.className = "muted";
  meta.textContent = `date: ${data.date} • count: ${data.count}`;
  wrap.appendChild(meta);

  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(data.props || [], null, 2);
  wrap.appendChild(pre);
}

function getInputs() {
  const date = el("dateInput").value || "";
  const minEdge = el("minEdgeInput").value || "0";
  const games = el("gamesInput").value || "10";
  return { date, minEdge: Number(minEdge), games: Number(games) };
}

async function loadActiveDate() {
  const data = await apiGet("/api/props/active-date");
  state.todayET = data.todayET;
  state.activeDate = data.activeDate;

  if (!el("dateInput").value) el("dateInput").value = state.activeDate || state.todayET || "";
}

async function refreshAll() {
  clearError();
  try {
    setMetaLine("Loading...");
    const inputs = getInputs();

    const [quickLinks, status, leaders, edges, sgo] = await Promise.all([
      apiGet("/api/pt/quick-links"),
      apiGet("/api/nba/stats/status"),
      apiGet("/api/nba/stats/leaders"),
      apiGet(`/api/nba/edges-today-tiered?date=${encodeURIComponent(inputs.date)}&minEdge=${encodeURIComponent(inputs.minEdge)}&games=${encodeURIComponent(inputs.games)}`),
      apiGet(`/api/odds/sgo/props-for-date?date=${encodeURIComponent(inputs.date)}&limit=50`)
    ]);

    renderQuickLinks(quickLinks);
    renderStatus(status);
    renderLeaders(leaders);
    renderEdges(edges);
    renderSgoProps(sgo);

    setMetaLine(`OK • todayET: ${state.todayET || "?"} • activeDate: ${state.activeDate || "?"}`);
  } catch (err) {
    showError(err);
    setMetaLine("Error");
  }
}

async function warmLeaders() {
  clearError();
  try {
    setMetaLine("Warming leaders cache...");
    const data = await apiPost("/api/nba/stats/warm", {});
    setMetaLine(`Leaders warmed • ts: ${data.ts}`);
    await refreshAll();
  } catch (err) {
    showError(err);
    setMetaLine("Error");
  }
}

function wireUI() {
  el("refreshBtn").addEventListener("click", refreshAll);
  el("warmBtn").addEventListener("click", warmLeaders);
  el("dateInput").addEventListener("change", refreshAll);
}

(async function main() {
  wireUI();
  try { await loadActiveDate(); } catch (e) { showError(`Active-date load failed: ${e.message}`); }
  await refreshAll();
})();
