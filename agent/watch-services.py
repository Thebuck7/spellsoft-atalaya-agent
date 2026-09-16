#!/usr/bin/env python3
"""
Watcher de servicios del agente de Atalaya.

Corre en background, sondea puertos locales cada POLL_INTERVAL segundos y
publica el estado a la API de Atalaya (PUT /servers/{SERVER_ID}/status) SOLO
cuando cambia: un servicio se levanta o se cae, cambia la IP, o cambia un
puerto/ruta.

Diseñado para consumir casi nada:
  - solo stdlib (sin dependencias — el PUT usa urllib, no requests/boto3)
  - el bucle es un connect() TCP a un puñado de puertos y luego duerme
  - la API solo se llama cuando de verdad hay un cambio (o heartbeat)
  - guarda el último estado en disco, así un reinicio del watcher no republica

Config: agent/.env (lo escribe install.sh) — SERVER_ID, AGENT_TOKEN, API_URL.

Uso:
    python3 watch-services.py            # foreground
    ./watch.sh start | stop | status | logs
"""

import json
import os
import signal
import socket
import subprocess
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent

POLL_INTERVAL = 15        # segundos entre sondeos
HEARTBEAT_SEC = 0         # republicar aunque no haya cambios (0 = solo-cambios)
PORT_TIMEOUT = 0.4        # timeout del connect() por puerto
HTTP_TIMEOUT = 10         # timeout del PUT a la API

STATE_FILE = HERE / ".watch-state.json"   # último payload publicado (cache local)
LOG_FILE = HERE / "watch-services.log"
CONFIG_FILE = HERE / "services.json"       # fuente de verdad de servicios
ENV_FILE = HERE / ".env"                   # SERVER_ID / AGENT_TOKEN / API_URL
PORTAL_ENV_FILE = HERE.parent / "portal" / ".env"   # WEBTERM_TOKEN de Portal (opcional)


def read_env(path):
    """Parser mínimo de archivos `CLAVE=valor` (sin comillas, # = comentario)."""
    values = {}
    try:
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            values[key.strip()] = val.strip()
    except OSError:
        pass
    return values


_agent_env = read_env(ENV_FILE)
SERVER_ID = _agent_env.get("SERVER_ID", "")
AGENT_TOKEN = _agent_env.get("AGENT_TOKEN", "")
API_URL = _agent_env.get("API_URL", "").rstrip("/")

# Token de Portal (para armar el link "/?token=..." en el path publicado) — no
# confundir con AGENT_TOKEN de arriba, que autentica el heartbeat con la API.
TOKEN = read_env(PORTAL_ENV_FILE).get("WEBTERM_TOKEN", "")

# Fallback si services.json falta o está roto — coincide con el default de
# services.json de este repo (una sola entrada: Terminal / Portal).
_DEFAULT_SERVICES = [
    {"name": "Terminal", "icon": "\U0001F5A5️", "port": 3001,
     "path": "/?token={token}", "scheme": "http"},
]
_DEFAULT_DISCOVER = [3000, 3002, 3003, 4000, 5000, 8000, 9000]


def load_config():
    """(services[], discover_ports[]) desde services.json, con fallback."""
    try:
        d = json.loads(CONFIG_FILE.read_text())
        return (d.get("services") or _DEFAULT_SERVICES,
                d.get("discover_ports") or _DEFAULT_DISCOVER)
    except (OSError, ValueError):
        return _DEFAULT_SERVICES, _DEFAULT_DISCOVER


def subst(v):
    return v.replace("{token}", TOKEN) if isinstance(v, str) else v


# ── Autodescubrimiento ──────────────────────────────────────────────────────
# Además de los servicios de services.json, publica cualquier puerto TCP en
# escucha como tarjeta genérica ("Puerto 3007"), que aparece/desaparece con el
# proceso. AUTODISCOVER = False para vigilar SOLO la lista declarada.
AUTODISCOVER = True
DISCOVER_RANGE = (3000, 9999)   # si se puede leer /proc: escanea este rango gratis
DISCOVER_IGNORE = {3306, 5432, 6379, 9229, 27017}   # infra / ruido a ocultar
DISCOVER_LABELS = {
    # 3000: ("Mi proyecto", "/", "\U0001F680"),
}
# Cuando /proc está bloqueado (containers/PRoot) se sondea con connect() la
# lista "discover_ports" de services.json.
# ────────────────────────────────────────────────────────────────────────────


def log(msg):
    line = "%s  %s" % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg)
    print(line, flush=True)
    try:
        with LOG_FILE.open("a") as f:
            f.write(line + "\n")
    except OSError:
        pass


def port_open(port):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(PORT_TIMEOUT)
    try:
        return s.connect_ex(("127.0.0.1", port)) == 0
    except OSError:
        return False
    finally:
        s.close()


def listening_ports():
    """Puertos TCP locales en estado LISTEN, leyendo /proc (sin dependencias)."""
    ports = set()
    for proc in ("/proc/net/tcp", "/proc/net/tcp6"):
        try:
            with open(proc) as f:
                next(f)  # cabecera
                for line in f:
                    parts = line.split()
                    if len(parts) > 3 and parts[3] == "0A":  # 0A = LISTEN
                        ports.add(int(parts[1].rsplit(":", 1)[1], 16))
        except (OSError, ValueError, StopIteration):
            pass
    return ports


def current_ip():
    try:
        out = subprocess.run(
            ["hostname", "-I"], capture_output=True, text=True, timeout=5
        ).stdout.split()
        return out[0] if out else "127.0.0.1"
    except (subprocess.SubprocessError, OSError):
        return "127.0.0.1"


def probe():
    """Estado actual: (ip, [services])."""
    ip = current_ip()
    services_cfg, discover_ports = load_config()
    listen = listening_ports()
    use_proc = bool(listen)  # si /proc no se pudo leer, caemos a connect()

    def is_up(port):
        return port in listen if use_proc else port_open(port)

    # 1) servicios declarados en services.json (con su alt_ports)
    out = []
    declared = set()
    for c in services_cfg:
        ports = [c["port"]] + list(c.get("alt_ports", []))
        declared.update(ports)
        live = next((p for p in ports if is_up(p)), None)
        out.append({
            "name": c["name"],
            "port": live or c["port"],
            "path": subst(c.get("path", "/")),
            "icon": c.get("icon", "\U0001F517"),
            "scheme": c.get("scheme", "http"),
            "up": live is not None,
        })

    # 2) puertos nuevos en escucha que no estén ya declarados
    if AUTODISCOVER:
        if use_proc:
            lo, hi = DISCOVER_RANGE
            candidates = [p for p in sorted(listen) if lo <= p <= hi]
        else:
            candidates = [p for p in discover_ports if port_open(p)]
        for port in candidates:
            if port in declared or port in DISCOVER_IGNORE:
                continue
            name, path, icon = DISCOVER_LABELS.get(
                port, ("Puerto %d" % port, "/", "\U0001F4E6")
            )
            out.append({
                "name": name, "port": port, "path": subst(path),
                "icon": icon, "scheme": "http", "up": True,
            })

    return ip, out


def fingerprint(ip, services):
    """Huella estable para detectar cambios (sin el timestamp)."""
    rows = sorted(
        [s["name"], s["port"], s["path"], s["icon"], s["scheme"], s["up"]]
        for s in services
    )
    return json.dumps({"ip": ip, "services": rows}, sort_keys=True)


def publish(ip, services):
    payload = json.dumps({"ip": ip, "services": services}).encode("utf-8")
    req = urllib.request.Request(
        "%s/servers/%s/status" % (API_URL, SERVER_ID),
        data=payload,
        method="PUT",
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer %s" % AGENT_TOKEN,
        },
    )
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT) as resp:
        resp.read()


def load_state():
    try:
        d = json.loads(STATE_FILE.read_text())
        return d.get("fingerprint"), float(d.get("published_at", 0))
    except (OSError, ValueError, TypeError):
        return None, 0.0


def save_state(fp):
    try:
        STATE_FILE.write_text(
            json.dumps({"fingerprint": fp, "published_at": time.time()})
        )
    except OSError:
        pass


_running = True


def _stop(signum, _frame):
    global _running
    _running = False


def main():
    if not (SERVER_ID and AGENT_TOKEN and API_URL):
        log("ERROR fatal: falta SERVER_ID/AGENT_TOKEN/API_URL en %s "
            "— corré install.sh de nuevo o completá ese archivo a mano" % ENV_FILE)
        raise SystemExit(1)

    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)

    last_fp, last_pub = load_state()
    log("watcher iniciado · poll=%ss heartbeat=%ss api=%s server=%s"
        % (POLL_INTERVAL, HEARTBEAT_SEC, API_URL, SERVER_ID))

    while _running:
        ip, services = probe()
        fp = fingerprint(ip, services)
        now = time.time()

        changed = fp != last_fp
        heartbeat_due = HEARTBEAT_SEC and (now - last_pub) >= HEARTBEAT_SEC

        if changed or heartbeat_due:
            try:
                publish(ip, services)
                reason = "cambio" if changed else "heartbeat"
                up_list = ", ".join(s["name"] for s in services if s["up"]) or "(ninguno)"
                log("publicado [%s] ip=%s arriba: %s" % (reason, ip, up_list))
                last_fp, last_pub = fp, now
                save_state(fp)
            except urllib.error.HTTPError as e:
                body = e.read().decode("utf-8", "replace") if e.fp else ""
                log("ERROR al publicar: HTTP %s %s" % (e.code, body))
            except (urllib.error.URLError, OSError) as e:
                log("ERROR al publicar (red): %s" % e)

        for _ in range(max(1, int(POLL_INTERVAL))):
            if not _running:
                break
            time.sleep(1)

    log("watcher detenido")


if __name__ == "__main__":
    main()
