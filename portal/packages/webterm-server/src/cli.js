#!/usr/bin/env node
"use strict";

// Carga .env del directorio desde donde se invoca (silencioso si no existe).
require("dotenv").config();

const http = require("http");
const path = require("path");
const fs = require("fs");
const express = require("express");

function opt(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}
function envBool(v, fallback) {
  if (v === undefined) return fallback;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}
function intOpt(name, envVar, fallback) {
  const raw = opt(name, envVar);
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

if (hasFlag("help") || hasFlag("h")) {
  console.log(`
webterm-server — expone una terminal PTY por WebSocket sobre HTTP.

Uso: webterm-server [opciones]

  --port <n>              puerto                          WEBTERM_PORT       (3001)
  --host <ip>              interfaz de escucha              WEBTERM_HOST       (127.0.0.1)
  --token <str>            token requerido (?token=)        WEBTERM_TOKEN      (sin auth)
  --path <ruta>            ruta del WebSocket                WEBTERM_WS_PATH    (/ws)
  --static <dir>           carpeta a servir (build de Vite)  WEBTERM_STATIC     (ninguna)
  --session-timeout <s|inf> vida de la sesión tras desconectar WEBTERM_SESSION_TIMEOUT (600)
  --shell <bin>            shell a lanzar                    WEBTERM_SHELL      ($SHELL o bash)
  --cwd <dir>              directorio inicial                WEBTERM_CWD        ($HOME)
  --max-sessions <n>       sesiones simultáneas permitidas    WEBTERM_MAX_SESSIONS (50)
  --scrollback-bytes <n>   histórico replayeado al reconectar WEBTERM_SCROLLBACK_BYTES (200000)
  --max-upload-mb <n>      tamaño máx. de subida (MB)         WEBTERM_MAX_UPLOAD_MB (500)
  --no-files               desactiva subir/bajar archivos     WEBTERM_FILES=0
  --files-path <ruta>      ruta de las rutas de archivos      WEBTERM_FILES_PATH (/webterm-files)

Cualquier opción también se puede fijar en un archivo .env en el directorio
desde donde se ejecuta (ver .env.example).
`);
  process.exit(0);
}

const PORT = intOpt("port", process.env.WEBTERM_PORT, 3001);
const HOST = opt("host", process.env.WEBTERM_HOST || "127.0.0.1");
const TOKEN = opt("token", process.env.WEBTERM_TOKEN || "");
const WS_PATH = opt("path", process.env.WEBTERM_WS_PATH || "/ws");
const STATIC = opt("static", process.env.WEBTERM_STATIC || "");
const SHELL = opt("shell", process.env.WEBTERM_SHELL || undefined);
const CWD = opt("cwd", process.env.WEBTERM_CWD || undefined);
const MAX_SESSIONS = intOpt("max-sessions", process.env.WEBTERM_MAX_SESSIONS, 50);
const SCROLLBACK_BYTES = intOpt(
  "scrollback-bytes",
  process.env.WEBTERM_SCROLLBACK_BYTES,
  200_000,
);
const MAX_UPLOAD_MB = intOpt("max-upload-mb", process.env.WEBTERM_MAX_UPLOAD_MB, 500);
const FILES = hasFlag("no-files") ? false : envBool(process.env.WEBTERM_FILES, true);
const FILES_PATH = opt("files-path", process.env.WEBTERM_FILES_PATH || "/webterm-files");

// segundos que el shell sobrevive tras cerrarse la pestaña (refresco). 0 = no; "inf" = siempre
const ST_RAW = opt("session-timeout", process.env.WEBTERM_SESSION_TIMEOUT || "600");
const SESSION_TIMEOUT = /^inf/i.test(ST_RAW)
  ? Infinity
  : Math.max(0, parseInt(ST_RAW, 10) || 0) * 1000;

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(`[webterm] --port inválido: ${opt("port", process.env.WEBTERM_PORT)}`);
  process.exit(1);
}

// node-pty es un módulo nativo: si el server destino no tiene toolchain de
// compilación (o node-gyp falló), dar un error accionable en vez de un stack
// trace críptico de un require() fallido en medio del arranque.
let attachWebTerm;
try {
  ({ attachWebTerm } = require("./index.js"));
} catch (err) {
  console.error(
    "[webterm] no se pudo cargar node-pty (módulo nativo).\n" +
      "  · Necesitás un compilador de C++ + python3 en este servidor:\n" +
      "      Debian/Ubuntu: apt install -y build-essential python3\n" +
      "      Alpine:        apk add build-base python3\n" +
      "  · Después: npm rebuild node-pty  (o borrá node_modules y npm install de nuevo)\n" +
      "  · Node.js debe ser >= 18.\n\nError original:",
  );
  console.error(err.message);
  process.exit(1);
}

if (!TOKEN && HOST !== "127.0.0.1" && HOST !== "localhost") {
  console.warn(
    `[webterm] ⚠ escuchando en ${HOST} SIN token — cualquiera que llegue a ` +
      `este puerto tiene una shell. Definí --token o WEBTERM_TOKEN.`,
  );
}

const app = express();
const server = http.createServer(app);

app.get("/healthz", (_req, res) => res.status(200).json({ ok: true }));

const wt = attachWebTerm(server, {
  path: WS_PATH,
  token: TOKEN,
  shell: SHELL,
  cwd: CWD,
  sessionTimeout: SESSION_TIMEOUT,
  maxSessions: MAX_SESSIONS,
  scrollbackBytes: SCROLLBACK_BYTES,
  maxUploadBytes: MAX_UPLOAD_MB * 1024 * 1024,
  files: FILES,
  filesPath: FILES_PATH,
  onSession: (s) =>
    console.log(
      `[webterm] sesión ${s.resuming ? "reanudada" : "nueva"} ` +
        `id=${s.id.slice(0, 8)} pid=${s.pid} desde ${s.remote}`,
    ),
});
// Antes del static/catch-all: si no, éste último (que no llama a next()) se
// come cualquier request, incluida /webterm-files/*.
app.use(wt.filesMiddleware);

if (STATIC) {
  const dir = path.resolve(STATIC);
  if (!fs.existsSync(dir)) {
    console.error(`[webterm] --static ${STATIC} no existe (¿falta 'npm run build'?)`);
    process.exit(1);
  }
  app.use(express.static(dir));
  app.use((_req, res) => {
    const index = path.join(dir, "index.html");
    if (fs.existsSync(index)) res.sendFile(index);
    else res.status(404).end("not found");
  });
}

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `[webterm] el puerto ${PORT} ya está en uso ` +
        `(fuser -k ${PORT}/tcp, o --port <otro>).`,
    );
    process.exit(1);
  }
  if (err.code === "EACCES") {
    console.error(
      `[webterm] sin permiso para escuchar en ${HOST}:${PORT} ` +
        `(¿puerto < 1024 sin ser root? usá uno > 1024 o corré con sudo/setcap).`,
    );
    process.exit(1);
  }
  throw err;
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`\n[webterm] ${sig} recibido, cerrando…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}

server.listen(PORT, HOST, () => {
  const st =
    SESSION_TIMEOUT === Infinity
      ? "∞"
      : SESSION_TIMEOUT === 0
        ? "off"
        : `${SESSION_TIMEOUT / 1000}s`;
  console.log(
    `[webterm] http://${HOST}:${PORT}  ws:${WS_PATH}  ` +
      `auth:${TOKEN ? "token" : "none"}  static:${STATIC || "-"}  persist:${st}  ` +
      `files:${FILES ? FILES_PATH : "off"}`,
  );
});
