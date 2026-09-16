# spellsoft-atalaya-agent

Agente instalable en un servidor para que aparezca en el dashboard
[Atalaya](https://github.com/Thebuck7/spellsoft-atalaya-agent) — expone una
terminal web (Portal) y le reporta a Atalaya, cada vez que cambia algo, su IP
y qué servicios tiene arriba.

## Instalar

No hace falta saber programar. En el servidor nuevo (Linux, Node 18+, Python 3):

1. Entrá al dashboard de Atalaya y hacé click en **"+ Agregar servidor"**.
2. Copiá el comando que te muestra (ya trae tus credenciales incluidas).
3. Pegalo en la terminal del servidor nuevo y presioná Enter. Va a tardar
   unos minutos — instala solo, no hay que tocar nada más.

¿Instalando desde el celular con Termux (Android)? Seguí
[docs/TERMUX.md](docs/TERMUX.md) — mismos pasos, con las particularidades
de Android (batería, arranque automático, etc.).

El comando tiene esta forma (no hace falta escribirlo a mano, es solo para
referencia):

```bash
curl -sSL https://raw.githubusercontent.com/Thebuck7/spellsoft-atalaya-agent/master/install.sh \
  | bash -s -- <SERVER_ID> <AGENT_TOKEN>
```

`SERVER_ID` y `AGENT_TOKEN` los genera el dashboard al crear el servidor. Si
ya tenés el agente instalado y solo necesitás cargar las credenciales a mano,
el dashboard también te deja copiarlas por separado.

El instalador clona este repo en `~/atalaya-agent`, instala y compila Portal
(`portal/install.sh`), escribe `agent/.env` con las credenciales, y arranca
todo con `./svc up`. A los ~15-30s el servidor aparece en el dashboard.

### Si el instalador se queja de "make", "gcc" o "node-gyp"

Portal usa un módulo nativo (`node-pty`) que necesita compilarse la primera
vez. Si ves un error mencionando `node-gyp`, `make` o "compilador de C++",
instalá el toolchain y volvé a correr **el mismo comando de arriba**:

```bash
# Debian/Ubuntu
sudo apt update && sudo apt install -y build-essential python3-dev

# Alpine
sudo apk add build-base python3

# RHEL/Fedora
sudo dnf groupinstall -y 'Development Tools' && sudo dnf install -y python3
```

El instalador es seguro de correr varias veces — si algo ya está instalado,
lo detecta y sigue donde quedó.

### Arranque automático al bootear

Si corriste el instalador como **root** (lo más común en un servidor propio),
ya quedó activado solo — no hay que hacer nada más. Si no, el instalador
imprime al final los 3 comandos (`sudo`) para activarlo a mano.

Sin esto, `svc up` solo queda corriendo hasta el próximo reinicio del servidor.

## Estructura

```
spellsoft-atalaya-agent/
├── portal/          copia vendorizada de Portal (terminal web) — ver su README
├── agent/
│   ├── svc                 launcher/menú de control (arranca/para/logs)
│   ├── watch-services.py   observer: sondea puertos, publica cambios a la API de Atalaya
│   ├── watch.sh             arranca/para watch-services.py en background
│   ├── services.json         qué servicios corre este servidor (por defecto: solo Terminal)
│   └── .env                  SERVER_ID / AGENT_TOKEN / API_URL (lo crea install.sh, no se commitea)
├── install.sh        instalador de un paso (ver arriba)
└── README.md
```

## Notas

- `portal/` es una **copia vendorizada** de
  [`/root/portal-app`](https://github.com/Thebuck7/spellsoft-portal), no un
  submódulo ni un symlink — diverge con el tiempo, mismo trade-off ya
  aceptado entre `webterm` y `portal-app`. Un cambio de UI en Portal se
  portea a mano copiándolo acá.
- `agent/svc` y `agent/watch.sh` son genéricos (sin nada específico de
  ninguna máquina) — `agent/watch-services.py` es la única pieza que sabe
  hablar con la API de Atalaya (antes usaba `aws s3 cp`; ahora es un `PUT`
  HTTP con la stdlib de Python, sin dependencias nuevas).
- Borrar el servidor desde el dashboard de Atalaya revoca su `AGENT_TOKEN`
  del lado del servidor — el próximo heartbeat de este agente falla con 404,
  pero el agente sigue corriendo localmente hasta que lo pares vos
  (`./svc down`) o reinstales apuntando a un servidor nuevo.
