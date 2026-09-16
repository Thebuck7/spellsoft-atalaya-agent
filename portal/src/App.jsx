import { TerminalWorkspace } from "react-webterm";
import "react-webterm/style.css";

// Token opcional: abre la app como  http://<host>:<puerto>/?token=SECRETO
const token =
  new URLSearchParams(window.location.search).get("token") || undefined;

export default function App() {
  return (
    <div style={{ height: "100dvh" }}>
      <TerminalWorkspace url="/ws" token={token} autoReconnect />
    </div>
  );
}
