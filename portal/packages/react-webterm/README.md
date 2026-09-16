# react-webterm

Componente React de terminal sobre WebSocket (xterm.js). Pareja de
[`webterm-server`](../webterm-server).

```bash
npm install react-webterm webterm-server
```

```jsx
import { WebTerm, TerminalWorkspace } from "react-webterm";
import "react-webterm/style.css";

// una terminal
<div style={{ height: 400 }}>
  <WebTerm url="/ws" header autoReconnect persist />
</div>

// varias: pestañas en móvil, ventanas en escritorio, persistidas en localStorage
<div style={{ height: "100dvh" }}>
  <TerminalWorkspace url="/ws" autoReconnect />
</div>
```

El contenedor ocupa el 100% de su padre — dale altura al padre.
`<TerminalWorkspace>` necesita el server con `sessionTimeout: Infinity`.

Ver la [documentación completa](../../README.md): props, ref imperativa,
protocolo del WebSocket y el servidor.

## Protocolo

```
cliente → servidor : {"type":"input","data":"…"} | {"type":"resize","cols":N,"rows":N}
servidor → cliente : salida cruda del shell (string)
```

Sirve cualquier backend que hable eso; `webterm-server` es la implementación de
referencia con `node-pty`.
