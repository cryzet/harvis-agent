# Harvis Lite

Agente personal local para Windows, macOS y Linux. Toma como referencia la
experiencia operativa de OpenClaw —configuración guiada, canales, skills y
herramientas— con un único proceso Node.js, sin gateway de red ni Docker.
Incluye consola interactiva, proveedores compatibles con OpenAI, WhatsApp,
Telegram, Discord, skills Markdown y servidor MCP local por stdio.

Harvis Lite es una implementación independiente; no carga plugins de OpenClaw,
que requieren el host OpenClaw. Los adaptadores de mensajería usan bibliotecas
propias de cada plataforma. Referencias de diseño: [arquitectura de OpenClaw](https://docs.openclaw.ai/concepts/architecture),
[ciclo del agente](https://docs.openclaw.ai/concepts/agent-loop),
[canales](https://docs.openclaw.ai/channels) y
[skills](https://docs.openclaw.ai/tools/skills). OpenClaw publica su código bajo
MIT; este proyecto no incluye código fuente copiado de OpenClaw.

## Requisitos e inicio

- Node.js 20 o superior.
- Un modelo compatible con la API Chat Completions de OpenAI (por ejemplo,
  LM Studio local).

```powershell
npm install
npm start
```

En Windows también puedes ejecutar `iniciar-harvis.bat`. En la primera
ejecución aparece el asistente QuickStart / Manual setup; en las siguientes,
usa `/configure` para volver a abrir los menús. Ejecuta `/help` para ver todos
los comandos.

Los datos se guardan juntos en `Documents/<nombre del agente>_WorkDir`, donde
el nombre corresponde al elegido durante la primera configuración. `config/`
contiene el perfil, las credenciales, skills, módulos y canales instalados;
`files/` contiene archivos del usuario, temporales y el inbox de WhatsApp.
`HARVIS_HOME` permite elegir otra carpeta de trabajo. En el primer inicio, los
perfiles anteriores de Harvis Lite y los archivos de `Harvis_WorkDir` se copian
a la nueva estructura.

## Configuración

En una instalación nueva se inicia un asistente guiado, inspirado en el flujo
de onboarding de OpenClaw:

1. Elige **QuickStart** (configuración breve recomendada) o **Manual setup**
   (muestra las notas completas de seguridad) y define el nombre del agente.
2. Configura el proveedor, URL, modelo y API key (LM Studio, OpenAI o endpoint
   compatible). Puedes probar la conexión antes de continuar.
3. Instala uno o más canales (WhatsApp, Telegram o Discord). Después de cada
   instalación, Harvis pregunta si quieres vincular o configurar el canal en ese
   momento. WhatsApp solicita el número administrador y muestra el QR si aceptas;
   Telegram y Discord solicitan el token del bot.
4. Crea una skill Markdown local o instala una publicada en npm.
5. Configura búsqueda en tiempo real con DuckDuckGo (sin API key) o Brave Search
   (requiere API key), y habilita o deshabilita la extracción de páginas web.
   Después confirma MCP local por stdio y revisa el resumen. No hay paso de
   gateway de red. Al terminar, los canales se inician como servicio local en
   segundo plano.

El nombre elegido se utiliza como identidad del asistente en la consola: en el
encabezado de las respuestas, el indicador de actividad, los menús y los
mensajes de inicio. Puedes cambiar el nombre visible en **/configure > Perfil
del agente**; la carpeta conserva el nombre elegido durante la primera
configuración.

Al configurar LM Studio, Harvis consulta primero `GET /api/v1/models`, que
devuelve los modelos instalados, y muestra los modelos de tipo LLM usando su
identificador `key`. Si el servidor no ofrece la API nativa, prueba el endpoint
compatible `GET /v1/models`. Para otros proveedores compatibles consulta
`/models` bajo la URL configurada. La última opción permite introducir el ID
manualmente; los errores de conexión o autenticación se informan. Para chat,
si la URL de LM Studio es solo el host o termina en `/api/v1`, Harvis la
normaliza al endpoint compatible `/v1/chat/completions`. Las respuestas del
agente y la prueba de conexión permiten hasta 1000 tokens de salida. Cada
solicitud al proveedor espera hasta 10 minutos, para permitir que un modelo local
termine de cargar y generar su respuesta. Los perfiles que usaban el límite
predeterminado anterior de 1024 tokens se actualizan automáticamente a 1000.

`/configure` abre el menú de secciones **Modelo / autenticación**, **Canales**,
**Skills**, **Perfil del agente**, **Búsqueda web y scraping** y **MCP local**,
con submenús de instalación, credenciales y permisos. El asistente de proveedor
ofrece LM Studio, OpenAI y un endpoint personalizado. También se admiten
comandos directos:

```text
/configure provider url http://127.0.0.1:1234/v1
/configure provider model <id-del-modelo>
/configure provider api-key <clave>
/configure web provider <duckduckgo|brave|off>
/configure web api-key <clave>
/configure web scrape on|off
```

Para proveedores remotos, configura su URL compatible con OpenAI, modelo y API
key. Las variables `OPENAI_BASE_URL`, `OPENAI_MODEL` y `OPENAI_API_KEY`
prevalecen sobre los valores del perfil. `/models` consulta el endpoint
configurado.

La búsqueda está disponible como herramienta `web_search` del agente. DuckDuckGo
no requiere cuenta ni clave; Brave requiere una API key que también puede
proporcionarse con `HARVIS_BRAVE_SEARCH_API_KEY`. La herramienta
`web_scrape` extrae texto de una URL pública, no ejecuta scripts y limita cada
descarga a 2 MB y 10 segundos, con un máximo de cuatro solicitudes por
redirecciones. Solo permite HTTP/HTTPS,
rechaza hosts/IP privados y vuelve a validar cada destino de redirección. Los
cambios en herramientas web se aplican al ejecutar `/restart`.

## Canales

Los canales se instalan a petición desde **Configurar > Canales**; sus
dependencias no forman parte de la instalación básica:

| Canal | Paquete instalado | Configuración |
| --- | --- | --- |
| WhatsApp | `baileys` y `qrcode-terminal` | Tras instalar, puedes configurar el número administrador y vincular con QR |
| Telegram | `grammy` | Tras instalar, puedes guardar el token del bot y conectar |
| Discord | `discord.js` | Tras instalar, puedes guardar el token del bot y conectar |

### Administrador y atención a clientes

El número internacional configurado para WhatsApp (`/configure channel
whatsapp number <+código-país-número>`) es el administrador: conserva el acceso
completo a las herramientas y puede gestionar archivos sin OTP por operación.
Los usuarios autorizados de Telegram/Discord y la consola también se consideran
administradores. Otros números de WhatsApp reciben respuestas de un agente
aislado, sin herramientas, limitado a la información de `Instrucciones.txt`.
Sus conversaciones se mantienen separadas por número y tienen un historial
corto. Si las instrucciones están vacías, reciben una respuesta genérica.
Los adjuntos de clientes se rechazan antes de descargarse.

`config/Instrucciones.txt` y `config/Ignore.txt` se crean en el perfil local de Harvis. Los
números de `Ignore.txt` se escriben en formato internacional E.164, uno por
línea; esos contactos no reciben respuesta. La consola permite consultar y
actualizar ambos archivos:

```text
/configure instructions show
/configure instructions set <texto para compartir con clientes>
/configure ignore list
/configure ignore add <+código-país-número>
/configure ignore remove <+código-país-número>
```

El administrador también puede solicitar esas operaciones por los canales
autorizados; los cambios de instrucciones se aplican a los siguientes mensajes.

### Archivos del administrador

El administrador puede listar, leer, crear, reemplazar, eliminar y enviar
archivos dentro de `Documents/<nombre-del-agente>_WorkDir/files`. El agente puede
crear notas allí sin pedir confirmación. Los adjuntos recibidos por WhatsApp se
guardan en `files/WhatsApp-Inbox` y el agente puede leerlos para responder. No
se descargan adjuntos enviados por clientes y las rutas no pueden salir de
`files/`. Las herramientas no eliminan carpetas ni crean carpetas arbitrarias.

`config/soul.md` contiene la personalidad del agente principal. El administrador
puede pedirle que la lea o la modifique. `config/Instrucciones.txt` pertenece
exclusivamente al subbot de atención a clientes: el agente principal solo lo
consulta o modifica cuando el administrador se lo pide, y no lo usa como notas
ni como directrices propias.

Se admiten archivos de texto de hasta 1 MB, PDF/DOCX e imágenes de hasta 12 MB;
las transferencias de WhatsApp tienen un límite de 16 MB. La extracción de PDF
requiere Node.js 20.16+ o 22.3+. La lectura de imágenes requiere un modelo con
soporte de visión. Los PDF escaneados sin capa de texto requieren OCR y no se
procesan.

## Servicio en segundo plano

Al completar el onboarding, Harvis ejecuta los canales en un proceso separado
de la consola. En Windows solicita autorización UAC únicamente para registrar
una tarea del usuario actual en el Programador de tareas; la tarea ejecuta Harvis
con permisos normales, no como administrador. En Linux habilita una unidad
`systemd --user` para iniciar al iniciar sesión. Si se rechaza la autorización o
falla el registro, el servicio puede iniciarse manualmente y Harvis explica que
no arrancará automáticamente.

`/start` inicia el servicio y habilita el inicio automático; `/stop` detiene el
servicio sin borrar esa configuración. `/restart` lo reinicia y `/quit` cierra
solo la consola. Para vincular WhatsApp más tarde, usa
`/configure channel whatsapp link`; el QR se muestra directamente en la
terminal. El acceso administrativo queda limitado al teléfono configurado
durante la instalación; se requiere un número internacional E.164 con `+` y código de país
(por ejemplo `+14155552671`). Otros remitentes no incluidos en `Ignore.txt`
reciben atención limitada a `Instrucciones.txt`; no se generan códigos OTP ni
notificaciones de acceso. Para cambiar el número administrador
permitido, usa `/configure channel whatsapp number <+código-país-número>`.
La API de control del servicio es autenticada, escucha únicamente en
`127.0.0.1`, no ofrece páginas web y no expone un gateway en la red ni cambia
el transporte MCP stdio. Las instalaciones de paquetes npm se autorizan desde
la consola interactiva. El registro del servicio se guarda en `service.log`
dentro de `config/`.

También están disponibles los comandos:

```text
/configure channel install whatsapp
/configure channel whatsapp number +14155552671
/configure channel whatsapp link
/configure channel install telegram
/configure channel install discord
/configure channel telegram token <token>
/configure channel discord token <token>
/configure channel <tipo> allow <id>
/configure channel <tipo> on
/configure channel <tipo> off
```

Para Telegram, crea un bot con `@BotFather`. Para Discord, crea una aplicación
y un bot en el Developer Portal, habilita el intent de contenido de mensajes
si se usará en servidores y concede los permisos necesarios. En Telegram y
Discord, al llegar un mensaje de un usuario no autorizado, Harvis informa su ID
localmente; autorízalo con el comando `allow` correspondiente. WhatsApp usa
exclusivamente la allowlist de números internacionales configurada arriba. Los
tokens se guardan en el perfil local y no se muestran en el estado.

Los canales npm externos pueden instalarse mediante el menú. Después de
instalarlos, Harvis pregunta si quieres activarlos y conectarlos de inmediato.
El paquete debe exportar `createChannel(config)` y devolver un adaptador con
`start({ onMessage })` y `stop()`. La instalación npm requiere confirmación.
Harvis no puede cargar directamente paquetes `@openclaw/*` que dependan del
host OpenClaw.

## Skills

Una skill es una carpeta del perfil que contiene `SKILL.md`. El menú **Skills**
permite listar, crear, instalar, habilitar y deshabilitar skills:

```text
/configure skill create <nombre> <instrucciones>
/configure skill install <paquete-npm>
/configure skill <nombre> on
/configure skill <nombre> off
```

Los paquetes npm deben incluir `SKILL.md`. Como npm puede ejecutar scripts, cada
instalación solicita autorización. Las skills instaladas aportan instrucciones
al agente; el runtime no ejecuta el código del paquete como herramienta.

## MCP local

El servidor Model Context Protocol usa el transporte stdio; no abre un puerto de
red. Inícialo con:

```powershell
npm run mcp
```

Ejemplo de configuración para un cliente MCP:

```json
{
  "mcpServers": {
    "harvis": {
      "command": "node",
      "args": ["C:\\ruta\\a\\harvis-agent\\src\\mcp-server.js"]
    }
  }
}
```

Ofrece herramientas acotadas para estado, canales y skills, además de búsqueda
web y extracción segura de páginas cuando están habilitadas; stdout queda
reservado para el protocolo. No expone ejecución de shell ni acceso general al
sistema de archivos.

## Comandos

| Comando | Acción |
| --- | --- |
| `/help` | Mostrar ayuda |
| `/configure` | Abrir el menú interactivo |
| `/status` | Ver estado del agente |
| `/models` | Consultar modelos disponibles |
| `/channels` | Ver canales y estado |
| `/skills` | Ver skills y estado |
| `/start` | Iniciar el servicio y habilitar inicio automático |
| `/stop` | Detener el servicio (conserva la tarea de inicio) |
| `/restart` | Recargar configuración y canales |
| `/quit` | Cerrar solo la consola; el servicio continúa |

`/status` muestra el estado y si el proveedor está configurado, pero no imprime
la URL, el ID del modelo ni las credenciales.

## Autores

- Bryan (autor del proyecto)
- Copilot (asistente de desarrollo)

## Pruebas

```powershell
npm test
```
