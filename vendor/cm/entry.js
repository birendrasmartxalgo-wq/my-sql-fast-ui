// vendor/cm/entry.js — build-time only. Bundled into public/js/cm6.js (a self-hosted,
// prebuilt static asset, like tools/tailwindcss). The @codemirror/* packages are dev
// dependencies; nothing here ships except the bundled output. Build:
//   bun run cm   →   bun build vendor/cm/entry.js --outfile public/js/cm6.js --minify --target browser --format iife
import { EditorState, Compartment, StateEffect, StateField, RangeSetBuilder } from "@codemirror/state";
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, dropCursor, rectangularSelection, crosshairCursor, placeholder,
  Decoration, ViewPlugin,
} from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  syntaxHighlighting, HighlightStyle, defaultHighlightStyle,
  bracketMatching, indentOnInput,
} from "@codemirror/language";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { setDiagnostics, lintGutter } from "@codemirror/lint";
import { sql, MySQL } from "@codemirror/lang-sql";
import { tags } from "@lezer/highlight";

window.CM6PKG = {
  EditorState, Compartment, StateEffect, StateField, RangeSetBuilder,
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, dropCursor, rectangularSelection, crosshairCursor, placeholder,
  Decoration, ViewPlugin,
  defaultKeymap, history, historyKeymap, indentWithTab,
  syntaxHighlighting, HighlightStyle, defaultHighlightStyle, bracketMatching, indentOnInput,
  autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap,
  setDiagnostics, lintGutter,
  sql, MySQL, tags,
};
