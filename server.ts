import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";

interface LeaderboardEntry {
  id: string;
  runId?: string;
  name: string;
  term: number;
  mandate: number;
  bills: number;
  cabinet: string;
  createdAt: string;
  ipHash?: string;
  isOnline: boolean;
}

const app = express();
const PORT = 3000;

// Enable CORS for external static hosts (e.g. GitHub Pages)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json());

// Persistent leaderboard data file path
const DATA_DIR = path.join(process.cwd(), "data");
const LEADERBOARD_FILE = path.join(DATA_DIR, "leaderboard.json");

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadLeaderboard(): LeaderboardEntry[] {
  try {
    if (fs.existsSync(LEADERBOARD_FILE)) {
      const data = fs.readFileSync(LEADERBOARD_FILE, "utf-8");
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch (err) {
    console.error("Error reading leaderboard file:", err);
  }
  saveLeaderboard([]);
  return [];
}

function saveLeaderboard(entries: LeaderboardEntry[]) {
  try {
    fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(entries, null, 2), "utf-8");
  } catch (err) {
    console.error("Error writing leaderboard file:", err);
  }
}

// In-memory working cache
let leaderboardCache: LeaderboardEntry[] = loadLeaderboard();

// --- API ROUTES ---

// Health check
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// GET /api/leaderboard - Retrieve real live rankings
app.get("/api/leaderboard", (req, res) => {
  const category = (req.query.category as string) || "mandate";
  const limit = Math.min(parseInt((req.query.limit as string) || "50", 10), 100);

  const sorted = [...leaderboardCache];
  if (category === "term") {
    sorted.sort((a, b) => b.term - a.term || b.mandate - a.mandate);
  } else if (category === "bills") {
    sorted.sort((a, b) => b.bills - a.bills || b.mandate - a.mandate);
  } else {
    // Default by mandate score
    sorted.sort((a, b) => b.mandate - a.mandate || b.term - a.term);
  }

  res.json({
    success: true,
    serverTime: new Date().toISOString(),
    totalEntries: sorted.length,
    category,
    entries: sorted.slice(0, limit)
  });
});

// POST /api/leaderboard - Submit a new real online run with deduplication
app.post("/api/leaderboard", (req, res) => {
  const { runId, name, term, mandate, bills, cabinet } = req.body;

  const sanitizedName = String(name || "ANONYMOUS PRESIDENT")
    .trim()
    .toUpperCase()
    .substring(0, 18);

  const validTerm = Math.max(1, parseInt(term || "1", 10));
  const validMandate = Math.max(0, parseInt(mandate || "0", 10));
  const validBills = Math.max(0, parseInt(bills || "0", 10));
  const sanitizedCabinet = String(cabinet || "Independent Cabinet").substring(0, 100);

  if (validMandate <= 0 && validBills <= 0) {
    return res.status(400).json({ success: false, error: "Score or bills must be greater than 0" });
  }

  // Deduplication check: If the user passes a unique campaign runId, check if it was already recorded
  if (runId) {
    const existingIndex = leaderboardCache.findIndex(e => e.runId === runId);
    if (existingIndex !== -1) {
      const existing = leaderboardCache[existingIndex];
      // Update existing if improved or player name changed
      if (validMandate >= existing.mandate) {
        leaderboardCache[existingIndex] = {
          ...existing,
          name: sanitizedName,
          term: Math.max(existing.term, validTerm),
          mandate: Math.max(existing.mandate, validMandate),
          bills: Math.max(existing.bills, validBills),
          cabinet: sanitizedCabinet,
          createdAt: new Date().toISOString()
        };
        saveLeaderboard(leaderboardCache);
        const sorted = [...leaderboardCache].sort((a, b) => b.mandate - a.mandate);
        const rank = sorted.findIndex((e) => e.id === existing.id) + 1;
        return res.json({
          success: true,
          updated: true,
          message: "Existing campaign run updated",
          entry: leaderboardCache[existingIndex],
          rank,
          totalRecords: leaderboardCache.length
        });
      } else {
        const sorted = [...leaderboardCache].sort((a, b) => b.mandate - a.mandate);
        const rank = sorted.findIndex((e) => e.id === existing.id) + 1;
        return res.json({
          success: true,
          updated: false,
          message: "Campaign run already recorded with higher or equal score",
          entry: existing,
          rank,
          totalRecords: leaderboardCache.length
        });
      }
    }
  }

  // Check for duplicate identical submission in the last 15 seconds (same name, term, mandate, bills)
  const recentDuplicate = leaderboardCache.find(e => 
    e.name === sanitizedName && 
    e.term === validTerm && 
    e.mandate === validMandate && 
    e.bills === validBills &&
    (Date.now() - new Date(e.createdAt).getTime()) < 20000
  );
  if (recentDuplicate) {
    const sorted = [...leaderboardCache].sort((a, b) => b.mandate - a.mandate);
    const rank = sorted.findIndex((e) => e.id === recentDuplicate.id) + 1;
    return res.json({
      success: true,
      duplicate: true,
      message: "Duplicate run detected, ranking retrieved",
      entry: recentDuplicate,
      rank,
      totalRecords: leaderboardCache.length
    });
  }

  const newEntry: LeaderboardEntry = {
    id: `run_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    runId: runId || `run_${Date.now()}`,
    name: sanitizedName || "PRESIDENT RUNNER",
    term: validTerm,
    mandate: validMandate,
    bills: validBills,
    cabinet: sanitizedCabinet,
    createdAt: new Date().toISOString(),
    isOnline: true
  };

  // Add to cache & persist
  leaderboardCache.unshift(newEntry);
  // Keep up to top 500 records
  if (leaderboardCache.length > 500) {
    leaderboardCache = leaderboardCache.slice(0, 500);
  }
  saveLeaderboard(leaderboardCache);

  // Compute player rank
  const sorted = [...leaderboardCache].sort((a, b) => b.mandate - a.mandate);
  const rank = sorted.findIndex((e) => e.id === newEntry.id) + 1;

  res.status(201).json({
    success: true,
    message: "Run published to National Online Leaderboard",
    entry: newEntry,
    rank,
    totalRecords: leaderboardCache.length
  });
});

// GET /api/leaderboard/stats - Global server stats
app.get("/api/leaderboard/stats", (_req, res) => {
  const totalRuns = leaderboardCache.length;
  const highestMandate = leaderboardCache.reduce((max, e) => Math.max(max, e.mandate), 0);
  const totalBillsPassed = leaderboardCache.reduce((sum, e) => sum + e.bills, 0);
  const maxTermReached = leaderboardCache.reduce((max, e) => Math.max(max, e.term), 0);

  res.json({
    success: true,
    totalRuns,
    highestMandate,
    totalBillsPassed,
    maxTermReached,
    onlineStatus: "LIVE"
  });
});

async function startServer() {
  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa"
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`CABINET Politics Online server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
