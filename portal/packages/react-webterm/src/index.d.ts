import type { CSSProperties, ForwardRefExoticComponent, RefAttributes } from "react";
import type { Terminal as Xterm, ITheme } from "@xterm/xterm";

export type WebTermStatus = "connecting" | "connected" | "disconnected";

export interface WebTermProps {
  /** ws path or absolute ws:// URL. Default "/ws". */
  url?: string;
  /** Optional auth token, appended as ?token=. */
  token?: string;
  /** Explicit server session id. Overrides `persist`/storage. */
  sessionId?: string;
  /** Keep the server-side session alive across a page refresh. Default false. */
  persist?: boolean;
  /** sessionStorage key for the persisted session id. Default "webterm:" + url. */
  persistKey?: string;
  fontSize?: number;
  fontFamily?: string;
  theme?: ITheme;
  cursorBlink?: boolean;
  autoReconnect?: boolean;
  reconnectDelay?: number;
  header?: boolean;
  /** Copy the mouse selection to the clipboard automatically. Default true. */
  copyOnSelect?: boolean;
  /** Right-click pastes. Default false (needs a secure origin: https/localhost). */
  pasteOnRightClick?: boolean;
  /** Toolbar with Esc/Tab/Ctrl/Alt/arrows/Home/End/PgUp/PgDn/Del, collapsible.
   * "auto" shows it on coarse-pointer (touch) devices. Default "auto". */
  mobileToolbar?: boolean | "auto";
  /** Show upload/download controls + drag&drop over the terminal. Default true. */
  files?: boolean;
  /** Base path for the file HTTP routes. Default "/webterm-files". */
  filesPath?: string;
  onStatusChange?: (status: WebTermStatus) => void;
  onData?: (chunk: string) => void;
  className?: string;
  style?: CSSProperties;
}

export interface WebTermHandle {
  focus(): void;
  fit(): void;
  clear(): void;
  write(data: string): void;
  sendInput(data: string): void;
  reconnect(): void;
  /** Abandon the current session and start a fresh one. */
  newSession(): void;
  /** End the server-side session for good (kills the PTY) and stop reconnecting. */
  endSession(): void;
  /** Copy the current selection to the clipboard; returns the copied text. */
  copySelection(): string;
  /** Paste `text` (or the clipboard, on secure origins) into the terminal. */
  paste(text?: string): Promise<void>;
  /** Upload files into the shell's current cwd (same as a drag&drop). */
  uploadFiles(files: FileList | File[]): void;
  getSessionId(): string | null;
  getTerminal(): Xterm | null;
  getSocket(): WebSocket | null;
}

export const WebTerm: ForwardRefExoticComponent<
  WebTermProps & RefAttributes<WebTermHandle>
>;

export default WebTerm;

/* ── TerminalWorkspace ─────────────────────────────────────────────── */

export interface WorkspaceTerminalInfo {
  id: string;
  title: string;
  sessionId: string;
}

export interface TerminalWorkspaceProps {
  url?: string;
  token?: string;
  /** localStorage key for the saved layout. Default "webterm-workspace". */
  storageKey?: string;
  /** "auto" picks windows on wide screens, tabs on narrow. Default "auto". */
  layout?: "auto" | "tabs" | "windows";
  /** px; below this width "auto" uses tabs. Default 720. */
  windowsMinWidth?: number;
  theme?: ITheme;
  fontSize?: number;
  fontFamily?: string;
  cursorBlink?: boolean;
  autoReconnect?: boolean;
  copyOnSelect?: boolean;
  pasteOnRightClick?: boolean;
  mobileToolbar?: boolean | "auto";
  /** Show upload/download controls + drag&drop over each terminal. Default true. */
  files?: boolean;
  /** Base path for the file HTTP routes. Default "/webterm-files". */
  filesPath?: string;
  newTerminalTitle?: (n: number) => string;
  className?: string;
  style?: CSSProperties;
}

export interface TerminalWorkspaceHandle {
  addTerminal(): void;
  closeTerminal(id: string): void;
  listTerminals(): WorkspaceTerminalInfo[];
  getState(): unknown;
}

export const TerminalWorkspace: ForwardRefExoticComponent<
  TerminalWorkspaceProps & RefAttributes<TerminalWorkspaceHandle>
>;
