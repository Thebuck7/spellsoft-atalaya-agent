import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Terminal as Xterm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { zip } from "fflate";
import "@xterm/xterm/css/xterm.css";
import "./style.css";

const DEFAULT_FONT =
  'ui-monospace, "Cascadia Code", "Fira Code", "SF Mono", Menlo, Consolas, monospace';
const DEFAULT_THEME = { background: "#1e1e1e", foreground: "#d4d4d4" };

function newId() {
  try {
    if (crypto?.randomUUID) return crypto.randomUUID();
  } catch {
    /* not available */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Zips [{relPath, file}] (relPath keeps the folder structure, e.g.
 *  "MyFolder/sub/a.txt") into a single Uint8Array, in-browser. */
async function zipEntries(entries) {
  const map = {};
  for (const { relPath, file } of entries) {
    map[relPath] = new Uint8Array(await file.arrayBuffer());
  }
  return new Promise((resolve, reject) => {
    zip(map, { level: 6 }, (err, data) => (err ? reject(err) : resolve(data)));
  });
}

/** Recursively walks a dropped DataTransferItemList, resolving directories,
 *  into a flat [{relPath, file}] list (relPath includes the top folder name
 *  when one was dropped). Returns null if nothing dir-like was found, so the
 *  caller can fall back to the plain flat-file drop path. */
async function walkDroppedItems(items) {
  const entries = Array.from(items || [])
    .map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null))
    .filter(Boolean);
  if (!entries.length || !entries.some((e) => e.isDirectory)) return null;

  const out = [];
  async function walk(entry, prefix) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ relPath: prefix + entry.name, file });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      const children = await new Promise((res, rej) => reader.readEntries(res, rej));
      for (const child of children) await walk(child, prefix + entry.name + "/");
    }
  }
  for (const entry of entries) await walk(entry, "");
  return out;
}

/** Copy text to the clipboard. Falls back to execCommand on insecure origins
 *  (http://<LAN-ip>), where navigator.clipboard is unavailable. */
async function writeClipboard(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to execCommand */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText =
      "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Read the clipboard. Only works on secure origins (https / localhost);
 *  elsewhere returns null and callers fall back to the native paste event. */
async function readClipboard() {
  try {
    if (navigator.clipboard?.readText) return await navigator.clipboard.readText();
  } catch {
    /* not permitted / insecure context */
  }
  return null;
}

/** CSI sequence for a cursor key, respecting DECCKM (application cursor mode). */
function csi(term, letter) {
  const app = term?.modes?.applicationCursorKeysMode;
  return (app ? "\x1bO" : "\x1b[") + letter;
}

/** xterm modifier parameter: 1=none, +1 shift, +2 alt, +4 ctrl. */
function modParam(ctrl, alt, shift) {
  let n = 1;
  if (shift) n += 1;
  if (alt) n += 2;
  if (ctrl) n += 4;
  return n;
}

const ARROW_LETTER = { up: "A", down: "B", right: "C", left: "D" };
const TILDE_CODE = { pgup: 5, pgdn: 6, del: 3 };

/** Build the escape sequence for a navigation key, applying sticky Ctrl/Alt as an xterm modifier. */
function specialKeySeq(term, kind, ctrl, alt) {
  const mod = modParam(ctrl, alt, false);
  if (ARROW_LETTER[kind]) {
    const letter = ARROW_LETTER[kind];
    return mod > 1 ? `\x1b[1;${mod}${letter}` : csi(term, letter);
  }
  if (kind === "home" || kind === "end") {
    const letter = kind === "home" ? "H" : "F";
    return mod > 1 ? `\x1b[1;${mod}${letter}` : csi(term, letter);
  }
  const code = TILDE_CODE[kind];
  return mod > 1 ? `\x1b[${code};${mod}~` : `\x1b[${code}~`;
}

/** Ctrl+<char> control code, e.g. "c" -> \x03. Returns null when not representable. */
function ctrlCode(ch) {
  const c = ch.toUpperCase();
  if (c.length === 1 && c >= "A" && c <= "Z") {
    return String.fromCharCode(c.charCodeAt(0) - 64);
  }
  const map = { "@": 0, "[": 27, "\\": 28, "]": 29, "^": 30, _: 31, "?": 127 };
  return Object.prototype.hasOwnProperty.call(map, ch)
    ? String.fromCharCode(map[ch])
    : null;
}

/** Turn a path or absolute ws URL + token + sessionId into a full ws:// URL. */
function resolveUrl(url, token, sessionId) {
  let out = url || "/ws";
  if (!/^wss?:\/\//i.test(out)) {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    out = `${proto}//${window.location.host}${out.startsWith("/") ? "" : "/"}${out}`;
  }
  const params = [];
  if (token) params.push("token=" + encodeURIComponent(token));
  if (sessionId) params.push("sessionId=" + encodeURIComponent(sessionId));
  if (params.length) out += (out.includes("?") ? "&" : "?") + params.join("&");
  return out;
}

/** Same-origin by default; if `url` is an absolute ws(s):// URL pointing
 *  elsewhere, the file routes live at that same host over http(s). */
function resolveHttpOrigin(url) {
  if (!/^wss?:\/\//i.test(url || "")) return "";
  const u = new URL(url);
  return (u.protocol === "wss:" ? "https:" : "http:") + "//" + u.host;
}

function formatBytes(n) {
  if (!Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

/**
 * <WebTerm /> — a terminal wired to a WebSocket that speaks:
 *   client -> server : {"type":"input","data":"..."}  /  {"type":"resize","cols":N,"rows":N}
 *   server -> client : raw terminal output (string)
 *
 * Props:
 *   url             ws path or absolute URL (default "/ws")
 *   token           optional auth token, sent as ?token=
 *   persist         keep the server-side session across a page refresh (default false).
 *                   Stores a session id in sessionStorage and sends it as ?sessionId=;
 *                   the server replays recent scrollback on reattach.
 *   persistKey      sessionStorage key to use (default "webterm:" + url)
 *   fontSize        number (default 14)
 *   fontFamily      string
 *   theme           xterm theme object
 *   cursorBlink     bool (default true)
 *   autoReconnect   bool (default false)
 *   reconnectDelay  ms between retries (default 1000)
 *   header          show the status bar + reconnect button (default false)
 *   onStatusChange  (status) => void   "connecting" | "connected" | "disconnected"
 *   onData          (chunk) => void    raw output, as it arrives
 *   className, style, ...rest          forwarded to the wrapper <div>
 *
 *   copyOnSelect     copy the mouse selection to the clipboard (default true)
 *   pasteOnRightClick  right-click pastes when there's no selection (default
 *                    false; needs https/localhost). Right-click always copies
 *                    the current selection first, regardless of this flag.
 *
 *   mobileToolbar    true | false | "auto" (default "auto"): show a row of
 *                    buttons (Esc, Tab, Ctrl, Alt, arrows, Inicio/Fin,
 *                    RePág/AvPág, Supr) for keys a mobile on-screen keyboard
 *                    doesn't have. "auto" shows it on coarse-pointer (touch)
 *                    devices. The row itself can be collapsed/expanded with a
 *                    toggle handle; Ctrl/Alt are sticky — tap one, then the
 *                    next key (typed or tapped) is sent with that modifier.
 *
 *   files            show the upload (⬆) / download (⬇) controls over the
 *                    terminal, and enable drag & drop of files onto it
 *                    (default true). Requires the server's attachWebTerm to
 *                    have `files` enabled (default) and its filesMiddleware
 *                    mounted. Files always land in / are read from the
 *                    shell's *current* cwd (resolved live, so `cd` in the
 *                    terminal changes where the next upload/download goes).
 *                    Whole folders work too: the "⬆📁" button (or dropping a
 *                    folder onto the terminal) zips it in the browser and
 *                    extracts it server-side, preserving subfolders; "⬇📁" in
 *                    the browse bar (and a small ⬇ next to each folder in the
 *                    listing) downloads a folder back as a .zip.
 *   filesPath        base path for the file HTTP routes (default "/webterm-files")
 *
 * Clipboard keys: Ctrl/Cmd+Shift+C and Ctrl+Insert copy the selection;
 * Ctrl/Cmd+V, Ctrl+Shift+V and Shift+Insert paste. Plain Ctrl+C still sends
 * SIGINT unless there is a selection.
 *
 * Ref API: focus(), fit(), clear(), write(data), sendInput(data), reconnect(),
 *          newSession(), endSession(), copySelection(), paste(text?),
 *          uploadFiles(fileList), getSessionId(), getTerminal(), getSocket()
 */
export const WebTerm = forwardRef(function WebTerm(props, ref) {
  const {
    url = "/ws",
    token,
    sessionId: sessionIdProp,
    persist = false,
    persistKey,
    fontSize = 14,
    fontFamily = DEFAULT_FONT,
    theme,
    cursorBlink = true,
    autoReconnect = false,
    reconnectDelay = 1000,
    header = false,
    copyOnSelect = true,
    pasteOnRightClick = false,
    mobileToolbar = "auto",
    files = true,
    filesPath = "/webterm-files",
    onStatusChange,
    onData,
    className,
    style,
    ...rest
  } = props;

  const storageKey = persistKey || `webterm:${url}`;

  const rootRef = useRef(null);
  const keysbarRef = useRef(null);
  const screenRef = useRef(null);
  const termRef = useRef(null);
  const fitRef = useRef(null);
  const wsRef = useRef(null);
  const retryRef = useRef(null);
  const firstConnectRef = useRef(true);
  const deadRef = useRef(false); // set by endSession() -> stop reconnecting
  const cbRef = useRef({});
  cbRef.current.onData = onData;
  cbRef.current.onStatusChange = onStatusChange;
  cbRef.current.copyOnSelect = copyOnSelect;
  cbRef.current.pasteOnRightClick = pasteOnRightClick;

  // Resolve the session id synchronously, before the connect effect runs.
  // Precedence: explicit `sessionId` prop > persisted (sessionStorage) > ephemeral.
  // Even the ephemeral case gets a real id (not null): the server accepts
  // whatever id the client sends as ?sessionId=, and the client needs to know
  // it too, to address the files routes (list/upload/download) at that
  // session — not just to support `persist` reattachment.
  const sessionIdRef = useRef(undefined);
  if (sessionIdRef.current === undefined) {
    sessionIdRef.current = sessionIdProp || null;
    if (!sessionIdProp && persist) {
      try {
        let id = window.sessionStorage.getItem(storageKey);
        if (!id) {
          id = newId();
          window.sessionStorage.setItem(storageKey, id);
        }
        sessionIdRef.current = id;
      } catch {
        sessionIdRef.current = newId(); // storage blocked -> still ephemeral, just not persisted
      }
    } else if (!sessionIdProp) {
      sessionIdRef.current = newId();
    }
  } else if (sessionIdProp && sessionIdProp !== sessionIdRef.current) {
    // Parent handed us a different session id -> switch to it on next connect.
    sessionIdRef.current = sessionIdProp;
  }

  const [status, setStatus] = useState("connecting");
  const [nonce, setNonce] = useState(0);

  const setStat = useCallback((s) => {
    setStatus(s);
    cbRef.current.onStatusChange?.(s);
  }, []);

  const sendResize = useCallback(() => {
    const term = termRef.current;
    const ws = wsRef.current;
    if (!term || !ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  }, []);

  const reconnect = useCallback(() => setNonce((n) => n + 1), []);

  const newSession = useCallback(() => {
    const id = newId();
    if (persist) {
      try {
        window.sessionStorage.setItem(storageKey, id);
      } catch {
        /* ignore */
      }
    }
    sessionIdRef.current = id;
    firstConnectRef.current = true; // treat like a fresh mount (no reset flash)
    deadRef.current = false;
    termRef.current?.reset();
    setNonce((n) => n + 1);
  }, [persist, storageKey]);

  // End the server-side session for good (kills the PTY), and stop reconnecting.
  const endSession = useCallback(() => {
    deadRef.current = true;
    const ws = wsRef.current;
    try {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "kill" }));
      }
    } catch {
      /* ignore */
    }
    if (persist && !sessionIdProp) {
      try {
        window.sessionStorage.removeItem(storageKey);
      } catch {
        /* ignore */
      }
    }
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
  }, [persist, sessionIdProp, storageKey]);

  const copySelection = useCallback(() => {
    const sel = termRef.current?.getSelection() || "";
    if (sel) writeClipboard(sel).then(() => termRef.current?.focus());
    return sel;
  }, []);

  const paste = useCallback(async (text) => {
    const t = text ?? (await readClipboard());
    if (t != null && t !== "") termRef.current?.paste(t);
  }, []);

  // ── Files: upload into / download from the shell's current cwd ─────────
  const filesOrigin = resolveHttpOrigin(url);
  const fileInputRef = useRef(null);
  const folderInputRef = useRef(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploads, setUploads] = useState([]); // {id,name,progress,status:"uploading"|"done"|"error"}
  const [browseOpen, setBrowseOpen] = useState(false);
  const [browseDir, setBrowseDir] = useState("");
  const [browseEntries, setBrowseEntries] = useState(null);
  const [browseError, setBrowseError] = useState("");

  const filesUrl = useCallback(
    (route, extra) => {
      const qs = new URLSearchParams();
      qs.set("sessionId", sessionIdRef.current || "");
      if (token) qs.set("token", token);
      for (const k in extra) if (extra[k] != null) qs.set(k, extra[k]);
      return `${filesOrigin}${filesPath}/${route}?${qs.toString()}`;
    },
    [filesOrigin, filesPath, token],
  );

  const uploadFiles = useCallback(
    (fileList) => {
      const list = Array.from(fileList || []);
      if (!list.length || !sessionIdRef.current) return;
      for (const file of list) {
        const id = newId();
        setUploads((u) => [...u, { id, name: file.name, progress: 0, status: "uploading" }]);
        const xhr = new XMLHttpRequest();
        xhr.open("POST", filesUrl("upload", { name: file.name, dir: browseDir || undefined }));
        xhr.upload.onprogress = (e) => {
          if (!e.lengthComputable) return;
          const progress = Math.round((e.loaded / e.total) * 100);
          setUploads((u) => u.map((x) => (x.id === id ? { ...x, progress } : x)));
        };
        const settle = (status) => {
          setUploads((u) => u.map((x) => (x.id === id ? { ...x, progress: 100, status } : x)));
          if (status === "done") {
            setTimeout(() => setUploads((u) => u.filter((x) => x.id !== id)), 2500);
            if (browseOpen) loadDirRef.current?.(browseDir);
          }
        };
        xhr.onload = () => settle(xhr.status >= 200 && xhr.status < 300 ? "done" : "error");
        xhr.onerror = () => settle("error");
        xhr.send(file);
      }
    },
    [filesUrl, browseDir, browseOpen],
  );

  // Zipea [{relPath, file}] en el navegador y lo sube a upload-dir, que lo
  // extrae preservando la estructura de carpetas.
  const uploadFolderEntries = useCallback(
    (entries, label) => {
      if (!entries?.length || !sessionIdRef.current) return;
      const id = newId();
      const name = (label || "carpeta") + ".zip";
      setUploads((u) => [...u, { id, name, progress: 0, status: "zipping" }]);
      zipEntries(entries)
        .then((zipped) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", filesUrl("upload-dir", { dir: browseDir || undefined }));
          xhr.upload.onprogress = (e) => {
            if (!e.lengthComputable) return;
            const progress = Math.round((e.loaded / e.total) * 100);
            setUploads((u) => u.map((x) => (x.id === id ? { ...x, progress, status: "uploading" } : x)));
          };
          const settle = (status) => {
            setUploads((u) => u.map((x) => (x.id === id ? { ...x, progress: 100, status } : x)));
            if (status === "done") {
              setTimeout(() => setUploads((u) => u.filter((x) => x.id !== id)), 2500);
              if (browseOpen) loadDirRef.current?.(browseDir);
            }
          };
          xhr.onload = () => settle(xhr.status >= 200 && xhr.status < 300 ? "done" : "error");
          xhr.onerror = () => settle("error");
          xhr.send(zipped);
        })
        .catch(() => {
          setUploads((u) => u.map((x) => (x.id === id ? { ...x, progress: 100, status: "error" } : x)));
        });
    },
    [filesUrl, browseDir, browseOpen],
  );

  const onFolderInputChange = useCallback(
    (e) => {
      const list = Array.from(e.target.files || []);
      e.target.value = "";
      if (!list.length) return;
      const topName = list[0].webkitRelativePath?.split("/")[0] || "carpeta";
      const entries = list.map((file) => ({
        relPath: file.webkitRelativePath || file.name,
        file,
      }));
      uploadFolderEntries(entries, topName);
    },
    [uploadFolderEntries],
  );

  const downloadDirUrl = useCallback(
    (name) => filesUrl("download-dir", { dir: browseDir || undefined, name }),
    [filesUrl, browseDir],
  );

  const loadDir = useCallback(
    (dir) => {
      if (!sessionIdRef.current) return;
      setBrowseError("");
      fetch(filesUrl("list", { dir: dir || undefined }))
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((data) => {
          setBrowseDir(data.dir === "." ? "" : data.dir);
          setBrowseEntries(data.entries);
        })
        .catch(() => setBrowseError("No se pudo leer el directorio"));
    },
    [filesUrl],
  );
  const loadDirRef = useRef(loadDir);
  loadDirRef.current = loadDir;

  const toggleBrowse = useCallback(() => {
    setBrowseOpen((open) => {
      const next = !open;
      if (next) loadDirRef.current?.(browseDir);
      return next;
    });
  }, [browseDir]);

  const enterDir = useCallback(
    (name) => loadDir(browseDir ? `${browseDir}/${name}` : name),
    [loadDir, browseDir],
  );
  const goUp = useCallback(() => {
    const parent = browseDir.split("/").slice(0, -1).join("/");
    loadDir(parent);
  }, [loadDir, browseDir]);

  const onDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDragOver(false);
      const items = e.dataTransfer?.items;
      if (items?.length) {
        walkDroppedItems(items).then((entries) => {
          if (entries) {
            // al menos una carpeta venía en el drop: todo lo que se soltó
            // (archivos sueltos incluidos) se sube junto, en un solo .zip.
            const topName = entries[0]?.relPath.split("/")[0] || "carpeta";
            uploadFolderEntries(entries, topName);
          } else if (e.dataTransfer.files?.length) {
            uploadFiles(e.dataTransfer.files);
          }
        });
        return;
      }
      if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
    },
    [uploadFiles, uploadFolderEntries],
  );

  // ── Mobile toolbar (Esc/Tab/Ctrl/Alt/arrows/Home/End/PgUp/PgDn/Del) ─────
  const [showKeys, setShowKeys] = useState(() => {
    if (mobileToolbar === true) return true;
    if (mobileToolbar === false) return false;
    try {
      return !!window.matchMedia?.("(pointer: coarse)").matches;
    } catch {
      return false;
    }
  });
  const [sticky, setSticky] = useState({ ctrl: false, alt: false });
  const stickyRef = useRef(sticky);

  const setStickyMod = useCallback((patch) => {
    stickyRef.current = { ...stickyRef.current, ...patch };
    setSticky(stickyRef.current);
  }, []);

  const sendRaw = useCallback((data) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input", data }));
    }
    termRef.current?.focus();
  }, []);

  const toggleSticky = useCallback(
    (mod) => setStickyMod({ [mod]: !stickyRef.current[mod] }),
    [setStickyMod],
  );

  const sendSpecial = useCallback(
    (kind) => {
      const { ctrl, alt } = stickyRef.current;
      sendRaw(specialKeySeq(termRef.current, kind, ctrl, alt));
      if (ctrl || alt) setStickyMod({ ctrl: false, alt: false });
    },
    [sendRaw, setStickyMod],
  );

  const sendPlain = useCallback(
    (data) => {
      sendRaw(data);
      if (stickyRef.current.ctrl || stickyRef.current.alt) {
        setStickyMod({ ctrl: false, alt: false });
      }
    },
    [sendRaw, setStickyMod],
  );

  // On-screen keyboards (mostly iOS Safari) overlay the page instead of
  // shrinking it, so a bar docked at the bottom via flexbox ends up hidden
  // behind the keyboard. Track visualViewport and float the bar just above
  // it whenever it's covering that much space.
  useEffect(() => {
    if (mobileToolbar === false) return undefined;
    const vv = window.visualViewport;
    const bar = keysbarRef.current;
    const root = rootRef.current;
    if (!vv || !bar || !root) return undefined;

    let floating = false;
    const update = () => {
      const covered = window.innerHeight - vv.height - vv.offsetTop;
      if (covered > 80) {
        const rect = root.getBoundingClientRect();
        bar.style.position = "fixed";
        bar.style.left = rect.left + "px";
        bar.style.width = rect.width + "px";
        bar.style.bottom = covered + "px";
        bar.style.zIndex = "20";
        floating = true;
      } else if (floating) {
        bar.style.position = "";
        bar.style.left = "";
        bar.style.width = "";
        bar.style.bottom = "";
        bar.style.zIndex = "";
        floating = false;
      }
    };

    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    update();

    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [mobileToolbar]);

  useImperativeHandle(
    ref,
    () => ({
      focus: () => termRef.current?.focus(),
      fit: () => {
        fitRef.current?.fit();
        sendResize();
      },
      clear: () => termRef.current?.clear(),
      write: (d) => termRef.current?.write(d),
      sendInput: (d) => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "input", data: d }));
        }
      },
      reconnect,
      newSession,
      endSession,
      copySelection,
      paste,
      uploadFiles,
      getSessionId: () => sessionIdRef.current,
      getTerminal: () => termRef.current,
      getSocket: () => wsRef.current,
    }),
    [reconnect, newSession, endSession, copySelection, paste, sendResize, uploadFiles],
  );

  // Create the xterm instance once.
  useEffect(() => {
    const term = new Xterm({
      cursorBlink,
      fontFamily,
      fontSize,
      theme: theme || DEFAULT_THEME,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(screenRef.current);
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    // xterm.js ya crea su textarea oculto con autocapitalize="off", pero en
    // Chrome/Android el teclado a veces reaplica la mayúscula inicial al
    // reenfocar (p.ej. tras tocar el toolbar móvil o volver de otra app).
    // Lo reforzamos en cada focus para que nunca capitalice la primera letra.
    const disableAutoCap = () => {
      term.textarea?.setAttribute("autocapitalize", "off");
      term.textarea?.setAttribute("autocorrect", "off");
      term.textarea?.setAttribute("autocomplete", "off");
      term.textarea?.setAttribute("spellcheck", "false");
    };
    disableAutoCap();
    term.textarea?.addEventListener("focus", disableAutoCap);

    // Programas de pantalla completa sin scrollback propio (vim, htop, less,
    // tmux, el propio Claude Code…) corren en el buffer alternativo. xterm.js
    // ya sabe traducir la rueda del mouse en flechas Arriba/Abajo ahí (ver su
    // Terminal.bindMouse), pero esa conversión sólo escucha 'wheel', nunca
    // 'touchmove' — por eso deslizar el dedo no hace nada en esos programas.
    // Reusamos esa lógica: convertimos el swipe en un wheel sintético sobre
    // el propio elemento de xterm, así hereda flechas/reporte de mouse tal
    // cual lo haría un mouse real, sin duplicar esa traducción acá.
    let touchY = null;
    const onAltTouchStart = (ev) => {
      touchY = ev.touches.length === 1 ? ev.touches[0].clientY : null;
    };
    const onAltTouchMove = (ev) => {
      if (touchY == null || term.buffer.active.type !== "alternate") return;
      const y = ev.touches[0]?.clientY;
      if (y == null) return;
      const deltaY = touchY - y;
      touchY = y;
      term.element.dispatchEvent(
        new WheelEvent("wheel", { deltaY, deltaMode: 0, cancelable: true, bubbles: true }),
      );
      ev.preventDefault();
    };
    term.element.addEventListener("touchstart", onAltTouchStart, { passive: true });
    term.element.addEventListener("touchmove", onAltTouchMove, { passive: false });

    const ro = new ResizeObserver(() => {
      fit.fit();
      sendResize();
    });
    ro.observe(screenRef.current);

    // ── Clipboard ─────────────────────────────────────────────────────
    // Intercept the copy/paste chords before xterm turns them into control
    // characters. Paste itself is done by the browser's native "paste" event
    // (which xterm already handles, and which works on insecure origins too);
    // we only swallow the keydown so Ctrl+V doesn't also send ^V.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;

      // Sticky Ctrl/Alt armed from the mobile toolbar: apply to the next
      // real keypress (the on-screen keyboard doesn't have modifier keys).
      const stick = stickyRef.current;
      if (stick.ctrl || stick.alt) {
        if (["Control", "Alt", "Shift", "Meta", "AltGraph"].includes(e.key)) {
          return true; // let the modifier keydown itself pass through
        }
        if (e.key.length === 1) {
          const base = stick.ctrl ? ctrlCode(e.key) : e.key;
          if (base != null) {
            e.preventDefault();
            const ws = wsRef.current;
            const seq = stick.alt ? "\x1b" + base : base;
            if (ws?.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "input", data: seq }));
            }
            setStickyMod({ ctrl: false, alt: false });
            return false;
          }
        }
        setStickyMod({ ctrl: false, alt: false });
      }

      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

      const isCopy =
        (mod && e.shiftKey && key === "c") ||
        (e.ctrlKey && key === "Insert") ||
        (e.metaKey && !e.shiftKey && key === "c");
      const isCopyOrSigint = e.ctrlKey && !e.shiftKey && !e.altKey && key === "c";
      if (isCopy || (isCopyOrSigint && term.hasSelection())) {
        const sel = term.getSelection();
        if (sel) {
          writeClipboard(sel).then(() => term.focus());
          return false;
        }
        return !isCopy; // plain Ctrl+C with no selection -> let SIGINT through
      }

      const isPaste =
        (mod && key === "v") || (e.shiftKey && key === "Insert");
      if (isPaste) {
        if (window.isSecureContext && navigator.clipboard?.readText) {
          // https / localhost: read it ourselves and stop the native paste
          // so it doesn't fire twice.
          e.preventDefault();
          readClipboard().then((t) => {
            if (t) term.paste(t);
          });
        }
        // insecure origin (http://<LAN-ip>): don't preventDefault — the
        // browser's native "paste" event fires and xterm handles it.
        // Either way, swallow the keydown so xterm doesn't emit ^V.
        return false;
      }

      return true;
    });

    const onSelect = () => {
      if (!cbRef.current.copyOnSelect) return;
      const sel = term.getSelection();
      if (sel) writeClipboard(sel).then(() => term.focus());
    };
    // copy once the selection settles (a drag fires many selection changes)
    const screen = screenRef.current;
    screen.addEventListener("mouseup", onSelect);

    const onContextMenu = (e) => {
      const sel = term.getSelection();
      if (sel) {
        e.preventDefault();
        writeClipboard(sel).then(() => term.focus());
        return;
      }
      if (!cbRef.current.pasteOnRightClick) return;
      e.preventDefault();
      readClipboard().then((t) => {
        if (t) term.paste(t);
      });
    };
    screen.addEventListener("contextmenu", onContextMenu);

    return () => {
      ro.disconnect();
      screen.removeEventListener("mouseup", onSelect);
      screen.removeEventListener("contextmenu", onContextMenu);
      term.textarea?.removeEventListener("focus", disableAutoCap);
      term.element?.removeEventListener("touchstart", onAltTouchStart);
      term.element?.removeEventListener("touchmove", onAltTouchMove);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep options in sync when the relevant props change.
  const themeKey = theme ? JSON.stringify(theme) : "";
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    term.options.fontFamily = fontFamily;
    term.options.cursorBlink = cursorBlink;
    term.options.theme = theme || DEFAULT_THEME;
    fitRef.current?.fit();
    sendResize();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fontSize, fontFamily, cursorBlink, themeKey, sendResize]);

  // (Re)connect whenever nonce / url / token / sessionId change.
  useEffect(() => {
    const term = termRef.current;
    if (!term || deadRef.current) return;
    let closedByUs = false;
    setStat("connecting");

    const ws = new WebSocket(resolveUrl(url, token, sessionIdRef.current));
    wsRef.current = ws;

    ws.onopen = () => {
      setStat("connected");
      // On a reconnect the server replays the session scrollback, so wipe the
      // stale screen first to avoid doubling it. On the very first connect the
      // terminal is already empty — skip the reset to avoid a flash.
      if (!firstConnectRef.current) term.reset();
      firstConnectRef.current = false;
      fitRef.current?.fit();
      sendResize();
      term.focus();
    };
    ws.onmessage = (ev) => {
      term.write(ev.data);
      cbRef.current.onData?.(ev.data);
    };
    ws.onclose = () => {
      if (closedByUs || deadRef.current) return;
      setStat("disconnected");
      term.write("\r\n\x1b[33m[desconectado]\x1b[0m\r\n");
      if (autoReconnect) {
        retryRef.current = setTimeout(() => setNonce((n) => n + 1), reconnectDelay);
      }
    };
    ws.onerror = () => {};

    const disposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    return () => {
      closedByUs = true;
      clearTimeout(retryRef.current);
      disposable.dispose();
      ws.close();
    };
  }, [nonce, url, token, sessionIdProp, autoReconnect, reconnectDelay, setStat, sendResize]);

  return (
    <div
      ref={rootRef}
      className={"webterm" + (className ? " " + className : "")}
      style={style}
      {...rest}
    >
      {header && (
        <div className="webterm__bar">
          <span className={"webterm__dot webterm__dot--" + status} />
          <span className="webterm__status">{status}</span>
          <button type="button" className="webterm__btn" onClick={reconnect}>
            Reconectar
          </button>
        </div>
      )}
      <div
        className={"webterm__screenwrap" + (dragOver ? " is-dragover" : "")}
        onDragOver={
          files
            ? (e) => {
                e.preventDefault();
                setDragOver(true);
              }
            : undefined
        }
        onDragLeave={files ? () => setDragOver(false) : undefined}
        onDrop={files ? onDrop : undefined}
      >
        <div className="webterm__screen" ref={screenRef} />

        {files && (
          <>
            <div className="webterm__filesbar">
              <button
                type="button"
                className="webterm__filesbtn"
                title="Subir archivo(s) al directorio actual"
                aria-label="Subir archivo"
                onClick={() => fileInputRef.current?.click()}
              >
                ⬆
              </button>
              <button
                type="button"
                className="webterm__filesbtn"
                title="Subir una carpeta completa (se comprime en el navegador y se extrae acá)"
                aria-label="Subir carpeta"
                onClick={() => folderInputRef.current?.click()}
              >
                ⬆📁
              </button>
              <button
                type="button"
                className={"webterm__filesbtn" + (browseOpen ? " is-active" : "")}
                title="Descargar archivos del directorio actual"
                aria-label="Descargar archivo"
                onClick={toggleBrowse}
              >
                ⬇
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="webterm__fileinput"
              onChange={(e) => {
                uploadFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <input
              ref={folderInputRef}
              type="file"
              multiple
              webkitdirectory=""
              directory=""
              className="webterm__fileinput"
              onChange={onFolderInputChange}
            />

            {uploads.length > 0 && (
              <div className="webterm__uploads">
                {uploads.map((u) => (
                  <div key={u.id} className={"webterm__upload webterm__upload--" + u.status}>
                    <span className="webterm__uploadname" title={u.name}>
                      {u.name}
                    </span>
                    <div className="webterm__uploadbar">
                      <div
                        className="webterm__uploadfill"
                        style={{ width: u.progress + "%" }}
                      />
                    </div>
                    <span className="webterm__uploadpct">
                      {u.status === "error" ? "✕" : u.status === "done" ? "✓" : u.progress + "%"}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {browseOpen && (
              <div className="webterm__browse">
                <div className="webterm__browsepath">
                  <button
                    type="button"
                    className="webterm__browseup"
                    onClick={goUp}
                    disabled={!browseDir}
                    aria-label="Subir un nivel"
                    title="Subir un nivel"
                  >
                    ↑
                  </button>
                  <span className="webterm__browsedir" title={browseDir || "."}>
                    {browseDir || "."}
                  </span>
                  <a
                    className="webterm__browsezip"
                    href={downloadDirUrl(undefined)}
                    title="Descargar esta carpeta completa como .zip"
                    aria-label="Descargar carpeta actual"
                  >
                    ⬇📁
                  </a>
                  <button
                    type="button"
                    className="webterm__x"
                    onClick={() => setBrowseOpen(false)}
                    aria-label="cerrar"
                  >
                    ×
                  </button>
                </div>
                <div className="webterm__browselist">
                  {browseError && <div className="webterm__browseerror">{browseError}</div>}
                  {!browseError && browseEntries == null && (
                    <div className="webterm__browseempty">Cargando…</div>
                  )}
                  {!browseError && browseEntries?.length === 0 && (
                    <div className="webterm__browseempty">Directorio vacío</div>
                  )}
                  {browseEntries?.map((entry) =>
                    entry.isDir ? (
                      <div key={entry.name} className="webterm__browserow">
                        <button
                          type="button"
                          className="webterm__browseitem webterm__browseitem--dir"
                          onClick={() => enterDir(entry.name)}
                        >
                          <span className="webterm__browseicon">📁</span>
                          <span className="webterm__browsename">{entry.name}</span>
                        </button>
                        <a
                          className="webterm__browsezip webterm__browsezip--row"
                          href={downloadDirUrl(entry.name)}
                          title={`Descargar "${entry.name}" como .zip`}
                          aria-label={`Descargar carpeta ${entry.name}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          ⬇
                        </a>
                      </div>
                    ) : (
                      <a
                        key={entry.name}
                        className="webterm__browseitem"
                        href={filesUrl("download", { dir: browseDir || undefined, name: entry.name })}
                      >
                        <span className="webterm__browseicon">📄</span>
                        <span className="webterm__browsename">{entry.name}</span>
                        <span className="webterm__browsesize">{formatBytes(entry.size)}</span>
                      </a>
                    ),
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
      {mobileToolbar !== false && (
        <div className="webterm__keysbar" ref={keysbarRef}>
          <button
            type="button"
            className="webterm__keystoggle"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setShowKeys((v) => !v)}
            aria-label={showKeys ? "Ocultar teclas" : "Mostrar teclas"}
            title={showKeys ? "Ocultar teclas" : "Mostrar teclas"}
          >
            {showKeys ? "⌄" : "⌨"}
          </button>
          {showKeys && (
            <div className="webterm__keys">
              <button
                type="button"
                className="webterm__key"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => sendPlain("\x1b")}
              >
                Esc
              </button>
              <button
                type="button"
                className="webterm__key"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => sendPlain("\t")}
              >
                Tab
              </button>
              <button
                type="button"
                className={"webterm__key" + (sticky.ctrl ? " is-active" : "")}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => toggleSticky("ctrl")}
              >
                Ctrl
              </button>
              <button
                type="button"
                className={"webterm__key" + (sticky.alt ? " is-active" : "")}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => toggleSticky("alt")}
              >
                Alt
              </button>
              <button
                type="button"
                className="webterm__key"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => sendSpecial("left")}
              >
                ◀
              </button>
              <button
                type="button"
                className="webterm__key"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => sendSpecial("up")}
              >
                ▲
              </button>
              <button
                type="button"
                className="webterm__key"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => sendSpecial("down")}
              >
                ▼
              </button>
              <button
                type="button"
                className="webterm__key"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => sendSpecial("right")}
              >
                ▶
              </button>
              <button
                type="button"
                className="webterm__key"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => sendSpecial("home")}
              >
                Inicio
              </button>
              <button
                type="button"
                className="webterm__key"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => sendSpecial("end")}
              >
                Fin
              </button>
              <button
                type="button"
                className="webterm__key"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => sendSpecial("pgup")}
              >
                RePág
              </button>
              <button
                type="button"
                className="webterm__key"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => sendSpecial("pgdn")}
              >
                AvPág
              </button>
              <button
                type="button"
                className="webterm__key"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => sendSpecial("del")}
              >
                Supr
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

export default WebTerm;
