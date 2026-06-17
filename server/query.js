// query.js — friendly MySQL error explanations (errno → plain language,
// Levenshtein "did you mean"), server-side destructive-SQL check, and EXPLAIN handler.
import { getPool } from "./db.js";
import { fetchSchema } from "./schema.js";

// ---------------------------------------------------------------- Levenshtein
function lev(a, b) {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
function nearest(target, candidates, maxDist = 3) {
  let best = null, bestD = maxDist + 1;
  const lo = target.toLowerCase();
  for (const c of candidates) {
    const d = lev(lo, c.toLowerCase());
    if (d < bestD) { bestD = d; best = c; }
  }
  if (bestD <= Math.max(1, Math.min(maxDist, Math.floor(target.length / 3) + 1))) return best;
  if (lo.length >= 3) {
    const contains = candidates.filter(c => c.toLowerCase().includes(lo));
    if (contains.length) return contains.sort((a, b) => a.length - b.length)[0];
  }
  return null;
}

// ---------------------------------------------------------------- friendly errors
// MySQL server error codes (e.errno) — the most common ones users hit.
// Bun.SQL for MySQL puts the errno in e.errno and the message in e.message.
const ERRNO_TEXT = {
  1054: "That column doesn't exist in the table(s) you're querying.",
  1146: "That table doesn't exist in this database — check the name and database.",
  1064: "MySQL couldn't parse the SQL — there's a syntax error near the position shown.",
  1062: "A row with this value already exists — the column has a UNIQUE or PRIMARY KEY constraint.",
  1451: "Cannot delete or update — a row in another table references this one (foreign-key constraint).",
  1452: "Cannot add or update — the referenced row doesn't exist (foreign-key constraint).",
  1048: "A column cannot be NULL — supply a value or give the column a DEFAULT.",
  1052: "The column name is ambiguous — qualify it with the table name or alias.",
  1040: "Too many connections to MySQL — close idle sessions or raise max_connections.",
  1142: "Permission denied — the connected user lacks rights on this object.",
  1060: "A column with that name already exists in the table.",
  1091: "That column or key doesn't exist in the table.",
  1265: "A value doesn't match the column type (e.g. text into an integer column).",
  1406: "Data too long for the column — the value exceeds the column's max length.",
  1364: "A column with no default value is missing from the INSERT.",
  1175: "You're updating with no WHERE clause in safe-update mode — disable safe updates or add a key-based WHERE.",
  1005: "Can't create table — usually a foreign-key constraint references a nonexistent table or column.",
  1215: "Cannot add foreign key constraint — check that the referenced column exists and types match.",
  1216: "Cannot add or update a child row — the parent row doesn't exist (foreign-key constraint).",
  1217: "Cannot delete or update a parent row — child rows exist (foreign-key constraint).",
  1007: "Can't create database — it already exists.",
  1008: "Can't drop database — it doesn't exist.",
  1050: "Table already exists.",
  1051: "Unknown table — the table doesn't exist.",
  1067: "Invalid default value for the column.",
  1068: "Multiple primary key defined.",
  1072: "Key column doesn't exist in table.",
  1075: "Incorrect table definition — there can be only one auto column and it must be a key.",
  1136: "Column count doesn't match value count — check your INSERT columns and VALUES.",
  1264: "Value out of range for the column type.",
  1292: "Incorrect datetime/date/time value.",
  1366: "Incorrect integer/string/decimal value for the column.",
  1396: "Operation failed for the user (e.g. user doesn't exist for DROP USER).",
};

export async function friendlyError(e, db, connId = 0) {
  const errno = Number(e?.errno || 0);
  const out = {};
  if (ERRNO_TEXT[errno]) out.friendly = ERRNO_TEXT[errno];
  // "did you mean" for unknown column / table
  if ((errno === 1054 || errno === 1146) && db) {
    const msg = e.message || "";
    const m = msg.match(/['`"']([^'`"']+)['`"']/);
    if (m) {
      try {
        const schema = await fetchSchema(db, connId);
        let names;
        if (errno === 1054) {
          // Unknown column — try to scope to the table named in the error
          const rel = msg.match(/['`]([^'`]+)['`]/);
          const cols = rel ? schema.columns.filter(c => c.table === rel[1]) : schema.columns;
          names = [...new Set(cols.map(c => c.name))];
        } else {
          names = schema.tables.map(t => t.name);
        }
        const hit = nearest(m[1], names.filter(n => n.toLowerCase() !== m[1].toLowerCase()));
        if (hit) out.didYouMean = hit;
      } catch { /* schema lookup is best-effort */ }
    }
  }
  return out;
}

// ---------------------------------------------------------------- destructive check (server-side)
export function isDestructive(sql) {
  const clean = String(sql).replace(/'(?:[^'\\]|\\.)*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/--[^\n]*/g, "").replace(/#[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  return clean.split(";").map(s => s.trim()).filter(Boolean)
    .some(s => /^(drop|truncate|delete|update|insert|alter|create|grant|revoke|rename|call|do)\b/i.test(s));
}

// ---------------------------------------------------------------- EXPLAIN
function walkPlan(node, depth, out, analyzed) {
  const rows = Number(node.rows_examined_per_scan ?? node.rows ?? 0);
  if (node.access_type === "ALL" && rows > 10000) {
    out.hints.push(`Full table scan on "${node.table_name}" over ~${rows.toLocaleString()} rows` +
      (node.attached_condition ? ` filtered by ${node.attached_condition} — an index on the filtered column(s) could help` : " — consider whether an index applies"));
  }
  if (node.access_type === "index" && rows > 50000) {
    out.hints.push(`Full index scan on "${node.table_name}" over ~${rows.toLocaleString()} rows — consider a more selective index or filter`);
  }
  if (node.using_filesort) {
    out.hints.push(`Filesort on "${node.table_name || "result"}" — consider an index matching the ORDER BY`);
  }
  if (node.using_temporary_table) {
    out.hints.push(`Temporary table used on "${node.table_name || "result"}" — consider an index or rewriting the query`);
  }
  if (analyzed && Number.isFinite(node.actual_rows) && Number.isFinite(node.rows)) {
    const actual = Number(node.actual_rows);
    const estimated = Number(node.rows);
    if (estimated > 0) {
      const ratio = Math.max(actual, 1) / estimated;
      if (ratio > 100 || ratio < 0.01) {
        out.hints.push(`Planner estimate is off ${ratio > 1 ? Math.round(ratio) : "1/" + Math.round(1 / ratio)}× on ${node.operation || "scan"}` +
          (node.table_name ? ` ("${node.table_name}")` : "") + ` — run ANALYZE TABLE to refresh statistics`);
      }
    }
  }
  for (const child of node["inputs"] || node.inner_plan || []) walkPlan(child, depth + 1, out, analyzed);
}

export async function handleExplain({ db, sql, analyze, connId = 0 }) {
  const wantAnalyze = !!analyze;
  let analyzed = wantAnalyze;
  let note = null;
  if (wantAnalyze && isDestructive(sql)) {
    analyzed = false;
    note = "ANALYZE actually executes the statement — refused for a mutating/DDL statement. Showing the plain plan instead.";
  }
  // MySQL 8.0.18+ supports EXPLAIN ANALYZE
  const stmt = analyzed ? `EXPLAIN ANALYZE ${sql}` : `EXPLAIN FORMAT=JSON ${sql}`;
  const pool = await getPool(db, connId);
  const conn = await pool.reserve();
  let raw;
  try {
    raw = await conn.unsafe(stmt);
  } finally {
    conn.release();
  }
  // MySQL EXPLAIN FORMAT=JSON returns a "query_block" -> "table" structure
  // EXPLAIN ANALYZE returns a text table with timing info inline
  let planDoc = null;
  if (analyzed) {
    // EXPLAIN ANALYZE output is a result set (text-like), not JSON
    // We return it as a text plan
    if (Array.isArray(raw) && raw[0]) {
      planDoc = { query_block: { table: raw[0] }, text_plan: true };
    }
  } else {
    const cell = Array.isArray(raw) && raw[0] ? Object.values(raw[0])[0] : null;
    planDoc = typeof cell === "string" ? JSON.parse(cell) : (cell || {});
  }
  const root = planDoc?.query_block || planDoc;
  const out = { hints: [] };
  if (root) walkPlan(typeof root === "object" ? root : {}, 0, out, analyzed);
  const hints = [...new Set(out.hints)].slice(0, 8);
  return { plan: planDoc, hints, analyzed, note };
}
