# webterm-server

Adjunta un terminal PTY (`node-pty`) por WebSocket a cualquier `http.Server` de
Node. Pareja de [`react-webterm`](../react-webterm).

```js
import http from "http";
import { attachWebTerm } from "webterm-server";

const server = http.createServer(app); // app de Express, etc. (opcional)
attachWebTerm(server, { path: "/ws", token: process.env.WEBTERM_TOKEN });
server.listen(3001);
```

## CLI

```bash
npx webterm-server --port 3001 --host 127.0.0.1 --token SECRETO --static ./dist
```

| flag | default |
|---|---|
| `--port` | `3001` (o `$WEBTERM_PORT`) |
| `--host` | `127.0.0.1` (o `$WEBTERM_HOST`) |
| `--token` | — (o `$WEBTERM_TOKEN`) |
| `--path` | `/ws` |
| `--static` | — carpeta a servir (o `$WEBTERM_STATIC`) |

## Opciones de `attachWebTerm`

`path` · `token` · `authorize(req)` · `shell` · `args` · `cwd` · `env` ·
`cols` · `rows` · `sessionTimeout` · `maxSessions` · `scrollbackBytes` ·
`files` · `filesPath` · `maxUploadBytes` · `onSession({pid,remote,term,ws})`

Con `token`, los clientes sin token válido se rechazan con **HTTP 401** en el
upgrade (no llega a abrirse el WebSocket).

### Transferencia de archivos (`files: true`, default)

Bajo `filesPath` (default `/webterm-files`), auth'd igual que el WebSocket:

| Ruta | Qué hace |
|---|---|
| `GET /list?dir=` | lista un directorio |
| `GET /download?dir=&name=` | baja un archivo |
| `POST /upload?dir=&name=` | sube un archivo (body = bytes crudos) |
| `GET /download-dir?dir=&name=` | baja una carpeta completa como `.zip` |
| `POST /upload-dir?dir=` | sube un `.zip` y lo extrae ahí, con subcarpetas |

Todas relativas al cwd *actual* de la sesión (`?sessionId=`), resuelto en vivo.
`upload-dir` valida cada entrada del zip contra "zip slip" (rutas `../../`) —
nunca escribe fuera de `dir`.

Solo intercepta los upgrades de `path`; convive con otros WebSocket en el mismo
`http.Server` (p. ej. el HMR de Vite si lo montas en un plugin de dev).

Ver la [documentación completa](../../README.md).
