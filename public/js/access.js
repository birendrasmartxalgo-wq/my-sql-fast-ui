/* access.js — Access tab: roles and table grants (read-only views). */
async function loadRoles() {
  const out = document.getElementById("roles-out");
  try {
    const { roles } = await api("/api/roles");
    out.innerHTML = `<table class="grid-table w-full"><thead><tr><th>role</th><th>login</th><th>superuser</th><th>createdb</th><th>createrole</th><th>conn limit</th></tr></thead>
      <tbody>${roles.map(r => `<tr><td class="text-ink-100">${esc(r.name)}</td>
        <td>${r.login ? '<span class="text-green-led">●</span>' : ""}</td>
        <td>${r.superuser ? '<span class="text-amber-led">●</span>' : ""}</td>
        <td>${r.createdb ? '<span class="text-quill-400">●</span>' : ""}</td>
        <td>${r.createrole ? '<span class="text-quill-400">●</span>' : ""}</td>
        <td>${r.conn_limit < 0 ? "∞" : r.conn_limit}</td></tr>`).join("")}</tbody></table>`;
  } catch (e) { out.innerHTML = `<div class="text-red-led text-xs">${esc(e.message)}</div>`; }
}
async function loadGrants() {
  document.getElementById("grants-db").textContent = currentDb || "—";
  const out = document.getElementById("grants-out");
  if (!currentDb) { out.innerHTML = `<div class="mlabel">select a database</div>`; return; }
  try {
    const { grants } = await api("/api/grants?db=" + encodeURIComponent(currentDb));
    out.innerHTML = grants.length
      ? `<table class="grid-table w-full"><thead><tr><th>table</th><th>grantee</th><th>privileges</th></tr></thead>
        <tbody>${grants.map(g => `<tr><td class="text-ink-100">${esc(g.schema)}.${esc(g.table)}</td><td>${esc(g.grantee)}</td><td class="!whitespace-normal !max-w-none">${esc(g.privileges)}</td></tr>`).join("")}</tbody></table>`
      : `<div class="mlabel">no explicit table grants</div>`;
  } catch (e) { out.innerHTML = `<div class="text-red-led text-xs">${esc(e.message)}</div>`; }
}
