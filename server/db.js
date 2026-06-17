// db.js — MySQL connection pools, identifier/literal quoting, statement splitter,
// and tiny HTTP helpers shared by every route module. Bun built-ins only.
import { SQL } from "bun";
import { connTarget, registerPoolCloser } from "./connections.js";

export const MYSQL = {
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "",
  maintDb: process.env.MYSQL_MAINT_DB || "mysql",
};
export const POOL_MAX = Number(process.env.POOL_MAX || 2);

// ---------------------------------------------------------------- pools
// Keyed per (connection, database). Lazy; the local fast path (conn 0) resolves
// synchronously inside connTarget, SSH connections may spin a tunnel up first.
// Bun.SQL auto-detects MySQL protocol only from the mysql:// URL scheme, not the
// options-object form (the object form always speaks PG wire protocol).
const pools = new Map(); // "connId/dbname" -> SQL
export async function getPool(db, connId = 0) {
  const key = (Number(connId) || 0) + "/" + db;
  if (!pools.has(key)) {
    const t = await connTarget(connId);
    if (pools.has(key)) return pools.get(key); // raced with a concurrent first call
    const enc = (s) => encodeURIComponent(s);
    const url = `mysql://${enc(t.user)}${t.password ? ":" + enc(t.password) : ""}@${enc(t.host)}:${t.port}/${enc(db)}`;
    pools.set(key, new SQL(url));
  }
  return pools.get(key);
}
export async function closePool(db, connId = 0) {
  const key = (Number(connId) || 0) + "/" + db;
  const p = pools.get(key);
  if (p) { pools.delete(key); try { await p.close(); } catch {} }
}
// evict every pool for a connection (called when its tunnel dies or its config changes)
registerPoolCloser((connId) => {
  const prefix = (Number(connId) || 0) + "/";
  for (const [key, p] of pools) {
    if (key.startsWith(prefix)) { pools.delete(key); p.close().catch(() => {}); }
  }
});

// MySQL uses backtick quoting
export const quoteIdent = (s) => "`" + String(s).replace(/`/g, "``") + "`";
export const quoteLit = (s) => "'" + String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
export const validDbName = (s) => typeof s === "string" && s.length > 0 && s.length <= 64 && !/[\0\/\\\s`]/.test(s);

// ---------------------------------------------------------------- SQL statement splitter
// Splits a script on top-level semicolons, respecting '…', "…", `…` backtick quoting,
// -- line comments, # line comments, and (nested) /* */ block comments.
export function splitStatements(script) {
  const out = [];
  let i = 0, start = 0, n = script.length;
  while (i < n) {
    const c = script[i];
    if (c === "'") {
      i++;
      while (i < n) {
        if (script[i] === "\\") { i += 2; continue; }
        if (script[i] === "'") { if (script[i + 1] === "'") { i += 2; continue; } i++; break; }
        i++;
      }
    } else if (c === '"') {
      i++;
      while (i < n) { if (script[i] === "\\") { i += 2; continue; } if (script[i] === '"') { if (script[i + 1] === '"') { i += 2; continue; } i++; break; } i++; }
    } else if (c === "`") {
      i++;
      while (i < n) { if (script[i] === "`") { if (script[i + 1] === "`") { i += 2; continue; } i++; break; } i++; }
    } else if (c === "#") {
      const nl = script.indexOf("\n", i); i = nl === -1 ? n : nl + 1;
    } else if (c === "-" && script[i + 1] === "-" && (script[i + 2] === " " || script[i + 2] === "\t" || script[i + 2] === "\n")) {
      const nl = script.indexOf("\n", i); i = nl === -1 ? n : nl + 1;
    } else if (c === "/" && script[i + 1] === "*" && (!(script[i + 2] === "!" && script[i + 3] >= "0" && script[i + 3] <= "9"))) {
      // skip /*!...*/ versioned comments (MySQL conditional exec) — they contain executable SQL
      let depth = 1; i += 2;
      while (i < n && depth > 0) {
        if (script[i] === "/" && script[i + 1] === "*") { depth++; i += 2; }
        else if (script[i] === "*" && script[i + 1] === "/") { depth--; i += 2; }
        else i++;
      }
    } else if (c === ";") {
      const stmt = script.slice(start, i).trim();
      if (stmt) out.push(stmt);
      i++; start = i;
    } else i++;
  }
  const tail = script.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

// ---------------------------------------------------------------- HTTP helpers
export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
export const err = (message, status = 400) => json({ error: message }, status);

export async function readBody(req) { try { return await req.json(); } catch { return null; } }
