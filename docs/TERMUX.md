# Instalar en Termux (Android, con Ubuntu adentro)

Esta guía es para instalar el agente en un celular/tablet Android usando
**Termux + proot-distro con Ubuntu** (Termux nativo no trae suficientes
paquetes para compilar Portal, por eso se usa un Ubuntu completo adentro).
No hace falta saber programar, solo copiar y pegar.

## Requisitos

- Instalá Termux desde **F-Droid**, no desde Play Store (la de Play Store
  está desactualizada y suele fallar):
  https://f-droid.org/packages/com.termux/

## Pasos

1. Abrí Termux y esperá a que termine de configurarse la primera vez.

2. Instalá `proot-distro` y el Ubuntu adentro (copiá y pegá, Enter):

   ```
   pkg update -y && pkg install -y proot-distro
   proot-distro install ubuntu
   ```

   Tarda varios minutos — descarga Ubuntu completo.

3. Entrá al Ubuntu (vas a tener que hacer esto **cada vez** que abras
   Termux y quieras usar el agente):

   ```
   proot-distro login ubuntu
   ```

   El prompt cambia (algo como `root@localhost:~#`) — ya estás "adentro"
   de Ubuntu.

4. Ya adentro de Ubuntu, instalá lo necesario para compilar (una sola vez):

   ```
   apt update && apt install -y curl git build-essential python3 python3-dev nodejs npm
   ```

   Chequeá que Node haya quedado en versión 18 o más nueva:

   ```
   node -v
   ```

   Si te muestra menos de v18 (puede pasar en versiones viejas de Ubuntu),
   instalá una versión más nueva así:

   ```
   curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
   apt install -y nodejs
   ```

5. Entrá al dashboard de Atalaya (desde el navegador del celular u otra
   compu) → **"+ Agregar servidor"** → copiá el comando que te muestra.

6. Pegalo **dentro del Ubuntu** (el prompt tiene que decir `root@localhost`,
   si dice otra cosa te faltó el paso 3) y presioná Enter:

   ```
   curl -sSL https://raw.githubusercontent.com/Thebuck7/spellsoft-atalaya-agent/master/install.sh \
     | bash -s -- <SERVER_ID> <AGENT_TOKEN>
   ```

   Va a tardar unos minutos compilando la terminal web.

7. A los ~15-30s tu celular debería aparecer en el dashboard.

## Que no se corte al apagar la pantalla

Android mata procesos en segundo plano para ahorrar batería. Para que el
agente siga corriendo con la pantalla apagada:

- Deslizá hacia abajo la barra de notificaciones, tocá la notificación de
  Termux y elegí **"Acquire wakelock"** (o corré `termux-wake-lock` en
  Termux, fuera del `proot-distro login`).
- En los ajustes de batería del celular, buscá Termux y desactivá la
  optimización de batería / elegí "Sin restricciones".

## Arranque automático al prender el celular

Ni Termux ni el Ubuntu de proot-distro tienen systemd, así que el arranque
automático se arma con la app **Termux:Boot**:

1. Instalá **Termux:Boot** (también en F-Droid) y abrila una vez para darle
   permiso.
2. Desde Termux (no hace falta estar dentro del Ubuntu), creá el script:

   ```
   mkdir -p ~/.termux/boot
   cat > ~/.termux/boot/start-atalaya.sh <<'EOF'
   #!/data/data/com.termux/files/usr/bin/sh
   termux-wake-lock
   proot-distro login ubuntu -- bash -c "cd ~/atalaya-agent/agent && ./svc up"
   EOF
   chmod +x ~/.termux/boot/start-atalaya.sh
   ```

3. Listo. De ahora en más, cada vez que reiniciés el celular (o Android
   mate Termux), Termux:Boot entra al Ubuntu y levanta el agente solo.

## Problemas comunes

- **`proot-distro: command not found`**: te faltó el paso 2
  (`pkg install -y proot-distro`).
- **Error con `node-gyp`, `make` o "compilador de C++"**: te faltó el
  toolchain del paso 4. Adentro del Ubuntu (`proot-distro login ubuntu`)
  corré `apt install -y build-essential python3-dev` y volvé a correr el
  comando del paso 6 — es seguro repetirlo.
- **El comando de instalación no encuentra `node`/`npm`/`python3`**:
  seguro estás en Termux nativo y no adentro del Ubuntu — fijate que el
  prompt diga `root@localhost` (paso 3).
- **El celular deja de aparecer en el dashboard después de un rato**: es
  el ahorro de batería de Android matando Termux — mirá la sección
  "Que no se corte al apagar la pantalla" arriba.

## Control manual

Siempre desde adentro del Ubuntu (`proot-distro login ubuntu` primero):

```
cd ~/atalaya-agent/agent
./svc status   # ver qué está corriendo
./svc          # menú interactivo
```
