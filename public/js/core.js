/* core.js — icons, theme, generic helpers, api(), toast, modal, danger guard, SQL literals.
   Loaded first; later files (app/console/…) reference these globals. Plain scripts, no modules. */

/* ════════════════ icons (lucide, inlined — no npm, no CDN) ════════════════ */
const I = {
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5V19A9 3 0 0 0 21 19V5"/><path d="M3 12A9 3 0 0 0 21 12"/>',
  table: '<path d="M12 3v18"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/>',
  eye: '<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>',
  key: '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
  filecode: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m10 12-2 2 2 2"/><path d="m14 16 2-2-2-2"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  merge: '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>',
  swap: '<path d="m16 3 4 4-4 4"/><path d="M20 7H4"/><path d="m8 21-4-4 4-4"/><path d="M4 17h16"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  server: '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
  zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  keyround: '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
  arrowright: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  layers: '<path d="m12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83Z"/><path d="m22 17.65-9.17 4.16a2 2 0 0 1-1.66 0L2 17.65"/><path d="m22 12.65-9.17 4.16a2 2 0 0 1-1.66 0L2 12.65"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
  sparkles: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/>',
  bookmark: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>',
  gauge: '<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>',
  scroll: '<path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>',
  pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  rowinsert: '<path d="M21 12H3"/><path d="M21 5H3"/><path d="M12 16v6"/><path d="M9 19h6"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
};
const ic = (n, s = 14, cls = "") =>
  `<svg class="${cls}" width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:none">${I[n] || ""}</svg>`;
function hydrateIcons(root = document) {
  root.querySelectorAll("[data-ic]").forEach(e => { e.innerHTML = ic(e.dataset.ic, Number(e.dataset.s || 14)); });
}
hydrateIcons();

/* ════════════════ day / night ledger ════════════════ */
function renderDarkIc() {
  document.getElementById("darkic").innerHTML = ic(document.documentElement.classList.contains("dark") ? "sun" : "moon", 14);
}
function toggleDark() {
  const dark = document.documentElement.classList.toggle("dark");
  localStorage.setItem("msq_dark", dark ? "1" : "0");
  renderDarkIc();
  if (window.CM && CM.setDark) CM.setDark(dark);   // re-theme the CodeMirror editor
}
renderDarkIc();

/* ════════════════ generic helpers ════════════════ */
async function api(path, opts = {}) {
  opts.headers = Object.assign({ authorization: "Bearer " + token }, opts.headers || {});
  // thread the active server through every call (harmless on routes that ignore it;
  // the registry routes themselves don't need it but tolerate it)
  if (typeof currentConn !== "undefined" && currentConn && !/[?&]conn=/.test(path)) {
    path += (path.includes("?") ? "&" : "?") + "conn=" + currentConn;
  }
  const res = await fetch(path, opts);
  if (res.status === 401) { showLogin(); throw new Error("Unauthorized"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
function toast(msg, isError = false) {
  const d = document.createElement("div");
  d.className = "toastmsg" + (isError ? " error" : "");
  d.textContent = msg;
  document.getElementById("toast").appendChild(d);
  setTimeout(() => d.remove(), isError ? 8000 : 4000);
}
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const escPre = s => String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const fmtBytes = b => { b = Number(b); if (!b) return "0 B"; const u = ["B","KB","MB","GB","TB"]; const i = Math.floor(Math.log(b)/Math.log(1024)); return (b/1024**i).toFixed(i?1:0) + " " + u[i]; };
const ago = t => { const s = (Date.now() - t) / 1000; if (s < 60) return Math.floor(s) + "s"; if (s < 3600) return Math.floor(s/60) + "m"; if (s < 86400) return Math.floor(s/3600) + "h"; return Math.floor(s/86400) + "d"; };

/* SQL syntax highlight for <pre class=sqlblock> */
const SQL_KEYWORDS = new Set("SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE ALTER DROP INDEX VIEW JOIN INNER LEFT RIGHT FULL OUTER ON GROUP BY ORDER HAVING LIMIT OFFSET DISTINCT AND OR NOT NULL IS IN EXISTS BETWEEN LIKE AS UNION ALL CASE WHEN THEN ELSE END BEGIN COMMIT ROLLBACK GRANT REVOKE PRIMARY KEY FOREIGN REFERENCES UNIQUE DEFAULT CASCADE WITH EXPLAIN ANALYZE TRUNCATE CONSTRAINT ADD COLUMN MODIFY CHANGE RENAME TO USING BTREE HASH IF EXISTS TEXT INT INTEGER BIGINT SMALLINT TINYINT MEDIUMINT BOOLEAN BOOL DECIMAL NUMERIC TIMESTAMP DATETIME JSON CHAR VARCHAR BINARY VARBINARY BLOB ENUM AUTO_INCREMENT UNSIGNED ZEROFILL DOUBLE FLOAT REAL DATE TIME YEAR COUNT SUM AVG MIN MAX COALESCE IFNULL NULLIF NOW CURRENT_TIMESTAMP INTERVAL EXTRACT DATE_FORMAT STR_TO_DATE LIMIT DESCRIBE SHOW DATABASES TABLES ENGINE CHARSET COLLATE".split(" "));
function hlSql(sql) {
  return escPre(sql).replace(/(--[^\n]*)|('(?:[^']|'')*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]+)/g, (m, cmt, str, num, word) => {
    if (cmt) return `<span class="cmt">${cmt}</span>`;
    if (str) return `<span class="str">${str}</span>`;
    if (num) return `<span class="num">${num}</span>`;
    if (word && SQL_KEYWORDS.has(word.toUpperCase())) return `<span class="kw">${word}</span>`;
    return m;
  });
}

/* ════════════════ modal ════════════════ */
const modalEl = document.getElementById("modal"), modalCard = document.getElementById("modalcard");
let modalResolve = null, modalLastFocus = null;
const FOCUSABLE = 'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])';
function openModal(html) {
  modalLastFocus = document.activeElement;
  modalCard.innerHTML = html;
  modalEl.style.display = "flex";
  modalCard.classList.remove("reveal"); void modalCard.offsetWidth; modalCard.classList.add("reveal");
  const first = modalCard.querySelector(FOCUSABLE);
  if (first) first.focus();
}
function closeModal(result = false) {
  modalEl.style.display = "none";
  if (modalResolve) { modalResolve(result); modalResolve = null; }
  if (modalLastFocus && typeof modalLastFocus.focus === "function") { try { modalLastFocus.focus(); } catch {} }
  modalLastFocus = null;
}
modalEl.addEventListener("mousedown", e => { if (e.target === modalEl) closeModal(false); });
document.addEventListener("keydown", e => {
  if (modalEl.style.display !== "flex") return;
  if (e.key === "Escape") { closeModal(false); return; }
  if (e.key === "Tab") {                       // trap focus inside the dialog
    const items = [...modalCard.querySelectorAll(FOCUSABLE)].filter(el => !el.disabled && el.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

/* ════════════════ anchored dropdown menu ════════════════ */
/* a small floating menu pinned under (or above) an anchor element. items:
   [{label, icon?, danger?, onClick}]. Dismisses on outside click / Esc / scroll. */
let _openMenu = null;
function closeMenu() { if (_openMenu) { _openMenu.remove(); _openMenu = null; document.removeEventListener("mousedown", _menuOutside, true); } }
function _menuOutside(e) { if (_openMenu && !_openMenu.contains(e.target)) closeMenu(); }
function anchorMenu(anchorEl, items) {
  closeMenu();
  const m = document.createElement("div");
  m.className = "popmenu";
  m.setAttribute("role", "menu");
  m.innerHTML = items.map((it, i) =>
    `<button role="menuitem" tabindex="${i === 0 ? 0 : -1}" data-mi="${i}" class="popmenu-item${it.danger ? " popmenu-item-danger" : ""}">${it.icon ? ic(it.icon, 13) : ""}<span>${esc(it.label)}</span></button>`).join("");
  document.body.appendChild(m);
  const r = anchorEl.getBoundingClientRect(), mw = m.offsetWidth, mh = m.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - mw - 8);
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4); // flip up if no room
  m.style.left = Math.max(8, left) + "px";
  m.style.top = top + "px";
  m.querySelectorAll("[data-mi]").forEach(b => b.addEventListener("click", () => {
    const it = items[Number(b.dataset.mi)]; closeMenu(); it.onClick();
  }));
  m.addEventListener("keydown", e => {
    const btns = [...m.querySelectorAll("[data-mi]")]; let i = btns.indexOf(document.activeElement);
    if (e.key === "Escape") { closeMenu(); anchorEl.focus(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); (btns[i + 1] || btns[0]).focus(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); (btns[i - 1] || btns[btns.length - 1]).focus(); }
  });
  _openMenu = m;
  (m.querySelector("[data-mi]") || m).focus();
  setTimeout(() => document.addEventListener("mousedown", _menuOutside, true), 0);
}

/* destructive-statement detection — strings/comments stripped first */
function classifyDanger(sql) {
  const clean = sql.replace(/'(?:[^']|'')*'/g, "''").replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const warns = [];
  for (const s of clean.split(";").map(x => x.trim()).filter(Boolean)) {
    const hasWhere = /\bwhere\b/i.test(s);
    let m;
    if ((m = s.match(/^drop\s+(table|database|schema|view|index|role|sequence|function)\s+(?:if\s+exists\s+)?([\w".,\s]+)/i)))
      warns.push({ level: "red", text: `DROP ${m[1].toUpperCase()} ${m[2].trim().split(/\s/)[0]}`, note: "irreversible" });
    else if ((m = s.match(/^truncate\s+(?:table\s+)?(?:only\s+)?([\w".]+)/i)))
      warns.push({ level: "red", text: `TRUNCATE ${m[1]}`, note: "removes every row" });
    else if ((m = s.match(/^delete\s+from\s+(?:only\s+)?([\w".]+)/i)))
      warns.push(hasWhere ? { level: "amber", text: `DELETE FROM ${m[1]}`, note: "with WHERE" }
                          : { level: "red", text: `DELETE FROM ${m[1]}`, note: "NO WHERE — deletes ALL rows" });
    else if ((m = s.match(/^update\s+(?:only\s+)?([\w".]+)/i)))
      warns.push(hasWhere ? { level: "amber", text: `UPDATE ${m[1]}`, note: "with WHERE" }
                          : { level: "red", text: `UPDATE ${m[1]}`, note: "NO WHERE — rewrites ALL rows" });
    else if ((m = s.match(/^alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w".]+)[\s\S]*?\bdrop\b/i)))
      warns.push({ level: "red", text: `ALTER TABLE ${m[1]} … DROP`, note: "drops a column/constraint" });
  }
  return warns;
}
function confirmDanger(warns, sql) {
  const worst = warns.some(w => w.level === "red") ? "red" : "amber";
  return new Promise(resolve => {
    modalResolve = resolve;
    openModal(`
      <div class="flex items-center gap-3 px-5 py-4 border-b border-rule-700">
        <span class="led led-${worst}"></span>
        <span class="font-display font-semibold text-[16px]">Confirm before it's inked</span>
        <span class="chip chip-${worst === "red" ? "red" : "amber"} ml-auto">${worst === "red" ? "destructive" : "mutating"}</span>
      </div>
      <div class="px-5 py-4 flex flex-col gap-3 overflow-y-auto">
        <div class="text-ink-300 text-xs">This will run on <b class="font-mono text-quill-400">${esc((typeof connDisplayName === "function" && connDisplayName() !== "Local" ? connDisplayName() + " › " : "") + currentDb)}</b> and cannot be undone once committed:</div>
        <div class="flex flex-col gap-1.5">${warns.map(w => `
          <div class="flex items-center gap-2 font-mono text-[11.5px]">
            <span class="chip chip-${w.level === "red" ? "red" : "amber"}">${w.level === "red" ? "✕" : "!"}</span>
            <span class="text-ink-100">${esc(w.text)}</span>
            <span class="text-${w.level === "red" ? "red-led" : "amber-led"} ml-auto">${esc(w.note)}</span>
          </div>`).join("")}
        </div>
        <pre class="sqlblock max-h-48 overflow-y-auto">${hlSql(sql)}</pre>
      </div>
      <div class="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-rule-700">
        <button class="btn" onclick="closeModal(false)">Cancel</button>
        <button class="btn ${worst === "red" ? "btn-danger" : "btn-primary"}" onclick="closeModal(true)"><span data-ic="play" data-s="13"></span>Run it</button>
      </div>`);
    hydrateIcons(modalCard);
  });
}

const qid = s => "`" + String(s).replace(/`/g, "``") + "`";
/* SQL literal builder for generated UPDATEs / INSERT exports */
function sqlLit(v, type = "") {
  if (v === null || v === undefined) return "NULL";
  const t = type.toLowerCase();
  // MySQL takes a JSON value straight from a string literal — no cast needed
  const mq = x => "'" + x.replace(/\\/g, "\\\\").replace(/'/g, "''") + "'";
  if (typeof v === "object") return mq(JSON.stringify(v));
  const s = String(v);
  if (/int|numeric|real|double|decimal/.test(t) && /^-?\d+(\.\d+)?$/.test(s)) return s;
  if (/bool/.test(t) && /^(true|false)$/i.test(s)) return s.toLowerCase();
  return mq(s);
}
