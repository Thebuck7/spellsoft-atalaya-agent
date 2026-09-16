const { WebSocketServer } = require("ws");
const { randomUUID, createHash, timingSafeEqual } = require("crypto");
const pty = require("node-pty");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const archiver = require("archiver");
const unzipper = require("unzipper");

function tokenMatches(expected, given) {
  // Hashea ambos lados a longitud fija antes de comparar: evita filtrar la
  // longitud del token por timing y evita ramas de comparación de largo
  // distinto (timingSafeEqual exige buffers del mismo tamaño).
  const a = createHash("sha256").update(String(expected)).digest();
  const b = createHash("sha256").update(String(given ?? "")).digest();
  return timingSafeEqual(a, b);
}

/**
 * Attach a PTY-backed terminal endpoint to an existing http.Server.
 *
 * Protocol (JSON frames from client, raw strings back):
 *   client -> server : {"type":"input","data":"..."} | {"type":"resize","cols":N,"rows":N} | {"type":"kill"}
 *   server -> client : raw shell output
 * ("kill" ends the session/PTY immediately instead of keeping it alive for reattach.)
 *
 * Sessions survive a dropped WebSocket (e.g. a page refresh): a client that
 * reconnects with the same ?sessionId= reattaches to the live PTY and gets the
 * recent scrollback replayed. The PTY is only killed `sessionTimeout` ms after
 * the *last* client for that session disconnects.
 *
 * @param {import('http').Server} server
 * @param {object} [options]
 * @param {string}   [options.path="/ws"]
 * @param {string}   [options.token=""]              if set, clients must pass ?token=
 * @param {string}   [options.shell]                 default $SHELL or "bash"
 * @param {string[]} [options.args=[]]
 * @param {string}   [options.cwd]                   default $HOME
 * @param {object}   [options.env=process.env]
 * @param {number}   [options.cols=80]
 * @param {number}   [options.rows=24]
 * @param {number}   [options.sessionTimeout=600000] ms to keep a PTY alive after the
 *                                                   last client leaves. 0 = kill on
 *                                                   disconnect (no persistence).
 *                                                   Infinity = never auto-kill.
 * @param {number}   [options.scrollbackBytes=200000] approx chars of output replayed on reattach
 * @param {number}   [options.maxSessions=50]        cap on concurrent live sessions
 * @param {(session: {id:string, pid:number, remote:string, term:object, ws:object, resuming:boolean}) => void} [options.onSession]
 * @param {(req: import('http').IncomingMessage) => boolean} [options.authorize]
 * @param {boolean}  [options.files=true]            expose upload/download HTTP routes for each session's cwd
 * @param {string}   [options.filesPath="/webterm-files"] base path for the file routes
 * @param {number}   [options.maxUploadBytes=524288000] cap on a single uploaded file (default 500MB)
 * @returns {import('ws').WebSocketServer & {filesMiddleware: Function, filesPath: string}}
 */
function attachWebTerm(server, options = {}) {
  const {
    path: wsPath = "/ws",
    token = "",
    shell = process.env.SHELL || "bash",
    args = [],
    cwd = process.env.HOME || process.cwd(),
    env = process.env,
    cols = 80,
    rows = 24,
    sessionTimeout = 10 * 60 * 1000,
    scrollbackBytes = 200_000,
    maxSessions = 50,
    onSession,
    authorize,
    files = true,
    filesPath = "/webterm-files",
    maxUploadBytes = 500 * 1024 * 1024,
  } = options;

  /** @type {Map<string, {id:string, term:any, clients:Set<any>, buffer:string[], bytes:number, killTimer:any}>} */
  const sessions = new Map();

  const isAuthorized = (req) =>
    authorize
      ? !!safeCall(authorize, req)
      : !token ||
        tokenMatches(token, new URL(req.url, "http://x").searchParams.get("token"));

  // Handle the HTTP upgrade ourselves (noServer) so we only ever touch requests
  // for `path`. A `new WebSocketServer({ server, path })` would destroy every
  // upgrade that doesn't match `path` — which breaks other WebSocket servers on
  // the same http.Server, e.g. Vite's HMR socket (endless page-reload loop).
  const wss = new WebSocketServer({ noServer: true });

  const onUpgrade = (req, socket, head) => {
    let pathname;
    try {
      pathname = new URL(req.url, "http://x").pathname;
    } catch {
      return;
    }
    if (pathname !== wsPath) return; // not ours — let another handler take it
    if (!isAuthorized(req)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  };
  server.on("upgrade", onUpgrade);

  function createSession(id) {
    const term = pty.spawn(shell, args, {
      name: "xterm-color",
      cols,
      rows,
      cwd,
      env,
    });
    const session = {
      id,
      term,
      clients: new Set(),
      buffer: [],
      bytes: 0,
      killTimer: null,
    };

    term.onData((d) => {
      session.buffer.push(d);
      session.bytes += d.length;
      while (session.bytes > scrollbackBytes && session.buffer.length > 1) {
        session.bytes -= session.buffer.shift().length;
      }
      for (const ws of session.clients) {
        if (ws.readyState === ws.OPEN) ws.send(d);
      }
    });

    term.onExit(({ exitCode }) => {
      for (const ws of session.clients) {
        if (ws.readyState === ws.OPEN) {
          ws.send(`\r\n\x1b[31m[proceso terminado: ${exitCode}]\x1b[0m\r\n`);
          ws.close();
        }
      }
      clearTimeout(session.killTimer);
      sessions.delete(id);
    });

    sessions.set(id, session);
    return session;
  }

  function destroySession(session) {
    if (session.destroyed) return;
    session.destroyed = true;
    clearTimeout(session.killTimer);
    try {
      session.term.kill();
    } catch {
      /* already dead */
    }
    sessions.delete(session.id);
  }

  wss.on("connection", (ws, req) => {
    const requestedId = new URL(req.url, "http://x").searchParams.get("sessionId");
    const id = requestedId || randomUUID();

    let session = sessions.get(id);
    const resuming = !!session;

    if (!session) {
      if (sessions.size >= maxSessions) {
        ws.send(
          "\r\n\x1b[31m[demasiadas sesiones activas en el servidor]\x1b[0m\r\n",
        );
        ws.close(4002, "too many sessions");
        return;
      }
      session = createSession(id);
    }

    clearTimeout(session.killTimer);
    session.killTimer = null;

    // Replay recent scrollback to the (re)joining client, then go live.
    for (const chunk of session.buffer) {
      if (ws.readyState === ws.OPEN) ws.send(chunk);
    }
    session.clients.add(ws);

    const term = session.term;
    safeCall(onSession, {
      id: session.id,
      pid: term.pid,
      remote: req.socket.remoteAddress,
      term,
      ws,
      resuming,
    });

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "input") {
        term.write(msg.data);
      } else if (msg.type === "resize") {
        try {
          term.resize(Math.max(1, msg.cols | 0), Math.max(1, msg.rows | 0));
        } catch {
          /* window gone */
        }
      } else if (msg.type === "kill") {
        // Client asked to end this session for good (not just disconnect).
        destroySession(session);
      }
    });

    ws.on("close", () => {
      session.clients.delete(ws);
      if (session.clients.size > 0) return;
      if (sessionTimeout === 0) {
        destroySession(session);
      } else if (Number.isFinite(sessionTimeout)) {
        session.killTimer = setTimeout(() => destroySession(session), sessionTimeout);
      }
      // sessionTimeout === Infinity -> leave the PTY running
    });
  });

  wss.on("close", () => {
    server.removeListener("upgrade", onUpgrade);
    for (const session of sessions.values()) destroySession(session);
  });

  // ── File transfer (upload/download into the session's live shell cwd) ────
  //
  // Routes, all under `filesPath` (default "/webterm-files"), auth'd the same
  // way as the WebSocket (?token= or `authorize`):
  //   GET  <filesPath>/list?sessionId=&dir=      -> {dir, entries:[{name,isDir,size,mtimeMs}]}
  //   GET  <filesPath>/download?sessionId=&dir=&name=  -> raw file, attachment
  //   POST <filesPath>/upload?sessionId=&dir=&name=    -> raw body written to disk
  //   GET  <filesPath>/download-dir?sessionId=&dir=&name=  -> dir (or dir/name) as a .zip, streamed
  //   POST <filesPath>/upload-dir?sessionId=&dir=          -> .zip body, extracted into dir
  //                                                            (zip-slip safe, same as the others)
  //
  // `dir` is a path *relative to the shell's current cwd* (resolved fresh on
  // every request via /proc/<pid>/cwd — Linux only; falls back to the PTY's
  // launch cwd elsewhere), so uploads/downloads always land wherever the user
  // is actually `cd`'d to right now, and can't escape that subtree.
  function sessionCwd(session) {
    try {
      return fs.realpathSync(`/proc/${session.term.pid}/cwd`);
    } catch {
      return cwd;
    }
  }

  function resolveInside(base, rel) {
    const target = path.resolve(base, rel || ".");
    const relFromBase = path.relative(base, target);
    if (relFromBase === "") return target;
    if (relFromBase.startsWith("..") || path.isAbsolute(relFromBase)) return null;
    return target;
  }

  function safeName(name) {
    if (!name || typeof name !== "string") return null;
    const base = path.basename(name.replace(/\\/g, "/"));
    if (!base || base === "." || base === "..") return null;
    return base;
  }

  function sendJson(res, code, body) {
    res.statusCode = code;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify(body));
  }

  async function handleList(res, base, dirParam) {
    const dir = resolveInside(base, dirParam);
    if (!dir) return sendJson(res, 400, { error: "ruta inválida" });
    let names;
    try {
      names = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return sendJson(res, 404, { error: "no se pudo leer el directorio" });
    }
    const entries = [];
    for (const d of names) {
      let st;
      try {
        st = await fsp.stat(path.join(dir, d.name));
      } catch {
        continue; // broken symlink, permission error, race with deletion…
      }
      entries.push({
        name: d.name,
        isDir: st.isDirectory(),
        size: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
    entries.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
    sendJson(res, 200, { dir: path.relative(base, dir) || ".", entries });
  }

  async function handleDownload(res, base, params) {
    const dir = resolveInside(base, params.get("dir") || "");
    const name = safeName(params.get("name"));
    if (!dir || !name) return sendJson(res, 400, { error: "parámetros inválidos" });
    const full = path.join(dir, name);
    let st;
    try {
      st = await fsp.stat(full);
    } catch {
      return sendJson(res, 404, { error: "archivo no encontrado" });
    }
    if (!st.isFile()) return sendJson(res, 400, { error: "no es un archivo" });
    res.setHeader("content-type", "application/octet-stream");
    res.setHeader("content-length", st.size);
    res.setHeader(
      "content-disposition",
      `attachment; filename="${name.replace(/[\r\n"]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
    fs.createReadStream(full)
      .on("error", () => {
        if (!res.headersSent) sendJson(res, 500, { error: "error leyendo el archivo" });
        else res.destroy();
      })
      .pipe(res);
  }

  function handleUpload(req, res, base, params) {
    const dir = resolveInside(base, params.get("dir") || "");
    const name = safeName(params.get("name"));
    if (!dir || !name) return sendJson(res, 400, { error: "parámetros inválidos" });

    const declaredLen = parseInt(req.headers["content-length"] || "0", 10);
    if (declaredLen > maxUploadBytes) {
      return sendJson(res, 413, { error: "archivo demasiado grande" });
    }

    const full = path.join(dir, name);
    const out = fs.createWriteStream(full);
    let received = 0;
    let failed = false;

    const bail = (code, msg) => {
      if (failed) return;
      failed = true;
      req.unpipe(out);
      out.destroy();
      fs.unlink(full, () => {});
      if (!res.headersSent) sendJson(res, code, { error: msg });
    };

    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > maxUploadBytes) bail(413, "archivo demasiado grande");
    });
    req.on("aborted", () => bail(400, "subida interrumpida"));
    req.on("error", () => bail(400, "subida interrumpida"));
    out.on("error", () => bail(500, "error al escribir el archivo"));
    out.on("finish", () => {
      if (!failed) sendJson(res, 200, { ok: true, name, size: received });
    });
    req.pipe(out);
  }

  // Descarga `dir` (o el subdirectorio `name` dentro de `dir`, si se da)
  // comprimido como .zip, streameado — no se buffera en memoria.
  async function handleDownloadDir(res, base, params) {
    const dir = resolveInside(base, params.get("dir") || "");
    if (!dir) return sendJson(res, 400, { error: "ruta inválida" });

    let target = dir;
    const nameParam = params.get("name");
    if (nameParam) {
      const name = safeName(nameParam);
      if (!name) return sendJson(res, 400, { error: "nombre inválido" });
      target = resolveInside(dir, name);
      if (!target) return sendJson(res, 400, { error: "ruta inválida" });
    }

    let st;
    try {
      st = await fsp.stat(target);
    } catch {
      return sendJson(res, 404, { error: "no encontrado" });
    }
    if (!st.isDirectory()) return sendJson(res, 400, { error: "no es una carpeta" });

    const zipName = path.basename(target) || "carpeta";
    res.setHeader("content-type", "application/zip");
    res.setHeader(
      "content-disposition",
      `attachment; filename="${zipName.replace(/[\r\n"]/g, "_")}.zip"; ` +
        `filename*=UTF-8''${encodeURIComponent(zipName)}.zip`,
    );

    const archive = archiver("zip", { zlib: { level: 6 } });
    archive.on("warning", () => {}); // entradas ilegibles (permisos, symlink roto…) — se omiten
    archive.on("error", () => {
      if (!res.headersSent) sendJson(res, 500, { error: "error comprimiendo la carpeta" });
      else res.destroy();
    });
    archive.pipe(res);
    archive.directory(target, zipName);
    archive.finalize();
  }

  // Sube un .zip y lo extrae dentro de `dir`, preservando subcarpetas. Cada
  // entrada del zip se valida contra "zip slip" (rutas tipo ../../etc/passwd)
  // igual que las demás rutas de archivos — nunca se escribe fuera de `dir`.
  //
  // El body se bufferea primero a un archivo temporal: el formato zip guarda
  // su índice (central directory) al FINAL del archivo, así que leerlo bien
  // requiere poder buscar hacia atrás — un parseo puramente en streaming
  // (sin un archivo real de por medio) no es confiable para todos los zips.
  function handleUploadDir(req, res, base, params) {
    const dir = resolveInside(base, params.get("dir") || "");
    if (!dir) return sendJson(res, 400, { error: "ruta inválida" });

    const declaredLen = parseInt(req.headers["content-length"] || "0", 10);
    if (declaredLen > maxUploadBytes) {
      return sendJson(res, 413, { error: "archivo demasiado grande" });
    }

    const tmpZip = path.join(os.tmpdir(), `webterm-upload-${randomUUID()}.zip`);
    const out = fs.createWriteStream(tmpZip);
    let received = 0;
    let failed = false;

    const cleanup = () => fs.unlink(tmpZip, () => {});
    const bail = (code, msg) => {
      if (failed) return;
      failed = true;
      req.unpipe(out);
      out.destroy();
      cleanup();
      if (!res.headersSent) sendJson(res, code, { error: msg });
    };

    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > maxUploadBytes) bail(413, "archivo demasiado grande");
    });
    req.on("aborted", () => bail(400, "subida interrumpida"));
    req.on("error", () => bail(400, "subida interrumpida"));
    out.on("error", () => bail(500, "error al escribir el archivo temporal"));
    out.on("finish", async () => {
      if (failed) return;
      let fileCount = 0;
      try {
        const zip = await unzipper.Open.file(tmpZip);
        for (const entry of zip.files) {
          if (entry.type !== "File") continue;
          const target = resolveInside(dir, entry.path);
          if (!target) continue; // entrada con ../.. — se ignora, no se aborta el resto
          await fsp.mkdir(path.dirname(target), { recursive: true });
          await new Promise((resolve, reject) => {
            entry
              .stream()
              .pipe(fs.createWriteStream(target))
              .on("finish", resolve)
              .on("error", reject);
          });
          fileCount++;
        }
        cleanup();
        if (!failed) sendJson(res, 200, { ok: true, files: fileCount });
      } catch {
        cleanup();
        if (!failed) sendJson(res, 400, { error: "zip inválido o corrupto" });
      }
    });
    req.pipe(out);
  }

  /**
   * Connect/Express-compatible middleware: `(req, res, next?)`. Mount it in
   * whatever request-handling stack fronts `server` (an Express `app.use(...)`,
   * a Vite dev server's `server.middlewares.use(...)`, etc.) — attachWebTerm
   * does *not* itself listen for "request" events, since it can't know
   * whether something else on the same http.Server already owns that.
   */
  function filesMiddleware(req, res, next) {
    const done = () => (next ? next() : (res.statusCode = 404, res.end("not found")));
    if (!files) return done();
    let u;
    try {
      u = new URL(req.url, "http://x");
    } catch {
      return done();
    }
    if (!u.pathname.startsWith(filesPath + "/")) return done();
    if (!isAuthorized(req)) {
      res.statusCode = 401;
      return res.end("unauthorized");
    }

    const session = sessions.get(u.searchParams.get("sessionId") || "");
    if (!session) return sendJson(res, 404, { error: "sesión no encontrada" });
    const base = sessionCwd(session);
    const route = u.pathname.slice(filesPath.length);

    if (route === "/list" && req.method === "GET") {
      return void handleList(res, base, u.searchParams.get("dir") || "");
    }
    if (route === "/download" && req.method === "GET") {
      return void handleDownload(res, base, u.searchParams);
    }
    if (route === "/upload" && req.method === "POST") {
      return void handleUpload(req, res, base, u.searchParams);
    }
    if (route === "/download-dir" && req.method === "GET") {
      return void handleDownloadDir(res, base, u.searchParams);
    }
    if (route === "/upload-dir" && req.method === "POST") {
      return void handleUploadDir(req, res, base, u.searchParams);
    }
    return done();
  }

  wss.filesMiddleware = filesMiddleware;
  wss.filesPath = filesPath;

  return wss;
}

function safeCall(fn, arg) {
  if (typeof fn !== "function") return undefined;
  try {
    return fn(arg);
  } catch (err) {
    console.error("[webterm] callback error:", err);
    return undefined;
  }
}

module.exports = { attachWebTerm };
