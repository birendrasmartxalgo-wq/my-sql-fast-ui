/* joins.js — Joins tab: FK-ranked suggestions and BFS join-path finder. */
function tableOptions(db) {
  const s = schemaCache[db];
  if (!s) return "";
  return s.tables.filter(t => t.kind !== "view").map(t => {
    const v = (t.schema === "public" ? "" : t.schema + ".") + t.name;
    return `<option value="${esc(v)}">${esc(v)}</option>`;
  }).join("");
}
async function fillTableSelects() {
  if (!currentDb) return;
  if (!schemaCache[currentDb]) { try { schemaCache[currentDb] = await api("/api/schema?db=" + encodeURIComponent(currentDb)); } catch { return; } }
  const opts = tableOptions(currentDb);
  document.getElementById("join-table").innerHTML = `<option value="">Pick a table…</option>` + opts;
  document.getElementById("join-from").innerHTML = `<option value="">from…</option>` + opts;
  document.getElementById("join-to").innerHTML = `<option value="">to…</option>` + opts;
}
const CONF_CHIP = { high: "chip-green", medium: "chip-amber", low: "chip" };
/* DOM-built cards: SQL goes through closures, never through onclick attributes
   (quotes in generated SQL used to break the inline handlers silently) */
function createJoinCard({ title, detail, sql, kind, confidence }) {
  const card = document.createElement("div");
  card.className = "panel p-3.5";
  card.innerHTML = `
    <div class="flex items-center gap-2 mb-1">
      <span class="font-medium text-[13px]">${esc(title)}</span>
      <span class="chip ${CONF_CHIP[confidence] || "chip"}">${esc(kind || "path")}${confidence ? " · " + confidence : ""}</span>
    </div>
    <div class="text-ink-500 text-xs mb-2">${esc(detail || "")}</div>
    <pre class="sqlblock mb-2.5">${hlSql(sql)}</pre>
    <div class="flex gap-2">
      <button class="btn btn-primary btn-sm" data-run>${ic("play", 11)}Run in console</button>
      <button class="btn btn-sm" data-copy>${ic("copy", 11)}Copy</button>
    </div>`;
  card.querySelector("[data-run]").addEventListener("click", () => openInEditor(sql));
  card.querySelector("[data-copy]").addEventListener("click", () => { navigator.clipboard.writeText(sql); toast("Copied"); });
  return card;
}
function openInEditor(sql) { setEditorSql(sql); showTab("query"); runQuery(); }
async function loadJoins() {
  const t = document.getElementById("join-table").value;
  if (!t || !currentDb) return toast("Pick a database and table", true);
  const out = document.getElementById("join-results");
  out.innerHTML = `<div class="mlabel">analysing relationships…</div>`;
  try {
    const { suggestions } = await api(`/api/joins?db=${encodeURIComponent(currentDb)}&table=${encodeURIComponent(t)}`);
    if (suggestions.length) out.replaceChildren(...suggestions.map(createJoinCard));
    else out.innerHTML = `<div class="mlabel">no join candidates for ${esc(t)} — no FKs, no shared columns</div>`;
  } catch (e) { out.innerHTML = `<div class="text-red-led text-xs">${esc(e.message)}</div>`; }
}
async function loadJoinPath() {
  const f = document.getElementById("join-from").value, t = document.getElementById("join-to").value;
  if (!f || !t || !currentDb) return toast("Pick from and to tables", true);
  const out = document.getElementById("join-results");
  out.innerHTML = `<div class="mlabel">searching join graph…</div>`;
  try {
    const { path, message } = await api(`/api/joins?db=${encodeURIComponent(currentDb)}&from=${encodeURIComponent(f)}&to=${encodeURIComponent(t)}`);
    if (path) out.replaceChildren(createJoinCard({ title: `${f} → ${t}`, detail: "via " + path.via.join(" → "), sql: path.sql, kind: "path", confidence: path.via.some(v => v.startsWith("shared")) ? "low" : "high" }));
    else out.innerHTML = `<div class="mlabel">${esc(message || "no path found")}</div>`;
  } catch (e) { out.innerHTML = `<div class="text-red-led text-xs">${esc(e.message)}</div>`; }
}
