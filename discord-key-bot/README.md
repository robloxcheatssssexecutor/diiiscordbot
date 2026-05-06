# Discord Key Bot (simple)

Bot para generar y gestionar keys desde Discord, con API HTTP para validar primer login desde el menu.

## Comandos

Todos con prefijo `!` por defecto:

- `!keygen <duracion_en_dias>`
- `!keylist`
- `!keycheck <key>`
- `!keydel <key>`
- `!resethwid <key>`
- `!falcaohelp`

Solo funcionan para IDs incluidos en `ADMIN_IDS`.

## Formato de key

- `FALCAO-EXTERNAL-XXXXX-XXXXX` (`X` = letras y numeros random).

## Variables `.env`

Crea un archivo `.env` usando `.env.example`:

- `DISCORD_TOKEN`: token del bot (Discord Developer Portal -> Bot -> Token)
- `PREFIX`: prefijo de comandos (ej. `!`)
- `ADMIN_IDS`: IDs de usuarios admin separadas por coma
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

- `https://TU-APP-DISCLOUD-DOMAIN/api/v1`

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
6. Variables: `DISCORD_TOKEN`, `ADMIN_IDS`, `PREFIX`, `MENU_API_TOKEN`
7. Deploy y usa la URL publica de Koyeb para el menu:
   - `https://TU-SERVICIO.koyeb.app/api/v1`

## Persistencia

Las keys se guardan en `data/keys.json`.
