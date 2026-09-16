#!/usr/bin/env bash
# Instalador de un paso para el agente de Atalaya.
#
#   curl -sSL https://raw.githubusercontent.com/Thebuck7/spellsoft-atalaya-agent/master/install.sh \
#     | bash -s -- <SERVER_ID> <AGENT_TOKEN>
#
# SERVER_ID y AGENT_TOKEN los da el dashboard de Atalaya al crear un servidor
# nuevo ("+ Agregar servidor" → copiar el comando que se muestra).
#
# Deja: Portal (terminal web) instalado y compilado, el agente configurado
# con sus credenciales, y todo arrancado vía `svc up`. No instala toolchain
# de compilación (node/npm/python3 deben existir de antes).
set -euo pipefail

REPO_URL="https://github.com/Thebuck7/spellsoft-atalaya-agent.git"
API_URL="https://6sfxu7joyg.execute-api.us-east-1.amazonaws.com"
INSTALL_DIR="$HOME/atalaya-agent"

say()  { printf '\033[1m==>\033[0m %s\n' "$1"; }
die()  { printf '\033[31mxx\033[0m %s\n' "$1" >&2; exit 1; }

SERVER_ID="${1:-}"
AGENT_TOKEN="${2:-}"
[ -n "$SERVER_ID" ] && [ -n "$AGENT_TOKEN" ] \
  || die "uso: install.sh <SERVER_ID> <AGENT_TOKEN>  (los da el dashboard de Atalaya al crear un servidor)"

say "Chequeando dependencias (node, npm, python3)"
command -v node    >/dev/null 2>&1 || die "node no está instalado (necesitás Node 18+)."
command -v npm     >/dev/null 2>&1 || die "npm no está instalado."
command -v python3 >/dev/null 2>&1 || die "python3 no está instalado."

if [ -d "$INSTALL_DIR/.git" ]; then
  say "Ya existe $INSTALL_DIR — actualizando"
  git -C "$INSTALL_DIR" pull
else
  say "Clonando en $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR"
fi

say "Instalando Portal (terminal web) — puede tardar unos minutos (compila node-pty)"
( cd "$INSTALL_DIR/portal" && ./install.sh )

say "Configurando el agente"
cat > "$INSTALL_DIR/agent/.env" <<EOF
SERVER_ID=$SERVER_ID
AGENT_TOKEN=$AGENT_TOKEN
API_URL=$API_URL
EOF

say "Arrancando (Portal + watcher)"
( cd "$INSTALL_DIR/agent" && ./svc up )

SYSTEMD_OK=0
if [ "$(id -u)" = "0" ] && command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  say "Configurando arranque automático (systemd)"
  sed "s#/opt/atalaya-agent#$INSTALL_DIR#g" \
    "$INSTALL_DIR/agent/systemd/atalaya-agent.service.example" > /etc/systemd/system/atalaya-agent.service
  systemctl daemon-reload
  systemctl enable --now atalaya-agent >/dev/null 2>&1 && SYSTEMD_OK=1
fi

echo
say "Listo. Deberías ver este servidor en tu dashboard de Atalaya en unos ~15-30s."
echo "  Control:  cd $INSTALL_DIR/agent && ./svc          # menú"
echo "            cd $INSTALL_DIR/agent && ./svc status   # estado"
if [ "$SYSTEMD_OK" = "1" ]; then
  echo "  Arranque automático: activado (systemctl status atalaya-agent)"
else
  echo
  echo "  Arranque automático al bootear (opcional, necesita root/sudo):"
  echo "    sudo cp $INSTALL_DIR/agent/systemd/atalaya-agent.service.example /etc/systemd/system/atalaya-agent.service"
  echo "    sudo sed -i \"s#/opt/atalaya-agent#$INSTALL_DIR#g\" /etc/systemd/system/atalaya-agent.service"
  echo "    sudo systemctl daemon-reload && sudo systemctl enable --now atalaya-agent"
fi
