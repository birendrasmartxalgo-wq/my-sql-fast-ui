/* transfer.js — Transfer tab: mysqldump export and mysql/mysql import. */
function fillDbSelects() {
  const opts = databases.map(d => `<option ${d.name === currentDb ? "selected" : ""}>${esc(d.name)}</option>`).join("");
  document.getElementById("exp-db").innerHTML = opts;
  document.getElementById("imp-db").innerHTML = opts;
}
function exportDb(format) {
  const db = document.getElementById("exp-db").value;
  if (!db) return toast("Pick a database", true);
  const a = document.createElement("a");
  a.href = `/api/export?db=${encodeURIComponent(db)}&format=${format}&conn=${currentConn}&token=${encodeURIComponent(token)}`;
  a.download = "";
  a.click();
  toast(`Exporting ${db} (${format})…`);
}
async function importDb() {
  const fileEl = document.getElementById("imp-file");
  if (!fileEl.files.length) return toast("Choose a file", true);
  const create = document.getElementById("imp-create").checked;
  const db = create ? document.getElementById("imp-newname").value.trim() : document.getElementById("imp-db").value;
  if (!db) return toast(create ? "Enter the new database name" : "Pick a target database", true);
  const out = document.getElementById("imp-out");
  out.classList.remove("hidden");
  out.textContent = "importing…";
  try {
    const res = await fetch(`/api/import?db=${encodeURIComponent(db)}${create ? "&create=1" : ""}&conn=${currentConn}`, {
      method: "POST", headers: { authorization: "Bearer " + token }, body: fileEl.files[0],
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Import failed");
    out.textContent = `[${data.tool} exit ${data.exitCode}]\n` + (data.stderr || "") + (data.stdout || "");
    toast(data.ok ? `Imported into ${db}` : `Import finished with errors (exit ${data.exitCode})`, !data.ok);
    loadDatabases();
  } catch (e) { out.textContent = e.message; toast(e.message, true); }
}
