// ai.js — Claude API proxy for NL→SQL generation and error fixing.
// Raw fetch, no SDK (project is zero-npm-dep). The API key never reaches the browser;
// errors are mapped to generic messages so neither the key nor raw provider bodies leak.
import { json, err } from "./db.js";
import { fetchSchema, fetchFks } from "./schema.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const MODEL = () => process.env.AI_MODEL || "claude-opus-4-8";
export const aiConfigured = () => !!process.env.ANTHROPIC_API_KEY;

const STATIC_INSTRUCTIONS = `You are a MySQL expert embedded in a database console.
Write a single valid MySQL statement (or a short statement batch when genuinely required) for the user's request, using ONLY the tables and columns in the provided schema — never invent identifiers.
Rules:
- Return the SQL in one \`\`\`sql fenced block, followed by exactly one short plain-language sentence describing what it does.
- Prefer SELECT; never produce destructive operations (DROP/DELETE/UPDATE/TRUNCATE) unless the user explicitly asks for them.
- Quote identifiers with backticks only when necessary (reserved words, special chars). Add LIMIT 100 to open-ended SELECTs.
- MySQL 8.0 supports window functions, CTEs, and JSON functions — use them when appropriate.`;

// compact, deterministic schema summary — stable text caches well (prompt caching is a prefix match)
async function summarizeSchema(db, connId = 0) {
  const [schema, fks] = await Promise.all([fetchSchema(db, connId), fetchFks(db, connId)]);
  const cols = new Map();
  for (const c of schema.columns) {
    const k = `${c.schema}.${c.table}`;
    if (!cols.has(k)) cols.set(k, []);
    cols.get(k).push(`${c.name} ${c.type}${c.nullable ? "" : " NOT NULL"}`);
  }
  const pkOf = new Map(schema.pks.map(p => [`${p.schema}.${p.table}`, p.cols || []]));
  const lines = [`Database: ${db}`];
  for (const t of schema.tables) {
    const k = `${t.schema}.${t.name}`;
    const pk = pkOf.get(k);
    lines.push(`${t.name}(${(cols.get(k) || []).join(", ")})${pk?.length ? ` PK(${pk.join(",")})` : ""}`);
  }
  for (const f of fks) {
    lines.push(`fk: ${f.src_table}.${f.src_cols.join(",")} -> ${f.dst_table}.${f.dst_cols.join(",")}`);
  }
  return lines.join("\n");
}

function extractSql(text) {
  const fence = text.match(/```sql\s*\n([\s\S]*?)```/i) || text.match(/```\s*\n([\s\S]*?)```/);
  const sql = (fence ? fence[1] : text).trim();
  const explanation = fence ? text.slice(text.indexOf(fence[0]) + fence[0].length).trim().split("\n")[0].trim() : "";
  return { sql, explanation };
}

export async function handleAi({ db, mode, question, sql, error, connId = 0 }) {
  if (!aiConfigured()) return err("AI not configured — set ANTHROPIC_API_KEY in .env", 503);

  let userContent;
  if (mode === "fix") {
    if (!sql || !error) return err("fix mode expects { sql, error }");
    userContent = `This MySQL SQL failed:\n\`\`\`sql\n${sql}\n\`\`\`\n\nError:\n${error}\n\nReturn the corrected MySQL SQL.`;
  } else {
    if (!question?.trim()) return err("generate mode expects { question }");
    userContent = question.trim();
  }

  let schemaSummary;
  try { schemaSummary = await summarizeSchema(db, connId); }
  catch (e) { return err("Could not read the schema: " + (e?.message || e), 500); }

  let res;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL(),
        max_tokens: 2000,
        thinking: { type: "adaptive" },
        system: [
          { type: "text", text: STATIC_INSTRUCTIONS },
          { type: "text", text: schemaSummary, cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: userContent }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (e) {
    if (e?.name === "TimeoutError" || e?.name === "AbortError") return err("AI request timed out", 504);
    console.error("AI fetch failed:", e?.message);
    return err("AI temporarily unreachable", 502);
  }

  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json())?.error?.message || ""; } catch {}
    console.error(`AI upstream ${res.status}: ${detail.slice(0, 300)}`);
    if (res.status === 401 || res.status === 403) return err("AI auth failed — check ANTHROPIC_API_KEY", 502);
    if (res.status === 429) {
      const retry = res.headers.get("retry-after");
      return err(`AI rate limited — retry ${retry ? "in " + retry + "s" : "shortly"}`, 429);
    }
    if (res.status === 400) return err("AI rejected the request (model/config issue — see server log)", 502);
    return err("AI temporarily unavailable", 502);
  }

  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n").trim();
  if (!text) return err("AI returned an empty response", 502);
  const { sql: outSql, explanation } = extractSql(text);
  if (!outSql) return err("AI response contained no SQL", 502);
  const u = data.usage || {};
  console.log(`ai ${mode} db=${db} in=${u.input_tokens} cache_w=${u.cache_creation_input_tokens} cache_r=${u.cache_read_input_tokens} out=${u.output_tokens}`);
  return json({ sql: outSql, explanation });
}
