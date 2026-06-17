/* connections.js — multi-server support: switcher, add/edit modal (host/port, user+password,
   optional SSH tunnel with PEM key), test, manage. Credentials are AES-256-GCM encrypted at
   rest server-side and never echoed back. The active id rides on every api() call (core.js). */

let connList = [];
const CONN_COLORS = ["#7a8c5d", "#5d7a8c", "#a3324b", "#b08968", "#8c5d7a", "#3d6b54", "#6d5d8c", "#8a7a3d"];

function connById(id) { return connList.find(c => c.id === Number(id)); }
function connDisplayName() { return connById(currentConn)?.name || "Local"; }

async function loadConnections() {
  try {
    connList = (await api("/api/connections")).connections;
  } catch { connList = [{ id: 0, name: "Local", builtin: true, color: CONN_COLORS[0] }]; }
  if (!connById(currentConn)) { currentConn = 0; localStorage.setItem("msq_conn", "0"); }
  renderConnSwitcher();
}

function renderConnSwitcher() {
  const c = connById(currentConn) || {};
  const sel = document.getElementById("connsel");
  sel.innerHTML = connList.map(x =>
    `<option value="${x.id}" ${x.id === Number(currentConn) ? "selected" : ""}>${esc(x.name)}${x.ssh ? "  ⇆ ssh" : ""}</option>`).join("");
  document.getElementById("conndot").style.background = c.color || CONN_COLORS[0];
  // header badge only when working on a remote server — so it's unmistakable
  const chip = document.getElementById("curconnchip");
  chip.classList.toggle("hidden", Number(currentConn) === 0);
  document.getElementById("curconn").textContent = c.name || "";
  document.getElementById("curconndot").style.background = c.color || CONN_COLORS[0];
  const info = document.getElementById("conninfo");
  if (info) info.textContent = c.builtin || !c.host
    ? "mysql://127.0.0.1:3306"
    : `mysql://${c.host}:${c.port}` + (c.ssh ? `  via  ${c.ssh_user}@${c.ssh_host}` : "");
}

async function switchConn(id) {
  id = Number(id);
  if (id === Number(currentConn)) return;
  currentConn = id;
  localStorage.setItem("msq_conn", String(id));
  // hard reset of per-server state — schema cache, browse cursors, selection
  schemaCache = {};
  browse = null;
  activeTable = null;
  currentDb = "";
  localStorage.setItem("msq_db", "");
  document.getElementById("curdb").textContent = "—";
  document.getElementById("tabbtn-table").disabled = true;
  document.getElementById("dblist").innerHTML = `<div class="mlabel py-2">connecting…</div>`;
  renderConnSwitcher();
  showTab("query");
  try {
    await loadDatabases();
    toast("Switched to " + connDisplayName());
  } catch (e) {
    document.getElementById("dblist").innerHTML = `<div class="text-red-led text-xs py-2">${esc(e.message)}</div>`;
    toast("Could not reach " + connDisplayName() + ": " + e.message, true);
  }
}

/* ════════════════ add / edit modal ════════════════ */
function openConnModal(id, firstRun = false) {
  const c = id ? connById(id) : null;
  const color = c?.color || CONN_COLORS[(connList.length - 1) % CONN_COLORS.length];
  openModal(`
    <div class="flex items-center gap-3 px-5 py-4 border-b border-rule-700">
      <span data-ic="server" data-s="15"></span>
      <span class="font-display font-semibold text-[16px]">${firstRun ? "Welcome — connect your database" : c ? "Edit server — " + esc(c.name) : "Add a server"}</span>
      <span class="chip ml-auto" title="Passwords and keys are AES-256-GCM encrypted in the local store and never sent back to the browser">${ic("shield", 10)} encrypted at rest</span>
    </div>
    <div class="px-5 py-4 flex flex-col gap-3 overflow-y-auto" style="max-height:70vh">
      ${firstRun ? `<div class="text-[12px] text-ink-300 leading-relaxed bg-paper-850 border border-rule-700 rounded-md px-3 py-2.5">
        <b class="text-quill-400">First-time setup.</b> No reachable database was found on this machine. Enter your MySQL connection details below — they're saved encrypted on this device. You can add more servers later from the switcher.</div>` : ""}
      <div id="cn-explain" class="text-[11px] text-ink-500 leading-relaxed bg-paper-850 border border-rule-700 rounded-md px-3 py-2"></div>
      <div class="flex gap-3">
        <div class="flex-1 flex flex-col gap-1">
          <label class="mlabel">name <span class="text-ink-700">— optional, auto-named if left blank</span></label>
          <input id="cn-name" class="input font-mono text-xs" placeholder="auto" value="${esc(c?.name || "")}">
          <span id="cn-namehint" class="text-[10px] text-quill-400 font-mono min-h-3"></span>
        </div>
        <div class="flex flex-col gap-1"><label class="mlabel">colour</label>
          <div class="flex items-center gap-1.5 h-8" id="cn-colors">${CONN_COLORS.map(col =>
            `<span class="led cursor-pointer" data-col="${col}" style="background:${col};width:14px;height:14px;${col === color ? "outline:2px solid var(--color-quill-400);outline-offset:2px" : ""}"></span>`).join("")}</div></div>
      </div>
      <div class="flex gap-3">
        <div class="flex-[2] flex flex-col gap-1"><label class="mlabel">host <span class="text-ink-700">(from the SSH server's view when tunnelling — usually 127.0.0.1)</span></label>
          <input id="cn-host" class="input font-mono text-xs" placeholder="127.0.0.1 or db.example.com" value="${esc(c?.host || "")}"></div>
        <div class="w-24 flex flex-col gap-1"><label class="mlabel">port</label>
          <input id="cn-port" class="input font-mono text-xs" placeholder="3306" value="${esc(c?.port || "3306")}"></div>
      </div>
      <div class="flex gap-3">
        <div class="flex-1 flex flex-col gap-1"><label class="mlabel">username</label>
          <input id="cn-user" class="input font-mono text-xs" placeholder="root" value="${esc(c?.username || "")}"></div>
        <div class="flex-1 flex flex-col gap-1"><label class="mlabel">password</label>
          <input id="cn-pass" type="password" class="input font-mono text-xs" placeholder="${c?.hasPassword ? "•••••• (unchanged)" : "password"}" autocomplete="new-password"></div>
      </div>
      <label class="flex items-center gap-2 text-xs text-ink-300 cursor-pointer mt-1">
        <input type="checkbox" id="cn-ssh" ${c?.ssh ? "checked" : ""} onchange="document.getElementById('cn-sshbox').classList.toggle('hidden', !this.checked)">
        Connect through an SSH tunnel (PEM key)
      </label>
      <div id="cn-sshbox" class="panel p-3 flex-col gap-3 flex ${c?.ssh ? "" : "hidden"}">
        <div class="flex gap-3">
          <div class="flex-[2] flex flex-col gap-1"><label class="mlabel">ssh host</label>
            <input id="cn-sshhost" class="input font-mono text-xs" placeholder="21.121.31.45" value="${esc(c?.ssh_host || "")}"></div>
          <div class="w-20 flex flex-col gap-1"><label class="mlabel">port</label>
            <input id="cn-sshport" class="input font-mono text-xs" placeholder="22" value="${esc(c?.ssh_port || "22")}"></div>
          <div class="flex-1 flex flex-col gap-1"><label class="mlabel">ssh user</label>
            <input id="cn-sshuser" class="input font-mono text-xs" placeholder="root" value="${esc(c?.ssh_user || "")}"></div>
        </div>
        <div class="flex flex-col gap-1">
          <div class="flex items-center justify-between">
            <label class="mlabel">private key (PEM)${c?.hasKey ? ' <span class="text-green-led">· stored — leave blank to keep</span>' : ""}</label>
            <button class="btn btn-sm" onclick="document.getElementById('cn-keyfile').click()">${ic("upload", 11)} load .pem file</button>
            <input type="file" id="cn-keyfile" class="hidden" accept=".pem,.key,.ppk,*">
          </div>
          <textarea id="cn-sshkey" class="input font-mono text-[10px] h-24" spellcheck="false" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea>
        </div>
      </div>
      <div id="cn-testout" class="font-mono text-xs min-h-4"></div>
    </div>
    <div class="flex items-center gap-2 px-5 py-3.5 border-t border-rule-700">
      <button class="btn" id="cn-test" onclick="testConnForm(${c ? c.id : "null"})">${ic("zap", 12)} Test connection</button>
      <span class="flex-1"></span>
      <button class="btn" onclick="closeModal()">${firstRun ? "Skip for now" : "Cancel"}</button>
      <button class="btn btn-primary" onclick="saveConn(${c ? c.id : "null"}, ${firstRun})">${ic("play", 12)} ${firstRun ? "Connect" : c ? "Save changes" : "Add server"}</button>
    </div>`);
  hydrateIcons(modalCard);
  document.getElementById("cn-colors").addEventListener("click", e => {
    const dot = e.target.closest("[data-col]");
    if (!dot) return;
    document.querySelectorAll("#cn-colors [data-col]").forEach(d => { d.style.outline = ""; d.style.outlineOffset = ""; });
    dot.style.outline = "2px solid var(--color-quill-400)"; dot.style.outlineOffset = "2px";
  });
  document.getElementById("cn-keyfile").addEventListener("change", async e => {
    const f = e.target.files[0];
    if (f) { document.getElementById("cn-sshkey").value = await f.text(); updateNameHint(); }
  });

  // live "where to connect" explainer + auto-suggested name -----------------
  const nameInput = document.getElementById("cn-name");
  let nameTouched = !!(c && c.name); // editing an existing, named connection: leave it alone
  function updateExplain() {
    const ssh = document.getElementById("cn-ssh").checked;
    document.getElementById("cn-explain").innerHTML = ssh
      ? "<b class='text-ink-300'>Via SSH tunnel.</b> mysql-fast-ui SSHes into the jump box with your PEM key, then reaches MySQL through it. Below: put the jump box in <b>ssh host / user</b>, and the MySQL <b>host &amp; port as seen from that box</b> up top — usually <span class='text-quill-400'>127.0.0.1:3306</span>."
      : "<b class='text-ink-300'>Direct.</b> Connect straight to a MySQL this machine can already reach — fill <b>host &amp; port</b> and the database <b>username / password</b>. Tick the box below to instead reach it through an SSH jump host.";
  }
  function updateNameHint() {
    const hint = document.getElementById("cn-namehint");
    if (nameTouched && nameInput.value.trim()) { hint.textContent = ""; nameInput.placeholder = "auto"; return; }
    const suggested = deriveConnName(connSpecFromForm());
    nameInput.placeholder = suggested;
    hint.textContent = "saved as  " + suggested;
  }
  nameInput.addEventListener("input", () => { nameTouched = true; updateNameHint(); });
  ["cn-host", "cn-port", "cn-user", "cn-sshhost", "cn-sshport", "cn-sshuser"].forEach(idf =>
    document.getElementById(idf).addEventListener("input", updateNameHint));
  document.getElementById("cn-ssh").addEventListener("change", () => { updateExplain(); updateNameHint(); });
  updateExplain(); updateNameHint();
  nameInput.focus();
}

// client mirror of the server's deriveName — keep the two in sync
function deriveConnName(b) {
  const user = (b.username || "").trim() || "root";
  if (b.ssh && b.ssh_host) return `${user}@${b.ssh_host} (ssh)`;
  const host = (b.host || "").trim() || "127.0.0.1";
  const port = Number(b.port) || 3306;
  return port === 3306 ? `${user}@${host}` : `${user}@${host}:${port}`;
}

function connSpecFromForm() {
  const v = id => document.getElementById(id).value;
  const ssh = document.getElementById("cn-ssh").checked;
  return {
    name: v("cn-name").trim(), host: v("cn-host").trim(), port: Number(v("cn-port")) || 3306,
    username: v("cn-user").trim(), password: v("cn-pass"),
    color: document.querySelector("#cn-colors [data-col][style*='outline']")?.dataset.col || CONN_COLORS[0],
    ssh,
    ssh_host: ssh ? v("cn-sshhost").trim() : null,
    ssh_port: ssh ? (Number(v("cn-sshport")) || 22) : null,
    ssh_user: ssh ? v("cn-sshuser").trim() : null,
    ssh_key: ssh ? v("cn-sshkey") : null,
  };
}

async function testConnForm(id) {
  const out = document.getElementById("cn-testout");
  const btn = document.getElementById("cn-test");
  btn.disabled = true;
  out.innerHTML = `<span class="text-ink-500">testing… (SSH tunnels can take a few seconds)</span>`;
  try {
    const spec = connSpecFromForm();
    if (id != null) spec.id = id; // blank secrets fall back to the stored ones
    const r = await api("/api/connections/test", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(spec) });
    out.innerHTML = r.ok
      ? `<span class="text-green-led">✓ connected in ${r.ms}ms — ${esc(r.version)} as ${esc(r.user)} (${esc(r.via)})</span>`
      : `<span class="text-red-led">✕ ${esc(r.error)}</span>`;
  } catch (e) {
    out.innerHTML = `<span class="text-red-led">✕ ${esc(e.message)}</span>`;
  } finally { btn.disabled = false; }
}

async function saveConn(id, firstRun = false) {
  const spec = connSpecFromForm();
  const creating = id == null;
  try {
    if (!creating) {
      await api("/api/connections/" + id, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(spec) });
    } else {
      const r = await api("/api/connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(spec) });
      id = r.id;
    }
    closeModal();
    await loadConnections();
    // server may have auto-named/deduped — report the name it actually stored
    toast((creating ? "Added " : "Updated ") + (connById(id)?.name || "server") + (creating ? "" : " — pools & tunnels reset"));
    // first-time setup: make the new server active so the app comes alive immediately
    if (creating && firstRun) { await switchConn(id); }
    else if (Number(currentConn) === Number(id)) { schemaCache = {}; loadDatabases().catch(() => {}); }
  } catch (e) { toast(e.message, true); }
}

/* ════════════════ manager ════════════════ */
function openConnManager() {
  openModal(`
    <div class="flex items-center gap-3 px-5 py-4 border-b border-rule-700">
      <span data-ic="server" data-s="15"></span>
      <span class="font-display font-semibold text-[16px]">Servers</span>
      <button class="btn btn-sm btn-primary ml-auto" onclick="closeModal();openConnModal()">${ic("plus", 12)} Add server</button>
    </div>
    <div class="px-5 py-4 flex flex-col gap-1.5 overflow-y-auto" style="max-height:60vh">
      ${connList.map(c => `
        <div class="flex items-center gap-2.5 px-3 py-2 panel">
          <span class="led" style="background:${esc(c.color || CONN_COLORS[0])};flex:none"></span>
          <div class="flex flex-col min-w-0">
            <span class="text-[12.5px] font-medium text-ink-100 truncate">${esc(c.name)}${c.id === Number(currentConn) ? ' <span class="chip chip-green">active</span>' : ""}</span>
            <span class="font-mono text-[10px] text-ink-700 truncate">${c.builtin ? "configured via .env" :
              esc(`${c.username}@${c.host}:${c.port}`) + (c.ssh ? ` · ssh ${esc(c.ssh_user)}@${esc(c.ssh_host)}:${c.ssh_port} (key)` : "")}</span>
          </div>
          <span class="flex-1"></span>
          ${c.builtin ? "" : `
            <button class="btn btn-sm" onclick="closeModal();openConnModal(${c.id})">${ic("pencil", 11)} edit</button>
            <button class="btn btn-sm btn-icon btn-danger" title="Remove server" onclick="deleteConn(${c.id})">${ic("trash", 11)}</button>`}
        </div>`).join("")}
      <div class="mlabel mt-2">credentials are AES-256-GCM encrypted in data/pgadmin.sqlite; the key never leaves this machine</div>
    </div>
    <div class="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-rule-700">
      <button class="btn" onclick="closeModal()">Close</button>
    </div>`);
  hydrateIcons(modalCard);
}

async function deleteConn(id) {
  const c = connById(id);
  if (!confirm(`Remove server "${c?.name}"? Its stored credentials and tunnel are destroyed (the remote database itself is untouched).`)) return;
  try {
    await api("/api/connections/" + id, { method: "DELETE" });
    toast("Removed " + (c?.name || "server"));
    await loadConnections();
    if (Number(currentConn) === Number(id)) await switchConn(0);
    else openConnManager(); // refresh the list in place
  } catch (e) { toast(e.message, true); }
}
