import type { Server as HttpServer, IncomingMessage, ServerResponse } from "http";
import type { WebSocketServer, WebSocket } from "ws";

/** Connect/Express-style middleware: `(req, res, next?)`. */
export type FilesMiddleware = (
  req: IncomingMessage,
  res: ServerResponse,
  next?: () => void,
) => void;

export interface WebTermSession {
  id: string;
  pid: number;
  remote: string;
  term: unknown;
  ws: WebSocket;
  /** true when this connection reattached to an existing PTY. */
  resuming: boolean;
}

export interface AttachWebTermOptions {
  path?: string;
  token?: string;
  shell?: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
  /**
   * ms to keep a PTY alive after the last client disconnects, so a page refresh
   * can reattach. Default 600000 (10 min). 0 = kill on disconnect. Infinity =
   * never auto-kill.
   */
  sessionTimeout?: number;
  /** approx chars of output replayed to a reattaching client. Default 200000. */
  scrollbackBytes?: number;
  /** cap on concurrent live sessions. Default 50. */
  maxSessions?: number;
  onSession?: (session: WebTermSession) => void;
  authorize?: (req: IncomingMessage) => boolean;
  /** Expose upload/download HTTP routes for each session's live cwd. Default true. */
  files?: boolean;
  /**
   * Base path for the file routes: <filesPath>/list, /download, /upload,
   * /download-dir (a folder as a .zip), /upload-dir (a .zip extracted into
   * a folder). Default "/webterm-files".
   */
  filesPath?: string;
  /** Cap on a single uploaded file, in bytes. Default 500MB. */
  maxUploadBytes?: number;
}

export function attachWebTerm(
  server: HttpServer,
  options?: AttachWebTermOptions,
): WebSocketServer & {
  /** Mount this in front of `server` (app.use / server.middlewares.use) to serve the file routes. */
  filesMiddleware: FilesMiddleware;
  filesPath: string;
};
