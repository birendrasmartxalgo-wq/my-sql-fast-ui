// connections.js — multi-server connection registry: AES-256-GCM-encrypted credential
// store (bun:sqlite), SSH tunnels via the system ssh client (Bun.spawn, PEM-key auth),
// and the connTarget() resolver every route uses to reach the right MySQL server.
// Connection id 0 is the built-in local server from .env (never stored, never deletable).
import { store } from "./store.js";
import { SQL } from "bun";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdirSync, writeFileSync, chmodSync, unlinkSync, existsSync, readFileSync } from "node:fs";

// APP_DATA_DIR: per-user writable dir in a packaged desktop build (holds the
// encrypted-credential sqlite store, secret.key, and transient PEM keys); dev default ./data.
const DATA_DIR = process.env.APP_DATA_DIR || import.meta.dir + "/../data";
const KEY_DIR = DATA_DIR + "/keys";
// SSH_BIN lets the desktop shell point at a bundled OpenSSH client; dev default = PATH `ssh`.
const SSH_BIN = process.env.SSH_BIN || "ssh";

// ---------------------------------------------------------------- encryption at rest
// 32-byte key from SECRET_KEY in .env (hex or base64), else data/secret.key (0600,
// auto-generated). Encrypting protects the sqlite file alone (backups, copies) — the
// key file must be excluded from anything that leaves this box.
function loadSecret() {
  const env = process.env.SECRET_KEY;
  if (env) {
    const buf = /^[0-9a-f]{64}$/i.test(env) ? Buffer.from(env, "hex") : Buffer.from(env, "base64");
    if (buf.length === 32) return buf;
    console.error("SECRET_KEY is set but is not 32 bytes (hex/base64) — falling back to data/secret.key");
  }
  const path = DATA_DIR + "/secret.key";
  if (existsSync(path)) return Buffer.from(readFileSync(path, "utf8").trim(), "hex");
  const key = randomBytes(32);
  writeFileSync(path, key.toString("hex") + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
  return key;
}
const SECRET = loadSecret();

export function encrypt(plain) {
  if (plain == null || plain === "") return null;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", SECRET, iv);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}
export function decrypt(blob) {
  if (!blob) return null;
  const buf = Buffer.from(blob, "base64");
  const d = createDecipheriv("aes-256-gcm", SECRET, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}

// ---------------------------------------------------------------- registry (bun:sqlite)
store.exec(`
  CREATE TABLE IF NOT EXISTS connections (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color TEXT,
    host TEXT NOT NULL,
    port INTEGER NOT NULL DEFAULT 3306,
    username TEXT NOT NULL,
    password_enc TEXT,
    ssh_host TEXT,
    ssh_port INTEGER,
    ssh_user TEXT,
    ssh_key_enc TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )
`);

const LOCAL = () => ({
  id: 0, name: "Local", color: "#7a8c5d", builtin: true,
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3306),
  username: process.env.MYSQL_USER || "root",
  ssh: false, hasPassword: true,
});

const sanitize = (r) => ({
  id: r.id, name: r.name, color: r.color, host: r.host, port: r.port,
  username: r.username,
  ssh: !!r.ssh_host,
  ssh_host: r.ssh_host || null, ssh_port: r.ssh_port || null, ssh_user: r.ssh_user || null,
  hasPassword: !!r.password_enc, hasKey: !!r.ssh_key_enc,
  created_at: r.created_at, updated_at: r.updated_at,
});

export function listConnections() {
  const rows = store.prepare("SELECT * FROM connections ORDER BY name").all();
  return [LOCAL(), ...rows.map(sanitize)];
}
export function getConnRow(id) {
  if (Number(id) === 0) return LOCAL();
  return store.prepare("SELECT * FROM connections WHERE id = ?").get(Number(id)) || null;
}

// A human-readable default name when none is given
export function deriveName(b) {
  const user = (b.username || "root").trim() || "root";
  if (b.ssh_host?.trim()) return `${user}@${b.ssh_host.trim()} (ssh)`;
  const host = (b.host || "").trim() || "localhost";
  const port = Number(b.port) || 3306;
  return port === 3306 ? `${user}@${host}` : `${user}@${host}:${port}`;
}
function uniqueName(name, excludeId = -1) {
  const taken = new Set(store.prepare("SELECT name FROM connections WHERE id != ?")
    .all(excludeId).map(r => r.name.toLowerCase()));
  let candidate = name, n = 1;
  while (taken.has(candidate.toLowerCase())) candidate = `${name} (${++n})`;
  return candidate;
}

function validateSpec(b, { partial = false } = {}) {
  if (b.name !== undefined && b.name !== null && b.name.trim().length > 80) {
    throw new Error("Name must be 80 characters or fewer");
  }
  if (!partial || b.host !== undefined) {
    if (!b.host?.trim() || /[\s'"]/.test(b.host)) throw new Error("Host is required (no spaces/quotes)");
  }
  if (b.port !== undefined && b.port !== "" && !(Number(b.port) >= 1 && Number(b.port) <= 65535)) throw new Error("Port must be 1–65535");
  if (!partial && !b.username?.trim()) throw new Error("Username is required");
  if (b.ssh_host) {
    if (/[\s'"]/.test(b.ssh_host)) throw new Error("SSH host must not contain spaces/quotes");
    if (!b.ssh_user?.trim() || /[\s'"@]/.test(b.ssh_user)) throw new Error("SSH user is required (no spaces/quotes)");
    if (b.ssh_port !== undefined && b.ssh_port !== "" && b.ssh_port !== null && !(Number(b.ssh_port) >= 1 && Number(b.ssh_port) <= 65535)) throw new Error("SSH port must be 1–65535");
  }
}

export function createConnection(b) {
  validateSpec(b);
  if (b.ssh_host && !b.ssh_key?.trim()) throw new Error("SSH connections need a private key (PEM) — password SSH auth is not supported");
  // name is optional: derive a descriptive one (deduped) when left blank
  const name = b.name?.trim() ? b.name.trim() : uniqueName(deriveName(b));
  const now = Date.now();
  const r = store.prepare(`
    INSERT INTO connections (name, color, host, port, username, password_enc,
                             ssh_host, ssh_port, ssh_user, ssh_key_enc, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    name, b.color || null, b.host.trim(), Number(b.port) || 3306, b.username.trim(),
    encrypt(b.password),
    b.ssh_host?.trim() || null, b.ssh_host ? (Number(b.ssh_port) || 22) : null,
    b.ssh_host ? b.ssh_user.trim() : null, b.ssh_host ? encrypt(b.ssh_key.trim()) : null, now, now);
  return Number(r.lastInsertRowid);
}

export function updateConnection(id, b) {
  const cur = store.prepare("SELECT * FROM connections WHERE id = ?").get(Number(id));
  if (!cur) throw new Error("Connection not found");
  validateSpec({ ...cur, ...b, ssh_user: b.ssh_host ? (b.ssh_user ?? cur.ssh_user) : b.ssh_user }, { partial: true });
  const sshOn = b.ssh_host !== undefined ? !!b.ssh_host : !!cur.ssh_host;
  const password_enc = b.password ? encrypt(b.password) : cur.password_enc;
  const ssh_key_enc = !sshOn ? null : (b.ssh_key?.trim() ? encrypt(b.ssh_key.trim()) : cur.ssh_key_enc);
  if (sshOn && !ssh_key_enc) throw new Error("SSH connections need a private key (PEM)");
  const merged = { ...cur, ...b, ssh_host: sshOn ? (b.ssh_host ?? cur.ssh_host) : null };
  const name = b.name !== undefined && !b.name.trim()
    ? uniqueName(deriveName(merged), Number(id))
    : (b.name ?? cur.name).trim();
  store.prepare(`
    UPDATE connections SET name=?, color=?, host=?, port=?, username=?, password_enc=?,
           ssh_host=?, ssh_port=?, ssh_user=?, ssh_key_enc=?, updated_at=? WHERE id=?`).run(
    name, b.color ?? cur.color, (b.host ?? cur.host).trim(),
    Number(b.port ?? cur.port) || 3306, (b.username ?? cur.username).trim(), password_enc,
    sshOn ? (b.ssh_host ?? cur.ssh_host).trim() : null,
    sshOn ? (Number(b.ssh_port ?? cur.ssh_port) || 22) : null,
    sshOn ? (b.ssh_user ?? cur.ssh_user).trim() : null,
    ssh_key_enc, Date.now(), Number(id));
  dropTunnel(Number(id));
  return sanitize(store.prepare("SELECT * FROM connections WHERE id = ?").get(Number(id)));
}

export function deleteConnection(id) {
  dropTunnel(Number(id));
  return store.prepare("DELETE FROM connections WHERE id = ?").run(Number(id)).changes > 0;
}

// ---------------------------------------------------------------- SSH tunnels
const tunnels = new Map(); // connId -> { port, proc, stderr }
let poolCloser = null;
export function registerPoolCloser(fn) { poolCloser = fn; }

function freePort() {
  const srv = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const p = srv.port;
  srv.stop(true);
  return p;
}
const probePort = (port) => new Promise((resolve) => {
  Bun.connect({
    hostname: "127.0.0.1", port,
    socket: { open(s) { s.end(); resolve(true); }, data() {}, error() { resolve(false); }, connectError() { resolve(false); }, close() {} },
  }).catch(() => resolve(false));
});

export function dropTunnel(connId) {
  const t = tunnels.get(connId);
  if (t) { tunnels.delete(connId); try { t.proc.kill(); } catch {} }
  try { unlinkSync(`${KEY_DIR}/conn-${connId}.pem`); } catch {}
  if (poolCloser) poolCloser(connId);
}

async function ensureTunnel(row) {
  const live = tunnels.get(row.id);
  if (live && live.proc.exitCode === null) return live.port;
  if (live) dropTunnel(row.id);

  mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  const keyPath = `${KEY_DIR}/conn-${row.id}.pem`;
  let key = decrypt(row.ssh_key_enc);
  if (!key) throw new Error("No SSH key stored for this connection");
  if (!key.endsWith("\n")) key += "\n";
  writeFileSync(keyPath, key, { mode: 0o600 });
  chmodSync(keyPath, 0o600);

  const port = freePort();
  const proc = Bun.spawn([SSH_BIN, "-i", keyPath, "-p", String(row.ssh_port || 22),
    "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ExitOnForwardFailure=yes", "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
    "-N", "-L", `127.0.0.1:${port}:${row.host}:${row.port}`,
    `${row.ssh_user}@${row.ssh_host}`],
    { stdout: "ignore", stderr: "pipe", stdin: "ignore" });
  const t = { port, proc, stderr: "" };
  (async () => { for await (const chunk of proc.stderr) t.stderr += new TextDecoder().decode(chunk); })().catch(() => {});
  proc.exited.then(() => {
    if (tunnels.get(row.id) === t) {
      tunnels.delete(row.id);
      if (poolCloser) poolCloser(row.id);
      console.error(`ssh tunnel for "${row.name}" exited: ${t.stderr.trim().split("\n").pop() || "(no stderr)"}`);
    }
  });
  tunnels.set(row.id, t);

  for (let i = 0; i < 60; i++) {
    if (proc.exitCode !== null) {
      tunnels.delete(row.id);
      throw new Error("SSH tunnel failed: " + (t.stderr.trim().split("\n").filter(Boolean).pop() || `ssh exited with code ${proc.exitCode}`));
    }
    if (await probePort(port)) return port;
    await Bun.sleep(250);
  }
  dropTunnel(row.id);
  throw new Error("SSH tunnel did not come up within 15s");
}

// ---------------------------------------------------------------- target resolution
// MySQL has no "maintenance database" — we use the mysql system db for DB-level ops.
export async function connTarget(connId = 0) {
  const id = Number(connId) || 0;
  if (id === 0) {
    return { id: 0, name: "Local", host: process.env.MYSQL_HOST || "localhost",
      port: Number(process.env.MYSQL_PORT || 3306), user: process.env.MYSQL_USER || "root",
      password: process.env.MYSQL_PASSWORD || "" };
  }
  const row = getConnRow(id);
  if (!row) throw new Error(`Unknown connection id ${id}`);
  const base = { id, name: row.name, user: row.username,
    password: decrypt(row.password_enc) || "" };
  if (row.ssh_host) {
    const port = await ensureTunnel(row);
    return { ...base, host: "127.0.0.1", port };
  }
  return { ...base, host: row.host, port: row.port };
}

// ---------------------------------------------------------------- test
export async function testConnection(spec) {
  let row;
  if (spec.id !== undefined && spec.id !== null && spec.id !== "") {
    row = getConnRow(spec.id);
    if (!row) throw new Error("Connection not found");
    if (row.id === 0) row = { ...row, password_enc: null };
    row = { ...row,
      host: spec.host?.trim() || row.host, port: Number(spec.port) || row.port,
      username: spec.username?.trim() || row.username,
      password_enc: spec.password ? encrypt(spec.password) : row.password_enc,
      ssh_host: spec.ssh === false ? null : (spec.ssh_host?.trim() ?? row.ssh_host),
      ssh_port: Number(spec.ssh_port) || row.ssh_port || 22,
      ssh_user: spec.ssh_user?.trim() || row.ssh_user,
      ssh_key_enc: spec.ssh_key?.trim() ? encrypt(spec.ssh_key.trim()) : row.ssh_key_enc,
    };
  } else {
    validateSpec(spec);
    row = { id: -1, name: spec.name || "(test)", host: spec.host.trim(), port: Number(spec.port) || 3306,
      username: spec.username.trim(), password_enc: encrypt(spec.password),
      ssh_host: spec.ssh_host?.trim() || null, ssh_port: Number(spec.ssh_port) || 22,
      ssh_user: spec.ssh_user?.trim() || null,
      ssh_key_enc: spec.ssh_key?.trim() ? encrypt(spec.ssh_key.trim()) : null };
    if (row.ssh_host && !row.ssh_key_enc) throw new Error("SSH test needs the private key (PEM)");
  }
  const t0 = performance.now();
  let host = row.host, port = row.port;
  try {
    if (row.ssh_host) { port = await ensureTunnel(row); host = "127.0.0.1"; }
    const password = row.id === 0 ? (process.env.MYSQL_PASSWORD || "") : (decrypt(row.password_enc) || "");
    const enc = (s) => encodeURIComponent(s);
    const url = `mysql://${enc(row.username)}${password ? ":" + enc(password) : ""}@${enc(host)}:${port}/mysql`;
    const sql = new SQL(url);
    try {
      const [v] = await sql.unsafe("SELECT version() AS v, current_user() AS u");
      return { ok: true, ms: Math.round(performance.now() - t0),
        version: String(v.v).split(" on ")[0] || String(v.v).split(",")[0], user: String(v.u),
        via: row.ssh_host ? `ssh ${row.ssh_user}@${row.ssh_host}` : "direct" };
    } finally { await sql.close().catch(() => {}); }
  } finally {
    if (row.id === -1) dropTunnel(-1);
  }
}

export function connectionsShutdown() {
  for (const id of [...tunnels.keys()]) dropTunnel(id);
}
