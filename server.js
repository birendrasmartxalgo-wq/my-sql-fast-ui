// mysql-fast-ui — web console for MySQL databases.
// Bun built-ins only (Bun.serve, Bun.SQL, Bun.spawn). See ../CLAUDE.md conventions.
// Entry point: route dispatch + static serving. Logic lives in server/*.js modules.
import { MYSQL, getPool, closePool, quoteIdent, validDbName, splitStatements, json, err, readBody } from "./server/db.js";
import { listConnections, getConnRow, createConnection, updateConnection, deleteConnection,
         connTarget, testConnection, connectionsShutdown } from "./server/connections.js";
import { checkAuth, handleLogin } from "./server/auth.js";
import { fetchSchema, fetchFks, buildSuggestions, buildPath } from "./server/schema.js";
import { isMutating, recordAudit, listAudit, listSaved, createSaved, updateSaved, deleteSaved,
         recordHistory, listHistory, clearHistory } from "./server/store.js";
import { friendlyError, handleExplain } from "./server/query.js";
import { handleAi, aiConfigured } from "./server/ai.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PORT || 4602);
const HOST = process.env.HOST || "0.0.0.0";
const ASSETS_DIR = process.env.ASSETS_DIR || import.meta.dir + "/public";

// ---------------------------------------------------------------- route handlers
async function handleApi(req, url, ip) {
  const path = url.pathname;
  const method = req.method;

  if (path === "/api/login" && method === "POST") {
    return handleLogin(req, ip);
  }

  if (!checkAuth(req, url)) return err("Unauthorized", 401);

  // ---- which server? every data route accepts ?conn= (0 / absent = the local .env server)
  const connId = Number(url.searchParams.get("conn")) || 0;
  if (connId !== 0 && !getConnRow(connId)) return err("Unknown connection — it may have been deleted", 404);
  const target = () => connTarget(connId);

  // ---- connection registry (credentials AES-encrypted at rest; secrets never echoed)
  if (path === "/api/connections" && method === "GET") {
    return json({ connections: listConnections() });
  }
  if (path === "/api/connections" && method === "POST") {
    const body = await readBody(req);
    if (!body) return err("Expected a connection spec");
    try { return json({ id: createConnection(body) }); }
    catch (e) { return err(/UNIQUE/.test(e?.message || "") ? `A server named "${body.name}" already exists` : e.message); }
  }
  if (path === "/api/connections/test" && method === "POST") {
    const body = await readBody(req);
    if (!body) return err("Expected a connection spec or { id }");
    try { return json(await testConnection(body)); }
    catch (e) { return json({ ok: false, error: e?.message || String(e) }); }
  }
  let m = path.match(/^\/api\/connections\/(\d+)$/);
  if (m && method === "PUT") {
    const id = Number(m[1]);
    if (id === 0) return err("The built-in local server is configured via .env");
    const body = await readBody(req);
    if (!body) return err("Expected a connection spec");
    try { return json({ connection: updateConnection(id, body) }); }
    catch (e) { return err(/UNIQUE/.test(e?.message || "") ? `A server named "${body.name}" already exists` : e.message); }
  }
  if (m && method === "DELETE") {
    const id = Number(m[1]);
    if (id === 0) return err("The built-in local server cannot be deleted");
    return deleteConnection(id) ? json({ ok: true }) : err("Not found", 404);
  }

  // ---- databases (MySQL: list via SHOW DATABASES filtered to user-accessible)
  if (path === "/api/databases" && method === "GET") {
    const t = await target();
    const sql = await getPool("mysql", connId);
    const rows = await sql.unsafe(`SHOW DATABASES`);
    const names = rows.map(r => r.Database).filter(n =>
      !["mysql","information_schema","performance_schema","sys"].includes(n));
    // get sizes + charsets
    const details = await sql.unsafe(`
      SELECT schema_name AS name, default_character_set_name AS charset,
             CAST(COALESCE(SUM(data_length + index_length), 0) AS UNSIGNED) AS bytes
      FROM information_schema.SCHEMATA s
      LEFT JOIN information_schema.TABLES t ON t.table_schema = s.schema_name
      WHERE s.schema_name NOT IN ('mysql','information_schema','performance_schema','sys')
      GROUP BY s.schema_name, s.default_character_set_name
      ORDER BY s.schema_name`);
    const byName = new Map(details.map(d => [d.name, d]));
    const databases = names.map(n => {
      const d = byName.get(n);
      return { name: n, charset: d?.charset || "utf8mb4", bytes: d?.bytes || 0 };
    });
    return json({ databases, ai: aiConfigured() });
  }
  if (path === "/api/databases" && method === "POST") {
    const body = await readBody(req);
    if (!body || !validDbName(body.name)) return err("Invalid database name");
    const t = await target();
    const sql = await getPool("mysql", connId);
    let ddl = `CREATE DATABASE ${quoteIdent(body.name)}`;
    if (body.charset) ddl += ` CHARACTER SET ${body.charset}`;
    await sql.unsafe(ddl);
    recordAudit({ db: "mysql", sql: ddl, command: "CREATE DATABASE", ok: true, ip, conn: t.name });
    return json({ ok: true, ddl });
  }
  m = path.match(/^\/api\/databases\/([^/]+)$/);
  if (m && method === "DELETE") {
    const name = decodeURIComponent(m[1]);
    if (!validDbName(name)) return err("Invalid database name");
    // MySQL: no concept of "maintenance DB" — refuse to drop mysql system databases
    if (["mysql","information_schema","performance_schema","sys"].includes(name))
      return err(`Refusing to drop the system database (${name})`);
    await closePool(name, connId);
    const sql = await getPool("mysql", connId);
    await sql.unsafe(`DROP DATABASE ${quoteIdent(name)}`);
    recordAudit({ db: "mysql", sql: `DROP DATABASE ${quoteIdent(name)}`, command: "DROP DATABASE", ok: true, ip, conn: (await target()).name });
    return json({ ok: true });
  }

  // ---- saved queries (bun:sqlite, local — never written into user DBs)
  if (path === "/api/saved" && method === "GET") return json({ queries: listSaved() });
  if (path === "/api/saved" && method === "POST") {
    const body = await readBody(req);
    if (!body?.name?.trim() || typeof body.sql !== "string" || !body.sql.trim()) return err("Expected { name, sql }");
    try { return json({ id: createSaved({ name: body.name.trim(), sql: body.sql, db: body.db }) }); }
    catch (e) { return err(/UNIQUE/.test(e?.message || "") ? `A saved query named "${body.name.trim()}" already exists` : e.message); }
  }
  m = path.match(/^\/api\/saved\/(\d+)$/);
  if (m && method === "PUT") {
    const body = await readBody(req);
    if (!body?.name?.trim() || typeof body.sql !== "string") return err("Expected { name, sql }");
    return updateSaved(Number(m[1]), { name: body.name.trim(), sql: body.sql, db: body.db })
      ? json({ ok: true }) : err("Not found", 404);
  }
  if (m && method === "DELETE") {
    return deleteSaved(Number(m[1])) ? json({ ok: true }) : err("Not found", 404);
  }

  // ---- query history (bun:sqlite, written inside /api/query; capped at 10k)
  if (path === "/api/history" && method === "GET") {
    return json(listHistory({
      q: url.searchParams.get("q"),
      from: url.searchParams.get("from"),
      to: url.searchParams.get("to"),
      limit: url.searchParams.get("limit"),
      offset: url.searchParams.get("offset"),
    }));
  }
  if (path === "/api/history" && method === "DELETE") {
    clearHistory();
    return json({ ok: true });
  }

  // ---- audit log
  if (path === "/api/audit" && method === "GET") {
    return json({ entries: listAudit(url.searchParams.get("limit")) });
  }

  const db = url.searchParams.get("db");
  const needDb = () => { if (!db || !validDbName(db)) throw new Error("Missing or invalid ?db= parameter"); };

  // ---- schema tree (FKs included for context-aware autocomplete)
  if (path === "/api/schema" && method === "GET") {
    needDb();
    const [schema, fks] = await Promise.all([fetchSchema(db, connId), fetchFks(db, connId)]);
    return json({ ...schema, fks });
  }

  // ---- query execution (DML / DDL / DCL)
  if (path === "/api/query" && method === "POST") {
    const body = await readBody(req);
    if (!body || !validDbName(body.db) || typeof body.sql !== "string") return err("Expected { db, sql }");
    const tServer = performance.now();
    const maxRows = Math.min(Number(body.maxRows) || 500, 100000);
    const BYTE_BUDGET = 100 * 1024 * 1024;
    let bytesUsed = 0;
    const stmts = splitStatements(body.sql);
    if (!stmts.length) return err("No statements to execute");
    const connName = connId === 0 ? null : getConnRow(connId)?.name;
    const pool = await getPool(body.db, connId);
    const conn = await pool.reserve();
    const results = [];
    try {
      for (const stmt of stmts) {
        const t0 = performance.now();
        try {
          const r = await conn.unsafe(stmt);
          const rows = Array.isArray(r) ? r : [];
          const rowCount = typeof r?.count === "number" && r.count > 0 ? r.count : rows.length;
          const lim = Math.min(rows.length, maxRows);
          const kept = [];
          let byteCapped = false;
          const sampleN = Math.min(lim, 200);
          let sampleBytes = 0;
          for (let i = 0; i < sampleN; i++) sampleBytes += JSON.stringify(Object.values(rows[i])).length + 1;
          const estTotal = sampleN ? (sampleBytes / sampleN) * lim : 0;
          if (bytesUsed + estTotal < BYTE_BUDGET * 0.5) {
            for (let i = 0; i < lim; i++) kept.push(Object.values(rows[i]));
            bytesUsed += estTotal;
          } else {
            for (let i = 0; i < lim; i++) {
              const vals = Object.values(rows[i]);
              bytesUsed += JSON.stringify(vals).length + 1;
              if (bytesUsed > BYTE_BUDGET && kept.length) { byteCapped = true; break; }
              kept.push(vals);
            }
          }
          results.push({
            ok: true,
            statement: stmt.length > 200 ? stmt.slice(0, 200) + "…" : stmt,
            rowCount,
            truncated: rows.length > kept.length,
            byteCapped,
            packed: true,
            rows: kept,
            columns: rows.length ? Object.keys(rows[0]) : [],
            ms: Math.round(performance.now() - t0),
          });
          if (isMutating(stmt)) recordAudit({ db: body.db, sql: stmt, command: stmt.split(/\s/)[0], rowCount, ok: true, ip, conn: connName });
        } catch (e) {
          results.push({
            ok: false,
            statement: stmt.length > 200 ? stmt.slice(0, 200) + "…" : stmt,
            error: e?.message || String(e),
            sqlstate: null,
            errno: e?.errno ? Number(e.errno) : null,
            ...(await friendlyError(e, body.db, connId)),
            ms: Math.round(performance.now() - t0),
          });
          if (isMutating(stmt)) recordAudit({ db: body.db, sql: stmt, ok: false, ip, error: e?.message, conn: connName });
          // MySQL: after certain errors, the session must be rolled back
          try { await conn.unsafe("ROLLBACK"); } catch {}
          break;
        }
      }
    } finally {
      conn.release();
    }
    recordHistory({
      conn: connName,
      db: body.db, sql: body.sql,
      ok: results.every(r => r.ok),
      ms: results.reduce((a, r) => a + (r.ms || 0), 0),
      rowCount: results.reduce((a, r) => a + (r.ok ? r.rowCount : 0), 0),
    });
    return json({ results, serverMs: Math.round(performance.now() - tServer) });
  }

  // ---- AI proxy: NL→SQL generation + error fixing (key stays server-side)
  if (path === "/api/ai" && method === "POST") {
    const body = await readBody(req);
    if (!body || !validDbName(body.db)) return err("Expected { db, mode, … }");
    return handleAi({ ...body, connId });
  }

  // ---- EXPLAIN / query plan
  if (path === "/api/explain" && method === "POST") {
    const body = await readBody(req);
    if (!body || !validDbName(body.db) || typeof body.sql !== "string" || !body.sql.trim()) return err("Expected { db, sql }");
    try {
      return json(await handleExplain({ ...body, connId }));
    } catch (e) {
      return json({ error: e?.message || String(e), errno: e?.errno ? Number(e.errno) : null,
        ...(await friendlyError(e, body.db, connId)) }, 400);
    }
  }

  // ---- join suggestions
  if (path === "/api/joins" && method === "GET") {
    needDb();
    const [schema, fks] = await Promise.all([fetchSchema(db, connId), fetchFks(db, connId)]);
    const table = url.searchParams.get("table");
    const from = url.searchParams.get("from"), to = url.searchParams.get("to");
    if (from && to) {
      const p = buildPath({ fks, columns: schema.columns }, from, to);
      return json(p ? { path: p } : { path: null, message: "No join path found between these tables" });
    }
    if (!table) return err("Pass ?table= or ?from=&to=");
    return json({ suggestions: buildSuggestions({ fks, columns: schema.columns, pks: schema.pks }, table) });
  }

  // ---- table definition: SHOW CREATE TABLE + indexes + column stats
  if (path === "/api/tabledef" && method === "GET") {
    needDb();
    const schema = url.searchParams.get("schema") || db;
    const table = url.searchParams.get("table");
    if (!table) return err("Pass ?table=");
    const sql = await getPool(db, connId);
    const [createRows, indexes, colStats] = await Promise.all([
      sql.unsafe(`SHOW CREATE TABLE ${quoteIdent(schema)}.${quoteIdent(table)}`),
      sql.unsafe(`SHOW INDEX FROM ${quoteIdent(schema)}.${quoteIdent(table)}`),
      sql.unsafe(`
        SELECT c.column_name AS name, c.column_type AS type,
               c.is_nullable = 'YES' AS nullable,
               c.column_default AS dflt, c.extra,
               s.cardinality, c.ordinal_position
        FROM information_schema.COLUMNS c
        LEFT JOIN information_schema.STATISTICS s
          ON s.table_schema = c.table_schema AND s.table_name = c.table_name
         AND s.column_name = c.column_name
        WHERE c.table_schema = ? AND c.table_name = ?
        GROUP BY c.column_name, c.column_type, c.is_nullable, c.column_default, c.extra, s.cardinality, c.ordinal_position
        ORDER BY c.ordinal_position`, [schema, table]),
    ]);
    const ddl = createRows?.[0]?.["Create Table"] || "-- no DDL returned";
    const idxList = indexes.map(r => ({
      name: r.Key_name,
      columns: r.Column_name,
      unique: r.Non_unique === 0,
      primary: r.Key_name === "PRIMARY",
      cardinality: r.Cardinality || null,
      visible: r.Visible !== "NO",
    }));
    const stats = colStats.map(r => ({
      name: r.name, type: r.type, nullable: r.nullable, dflt: r.dflt,
      extra: r.extra, cardinality: r.cardinality,
    }));
    return json({ ddl, indexes: idxList, stats });
  }

  // ---- roles & grants (MySQL privilege system)
  if (path === "/api/roles" && method === "GET") {
    const t = await target();
    const sql = await getPool("mysql", connId);
    const roles = await sql.unsafe(`
      SELECT user AS name, host, plugin, authentication_string IS NOT NULL AND authentication_string != '' AS has_password,
             account_locked = 'Y' AS locked
      FROM mysql.user ORDER BY user, host`);
    return json({ roles });
  }
  if (path === "/api/grants" && method === "GET") {
    needDb();
    const sql = await getPool("mysql", connId);
    const grants = await sql.unsafe(`
      SELECT grantee, table_schema AS \`schema\`, table_name AS \`table\`,
             GROUP_CONCAT(privilege_type ORDER BY privilege_type SEPARATOR ', ') AS privileges
      FROM information_schema.TABLE_PRIVILEGES
      WHERE table_schema = ?
      GROUP BY grantee, table_schema, table_name
      ORDER BY table_schema, table_name, grantee`, [db]);
    return json({ grants });
  }

  // ---- export (mysqldump)
  if (path === "/api/export" && method === "GET") {
    needDb();
    const format = url.searchParams.get("format") === "custom" ? "custom" : "plain";
    const t = await target();
    const args = ["mysqldump", "-h", t.host, "-P", String(t.port), "-u", t.user,
      t.password ? `-p${t.password}` : "", "--single-transaction", "--routines", "--triggers",
      db];
    // filter out empty password arg
    const cleanArgs = args.filter(a => a !== "");
    const proc = Bun.spawn(cleanArgs, {
      stdout: "pipe", stderr: "pipe",
    });
    const ext = "sql";
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    return new Response(proc.stdout, {
      headers: {
        "content-type": "application/sql",
        "content-disposition": `attachment; filename="${db}-${stamp}.${ext}"`,
      },
    });
  }

  // ---- import (mysql client)
  if (path === "/api/import" && method === "POST") {
    needDb();
    const create = url.searchParams.get("create") === "1";
    const buf = new Uint8Array(await req.arrayBuffer());
    if (!buf.length) return err("Empty upload");
    const t = await target();
    if (create) {
      await (await getPool("mysql", connId)).unsafe(`CREATE DATABASE ${quoteIdent(db)}`);
    }
    const tmp = join(tmpdir(), `mysql-fast-import-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await Bun.write(tmp, buf);
    const args = ["mysql", "-h", t.host, "-P", String(t.port), "-u", t.user,
      t.password ? `-p${t.password}` : "", db];
    const cleanArgs = args.filter(a => a !== "");
    const proc = Bun.spawn(cleanArgs, {
      stdin: Bun.file(tmp),
      stdout: "pipe", stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    try { await Bun.file(tmp).delete(); } catch {}
    return json({ ok: code === 0, tool: "mysql", exitCode: code,
      stdout: stdout.slice(-8000), stderr: stderr.slice(-8000) });
  }

  return err("Not found", 404);
}

// ---------------------------------------------------------------- server
Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 120,
  async fetch(req, server) {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || server.requestIP(req)?.address || "";
        const res = await handleApi(req, url, ip);
        // gzip/zstd compression for JSON payloads >1 KB
        const ae = req.headers.get("accept-encoding") || "";
        if (res.headers.get("content-type")?.includes("application/json") &&
            !res.headers.get("content-encoding") && /\b(zstd|gzip)\b/.test(ae)) {
          const buf = await res.arrayBuffer();
          if (buf.byteLength > 1024) {
            const zstd = /\bzstd\b/.test(ae) && typeof Bun.zstdCompressSync === "function";
            const body = zstd
              ? Bun.zstdCompressSync(new Uint8Array(buf), { level: 3 })
              : Bun.gzipSync(new Uint8Array(buf), { level: buf.byteLength > 4_000_000 ? 1 : 4 });
            return new Response(body, {
              status: res.status,
              headers: { "content-type": "application/json", "content-encoding": zstd ? "zstd" : "gzip", "vary": "accept-encoding" },
            });
          }
          return new Response(buf, { status: res.status, headers: { "content-type": "application/json" } });
        }
        return res;
      } catch (e) {
        return err(e?.message || String(e), 500);
      }
    }
    const gzipOk = /\bgzip\b/.test(req.headers.get("accept-encoding") || "");
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const f = Bun.file(ASSETS_DIR + "/index.html");
      if (gzipOk) return new Response(Bun.gzipSync(new Uint8Array(await f.arrayBuffer()), { level: 4 }),
        { headers: { "content-type": "text/html;charset=utf-8", "content-encoding": "gzip", "vary": "accept-encoding" } });
      return new Response(f);
    }
    if (url.pathname.startsWith("/js/") && !url.pathname.includes("..") && url.pathname.endsWith(".js")) {
      const f = Bun.file(ASSETS_DIR + url.pathname);
      if (await f.exists()) {
        if (gzipOk) {
          return new Response(Bun.gzipSync(new Uint8Array(await f.arrayBuffer()), { level: 4 }),
            { headers: { "content-type": "text/javascript;charset=utf-8", "content-encoding": "gzip", "vary": "accept-encoding" } });
        }
        return new Response(f, { headers: { "content-type": "text/javascript;charset=utf-8" } });
      }
    }
    if (url.pathname.startsWith("/assets/") && !url.pathname.includes("..")) {
      const f = Bun.file(ASSETS_DIR + url.pathname);
      if (await f.exists()) {
        if (gzipOk && url.pathname.endsWith(".css")) {
          return new Response(Bun.gzipSync(new Uint8Array(await f.arrayBuffer()), { level: 4 }),
            { headers: { "content-type": "text/css", "content-encoding": "gzip", "vary": "accept-encoding", "cache-control": "public, max-age=86400" } });
        }
        return new Response(f, { headers: { "cache-control": "public, max-age=86400" } });
      }
    }
    return new Response("Not found", { status: 404 });
  },
});

// tear down SSH tunnels on shutdown
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { connectionsShutdown(); process.exit(0); });

console.log(`mysql-fast-ui listening on http://${HOST}:${PORT} (MySQL ${MYSQL.host}:${MYSQL.port} as ${MYSQL.user})`);
