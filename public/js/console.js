/* console.js — query console: run, browse (keyset pagination), results grid,
   inline cell editing, export, cell inspector, query history. */

function setEditorSql(sql) { CM.setDoc(sql); }
function appendToEditor(sql) {
  const cur = CM.getDoc();
  CM.setDoc((cur ? cur.replace(/\s*$/, "\n\n") : "") + sql + "\n");
  CM.focus();
}

/* ════════════════ templates — built from your real tables & columns ════════════════ */
const SQL_TEMPLATES = [
  { key: "select", label: "SELECT",        table: true, generic: "SELECT * FROM table_name LIMIT 100;" },
  { key: "insert", label: "INSERT",        table: true, generic: "INSERT INTO table_name (col1, col2) VALUES (val1, val2);" },
  { key: "update", label: "UPDATE",        table: true, generic: "UPDATE table_name SET col1 = val1 WHERE condition;" },
  { key: "delete", label: "DELETE",        table: true, generic: "DELETE FROM table_name WHERE condition;" },
  { key: "join",   label: "JOIN (via FK)", table: true, generic: "SELECT *\nFROM table_a a\nJOIN table_b b ON b.id = a.b_id;" },
  { key: "index",  label: "CREATE INDEX",  table: true, generic: "CREATE INDEX idx_name ON table_name (col_name);" },
  { key: "createtable", label: "CREATE TABLE", sql: "CREATE TABLE table_name (\n  id BIGINT AUTO_INCREMENT PRIMARY KEY,\n  name VARCHAR(255) NOT NULL,\n  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP\n);" },
  { key: "altertable",  label: "ALTER TABLE",  sql: "ALTER TABLE table_name ADD COLUMN col_name VARCHAR(255);" },
  { key: "droptable",   label: "DROP TABLE",   sql: "DROP TABLE IF EXISTS table_name;" },
  { key: "role",   label: "CREATE USER (DCL)", sql: "CREATE USER 'username'@'localhost' IDENTIFIED BY 'change-me';" },
  { key: "grant",  label: "GRANT (DCL)",       sql: "GRANT SELECT, INSERT, UPDATE ON table_name TO role_name;" },
  { key: "revoke", label: "REVOKE (DCL)",      sql: "REVOKE ALL ON table_name FROM role_name;" },
  { key: "tx",      label: "Transaction",      sql: "BEGIN;\n-- statements…\nCOMMIT;" },
  { key: "explain", label: "EXPLAIN ANALYZE",  sql: "EXPLAIN ANALYZE SELECT * FROM table_name;" },
];
document.getElementById("snippets").innerHTML =
  '<option value="">Templates…</option>' + SQL_TEMPLATES.map(t => `<option value="${t.key}">${esc(t.label)}</option>`).join("");

async function insertSnippet() {
  const sel = document.getElementById("snippets");
  const t = SQL_TEMPLATES.find(x => x.key === sel.value);
  sel.value = "";
  if (!t) return;
  if (!t.table) return appendToEditor(t.sql);
  // table-aware template: fall back to the generic snippet when no schema is at hand
  if (!currentDb) return appendToEditor(t.generic);
  if (!schemaCache[currentDb]) {
    try { schemaCache[currentDb] = await api("/api/schema?db=" + encodeURIComponent(currentDb)); }
    catch { return appendToEditor(t.generic); }
  }
  if (!schemaCache[currentDb].tables.length) return appendToEditor(t.generic);
  openTemplateModal(t);
}

/* typed example value for a column — what a human would write there */
function tplPlaceholder(c) {
  const t = c.type.toLowerCase();
  if (/bool/.test(t)) return "true";
  if (/int|numeric|real|double|decimal/.test(t)) return "0";
  if (t === "date") return "'2026-01-01'";
  if (/timestamp/.test(t)) return "now()";
  if (/json/.test(t)) return `'{}'`;
  if (/uuid/.test(t)) return "UUID()";
  return "'value'";
}
function tplMeta(fqv) {
  const [schema, table] = fqv.split(".");
  const s = schemaCache[currentDb];
  const cols = s.columns.filter(c => c.schema === schema && c.table === table);
  const pk = (s.pks.find(p => p.schema === schema && p.table === table) || {}).cols || [];
  const fq = (schema === currentDb ? "" : qid(schema) + ".") + qid(table);
  return { schema, table, fq, cols, pk, fks: s.fks || [] };
}
function buildTemplateSql(t, fqv) {
  const m = tplMeta(fqv);
  const nonPk = m.cols.filter(c => !m.pk.includes(c.name));
  const pkCond = m.pk.length
    ? m.pk.map(k => `${qid(k)} = ${tplPlaceholder(m.cols.find(c => c.name === k) || { type: "" })}`).join(" AND ")
    : "/* condition */";
  if (t.key === "select")
    return `SELECT ${m.cols.map(c => qid(c.name)).join(", ")}\nFROM ${m.fq}\nLIMIT 100;`;
  if (t.key === "insert") {
    const ins = m.cols.filter(c => !c.dflt); // defaulted/identity columns fill themselves
    if (!ins.length) return `INSERT INTO ${m.fq} DEFAULT VALUES;`;
    return `INSERT INTO ${m.fq} (${ins.map(c => qid(c.name)).join(", ")})\nVALUES (${ins.map(tplPlaceholder).join(", ")});`;
  }
  if (t.key === "update") {
    const sets = (nonPk.length ? nonPk : m.cols).slice(0, 3)
      .map(c => `${qid(c.name)} = ${tplPlaceholder(c)}`).join(",\n    ");
    return `UPDATE ${m.fq}\nSET ${sets}\nWHERE ${pkCond};`;
  }
  if (t.key === "delete") return `DELETE FROM ${m.fq}\nWHERE ${pkCond};`;
  if (t.key === "join") {
    const fk = m.fks.find(f => f.src_schema === m.schema && f.src_table === m.table)
      || m.fks.find(f => f.dst_schema === m.schema && f.dst_table === m.table);
    if (!fk) return `-- ${m.table} has no foreign keys — joining on a shared column instead\nSELECT *\nFROM ${m.fq} a\nJOIN other_table b ON b.id = a.other_id;`;
    const out = fk.src_schema === m.schema && fk.src_table === m.table;
    const other = out ? { schema: fk.dst_schema, table: fk.dst_table } : { schema: fk.src_schema, table: fk.src_table };
    const otherFq = (other.schema === currentDb ? "" : qid(other.schema) + ".") + qid(other.table);
    const on = fk.src_cols.map((sc, i) =>
      out ? `b.${qid(fk.dst_cols[i])} = a.${qid(sc)}` : `b.${qid(sc)} = a.${qid(fk.dst_cols[i])}`).join(" AND ");
    return `SELECT *\nFROM ${m.fq} a\nJOIN ${otherFq} b ON ${on}\nLIMIT 100;`;
  }
  if (t.key === "index") {
    const col = (nonPk[0] || m.cols[0]).name;
    return `CREATE INDEX ${qid(`idx_${m.table}_${col}`.replace(/\W/g, "_"))} ON ${m.fq} (${qid(col)});`;
  }
  return t.generic;
}
let tplActive = null;
function openTemplateModal(t) {
  tplActive = t;
  const s = schemaCache[currentDb];
  const tables = /^(select|join)$/.test(t.key) ? s.tables : s.tables.filter(x => x.kind !== "view");
  const cur = activeTable && tables.some(x => x.schema === activeTable.schema && x.name === activeTable.name)
    ? activeTable.schema + "." + activeTable.name : tables[0].schema + "." + tables[0].name;
  openModal(`
    <div class="flex items-center gap-2.5 px-5 py-4 border-b border-rule-700">
      <span class="text-quill-400" data-ic="terminal" data-s="15"></span>
      <span class="font-display font-semibold text-[16px]">${esc(t.label)} · pick a table</span>
      <button class="btn btn-sm btn-icon ml-auto" onclick="closeModal()"><span data-ic="x" data-s="13"></span></button>
    </div>
    <div class="px-5 py-4 flex flex-col gap-3 overflow-y-auto min-h-0">
      <div class="flex items-center gap-2">
        <span class="mlabel">table</span>
        <select id="tpl-table" class="input text-xs py-1.5 font-mono flex-1" oninput="renderTemplateSql()">
          ${tables.map(x => { const v = x.schema + "." + x.name;
            return `<option value="${esc(v)}" ${v === cur ? "selected" : ""}>${esc((x.schema === currentDb ? "" : x.schema + ".") + x.name)}${x.kind === "view" ? " · view" : ""}</option>`; }).join("")}
        </select>
      </div>
      <div class="mlabel">generated from the live schema — placeholders use each column's type</div>
      <pre class="sqlblock max-h-72 overflow-y-auto" id="tpl-sql"></pre>
    </div>
    <div class="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-rule-700">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-primary" onclick="insertTemplateSql()"><span data-ic="terminal" data-s="13"></span>Insert into console</button>
    </div>`);
  hydrateIcons(modalCard);
  renderTemplateSql();
}
function renderTemplateSql() {
  const sel = document.getElementById("tpl-table");
  if (!sel || !tplActive) return;
  document.getElementById("tpl-sql").innerHTML = hlSql(buildTemplateSql(tplActive, sel.value));
}
function insertTemplateSql() {
  const sel = document.getElementById("tpl-table");
  if (sel && tplActive) appendToEditor(buildTemplateSql(tplActive, sel.value));
  closeModal();
}
/* PK + column types for a table, from the schema cache */
function lookupTableMeta(schema, table) {
  const cache = schemaCache[currentDb];
  if (!cache) return null;
  const pk = (cache.pks.find(p => p.schema === schema && p.table === table) || {}).cols || [];
  if (!pk.length) return null;
  const cols = cache.columns.filter(c => c.schema === schema && c.table === table);
  return { schema, table, pk, types: Object.fromEntries(cols.map(c => [c.name, c.type])) };
}
/* if the run is a plain single-table SELECT * and we know its PK, results are editable */
function detectEditable(sql) {
  const m = sql.trim().match(/^select\s+\*\s+from\s+(?:"([^"]+)"\.)?"?([\w]+)"?\s*(?:limit\s+\d+)?\s*;?\s*$/i);
  return m ? lookupTableMeta(m[1] || currentDb, m[2]) : null;
}
let lastRun = null; // { sql, results, editable }

/* ════════════════ table browse: sort + keyset (cursor) pagination ════════════════
   Interactions compile to SQL — the grid never sorts the DOM. "Next" anchors on the
   last row of the page: WHERE (sort_col, pk…) > (cursor values), never OFFSET. */
let browse = null; // { schema, table, pk, types, sort:{col,dir}|null, pages:[cursorRow|null], page, limit }
function browseFq() { return (browse.schema === currentDb ? "" : qid(browse.schema) + ".") + qid(browse.table); }
function compileBrowse() {
  const s = browse.sort;
  const dir = s ? s.dir : "ASC";
  const op = dir === "ASC" ? ">" : "<";
  const orderCols = s ? [s.col, ...browse.pk.filter(k => k !== s.col)] : [...browse.pk];
  const order = orderCols.map(c => `${qid(c)} ${dir}`).join(", ");
  let where = "";
  const cur = browse.pages[browse.page]; // last row of the previous page, or null on page 1
  if (!cur && browse.page > 0) // jumped here — no keyset anchor yet, fall back to OFFSET once
    return `SELECT * FROM ${browseFq()}\nORDER BY ${order}\nLIMIT ${browse.limit} OFFSET ${browse.page * browse.limit};`;
  if (cur) {
    const pkTuple = browse.pk.length === 1 ? qid(browse.pk[0]) : `(${browse.pk.map(qid).join(", ")})`;
    const pkVals = browse.pk.length === 1 ? sqlLit(cur[browse.pk[0]], browse.types[browse.pk[0]] || "")
      : `(${browse.pk.map(k => sqlLit(cur[k], browse.types[k] || "")).join(", ")})`;
    if (!s) where = `WHERE ${pkTuple} ${op} ${pkVals}`;
    else {
      const c = qid(s.col), v = cur[s.col];
      if (v === null || v === undefined) where = `WHERE ${c} IS NULL AND ${pkTuple} ${op} ${pkVals}`;
      else {
        const lit = sqlLit(v, browse.types[s.col] || "");
        where = `WHERE (${c} ${op} ${lit} OR (${c} = ${lit} AND ${pkTuple} ${op} ${pkVals}) OR ${c} IS NULL)`;
      }
    }
  }
  return `SELECT * FROM ${browseFq()}\n${where ? where + "\n" : ""}ORDER BY ${order}\nLIMIT ${browse.limit};`;
}
function browseRun() {
  const lim = Number(document.getElementById("maxrows").value) || 100;
  if (lim !== browse.limit && browse.page > 0) { browse.pages = [null]; browse.page = 0; } // page size changed → cursors stale, restart at row 1
  browse.limit = lim;
  setEditorSql(compileBrowse());
  runQuery(true, lookupTableMeta(browse.schema, browse.table));
}
function browseSort(col) {
  if (!browse) return;
  browse.sort = !browse.sort || browse.sort.col !== col ? { col, dir: "ASC" }
    : browse.sort.dir === "ASC" ? { col, dir: "DESC" } : null;
  browse.pages = [null]; browse.page = 0;
  browseRun();
}
function browseNext() {
  const r = lastRun?.results[0];
  if (!browse || !r?.rows.length) return;
  browse.pages[browse.page + 1] = r.rows[r.rows.length - 1];
  browse.page++;
  browseRun();
}
function browsePrev() { if (browse && browse.page > 0) { browse.page--; browseRun(); } }
function browseJump(pageNo) {
  if (!browse) return;
  const p = Math.max(1, Math.floor(Number(pageNo) || 1)) - 1;
  if (p === browse.page) return;
  browse.page = p; // compileBrowse falls back to OFFSET when this page has no anchor
  browseRun();
}

/* /api/query ships rows as value-arrays (column names once, not per row — ~2x smaller
   and faster to parse). Rebuild the {col: value} objects the rest of the console expects. */
function unpackResults(results) {
  for (const r of results) {
    if (!r.ok || !r.packed || !r.rows.length) continue;
    const cols = r.columns;
    r.rows = r.rows.map(a => { const o = {}; for (let i = 0; i < cols.length; i++) o[cols[i]] = a[i]; return o; });
    r.packed = false;
  }
}

/* ════════════════ custom-query paging — LIMIT/OFFSET wrapper around any SELECT ════════════════ */
let qpage = null; // { sql (no trailing ;), page, pageSize, hasNext, total, disabled }
function pageableSql(sql) {
  // one statement, SELECT-shaped, and not SELECT … INTO (strings/comments stripped first)
  const clean = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const stmts = clean.split(";").map(s => s.trim()).filter(Boolean);
  if (stmts.length !== 1) return false;
  return /^(select|with|table|values)\b/i.test(stmts[0]) && !/\binto\b/i.test(stmts[0]);
}
/* A trailing top-level LIMIT/OFFSET must come OUT of the SQL and INTO the paging
   math — left inside the wrapper, `(… LIMIT 100000) OFFSET 100000` is empty by
   construction. End-anchored, so subquery LIMITs (`(… LIMIT 5) x`) are never touched. */
function stripTrailingLimit(sql) {
  let userLimit = null, userOffset = 0, s = sql.trim();
  for (let pass = 0; pass < 2; pass++) { // LIMIT and OFFSET can trail in either order
    let m;
    if ((m = s.match(/\blimit\s+(\d+|all)\s*$/i))) {
      if (m[1].toLowerCase() !== "all") userLimit = Number(m[1]);
      s = s.slice(0, m.index).trim();
    } else if ((m = s.match(/\boffset\s+(\d+)(\s+rows?)?\s*$/i))) {
      userOffset = Number(m[1]);
      s = s.slice(0, m.index).trim();
    } else break;
  }
  return { sql: s, userLimit, userOffset };
}
function qpageGo(p) {
  if (!qpage || p < 0) return;
  const ps = qpage.pageSize || 1;
  if (qpage.userLimit != null && p * ps >= qpage.userLimit)
    return toast(`Your query's LIMIT ${qpage.userLimit} caps paging at page ${Math.max(1, Math.ceil(qpage.userLimit / ps))} — raise or remove it to go further`, true);
  if (qpage.total != null && p * ps >= qpage.total && p > 0)
    return toast(`Only ${qpage.total} rows — page ${Math.max(1, Math.ceil(qpage.total / ps))} is the last`, true);
  qpage.page = p;
  runQuery(true, null, true);
}
function qpageMove(dir) { if (qpage) qpageGo(qpage.page + dir); }
function qpageJump(v) {
  const p = Math.max(1, Math.floor(Number(v) || 1)) - 1;
  if (qpage && p !== qpage.page) qpageGo(p);
}
async function qpageCount(btn) {
  if (!qpage) return;
  btn.textContent = "counting…"; btn.disabled = true;
  try {
    const { results } = await api("/api/query", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ db: currentDb, sql: `SELECT count(*) AS n FROM (\n${qpage.sql}\n) AS _count`, maxRows: 1 }),
    });
    if (!results[0]?.ok) return toast(results[0]?.error || "count failed", true);
    unpackResults(results);
    // the count runs over the stripped SQL — clamp to the query's own LIMIT/OFFSET window
    const raw = Number(results[0].rows[0]?.n);
    qpage.total = Math.max(0, Math.min(raw - qpage.userOffset, qpage.userLimit ?? Infinity));
    const pager = document.getElementById("qpager");
    if (pager && lastRun?.results[0]) pager.outerHTML = buildQPager(lastRun.results[0]);
  } catch (e) { toast(e.message, true); }
}
function buildQPager(r) {
  const start = qpage.page * qpage.pageSize + 1;
  const end = start + r.rows.length - 1;
  const atCap = !qpage.hasNext && qpage.userLimit != null && end >= qpage.userLimit;
  const rangeTitle = atCap ? `your query's LIMIT ${qpage.userLimit} is the cap — raise or remove it to page further` : "";
  return `
    <span id="qpager" class="flex items-center gap-1.5 mx-1">
      <button class="btn btn-sm" data-qpg="prev" ${qpage.page === 0 ? 'disabled style="opacity:.4"' : ""}>◂ Prev</button>
      <span class="chip chip-quill" title="${esc(rangeTitle)}">${r.rows.length ? `rows ${start}–${end}` : `page ${qpage.page + 1} · empty`}${qpage.total != null ? ` of ${qpage.total}` : qpage.hasNext ? "" : " · end"}</span>
      <button class="btn btn-sm" data-qpg="next" ${qpage.hasNext ? "" : 'disabled style="opacity:.4"'}>Next ▸</button>
      <input data-qjump class="input w-16 py-0.5 text-[11px] font-mono" value="${qpage.page + 1}" title="Type a page number and press Enter">
      ${qpage.total == null
        ? `<button class="btn btn-sm" data-qcount title="Run SELECT count(*) over your query — may be slow on big tables">total?</button>`
        : `<span class="chip" title="${qpage.total} rows">${Math.max(1, Math.ceil(qpage.total / qpage.pageSize))} pages</span>`}
    </span>`;
}

let __runOverride = null;
/* run a specific snippet (a selection or the statement under the cursor) without
   touching the editor doc; bypasses paging since it isn't the whole-editor query */
function runQuerySql(text) { if (text && text.trim()) { __runOverride = text; runQuery(); } }
/* keep the Run button label in step with the editor selection */
window.onCMSelection = hasSel => {
  const lbl = document.getElementById("runbtn-label");
  if (lbl) lbl.textContent = hasSel ? "Run selection" : "Run";
};
/* Run button: if text is selected in the editor, run only that — otherwise run all. */
function runEditor() {
  const sel = window.CM && CM.selText ? CM.selText() : "";
  if (sel && sel.trim()) return runQuerySql(sel);
  runQuery();
}
async function runQuery(skipConfirm = false, editableOverride = null, pageMove = false) {
  if (!currentDb) return toast("Select a database in the sidebar first", true);
  const override = __runOverride; __runOverride = null;
  const sql = (override != null ? override : CM.getDoc()).trim();
  if (!sql) return;
  hideAc();
  CM.clearErrors();
  if (!skipConfirm) {
    const warns = classifyDanger(sql);
    if (warns.length && !(await confirmDanger(warns, sql))) return;
  }
  if (!editableOverride) browse = null; // hand-run SQL leaves browse mode
  if (!pageMove) // fresh run from the editor — (re)enter paging mode if the SQL allows it
    qpage = !editableOverride && override == null && pageableSql(sql)
      ? { ...stripTrailingLimit(sql.replace(/;\s*$/, "")), page: 0, pageSize: 0, hasNext: false, total: null, disabled: false } : null;
  pending.clear(); renderSaveBar();
  const out = document.getElementById("results");
  const sumEl = document.getElementById("runsummary");
  sumEl.innerHTML = `<span class="chip"><span class="led led-amber"></span>running on ${esc(currentDb)}…</span>`;
  out.innerHTML = "";
  const qp = qpage && !qpage.disabled ? qpage : null;
  let execSql = sql, effLimit = 0;
  if (qp) {
    qp.pageSize = Number(document.getElementById("maxrows").value) || 100;
    // the query's own LIMIT/OFFSET define the paging universe (stripTrailingLimit pulled them out)
    effLimit = qp.userLimit == null ? qp.pageSize : Math.max(0, Math.min(qp.pageSize, qp.userLimit - qp.page * qp.pageSize));
    execSql = `SELECT * FROM (\n${qp.sql}\n) AS _page LIMIT ${effLimit} OFFSET ${qp.userOffset + qp.page * qp.pageSize}`;
  }
  const t0 = performance.now();
  try {
    const { results, serverMs } = await api("/api/query", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ db: currentDb, sql: execSql, maxRows: qp ? qp.pageSize : Number(document.getElementById("maxrows").value) || 100 }),
    });
    unpackResults(results);
    if (qp && results.length === 1 && !results[0].ok && (results[0].sqlstate === "42601" || results[0].sqlstate === "0A000")) {
      // exotic SQL that won't nest as a subquery — run it untouched, without paging
      qpage.disabled = true;
      return runQuery(true, editableOverride, true);
    }
    if (qp && results[0]?.ok)
      qp.hasNext = (effLimit > 0 && results[0].rows.length === effLimit &&
                    (qp.userLimit == null || (qp.page + 1) * qp.pageSize < qp.userLimit)) || results[0].truncated;
    const wall = Math.round(performance.now() - t0);
    const dbMs = results.reduce((a, r) => a + (r.ms || 0), 0);
    const srvMs = Math.max(0, (serverMs ?? dbMs) - dbMs); // server cost minus the time already counted as db
    const okAll = results.every(r => r.ok);
    const totalRows = results.reduce((a, r) => a + (r.ok ? r.rowCount : 0), 0);
    sumEl.innerHTML = `
      <span class="chip ${okAll ? "chip-green" : "chip-red"}"><span class="led ${okAll ? "led-green" : "led-red"}"></span>${results.length} statement${results.length === 1 ? "" : "s"}</span>
      <span class="chip" title="time inside MySQL">${ic("zap", 10)} db ${dbMs} ms</span>
      <span class="chip" title="server handling: connection pool, statement split, row shaping">${ic("server", 10)} srv ${srvMs} ms</span>
      <span class="chip" title="pure network: round-trip + transfer — this is your link to the box, not query cost">${ic("clock", 10)} wire ${Math.max(0, wall - dbMs - srvMs)} ms</span>
      <span class="chip">${totalRows} rows</span>`;
    histState.offset = 0; renderHistory(); // server recorded the run — refresh the drawer
    lastRun = { sql, results, editable: results.length === 1 && results[0].ok ? (editableOverride || detectEditable(sql)) : null };
    out.innerHTML = "";
    results.forEach((r, si) => {
      const block = document.createElement("div");
      block.className = "panel overflow-clip border-l-2 " + (r.ok ? "!border-l-quill-600" : "!border-l-red-led");
      if (!r.ok) {
        const badId = (String(r.error).match(/"([^"]+)"/) || [])[1] || "";
        block.innerHTML = `
          <div class="flex items-center gap-3 px-3 py-2 bg-paper-800 font-mono text-[11px]">
            <span class="text-red-led font-semibold">✕ ERROR${r.sqlstate ? ` · ${esc(r.sqlstate)}` : ""}</span><span class="text-ink-500 truncate">${esc((qp ? sql : r.statement).slice(0, 200))}</span>
            <span class="ml-auto text-ink-700">${r.ms} ms</span>
          </div>
          <div class="px-3 py-2.5 flex flex-col gap-1.5">
            <div class="text-red-led font-mono text-xs">${esc(r.error)}</div>
            ${r.friendly ? `<div class="text-ink-300 text-xs">${esc(r.friendly)}</div>` : ""}
            ${r.didYouMean ? `<div class="text-xs text-ink-300">did you mean <button class="chip chip-quill cursor-pointer hover:opacity-80" data-dym="${esc(r.didYouMean)}" data-bad="${esc(badId)}">${esc(r.didYouMean)}</button> ?</div>` : ""}
            ${typeof aiAvailable !== "undefined" && aiAvailable ? `<div class="flex mt-1"><button class="btn btn-sm" data-aifix="${si}">${ic("sparkles", 11)} Fix with AI</button></div>` : ""}
          </div>`;
      } else if (r.rows.length) {
        const sortable = browse && lastRun.editable && si === 0;
        const clientSortable = !lastRun.editable; // page-sort only when not editable (inline edits are row-index keyed)
        const nums = numericCols(r);
        let pager = "";
        if (sortable) {
          // row-range pager: each Next compiles the keyset query for the following window
          const start = browse.page * browse.limit + 1;
          const end = start + r.rows.length - 1;
          const atEnd = r.rows.length < browse.limit;
          const est = Number((schemaCache[currentDb]?.tables || []).find(t => t.schema === browse.schema && t.name === browse.table)?.est_rows);
          const estPages = est > 0 ? Math.max(1, Math.ceil(est / browse.limit)) : 0;
          pager = `
            <span class="flex items-center gap-1.5 mx-1">
              <button class="btn btn-sm" data-pg="prev" title="rows ${Math.max(1, start - browse.limit)}–${start - 1}" ${browse.page === 0 ? 'disabled style="opacity:.4"' : ""}>◂ ${start - browse.limit > 0 ? `${start - browse.limit}–${start - 1}` : "Prev"}</button>
              <span class="chip chip-quill">rows ${start}–${end}${atEnd ? " · end" : ""}</span>
              <button class="btn btn-sm" data-pg="next" title="rows ${end + 1}–${end + browse.limit}" ${atEnd ? 'disabled style="opacity:.4"' : ""}>${end + 1}–${end + browse.limit} ▸</button>
              <input data-bjump class="input w-16 py-0.5 text-[11px] font-mono" value="${browse.page + 1}" title="Type a page number and press Enter${estPages ? ` — ~${estPages} pages` : ""}">
              ${estPages ? `<span class="chip" title="from the planner's row estimate">~${estPages} pg</span>` : ""}
            </span>`;
        } else if (qpage && !qpage.disabled && si === 0) {
          pager = buildQPager(r);
        }
        block.innerHTML = `
          <div class="flex items-center gap-3 px-3 py-1.5 bg-paper-800 font-mono text-[11px] flex-wrap">
            <span class="text-quill-400 font-semibold">${esc(r.command || "OK")}</span>
            <span class="text-ink-500">${r.rowCount} row${r.rowCount === 1 ? "" : "s"}${r.truncated ? ` · <span class="text-amber-led">${r.byteCapped ? `stopped at the 100 MB response cap — ${r.rows.length} shown` : `first ${r.rows.length} shown`}</span>` : ""}</span>
            ${sortable && browse.sort ? `<span class="chip chip-quill">${esc(browse.sort.col)} ${browse.sort.dir === "ASC" ? "▲" : "▼"}</span>` : ""}
            <span class="text-amber-led" data-prog></span>
            <span class="ml-auto flex items-center gap-1.5">
              ${pager}
              ${sortable ? `<button class="btn btn-sm" data-newrow title="Insert a row into ${esc(browse.table)}">${ic("rowinsert", 11)}row</button>` : ""}
              <button class="btn btn-sm" data-freeze="${si}" title="Freeze the first column while scrolling sideways">${ic("table", 11)}freeze</button>
              <button class="btn btn-sm" data-exp="sql" data-si="${si}" title="Download as INSERT statements">${ic("download", 11)}sql</button>
              <button class="btn btn-sm" data-exp="csv" data-si="${si}" title="Download rows as CSV">${ic("download", 11)}csv</button>
              <button class="btn btn-sm" data-exp="json" data-si="${si}" title="Download rows as JSON">${ic("download", 11)}json</button>
              <span class="text-ink-700">${r.ms} ms</span>
            </span>
          </div>
          <div class="gridscroll max-h-[360px]" tabindex="0" aria-label="Result grid, ${r.rowCount} row${r.rowCount === 1 ? "" : "s"}"><table class="grid-table">
            <colgroup>${r.columns.map(c => `<col${r._w?.[c] ? ` style="width:${r._w[c]}px"` : ""}>`).join("")}</colgroup>
            <thead><tr>${r.columns.map(c => {
              const nc = nums.has(c) ? " num" : "", rz = `<span class="th-resizer"></span>`;
              if (sortable) return `<th scope="col" class="thsort${nc}" data-col="${esc(c)}" data-si="${si}" aria-sort="${browse.sort?.col === c ? (browse.sort.dir === "ASC" ? "ascending" : "descending") : "none"}" title="Sort by ${esc(c)}">${esc(c)}<span class="sortind">${browse.sort?.col === c ? (browse.sort.dir === "ASC" ? " ▲" : " ▼") : ""}</span>${rz}</th>`;
              if (clientSortable) return `<th scope="col" class="thsortc${nc}" data-col="${esc(c)}" data-si="${si}" aria-sort="none" title="Sort this page by ${esc(c)}">${esc(c)}<span class="sortind"></span>${rz}</th>`;
              return `<th scope="col" class="${nc}" data-col="${esc(c)}">${esc(c)}${rz}</th>`;
            }).join("")}</tr></thead>
            <tbody aria-rowcount="${r.rows.length}"></tbody></table></div>`;
        renderRowsChunked(block, r, si);
        attachResizers(block, r);
      } else if (qpage && !qpage.disabled && si === 0) {
        // an empty page must keep the pager — otherwise Prev disappears and the user is stranded
        qpage.hasNext = false;
        block.innerHTML = `
          <div class="flex items-center gap-3 px-3 py-1.5 bg-paper-800 font-mono text-[11px] flex-wrap">
            <span class="text-quill-400 font-semibold">${esc(r.command || "OK")}</span>
            <span class="${qpage.page > 0 ? "text-amber-led" : "text-ink-500"}">${qpage.page > 0 ? `page ${qpage.page + 1} is past the last row — use ◂ Prev` : "0 rows — the query matched nothing"}</span>
            <span class="ml-auto flex items-center gap-1.5">${buildQPager(r)}<span class="text-ink-700">${r.ms} ms</span></span>
          </div>`;
      } else {
        block.innerHTML = `
          <div class="flex items-center gap-3 px-3 py-2 bg-paper-800 font-mono text-[11px]">
            <span class="text-quill-400 font-semibold">${esc(r.command || "OK")}</span>
            <span class="text-ink-500">${r.rowCount} row${r.rowCount === 1 ? "" : "s"} affected</span>
            <span class="text-ink-700 truncate">${esc(r.statement)}</span>
            <span class="ml-auto text-ink-700">${r.ms} ms</span>
          </div>`;
      }
      out.appendChild(block);
    });
    const failed = results.some(r => !r.ok);
    if (override == null) CM.markErrors(results); // inline gutter/underline markers on failed statements (paged runs are single-statement, so editor offsets still line up)
    if (/\b(create|drop|alter)\b/i.test(sql) && !failed) { loadTree(currentDb); loadDatabases(); tableDefLoadedFor = null; }
  } catch (e) {
    sumEl.innerHTML = `<span class="chip chip-red"><span class="led led-red"></span>failed</span>`;
    out.innerHTML = `<div class="text-red-led font-mono text-xs">${esc(e.message)}</div>`;
  }
}

/* virtualized grid: a 1-lakh result keeps all rows in memory but only the ~80 rows
   around the viewport ever exist in the DOM — spacer rows fake the scrollbar height.
   Cells are white-space:nowrap so every row is the same height. */
const VIRTUAL_FROM = 500, VOVERSCAN = 25;
function renderRowsChunked(block, r, si) {
  const scroller = block.querySelector(".gridscroll");
  const tbody = block.querySelector("tbody");
  block.querySelector("[data-prog]")?.remove();
  const nums = numericCols(r);
  const cellHtml = (row, ri, c) => {
    const nc = nums.has(c) ? " num" : "";
    const p = pending.get(ri + ":" + c); // uncommitted inline edits survive scroll re-renders
    if (p) return `<td class="cellv pendingcell${nc}" data-si="${si}" data-ri="${ri}" data-c="${esc(c)}" title="pending: ${esc(p.text)}">${p.text === "" ? "''" : esc(p.text)}</td>`;
    const v = row[c];
    const text = v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    return `<td class="cellv${nc}" data-si="${si}" data-ri="${ri}" data-c="${esc(c)}" title="${esc(text.slice(0, 400))}">${v === null ? '<span class="text-ink-700">∅</span>' : esc(text)}</td>`;
  };
  const rowHtml = ri => `<tr data-vr="${ri}" aria-rowindex="${ri + 1}"${ri % 2 ? ' class="zebra"' : ""}>${r.columns.map(c => cellHtml(r.rows[ri], ri, c)).join("")}</tr>`;
  if (r.rows.length <= VIRTUAL_FROM) { // small grids: plain render, no machinery
    tbody.innerHTML = r.rows.map((_, ri) => rowHtml(ri)).join("");
    return;
  }
  let rowH = 24, start = -1, end = -1;
  const spacer = h => `<tr style="height:${h}px"><td colspan="${r.columns.length}" style="padding:0;border:0"></td></tr>`;
  const render = force => {
    if (tbody.querySelector("input.cellinput")) return; // don't yank an open editor out from under the user
    const s = Math.max(0, Math.floor(scroller.scrollTop / rowH) - VOVERSCAN);
    const e = Math.min(r.rows.length, Math.ceil((scroller.scrollTop + scroller.clientHeight) / rowH) + VOVERSCAN);
    if (!force && s === start && e === end) return;
    start = s; end = e;
    let html = s > 0 ? spacer(s * rowH) : "";
    for (let i = s; i < e; i++) html += rowHtml(i);
    if (e < r.rows.length) html += spacer((r.rows.length - e) * rowH);
    tbody.innerHTML = html;
  };
  render(true);
  scroller.addEventListener("scroll", () => render(false), { passive: true });
  requestAnimationFrame(() => { // now attached: calibrate row height from a real row and re-render with the true viewport
    const tr = tbody.querySelector("tr[data-vr]");
    if (tr && tr.offsetHeight) rowH = tr.offsetHeight;
    render(true);
  });
}

/* ---- grid power-ups: numeric detection, per-page sort, column resize, frozen column ---- */
// MySQL ships bigint/decimal as *strings* (to keep precision), so a
// numeric column may arrive as numbers or as numeric-looking strings — detect both.
const looksNumeric = v => typeof v === "number" || (typeof v === "string" && v !== "" && /^-?\d+(\.\d+)?$/.test(v));
function numericCols(r) {
  if (r._numc) return r._numc;
  const types = lastRun?.editable?.types || null;
  const set = new Set();
  for (const c of r.columns) {
    if (types) { if (types[c] && /int|numeric|decimal|real|double|money|serial|float/i.test(types[c])) set.add(c); continue; }
    let sawNum = false, allNum = true;
    for (let i = 0; i < Math.min(r.rows.length, 30); i++) {
      const v = r.rows[i][c];
      if (v === null || v === undefined) continue;
      if (looksNumeric(v)) sawNum = true; else { allNum = false; break; }
    }
    if (sawNum && allNum) set.add(c);
  }
  return (r._numc = set);
}
/* client-side sort of the current page — only wired on non-editable results (pending
   inline edits are keyed by row index, so reordering would corrupt their targets) */
function sortPage(th) {
  const si = Number(th.dataset.si), col = th.dataset.col;
  const r = lastRun?.results[si];
  if (!r || !r.rows) return;
  if (!r._orows) r._orows = r.rows.slice();             // remember original order for the "none" state
  const cur = r._sort && r._sort.col === col ? r._sort.dir : null;
  const dir = cur === null ? "asc" : cur === "asc" ? "desc" : "none";
  r._sort = dir === "none" ? null : { col, dir };
  if (dir === "none") r.rows = r._orows.slice();
  else {
    const num = numericCols(r).has(col), sign = dir === "asc" ? 1 : -1;
    r.rows = r.rows.slice().sort((a, b) => {
      let x = a[col], y = b[col];
      if (x === null || x === undefined) return 1;       // nulls last in both directions
      if (y === null || y === undefined) return -1;
      if (num) return (Number(x) - Number(y)) * sign;
      return String(x).localeCompare(String(y)) * sign;
    });
  }
  const block = th.closest(".panel");
  block.querySelectorAll("th.thsortc").forEach(h => {
    const on = r._sort && r._sort.col === h.dataset.col, ind = h.querySelector(".sortind");
    if (ind) ind.textContent = on ? (r._sort.dir === "asc" ? " ▲" : " ▼") : "";
    h.setAttribute("aria-sort", on ? (r._sort.dir === "asc" ? "ascending" : "descending") : "none");
  });
  renderRowsChunked(block, r, si);
}
/* drag a header's right edge to resize; widths live on a <colgroup> so they survive
   virtualized tbody re-renders (colgroup is a sibling of tbody, never rebuilt) */
function attachResizers(block, r) {
  const table = block.querySelector("table.grid-table");
  if (!table) return;
  const cols = table.querySelectorAll("colgroup col");
  block.querySelectorAll("th .th-resizer").forEach((handle, idx) => {
    handle.addEventListener("mousedown", e => {
      e.preventDefault(); e.stopPropagation();
      const th = handle.closest("th"), startX = e.clientX, startW = th.getBoundingClientRect().width;
      table.classList.add("resizing");
      const move = ev => {
        const w = Math.max(48, Math.round(startW + ev.clientX - startX));
        if (cols[idx]) cols[idx].style.width = w + "px";
        (r._w ||= {})[r.columns[idx]] = w;
      };
      const up = () => { document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up); table.classList.remove("resizing"); };
      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", up);
    });
  });
}
function toggleFreeze(btn) {
  const table = btn.closest(".panel")?.querySelector("table.grid-table");
  if (!table) return;
  btn.classList.toggle("btn-primary", table.classList.toggle("freeze1"));
}

/* ════════════════ cell inspector / inline editor / export ════════════════ */
let cellClickTimer = null;
document.getElementById("results").addEventListener("click", e => {
  const dym = e.target.closest("[data-dym]");
  if (dym) { // "did you mean X" — swap the misspelled identifier in the editor and re-run
    if (dym.dataset.bad) CM.setDoc(CM.getDoc().replaceAll(dym.dataset.bad, dym.dataset.dym));
    CM.focus();
    runQuery(true);
    return;
  }
  const nr = e.target.closest("[data-newrow]");
  if (nr && browse) return openInsertRow(browse.schema, browse.table);
  const pg = e.target.closest("[data-pg]");
  if (pg) { if (!pg.disabled) pg.dataset.pg === "next" ? browseNext() : browsePrev(); return; }
  const qpg = e.target.closest("[data-qpg]");
  if (qpg) { if (!qpg.disabled) qpageMove(qpg.dataset.qpg === "next" ? 1 : -1); return; }
  const qc = e.target.closest("[data-qcount]");
  if (qc) return qpageCount(qc);
  const ex = e.target.closest("[data-exp]");
  if (ex) return exportResult(Number(ex.dataset.si), ex.dataset.exp);
  const fz = e.target.closest("[data-freeze]");
  if (fz) return toggleFreeze(fz);
  if (e.target.classList.contains("th-resizer")) return; // a resize grab, not a sort
  const th = e.target.closest("th.thsort");
  if (th) return browseSort(th.dataset.col);
  const thc = e.target.closest("th.thsortc");
  if (thc) return sortPage(thc);
  const td = e.target.closest("td.cellv");
  if (!td || td.querySelector("input")) return;
  const open = () => openCellModal(Number(td.dataset.si), Number(td.dataset.ri), td.dataset.c);
  if (lastRun?.editable) { // wait: a double-click means inline edit, not the inspector
    clearTimeout(cellClickTimer);
    cellClickTimer = setTimeout(open, 260);
  } else open();
});
document.getElementById("results").addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  const qj = e.target.closest("[data-qjump]");
  if (qj) { e.preventDefault(); qpageJump(qj.value); return; }
  const bj = e.target.closest("[data-bjump]");
  if (bj) { e.preventDefault(); browseJump(bj.value); }
});
document.getElementById("results").addEventListener("dblclick", e => {
  const td = e.target.closest("td.cellv");
  if (!td || !lastRun?.editable || td.querySelector("input")) return;
  clearTimeout(cellClickTimer);
  startInlineEdit(td);
});

/* inline editing — edits accumulate as "pending", saved as one transaction */
const pending = new Map(); // "ri:col" -> {ri, col, text}
const cellText = v => v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
function startInlineEdit(td) {
  const si = Number(td.dataset.si), ri = Number(td.dataset.ri), col = td.dataset.c;
  const ed = lastRun.editable;
  if (ed.pk.includes(col)) return toast("Primary-key cells anchor the UPDATE — not editable", true);
  const orig = lastRun.results[si].rows[ri][col];
  const prev = pending.get(ri + ":" + col);
  td.innerHTML = `<input class="cellinput" spellcheck="false">`;
  const inp = td.querySelector("input");
  inp.value = prev ? prev.text : cellText(orig);
  inp.focus(); inp.select();
  let done = false;
  const finish = commit => {
    if (done) return; done = true;
    if (commit) {
      if (inp.value !== cellText(orig)) pending.set(ri + ":" + col, { ri, col, text: inp.value });
      else pending.delete(ri + ":" + col);
    }
    paintCell(td, si, ri, col);
    renderSaveBar();
  };
  inp.addEventListener("keydown", ev => {
    if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
    else if (ev.key === "Escape") { ev.stopPropagation(); finish(false); }
  });
  inp.addEventListener("blur", () => finish(true));
}
function paintCell(td, si, ri, col) {
  const p = pending.get(ri + ":" + col);
  if (p) {
    td.classList.add("pendingcell");
    td.textContent = p.text === "" ? "''" : p.text;
    td.title = "pending: " + p.text;
  } else {
    td.classList.remove("pendingcell");
    const orig = lastRun.results[si].rows[ri][col];
    if (orig === null) { td.innerHTML = '<span class="text-ink-700">∅</span>'; td.title = ""; }
    else { td.textContent = cellText(orig); td.title = cellText(orig).slice(0, 400); }
  }
}
function renderSaveBar() {
  const bar = document.getElementById("savebar");
  bar.style.display = pending.size ? "flex" : "none";
  if (pending.size) {
    const rows = new Set([...pending.values()].map(p => p.ri)).size;
    document.getElementById("savecount").textContent = `${pending.size} pending edit${pending.size > 1 ? "s" : ""} · ${rows} row${rows > 1 ? "s" : ""}`;
  }
}
function discardPending() {
  pending.clear();
  document.querySelectorAll("#results td.pendingcell").forEach(td => paintCell(td, Number(td.dataset.si), Number(td.dataset.ri), td.dataset.c));
  renderSaveBar();
}
async function savePending() {
  if (!pending.size || !lastRun?.editable) return;
  const ed = lastRun.editable;
  const fq = (ed.schema === currentDb ? "" : qid(ed.schema) + ".") + qid(ed.table);
  const byRow = {};
  for (const p of pending.values()) (byRow[p.ri] ||= []).push(p);
  const stmts = Object.entries(byRow).map(([ri, cols]) => {
    const row = lastRun.results[0].rows[ri];
    const sets = cols.map(p => `${qid(p.col)} = ${textToLit(p.text, ed.types[p.col] || "")}`).join(", ");
    const where = ed.pk.map(k => `${qid(k)} = ${sqlLit(row[k], ed.types[k] || "")}`).join(" AND ");
    return `UPDATE ${fq} SET ${sets} WHERE ${where};`;
  });
  const sql = ["BEGIN;", ...stmts, "COMMIT;"].join("\n");
  if (!(await confirmDanger(classifyDanger(sql), sql))) return;
  try {
    const { results } = await api("/api/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ db: currentDb, sql }) });
    const bad = results.find(x => !x.ok);
    if (bad) return toast(bad.error, true); // server already rolled back
    toast(`Posted ${pending.size} edit${pending.size > 1 ? "s" : ""} across ${stmts.length} row${stmts.length > 1 ? "s" : ""}`);
    pending.clear(); renderSaveBar();
    refreshCurrent();
  } catch (e) { toast(e.message, true); }
}
function textToLit(text, type) {
  if (/json/.test(type.toLowerCase())) { try { return sqlLit(JSON.parse(text), type); } catch { /* treat as text */ } }
  return sqlLit(text, type);
}
/* re-run whatever produced the current grid */
function refreshCurrent() {
  if (browse) browseRun();
  else if (lastRun) { setEditorSql(lastRun.sql); runQuery(true, lastRun.editable, true); } // pageMove keeps the current page
}

/* shape rows into a downloadable file — shared by the result-grid export buttons
   and the sidebar per-table export menu. fmt = csv | json | sql (INSERTs). */
function buildExportFile(columns, rows, fmt, rawName, types = {}) {
  if (fmt === "json") return { content: JSON.stringify(rows, null, 2), mime: "application/json", ext: "json" };
  if (fmt === "csv") {
    const cell = v => '"' + (v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)).replace(/"/g, '""') + '"';
    return { content: [columns.map(cell).join(","), ...rows.map(row => columns.map(c => cell(row[c])).join(","))].join("\r\n") + "\r\n", mime: "text/csv", ext: "csv" };
  }
  const fq = rawName.split(".").map(qid).join(".");
  const colList = columns.map(qid).join(", ");
  return { content: rows.map(row => `INSERT INTO ${fq} (${colList}) VALUES (${columns.map(c => sqlLit(row[c], types[c] || "")).join(", ")});`).join("\n") + "\n", mime: "application/sql", ext: "sql" };
}
function downloadFile(content, mime, ext, rawName) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type: mime }));
  a.download = `${currentDb}-${rawName.replace(/\./g, "_")}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.${ext}`;
  a.click();
  URL.revokeObjectURL(a.href);
}
/* export the rows of one result as .csv / .sql INSERTs / .json */
function exportResult(si, fmt) {
  const r = lastRun?.results[si];
  if (!r?.rows.length) return;
  const rawName = lastRun.editable ? (lastRun.editable.schema === currentDb ? "" : lastRun.editable.schema + ".") + lastRun.editable.table
    : (r.statement.match(/from\s+([\w".]+)/i)?.[1] || "table_name").replace(/"/g, "");
  const { content, mime, ext } = buildExportFile(r.columns, r.rows, fmt, rawName, lastRun.editable?.types || {});
  downloadFile(content, mime, ext, rawName);
  toast(`Exported ${r.rows.length} row${r.rows.length > 1 ? "s" : ""} as .${ext}${r.truncated ? " (fetched rows only)" : ""}`);
}

/* sidebar per-table export — fetches the whole table (capped) then builds the file */
function exportTableMenu(anchor, db, schema, name) {
  anchorMenu(anchor, [
    { label: "Export to CSV", icon: "download", onClick: () => exportTable(db, schema, name, "csv") },
    { label: "Export to SQL (INSERTs)", icon: "filecode", onClick: () => exportTable(db, schema, name, "sql") },
    { label: "Export to JSON", icon: "download", onClick: () => exportTable(db, schema, name, "json") },
  ]);
}
async function exportTable(db, schema, name, fmt) {
  const fq = (schema === currentDb ? "" : qid(schema) + ".") + qid(name);
  const rawName = (schema === currentDb ? "" : schema + ".") + name;
  toast(`Exporting ${name} as .${fmt === "sql" ? "sql" : fmt}…`);
  try {
    const { results } = await api("/api/query", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ db, sql: `SELECT * FROM ${fq}`, maxRows: 100000 }),
    });
    unpackResults(results);
    const r = results[0];
    if (!r?.ok) return toast(r?.error || "export failed", true);
    const types = {};
    (schemaCache[db]?.columns || []).filter(c => c.schema === schema && c.table === name).forEach(c => { types[c.name] = c.type; });
    const { content, mime, ext } = buildExportFile(r.columns, r.rows, fmt, rawName, types);
    downloadFile(content, mime, ext, rawName);
    toast(`Exported ${r.rows.length.toLocaleString()} row${r.rows.length === 1 ? "" : "s"} of ${name} as .${ext}${r.truncated || r.byteCapped ? " (first 100k rows)" : ""}`);
  } catch (e) { toast(e.message, true); }
}
function openCellModal(si, ri, col) {
  if (!lastRun) return;
  const r = lastRun.results[si]; if (!r || !r.ok) return;
  const row = r.rows[ri]; if (!row) return;
  const v = row[col];
  const isObj = v !== null && typeof v === "object";
  const text = v === null ? "" : isObj ? JSON.stringify(v, null, 2) : String(v);
  const ed = lastRun.editable;
  const isPkCol = !!ed && ed.pk.includes(col);
  const canEdit = !!ed && !isPkCol && ed.pk.every(k => r.columns.includes(k));
  const type = ed ? ed.types[col] || "" : "";
  openModal(`
    <div class="flex items-center gap-2.5 px-5 py-4 border-b border-rule-700 min-w-0">
      <span class="text-quill-400" data-ic="table" data-s="15"></span>
      <span class="font-mono text-[13px] font-bold truncate">${ed ? esc(ed.table) + "." : ""}${esc(col)}</span>
      ${type ? `<span class="chip">${esc(type)}</span>` : ""}
      ${v === null ? '<span class="chip chip-amber">null</span>' : ""}
      ${isPkCol ? '<span class="chip chip-quill">primary key</span>' : ""}
      <span class="mlabel ml-auto flex-none">row ${ri + 1}</span>
      <button class="btn btn-sm btn-icon" onclick="closeModal()" title="Close"><span data-ic="x" data-s="13"></span></button>
    </div>
    <div class="px-5 py-4 flex flex-col gap-3 overflow-y-auto min-h-0">
      <pre class="sqlblock max-h-[38vh] overflow-y-auto" id="cellval">${v === null ? '<span class="cmt">NULL</span>' : escPre(text)}</pre>
      <div class="flex gap-2">
        <button class="btn btn-sm" onclick='navigator.clipboard.writeText(document.getElementById("cellval").textContent); toast("Value copied")'><span data-ic="copy" data-s="12"></span>Copy value</button>
        <button class="btn btn-sm" id="copyrowbtn"><span data-ic="copy" data-s="12"></span>Copy row JSON</button>
      </div>
      ${canEdit ? `
      <div class="h-px bg-rule-700"></div>
      <div class="mlabel">amend entry</div>
      <textarea id="celledit" class="input w-full font-mono text-[12px] min-h-20 resize-y" spellcheck="false">${esc(isObj ? JSON.stringify(v) : v === null ? "" : String(v))}</textarea>
      <label class="text-xs text-ink-500 flex items-center gap-1.5"><input type="checkbox" id="cellnull" class="accent-quill-500" ${v === null ? "checked" : ""}> set NULL</label>
      <div class="mlabel">generated update</div>
      <pre class="sqlblock" id="cellsql"></pre>
      <div class="flex justify-end gap-2">
        <button class="btn" onclick="closeModal()">Cancel</button>
        <button class="btn btn-primary" id="cellsave"><span data-ic="play" data-s="13"></span>Run UPDATE</button>
      </div>` : ed
        ? `<div class="text-xs text-ink-500">${isPkCol ? "Primary-key cells aren't editable here — they anchor the UPDATE." : "Editing needs every PK column in the result."}</div>`
        : `<div class="text-xs text-ink-500">Read-only: editing needs a plain <span class="font-mono">SELECT * FROM table</span> on a table with a primary key.</div>`}
    </div>`);
  hydrateIcons(modalCard);
  document.getElementById("copyrowbtn").addEventListener("click", () => { navigator.clipboard.writeText(JSON.stringify(row, null, 2)); toast("Row copied as JSON"); });
  if (canEdit) {
    const q = s => '"' + s.replace(/"/g, '""') + '"';
    const fq = (ed.schema === currentDb ? "" : q(ed.schema) + ".") + q(ed.table);
    const where = ed.pk.map(k => `${q(k)} = ${sqlLit(row[k], ed.types[k] || "")}`).join(" AND ");
    const editEl = document.getElementById("celledit"), nullEl = document.getElementById("cellnull"), sqlEl = document.getElementById("cellsql");
    const buildUpdate = () => {
      let nv = nullEl.checked ? null : editEl.value;
      if (nv !== null && /json/.test(type.toLowerCase())) { try { nv = JSON.parse(nv); } catch { /* keep as text */ } }
      return `UPDATE ${fq} SET ${q(col)} = ${sqlLit(nv, type)} WHERE ${where};`;
    };
    const renderPrev = () => { sqlEl.innerHTML = hlSql(buildUpdate()); };
    editEl.addEventListener("input", () => { nullEl.checked = false; renderPrev(); });
    nullEl.addEventListener("input", renderPrev);
    renderPrev();
    document.getElementById("cellsave").addEventListener("click", async () => {
      const upd = buildUpdate();
      try {
        const { results } = await api("/api/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ db: currentDb, sql: upd }) });
        if (!results[0].ok) return toast(results[0].error, true);
        toast(`Updated ${results[0].rowCount} row${results[0].rowCount === 1 ? "" : "s"}`);
        closeModal();
        refreshCurrent();
      } catch (e2) { toast(e2.message, true); }
    });
  }
}
/* the console column must never pan horizontally — wide grids scroll inside their own wrappers */
const consolecol = document.getElementById("consolecol");
consolecol.addEventListener("scroll", () => { if (consolecol.scrollLeft) consolecol.scrollLeft = 0; });

/* ════════════════ EXPLAIN viewer ════════════════ */
async function runExplain() {
  if (!currentDb) return toast("Select a database in the sidebar first", true);
  const sql = CM.getDoc().trim();
  if (!sql) return;
  hideAc();
  const analyzeEl = document.getElementById("explainanalyze");
  let analyze = analyzeEl.checked;
  if (analyze && classifyDanger(sql).length) {
    analyze = false; analyzeEl.checked = false;
    toast("ANALYZE executes the query — switched off for this mutating statement", true);
  }
  const out = document.getElementById("results");
  const sumEl = document.getElementById("runsummary");
  sumEl.innerHTML = `<span class="chip"><span class="led led-amber"></span>explaining on ${esc(currentDb)}…</span>`;
  out.innerHTML = "";
  try {
    const data = await api("/api/explain", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ db: currentDb, sql, analyze }),
    });
    renderExplain(data);
  } catch (e) {
    sumEl.innerHTML = `<span class="chip chip-red"><span class="led led-red"></span>explain failed</span>`;
    out.innerHTML = `<div class="panel p-3 border-l-2 !border-l-red-led"><div class="text-red-led font-mono text-xs">${esc(e.message)}</div></div>`;
  }
}
function explainNodeHtml(n, depth) {
  const est = Number(n["Plan Rows"] ?? 0);
  const act = n["Actual Rows"] !== undefined ? Number(n["Actual Rows"]) : null;
  const seqBig = n["Node Type"] === "Seq Scan" && (act ?? est) > 10000;
  const title = [n["Node Type"], n["Relation Name"] ? `on ${n["Relation Name"]}` : "", n["Alias"] && n["Alias"] !== n["Relation Name"] ? `as ${n["Alias"]}` : "", n["Index Name"] ? `using ${n["Index Name"]}` : ""].filter(Boolean).join(" ");
  const time = n["Actual Total Time"] !== undefined ? `${Number(n["Actual Total Time"]).toFixed(2)} ms` : null;
  let html = `
    <div class="flex items-center gap-2 py-1 font-mono text-[11.5px]" style="margin-left:${depth * 22}px">
      <span class="${depth ? "text-ink-700" : "text-quill-400"}">${depth ? "└" : "▸"}</span>
      <span class="${seqBig ? "chip chip-red" : "chip"}">${esc(n["Node Type"])}</span>
      <span class="text-ink-100">${esc(title.replace(n["Node Type"], "").trim())}</span>
      <span class="text-ink-700 ml-auto flex items-center gap-2 flex-none">
        ${n["Total Cost"] !== undefined ? `cost ${Number(n["Total Cost"]).toFixed(0)}` : ""}
        · rows ${act !== null ? `${act.toLocaleString()} <span class="text-ink-700">(est ${est.toLocaleString()})</span>` : est.toLocaleString()}
        ${time ? `· <span class="${Number(n["Actual Total Time"]) > 100 ? "text-amber-led" : "text-green-led"}">${time}</span>` : ""}
        ${n["Loops"] > 1 ? `· ×${n["Loops"]}` : ""}
      </span>
    </div>
    ${n["Filter"] ? `<div class="font-mono text-[10.5px] text-ink-500 truncate" style="margin-left:${depth * 22 + 26}px" title="${esc(n["Filter"])}">filter: ${esc(n["Filter"])}</div>` : ""}
    ${n["Index Cond"] ? `<div class="font-mono text-[10.5px] text-ink-500 truncate" style="margin-left:${depth * 22 + 26}px">index cond: ${esc(n["Index Cond"])}</div>` : ""}`;
  for (const c of n["Plans"] || []) html += explainNodeHtml(c, depth + 1);
  return html;
}
function renderExplain({ plan, hints, analyzed, note }) {
  const sumEl = document.getElementById("runsummary");
  const out = document.getElementById("results");
  sumEl.innerHTML = `
    <span class="chip chip-green"><span class="led led-green"></span>${analyzed ? "EXPLAIN ANALYZE" : "EXPLAIN"}</span>
    ${plan["Planning Time"] !== undefined ? `<span class="chip">plan ${Number(plan["Planning Time"]).toFixed(2)} ms</span>` : ""}
    ${plan["Execution Time"] !== undefined ? `<span class="chip">${ic("zap", 10)} exec ${Number(plan["Execution Time"]).toFixed(2)} ms</span>` : ""}`;
  const block = document.createElement("div");
  block.className = "panel overflow-clip border-l-2 !border-l-quill-600";
  block.innerHTML = `
    <div class="flex items-center gap-3 px-3 py-1.5 bg-paper-800 font-mono text-[11px]">
      <span class="text-quill-400 font-semibold">${ic("gauge", 11)} QUERY PLAN</span>
      ${analyzed ? '<span class="chip chip-amber">measured — the query ran</span>' : '<span class="chip">estimates only</span>'}
    </div>
    ${note ? `<div class="px-3 py-2 text-xs text-amber-led border-b border-rule-700">${esc(note)}</div>` : ""}
    ${hints.length ? `<div class="px-3 py-2 flex flex-col gap-1 border-b border-rule-700">${hints.map(h =>
      `<div class="flex items-start gap-2 text-xs"><span class="chip chip-amber flex-none">hint</span><span class="text-ink-300">${esc(h)}</span></div>`).join("")}</div>` : ""}
    <div class="px-3 py-2 overflow-x-auto">${explainNodeHtml(plan.Plan, 0)}</div>`;
  out.replaceChildren(block);
}

/* ════════════════ query history (server-side bun:sqlite, 10k cap) ════════════════ */
const HIST_PAGE = 50;
let histState = { q: "", date: "", offset: 0, total: 0 };
let histDebounce = null;

async function clearHistory() {
  if (!confirm("Clear the entire query history (all " + (histState.total || "") + " entries)?")) return;
  try { await api("/api/history", { method: "DELETE" }); histState.offset = 0; renderHistory(); }
  catch (e) { toast(e.message, true); }
}
function toggleHistory() {
  const d = document.getElementById("histdrawer");
  d.classList.toggle("hidden");
  d.classList.toggle("flex", !d.classList.contains("hidden"));
  if (!d.classList.contains("hidden")) { // the two drawers share the right edge
    const s = document.getElementById("saveddrawer");
    s.classList.add("hidden"); s.classList.remove("flex");
  }
  localStorage.setItem("msq_histopen", d.classList.contains("hidden") ? "" : "1");
  renderHistory();
}
function histFilterChanged() { // debounced: search-as-you-type + date picker share this
  clearTimeout(histDebounce);
  histDebounce = setTimeout(() => {
    histState.q = document.getElementById("histq").value.trim();
    histState.date = document.getElementById("histdate").value;
    histState.offset = 0;
    renderHistory();
  }, 250);
}
function histClearDate() { document.getElementById("histdate").value = ""; histFilterChanged(); }
function histPage(dir) {
  const next = histState.offset + dir * HIST_PAGE;
  if (next < 0 || next >= histState.total) return;
  histState.offset = next;
  renderHistory();
}
async function renderHistory() {
  const drawer = document.getElementById("histdrawer");
  if (!drawer || drawer.classList.contains("hidden")) return;
  const el = document.getElementById("histlist");
  const p = new URLSearchParams({ limit: HIST_PAGE, offset: histState.offset });
  if (histState.q) p.set("q", histState.q);
  if (histState.date) { // one IST calendar day: local midnight → 23:59:59.999
    const start = new Date(histState.date + "T00:00:00").getTime();
    p.set("from", start); p.set("to", start + 86399999);
  }
  let data;
  try { data = await api("/api/history?" + p); }
  catch (e) { el.innerHTML = `<div class="text-red-led text-xs p-2">${esc(e.message)}</div>`; return; }
  histState.total = data.total;
  if (histState.offset >= data.total && data.total > 0) { // page fell off the end (e.g. after clear/filter)
    histState.offset = Math.floor((data.total - 1) / HIST_PAGE) * HIST_PAGE;
    return renderHistory();
  }
  const filtered = histState.q || histState.date;
  el.innerHTML = data.entries.length ? "" :
    `<div class="mlabel p-2">${filtered ? "nothing matches the filter" : "empty — run something"}</div>`;
  data.entries.forEach(e2 => {
    const d = document.createElement("div");
    d.className = "panel !bg-paper-850 p-2 cursor-pointer hover:!border-rule-300 transition-colors";
    d.innerHTML = `
      <div class="flex items-center gap-1.5 mb-1">
        <span class="led ${e2.ok ? "led-green" : "led-red"}" style="width:5px;height:5px"></span>
        <span class="font-mono text-[9.5px] text-quill-400">${e2.conn ? `<span class="text-amber-led">${esc(e2.conn)} › </span>` : ""}${esc(e2.db)}</span>
        <span class="font-mono text-[9.5px] text-ink-700 ml-auto">${e2.ms ?? "?"}ms · ${e2.row_count ?? 0}r · ${ago(e2.at)}</span>
      </div>
      <div class="clamp2 font-mono text-[10.5px] text-ink-300 leading-snug">${esc(e2.sql)}</div>`;
    d.title = new Date(e2.at).toLocaleString() + "\n\n" + e2.sql;
    d.addEventListener("click", () => {
      setEditorSql(e2.sql);
      if (e2.db !== currentDb && databases.some(x => x.name === e2.db)) selectDb(e2.db);
      CM.focus();
    });
    el.appendChild(d);
  });
  // pager: row ranges, like the browse grid
  const lo = data.total ? histState.offset + 1 : 0;
  const hi = Math.min(histState.offset + HIST_PAGE, data.total);
  document.getElementById("histrange").textContent = `${lo}–${hi} of ${data.total}`;
  document.getElementById("histprev").disabled = histState.offset === 0;
  document.getElementById("histnext").disabled = hi >= data.total;
}
