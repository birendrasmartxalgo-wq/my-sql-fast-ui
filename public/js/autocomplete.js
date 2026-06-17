/* autocomplete.js — context-aware SQL completion, exposed as a CodeMirror 6 source.
   Parses the current statement up to the caret: tracks FROM/JOIN/UPDATE/INTO table
   references and their aliases, then suggests
     · tables after FROM / JOIN / UPDATE / INSERT INTO / REFERENCES
     · columns of the tables in scope after SELECT / WHERE / ON / SET / GROUP BY / …
     · only that table's columns after `alias.`
     · complete `JOIN x ON a.id = x.a_id` snippets from FK metadata after JOIN
   CodeMirror owns rendering, positioning, and Arrow/Tab/Enter/Esc — this file is just
   the candidate logic (unchanged from the legacy overlay) reading `before` (text up to
   the caret) instead of a textarea + mirror div. */

const AC_NOT_ALIAS = new Set(["where","on","set","join","left","right","inner","outer","full","cross","group","order","limit","offset","having","using","values","select","natural","union","returning","as","and","or","when","then","for","fetch"]);
const AC_TABLE_KW = new Set(["from", "join", "update", "into", "references", "table"]);
const AC_COL_KW = new Set(["select", "where", "on", "and", "or", "set", "by", "having", "returning", "using", "distinct", "when", "then", "else", "between", "coalesce"]);

function parseContext(tok, before) {
  // mask strings/comments with spaces so positions survive
  const masked = before
    .replace(/'(?:[^']|'')*('|$)/g, m => " ".repeat(m.length))
    .replace(/--[^\n]*/g, m => " ".repeat(m.length))
    .replace(/\/\*[\s\S]*?(\*\/|$)/g, m => " ".repeat(m.length));
  const stmt = masked.slice(masked.lastIndexOf(";") + 1);
  const s = schemaCache[currentDb];
  const ctx = { scope: [], aliases: new Map(), mode: null, lastKw: null, dotAlias: null };
  if (!s) return ctx;

  const resolve = raw => {
    const parts = raw.replace(/"/g, "").split(".");
    const [sch, tbl] = parts.length === 2 ? parts : [currentDb, parts[0]];
    if (s.tables.some(t => t.schema === sch && t.name === tbl)) return { schema: sch, table: tbl };
    const hit = s.tables.find(t => t.name === tbl);
    return hit ? { schema: hit.schema, table: hit.name } : null;
  };
  const tref = /\b(from|join|update|into)\s+([\w".]+)(?:\s+(?:as\s+)?("?[A-Za-z_]\w*"?))?/gi;
  let m;
  while ((m = tref.exec(stmt))) {
    const t = resolve(m[2]);
    if (!t) continue;
    let alias = m[3] ? m[3].replace(/"/g, "") : null;
    if (alias && AC_NOT_ALIAS.has(alias.toLowerCase())) alias = null;
    const entry = { ...t, alias: alias || t.table };
    ctx.scope.push(entry);
    ctx.aliases.set(entry.alias.toLowerCase(), entry);
    ctx.aliases.set(t.table.toLowerCase(), entry);
  }
  const beforeTok = stmt.slice(0, stmt.length - tok.length);
  const dm = beforeTok.match(/("?[A-Za-z_]\w*"?)\.$/);
  if (dm) ctx.dotAlias = dm[1].replace(/"/g, "").toLowerCase();
  const kws = [...beforeTok.matchAll(/\b(select|from|join|update|into|set|where|on|and|or|having|by|returning|references|using|table|values|when|then|else|between|limit|offset)\b/gi)];
  if (kws.length) {
    ctx.lastKw = kws[kws.length - 1][1].toLowerCase();
    if (AC_TABLE_KW.has(ctx.lastKw)) ctx.mode = "table";
    else if (AC_COL_KW.has(ctx.lastKw)) ctx.mode = "column";
  }
  return ctx;
}

/* FK-powered `JOIN x ON a.col = x.col` completions for tables already in scope */
function fkJoinSnippets(ctx, lo) {
  const s = schemaCache[currentDb];
  if (!s?.fks) return [];
  const out = [];
  const inScope = (sch, tbl) => ctx.scope.find(t => t.schema === sch && t.table === tbl);
  for (const f of s.fks) {
    const src = inScope(f.src_schema, f.src_table);
    const dst = inScope(f.dst_schema, f.dst_table);
    let other = null, anchor = null, on = null;
    if (src && !dst) { other = f.dst_table; anchor = src; on = f.src_cols.map((c, i) => [c, f.dst_cols[i]]); }
    else if (dst && !src) { other = f.src_table; anchor = dst; on = f.dst_cols.map((c, i) => [c, f.src_cols[i]]); }
    if (!other || !other.toLowerCase().startsWith(lo)) continue;
    const conds = on.map(([ac, oc]) => `${anchor.alias}.${qid(ac)} = ${other}.${qid(oc)}`).join(" AND ");
    out.push({ t: `${other} ON ${conds}`, kind: "fk join" });
    if (out.length >= 4) break;
  }
  return out;
}

function buildCandidates(tok, before) {
  const lo = tok.toLowerCase();
  const out = [];
  const s = schemaCache[currentDb];
  const ctx = parseContext(tok, before);

  // `alias.` → that table's columns only
  if (ctx.dotAlias && ctx.aliases.has(ctx.dotAlias)) {
    const t = ctx.aliases.get(ctx.dotAlias);
    for (const c of s.columns)
      if (c.schema === t.schema && c.table === t.table && c.name.toLowerCase().startsWith(lo))
        out.push({ t: c.name, kind: "col · " + t.table });
    return out.filter(x => x.t.toLowerCase() !== lo).slice(0, 50);
  }

  if (ctx.mode === "table" && s) {
    if (ctx.lastKw === "join") out.push(...fkJoinSnippets(ctx, lo));
    for (const t of s.tables) if (t.name.toLowerCase().startsWith(lo)) out.push({ t: t.name, kind: t.kind });
    for (const k of ["LEFT","RIGHT","INNER","OUTER","ON","AS","LATERAL","ONLY"]) if (k.toLowerCase().startsWith(lo)) out.push({ t: k, kind: "keyword" });
  } else if (ctx.mode === "column" && s && ctx.scope.length) {
    const seen = new Set();
    for (const t of ctx.scope)
      for (const c of s.columns)
        if (c.schema === t.schema && c.table === t.table && c.name.toLowerCase().startsWith(lo) && !seen.has(c.name)) {
          seen.add(c.name);
          out.push({ t: c.name, kind: "col · " + t.table });
        }
    for (const k of SQL_KEYWORDS) if (k.toLowerCase().startsWith(lo)) out.push({ t: k, kind: "keyword" });
  } else {
    for (const k of SQL_KEYWORDS) if (k.toLowerCase().startsWith(lo)) out.push({ t: k, kind: "keyword" });
    if (s) {
      for (const t of s.tables) if (t.name.toLowerCase().startsWith(lo)) out.push({ t: t.name, kind: t.kind });
      const seen = new Set();
      for (const c of s.columns) if (c.name.toLowerCase().startsWith(lo) && !seen.has(c.name)) { seen.add(c.name); out.push({ t: c.name, kind: "col · " + c.table }); }
    }
  }
  return out.filter(x => x.t.toLowerCase() !== lo).slice(0, 50);
}

/* map our candidate "kind" to a CodeMirror completion type (drives the left-edge swatch) */
function acType(kind) {
  if (kind === "keyword") return "keyword";
  if (kind === "fk join") return "class";
  if (kind.startsWith("col")) return "property";
  return "variable"; // tables / views
}

/* CodeMirror 6 CompletionSource — registered by editor.js via window.pgCompletionSource */
window.pgCompletionSource = function (context) {
  const before = context.state.sliceDoc(0, context.pos);
  const word = context.matchBefore(/[\w$]+/);
  const afterDot = /[\w"]\.$/.test(before);
  const tok = word ? word.text : "";
  if (tok.length < 2 && !afterDot) return null;
  if (typeof schemaCache === "undefined" || !schemaCache[currentDb]) {
    // no schema loaded yet: keyword-only fallback so the editor is still helpful
    if (tok.length < 2) return null;
  }
  const items = buildCandidates(tok, before);
  if (!items.length) return null;
  return {
    from: word ? word.from : context.pos,
    options: items.map(x => ({ label: x.t, type: acType(x.kind), detail: x.kind })),
    validFor: /^[\w$]*$/,
  };
};

/* legacy no-op: runQuery()/runExplain() still call hideAc(); CM6 closes its own popup */
function hideAc() {}
