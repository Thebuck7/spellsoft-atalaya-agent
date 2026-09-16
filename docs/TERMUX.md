# Instalar en Termux (Android)

Termux es una terminal para Android. Sirve para que tu celular o tablet
también aparezca en el dashboard de Atalaya. No hace falta saber programar,
solo copiar y pegar.

## Requisitos

- Instalá Termux desde **F-Droid**, no desde Play Store (la de Play Store
  está desactualizada y suele fallar):
  https://f-droid.org/packages/com.termux/

## Pasos

1. Abrí Termux y esperá a que termine de configurarse la primera vez.

2. Copiá y pegá esto completo, apretá Enter (instala lo necesario para
   compilar — puede tardar varios minutos la primera vez):

   ```
   pkg update -y && pkg upgrade -y && pkg install -y nodejs-lts python clang make git curl
   ```

3. Entrá al dashboard de Atalaya → **"+ Agregar servidor"** → copiá el
   comando que te muestra (ya trae tus credenciales incluidas).

4. Pegalo en Termux y presioná Enter. Es el mismo comando que en una
   computadora:

   ```
   curl -sSL https://raw.githubusercontent.com/Thebuck7/spellsoft-atalaya-agent/master/install.sh \
     | bash -s -- <SERVER_ID> <AGENT_TOKEN>
   ```

   Va a tardar unos minutos compilando la terminal web.

5. A los ~15-30s tu celular debería aparecer en el dashboard.

## Que no se corte al apagar la pantalla

Android mata procesos en segundo plano para ahorrar batería. Para que el
agente siga corriendo con la pantalla apagada:

- Deslizá hacia abajo la barra de notificaciones, tocá la notificación de
  Termux y elegí **"Acquire wakelock"** (o corré `termux-wake-lock` dentro
  de Termux).
- En los ajustes de batería del celular, buscá Termux y desactivá la
  optimización de batería / elegí "Sin restricciones".

## Arranque automático al prender el celular

Termux no tiene systemd, así que el arranque automático funciona distinto:

1. Instalá la app **Termux:Boot** (también en F-Droid) y abrila una vez
   para darle permiso.
2. Creá el script de arranque:

   ```
   mkdir -p ~/.termux/boot
   cat > ~/.termux/boot/start-atalaya.sh <<'EOF'
   #!/data/data/com.termux/files/usr/bin/sh
   termux-wake-lock
   cd ~/atalaya-agent/agent && ./svc up
   EOF
   chmod +x ~/.termux/boot/start-atalaya.sh
   ```

3. Listo. De ahora en más, cada vez que reiniciés el celular (o Android
   mate Termux), Termux:Boot corre ese script solo.

## Problemas comunes

- **Error con `node-gyp`, `make` o "compilador"**: faltó el toolchain del
  paso 2. Corré `pkg install -y clang make python` y volvé a correr el
  comando de instalación del paso 4 — es seguro repetirlo.
- **`pkg: command not found` o Termux muy viejo**: desinstalá la versión de
  Play Store e instalá la de F-Droid (arriba).
- **El celular deja de aparecer en el dashboard después de un rato**: es el
  ahorro de batería de Android matando Termux — mirá la sección de arriba
  ("Que no se corte al apagar la pantalla").

## Control manual

```
cd ~/atalaya-agent/agent
./svc status   # ver qué está corriendo
./svc          # menú interactivo
```
