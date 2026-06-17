/* ai.js — AI assist: natural-language → SQL ("Ask AI") and one-click error fixing.
   Both go through the server proxy /api/ai (the API key never reaches the browser).
   Generated SQL is ALWAYS placed in the editor for review — never auto-executed. */
let aiAvailable = false; // set from /api/databases response in app.js

function aiSetAvailable(on) {
  aiAvailable = !!on;
  const btn = document.getElementById("askaibtn");
  if (btn) {
    btn.disabled = !on;
    btn.title = on ? "Describe what you want in plain language — get SQL" : "Set ANTHROPIC_API_KEY in the server .env to enable AI";
    btn.style.opacity = on ? "" : ".5";
  }
}

function openAskAi() {
  if (!aiAvailable) return toast("AI is not configured — set ANTHROPIC_API_KEY in the server .env", true);
  if (!currentDb) return toast("Select a database first", true);
  openModal(`
    <div class="flex items-center gap-2.5 px-5 py-4 border-b border-rule-700">
      <span class="text-quill-400" data-ic="sparkles" data-s="15"></span>
      <span class="font-display font-semibold text-[16px]">Ask the ledger</span>
      <span class="chip chip-quill ml-1">${esc(currentDb)}</span>
      <button class="btn btn-sm btn-icon ml-auto" onclick="closeModal()"><span data-ic="x" data-s="13"></span></button>
    </div>
    <div class="px-5 py-4 flex flex-col gap-3 overflow-y-auto min-h-0">
      <label class="mlabel">describe the query in plain language</label>
      <textarea id="ai-q" class="input w-full font-mono text-[12px] min-h-20 resize-y" spellcheck="false"
        placeholder="e.g. today's losing PAPER trades for NIFTY, worst first"></textarea>
      <div id="ai-out" class="hidden flex-col gap-2">
        <div class="mlabel">generated sql · review before running</div>
        <pre class="sqlblock max-h-60 overflow-y-auto" id="ai-sql"></pre>
        <div class="text-xs text-ink-300" id="ai-expl"></div>
      </div>
      <div id="ai-status" class="text-xs font-mono min-h-4"></div>
    </div>
    <div class="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-rule-700">
      <button class="btn" onclick="closeModal()">Cancel</button>
      <button class="btn btn-sm hidden" id="ai-insert"><span data-ic="terminal" data-s="12"></span>Insert into editor</button>
      <button class="btn btn-primary" id="ai-go"><span data-ic="sparkles" data-s="13"></span>Generate SQL</button>
    </div>`);
  hydrateIcons(modalCard);
  const q = document.getElementById("ai-q");
  q.focus();
  q.addEventListener("keydown", e => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") document.getElementById("ai-go").click(); });
  document.getElementById("ai-go").addEventListener("click", () => aiGenerate());
}
async function aiGenerate() {
  const q = document.getElementById("ai-q").value.trim();
  if (!q) return;
  const status = document.getElementById("ai-status"), go = document.getElementById("ai-go");
  status.innerHTML = `<span class="chip"><span class="led led-amber"></span>thinking…</span>`;
  go.disabled = true;
  try {
    const { sql, explanation } = await api("/api/ai", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ db: currentDb, mode: "generate", question: q }),
    });
    status.textContent = "";
    const out = document.getElementById("ai-out");
    out.classList.remove("hidden"); out.classList.add("flex");
    document.getElementById("ai-sql").innerHTML = hlSql(sql);
    document.getElementById("ai-expl").textContent = explanation || "";
    const ins = document.getElementById("ai-insert");
    ins.classList.remove("hidden");
    ins.onclick = () => { setEditorSql(sql); closeModal(); showTab("query"); CM.focus(); toast("SQL inserted — review, then Run"); };
    hydrateIcons(modalCard);
  } catch (e) {
    status.innerHTML = `<span class="text-red-led">✕ ${esc(e.message)}</span>`;
  } finally { go.disabled = false; }
}

/* "Fix with AI" — wired to the buttons console.js renders inside failed-statement blocks */
document.getElementById("results").addEventListener("click", async e => {
  const fix = e.target.closest("[data-aifix]");
  if (!fix || !lastRun) return;
  const r = lastRun.results[Number(fix.dataset.aifix)];
  if (!r || r.ok) return;
  const failingSql = lastRun.sql; // full editor SQL, not the truncated statement echo
  fix.disabled = true;
  fix.innerHTML = `${ic("sparkles", 11)} thinking…`;
  try {
    const { sql, explanation } = await api("/api/ai", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ db: currentDb, mode: "fix", sql: failingSql, error: r.error }),
    });
    openModal(`
      <div class="flex items-center gap-2.5 px-5 py-4 border-b border-rule-700">
        <span class="text-quill-400" data-ic="sparkles" data-s="15"></span>
        <span class="font-display font-semibold text-[16px]">Proposed correction</span>
        <button class="btn btn-sm btn-icon ml-auto" onclick="closeModal()"><span data-ic="x" data-s="13"></span></button>
      </div>
      <div class="px-5 py-4 flex flex-col gap-3 overflow-y-auto min-h-0">
        <div class="mlabel">failed</div>
        <pre class="sqlblock max-h-32 overflow-y-auto !border-l-2 !border-l-red-led">${hlSql(failingSql)}</pre>
        <div class="text-red-led font-mono text-[11px]">${esc(r.error)}</div>
        <div class="mlabel">corrected · review before running</div>
        <pre class="sqlblock max-h-60 overflow-y-auto !border-l-2 !border-l-green-led">${hlSql(sql)}</pre>
        ${explanation ? `<div class="text-xs text-ink-300">${esc(explanation)}</div>` : ""}
      </div>
      <div class="flex items-center justify-end gap-2 px-5 py-3.5 border-t border-rule-700">
        <button class="btn" onclick="closeModal()">Dismiss</button>
        <button class="btn btn-primary" id="aifix-insert"><span data-ic="terminal" data-s="13"></span>Insert into editor</button>
      </div>`);
    hydrateIcons(modalCard);
    document.getElementById("aifix-insert").addEventListener("click", () => {
      setEditorSql(sql); closeModal(); CM.focus();
      toast("Corrected SQL inserted — review, then Run");
    });
  } catch (e2) {
    toast(e2.message, true);
  } finally {
    fix.disabled = false;
    fix.innerHTML = `${ic("sparkles", 11)} Fix with AI`;
  }
});
