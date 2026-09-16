# spellsoft-atalaya-agent

Agente instalable en un servidor para que aparezca en el dashboard
[Atalaya](https://github.com/Thebuck7/spellsoft-atalaya-agent) — expone una
terminal web (Portal) y le reporta a Atalaya, cada vez que cambia algo, su IP
y qué servicios tiene arriba.

## Instalar

En el servidor nuevo (Linux, Node 18+, Python 3):

```bash
curl -sSL https://raw.githubusercontent.com/Thebuck7/spellsoft-atalaya-agent/master/install.sh \
  | bash -s -- <SERVER_ID> <AGENT_TOKEN>
```

`SERVER_ID` y `AGENT_TOKEN` los genera el dashboard de Atalaya al crear un
servidor ("+ Agregar servidor" → copiar el comando que muestra) — no hace
falta escribirlos a mano salvo para probar el instalador manualmente.

El instalador clona este repo en `~/atalaya-agent`, instala y compila Portal
(`portal/install.sh`), escribe `agent/.env` con las credenciales, y arranca
todo con `./svc up`. A los ~15-30s el servidor aparece en el dashboard.

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
