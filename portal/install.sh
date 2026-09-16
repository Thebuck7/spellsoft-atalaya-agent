#!/usr/bin/env bash
# Instalador para un servidor nuevo (Linux, cualquier distro con Node 18+).
#
#   git clone <repo> webterm-app && cd webterm-app && ./install.sh
#
# Deja: dependencias instaladas, node-pty compilado, .env listo para editar,
# y el build de producción (dist/) hecho. No arranca nada — ver el resumen
# final para eso.
set -euo pipefail
cd "$(dirname "$0")"

say()  { printf '\033[1m==>\033[0m %s\n' "$1"; }
warn() { printf '\033[33m!!\033[0m %s\n' "$1" >&2; }
die()  { printf '\033[31mxx\033[0m %s\n' "$1" >&2; exit 1; }

say "Chequeando Node.js"
command -v node >/dev/null 2>&1 || die "node no está instalado (necesitás Node 18+)."
NODE_MAJOR="$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  die "Node $(node -v) es muy viejo — necesitás 18 o más nuevo."
fi
say "Node $(node -v) OK"

command -v npm >/dev/null 2>&1 || die "npm no está instalado."

say "Instalando dependencias (esto compila node-pty, un módulo nativo)"
if ! npm install; then
  warn "npm install falló — node-pty necesita un compilador de C++."
  warn "Debian/Ubuntu: sudo apt install -y build-essential python3"
  warn "Alpine:        sudo apk add build-base python3"
  warn "RHEL/Fedora:   sudo dnf groupinstall -y 'Development Tools' && sudo dnf install -y python3"
  die "instalá el toolchain de arriba y volvé a correr ./install.sh"
fi

say "Verificando que node-pty haya compilado"
node -e "require('./packages/webterm-server/node_modules/node-pty')" 2>/dev/null \
  || node -e "require('node-pty')" 2>/dev/null \
  || die "node-pty no cargó. Probá: npm rebuild node-pty"
say "node-pty OK"

if [ ! -f .env ]; then
  cp .env.example .env
  TOKEN="$(openssl rand -hex 16 2>/dev/null || node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')"
  # inserta un token generado en vez de dejarlo vacío — más seguro por default
  if command -v sed >/dev/null 2>&1; then
    sed -i.bak "s/^WEBTERM_TOKEN=.*/WEBTERM_TOKEN=${TOKEN}/" .env && rm -f .env.bak
  fi
  say ".env creado con un token nuevo (editalo para ajustar puerto, shell, etc.)"
else
  say ".env ya existe, lo dejo como está"
fi

say "Build de producción (react-webterm + vite build)"
npm run build

echo
say "Listo."
echo
echo "  Probar en primer plano:"
echo "    npm start                  # build ya hecho arriba, arranca en :3001 (o WEBTERM_PORT)"
echo "    npm run start:lan          # igual, pero en 0.0.0.0 (toda la red)"
echo
echo "  Instalar como servicio systemd (arranca solo, sobrevive reinicios):"
echo "    sudo cp systemd/webterm.service.example /etc/systemd/system/webterm.service"
echo "    sudo sed -i \"s#/opt/webterm-app#$(pwd)#g\" /etc/systemd/system/webterm.service"
echo "    sudo systemctl daemon-reload && sudo systemctl enable --now webterm"
echo
echo "  Token generado en .env — la URL es http://<host>:<puerto>/?token=<ese-token>"
