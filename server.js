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
app.listen(PORT, HOST, () => console.log(`ProTracker v1 listening on http://${HOST}:${PORT}`));
