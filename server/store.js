// store.js — local bun:sqlite store for saved queries + audit log.
// Deliberately NOT in MySQL: this tool manages many DBs and must not write
// into user databases.
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";

// APP_DATA_DIR lets the desktop shell point the local store at a per-user writable
// dir (the install dir is read-only when packaged); defaults to the dev ./data layout.
const DATA_DIR = process.env.APP_DATA_DIR || import.meta.dir + "/../data";
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DATA_DIR + "/mysql-fast.sqlite", { create: true });
db.exec("PRAGMA journal_mode = WAL");
export const store = db; // shared handle for other local-store modules (connections.js)
db.exec(`
  CREATE TABLE IF NOT EXISTS saved_queries (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    sql TEXT NOT NULL,
    db TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    db TEXT,
    sql TEXT,
    command TEXT,
    row_count INTEGER,
    ok INTEGER,
    ip TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
  CREATE TABLE IF NOT EXISTS query_history (
    id INTEGER PRIMARY KEY,
    at INTEGER NOT NULL,
    db TEXT,
    sql TEXT NOT NULL,
    ok INTEGER,
    ms INTEGER,
    row_count INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_hist_at ON query_history(at DESC);
`);
// additive migrations: tag audit/history rows with the server (connection) they ran on
for (const t of ["audit_log", "query_history"]) {
  try { db.exec(`ALTER TABLE ${t} ADD COLUMN conn TEXT`); } catch { /* column already exists */ }
}

// ---------------------------------------------------------------- audit log
const MUTATING_RE = /^\s*(insert|update|delete|create|alter|drop|truncate|grant|revoke|rename)\b/i;
export const isMutating = (stmt) => MUTATING_RE.test(stmt);

const insAudit = db.prepare(
  "INSERT INTO audit_log (at, db, sql, command, row_count, ok, ip, error, conn) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
export function recordAudit({ db: dbName, sql, command, rowCount, ok, ip, error, conn }) {
  try {
    insAudit.run(Date.now(), dbName ?? null, String(sql).slice(0, 20000), command ?? null,
      rowCount ?? null, ok ? 1 : 0, ip ?? null, error ? String(error).slice(0, 2000) : null, conn ?? null);
  } catch (e) { console.error("audit write failed:", e?.message); }
}
const selAudit = db.prepare("SELECT * FROM audit_log ORDER BY at DESC LIMIT ?");
export function listAudit(limit = 200) {
  return selAudit.all(Math.min(Math.max(Number(limit) || 200, 1), 2000));
}

// ---------------------------------------------------------------- query history
const HIST_MAX = 10000;
const insHist = db.prepare("INSERT INTO query_history (at, db, sql, ok, ms, row_count, conn) VALUES (?, ?, ?, ?, ?, ?, ?)");
const trimHist = db.prepare("DELETE FROM query_history WHERE id <= (SELECT max(id) FROM query_history) - ?");
export function recordHistory({ db: dbName, sql, ok, ms, rowCount, conn }) {
  try {
    insHist.run(Date.now(), dbName ?? null, String(sql).slice(0, 20000), ok ? 1 : 0, ms ?? null, rowCount ?? null, conn ?? null);
    trimHist.run(HIST_MAX);
  } catch (e) { console.error("history write failed:", e?.message); }
}
export function listHistory({ q, from, to, limit, offset } = {}) {
  const conds = [], params = [];
  if (q) {
    const pat = "%" + String(q).replace(/[\\%_]/g, c => "\\" + c) + "%";
    conds.push("(sql LIKE ? ESCAPE '\\' OR db LIKE ? ESCAPE '\\')");
    params.push(pat, pat);
  }
  if (from && Number.isFinite(Number(from))) { conds.push("at >= ?"); params.push(Number(from)); }
  if (to && Number.isFinite(Number(to))) { conds.push("at <= ?"); params.push(Number(to)); }
  const where = conds.length ? " WHERE " + conds.join(" AND ") : "";
  const total = db.prepare("SELECT count(*) AS c FROM query_history" + where).get(...params).c;
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const off = Math.max(Number(offset) || 0, 0);
  const entries = db.prepare(
    "SELECT id, at, db, sql, ok, ms, row_count, conn FROM query_history" + where +
    " ORDER BY at DESC, id DESC LIMIT ? OFFSET ?").all(...params, lim, off);
  return { entries, total, limit: lim, offset: off };
}
export function clearHistory() { db.exec("DELETE FROM query_history"); }

// ---------------------------------------------------------------- saved queries
const selSaved = db.prepare("SELECT id, name, sql, db, created_at, updated_at FROM saved_queries ORDER BY updated_at DESC");
const insSaved = db.prepare("INSERT INTO saved_queries (name, sql, db, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
const updSaved = db.prepare("UPDATE saved_queries SET name = ?, sql = ?, db = ?, updated_at = ? WHERE id = ?");
const delSaved = db.prepare("DELETE FROM saved_queries WHERE id = ?");

export function listSaved() { return selSaved.all(); }
export function createSaved({ name, sql, db: dbName }) {
  const now = Date.now();
  const r = insSaved.run(String(name).slice(0, 200), String(sql), dbName ?? null, now, now);
  return Number(r.lastInsertRowid);
}
export function updateSaved(id, { name, sql, db: dbName }) {
  return updSaved.run(String(name).slice(0, 200), String(sql), dbName ?? null, Date.now(), id).changes > 0;
}
export function deleteSaved(id) { return delSaved.run(id).changes > 0; }
