# Harvis Lite

Agente personal local para Windows, macOS y Linux. Toma como referencia la
experiencia operativa de OpenClaw —configuración guiada, canales, skills y
herramientas— con consola y servicio locales en Node.js, sin gateway de red ni
Docker. Incluye proveedores compatibles con OpenAI, WhatsApp,
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
npm start
```

`npm start` comprueba e instala automáticamente las dependencias de la
aplicación, incluido WhatsApp, y descarga el modelo local de transcripción antes
de abrir el asistente de primer inicio. Para instalar sin iniciar el agente,
ejecuta `npm run install:agent`; también descarga el modelo. En
Windows puedes usar `instalar-harvis.bat`. En Windows también puedes ejecutar
`iniciar-harvis.bat`, que realiza la misma comprobación al iniciar. En la primera
ejecución interactiva, Harvis pide primero el nombre y luego abre el asistente
QuickStart / Manual setup; en las siguientes, usa `/configure` para volver a
abrir los menús. Ejecuta `/help` para ver todos los comandos. En una ejecución
sin terminal interactiva, `HARVIS_AGENT_NAME` permite indicar el nombre inicial;
si no está definida, se usa `Harvis`.

Las respuestas de voz de WhatsApp están desactivadas por defecto. Actívalas o
desactívalas desde la consola con `/voz on`, `/voz off` o `/voz estado`; el
administrador también puede enviar esos comandos desde WhatsApp. El agente
puede cambiar el ajuste cuando el administrador se lo pida explícitamente.
Cuando están activas, Harvis envía el texto de las respuestas de WhatsApp a
Edge TTS para generar un MP3 y responde solo con ese audio. El audio usa una
reformulación oral y breve. Si falla la reformulación o la síntesis, Harvis envía
la respuesta escrita como respaldo. Requiere conexión a Internet.
Los mensajes de voz entrantes de WhatsApp se transcriben automáticamente con
Whisper Tiny local y se entregan como texto al agente principal o al subbot de
clientes. El modelo (aprox. 75 MB) se descarga durante la instalación en
`models/` junto a `package.json`, de modo que los audios puedan transcribirse sin
esperar a que baje el modelo. Los mensajes de WhatsApp entrantes se procesan
secuencialmente en el orden recibido, incluidos textos y audios. Se aceptan
audios de hasta 16 MB y 5 minutos.

El perfil de trabajo final está en `Documents/<nombre del agente>_WorkDir`; el
nombre es el que se elige durante la primera configuración. Su estructura es:

```text
<nombre del agente>_WorkDir/
├── config/   configuración, credenciales, skills, canales y módulos
└── files/    notas, documentos e inbox de canales
```

En una instalación nueva, Harvis pide primero el nombre del agente y crea
directamente esa carpeta de trabajo antes de continuar con el asistente. No
crea un perfil provisional. Si encuentra un perfil antiguo de Harvis Lite, lo
migra a `config/`; si encuentra `Documents/Harvis_WorkDir`, pasa su contenido a
la estructura final y elimina esa carpeta después de guardar el perfil.

## Configuración

En una instalación nueva se inicia un asistente guiado, inspirado en el flujo
de onboarding de OpenClaw:

1. Define el nombre del agente; Harvis crea en ese momento su carpeta de
   trabajo. Después elige **QuickStart** (configuración breve recomendada) o
   **Manual setup** (muestra las notas completas de seguridad).
2. Configura el proveedor, URL, modelo y API key (LM Studio, OpenAI o endpoint
   compatible). Puedes probar la conexión antes de continuar.
3. Configura uno o más canales (WhatsApp, Telegram o Discord). Las dependencias
   de WhatsApp ya quedaron instaladas por el paso previo; el asistente puede
   solicitar el número administrador y mostrar el QR. Para Telegram o Discord,
   Harvis instala sus paquetes cuando los eliges y solicita el token del bot.
4. Crea una skill Markdown local o instala una publicada en npm.
5. Elige si habilitar la herramienta integrada para generar PDFs de texto.
   Después configura búsqueda web y scraping, confirma MCP local por stdio y
   revisa el resumen. No hay paso de gateway de red. Al terminar, los canales se
   inician como servicio local en segundo plano.

El nombre elegido se utiliza como identidad del asistente en la consola: en el
encabezado de las respuestas, el indicador de actividad, los menús y los
mensajes de inicio. Puedes cambiar el nombre visible en **/configure > Perfil
del agente**; la carpeta conserva el nombre elegido durante la primera
configuración.

Al configurar LM Studio, Harvis consulta primero `GET /api/v1/models`, que
devuelve los modelos instalados, y muestra los modelos de tipo LLM usando su
identificador `key`. Si el servidor no ofrece la API nativa, prueba el endpoint
compatible `GET /v1/models`. Para otros proveedores compatibles consulta
`/models` bajo la URL configurada. Cada consulta de modelos tiene un límite de
20 segundos. La última opción permite introducir el ID manualmente; los errores
de conexión o autenticación se informan. Para chat,
si la URL de LM Studio es solo el host o termina en `/api/v1`, Harvis la
normaliza al endpoint compatible `/v1/chat/completions`. Las respuestas del
agente usan el límite de salida configurado, que por defecto es 30000 tokens; la
prueba de conexión solicita hasta 1000. Los perfiles con los límites
predeterminados anteriores de 1000, 1024 o 4096 tokens se actualizan
automáticamente a 30000. La salida real también depende del espacio libre en la
ventana de contexto configurada para el modelo. Las solicitudes de chat y la prueba de conexión esperan hasta 10 minutos
para permitir que un modelo cargue y responda.
El contexto se estima con una ventana predeterminada de 32768 tokens compartida
por el agente principal y el subbot. Antes de cada solicitud, Harvis descarta
turnos antiguos si es necesario y reduce resultados largos de herramientas; el
contexto reserva un mínimo para responder y el límite de salida se ajusta al
espacio restante. `provider.contextWindowTokens`
puede ajustarse en `config/config.json` al tamaño configurado en el servidor del
modelo. Si el servidor del modelo tiene una ventana menor que la configurada en
Harvis, reduce este valor para que ambos límites coincidan.

`/configure` abre las secciones **Modelo / autenticación**, **Canales**,
**Skills**, **Perfil del agente**, **Búsqueda web y scraping**, **Creación de
archivos PDF**, **MCP local**, **Instrucciones para clientes** y **Números
ignorados**. PDFKit genera PDFs de texto en la carpeta `files`; la herramienta
está deshabilitada hasta que la habilites durante el onboarding o desde
`/configure pdf on`. También puedes deshabilitarla con `/configure pdf off`.
Los cambios hechos desde la consola requieren `/restart`; el administrador
también puede pedirle al agente que habilite o deshabilite la herramienta, y el
canal aplica el cambio inmediatamente. El asistente de
proveedor ofrece LM Studio, OpenAI y un endpoint personalizado. También se
admiten comandos directos:

```text
/configure provider url http://127.0.0.1:1234/v1
/configure provider model <id-del-modelo>
/configure provider api-key <clave>
/configure web provider <duckduckgo|brave|off>
/configure web api-key <clave>
/configure web scrape on|off
/configure pdf on|off
```

Para proveedores remotos, configura su URL compatible con OpenAI, modelo y API
key. Las variables `OPENAI_BASE_URL`, `OPENAI_MODEL` y `OPENAI_API_KEY`
prevalecen sobre los valores del perfil. `/models` consulta el endpoint
configurado. Los tokens de Telegram y Discord también pueden proporcionarse con
`HARVIS_TELEGRAM_BOT_TOKEN` y `HARVIS_DISCORD_BOT_TOKEN`; la clave de Brave
admite `HARVIS_BRAVE_SEARCH_API_KEY`.

La búsqueda está disponible como herramienta `web_search` del agente. DuckDuckGo
no requiere cuenta ni clave; Brave requiere una API key que también puede
proporcionarse con `HARVIS_BRAVE_SEARCH_API_KEY`. La herramienta
`web_scrape` extrae texto de una URL pública, no ejecuta scripts y limita cada
descarga a 2 MB. Solo permite HTTP/HTTPS, rechaza hosts e IP privados y vuelve
a validar cada destino de redirección. La resolución DNS y cada descarga tienen
un límite de 10 segundos; se permiten hasta tres redirecciones (cuatro
solicitudes como máximo). Las búsquedas esperan hasta 15 segundos. Los cambios
en herramientas web se aplican al ejecutar `/restart`.

## Canales

El instalador prepara las dependencias base y WhatsApp antes del primer inicio.
La configuración del canal se mantiene en el onboarding o en **Configurar >
Canales**. Telegram, Discord y los canales npm externos siguen instalándose a
petición:

| Canal | Paquete instalado | Configuración |
| --- | --- | --- |
| WhatsApp | `baileys` y `qrcode-terminal` (incluidos en el instalador de Harvis) | Configura el número administrador y vincula con QR durante el primer inicio o desde Canales |
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

`config/Instrucciones.txt` contiene las instrucciones del subbot en lenguaje
natural. `config/Ignore.txt` contiene los números excluidos, uno por línea en
formato internacional E.164; esos contactos no reciben respuesta. La consola
permite consultar y actualizar ambos archivos:

```text
/configure instructions show
/configure instructions set <texto para compartir con clientes>
/configure ignore list
/configure ignore add <+código-país-número>
/configure ignore remove <+código-país-número>
```

El administrador también puede solicitar esas operaciones por los canales
autorizados; los cambios de instrucciones se aplican a los siguientes mensajes.
Durante la primera configuración se crea `config/contacts.txt` con una nota de
uso. Añade ahí los contactos privados en formato E.164, separados por coma
(si existe un contacto técnico antiguo dentro de `Instrucciones.txt`, se migra a
este archivo):

```text
Técnico: +14155552671, Vendedor: +14155552672
```

El agente principal puede consultar y modificar ese archivo con las herramientas
`read_contacts` y `write_contacts`, y enviar mensajes a una etiqueta mediante
`send_contact_message`. Si el administrador indica un número de cliente y pide
expresamente iniciar una conversación —por ejemplo, para comunicar una oferta o
un descuento— puede usar `send_whatsapp_message`. No inicia envíos por iniciativa
propia. Cuando el subbot no encuentra una respuesta en
`Instrucciones.txt`, selecciona la etiqueta más adecuada según el tema de la
consulta y avisa a ese contacto con el número del cliente y su pregunta. El
subbot solo recibe las etiquetas disponibles; nunca recibe los números de
`contacts.txt` ni los revela a clientes.

### Archivos del administrador

El administrador puede listar, leer, crear, reemplazar, eliminar y enviar
archivos dentro de `Documents/<nombre-del-agente>_WorkDir/files`. El agente puede
crear allí apuntes, notas, recordatorios y archivos temporales por iniciativa
propia cuando conservar esa información pueda ayudar con solicitudes futuras.
Debe evitar duplicados, no sobrescribir notas existentes salvo que se lo pidan y
no guardar credenciales ni datos sensibles innecesarios. Los recordatorios son
notas persistentes para consultar después; no generan avisos automáticos.
Todas las herramientas (`list_files`,
`read_file`, `write_file`, `create_pdf`, `delete_file` y `send_file`) usan como raíz la carpeta
`files`; sus rutas son relativas a ella (por ejemplo `informe.txt`, no
`files/informe.txt`). Los adjuntos de administradores recibidos por WhatsApp,
Telegram y Discord se guardan respectivamente en `files/inbox/whatsapp`,
`files/inbox/telegram` y `files/inbox/discord`, y quedan disponibles para lectura
y envío mediante su ruta relativa. `send_file` responde por el canal en que se
solicitó. Los adjuntos enviados por clientes de WhatsApp se rechazan antes de
descargarse. Las rutas no pueden salir de `files/`; las herramientas no eliminan
carpetas, y `write_file` crea las subcarpetas necesarias dentro de `files/`.
Cuando la creación PDF está habilitada, `create_pdf` genera un documento de
texto de varias páginas en esa misma carpeta. El agente puede enviarlo con
`send_file` cuando el administrador lo solicite expresamente.

`config/soul.md` contiene la personalidad del agente principal. Puede leerlo,
pero solo lo modifica si el administrador pide explícitamente cambiar su
personalidad o ese archivo. El agente tampoco modifica `config.json`, canales,
skills, credenciales, instrucciones, contactos ni otros ajustes salvo petición
explícita del administrador. Puede guardar notas y otros archivos de trabajo
por iniciativa propia dentro de `files`; enviar archivos requiere una petición
expresa del administrador. `config/Instrucciones.txt` pertenece exclusivamente
al subbot de atención a clientes: el agente principal no la usa como notas ni
como directrices propias, y solo la lee o modifica cuando el administrador se
lo pide explícitamente. El subbot responde con cordialidad y respeto. En perfiles
nuevos, las instrucciones predeterminadas establecen que es un subagente para
informar sobre los productos y servicios de la empresa. Si no puede resolver una
petición con la información disponible, deriva la consulta y el número del
cliente al trabajador pertinente según la etiqueta configurada en `contacts.txt`
(por ejemplo Técnico, Vendedor o Atención al cliente). El subbot recibe solo las
etiquetas; el sistema resuelve el número en privado. Si no hay un contacto
pertinente o falla el envío, no afirma que la consulta fue derivada. Al iniciar,
Harvis agrega estas instrucciones a perfiles nuevos y a los perfiles existentes
que todavía tengan `Instrucciones.txt` vacío; conserva las instrucciones
personalizadas que ya tengan contenido.

Se admiten archivos de texto de hasta 1 MB, PDF/DOCX e imágenes de hasta 12 MB;
las transferencias de archivos por WhatsApp, Telegram y Discord tienen un límite
de 16 MB. La extracción de PDF
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
no arrancará automáticamente. En macOS el inicio automático no está
implementado; el servicio se puede iniciar manualmente con `/start`.

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
/configure pdf on
/configure pdf off
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
red. Completa primero la configuración con `npm start`; después puedes iniciarlo
con:

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
| `/memory clear` | Borrar el historial de conversación en memoria del agente y el subbot |
| `/start` | Iniciar el servicio y habilitar inicio automático |
| `/stop` | Detener el servicio (conserva la tarea de inicio) |
| `/restart` | Recargar configuración y canales |
| `/quit` | Cerrar solo la consola; el servicio continúa |

`/status` muestra el estado del servicio, los canales y si el proveedor y el
modelo están configurados, pero no imprime la URL, el ID del modelo ni las
credenciales.

`/memory clear` borra el historial de conversación temporal de todas las sesiones
del agente principal y del subbot. No elimina archivos, configuración ni memoria
guardada manualmente en la carpeta de trabajo.

## Autores

- Cryzet (autor del proyecto)
- Copilot (asistente de desarrollo)

## Pruebas

```powershell
npm test
```
