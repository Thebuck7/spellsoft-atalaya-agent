import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { WebTerm } from "./WebTerm.jsx";

function uid() {
  try {
    if (crypto?.randomUUID) return crypto.randomUUID();
  } catch {
    /* not available */
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

const MIN_W = 260;
const MIN_H = 160;
const DEF_W = 620;
const DEF_H = 380;

function loadState(key) {
  try {
    const s = JSON.parse(window.localStorage.getItem(key) || "null");
    if (s && Array.isArray(s.terminals) && s.terminals.every((t) => t && t.id && t.sessionId)) {
      return s;
    }
  } catch {
    /* ignore */
  }
  return null;
}
function saveState(key, state) {
  try {
    window.localStorage.setItem(key, JSON.stringify(state));
  } catch {
    /* storage blocked */
  }
}

function useViewportWide(min) {
  const [wide, setWide] = useState(
    () => typeof window !== "undefined" && window.innerWidth >= min,
  );
  useEffect(() => {
    const on = () => setWide(window.innerWidth >= min);
    on();
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, [min]);
  return wide;
}

/**
 * <TerminalWorkspace /> — many persistent terminals as tabs (narrow screens)
 * or draggable windows (wide screens). The set of open terminals and their
 * layout is saved to localStorage; each terminal keeps its own server session
 * (see <WebTerm> `persist`). Sessions live until the user closes the terminal
 * here (which sends {type:"kill"}) or the server restarts.
 *
 * Props:
 *   url, token                 passed to every <WebTerm>
 *   storageKey                 localStorage key for the layout (default "webterm-workspace")
 *   layout                     "auto" | "tabs" | "windows"   (default "auto")
 *   windowsMinWidth            px; below this, "auto" uses tabs (default 720)
 *   theme, fontSize, fontFamily, cursorBlink, autoReconnect   forwarded to <WebTerm>
 *   files, filesPath           forwarded to <WebTerm> (upload/download UI, default true / "/webterm-files")
 *   newTerminalTitle           (n) => string   (default `Terminal ${n}`)
 *   className, style
 *
 * Ref API: addTerminal(), closeTerminal(id), listTerminals(), getState()
 */
export const TerminalWorkspace = forwardRef(function TerminalWorkspace(props, ref) {
  const {
    url = "/ws",
    token,
    storageKey = "webterm-workspace",
    layout = "auto",
    windowsMinWidth = 720,
    theme,
    fontSize,
    fontFamily,
    cursorBlink,
    autoReconnect = true,
    copyOnSelect = true,
    pasteOnRightClick = false,
    mobileToolbar = "auto",
    files = true,
    filesPath = "/webterm-files",
    newTerminalTitle = (n) => `Terminal ${n}`,
    className,
    style,
  } = props;

  const [state, setState] = useState(() => {
    const loaded = loadState(storageKey);
    if (loaded) return loaded;
    const id = uid();
    return {
      terminals: [
        {
          id,
          title: newTerminalTitle(1),
          sessionId: uid(),
          rect: { x: 24, y: 24, w: DEF_W, h: DEF_H },
          minimized: false,
        },
      ],
      activeId: id,
      counter: 1,
    };
  });

  const { terminals, activeId } = state;

  const wide = useViewportWide(windowsMinWidth);
  const mode = layout === "auto" ? (wide ? "windows" : "tabs") : layout;

  const canvasRef = useRef(null);
  const getBounds = useCallback(() => {
    const el = canvasRef.current;
    return el
      ? { w: el.clientWidth, h: el.clientHeight }
      : { w: window.innerWidth, h: window.innerHeight };
  }, []);

  // <WebTerm> handles + stable per-id ref callbacks + lazy-mount tracking.
  const handles = useRef(new Map());
  const refCbs = useRef(new Map());
  const mounted = useRef(new Set());
  const getRefCb = (id) => {
    let cb = refCbs.current.get(id);
    if (!cb) {
      cb = (h) => {
        if (h) handles.current.set(id, h);
        else handles.current.delete(id);
      };
      refCbs.current.set(id, cb);
    }
    return cb;
  };

  // Persist layout (cheap; debounced a touch for drag).
  const saveTimer = useRef(null);
  useEffect(() => {
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveState(storageKey, state), 120);
    return () => clearTimeout(saveTimer.current);
  }, [state, storageKey]);

  const fitAll = useCallback(() => {
    requestAnimationFrame(() => {
      for (const h of handles.current.values()) h.fit?.();
    });
  }, []);
  useEffect(fitAll, [mode, fitAll]);

  const setActive = useCallback((id) => {
    setState((s) => {
      const t = s.terminals.find((x) => x.id === id);
      if (!t) return s;
      const rest = s.terminals
        .filter((x) => x.id !== id)
        // switching focus exits another window's maximized ("focus fullscreen")
        .map((x) => (x.maximized ? { ...x, maximized: false } : x));
      return {
        ...s,
        activeId: id,
        terminals: [...rest, { ...t, minimized: false }], // last = front
      };
    });
    requestAnimationFrame(() => {
      for (const h of handles.current.values()) h.fit?.();
      handles.current.get(id)?.focus();
    });
  }, []);

  const addTerminal = useCallback(() => {
    const b = getBounds();
    const w = Math.max(DEF_W, Math.min(Math.round(b.w * 0.72), b.w - 16));
    const h = Math.max(DEF_H, Math.min(Math.round(b.h * 0.72), b.h - 16));
    setState((s) => {
      const n = s.counter + 1;
      const id = uid();
      const k = s.terminals.length % 6;
      return {
        ...s,
        counter: n,
        activeId: id,
        terminals: [
          ...s.terminals,
          {
            id,
            title: newTerminalTitle(n),
            sessionId: uid(),
            rect: {
              x: Math.min(24 + k * 26, Math.max(0, b.w - w)),
              y: Math.min(24 + k * 26, Math.max(0, b.h - h)),
              w,
              h,
            },
            minimized: false,
            maximized: false,
          },
        ],
      };
    });
  }, [newTerminalTitle, getBounds]);

  const closeTerminal = useCallback((id) => {
    handles.current.get(id)?.endSession(); // kill the PTY server-side
    handles.current.delete(id);
    refCbs.current.delete(id);
    mounted.current.delete(id);
    setState((s) => {
      const remaining = s.terminals.filter((t) => t.id !== id);
      const activeId =
        s.activeId === id
          ? remaining[remaining.length - 1]?.id ?? null
          : s.activeId;
      return { ...s, terminals: remaining, activeId };
    });
  }, []);

  const renameTerminal = useCallback((id, title) => {
    if (!title) return;
    setState((s) => ({
      ...s,
      terminals: s.terminals.map((t) => (t.id === id ? { ...t, title } : t)),
    }));
  }, []);

  const patchRect = useCallback((id, rect) => {
    setState((s) => ({
      ...s,
      terminals: s.terminals.map((t) => (t.id === id ? { ...t, rect } : t)),
    }));
  }, []);

  const setMinimized = useCallback(
    (id, minimized) => {
      setState((s) => ({
        ...s,
        terminals: s.terminals.map((t) =>
          t.id === id ? { ...t, minimized } : t,
        ),
      }));
      if (!minimized) setActive(id);
    },
    [setActive],
  );

  const toggleMax = useCallback(
    (id) => {
      setState((s) => ({
        ...s,
        terminals: s.terminals.map((t) =>
          t.id === id ? { ...t, maximized: !t.maximized } : t,
        ),
      }));
      setActive(id);
      fitAll();
    },
    [setActive, fitAll],
  );

  useImperativeHandle(
    ref,
    () => ({
      addTerminal,
      closeTerminal,
      listTerminals: () =>
        state.terminals.map(({ id, title, sessionId }) => ({ id, title, sessionId })),
      getState: () => state,
    }),
    [addTerminal, closeTerminal, state],
  );

  function renderTerm(t) {
    const show =
      mode === "windows" ? !t.minimized : t.id === activeId;
    if (show || t.id === activeId) mounted.current.add(t.id);
    if (!mounted.current.has(t.id)) return null;
    return (
      <WebTerm
        ref={getRefCb(t.id)}
        url={url}
        token={token}
        sessionId={t.sessionId}
        theme={theme}
        fontSize={fontSize}
        fontFamily={fontFamily}
        cursorBlink={cursorBlink}
        autoReconnect={autoReconnect}
        copyOnSelect={copyOnSelect}
        pasteOnRightClick={pasteOnRightClick}
        mobileToolbar={mobileToolbar}
        files={files}
        filesPath={filesPath}
        style={{ height: "100%" }}
      />
    );
  }

  const empty = terminals.length === 0;

  return (
    <div
      className={"wtws wtws--" + mode + (className ? " " + className : "")}
      style={style}
    >
      {mode === "tabs" ? (
        <>
          <div className="wtws__tabs" role="tablist">
            {terminals.map((t) => (
              <div
                key={t.id}
                className={"wtws__tab" + (t.id === activeId ? " is-active" : "")}
                onClick={() => setActive(t.id)}
                onDoubleClick={() =>
                  renameTerminal(
                    t.id,
                    window.prompt("Nombre de la terminal", t.title),
                  )
                }
              >
                <span className="wtws__tabname">{t.title}</span>
                <button
                  type="button"
                  className="wtws__x"
                  aria-label="cerrar"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTerminal(t.id);
                  }}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              type="button"
              className="wtws__add"
              aria-label="nueva terminal"
              onClick={addTerminal}
            >
              +
            </button>
          </div>
          <div className="wtws__stage">
            {empty && (
              <div className="wtws__empty">
                <button type="button" className="wtws__add" onClick={addTerminal}>
                  + Nueva terminal
                </button>
              </div>
            )}
            {terminals.map((t) => (
              <div
                key={t.id}
                className="wtws__pane"
                style={{ display: t.id === activeId ? "block" : "none" }}
              >
                {renderTerm(t)}
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="wtws__canvas" ref={canvasRef}>
            {empty && (
              <div className="wtws__empty">
                <button type="button" className="wtws__add" onClick={addTerminal}>
                  + Nueva ventana
                </button>
              </div>
            )}
            {terminals.map((t, i) =>
              t.minimized ? null : (
                <WindowFrame
                  key={t.id}
                  term={t}
                  front={i === terminals.length - 1}
                  getBounds={getBounds}
                  onFocus={() => setActive(t.id)}
                  onClose={() => closeTerminal(t.id)}
                  onMinimize={() => setMinimized(t.id, true)}
                  onMaximize={() => toggleMax(t.id)}
                  onRename={() =>
                    renameTerminal(
                      t.id,
                      window.prompt("Nombre de la ventana", t.title),
                    )
                  }
                  onRect={(r) => patchRect(t.id, r)}
                  onRectCommit={fitAll}
                >
                  {renderTerm(t)}
                </WindowFrame>
              ),
            )}
          </div>
          <div className="wtws__taskbar">
            <button
              type="button"
              className="wtws__add"
              onClick={addTerminal}
              aria-label="nueva ventana"
            >
              + Nueva
            </button>
            {terminals.map((t) => (
              <button
                key={t.id}
                type="button"
                className={
                  "wtws__chip" +
                  (t.minimized ? " is-min" : "") +
                  (t.id === activeId && !t.minimized ? " is-active" : "")
                }
                onClick={() =>
                  t.minimized ? setMinimized(t.id, false) : setActive(t.id)
                }
              >
                {t.title}
                <span
                  className="wtws__x"
                  role="button"
                  aria-label="cerrar"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTerminal(t.id);
                  }}
                >
                  ×
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
});

function WindowFrame({
  term,
  front,
  getBounds,
  onFocus,
  onClose,
  onMinimize,
  onMaximize,
  onRename,
  onRect,
  onRectCommit,
  children,
}) {
  const { rect } = term;
  const max = !!term.maximized;
  const startRef = useRef(null);

  const begin = (e, kind) => {
    if (max) return;
    if (e.button != null && e.button !== 0) return;
    e.preventDefault();
    onFocus();
    startRef.current = {
      kind,
      px: e.clientX,
      py: e.clientY,
      rect: { ...rect },
      bounds: getBounds(),
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };
  const move = (e) => {
    const s = startRef.current;
    if (!s) return;
    const dx = e.clientX - s.px;
    const dy = e.clientY - s.py;
    const b = s.bounds;
    if (s.kind === "move") {
      // keep at least a strip of the titlebar reachable inside the canvas
      onRect({
        ...s.rect,
        x: Math.min(Math.max(0, s.rect.x + dx), Math.max(0, b.w - 80)),
        y: Math.min(Math.max(0, s.rect.y + dy), Math.max(0, b.h - 32)),
      });
    } else {
      onRect({
        ...s.rect,
        w: Math.max(MIN_W, Math.min(s.rect.w + dx, b.w - s.rect.x)),
        h: Math.max(MIN_H, Math.min(s.rect.h + dy, b.h - s.rect.y)),
      });
    }
  };
  const end = () => {
    startRef.current = null;
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    onRectCommit?.();
  };

  const stop = (e) => e.stopPropagation();

  const posStyle = max
    ? { inset: 0, width: "auto", height: "auto" }
    : { left: rect.x, top: rect.y, width: rect.w, height: rect.h };

  return (
    <div
      className={
        "wtws__window" + (front ? " is-front" : "") + (max ? " is-max" : "")
      }
      style={posStyle}
      onPointerDown={onFocus}
    >
      <div
        className="wtws__titlebar"
        onPointerDown={(e) => begin(e, "move")}
        onDoubleClick={onMaximize}
      >
        <span
          className="wtws__title"
          onDoubleClick={(e) => {
            e.stopPropagation();
            onRename();
          }}
          title="doble clic: renombrar"
        >
          {term.title}
        </span>
        <button
          type="button"
          className="wtws__winbtn"
          onPointerDown={stop}
          onClick={onMinimize}
          aria-label="minimizar"
        >
          –
        </button>
        <button
          type="button"
          className="wtws__winbtn"
          onPointerDown={stop}
          onClick={onMaximize}
          aria-label={max ? "restaurar" : "maximizar"}
        >
          {max ? "❐" : "□"}
        </button>
        <button
          type="button"
          className="wtws__winbtn wtws__winbtn--close"
          onPointerDown={stop}
          onClick={onClose}
          aria-label="cerrar"
        >
          ×
        </button>
      </div>
      <div className="wtws__body">{children}</div>
      {!max && (
        <div
          className="wtws__resize"
          onPointerDown={(e) => begin(e, "resize")}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

export default TerminalWorkspace;
