// auth.js — bearer-token sessions + login (with per-IP rate limiting).
import { json, err, readBody } from "./db.js";

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DESKTOP_TOKEN = process.env.DESKTOP_TOKEN || null;
if (!ADMIN_PASSWORD && !DESKTOP_TOKEN) {
  console.error("ADMIN_PASSWORD is not set in .env — refusing to start.");
  process.exit(1);
}

const sessions = new Map(); // token -> expiry epoch ms
const SESSION_TTL = 24 * 60 * 60 * 1000;

function makeToken() {
  const b = new Uint8Array(24); crypto.getRandomValues(b);
  return Buffer.from(b).toString("base64url");
}

export function checkAuth(req, url) {
  const h = req.headers.get("authorization");
  let token = h && h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) token = url.searchParams.get("token"); // for <a download> export links
  if (!token) return false;
  if (DESKTOP_TOKEN && token === DESKTOP_TOKEN) return true; // pre-shared desktop token: no expiry
  const exp = sessions.get(token);
  if (!exp || exp < Date.now()) { sessions.delete(token); return false; }
  return true;
}

// per-IP login rate limit: 5 attempts per 15 minutes, reset on success
const LOGIN_MAX = 5, LOGIN_WINDOW = 15 * 60 * 1000;
const loginAttempts = new Map(); // ip -> { count, resetAt }

export async function handleLogin(req, ip) {
  const now = Date.now();
  const key = ip || "unknown";
  let a = loginAttempts.get(key);
  if (a && a.resetAt < now) { loginAttempts.delete(key); a = null; }
  if (a && a.count >= LOGIN_MAX) {
    const mins = Math.ceil((a.resetAt - now) / 60000);
    return err(`Too many failed attempts — try again in ${mins} min`, 429);
  }
  const body = await readBody(req);
  if (!body || body.password !== ADMIN_PASSWORD) {
    if (!a) { a = { count: 0, resetAt: now + LOGIN_WINDOW }; loginAttempts.set(key, a); }
    a.count++;
    return err("Invalid password", 401);
  }
  loginAttempts.delete(key);
  const token = makeToken();
  sessions.set(token, now + SESSION_TTL);
  return json({ token });
}
