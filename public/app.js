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
// ===========================
// APPEND-ONLY UI BLOCK: Edges v2 + Mode Toggle
// Paste at the very bottom of public/app.js
// ===========================

(function () {
  function $(id) { return document.getElementById(id); }

  function showError(msg) {
    const box = $("errorBox");
    if (!box) return;
    box.textContent = msg ? String(msg) : "";
    box.style.display = msg ? "block" : "none";
  }

  function ensureModeToggle() {
    // Create a simple mode toggle near the top if it doesn't exist
    if ($("modeSelect")) return;

    const container =
      $("controls") || // if you have a wrapper
      document.querySelector(".controls") ||
      document.body;

    const wrap = document.createElement("div");
    wrap.style.margin = "8px 0";

    const label = document.createElement("label");
    label.textContent = "Projection Mode:";
    label.style.display = "block";
    label.style.fontSize = "14px";
    label.style.marginBottom = "4px";

    const select = document.createElement("select");
    select.id = "modeSelect";
    select.style.width = "100%";
    select.style.padding = "10px";
    select.style.fontSize = "16px";

    const optW = document.createElement("option");
    optW.value = "weighted";
    optW.textContent = "Weighted (recent games matter more)";

    const optF = document.createElement("option");
    optF.value = "flat";
    optF.textContent = "Flat average";

    select.appendChild(optW);
    select.appendChild(optF);

    wrap.appendChild(label);
    wrap.appendChild(select);

    // Insert near top of page, but not breaking layout
    if (container && container !== document.body) {
      container.appendChild(wrap);
    } else {
      document.body.insertBefore(wrap, document.body.firstChild);
    }
  }

  function getVal(id, fallback) {
    const el = $(id);
    if (!el) return fallback;
    return el.value;
  }

  async function refreshEdgesV2() {
    showError("");

    const date = getVal("dateInput", "");
    const minEdge = getVal("minEdgeInput", "0");
    const games = getVal("gamesInput", "10");
    const mode = getVal("modeSelect", "weighted");

    const qs = new URLSearchParams();
    if (date) qs.set("date", date);
    if (minEdge !== "") qs.set("minEdge", String(minEdge));
    if (games !== "") qs.set("games", String(games));
    qs.set("mode", mode);

    const edgesBox = $("edgesBox") || $("edges") || $("edgesSection");
    if (edgesBox) edgesBox.textContent = "Loading edges…";

    try {
      const r = await fetch(`/api/nba/edges-tiered-v2?${qs.toString()}`);
      const data = await r.json();

      if (!r.ok || !data.ok) {
        throw new Error(data.error || `Request failed (${r.status})`);
      }

      if (!edgesBox) return;

      const { tiers, counts, date: d, mode: m, gamesUsed } = data;
      const lines = [];

      lines.push(`Date: ${d} | Mode: ${m} | Games: ${gamesUsed}`);
      lines.push(`Props: ${counts.totalPropsForDate} | A:${counts.A} B:${counts.B} C:${counts.C}`);
      lines.push("");

      function addTier(name) {
        lines.push(`=== Tier ${name} ===`);
        const arr = tiers[name] || [];
        if (arr.length === 0) {
          lines.push("(none)");
          lines.push("");
          return;
        }
        for (const it of arr) {
          lines.push(
            `${it.playerName} ${it.statType} | line ${it.line} | proj ${it.proj} | edge ${it.edge} | gp ${it.gp} | ${it.source}`
          );
        }
        lines.push("");
      }

      addTier("A");
      addTier("B");
      addTier("C");

      edgesBox.textContent = lines.join("\n");
    } catch (err) {
      if (edgesBox) edgesBox.textContent = "";
      showError(err.message || String(err));
    }
  }

  function wireButtons() {
    // Try to hook your existing Refresh button, but don't break if IDs differ.
    const btn = $("btnRefresh") || $("refreshBtn") || document.querySelector("button[data-action='refresh']");
    if (btn && !btn.__ptBoundEdgesV2) {
      btn.__ptBoundEdgesV2 = true;
      btn.addEventListener("click", () => {
        // call existing refresh if you have it, then edges v2
        refreshEdgesV2();
      });
    }

    // Also refresh edges when mode changes
    const modeSel = $("modeSelect");
    if (modeSel && !modeSel.__ptBoundEdgesV2) {
      modeSel.__ptBoundEdgesV2 = true;
      modeSel.addEventListener("change", refreshEdgesV2);
    }
  }

  window.addEventListener("load", () => {
    ensureModeToggle();
    wireButtons();

    // Optional auto-load edges on page load if edges box exists
    const edgesBox = $("edgesBox") || $("edges") || $("edgesSection");
    if (edgesBox) refreshEdgesV2();
  });
})();

// ===========================
// APPEND-ONLY UI BLOCK: Archive Props Button
// Paste at the very bottom of public/app.js
// ===========================

(function () {
  function $(id) { return document.getElementById(id); }

  function showError(msg) {
    const box = $("errorBox");
    if (!box) return;
    box.textContent = msg ? String(msg) : "";
    box.style.display = msg ? "block" : "none";
  }

  function appendStatusLine(line) {
    const statusBox = $("statusBox") || $("status") || $("statusSection");
    if (!statusBox) return;
    const prev = statusBox.textContent || "";
    statusBox.textContent = prev ? (prev + "\n" + line) : line;
  }

  function ensureArchiveButton() {
    if ($("btnArchiveProps")) return;

    const container =
      $("controls") ||
      document.querySelector(".controls") ||
      document.body;

    const btn = document.createElement("button");
    btn.id = "btnArchiveProps";
    btn.type = "button";
    btn.textContent = "Archive Props For Date";
    btn.style.width = "100%";
    btn.style.padding = "12px";
    btn.style.fontSize = "16px";
    btn.style.margin = "8px 0";

    // Put it near other buttons if possible
    if (container && container !== document.body) container.appendChild(btn);
    else document.body.appendChild(btn);
  }

  async function archivePropsForSelectedDate() {
    showError("");

    const dateInput = $("dateInput");
    const date = dateInput && dateInput.value ? String(dateInput.value) : "";

    if (!date) {
      showError("Pick a date first, then tap Archive Props For Date.");
      return;
    }

    try {
      const r = await fetch("/api/props/archive-date", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date })
      });

      const data = await r.json();

      if (!r.ok || !data.ok) {
        throw new Error(data.error || `Archive failed (${r.status})`);
      }

      appendStatusLine(`Archived props for ${data.date} @ ${data.archivedAt} | sgo=${data.counts.sgo} hardrock=${data.counts.hardrock}`);
    } catch (err) {
      showError(err.message || String(err));
    }
  }

  window.addEventListener("load", () => {
    ensureArchiveButton();

    const btn = $("btnArchiveProps");
    if (btn && !btn.__ptBoundArchive) {
      btn.__ptBoundArchive = true;
      btn.addEventListener("click", archivePropsForSelectedDate);
    }
  });
})();

// ===========================
// APPEND-ONLY UI BLOCK: Archive Viewer
// Paste at the very bottom of public/app.js
// ===========================

(function () {
  function $(id) { return document.getElementById(id); }

  function showError(msg) {
    const box = $("errorBox");
    if (!box) return;
    box.textContent = msg ? String(msg) : "";
    box.style.display = msg ? "block" : "none";
  }

  function ensureArchiveViewer() {
    if ($("archiveBox")) return;

    const root =
      document.querySelector("#main") ||
      document.querySelector(".container") ||
      document.body;

    const section = document.createElement("section");
    section.style.padding = "12px";
    section.style.border = "1px solid #ddd";
    section.style.borderRadius = "10px";
    section.style.margin = "12px 0";

    const h = document.createElement("h3");
    h.textContent = "Archive Viewer";
    h.style.margin = "0 0 8px 0";

    const btn = document.createElement("button");
    btn.id = "btnLoadArchive";
    btn.type = "button";
    btn.textContent = "Load Archive For Date";
    btn.style.width = "100%";
    btn.style.padding = "12px";
    btn.style.fontSize = "16px";

    const pre = document.createElement("pre");
    pre.id = "archiveBox";
    pre.style.whiteSpace = "pre-wrap";
    pre.style.marginTop = "10px";
    pre.style.padding = "10px";
    pre.style.background = "#f7f7f7";
    pre.style.borderRadius = "10px";
    pre.textContent = "No archive loaded yet.";

    section.appendChild(h);
    section.appendChild(btn);
    section.appendChild(pre);

    root.appendChild(section);
  }

  function formatProp(p) {
    const name = p.playerName || p.playerId || "Unknown";
    const stat = p.statType || "stat";
    const line = (p.line !== undefined) ? p.line : "?";
    const team = p.team ? ` (${p.team})` : "";
    return `${name}${team} — ${stat} ${line}`;
  }

  async function loadArchiveForSelectedDate() {
    showError("");

    const dateInput = $("dateInput");
    const date = dateInput && dateInput.value ? String(dateInput.value) : "";

    if (!date) {
      showError("Pick a date first, then tap Load Archive For Date.");
      return;
    }

    const box = $("archiveBox");
    if (box) box.textContent = "Loading archive…";

    try {
      const r = await fetch(`/api/props/archive?date=${encodeURIComponent(date)}`);
      const data = await r.json();

      if (!r.ok || !data.ok) {
        throw new Error(data.error || `Archive load failed (${r.status})`);
      }

      if (!box) return;

      if (!data.exists || !data.archive) {
        box.textContent = `No archive exists for ${date}.`;
        return;
      }

      const a = data.archive;
      const sgo = Array.isArray(a.sgo) ? a.sgo : [];
      const hr = Array.isArray(a.hardrock) ? a.hardrock : [];

      const lines = [];
      lines.push(`Archived Date: ${date}`);
      lines.push(`Archived At: ${a.ts}`);
      lines.push(`SGO count: ${sgo.length}`);
      lines.push(`Hardrock count: ${hr.length}`);
      lines.push("");

      lines.push("— SGO (first 20) —");
      for (const p of sgo.slice(0, 20)) lines.push(formatProp(p));
      lines.push("");

      lines.push("— Hardrock (first 20) —");
      for (const p of hr.slice(0, 20)) lines.push(formatProp(p));

      box.textContent = lines.join("\n");
    } catch (err) {
      if (box) box.textContent = "";
      showError(err.message || String(err));
    }
  }

  window.addEventListener("load", () => {
    ensureArchiveViewer();

    const btn = $("btnLoadArchive");
    if (btn && !btn.__ptBoundArchiveViewer) {
      btn.__ptBoundArchiveViewer = true;
      btn.addEventListener("click", loadArchiveForSelectedDate);
    }
  });
})();

// ===========================
// APPEND-ONLY UI BLOCK: One-Tap Pipeline (Paste JSON -> Import -> Archive -> Refresh)
// Paste at the very bottom of public/app.js
// ===========================

(function () {
  function $(id) { return document.getElementById(id); }

  function showError(msg) {
    const box = $("errorBox");
    if (!box) return;
    box.textContent = msg ? String(msg) : "";
    box.style.display = msg ? "block" : "none";
  }

  function ensurePipelineUI() {
    if ($("pipelineBox")) return;

    const root =
      document.querySelector("#main") ||
      document.querySelector(".container") ||
      document.body;

    const section = document.createElement("section");
    section.id = "pipelineBox";
    section.style.padding = "12px";
    section.style.border = "1px solid #ddd";
    section.style.borderRadius = "10px";
    section.style.margin = "12px 0";

    const h = document.createElement("h3");
    h.textContent = "One-Tap Pipeline";
    h.style.margin = "0 0 8px 0";

    const p = document.createElement("div");
    p.textContent = "Paste JSON array, import it, optionally archive props for selected date, then refresh.";
    p.style.fontSize = "14px";
    p.style.opacity = "0.85";
    p.style.marginBottom = "10px";

    const labelType = document.createElement("label");
    labelType.textContent = "JSON Type:";
    labelType.style.display = "block";
    labelType.style.margin = "8px 0 4px 0";
    labelType.style.fontSize = "14px";

    const sel = document.createElement("select");
    sel.id = "pipelineType";
    sel.style.width = "100%";
    sel.style.padding = "10px";
    sel.style.fontSize = "16px";

    const opt1 = document.createElement("option");
    opt1.value = "nba";
    opt1.textContent = "NBA Game Logs (POST /api/import/nba-game-logs)";

    const opt2 = document.createElement("option");
    opt2.value = "sgo";
    opt2.textContent = "SGO Props (POST /api/import/sgo-props)";

    const opt3 = document.createElement("option");
    opt3.value = "hardrock";
    opt3.textContent = "Hardrock Props (POST /api/import/hardrock-props)";

    sel.appendChild(opt1);
    sel.appendChild(opt2);
    sel.appendChild(opt3);

    const labelJSON = document.createElement("label");
    labelJSON.textContent = "Paste JSON Array:";
    labelJSON.style.display = "block";
    labelJSON.style.margin = "8px 0 4px 0";
    labelJSON.style.fontSize = "14px";

    const ta = document.createElement("textarea");
    ta.id = "pipelineJSON";
    ta.placeholder = '[{"date":"2026-02-16","playerId":"99","playerName":"Example","statType":"points","line":19.5,"team":"TTT"}]';
    ta.style.width = "100%";
    ta.style.minHeight = "140px";
    ta.style.fontSize = "14px";
    ta.style.padding = "10px";

    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.gap = "8px";
    row.style.marginTop = "10px";

    const btnImport = document.createElement("button");
    btnImport.id = "btnPipelineImport";
    btnImport.type = "button";
    btnImport.textContent = "Import JSON";
    btnImport.style.flex = "1";
    btnImport.style.padding = "12px";
    btnImport.style.fontSize = "16px";

    const btnRunAll = document.createElement("button");
    btnRunAll.id = "btnPipelineRunAll";
    btnRunAll.type = "button";
    btnRunAll.textContent = "Import + Archive + Refresh";
    btnRunAll.style.flex = "1";
    btnRunAll.style.padding = "12px";
    btnRunAll.style.fontSize = "16px";

    row.appendChild(btnImport);
    row.appendChild(btnRunAll);

    const pre = document.createElement("pre");
    pre.id = "pipelineOut";
    pre.style.whiteSpace = "pre-wrap";
    pre.style.marginTop = "10px";
    pre.style.padding = "10px";
    pre.style.background = "#f7f7f7";
    pre.style.borderRadius = "10px";
    pre.textContent = "Ready.";

    section.appendChild(h);
    section.appendChild(p);
    section.appendChild(labelType);
    section.appendChild(sel);
    section.appendChild(labelJSON);
    section.appendChild(ta);
    section.appendChild(row);
    section.appendChild(pre);

    root.appendChild(section);
  }

  function out(line, replace) {
    const box = $("pipelineOut");
    if (!box) return;
    if (replace) box.textContent = String(line || "");
    else box.textContent = (box.textContent ? box.textContent + "\n" : "") + String(line || "");
  }

  function getSelectedDate() {
    const d = $("dateInput");
    return d && d.value ? String(d.value) : "";
  }

  function getEdgesParams() {
    const date = getSelectedDate();
    const minEdge = ($("minEdgeInput") && $("minEdgeInput").value) ? $("minEdgeInput").value : "0";
    const games = ($("gamesInput") && $("gamesInput").value) ? $("gamesInput").value : "10";
    const mode = ($("modeSelect") && $("modeSelect").value) ? $("modeSelect").value : "weighted";
    return { date, minEdge, games, mode };
  }

  async function refreshStatusBox() {
    const statusBox = $("statusBox") || $("status") || $("statusSection");
    if (!statusBox) return;

    try {
      const r = await fetch("/api/nba/stats/status");
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || `Status failed (${r.status})`);

      statusBox.textContent =
        `DB Counts:\n` +
        `nbaPlayerGameLogs: ${data.counts.nbaPlayerGameLogs}\n` +
        `sgoPropLines: ${data.counts.sgoPropLines}\n` +
        `hardrockPropLines: ${data.counts.hardrockPropLines}\n\n` +
        `Cache leaders: ${data.cache?.leaders?.hasData ? "yes" : "no"}`;
    } catch (e) {
      showError(e.message || String(e));
    }
  }

  async function refreshEdgesBoxV2() {
    const edgesBox = $("edgesBox") || $("edges") || $("edgesSection");
    if (!edgesBox) return;

    const { date, minEdge, games, mode } = getEdgesParams();
    edgesBox.textContent = "Loading edges…";

    try {
      const qs = new URLSearchParams();
      if (date) qs.set("date", date);
      qs.set("minEdge", String(minEdge));
      qs.set("games", String(games));
      qs.set("mode", String(mode));

      const r = await fetch(`/api/nba/edges-tiered-v2?${qs.toString()}`);
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || `Edges failed (${r.status})`);

      const lines = [];
      lines.push(`Date: ${data.date} | Mode: ${data.mode} | Games: ${data.gamesUsed}`);
      lines.push(`Props: ${data.counts.totalPropsForDate} | A:${data.counts.A} B:${data.counts.B} C:${data.counts.C}`);
      lines.push("");

      for (const tierName of ["A", "B", "C"]) {
        lines.push(`=== Tier ${tierName} ===`);
        const arr = data.tiers?.[tierName] || [];
        if (!arr.length) {
          lines.push("(none)");
          lines.push("");
          continue;
        }
        for (const it of arr) {
          lines.push(`${it.playerName} ${it.statType} | line ${it.line} | proj ${it.proj} | edge ${it.edge} | gp ${it.gp} | ${it.source}`);
        }
        lines.push("");
      }

      edgesBox.textContent = lines.join("\n");
    } catch (e) {
      edgesBox.textContent = "";
      showError(e.message || String(e));
    }
  }

  async function postJSON(url, payloadArray) {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payloadArray)
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) {
      throw new Error(data.error || `POST ${url} failed (${r.status})`);
    }
    return data;
  }

  async function archiveDate(date) {
    const r = await fetch("/api/props/archive-date", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data.error || `Archive failed (${r.status})`);
    return data;
  }

  function parseTextareaJSON() {
    const ta = $("pipelineJSON");
    const txt = ta ? String(ta.value || "").trim() : "";
    if (!txt) throw new Error("Paste a JSON array first.");
    let obj;
    try { obj = JSON.parse(txt); }
    catch (e) { throw new Error("Invalid JSON. Paste a JSON ARRAY like: [ {...}, {...} ]"); }
    if (!Array.isArray(obj)) throw new Error("JSON must be an ARRAY: [ {...}, {...} ]");
    return obj;
  }

  async function doImportOnly() {
    showError("");
    out("Starting import…", true);

    const type = $("pipelineType") ? $("pipelineType").value : "nba";
    const arr = parseTextareaJSON();

    let url = "/api/import/nba-game-logs";
    if (type === "sgo") url = "/api/import/sgo-props";
    if (type === "hardrock") url = "/api/import/hardrock-props";

    const res = await postJSON(url, arr);
    out(`Imported via ${url}`);
    out(`Received: ${res.received} | Added: ${res.added} | Total: ${res.total}`);
    if (res.sampleAdded) out(`Sample:\n${JSON.stringify(res.sampleAdded, null, 2)}`);
    await refreshStatusBox();
    await refreshEdgesBoxV2();
  }

  async function doImportArchiveRefresh() {
    showError("");
    out("Starting import + archive + refresh…", true);

    const type = $("pipelineType") ? $("pipelineType").value : "nba";
    const arr = parseTextareaJSON();

    let url = "/api/import/nba-game-logs";
    if (type === "sgo") url = "/api/import/sgo-props";
    if (type === "hardrock") url = "/api/import/hardrock-props";

    const imported = await postJSON(url, arr);
    out(`Imported via ${url}`);
    out(`Received: ${imported.received} | Added: ${imported.added} | Total: ${imported.total}`);

    const date = getSelectedDate();
    if (date) {
      const archived = await archiveDate(date);
      out(`Archived ${archived.date} @ ${archived.archivedAt} | sgo=${archived.counts.sgo} hardrock=${archived.counts.hardrock}`);
    } else {
      out("No date selected — skipped archive step.");
    }

    await refreshStatusBox();
    await refreshEdgesBoxV2();
    out("Done.");
  }

  window.addEventListener("load", () => {
    ensurePipelineUI();

    const b1 = $("btnPipelineImport");
    if (b1 && !b1.__ptBound) {
      b1.__ptBound = true;
      b1.addEventListener("click", () => doImportOnly().catch(e => showError(e.message || String(e))));
    }

    const b2 = $("btnPipelineRunAll");
    if (b2 && !b2.__ptBound) {
      b2.__ptBound = true;
      b2.addEventListener("click", () => doImportArchiveRefresh().catch(e => showError(e.message || String(e))));
    }
  });
})();


// ===========================
// APPEND-ONLY UI BLOCK: Line Movers Viewer
// Paste at the very bottom of public/app.js
// ===========================

(function () {
  function $(id) { return document.getElementById(id); }

  function showError(msg) {
    const box = $("errorBox");
    if (!box) return;
    box.textContent = msg ? String(msg) : "";
    box.style.display = msg ? "block" : "none";
  }

  function ensureLineMoversUI() {
    if ($("lineMoversBox")) return;

    const root =
      document.querySelector("#main") ||
      document.querySelector(".container") ||
      document.body;

    const section = document.createElement("section");
    section.style.padding = "12px";
    section.style.border = "1px solid #ddd";
    section.style.borderRadius = "10px";
    section.style.margin = "12px 0";

    const h = document.createElement("h3");
    h.textContent = "Line Movers";
    h.style.margin = "0 0 8px 0";

    const row1 = document.createElement("div");
    row1.style.display = "flex";
    row1.style.gap = "8px";
    row1.style.marginBottom = "8px";

    const src = document.createElement("select");
    src.id = "lineMoversSource";
    src.style.flex = "1";
    src.style.padding = "10px";
    src.style.fontSize = "16px";

    const oAll = document.createElement("option");
    oAll.value = "all";
    oAll.textContent = "All Sources";

    const oS = document.createElement("option");
    oS.value = "sgo";
    oS.textContent = "SGO Only";

    const oH = document.createElement("option");
    oH.value = "hardrock";
    oH.textContent = "Hardrock Only";

    src.appendChild(oAll);
    src.appendChild(oS);
    src.appendChild(oH);

    const lim = document.createElement("input");
    lim.id = "lineMoversLimit";
    lim.type = "number";
    lim.inputMode = "numeric";
    lim.placeholder = "Limit";
    lim.value = "50";
    lim.style.width = "110px";
    lim.style.padding = "10px";
    lim.style.fontSize = "16px";

    row1.appendChild(src);
    row1.appendChild(lim);

    const btn = document.createElement("button");
    btn.id = "btnLoadLineMovers";
    btn.type = "button";
    btn.textContent = "Load Line Movers";
    btn.style.width = "100%";
    btn.style.padding = "12px";
    btn.style.fontSize = "16px";

    const pre = document.createElement("pre");
    pre.id = "lineMoversBox";
    pre.style.whiteSpace = "pre-wrap";
    pre.style.marginTop = "10px";
    pre.style.padding = "10px";
    pre.style.background = "#f7f7f7";
    pre.style.borderRadius = "10px";
    pre.textContent = "No line movers loaded yet.";

    section.appendChild(h);
    section.appendChild(row1);
    section.appendChild(btn);
    section.appendChild(pre);

    root.appendChild(section);
  }

  function fmtMove(m) {
    const name = m.playerName || m.playerId || "Unknown";
    const stat = m.statType || "stat";
    const team = m.team ? ` (${m.team})` : "";
    const d = (m.delta >= 0) ? `+${m.delta}` : `${m.delta}`;
    return `${name}${team} — ${stat} | open ${m.openLine} → now ${m.curLine} | move ${d} | ${m.source}`;
  }

  async function loadLineMovers() {
    showError("");

    const dateEl = $("dateInput");
    const date = dateEl && dateEl.value ? String(dateEl.value) : "";
    if (!date) {
      showError("Pick a date first, then load line movers.");
      return;
    }

    const source = $("lineMoversSource") ? $("lineMoversSource").value : "all";
    const limit = $("lineMoversLimit") ? $("lineMoversLimit").value : "50";

    const box = $("lineMoversBox");
    if (box) box.textContent = "Loading line movers…";

    try {
      const qs = new URLSearchParams();
      qs.set("date", date);
      qs.set("source", source);
      qs.set("limit", String(limit || 50));

      const r = await fetch(`/api/props/line-moves?${qs.toString()}`);
      const data = await r.json();

      if (!r.ok || !data.ok) {
        throw new Error(data.error || `Request failed (${r.status})`);
      }

      if (!box) return;

      if (!data.exists) {
        box.textContent = `No archive exists for ${date}.\n\nRun "Archive Props For Date" first.`;
        return;
      }

      const lines = [];
      lines.push(`Date: ${data.date} | Source: ${data.source} | ArchivedAt: ${data.archivedAt || "?"}`);
      lines.push(`Archive counts: sgo=${data.counts.archiveSGO} hardrock=${data.counts.archiveHardrock}`);
      lines.push(`Current counts: sgo=${data.counts.currentSGO} hardrock=${data.counts.currentHardrock}`);
      lines.push(`Moves found: ${data.counts.moves}`);
      lines.push("");

      const moves = Array.isArray(data.moves) ? data.moves : [];
      if (!moves.length) {
        lines.push("(No moves yet — change current lines vs archived lines to see movement.)");
      } else {
        for (const m of moves) lines.push(fmtMove(m));
      }

      box.textContent = lines.join("\n");
    } catch (err) {
      if (box) box.textContent = "";
      showError(err.message || String(err));
    }
  }

  window.addEventListener("load", () => {
    ensureLineMoversUI();

    const btn = $("btnLoadLineMovers");
    if (btn && !btn.__ptBoundLineMovers) {
      btn.__ptBoundLineMovers = true;
      btn.addEventListener("click", loadLineMovers);
    }
  });
})();

// ===========================
// APPEND-ONLY UI BLOCK: Simulate Line Move (DEV)
// Paste at the very bottom of public/app.js
// ===========================

(function () {
  function $(id) { return document.getElementById(id); }

  function showError(msg) {
    const box = $("errorBox");
    if (!box) return;
    box.textContent = msg ? String(msg) : "";
    box.style.display = msg ? "block" : "none";
  }

  function ensureSimMoveUI() {
    if ($("btnSimMove")) return;

    const root =
      document.querySelector("#main") ||
      document.querySelector(".container") ||
      document.body;

    const section = document.createElement("section");
    section.style.padding = "12px";
    section.style.border = "1px dashed #bbb";
    section.style.borderRadius = "10px";
    section.style.margin = "12px 0";

    const h = document.createElement("h3");
    h.textContent = "DEV: Simulate Line Move";
    h.style.margin = "0 0 8px 0";

    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.gap = "8px";
    row.style.marginBottom = "8px";

    const src = document.createElement("select");
    src.id = "simSource";
    src.style.flex = "1";
    src.style.padding = "10px";
    src.style.fontSize = "16px";
    src.innerHTML = `
      <option value="sgo">SGO</option>
      <option value="hardrock">Hardrock</option>
    `;

    const stat = document.createElement("select");
    stat.id = "simStat";
    stat.style.flex = "1";
    stat.style.padding = "10px";
    stat.style.fontSize = "16px";
    stat.innerHTML = `
      <option value="points">points</option>
      <option value="rebounds">rebounds</option>
      <option value="assists">assists</option>
      <option value="3pm">3pm</option>
    `;

    row.appendChild(src);
    row.appendChild(stat);

    const row2 = document.createElement("div");
    row2.style.display = "flex";
    row2.style.gap = "8px";

    const delta = document.createElement("input");
    delta.id = "simDelta";
    delta.type = "number";
    delta.inputMode = "decimal";
    delta.value = "1";
    delta.placeholder = "Delta";
    delta.style.width = "110px";
    delta.style.padding = "10px";
    delta.style.fontSize = "16px";

    const btn = document.createElement("button");
    btn.id = "btnSimMove";
    btn.type = "button";
    btn.textContent = "Simulate Move";
    btn.style.flex = "1";
    btn.style.padding = "12px";
    btn.style.fontSize = "16px";

    row2.appendChild(delta);
    row2.appendChild(btn);

    const pre = document.createElement("pre");
    pre.id = "simMoveOut";
    pre.style.whiteSpace = "pre-wrap";
    pre.style.marginTop = "10px";
    pre.style.padding = "10px";
    pre.style.background = "#f7f7f7";
    pre.style.borderRadius = "10px";
    pre.textContent = "Tip: Archive first, then simulate, then load line movers.";

    section.appendChild(h);
    section.appendChild(row);
    section.appendChild(row2);
    section.appendChild(pre);

    root.appendChild(section);
  }

  async function simulateMove() {
    showError("");
    const date = ($("dateInput") && $("dateInput").value) ? String($("dateInput").value) : "";
    if (!date) {
      showError("Pick a date first.");
      return;
    }

    const source = $("simSource") ? $("simSource").value : "sgo";
    const statType = $("simStat") ? $("simStat").value : "points";
    const delta = Number(($("simDelta") && $("simDelta").value) ? $("simDelta").value : 1);

    const out = $("simMoveOut");
    if (out) out.textContent = "Simulating…";

    try {
      const r = await fetch("/api/dev/simulate-line-move", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, source, statType, delta })
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || `Sim failed (${r.status})`);

      if (out) out.textContent = JSON.stringify(data.updated, null, 2);

      // If line movers UI exists, you can now tap "Load Line Movers"
    } catch (e) {
      if (out) out.textContent = "";
      showError(e.message || String(e));
    }
  }

  window.addEventListener("load", () => {
    ensureSimMoveUI();
    const btn = $("btnSimMove");
    if (btn && !btn.__ptBoundSim) {
      btn.__ptBoundSim = true;
      btn.addEventListener("click", simulateMove);
    }
  });
})();

// ===========================
// APPEND-ONLY UI BLOCK: Auto-refresh Line Movers after DEV simulate + archive
// Paste at the very bottom of public/app.js
// ===========================

(function () {
  function $(id) { return document.getElementById(id); }

  // Try to click the existing "Load Line Movers" button if it exists
  function triggerLineMoversRefresh() {
    const btn = $("btnLoadLineMovers");
    if (btn) btn.click();
  }

  // Try to click the existing "Refresh" button if it exists (updates edges/status in many builds)
  function triggerMainRefresh() {
    const btn = $("btnRefresh") || $("refreshBtn") || document.querySelector("button[data-action='refresh']");
    if (btn) btn.click();
  }

  // Hook into simulate button, without editing earlier code
  function hookSimulateButton() {
    const simBtn = $("btnSimMove");
    if (!simBtn || simBtn.__ptHookedAuto) return;
    simBtn.__ptHookedAuto = true;

    simBtn.addEventListener("click", () => {
      // simulate endpoint runs async; wait a moment then refresh movers
      setTimeout(() => {
        triggerLineMoversRefresh();
        triggerMainRefresh();
      }, 600);
    });
  }

  // Hook into archive button too, because you often archive then want to view movers immediately
  function hookArchiveButton() {
    const archBtn = $("btnArchiveProps");
    if (!archBtn || archBtn.__ptHookedAuto) return;
    archBtn.__ptHookedAuto = true;

    archBtn.addEventListener("click", () => {
      setTimeout(() => {
        triggerLineMoversRefresh();
      }, 600);
    });
  }

  window.addEventListener("load", () => {
    hookSimulateButton();
    hookArchiveButton();

    // In case buttons are added after load by other append blocks, re-check briefly
    let tries = 0;
    const t = setInterval(() => {
      hookSimulateButton();
      hookArchiveButton();
      tries++;
      if (tries >= 10) clearInterval(t);
    }, 500);
  });
})();

// ===========================
// APPEND-ONLY UI BLOCK: Backup DB Button (downloads /api/db/export)
// Paste at the very bottom of public/app.js
// ===========================

(function () {
  function $(id) { return document.getElementById(id); }

  function showError(msg) {
    const box = $("errorBox");
    if (!box) return;
    box.textContent = msg ? String(msg) : "";
    box.style.display = msg ? "block" : "none";
  }

  function ensureBackupButton() {
    if ($("btnBackupDB")) return;

    const container =
      $("controls") ||
      document.querySelector(".controls") ||
      document.querySelector("#main") ||
      document.body;

    const btn = document.createElement("button");
    btn.id = "btnBackupDB";
    btn.type = "button";
    btn.textContent = "Backup DB (Download)";
    btn.style.width = "100%";
    btn.style.padding = "12px";
    btn.style.fontSize = "16px";
    btn.style.margin = "8px 0";

    container.appendChild(btn);
  }

  function downloadDB() {
    showError("");
    // Open download in same tab (some mobile browsers block popups)
    window.location.href = "/api/db/export";
  }

  window.addEventListener("load", () => {
    ensureBackupButton();

    const btn = $("btnBackupDB");
    if (btn && !btn.__ptBoundBackup) {
      btn.__ptBoundBackup = true;
      btn.addEventListener("click", downloadDB);
    }
  });
})();

// ===========================
// ProTracker UI Add-ons (Archive + Line Movers + Backup DB)
// Append-only block. Paste at very bottom of public/app.js
// ===========================

(function () {
  "use strict";

  const el2 = (id) => document.getElementById(id);

  function showErr2(msg) {
    const box = el2("errorBox");
    if (!box) return;
    box.textContent = String(msg || "");
    box.style.display = msg ? "block" : "none";
  }

  function ensureSection(titleText) {
    const main =
      document.querySelector("main") ||
      document.getElementById("main") ||
      document.body;

    const section = document.createElement("section");
    section.style.padding = "12px";
    section.style.border = "1px solid #ddd";
    section.style.borderRadius = "10px";
    section.style.margin = "12px 0";

    const h = document.createElement("h3");
    h.textContent = titleText;
    h.style.margin = "0 0 8px 0";

    section.appendChild(h);
    main.appendChild(section);
    return section;
  }

  async function apiPost2(url, bodyObj) {
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

  async function apiGet2(url) {
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

  function getSelectedDate2() {
    const d = el2("dateInput");
    return d && d.value ? String(d.value) : "";
  }

  // ---------------------------
  // ARCHIVE BUTTON + VIEWER
  // ---------------------------
  function mountArchiveUI() {
    if (el2("btnArchiveProps2")) return;

    const section = ensureSection("Archive");

    const btnRow = document.createElement("div");
    btnRow.style.display = "flex";
    btnRow.style.gap = "8px";

    const btnArchive = document.createElement("button");
    btnArchive.id = "btnArchiveProps2";
    btnArchive.type = "button";
    btnArchive.textContent = "Archive Props For Date";
    btnArchive.style.flex = "1";
    btnArchive.style.padding = "12px";
    btnArchive.style.fontSize = "16px";

    const btnLoad = document.createElement("button");
    btnLoad.id = "btnLoadArchive2";
    btnLoad.type = "button";
    btnLoad.textContent = "Load Archive For Date";
    btnLoad.style.flex = "1";
    btnLoad.style.padding = "12px";
    btnLoad.style.fontSize = "16px";

    btnRow.appendChild(btnArchive);
    btnRow.appendChild(btnLoad);

    const pre = document.createElement("pre");
    pre.id = "archiveOut2";
    pre.style.whiteSpace = "pre-wrap";
    pre.style.marginTop = "10px";
    pre.style.padding = "10px";
    pre.style.background = "#f7f7f7";
    pre.style.borderRadius = "10px";
    pre.textContent = "No archive loaded yet.";

    section.appendChild(btnRow);
    section.appendChild(pre);

    btnArchive.addEventListener("click", async () => {
      showErr2("");
      const date = getSelectedDate2();
      if (!date) return showErr2("Pick a date first, then archive.");

      pre.textContent = "Archiving…";
      try {
        const data = await apiPost2("/api/props/archive-date", { date });
        pre.textContent =
          `Archived ${data.date}\n` +
          `ArchivedAt: ${data.archivedAt}\n` +
          `Counts: sgo=${data.counts.sgo} hardrock=${data.counts.hardrock}\n\n` +
          `Tip: Now load archive or line movers.`;
      } catch (e) {
        pre.textContent = "";
        showErr2(e.message);
      }
    });

    btnLoad.addEventListener("click", async () => {
      showErr2("");
      const date = getSelectedDate2();
      if (!date) return showErr2("Pick a date first, then load archive.");

      pre.textContent = "Loading archive…";
      try {
        const data = await apiGet2(`/api/props/archive?date=${encodeURIComponent(date)}`);
        if (!data.exists) {
          pre.textContent = `No archive exists for ${date}.`;
          return;
        }
        const a = data.archive || {};
        const sgo = Array.isArray(a.sgo) ? a.sgo : [];
        const hr = Array.isArray(a.hardrock) ? a.hardrock : [];
        pre.textContent =
          `Archived Date: ${date}\n` +
          `ArchivedAt: ${a.ts || "?"}\n` +
          `SGO: ${sgo.length} | Hardrock: ${hr.length}\n\n` +
          `First 20 SGO:\n` + sgo.slice(0, 20).map(p => `${p.playerName || p.playerId || "?"} ${p.statType} ${p.line}`).join("\n") +
          `\n\nFirst 20 Hardrock:\n` + hr.slice(0, 20).map(p => `${p.playerName || p.playerId || "?"} ${p.statType} ${p.line}`).join("\n");
      } catch (e) {
        pre.textContent = "";
        showErr2(e.message);
      }
    });
  }

  // ---------------------------
  // LINE MOVERS VIEWER
  // ---------------------------
  function mountLineMoversUI() {
    if (el2("btnLoadLineMovers2")) return;

    const section = ensureSection("Line Movers");

    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.gap = "8px";
    row.style.marginBottom = "8px";

    const src = document.createElement("select");
    src.id = "lineMoversSource2";
    src.style.flex = "1";
    src.style.padding = "10px";
    src.style.fontSize = "16px";
    src.innerHTML = `
      <option value="all">All Sources</option>
      <option value="sgo">SGO Only</option>
      <option value="hardrock">Hardrock Only</option>
    `;

    const lim = document.createElement("input");
    lim.id = "lineMoversLimit2";
    lim.type = "number";
    lim.inputMode = "numeric";
    lim.value = "50";
    lim.style.width = "110px";
    lim.style.padding = "10px";
    lim.style.fontSize = "16px";

    row.appendChild(src);
    row.appendChild(lim);

    const btn = document.createElement("button");
    btn.id = "btnLoadLineMovers2";
    btn.type = "button";
    btn.textContent = "Load Line Movers";
    btn.style.width = "100%";
    btn.style.padding = "12px";
    btn.style.fontSize = "16px";

    const pre = document.createElement("pre");
    pre.id = "lineMoversOut2";
    pre.style.whiteSpace = "pre-wrap";
    pre.style.marginTop = "10px";
    pre.style.padding = "10px";
    pre.style.background = "#f7f7f7";
    pre.style.borderRadius = "10px";
    pre.textContent = "No line movers loaded yet.";

    section.appendChild(row);
    section.appendChild(btn);
    section.appendChild(pre);

    btn.addEventListener("click", async () => {
      showErr2("");
      const date = getSelectedDate2();
      if (!date) return showErr2("Pick a date first, then load line movers.");

      const source = src.value || "all";
      const limit = lim.value || "50";

      pre.textContent = "Loading line movers…";
      try {
        const data = await apiGet2(`/api/props/line-moves?date=${encodeURIComponent(date)}&source=${encodeURIComponent(source)}&limit=${encodeURIComponent(limit)}`);
        if (!data.exists) {
          pre.textContent = `No archive exists for ${date}.\nArchive first, then line movers will work.`;
          return;
        }
        const moves = Array.isArray(data.moves) ? data.moves : [];
        const lines = [];
        lines.push(`Date: ${data.date} | Source: ${data.source} | ArchivedAt: ${data.archivedAt || "?"}`);
        lines.push(`Moves found: ${data.counts.moves}`);
        lines.push("");
        if (!moves.length) lines.push("(No moves yet — change current lines vs archived lines.)");
        else {
          for (const m of moves) {
            const d = (m.delta >= 0) ? `+${m.delta}` : `${m.delta}`;
            lines.push(`${m.playerName || m.playerId || "?"} ${m.statType} | open ${m.openLine} → now ${m.curLine} | move ${d} | ${m.source}`);
          }
        }
        pre.textContent = lines.join("\n");
      } catch (e) {
        pre.textContent = "";
        showErr2(e.message);
      }
    });
  }

  // ---------------------------
  // BACKUP DB BUTTON
  // ---------------------------
  function mountBackupUI() {
    if (el2("btnBackupDB2")) return;

    const section = ensureSection("Backup");

    const btn = document.createElement("button");
    btn.id = "btnBackupDB2";
    btn.type = "button";
    btn.textContent = "Backup DB (Download)";
    btn.style.width = "100%";
    btn.style.padding = "12px";
    btn.style.fontSize = "16px";

    section.appendChild(btn);

    btn.addEventListener("click", () => {
      showErr2("");
      // Works on Render and locally because it's a relative URL
      window.location.href = "/api/db/export";
    });
  }

  // Mount when the page is ready
  window.addEventListener("load", () => {
    try {
      mountArchiveUI();
      mountLineMoversUI();
      mountBackupUI();
    } catch (e) {
      showErr2(e.message || String(e));
    }
  });
})();

// ===========================
// UI PACK: Archive + Line Movers + Backup (Render-safe)
// Append-only. Paste at bottom of public/app.js
// ===========================

(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);

  function showErr(msg) {
    const box = $("errorBox");
    if (!box) return;
    box.textContent = msg ? String(msg) : "";
    box.style.display = msg ? "block" : "none";
  }

  async function getJSON(url) {
    const res = await fetch(url, { headers: { "Accept": "application/json" } });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) throw new Error((data && data.error) ? data.error : text || res.statusText);
    return data;
  }

  async function postJSON(url, body) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body || {})
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) throw new Error((data && data.error) ? data.error : text || res.statusText);
    return data;
  }

  function dateVal() {
    const d = $("dateInput");
    return d && d.value ? String(d.value) : "";
  }

  function mountSection(title) {
    const main = document.querySelector("main") || document.body;

    const section = document.createElement("section");
    section.style.padding = "12px";
    section.style.border = "1px solid #ddd";
    section.style.borderRadius = "10px";
    section.style.margin = "12px 0";

    const h = document.createElement("h3");
    h.textContent = title;
    h.style.margin = "0 0 8px 0";

    section.appendChild(h);
    main.appendChild(section);
    return section;
  }

  function mountArchive() {
    if ($("ptArchiveOut")) return;
    const sec = mountSection("Archive");

    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.gap = "8px";

    const btnA = document.createElement("button");
    btnA.type = "button";
    btnA.textContent = "Archive Props For Date";
    btnA.style.flex = "1";
    btnA.style.padding = "12px";
    btnA.style.fontSize = "16px";

    const btnL = document.createElement("button");
    btnL.type = "button";
    btnL.textContent = "Load Archive For Date";
    btnL.style.flex = "1";
    btnL.style.padding = "12px";
    btnL.style.fontSize = "16px";

    row.appendChild(btnA);
    row.appendChild(btnL);

    const pre = document.createElement("pre");
    pre.id = "ptArchiveOut";
    pre.style.whiteSpace = "pre-wrap";
    pre.style.marginTop = "10px";
    pre.style.padding = "10px";
    pre.style.background = "#f7f7f7";
    pre.style.borderRadius = "10px";
    pre.textContent = "No archive loaded yet.";

    sec.appendChild(row);
    sec.appendChild(pre);

    btnA.addEventListener("click", async () => {
      showErr("");
      const date = dateVal();
      if (!date) return showErr("Pick a date first.");
      pre.textContent = "Archiving…";
      try {
        const data = await postJSON("/api/props/archive-date", { date });
        pre.textContent = `Archived ${data.date}\nArchivedAt: ${data.archivedAt}\nCounts: sgo=${data.counts.sgo} hardrock=${data.counts.hardrock}`;
      } catch (e) {
        pre.textContent = "";
        showErr(e.message || String(e));
      }
    });

    btnL.addEventListener("click", async () => {
      showErr("");
      const date = dateVal();
      if (!date) return showErr("Pick a date first.");
      pre.textContent = "Loading…";
      try {
        const data = await getJSON(`/api/props/archive?date=${encodeURIComponent(date)}`);
        if (!data.exists) { pre.textContent = `No archive exists for ${date}.`; return; }
        const a = data.archive || {};
        const sgo = Array.isArray(a.sgo) ? a.sgo : [];
        const hr  = Array.isArray(a.hardrock) ? a.hardrock : [];
        pre.textContent =
          `Archived Date: ${date}\nArchivedAt: ${a.ts || "?"}\nSGO: ${sgo.length} | Hardrock: ${hr.length}\n\n` +
          `First 10 SGO:\n${sgo.slice(0,10).map(p=>`${p.playerName||p.playerId||"?"} ${p.statType} ${p.line}`).join("\n")}\n\n` +
          `First 10 Hardrock:\n${hr.slice(0,10).map(p=>`${p.playerName||p.playerId||"?"} ${p.statType} ${p.line}`).join("\n")}`;
      } catch (e) {
        pre.textContent = "";
        showErr(e.message || String(e));
      }
    });
  }

  function mountLineMovers() {
    if ($("ptLineMovesOut")) return;
    const sec = mountSection("Line Movers");

    const row = document.createElement("div");
    row.style.display = "flex";
    row.style.gap = "8px";
    row.style.marginBottom = "8px";

    const src = document.createElement("select");
    src.style.flex = "1";
    src.style.padding = "10px";
    src.style.fontSize = "16px";
    src.innerHTML = `<option value="all">All</option><option value="sgo">SGO</option><option value="hardrock">Hardrock</option>`;

    const lim = document.createElement("input");
    lim.type = "number";
    lim.inputMode = "numeric";
    lim.value = "50";
    lim.style.width = "110px";
    lim.style.padding = "10px";
    lim.style.fontSize = "16px";

    row.appendChild(src);
    row.appendChild(lim);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Load Line Movers";
    btn.style.width = "100%";
    btn.style.padding = "12px";
    btn.style.fontSize = "16px";

    const pre = document.createElement("pre");
    pre.id = "ptLineMovesOut";
    pre.style.whiteSpace = "pre-wrap";
    pre.style.marginTop = "10px";
    pre.style.padding = "10px";
    pre.style.background = "#f7f7f7";
    pre.style.borderRadius = "10px";
    pre.textContent = "No line movers loaded yet.";

    sec.appendChild(row);
    sec.appendChild(btn);
    sec.appendChild(pre);

    btn.addEventListener("click", async () => {
      showErr("");
      const date = dateVal();
      if (!date) return showErr("Pick a date first.");
      pre.textContent = "Loading…";
      try {
        const data = await getJSON(`/api/props/line-moves?date=${encodeURIComponent(date)}&source=${encodeURIComponent(src.value)}&limit=${encodeURIComponent(lim.value || 50)}`);
        if (!data.exists) { pre.textContent = `No archive exists for ${date}. Archive first.`; return; }
        const moves = Array.isArray(data.moves) ? data.moves : [];
        const lines = [];
        lines.push(`Date: ${data.date} | Source: ${data.source} | Moves: ${data.counts.moves}`);
        lines.push("");
        if (!moves.length) lines.push("(No moves yet)");
        else for (const m of moves) {
          const d = (m.delta >= 0) ? `+${m.delta}` : `${m.delta}`;
          lines.push(`${m.playerName || m.playerId || "?"} ${m.statType} | ${m.openLine} → ${m.curLine} (${d}) | ${m.source}`);
        }
        pre.textContent = lines.join("\n");
      } catch (e) {
        pre.textContent = "";
        showErr(e.message || String(e));
      }
    });
  }

  function mountBackup() {
    if ($("ptBackupBtn")) return;
    const sec = mountSection("Backup");

    const btn = document.createElement("button");
    btn.id = "ptBackupBtn";
    btn.type = "button";
    btn.textContent = "Backup DB (Download)";
    btn.style.width = "100%";
    btn.style.padding = "12px";
    btn.style.fontSize = "16px";

    sec.appendChild(btn);
    btn.addEventListener("click", () => { showErr(""); window.location.href = "/api/db/export"; });
  }

  window.addEventListener("load", () => {
    mountArchive();
    mountLineMovers();
    mountBackup();
  });
})();

