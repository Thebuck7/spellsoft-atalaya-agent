# webterm-app

Terminal web (pestañas + ventanas, xterm.js) — **proyecto autocontenido**,
instalable en cualquier servidor Linux con un `git clone` + `./install.sh`.

```
webterm-app/
├── packages/
│   ├── react-webterm/     <TerminalWorkspace /> — componente React (xterm.js)
│   └── webterm-server/    attachWebTerm() + CLI `webterm-server` (ws + node-pty)
├── src/App.jsx            usa react-webterm, lee ?token= de la URL
├── vite.config.js         dev: sirve /ws desde el propio Vite (sin backend aparte)
├── install.sh             instalador para un servidor nuevo
├── systemd/                unit de ejemplo para correrlo como servicio
└── .env.example            todas las variables, documentadas
```

`packages/react-webterm` y `packages/webterm-server` son copias vendorizadas
(no symlinks a otro repo) — este proyecto no depende de nada fuera de sí
mismo. Antes vivían en un monorepo aparte (`/root/webterm`, pensado para
compartir entre varias apps); ese repo se deja intacto como referencia, pero
**webterm-app ya no lo usa**. Si en el futuro hace falta reusar el
componente/servidor en otro proyecto, copiá desde acá (o desde `/root/webterm`
si preferís no arrastrar las mejoras de acá).

## Requisitos

- Node.js **18+**
- Un compilador de C++ (para `node-pty`, el único módulo nativo):
  - Debian/Ubuntu: `apt install -y build-essential python3`
  - Alpine: `apk add build-base python3`
  - RHEL/Fedora: `dnf groupinstall -y 'Development Tools' && dnf install -y python3`

## Instalar en un servidor nuevo

```bash
git clone <este-repo> webterm-app
cd webterm-app
./install.sh
```

`install.sh` instala dependencias, verifica que `node-pty` haya compilado,
crea `.env` (con un token aleatorio si no existía uno) y hace el build de
producción. Después:

```bash
npm start          # build ya hecho por install.sh → arranca en :3001 (o $WEBTERM_PORT)
npm run start:lan   # igual, pero escuchando en 0.0.0.0 (toda la red)
```

Abrí `http://<host>:<puerto>/?token=<el-de-tu-.env>`.

### Como servicio systemd (recomendado en un servidor real)

```bash
sudo cp systemd/webterm.service.example /etc/systemd/system/webterm.service
sudo sed -i "s#/opt/webterm-app#$(pwd)#g" /etc/systemd/system/webterm.service
sudo systemctl daemon-reload
sudo systemctl enable --now webterm
sudo systemctl status webterm
```

El unit de ejemplo corre como un usuario sin privilegios (`webterm`, no
root) — el comentario adentro trae el `useradd` para crearlo.

## Parametrización

Todo se configura por variables de entorno — en un archivo `.env` (se carga
solo, tanto en dev como en prod) o exportadas a mano. Los flags de línea de
comandos (`webterm-server --flag valor`) pisan al `.env`. Ver `.env.example`
para la lista con comentarios; referencia completa:

| Variable                      | Flag CLI              | Default            | Qué hace |
|--------------------------------|------------------------|---------------------|----------|
| `WEBTERM_PORT`                 | `--port`               | `3001`               | puerto del server de producción |
| `WEBTERM_HOST`                 | `--host`               | `127.0.0.1`          | interfaz de escucha (`0.0.0.0` = toda la red) |
| `WEBTERM_DEV_PORT`             | —                       | `5190`               | puerto de `npm run dev` (Vite) |
| `WEBTERM_WS_PATH`              | `--path`               | `/ws`                | ruta del WebSocket |
| `WEBTERM_TOKEN`                | `--token`               | (vacío = sin auth)  | token requerido como `?token=` |
| `WEBTERM_SHELL`                | `--shell`               | `$SHELL` o `bash`   | shell a lanzar |
| `WEBTERM_CWD`                  | `--cwd`                 | `$HOME`              | directorio inicial de cada sesión |
| `WEBTERM_SESSION_TIMEOUT`      | `--session-timeout`     | `600` (segundos)     | vida de la sesión tras desconectar. `0`=muere al toque, `inf`=nunca |
| `WEBTERM_MAX_SESSIONS`         | `--max-sessions`        | `50`                 | shells simultáneas permitidas |
| `WEBTERM_SCROLLBACK_BYTES`     | `--scrollback-bytes`    | `200000`             | histórico que se reenvía al reconectar |
| `WEBTERM_FILES`                | `--no-files` (desactiva)| `1` (activado)       | rutas HTTP de subir/bajar archivos |
| `WEBTERM_FILES_PATH`           | `--files-path`          | `/webterm-files`     | prefijo de esas rutas |
| `WEBTERM_MAX_UPLOAD_MB`        | `--max-upload-mb`       | `500`                 | tamaño máx. por archivo subido |

`webterm-server --help` imprime esta misma tabla desde la terminal.

### Seguridad

- **Sin `WEBTERM_TOKEN` no hay autenticación** — cualquiera que llegue al
  puerto tiene una shell. El instalador genera uno solo; en `WEBTERM_HOST=0.0.0.0`
  sin token el server imprime un warning al arrancar.
- El token se compara en tiempo constante (`crypto.timingSafeEqual` sobre un
  hash, no un `===` directo) para no filtrar nada por timing.
- Esto **no es HTTPS**. Para exponerlo a internet, ponele un reverse proxy
  (nginx/Caddy/Cloudflare Tunnel) con TLS delante — `webterm-server` en sí
  solo habla HTTP plano.
- `node-pty` es el único módulo nativo; si falla al cargar, `webterm-server`
  lo dice con un mensaje claro (qué paquetes instalar) en vez de un stack
  trace críptico.
- Nota sobre `npm audit`: reporta 2 vulnerabilidades de `esbuild`/`vite`, pero
  son del **servidor de desarrollo de Vite** (CSRF/DNS-rebinding contra
  `npm run dev`) — el camino de producción (`webterm-server --static dist`,
  lo que corre `npm start` / el systemd unit) es Express + `ws` puro, no usa
  Vite/esbuild en ningún momento, así que no aplica ahí. No se forzó el
  upgrade a Vite 6/8 (rompe compatibilidad) por ese motivo; si vas a correr
  `npm run dev` expuesto más allá de tu LAN, tenelo en cuenta.

## Desarrollo (esta máquina)

```bash
npm run dev          # http://localhost:5190 — todo en un proceso, con HMR
```

El WebSocket (`/ws`) lo sirve el propio Vite vía el plugin en
`vite.config.js` — no hace falta levantar `webterm-server` aparte. Si tocás
`packages/react-webterm/src/*`, `npm run dev`/`npm run build` reconstruyen
la librería solos (script `build:lib`) antes de arrancar.

### Producción local (sin systemd)

```bash
npm start            # build + webterm-server sirviendo dist/ en :3001
npm run start:lan     # igual, en 0.0.0.0
```

## Notas

- Las sesiones (shells) sobreviven un refresh de página y hasta un rato
  después de cerrar la pestaña (`WEBTERM_SESSION_TIMEOUT`); en dev el plugin
  las deja vivas indefinidamente. El layout (qué terminales hay, tamaño y
  posición de las ventanas) se guarda en `localStorage` del navegador.
- `GET /healthz` devuelve `{"ok":true}` — útil para healthchecks de un
  reverse proxy o de systemd/docker.
- **Subir/bajar carpetas enteras**: el botón "⬆📁" (o arrastrar una carpeta
  sobre la terminal) la comprime en el navegador y la extrae del lado del
  servidor preservando subcarpetas; "⬇📁" en la barra de navegación de
  archivos (y el ⬇ junto a cada carpeta en el listado) la baja de vuelta
  como `.zip`. Igual que el resto de la transferencia de archivos, siempre
  relativo al cwd *actual* de la sesión.
