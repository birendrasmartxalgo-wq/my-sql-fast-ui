/* editor.js — CodeMirror 6 SQL editor + a thin facade (window.CM) the rest of the
   console talks to. Loads after the vendored bundle (cm6.js) and before console.js,
   so window.CM exists by the time other modules call setEditorSql / runQuery / etc. */
(function () {
  const P = window.CM6PKG;
  const host = document.getElementById("sqlbox");
  if (!P || !host) { console.error("[editor] CodeMirror bundle or #sqlbox host missing"); return; }

  /* syntax colours map to the same CSS tokens as .sqlblock — they flip with dark mode
     automatically via var(), so no theme swap is needed on toggle. */
  const highlight = P.HighlightStyle.define([
    { tag: P.tags.keyword, color: "var(--color-quill-400)", fontWeight: "600" },
    { tag: P.tags.string, color: "var(--color-str)" },
    { tag: P.tags.number, color: "var(--color-num)" },
    { tag: P.tags.bool, color: "var(--color-num)" },
    { tag: P.tags.null, color: "var(--color-num)" },
    { tag: P.tags.lineComment, color: "var(--color-ink-500)", fontStyle: "italic" },
    { tag: P.tags.blockComment, color: "var(--color-ink-500)", fontStyle: "italic" },
    { tag: P.tags.operator, color: "var(--color-ink-500)" },
    { tag: P.tags.typeName, color: "var(--color-quill-300)" },
    { tag: P.tags.variableName, color: "var(--color-ink-100)" },
  ]);

  const theme = P.EditorView.theme({
    "&": { color: "var(--color-ink-100)", backgroundColor: "transparent", fontSize: "13px" },
    ".cm-content": { fontFamily: "var(--font-mono)", caretColor: "var(--color-ink-100)", padding: "8px 0" },
    ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.55", overflow: "auto" },
    "&.cm-editor": { minHeight: "150px", maxHeight: "440px", border: "1px solid var(--color-rule-500)", borderRadius: "4px", backgroundColor: "var(--color-paper-900)" },
    "&.cm-editor.cm-focused": { outline: "none", boxShadow: "0 0 0 2px color-mix(in oklab, var(--color-quill-500) 25%, transparent)", borderColor: "var(--color-quill-500)" },
    ".cm-gutters": { backgroundColor: "var(--color-paper-900)", color: "var(--color-ink-700)", border: "none", borderRight: "1px solid var(--color-rule-700)" },
    ".cm-activeLineGutter": { backgroundColor: "color-mix(in oklab, var(--color-quill-500) 10%, transparent)", color: "var(--color-ink-500)" },
    ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--color-quill-500) 5%, transparent)" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--color-ink-100)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": { backgroundColor: "color-mix(in oklab, var(--color-quill-500) 26%, transparent)" },
    ".cm-matchingBracket": { backgroundColor: "color-mix(in oklab, var(--color-quill-500) 22%, transparent)", outline: "none" },
    ".cm-tooltip": { backgroundColor: "var(--color-paper-850)", border: "1px solid var(--color-rule-500)", borderRadius: "4px", boxShadow: "0 8px 24px -8px var(--shadow-color)" },
    ".cm-tooltip-autocomplete > ul > li": { fontFamily: "var(--font-mono)", fontSize: "12.5px", color: "var(--color-ink-300)", padding: "3px 8px" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "color-mix(in oklab, var(--color-quill-500) 18%, transparent)", color: "var(--color-quill-300)" },
    ".cm-completionDetail": { color: "var(--color-ink-700)", fontStyle: "normal", marginLeft: "1.5em" },
    ".cm-placeholder": { color: "var(--color-ink-700)" },
  });

  /* offset-aware statement splitter — a faithful port of server/db.js splitStatements
     (same handling of '…', E'…', "…", $tag$…$tag$, -- and nested /* * / comments) so the
     i-th client segment lines up with the i-th statement the server ran. Adds from/to. */
  function clientSplit(script) {
    const out = [];
    let i = 0, start = 0, n = script.length;
    const push = (from, to) => {
      const raw = script.slice(from, to);
      const t = raw.trim();
      if (!t) return;
      const lead = raw.length - raw.replace(/^\s+/, "").length;
      out.push({ from: from + lead, to: from + lead + t.length, text: t });
    };
    while (i < n) {
      const c = script[i];
      if (c === "'") {
        const escaping = /[eE]/.test(script[i - 1] || "") && !/[a-zA-Z0-9_]/.test(script[i - 2] || "");
        i++;
        while (i < n) {
          if (escaping && script[i] === "\\") { i += 2; continue; }
          if (script[i] === "'") { if (script[i + 1] === "'") { i += 2; continue; } i++; break; }
          i++;
        }
      } else if (c === '"') {
        i++;
        while (i < n) { if (script[i] === '"') { if (script[i + 1] === '"') { i += 2; continue; } i++; break; } i++; }
      } else if (c === "$") {
        const m = /^\$[a-zA-Z_]?[a-zA-Z0-9_]*\$/.exec(script.slice(i, i + 64));
        if (m) { const tag = m[0]; const end = script.indexOf(tag, i + tag.length); i = end === -1 ? n : end + tag.length; }
        else i++;
      } else if (c === "-" && script[i + 1] === "-") {
        const nl = script.indexOf("\n", i); i = nl === -1 ? n : nl + 1;
      } else if (c === "/" && script[i + 1] === "*") {
        let depth = 1; i += 2;
        while (i < n && depth > 0) {
          if (script[i] === "/" && script[i + 1] === "*") { depth++; i += 2; }
          else if (script[i] === "*" && script[i + 1] === "/") { depth--; i += 2; }
          else i++;
        }
      } else if (c === ";") {
        push(start, i); i++; start = i;
      } else i++;
    }
    push(start, n);
    return out;
  }

  function currentStatementText(view) {
    const pos = view.state.selection.main.head;
    const segs = clientSplit(view.state.doc.toString());
    const seg = segs.find(s => pos >= s.from && pos <= s.to) || segs[segs.length - 1];
    return seg ? seg.text : view.state.doc.toString();
  }

  /* Mod-Enter runs selection if any, else the statement under the cursor;
     Mod-Shift-Enter runs the whole document. Ordered before the default keymap. */
  const runKeymap = P.keymap.of([
    { key: "Mod-Enter", preventDefault: true, run(view) {
        const sel = view.state.selection.main;
        const text = !sel.empty ? view.state.sliceDoc(sel.from, sel.to) : currentStatementText(view);
        if (typeof runQuerySql === "function") runQuerySql(text);
        return true;
      } },
    { key: "Mod-Shift-Enter", preventDefault: true, run() {
        if (typeof runQuery === "function") runQuery();
        return true;
      } },
  ]);

  // late-bound so autocomplete.js (loaded after this file) can define the source
  const completionSource = ctx => (window.pgCompletionSource ? window.pgCompletionSource(ctx) : null);

  const view = new P.EditorView({
    parent: host,
    doc: "",
    extensions: [
      P.lineNumbers(),
      P.highlightActiveLine(),
      P.highlightActiveLineGutter(),
      P.history(),
      P.bracketMatching(),
      P.drawSelection(),
      P.dropCursor(),
      P.sql({ dialect: P.MySQL, upperCaseKeywords: false }),
      P.syntaxHighlighting(highlight),
      P.lintGutter(),
      P.autocompletion({ override: [completionSource], activateOnTyping: true, icons: false }),
      P.EditorView.lineWrapping,
      P.placeholder("-- Select a database, then write SQL. DDL · DML · DCL all run here.\n-- Autocomplete: keywords, tables & columns appear as you type. ⌃↵ runs the statement, ⌃⇧↵ runs all."),
      runKeymap,
      P.keymap.of([...P.defaultKeymap, ...P.historyKeymap, ...P.completionKeymap, P.indentWithTab]),
      P.EditorView.updateListener.of(u => { if (u.selectionSet || u.docChanged) window.onCMSelection?.(!u.state.selection.main.empty); }),
      theme,
    ],
  });

  /* facade — the public contract the rest of the console relies on */
  window.CM = {
    view,
    getDoc: () => view.state.doc.toString(),
    setDoc(s) { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: s ?? "" } }); },
    replaceSel(s) { view.dispatch(view.state.replaceSelection(s ?? "")); view.focus(); },
    selText() { const s = view.state.selection.main; return s.empty ? "" : view.state.sliceDoc(s.from, s.to); },
    focus() { view.focus(); },
    setDark() { view.requestMeasure(); },          // colours flip via var(); just re-measure
    clientSplit,
    clearErrors() { view.dispatch(P.setDiagnostics(view.state, [])); },
    markErrors(results) {
      const segs = clientSplit(view.state.doc.toString());
      const diags = [];
      (results || []).forEach((r, idx) => {
        if (r && !r.ok && segs[idx]) {
          diags.push({
            from: segs[idx].from, to: segs[idx].to, severity: "error",
            message: (r.sqlstate ? r.sqlstate + " — " : "") + (r.friendly || r.error || "error"),
          });
        }
      });
      view.dispatch(P.setDiagnostics(view.state, diags));
    },
  };
})();
