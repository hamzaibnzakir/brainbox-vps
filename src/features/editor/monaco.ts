/**
 * Monaco setup: local workers (no CDN), Brainbox themes, and extra languages
 * (nginx, dotenv, log) not shipped with Monaco.
 */
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/editor/editor.all";
import "monaco-editor/esm/vs/basic-languages/monaco.contribution";
import "monaco-editor/esm/vs/language/json/monaco.contribution";
import "monaco-editor/esm/vs/language/css/monaco.contribution";
import "monaco-editor/esm/vs/language/html/monaco.contribution";
import "monaco-editor/esm/vs/language/typescript/monaco.contribution";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

self.MonacoEnvironment = {
  getWorker(_id: string, label: string) {
    if (label === "json") return new JsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new CssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new HtmlWorker();
    if (label === "typescript" || label === "javascript") return new TsWorker();
    return new EditorWorker();
  },
};

let ready = false;
export function setupMonaco() {
  if (ready) return monaco;
  ready = true;
  monaco.languages.register({ id: "nginx" });
  monaco.languages.setMonarchTokensProvider("nginx", {
    tokenizer: {
      root: [
        [/#.*$/, "comment"],
        [/\b(server|location|http|events|upstream|map|if|include|listen|server_name|root|index|proxy_pass|return|rewrite|try_files|ssl_certificate|ssl_certificate_key|add_header|proxy_set_header|error_page|access_log|error_log|gzip|worker_processes|worker_connections|user|pid|sendfile|keepalive_timeout|client_max_body_size|fastcgi_pass|limit_req|default_type|alias|deny|allow)\b/, "keyword"],
        [/\$[a-zA-Z_][\w]*/, "variable"],
        [/\b\d+[kKmMgGsSdh]?\b/, "number"],
        [/"([^"\\]|\\.)*"/, "string"],
        [/'([^'\\]|\\.)*'/, "string"],
        [/[{};]/, "delimiter"],
        [/~\*?|=|\^~/, "operator"],
      ],
    },
  });
  monaco.languages.setLanguageConfiguration("nginx", { comments: { lineComment: "#" }, brackets: [["{", "}"]], autoClosingPairs: [{ open: "{", close: "}" }, { open: '"', close: '"' }, { open: "'", close: "'" }] });
  monaco.languages.register({ id: "dotenv" });
  monaco.languages.setMonarchTokensProvider("dotenv", {
    tokenizer: {
      root: [
        [/#.*$/, "comment"],
        [/^\s*(export\s+)?[A-Za-z_][A-Za-z0-9_.]*(?=\s*=)/, "variable"],
        [/=/, "delimiter"],
        [/"([^"\\]|\\.)*"/, "string"],
        [/'[^']*'/, "string"],
        [/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/, "keyword"],
      ],
    },
  });
  monaco.languages.setLanguageConfiguration("dotenv", { comments: { lineComment: "#" } });
  monaco.languages.register({ id: "log" });
  monaco.languages.setMonarchTokensProvider("log", {
    tokenizer: {
      root: [
        [/\b(ERROR|FATAL|CRIT|CRITICAL|EMERG|ALERT|error|fatal|failed|Failed)\b.*$/, "invalid"],
        [/\b(WARN|WARNING|warn|warning)\b/, "keyword"],
        [/\b(INFO|NOTICE|DEBUG|TRACE)\b/, "type"],
        [/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?Z?/, "number"],
        [/\b\d{1,3}(\.\d{1,3}){3}\b/, "string"],
      ],
    },
  });
  monaco.editor.defineTheme("brainbox-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6f6f88", fontStyle: "italic" },
      { token: "keyword", foreground: "b69bff" },
      { token: "string", foreground: "7fe0a8" },
      { token: "number", foreground: "ffcf7a" },
      { token: "variable", foreground: "7cc5ff" },
      { token: "type", foreground: "5ad7f0" },
      { token: "invalid", foreground: "ff7a85" },
    ],
    colors: {
      "editor.background": "#0f0f17",
      "editor.foreground": "#e3e3ee",
      "editorLineNumber.foreground": "#4b4b60",
      "editorLineNumber.activeForeground": "#a8a8bd",
      "editor.lineHighlightBackground": "#17172380",
      "editor.selectionBackground": "#7c5cff45",
      "editor.inactiveSelectionBackground": "#7c5cff25",
      "editorCursor.foreground": "#9b82ff",
      "editorIndentGuide.background1": "#22222f",
      "editorWidget.background": "#13131d",
      "editorWidget.border": "#2e2e42",
      "minimap.background": "#0f0f17",
      "scrollbarSlider.background": "#2c2c4080",
    },
  });
  monaco.editor.defineTheme("brainbox-light", {
    base: "vs",
    inherit: true,
    rules: [{ token: "comment", foreground: "8a8aa0", fontStyle: "italic" }],
    colors: { "editor.background": "#ffffff", "editor.selectionBackground": "#7c5cff30", "editorCursor.foreground": "#7c5cff" },
  });
  return monaco;
}

export { monaco };
