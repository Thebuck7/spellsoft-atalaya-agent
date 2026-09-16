import "dotenv/config";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { attachWebTerm } from "webterm-server";

// En dev, el WebSocket del terminal (/ws) lo sirve el propio servidor de Vite:
// no hace falta un backend aparte ni un proxy.
function webterm(options = {}) {
  return {
    name: "webterm-dev",
    configureServer(server) {
      if (!server.httpServer) return; // middleware mode: no http.Server to attach to
      const wsPath = process.env.WEBTERM_WS_PATH || "/ws";
      const wt = attachWebTerm(server.httpServer, {
        path: wsPath,
        sessionTimeout: Infinity, // las sesiones viven hasta que las cierres
        token: process.env.WEBTERM_TOKEN || "",
        shell: process.env.WEBTERM_SHELL || undefined,
        cwd: process.env.WEBTERM_CWD || undefined,
        maxSessions: process.env.WEBTERM_MAX_SESSIONS
          ? parseInt(process.env.WEBTERM_MAX_SESSIONS, 10)
          : undefined,
        ...options,
      });
      // Montado aquí (no diferido) para quedar ANTES de las internas de Vite:
      // si no, el fallback de SPA (sirve index.html para cualquier GET no
      // reconocido) intercepta /webterm-files/* primero.
      // Sin prefijo: filesMiddleware ya filtra por pathname completo — si se
      // monta con `.use(path, fn)`, connect recorta ese prefijo de req.url
      // antes de llamar a fn, y el chequeo interno dejaría de matchear.
      server.middlewares.use(wt.filesMiddleware);
      server.config.logger.info(
        `  \x1b[32m➜\x1b[0m  \x1b[1mwebterm\x1b[22m: terminal en ${wsPath}` +
          (process.env.WEBTERM_TOKEN ? "  (token)" : ""),
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), webterm()],
  server: {
    host: true, // accesible desde la LAN
    port: parseInt(process.env.WEBTERM_DEV_PORT || "5190", 10),
    strictPort: true,
  },
});
