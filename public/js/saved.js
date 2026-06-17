/* saved.js — server-persisted saved-queries drawer (bun:sqlite on the server)
   + audit-log panel in the Access tab. */

function toggleSaved() {
  const d = document.getElementById("saveddrawer");
  d.classList.toggle("hidden");
  d.classList.toggle("flex", !d.classList.contains("hidden"));
  // the two drawers share the right edge — close history when saved opens
  if (!d.classList.contains("hidden")) {
    const h = document.getElementById("histdrawer");
    h.classList.add("hidden"); h.classList.remove("flex");
    renderSaved();
  }
}
async function renderSaved() {
  const el = document.getElementById("savedlist");
  el.innerHTML = `<div class="mlabel p-2">loading…</div>`;
  try {
    const { queries } = await api("/api/saved");
    el.innerHTML = queries.length ? "" : `<div class="mlabel p-2">nothing saved yet — write SQL and press “Save current”</div>`;
    for (const q of queries) {
      const d = document.createElement("div");
      d.className = "panel !bg-paper-850 p-2 cursor-pointer hover:!border-rule-300 transition-colors group";
      d.innerHTML = `
        <div class="flex items-center gap-1.5 mb-1">
          <span class="text-quill-400">${ic("bookmark", 10)}</span>
          <span class="font-medium text-[11.5px] truncate flex-1">${esc(q.name)}</span>
          ${q.db ? `<span class="font-mono text-[9.5px] text-quill-400">${esc(q.db)}</span>` : ""}
          <button class="btn btn-sm btn-icon opacity-0 group-hover:opacity-100 transition-opacity" title="Rename" data-ren>${ic("pencil", 10)}</button>
          <button class="btn btn-sm btn-icon btn-danger opacity-0 group-hover:opacity-100 transition-opacity" title="Delete" data-del>${ic("trash", 10)}</button>
        </div>
        <div class="clamp2 font-mono text-[10.5px] text-ink-300 leading-snug">${esc(q.sql)}</div>`;
      d.title = q.sql;
      d.addEventListener("click", e => {
        if (e.target.closest("[data-del],[data-ren]")) return;
        setEditorSql(q.sql);
        if (q.db && q.db !== currentDb && databases.some(x => x.name === q.db)) selectDb(q.db);
        CM.focus();
      });
      d.querySelector("[data-del]").addEventListener("click", async e => {
        e.stopPropagation();
        try { await api("/api/saved/" + q.id, { method: "DELETE" }); toast(`Deleted "${q.name}"`); renderSaved(); }
        catch (e2) { toast(e2.message, true); }
      });
      d.querySelector("[data-ren]").addEventListener("click", async e => {
        e.stopPropagation();
        const name = prompt("Rename saved query:", q.name);
        if (!name || name === q.name) return;
        try {
          await api("/api/saved/" + q.id, { method: "PUT", headers: { "content-type": "application/json" },
            body: JSON.stringify({ name, sql: q.sql, db: q.db }) });
          renderSaved();
        } catch (e2) { toast(e2.message, true); }
      });
      el.appendChild(d);
    }
  } catch (e) { el.innerHTML = `<div class="text-red-led text-xs p-2">${esc(e.message)}</div>`; }
}
async function saveCurrentQuery() {
  const sql = CM.getDoc().trim();
  if (!sql) return toast("The editor is empty — nothing to save", true);
  const name = prompt("Name this query:", "");
  if (!name?.trim()) return;
  try {
    await api("/api/saved", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name.trim(), sql, db: currentDb || null }) });
    toast(`Saved "${name.trim()}"`);
    renderSaved();
  } catch (e) { toast(e.message, true); }
}

/* ════════════════ audit log (Access tab) ════════════════ */
async function loadAudit() {
  const out = document.getElementById("audit-out");
  try {
    const { entries } = await api("/api/audit?limit=200");
    out.innerHTML = entries.length
      ? `<table class="grid-table w-full"><thead><tr><th>when</th><th>db</th><th>command</th><th>rows</th><th>ok</th><th>ip</th><th>statement</th></tr></thead>
        <tbody>${entries.map(a => `<tr>
          <td class="font-mono text-[10.5px]" title="${new Date(a.at).toLocaleString()}">${ago(a.at)} ago</td>
          <td class="text-quill-400">${esc(a.db || "")}</td>
          <td>${esc(a.command || "")}</td>
          <td>${a.row_count ?? ""}</td>
          <td>${a.ok ? '<span class="text-green-led">●</span>' : `<span class="text-red-led" title="${esc(a.error || "")}">✕</span>`}</td>
          <td class="font-mono text-[10px] text-ink-700">${esc(a.ip || "")}</td>
          <td class="!whitespace-normal !max-w-none font-mono text-[10.5px]" title="${esc((a.sql || "").slice(0, 800))}">${esc((a.sql || "").slice(0, 160))}${(a.sql || "").length > 160 ? "…" : ""}</td>
        </tr>`).join("")}</tbody></table>`
      : `<div class="mlabel py-2">no mutations recorded yet</div>`;
  } catch (e) { out.innerHTML = `<div class="text-red-led text-xs">${esc(e.message)}</div>`; }
}
