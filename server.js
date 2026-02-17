"use strict";

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const express = require("express");

const app = express();

// ---------------------------
// Config
// ---------------------------
const PORT = Number(process.env.PORT) || 3000;
const HOST = "0.0.0.0";

const DB_PATH = path.join(__dirname, "db.json");

// In-memory cache (leaders)
const cache = {
  leaders: {
    ts: null,
    data: null
  }
};

// ---------------------------
// Middleware
// ---------------------------
app.use(express.json({ limit: "1mb" }));

// Serve static UI
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

// ---------------------------
// DB Helpers (safe write)
// ---------------------------
function defaultDB() {
  return {
    nbaPlayerGameLogs: [],
    sgoPropLines: [],
    hardrockPropLines: [],
    propsArchive: {},
    meta: {
      createdAt: new Date().toISOString(),
      version: 1
    }
  };
}

async function ensureDBExists() {
  try {
    await fsp.access(DB_PATH, fs.constants.F_OK);
  } catch {
    const initial = defaultDB();
    await writeDB(initial);
  }
}

async function readDB() {
  await ensureDBExists();
  const raw = await fsp.readFile(DB_PATH, "utf8");
  let db;
  try {
    db = JSON.parse(raw);
  } catch {
    const backupPath = DB_PATH + ".corrupt." + Date.now();
    await fsp.writeFile(backupPath, raw, "utf8");
    db = defaultDB();
    await writeDB(db);
  }

  db.nbaPlayerGameLogs = Array.isArray(db.nbaPlayerGameLogs) ? db.nbaPlayerGameLogs : [];
  db.sgoPropLines = Array.isArray(db.sgoPropLines) ? db.sgoPropLines : [];
  db.hardrockPropLines = Array.isArray(db.hardrockPropLines) ? db.hardrockPropLines : [];
  db.propsArchive = db.propsArchive && typeof db.propsArchive === "object" ? db.propsArchive : {};
  db.meta = db.meta && typeof db.meta === "object" ? db.meta : { createdAt: new Date().toISOString(), version: 1 };

  return db;
}

async function writeDB(dbObj) {
  const tmpPath = DB_PATH + ".tmp";
  const data = JSON.stringify(dbObj, null, 2);
  await fsp.writeFile(tmpPath, data, "utf8");
  await fsp.rename(tmpPath, DB_PATH);
}

// ---------------------------
// Date helpers (ET-aware via Intl)
// ---------------------------
function getTodayET() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return fmt.format(new Date());
}

function isValidISODate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function compareISODate(a, b) {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function uniqSortedDates(arr) {
  const set = new Set(arr.filter(isValidISODate));
  return Array.from(set).sort(compareISODate);
}

// ---------------------------
// Base URL builder (no hardcoding)
// ---------------------------
function getBaseUrl(req) {
  const protoHeader = req.headers["x-forwarded-proto"];
  const protocol = (protoHeader ? String(protoHeader).split(",")[0].trim() : req.protocol) || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${protocol}://${host}`;
}

// ---------------------------
// Route registry endpoint helper
// ---------------------------
function listRoutes(appInstance) {
  const routes = [];
  const stack = appInstance && appInstance._router && appInstance._router.stack ? appInstance._router.stack : [];
  for (const layer of stack) {
    if (layer.route && layer.route.path) {
      const methods = Object.keys(layer.route.methods || {}).filter((m) => layer.route.methods[m]);
      for (const m of methods) {
        routes.push({ method: m.toUpperCase(), path: layer.route.path });
      }
    }
  }
  routes.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)));
  return routes;
}

// ---------------------------
// Domain logic
// ---------------------------
function extractPropDate(prop) {
  return prop.date || prop.slateDate || prop.gameDate || prop.eventDate || prop.day || null;
}

function extractPropLine(prop) {
  const candidates = [prop.line, prop.value, prop.points, prop.total, prop.threshold, prop.number];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function extractPropKey(prop) {
  const playerId = prop.playerId || prop.player_id || prop.pid || null;
  const playerName = prop.playerName || prop.player_name || prop.name || "";
  const statType = prop.statType || prop.market || prop.propType || prop.category || prop.stat || "";
  const team = prop.team || prop.teamAbbr || prop.team_abbr || "";
  return {
    playerId: playerId ? String(playerId) : null,
    playerName: String(playerName || "").trim(),
    statType: String(statType || "").trim(),
    team: String(team || "").trim()
  };
}

function normalizeStatType(statType) {
  const s = String(statType || "").toLowerCase();
  if (s.includes("point") || s === "pts") return "PTS";
  if (s.includes("rebound") || s === "reb") return "REB";
  if (s.includes("assist") || s === "ast") return "AST";
  if (s.includes("3") && (s.includes("made") || s.includes("pm") || s.includes("three"))) return "3PM";
  if (s === "3pm") return "3PM";
  if (["PTS", "REB", "AST", "3PM"].includes(statType)) return statType;
  return null;
}

function getStatFromLog(log, stat) {
  const map = {
    PTS: ["pts", "points", "PTS"],
    REB: ["reb", "rebounds", "REB", "trb", "totalRebounds"],
    AST: ["ast", "assists", "AST"],
    "3PM": ["fg3m", "3pm", "threesMade", "threePointersMade", "FG3M"]
  };
  const keys = map[stat] || [];
  for (const k of keys) {
    const n = Number(log[k]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function getPlayerIdFromLog(log) {
  return log.playerId || log.player_id || log.pid || null;
}
function getPlayerNameFromLog(log) {
  return log.playerName || log.player_name || log.name || log.player || "";
}

function computeLeadersFromLogs(logs) {
  const byPlayer = new Map();

  for (const lg of logs) {
    const pidRaw = getPlayerIdFromLog(lg);
    const pid = pidRaw ? String(pidRaw) : null;
    const pname = String(getPlayerNameFromLog(lg) || "").trim();
    if (!pid && !pname) continue;

    const key = pid ? `id:${pid}` : `name:${pname.toLowerCase()}`;
    let obj = byPlayer.get(key);
    if (!obj) {
      obj = { playerId: pid, playerName: pname, gp: 0, sums: { PTS: 0, REB: 0, AST: 0, "3PM": 0 } };
      byPlayer.set(key, obj);
    }

    const pts = getStatFromLog(lg, "PTS");
    const reb = getStatFromLog(lg, "REB");
    const ast = getStatFromLog(lg, "AST");
    const tpm = getStatFromLog(lg, "3PM");

    const hasAny = [pts, reb, ast, tpm].some((v) => Number.isFinite(v));
    if (!hasAny) continue;

    obj.gp += 1;
    obj.sums.PTS += Number.isFinite(pts) ? pts : 0;
    obj.sums.REB += Number.isFinite(reb) ? reb : 0;
    obj.sums.AST += Number.isFinite(ast) ? ast : 0;
    obj.sums["3PM"] += Number.isFinite(tpm) ? tpm : 0;

    if (!obj.playerName && pname) obj.playerName = pname;
  }

  const players = Array.from(byPlayer.values())
    .filter((p) => p.gp > 0)
    .map((p) => ({
      playerId: p.playerId,
      playerName: p.playerName,
      gp: p.gp,
      avg: {
        PTS: p.sums.PTS / p.gp,
        REB: p.sums.REB / p.gp,
        AST: p.sums.AST / p.gp,
        "3PM": p.sums["3PM"] / p.gp
      }
    }));

  function top25(stat) {
    return players
      .map((p) => ({
        playerId: p.playerId,
        playerName: p.playerName,
        gp: p.gp,
        perGame: Number(p.avg[stat].toFixed(2))
      }))
      .sort((a, b) => b.perGame - a.perGame)
      .slice(0, 25);
  }

  return {
    generatedAt: new Date().toISOString(),
    points: top25("PTS"),
    rebounds: top25("REB"),
    assists: top25("AST"),
    threes: top25("3PM")
  };
}

function rollingProjection(logs, playerKey, stat, gamesN) {
  const statNorm = normalizeStatType(stat);
  if (!statNorm) return null;

  const filtered = logs.filter((lg) => {
    const pid = getPlayerIdFromLog(lg);
    const pname = String(getPlayerNameFromLog(lg) || "").trim();
    if (playerKey.playerId && pid && String(pid) === String(playerKey.playerId)) return true;
    if (!playerKey.playerId && playerKey.playerName && pname) return pname.toLowerCase() === playerKey.playerName.toLowerCase();
    return false;
  });

  filtered.sort((a, b) => {
    const da = a.gameDate || a.date || a.gamedate || a.day || "";
    const db = b.gameDate || b.date || b.gamedate || b.day || "";
    if (isValidISODate(da) && isValidISODate(db)) return compareISODate(db, da);
    return 0;
  });

  const vals = [];
  for (const lg of filtered) {
    const v = getStatFromLog(lg, statNorm);
    if (Number.isFinite(v)) vals.push(v);
    if (vals.length >= gamesN) break;
  }

  if (vals.length === 0) return null;
  const avg = vals.reduce((s, x) => s + x, 0) / vals.length;
  return { stat: statNorm, gamesUsed: vals.length, projection: avg };
}

function tierForAbsEdge(absEdge) {
  if (absEdge >= 3) return "A";
  if (absEdge >= 1.5) return "B";
  return "C";
}

// ---------------------------
// API Endpoints
// ---------------------------
app.get("/api/health", (req, res) => res.json({ ok: true }));

app.get("/api/pt/quick-links", (req, res) => {
  const todayET = getTodayET();
  const activeDate = todayET;
  const base = getBaseUrl(req);

  res.json({
    activeDate,
    todayET,
    links: {
      health: `${base}/api/health`,
      routes: `${base}/api/pt/routes`,
      dates: `${base}/api/props/dates`,
      activeDate: `${base}/api/props/active-date`,
      sgoPropsForDate: `${base}/api/odds/sgo/props-for-date?date=${todayET}&limit=50`,
      status: `${base}/api/nba/stats/status`,
      leaders: `${base}/api/nba/stats/leaders`,
      warmLeaders: `${base}/api/nba/stats/warm`,
      edgesTiered: `${base}/api/nba/edges-today-tiered`
    }
  });
});

app.get("/api/pt/routes", (req, res) => res.json({ routes: listRoutes(app) }));

app.get("/api/props/dates", async (req, res) => {
  try {
    const db = await readDB();
    const dates = [
      ...db.sgoPropLines.map(extractPropDate),
      ...db.hardrockPropLines.map(extractPropDate),
      ...Object.keys(db.propsArchive || {})
    ].filter(isValidISODate);

    res.json({ dates: uniqSortedDates(dates) });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.get("/api/props/active-date", async (req, res) => {
  try {
    const todayET = getTodayET();
    const db = await readDB();

    const dates = [
      ...db.sgoPropLines.map(extractPropDate),
      ...db.hardrockPropLines.map(extractPropDate),
      ...Object.keys(db.propsArchive || {})
    ].filter(isValidISODate);

    const unique = uniqSortedDates(dates);

    let activeDate = todayET;
    if (unique.length > 0) {
      const upcoming = unique.filter((d) => d >= todayET);
      activeDate = upcoming.length ? upcoming[0] : unique[unique.length - 1];
    }

    res.json({ todayET, activeDate, availableDates: unique });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.get("/api/odds/sgo/props-for-date", async (req, res) => {
  try {
    const date = String(req.query.date || "");
    const limit = Math.max(1, Math.min(500, Number(req.query.limit || 50)));

    if (!isValidISODate(date)) return res.status(400).json({ ok: false, error: "Missing/invalid date. Use YYYY-MM-DD." });

    const db = await readDB();
    const items = db.sgoPropLines.filter((p) => extractPropDate(p) === date).slice(0, limit);

    res.json({ ok: true, date, limit, count: items.length, props: items });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.get("/api/nba/stats/status", async (req, res) => {
  try {
    const db = await readDB();
    const sampleKeys = (arr) => {
      if (!Array.isArray(arr) || arr.length === 0) return [];
      const obj = arr[0] && typeof arr[0] === "object" ? arr[0] : null;
      return obj ? Object.keys(obj).slice(0, 25) : [];
    };

    res.json({
      ok: true,
      counts: {
        nbaPlayerGameLogs: db.nbaPlayerGameLogs.length,
        sgoPropLines: db.sgoPropLines.length,
        hardrockPropLines: db.hardrockPropLines.length
      },
      sampleKeys: {
        nbaPlayerGameLogs: sampleKeys(db.nbaPlayerGameLogs),
        sgoPropLines: sampleKeys(db.sgoPropLines),
        hardrockPropLines: sampleKeys(db.hardrockPropLines)
      },
      cache: { leaders: { ts: cache.leaders.ts, hasData: !!cache.leaders.data } }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.get("/api/nba/stats/leaders", async (req, res) => {
  try {
    if (cache.leaders.data) return res.json({ ok: true, cached: true, ts: cache.leaders.ts, leaders: cache.leaders.data });
    const db = await readDB();
    const leaders = computeLeadersFromLogs(db.nbaPlayerGameLogs);
    res.json({ ok: true, cached: false, ts: null, leaders });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.post("/api/nba/stats/warm", async (req, res) => {
  try {
    const db = await readDB();
    cache.leaders.data = computeLeadersFromLogs(db.nbaPlayerGameLogs);
    cache.leaders.ts = new Date().toISOString();
    res.json({ ok: true, ts: cache.leaders.ts });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.get("/api/nba/edges-today-tiered", async (req, res) => {
  try {
    const date = String(req.query.date || "");
    const minEdge = Number(req.query.minEdge || 0);
    const gamesN = Math.max(1, Math.min(30, Number(req.query.games || 10)));

    if (date && !isValidISODate(date)) return res.status(400).json({ ok: false, error: "Invalid date. Use YYYY-MM-DD (or omit date)." });

    const db = await readDB();
    const todayET = getTodayET();

    let useDate = date;
    if (!useDate) {
      const dates = uniqSortedDates([
        ...db.sgoPropLines.map(extractPropDate),
        ...db.hardrockPropLines.map(extractPropDate)
      ].filter(isValidISODate));

      if (dates.length === 0) useDate = todayET;
      else {
        const upcoming = dates.filter((d) => d >= todayET);
        useDate = upcoming.length ? upcoming[0] : dates[dates.length - 1];
      }
    }

    const props = [
      ...db.sgoPropLines.filter((p) => extractPropDate(p) === useDate).map((p) => ({ ...p, __source: "sgo" })),
      ...db.hardrockPropLines.filter((p) => extractPropDate(p) === useDate).map((p) => ({ ...p, __source: "hardrock" }))
    ];

    const edges = [];
    for (const p of props) {
      const line = extractPropLine(p);
      if (!Number.isFinite(line)) continue;

      const key = extractPropKey(p);
      const statTypeRaw = p.statType || p.market || p.propType || p.category || p.stat;
      const proj = rollingProjection(db.nbaPlayerGameLogs, key, statTypeRaw, gamesN);
      if (!proj) continue;

      const edge = proj.projection - line;
      const absEdge = Math.abs(edge);
      if (absEdge < minEdge) continue;

      edges.push({
        tier: tierForAbsEdge(absEdge),
        source: p.__source,
        date: useDate,
        playerId: key.playerId,
        playerName: key.playerName || null,
        team: key.team || null,
        stat: proj.stat,
        gamesUsed: proj.gamesUsed,
        projection: Number(proj.projection.toFixed(2)),
        line: Number(line.toFixed(2)),
        edge: Number(edge.toFixed(2)),
        absEdge: Number(absEdge.toFixed(2)),
        rawProp: p
      });
    }

    const tierRank = { A: 1, B: 2, C: 3 };
    edges.sort((a, b) => {
      const ta = tierRank[a.tier] || 9;
      const tb = tierRank[b.tier] || 9;
      if (ta !== tb) return ta - tb;
      return b.absEdge - a.absEdge;
    });

    const tiered = {
      A: edges.filter((e) => e.tier === "A"),
      B: edges.filter((e) => e.tier === "B"),
      C: edges.filter((e) => e.tier === "C")
    };

    res.json({
      ok: true,
      todayET,
      date: useDate,
      minEdge,
      gamesN,
      counts: { total: edges.length, A: tiered.A.length, B: tiered.B.length, C: tiered.C.length },
      tiered
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// Root
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// Start (single listen)
// ===========================
// APPEND-ONLY ZONE: HELPERS
// Add new helper functions BELOW this line.
// Do not edit above unless necessary.
// ===========================


// ===========================
// APPEND-ONLY ZONE: ROUTES
// Add new API endpoints BELOW this line.
// Keep each endpoint self-contained.
// ===========================
app.listen(PORT, HOST, () => console.log(`ProTracker v1 listening on http://${HOST}:${PORT}`));
app.post("/api/import/nba-game-logs", async (req, res) => {
  try {
    const rows = Array.isArray(req.body) ? req.body : [];
    if (rows.length === 0) {
      return res.status(400).json({ ok: false, error: "Body must be an array of game logs" });
    }

    const db = await readDB();

    // Dedup key: playerId + gameDate
    const seen = new Set(
      db.nbaPlayerGameLogs.map((g) => `${String(g.playerId || "")}__${String(g.gameDate || "")}`)
    );

    let added = 0;
    const kept = [];

    for (const r of rows) {
      if (!r || typeof r !== "object") continue;

      const playerId = r.playerId ?? r.player_id ?? r.pid ?? null;
      const playerName = r.playerName ?? r.player_name ?? r.name ?? "";
      const gameDate = r.gameDate ?? r.date ?? r.gamedate ?? null;

      if (!playerId || !gameDate) continue;

      const key = `${String(playerId)}__${String(gameDate)}`;
      if (seen.has(key)) continue;

      const row = {
        playerId: String(playerId),
        playerName: String(playerName || "").trim(),
        gameDate: String(gameDate),
        pts: Number.isFinite(Number(r.pts)) ? Number(r.pts) : undefined,
        reb: Number.isFinite(Number(r.reb)) ? Number(r.reb) : undefined,
        ast: Number.isFinite(Number(r.ast)) ? Number(r.ast) : undefined,
        fg3m: Number.isFinite(Number(r.fg3m)) ? Number(r.fg3m) : undefined
      };

      db.nbaPlayerGameLogs.push(row);
      seen.add(key);
      kept.push(row);
      added++;
    }

    await writeDB(db);

    res.json({
      ok: true,
      received: rows.length,
      added,
      total: db.nbaPlayerGameLogs.length,
      sampleAdded: kept.slice(0, 3)
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.post("/api/import/sgo-props", async (req, res) => {
  try {
    const rows = Array.isArray(req.body) ? req.body : [];
    if (rows.length === 0) {
      return res.status(400).json({ ok: false, error: "Body must be an array of prop rows" });
    }

    const db = await readDB();

    // Dedupe key: date + playerId(or name) + statType + line
    const seen = new Set(
      db.sgoPropLines.map((p) => {
        const date = String(p.date || p.slateDate || "");
        const pid = String(p.playerId || p.player_id || "");
        const name = String(p.playerName || p.player_name || p.name || "").toLowerCase();
        const stat = String(p.statType || p.market || p.propType || p.stat || "").toLowerCase();
        const line = Number(p.line ?? p.value ?? p.total ?? p.threshold ?? p.number);
        return `${date}__${pid || name}__${stat}__${Number.isFinite(line) ? line : ""}`;
      })
    );

    let added = 0;
    const sample = [];

    for (const r of rows) {
      if (!r || typeof r !== "object") continue;

      const date = r.date ?? r.slateDate ?? r.gameDate ?? null;
      const playerId = r.playerId ?? r.player_id ?? r.pid ?? null;
      const playerName = r.playerName ?? r.player_name ?? r.name ?? "";
      const statType = r.statType ?? r.market ?? r.propType ?? r.stat ?? r.category ?? "";
      const team = r.team ?? r.teamAbbr ?? r.team_abbr ?? "";
      const lineRaw = r.line ?? r.value ?? r.total ?? r.threshold ?? r.number ?? null;

      if (!date) continue;

      const line = Number(lineRaw);
      const key = `${String(date)}__${playerId ? String(playerId) : String(playerName || "").toLowerCase()}__${String(statType || "").toLowerCase()}__${Number.isFinite(line) ? line : ""}`;
      if (seen.has(key)) continue;

      const row = {
        date: String(date),
        playerId: playerId ? String(playerId) : undefined,
        playerName: String(playerName || "").trim() || undefined,
        statType: String(statType || "").trim() || undefined,
        team: String(team || "").trim() || undefined,
        line: Number.isFinite(line) ? line : undefined,
        source: "sgo"
      };

      db.sgoPropLines.push(row);
      seen.add(key);
      added++;
      if (sample.length < 3) sample.push(row);
    }

    await writeDB(db);

    res.json({
      ok: true,
      received: rows.length,
      added,
      total: db.sgoPropLines.length,
      sampleAdded: sample
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.post("/api/import/hardrock-props", async (req, res) => {
  try {
    const rows = Array.isArray(req.body) ? req.body : [];
    if (rows.length === 0) {
      return res.status(400).json({ ok: false, error: "Body must be an array of prop rows" });
    }

    const db = await readDB();

    const seen = new Set(
      db.hardrockPropLines.map((p) => {
        const date = String(p.date || p.slateDate || "");
        const pid = String(p.playerId || p.player_id || "");
        const name = String(p.playerName || p.player_name || p.name || "").toLowerCase();
        const stat = String(p.statType || p.market || p.propType || p.stat || "").toLowerCase();
        const line = Number(p.line ?? p.value ?? p.total ?? p.threshold ?? p.number);
        return `${date}__${pid || name}__${stat}__${Number.isFinite(line) ? line : ""}`;
      })
    );

    let added = 0;
    const sample = [];

    for (const r of rows) {
      if (!r || typeof r !== "object") continue;

      const date = r.date ?? r.slateDate ?? r.gameDate ?? null;
      const playerId = r.playerId ?? r.player_id ?? r.pid ?? null;
      const playerName = r.playerName ?? r.player_name ?? r.name ?? "";
      const statType = r.statType ?? r.market ?? r.propType ?? r.stat ?? r.category ?? "";
      const team = r.team ?? r.teamAbbr ?? r.team_abbr ?? "";
      const lineRaw = r.line ?? r.value ?? r.total ?? r.threshold ?? r.number ?? null;

      if (!date) continue;

      const line = Number(lineRaw);
      const key = `${String(date)}__${playerId ? String(playerId) : String(playerName || "").toLowerCase()}__${String(statType || "").toLowerCase()}__${Number.isFinite(line) ? line : ""}`;
      if (seen.has(key)) continue;

      const row = {
        date: String(date),
        playerId: playerId ? String(playerId) : undefined,
        playerName: String(playerName || "").trim() || undefined,
        statType: String(statType || "").trim() || undefined,
        team: String(team || "").trim() || undefined,
        line: Number.isFinite(line) ? line : undefined,
        source: "hardrock"
      };

      db.hardrockPropLines.push(row);
      seen.add(key);
      added++;
      if (sample.length < 3) sample.push(row);
    }

    await writeDB(db);

    res.json({
      ok: true,
      received: rows.length,
      added,
      total: db.hardrockPropLines.length,
      sampleAdded: sample
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.post("/api/props/archive-date", async (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const date = String(body.date || "");

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ ok: false, error: "Missing/invalid date. Use {\"date\":\"YYYY-MM-DD\"}" });
    }

    const db = await readDB();

    const sgo = db.sgoPropLines.filter((p) => String(p.date || p.slateDate || "") === date);
    const hardrock = db.hardrockPropLines.filter((p) => String(p.date || p.slateDate || "") === date);

    if (!db.propsArchive || typeof db.propsArchive !== "object") db.propsArchive = {};

    db.propsArchive[date] = {
      ts: new Date().toISOString(),
      sgoCount: sgo.length,
      hardrockCount: hardrock.length,
      sgo,
      hardrock
    };

    await writeDB(db);

    res.json({
      ok: true,
      date,
      archivedAt: db.propsArchive[date].ts,
      counts: { sgo: sgo.length, hardrock: hardrock.length }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.get("/api/props/archive", async (req, res) => {
  try {
    const date = String(req.query.date || "");

    if (!date) {
      return res.status(400).json({
        ok: false,
        error: "Missing date. Use /api/props/archive?date=YYYY-MM-DD"
      });
    }

    const db = await readDB();

    if (!db.propsArchive || !db.propsArchive[date]) {
      return res.json({
        ok: true,
        date,
        exists: false,
        archive: null
      });
    }

    res.json({
      ok: true,
      date,
      exists: true,
      archive: db.propsArchive[date]
    });

  } catch (err) {
    res.status(500).json({
      ok: false,
      error: String(err?.message || err)
    });
  }
});

app.get("/api/nba/projections", async (req, res) => {
  try {
    const gamesN = Math.max(1, Number(req.query.games || 10));

    const db = await readDB();
    const logs = Array.isArray(db.nbaPlayerGameLogs)
      ? db.nbaPlayerGameLogs
      : [];

    const byPlayer = new Map();

    for (const g of logs) {
      if (!g.playerId) continue;
      if (!byPlayer.has(g.playerId)) byPlayer.set(g.playerId, []);
      byPlayer.get(g.playerId).push(g);
    }

    const projections = [];

    for (const [playerId, arr] of byPlayer.entries()) {
      arr.sort((a, b) => String(b.gameDate).localeCompare(String(a.gameDate)));

      const slice = arr.slice(0, gamesN);
      if (slice.length === 0) continue;

      let pts = 0, reb = 0, ast = 0, fg3m = 0;

      for (const g of slice) {
        pts += Number(g.pts || 0);
        reb += Number(g.reb || 0);
        ast += Number(g.ast || 0);
        fg3m += Number(g.fg3m || 0);
      }

      const gp = slice.length;

      projections.push({
        playerId,
        playerName: slice[0].playerName,
        gp,
        pts: pts / gp,
        reb: reb / gp,
        ast: ast / gp,
        fg3m: fg3m / gp
      });
    }

    projections.sort((a, b) => b.pts - a.pts);

    res.json({
      ok: true,
      gamesUsed: gamesN,
      count: projections.length,
      projections
    });

  } catch (err) {
    res.status(500).json({
      ok: false,
      error: String(err?.message || err)
    });
  }
});

app.get("/api/nba/projections-weighted", async (req, res) => {
  try {
    const gamesN = Math.max(1, Number(req.query.games || 10));

    const db = await readDB();
    const logs = Array.isArray(db.nbaPlayerGameLogs) ? db.nbaPlayerGameLogs : [];

    const byPlayer = new Map();
    for (const g of logs) {
      if (!g || !g.playerId || !g.gameDate) continue;
      if (!byPlayer.has(g.playerId)) byPlayer.set(g.playerId, []);
      byPlayer.get(g.playerId).push(g);
    }

    // Weight schedule: most recent gets weight = gamesN, next = gamesN-1, ...
    const projections = [];

    for (const [playerId, arr] of byPlayer.entries()) {
      arr.sort((a, b) => String(b.gameDate).localeCompare(String(a.gameDate)));
      const slice = arr.slice(0, gamesN);
      if (slice.length === 0) continue;

      let wSum = 0;
      let pts = 0, reb = 0, ast = 0, fg3m = 0;

      for (let i = 0; i < slice.length; i++) {
        const g = slice[i];
        const w = (gamesN - i); // newest gets biggest weight
        wSum += w;

        pts += w * Number(g.pts || 0);
        reb += w * Number(g.reb || 0);
        ast += w * Number(g.ast || 0);
        fg3m += w * Number(g.fg3m || 0);
      }

      const gp = slice.length;

      projections.push({
        playerId,
        playerName: slice[0].playerName,
        gp,
        gamesRequested: gamesN,
        weightSum: wSum,
        pts: wSum ? pts / wSum : 0,
        reb: wSum ? reb / wSum : 0,
        ast: wSum ? ast / wSum : 0,
        fg3m: wSum ? fg3m / wSum : 0
      });
    }

    projections.sort((a, b) => b.pts - a.pts);

    res.json({
      ok: true,
      gamesUsed: gamesN,
      count: projections.length,
      projections
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.get("/api/nba/edges-tiered-v2", async (req, res) => {
  try {
    // ---------- helpers (local, self-contained) ----------
    const nowETDate = () => {
      // "YYYY-MM-DD" in America/New_York
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).formatToParts(new Date());
      const y = parts.find(p => p.type === "year")?.value;
      const m = parts.find(p => p.type === "month")?.value;
      const d = parts.find(p => p.type === "day")?.value;
      return `${y}-${m}-${d}`;
    };

    const statToField = (statType) => {
      const s = String(statType || "").toLowerCase().trim();
      if (s === "points" || s === "pts") return "pts";
      if (s === "rebounds" || s === "rebs" || s === "reb") return "reb";
      if (s === "assists" || s === "asts" || s === "ast") return "ast";
      if (s === "3pm" || s === "threes" || s === "3s" || s === "fg3m") return "fg3m";
      return null;
    };

    const flatAvg = (arr, field, gamesN) => {
      const slice = arr.slice(0, gamesN);
      if (slice.length === 0) return { gp: 0, value: null };
      let sum = 0;
      for (const g of slice) sum += Number(g[field] || 0);
      return { gp: slice.length, value: sum / slice.length };
    };

    const weightedAvg = (arr, field, gamesN) => {
      const slice = arr.slice(0, gamesN);
      if (slice.length === 0) return { gp: 0, value: null };
      let wSum = 0;
      let sum = 0;
      for (let i = 0; i < slice.length; i++) {
        const w = (gamesN - i); // newest highest weight
        wSum += w;
        sum += w * Number(slice[i][field] || 0);
      }
      return { gp: slice.length, value: wSum ? (sum / wSum) : null };
    };

    // ---------- inputs ----------
    const date = String(req.query.date || "").trim() || nowETDate();
    const gamesN = Math.max(1, Number(req.query.games || 10));
    const minEdge = Math.max(0, Number(req.query.minEdge || 0));
    const mode = String(req.query.mode || "weighted").toLowerCase(); // "weighted" or "flat"

    // ---------- load db ----------
    const db = await readDB();
    const logs = Array.isArray(db.nbaPlayerGameLogs) ? db.nbaPlayerGameLogs : [];
    const sgo = Array.isArray(db.sgoPropLines) ? db.sgoPropLines : [];
    const hr = Array.isArray(db.hardrockPropLines) ? db.hardrockPropLines : [];

    // ---------- group logs by player ----------
    const byPlayer = new Map();
    for (const g of logs) {
      if (!g || !g.playerId || !g.gameDate) continue;
      if (!byPlayer.has(g.playerId)) byPlayer.set(g.playerId, []);
      byPlayer.get(g.playerId).push(g);
    }
    for (const arr of byPlayer.values()) {
      arr.sort((a, b) => String(b.gameDate).localeCompare(String(a.gameDate)));
    }

    // ---------- collect props for date ----------
    const props = [];
    for (const p of sgo) if (String(p.date || "") === date) props.push({ ...p, source: "sgo" });
    for (const p of hr)  if (String(p.date || "") === date) props.push({ ...p, source: "hardrock" });

    // ---------- compute edges ----------
    const tiers = { A: [], B: [], C: [] };

    for (const p of props) {
      const field = statToField(p.statType);
      if (!field) continue;

      const playerId = p.playerId ? String(p.playerId) : null;
      const playerName = String(p.playerName || "").trim();

      const arr = playerId && byPlayer.has(playerId) ? byPlayer.get(playerId) : null;
      if (!arr || arr.length === 0) continue;

      const { gp, value } = (mode === "flat")
        ? flatAvg(arr, field, gamesN)
        : weightedAvg(arr, field, gamesN);

      if (value === null) continue;

      const line = Number(p.line);
      if (!Number.isFinite(line)) continue;

      const edge = value - line;
      const absEdge = Math.abs(edge);

      if (absEdge < minEdge) continue;

      const item = {
        date,
        source: p.source,
        playerId,
        playerName: playerName || arr[0]?.playerName || "Unknown",
        team: p.team || undefined,
        statType: p.statType,
        line,
        proj: Number(value.toFixed(3)),
        edge: Number(edge.toFixed(3)),
        absEdge: Number(absEdge.toFixed(3)),
        gp
      };

      // Tier rules (simple + consistent)
      if (absEdge >= 3) tiers.A.push(item);
      else if (absEdge >= 2) tiers.B.push(item);
      else tiers.C.push(item);
    }

    // sort within tiers (largest edge first)
    for (const k of Object.keys(tiers)) {
      tiers[k].sort((a, b) => b.absEdge - a.absEdge);
    }

    res.json({
      ok: true,
      date,
      mode,
      gamesUsed: gamesN,
      minEdge,
      counts: {
        totalPropsForDate: props.length,
        A: tiers.A.length,
        B: tiers.B.length,
        C: tiers.C.length
      },
      tiers
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.get("/api/db/export", async (req, res) => {
  try {
    const db = await readDB();

    const fileName =
      "protracker-db-" +
      new Date().toISOString().replace(/[:.]/g, "-") +
      ".json";

    res.setHeader("Content-Type", "application/json");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName}"`
    );

    res.send(JSON.stringify(db, null, 2));
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: String(err?.message || err)
    });
  }
});

app.get("/api/props/line-moves", async (req, res) => {
  try {
    const date = String(req.query.date || "").trim();
    const source = String(req.query.source || "all").toLowerCase(); // all|sgo|hardrock
    const limit = Math.max(1, Number(req.query.limit || 50));

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({
        ok: false,
        error: "Missing/invalid date. Use /api/props/line-moves?date=YYYY-MM-DD&source=all|sgo|hardrock&limit=50"
      });
    }

    const db = await readDB();

    const archive = db.propsArchive && db.propsArchive[date] ? db.propsArchive[date] : null;
    if (!archive) {
      return res.json({
        ok: true,
        date,
        exists: false,
        error: "No archive for this date. Run POST /api/props/archive-date first.",
        moves: []
      });
    }

    const normStat = (s) => String(s || "").toLowerCase().trim();
    const normName = (s) => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();

    const keyOf = (p) => {
      const pid = p.playerId ? String(p.playerId) : "";
      const name = normName(p.playerName || p.name || "");
      const stat = normStat(p.statType || p.market || p.propType || p.stat || "");
      // key ignores line so we can compare movements
      return `${pid || name}__${stat}`;
    };

    const toNum = (x) => {
      const n = Number(x);
      return Number.isFinite(n) ? n : null;
    };

    // Current props
    const curSGO = (Array.isArray(db.sgoPropLines) ? db.sgoPropLines : []).filter(p => String(p.date || "") === date);
    const curHR  = (Array.isArray(db.hardrockPropLines) ? db.hardrockPropLines : []).filter(p => String(p.date || "") === date);

    // Archived props (snapshot)
    const arcSGO = Array.isArray(archive.sgo) ? archive.sgo : [];
    const arcHR  = Array.isArray(archive.hardrock) ? archive.hardrock : [];

    const includeSGO = source === "all" || source === "sgo";
    const includeHR  = source === "all" || source === "hardrock";

    const arcMap = new Map();

    if (includeSGO) {
      for (const p of arcSGO) {
        const k = `sgo__${keyOf(p)}`;
        const line = toNum(p.line);
        if (line === null) continue;
        arcMap.set(k, { ...p, source: "sgo", line });
      }
    }
    if (includeHR) {
      for (const p of arcHR) {
        const k = `hardrock__${keyOf(p)}`;
        const line = toNum(p.line);
        if (line === null) continue;
        arcMap.set(k, { ...p, source: "hardrock", line });
      }
    }

    const moves = [];

    function compareCurrent(list, srcTag) {
      for (const p of list) {
        const k = `${srcTag}__${keyOf(p)}`;
        const open = arcMap.get(k);
        if (!open) continue;

        const curLine = toNum(p.line);
        if (curLine === null) continue;

        const delta = curLine - open.line;
        const absDelta = Math.abs(delta);

        // only report actual moves (not unchanged)
        if (absDelta === 0) continue;

        moves.push({
          date,
          source: srcTag,
          playerId: p.playerId ? String(p.playerId) : (open.playerId ? String(open.playerId) : undefined),
          playerName: p.playerName || open.playerName || "Unknown",
          team: p.team || open.team || undefined,
          statType: p.statType || open.statType || undefined,
          openLine: open.line,
          curLine,
          delta,
          absDelta
        });
      }
    }

    if (includeSGO) compareCurrent(curSGO, "sgo");
    if (includeHR) compareCurrent(curHR, "hardrock");

    moves.sort((a, b) => b.absDelta - a.absDelta);

    res.json({
      ok: true,
      date,
      exists: true,
      archivedAt: archive.ts || null,
      source,
      counts: {
        archiveSGO: arcSGO.length,
        archiveHardrock: arcHR.length,
        currentSGO: curSGO.length,
        currentHardrock: curHR.length,
        moves: moves.length
      },
      moves: moves.slice(0, limit)
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

app.post("/api/dev/simulate-line-move", async (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const date = String(body.date || "").trim();
    const source = String(body.source || "sgo").toLowerCase(); // sgo|hardrock
    const statType = String(body.statType || "points").toLowerCase();
    const delta = Number(body.delta ?? 1);

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ ok: false, error: "Invalid date. Use YYYY-MM-DD" });
    }
    if (!["sgo", "hardrock"].includes(source)) {
      return res.status(400).json({ ok: false, error: "Invalid source. Use sgo or hardrock" });
    }
    if (!Number.isFinite(delta) || delta === 0) {
      return res.status(400).json({ ok: false, error: "Invalid delta. Use a number like 0.5 or 1" });
    }

    const db = await readDB();

    const list = source === "sgo"
      ? (Array.isArray(db.sgoPropLines) ? db.sgoPropLines : [])
      : (Array.isArray(db.hardrockPropLines) ? db.hardrockPropLines : []);

    // Find first matching prop for the date + statType with numeric line
    let updated = null;

    for (const p of list) {
      if (String(p.date || "") !== date) continue;
      if (String(p.statType || "").toLowerCase() !== statType) continue;

      const line = Number(p.line);
      if (!Number.isFinite(line)) continue;

      p.line = Number((line + delta).toFixed(3));
      updated = {
        date,
        source,
        playerId: p.playerId || null,
        playerName: p.playerName || null,
        team: p.team || null,
        statType: p.statType,
        oldLine: line,
        newLine: p.line,
        delta
      };
      break;
    }

    if (!updated) {
      return res.status(404).json({
        ok: false,
        error: `No matching prop found to update for date=${date} source=${source} statType=${statType}`
      });
    }

    await writeDB(db);

    res.json({ ok: true, updated });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
});

// ===========================
// ProTracker v1 Add-on Routes (Archive + Export + Line Moves)
// Append-only. Paste at very bottom of server.js
// ===========================


// ===========================
// Render Disk Support: persist db.json on /var/data when available
// Append-only. Paste at bottom of server.js
// ===========================

(function () {
  const path = require("path");
  const fs = require("fs");

  // Prefer Render disk if it exists
  const RENDER_DISK_DIR = "/var/data";
  const diskExists = (() => {
    try {
      return fs.existsSync(RENDER_DISK_DIR) && fs.statSync(RENDER_DISK_DIR).isDirectory();
    } catch {
      return false;
    }
  })();

  // This becomes the DB file path your readDB/writeDB should use
  const DB_FILE_OVERRIDE = diskExists
    ? path.join(RENDER_DISK_DIR, "db.json")
    : path.join(__dirname, "db.json");

  // Expose for debugging/versioning
  app.get("/api/storage", (req, res) => {
    res.json({
      ok: true,
      diskExists,
      dbFile: DB_FILE_OVERRIDE
    });
  });

  // Monkey-patch readDB/writeDB if your server.js uses DB_FILE constant.
  // We safely replace globalThis.__PT_DB_FILE if your code checks it.
  // If your existing readDB/writeDB reads from ./db.json directly,
  // we provide new helpers that server can use going forward.
  globalThis.__PT_DB_FILE = DB_FILE_OVERRIDE;

  // NOTE:
  // If your current readDB/writeDB already uses globalThis.__PT_DB_FILE or a DB_FILE var,
  // you’re done.
  // If not, tell me and I will give you the exact minimal edit block to switch paths.
})();

// ===========================
// BOTTOM-ONLY: Render Disk Sync Shim for db.json
// Goal: persist DB across Render restarts without editing existing readDB/writeDB.
// Strategy:
// - If /var/data exists: keep an authoritative copy at /var/data/db.json
// - On boot: if /var/data/db.json exists and ./db.json is missing or older -> copy disk -> local
// - Else if ./db.json exists and disk missing -> copy local -> disk
// - Provides /api/storage and /api/storage/sync for manual control
// ===========================

(function () {
  const fs = require("fs");
  const fsp = fs.promises;
  const path = require("path");

  const LOCAL_DB = path.join(__dirname, "db.json");
  const DISK_DIR = "/var/data";
  const DISK_DB = path.join(DISK_DIR, "db.json");

  function exists(p) {
    try { fs.accessSync(p); return true; } catch { return false; }
  }
  function statSafe(p) {
    try { return fs.statSync(p); } catch { return null; }
  }

  async function copyFileSafe(src, dst) {
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    const tmp = dst + ".tmp";
    await fsp.copyFile(src, tmp);
    await fsp.rename(tmp, dst);
  }

  async function bootSync() {
    const diskOk = exists(DISK_DIR) && statSafe(DISK_DIR)?.isDirectory();
    if (!diskOk) return { ok: true, disk: false, action: "none" };

    const localExists = exists(LOCAL_DB);
    const diskExists = exists(DISK_DB);

    // If disk has DB but local doesn't -> pull from disk
    if (diskExists && !localExists) {
      await copyFileSafe(DISK_DB, LOCAL_DB);
      return { ok: true, disk: true, action: "pulled_disk_to_local" };
    }

    // If local has DB but disk doesn't -> push to disk
    if (localExists && !diskExists) {
      await copyFileSafe(LOCAL_DB, DISK_DB);
      return { ok: true, disk: true, action: "pushed_local_to_disk" };
    }

    // If both exist -> prefer newer by mtime
    if (localExists && diskExists) {
      const ls = statSafe(LOCAL_DB);
      const ds = statSafe(DISK_DB);
      const localM = ls ? ls.mtimeMs : 0;
      const diskM = ds ? ds.mtimeMs : 0;

      if (diskM > localM + 1) {
        await copyFileSafe(DISK_DB, LOCAL_DB);
        return { ok: true, disk: true, action: "pulled_newer_disk_to_local" };
      }
      if (localM > diskM + 1) {
        await copyFileSafe(LOCAL_DB, DISK_DB);
        return { ok: true, disk: true, action: "pushed_newer_local_to_disk" };
      }
      return { ok: true, disk: true, action: "already_in_sync" };
    }

    return { ok: true, disk: true, action: "none" };
  }

  // Run once on boot (do not crash server if sync fails)
  bootSync().catch((e) => console.warn("[RenderDiskSync] bootSync failed:", e?.message || e));

  // Storage info endpoint
  app.get("/api/storage", async (req, res) => {
    try {
      const diskOk = exists(DISK_DIR) && statSafe(DISK_DIR)?.isDirectory();
      const ls = statSafe(LOCAL_DB);
      const ds = statSafe(DISK_DB);

      res.json({
        ok: true,
        diskExists: diskOk,
        localDb: {
          path: LOCAL_DB,
          exists: !!ls,
          mtimeMs: ls ? ls.mtimeMs : null,
          size: ls ? ls.size : null
        },
        diskDb: {
          path: DISK_DB,
          exists: !!ds,
          mtimeMs: ds ? ds.mtimeMs : null,
          size: ds ? ds.size : null
        }
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });

  // Manual sync trigger (POST) to push local->disk or pull disk->local
  app.post("/api/storage/sync", express.json(), async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const mode = String(body.mode || "auto").toLowerCase(); // auto|push|pull

      const diskOk = exists(DISK_DIR) && statSafe(DISK_DIR)?.isDirectory();
      if (!diskOk) return res.status(400).json({ ok: false, error: "Render disk not present at /var/data" });

      const localExists = exists(LOCAL_DB);
      const diskExists = exists(DISK_DB);

      if (mode === "push") {
        if (!localExists) return res.status(400).json({ ok: false, error: "Local db.json missing" });
        await copyFileSafe(LOCAL_DB, DISK_DB);
        return res.json({ ok: true, action: "pushed_local_to_disk" });
      }

      if (mode === "pull") {
        if (!diskExists) return res.status(400).json({ ok: false, error: "Disk db.json missing" });
        await copyFileSafe(DISK_DB, LOCAL_DB);
        return res.json({ ok: true, action: "pulled_disk_to_local" });
      }

      const result = await bootSync();
      return res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
  });
})();

