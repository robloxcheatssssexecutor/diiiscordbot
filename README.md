# Discord Key Bot (simple)

Bot para generar y gestionar keys desde Discord, con API HTTP para validar primer login desde el menu.

## Comandos

Todos con prefijo `!` por defecto:

- `!keygen <duracion_en_dias>`
- `!keylist`
- `!keycheck <key>`
- `!keydel <key>`
- `!resethwid <key>`
- `!tablaprecios`
- `!tablaprecios set <tiempo> <precio>`
- `!ticketpanel`
- `!falcaohelp`

`!falcaohelp` es publico. El resto requiere el rol `1502014441623916544`.

Tiempos validos para `!tablaprecios set`:

- `1w` (1 Week)
- `1m` (1 Month)
- `3m` (3 Month)
- `life` (Lifetime)
- `custom` (Custom Time)

## Formato de key

- `FALCAO-EXTERNAL-XXXXX-XXXXX` (`X` = letras y numeros random).

## Variables `.env`

Crea un archivo `.env` usando `.env.example`:

- `DISCORD_TOKEN`: token del bot (Discord Developer Portal -> Bot -> Token)
- `PREFIX`: prefijo de comandos (ej. `!`)
- `API_PORT`: puerto HTTP para validar licencias (default `3000`)
- `MENU_API_TOKEN`: token compartido para que solo tu menu pueda usar la API

## Ejecutar local

```bash
npm install
npm start
```

## API para el menu (primer login HWID/IP)

Endpoint:

- `POST /api/license/validate`
- `POST /api/v1/licenses/activate` (compat menu antiguo)
- `POST /api/v1/licenses/validate` (compat menu antiguo)

Headers:

- `Content-Type: application/json`
- `x-menu-token: <MENU_API_TOKEN>`

Body JSON:

```json
{
  "key": "FALCAO-EXTERNAL-ABCDE-12345",
  "hwid": "HWID_DEL_CLIENTE",
  "ip": "IP_DEL_CLIENTE"
}
```

Comportamiento:

- Primer login: guarda `hwid` + `ip` en la key.
- Siguientes logins: solo valida si coinciden `hwid` e `ip`.
- Si no coinciden, devuelve denegado.

## Importante para conectar con el menu

Si tu menu usa el cliente antiguo de licencias, la URL base debe apuntar al dominio de Discloud del bot, por ejemplo:

- `https://falcaobot.onrender.com/api/v1`

No debe quedar en `https://localhost:8443/api/v1` cuando hagas uso real.

## Subir a Discloud

1. Entra a la carpeta `discord-key-bot`.
2. Asegura que existen: `index.js`, `package.json`, `discloud.config`, `.env`.
3. Comprime el contenido de `discord-key-bot` en un `.zip`.
4. Sube ese zip a Discloud.

## Deploy en Koyeb (recomendado para URL publica)

1. Sube `discord-key-bot` a un repo GitHub.
2. En Koyeb: `Create Web Service` -> `GitHub` -> selecciona repo.
3. Runtime: Node.js.
4. Build command: `npm install`
5. Run command: `npm start`
6. Variables: `DISCORD_TOKEN`, `PREFIX`, `MENU_API_TOKEN`
7. Deploy y usa la URL publica de Koyeb para el menu:
   - `https://TU-SERVICIO.koyeb.app/api/v1`

## Panel remoto (movil)

URL del panel web:

- `https://TU-DOMINIO/panel`

Flujo para clientes:

1. Abrir FiveM + external en la PC y hacer login con la key.
2. En el movil, abrir `/panel` e introducir la misma key.
3. El panel muestra todas las opciones del menu y permite guardar/cargar configs.

Endpoints del relay:

- `POST /api/panel/client/register` (external)
- `POST /api/panel/client/sync` (external, cada ~750ms)
- `POST /api/panel/web/login` (panel movil)
- `GET /api/panel/web/status` (panel movil)
- `POST /api/panel/web/command` (panel movil)

## Persistencia (importante en Render)

Las keys se guardan en `data/keys.json` **dentro de la carpeta persistente**.

En Render, el disco efimero borra todo al redeploy. Para que **las keys no se reinicien**:

1. En Render → tu servicio → **Disks** → Add disk (1 GB) montado en `/var/data`.
2. Variables de entorno:
   - `PERSISTENT_DATA_DIR=/var/data/falcao-external`
   - `REQUIRE_PERSISTENT_DATA=1` (opcional: evita arrancar con DB vacia si falla el disco)
3. Redeploy una vez con el disco montado.

El bot hace copias automaticas en `data/backups/` cada 6 horas y restaura desde `.bak` o backups si `keys.json` se corrompe.

Tambien puedes usar `render.yaml` de este repo (Blueprint) que ya declara el disco persistente.
