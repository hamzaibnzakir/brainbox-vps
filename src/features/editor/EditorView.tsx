import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Download, RefreshCw, Save, SaveAll, Upload, WrapText, Map as MapIcon, AlignLeft, Search } from "lucide-react";
import type * as Monaco from "monaco-editor/esm/vs/editor/editor.api";
import type { AppError, TextFile } from "@/types/generated";
import { api } from "@/services/api";
import { toAppError } from "@/services/errors";
import { platform } from "@/services/platform";
import { useSettings } from "@/stores/settings";
import { toastError, useUi } from "@/stores/ui";
import { useWorkspace, type Tab } from "@/stores/workspace";
import { Badge, Button, IconButton, Select, Spinner } from "@/components/ui";
import { ErrorPanel } from "@/components/ErrorView";
import { ConnectGate } from "../servers/ConnectGate";
import { languageFor } from "@/lib/languages";
import { basename, dirname, joinPath } from "@/lib/paths";
import { formatBytes, permString } from "@/lib/format";

const LANGS = ["plaintext", "javascript", "typescript", "python", "rust", "go", "php", "html", "css", "scss", "json", "yaml", "markdown", "shell", "nginx", "dockerfile", "dotenv", "sql", "ini", "xml", "log", "powershell"];

function EditorInner({ tab }: { tab: Tab }) {
  const serverId = tab.serverId!;
  const path: string = tab.data.path;
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const [file, setFile] = useState<TextFile | null>(null);
  const [error, setError] = useState<AppError | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirtyState] = useState(false);
  const [lang, setLang] = useState(languageFor(path));
  const [cursor, setCursor] = useState({ line: 1, col: 1, sel: 0 });
  const [conflict, setConflict] = useState(false);
  const settings = useSettings((s) => s.settings);
  const [wrap, setWrap] = useState(settings.editorWordWrap);
  const [minimap, setMinimap] = useState(settings.editorMinimap);
  const setDirtyTab = useWorkspace((s) => s.setDirty);
  const saved = useRef("");
  const fileRef = useRef<TextFile | null>(null);
  fileRef.current = file;

  const setDirty = useCallback(
    (d: boolean) => {
      setDirtyState(d);
      setDirtyTab(tab.id, d);
    },
    [tab.id, setDirtyTab],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const f = await api.sftpReadText(serverId, path);
      setFile(f);
      saved.current = f.content;
      setConflict(false);
      if (editor.current) {
        editor.current.setValue(f.content);
        setDirty(false);
      }
    } catch (e) {
      setError(toAppError(e));
    } finally {
      setLoading(false);
    }
  }, [serverId, path, setDirty]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (force = false) => {
      const ed = editor.current;
      const f = fileRef.current;
      if (!ed || !f) return;
      let content = ed.getValue();
      if (f.eol === "crlf") content = content.replace(/\r?\n/g, "\r\n");
      setSaving(true);
      try {
        const entry = await api.sftpWriteText(serverId, path, content, f.encoding, force ? null : f.modified);
        setFile({ ...f, content, modified: entry.modified, size: entry.size });
        saved.current = ed.getValue();
        setDirty(false);
        setConflict(false);
        useUi.getState().toast({ kind: "success", title: `Saved ${basename(path)}`, body: `${formatBytes(entry.size)} written to the server`, timeout: 2200 });
      } catch (e) {
        const err = toAppError(e);
        if (err.title === "File changed on the server") setConflict(true);
        else toastError(err);
      } finally {
        setSaving(false);
      }
    },
    [serverId, path, setDirty],
  );

  const saveAs = useCallback(async () => {
    const ed = editor.current;
    const f = fileRef.current;
    if (!ed || !f) return;
    const r = await useUi.getState().prompt({ title: "Save as", label: "Remote path", initial: joinPath(dirname(path), basename(path)), confirmLabel: "Save" });
    if (!r?.value.trim()) return;
    try {
      await api.sftpWriteText(serverId, r.value.trim(), ed.getValue(), f.encoding, null);
      useWorkspace.getState().openTab("editor", serverId, { path: r.value.trim() });
    } catch (e) {
      toastError(toAppError(e));
    }
  }, [serverId, path]);

  const download = async () => {
    const dest = await platform.saveDialog({ title: "Download file", defaultPath: basename(path) });
    if (!dest) return;
    try {
      await api.transferStart({ serverId, direction: "download", localPath: dest, remotePath: path, overwrite: true });
      useUi.getState().set({ bottomOpen: true, bottomTab: "transfers" });
    } catch (e) {
      toastError(toAppError(e));
    }
  };
  const upload = async () => {
    const picked = await platform.openDialog({ title: `Replace ${basename(path)} with a local file` });
    if (!picked?.[0]) return;
    const ok = await useUi.getState().confirm({ title: `Replace ${basename(path)}?`, message: "The file on the server will be overwritten with the selected local file.", confirmLabel: "Upload & replace", danger: true });
    if (!ok) return;
    try {
      await api.transferStart({ serverId, direction: "upload", localPath: picked[0], remotePath: path, overwrite: true });
      useUi.getState().set({ bottomOpen: true, bottomTab: "transfers" });
    } catch (e) {
      toastError(toAppError(e));
    }
  };

  // Create the editor once the file is loaded.
  useEffect(() => {
    if (!file || editor.current || !host.current) return;
    let disposed = false;
    void import("./monaco").then(({ setupMonaco }) => {
      if (disposed || !host.current) return;
      const monaco = setupMonaco();
      monacoRef.current = monaco;
      const ed = monaco.editor.create(host.current, {
        value: file.content,
        language: lang,
        theme: document.documentElement.dataset.theme === "light" ? "brainbox-light" : "brainbox-dark",
        fontFamily: '"JetBrains Mono Variable", "Cascadia Code", Consolas, monospace',
        fontSize: settings.editorFontSize,
        fontLigatures: true,
        minimap: { enabled: minimap },
        wordWrap: wrap ? "on" : "off",
        automaticLayout: true,
        smoothScrolling: true,
        cursorSmoothCaretAnimation: "on",
        renderWhitespace: "selection",
        scrollBeyondLastLine: false,
        padding: { top: 8 },
        bracketPairColorization: { enabled: true },
        stickyScroll: { enabled: true },
        tabSize: 2,
        detectIndentation: true,
      });
      editor.current = ed;
      ed.onDidChangeModelContent(() => setDirty(ed.getValue() !== saved.current));
      ed.onDidChangeCursorSelection((e) => {
        const sel = ed.getModel()?.getValueInRange(e.selection).length ?? 0;
        setCursor({ line: e.selection.positionLineNumber, col: e.selection.positionColumn, sel });
      });
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save());
      ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS, () => void saveAs());
      ed.focus();
    });
    return () => {
      disposed = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file !== null]);

  useEffect(() => () => editor.current?.dispose(), []);
  useEffect(() => {
    const m = monacoRef.current;
    const model = editor.current?.getModel();
    if (m && model) m.editor.setModelLanguage(model, lang);
  }, [lang]);
  useEffect(() => editor.current?.updateOptions({ wordWrap: wrap ? "on" : "off", minimap: { enabled: minimap }, fontSize: settings.editorFontSize }), [wrap, minimap, settings.editorFontSize]);

  if (error && !file) return <ErrorPanel error={error} onRetry={() => void load()} />;
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-1 h-9 px-2 border-b border-line bg-bg-1 shrink-0">
        <span className="font-mono text-[12px] text-fg-2 truncate px-1" title={path}>
          {path}
        </span>
        {dirty && <Badge tone="warn">Unsaved</Badge>}
        <div className="flex-1" />
        <Select value={lang} onChange={(e) => setLang(e.target.value)} className="h-6 text-[11.5px] py-0">
          {LANGS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </Select>
        <IconButton label="Find / replace (Ctrl+F / Ctrl+H)" size="xs" onClick={() => editor.current?.getAction("actions.find")?.run()}>
          <Search size={13} />
        </IconButton>
        <IconButton label="Format document" size="xs" onClick={() => void editor.current?.getAction("editor.action.formatDocument")?.run()}>
          <AlignLeft size={13} />
        </IconButton>
        <IconButton label="Word wrap" size="xs" active={wrap} onClick={() => setWrap(!wrap)}>
          <WrapText size={13} />
        </IconButton>
        <IconButton label="Minimap" size="xs" active={minimap} onClick={() => setMinimap(!minimap)}>
          <MapIcon size={13} />
        </IconButton>
        <IconButton label="Reload from server" size="xs" onClick={async () => { if (!dirty || (await useUi.getState().confirm({ title: "Reload and discard changes?", danger: true, confirmLabel: "Reload" }))) void load(); }}>
          <RefreshCw size={13} />
        </IconButton>
        <IconButton label="Download" size="xs" onClick={() => void download()}>
          <Download size={13} />
        </IconButton>
        <IconButton label="Upload local file over this one" size="xs" onClick={() => void upload()}>
          <Upload size={13} />
        </IconButton>
        <div className="w-px h-4 bg-line mx-1" />
        <Button size="xs" variant="ghost" icon={<SaveAll size={12} />} onClick={() => void saveAs()}>
          Save as
        </Button>
        <Button size="xs" variant="primary" icon={<Save size={12} />} loading={saving} disabled={!dirty} onClick={() => void save()} data-testid="editor-save">
          Save
        </Button>
      </div>
      {conflict && (
        <div className="flex items-center gap-3 px-3 py-2 bg-warn/10 border-b border-warn/25 text-[12.5px] text-fg anim-fade">
          <AlertTriangle size={15} className="text-warn" />
          <span className="flex-1">This file was changed on the server after you opened it. Saving now would overwrite those changes.</span>
          <Button size="xs" onClick={() => void load()}>
            Reload theirs
          </Button>
          <Button size="xs" variant="danger" onClick={() => void save(true)}>
            Save anyway
          </Button>
        </div>
      )}
      <div className="flex-1 min-h-0 relative">
        {loading && !file && (
          <div className="absolute inset-0 flex items-center justify-center">
            <Spinner size={20} />
          </div>
        )}
        <div ref={host} className="absolute inset-0" data-testid="monaco-host" />
      </div>
      <div className="h-6 px-3 flex items-center gap-4 border-t border-line bg-bg-1 text-[11px] text-fg-3 shrink-0">
        <span>
          Ln {cursor.line}, Col {cursor.col}
          {cursor.sel > 0 && ` (${cursor.sel} selected)`}
        </span>
        <span>{file?.encoding.toUpperCase()}</span>
        <span>{file?.eol.toUpperCase()}</span>
        <span>{file ? formatBytes(file.size) : ""}</span>
        <span className="font-mono">{file?.permissions != null ? permString(file.permissions) : ""}</span>
        <span className="flex-1" />
        <span>Atomic save · Ctrl+S</span>
      </div>
    </div>
  );
}

export function EditorView({ tab }: { tab: Tab }) {
  return (
    <ConnectGate serverId={tab.serverId!} what="edit this file">
      <EditorInner tab={tab} />
    </ConnectGate>
  );
}
