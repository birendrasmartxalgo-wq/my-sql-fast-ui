/* boot.js — loaded last: app initialisation after every module is in scope. */
async function init() {
  await loadConnections(); // populate the server switcher + conninfo before any data loads
  builderMode("create");
  if (!document.querySelector("[data-coldef]")) addColRow("id", "BIGINT AUTO_INCREMENT");
  if (localStorage.getItem("msq_histopen")) { document.getElementById("histdrawer").classList.remove("hidden"); document.getElementById("histdrawer").classList.add("flex"); renderHistory(); }
  try {
    await loadDatabases();
  } catch (e) {
    handleDbUnreachable(e); // wrong/absent local creds on a fresh machine → first-run setup
  }
}

// The active connection couldn't list databases. If nothing is configured yet (fresh
// install, default local MySQL unreachable), guide the user through first-time setup;
// otherwise show an inline error + a way into the server manager.
function handleDbUnreachable(e) {
  document.getElementById("latency").innerHTML = `<span class="led led-red"></span><span>offline</span>`;
  const el = document.getElementById("dblist");
  const hasRealServer = connList.some(c => !c.builtin);
  if (!hasRealServer) {
    el.innerHTML = `<button class="btn btn-primary w-full mt-2" onclick="openConnModal(null,true)">${ic("plus", 12)} Set up your database</button>`;
    hydrateIcons(el);
    openConnModal(null, true);
  } else {
    el.innerHTML = `<div class="text-red-led text-xs py-2 leading-relaxed">${esc(e.message)}</div>
      <button class="btn btn-sm w-full mt-1" onclick="openConnManager()">${ic("server", 11)} Manage servers</button>`;
    hydrateIcons(el);
    toast("Could not reach " + connDisplayName() + ": " + e.message, true);
  }
}
(async () => {
  if (!token) return showLogin();
  // auth probe against the registry (never touches MySQL — an unreachable saved
  // remote server must not lock the whole UI out)
  try { await api("/api/connections"); document.getElementById("login").style.display = "none"; }
  catch { return; /* 401 already routed to showLogin */ }
  try { await init(); }
  catch (e) { toast("Could not reach " + (typeof connDisplayName === "function" ? connDisplayName() : "the server") + ": " + e.message, true); }
})();
