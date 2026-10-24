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

El perfil de esta versión se guarda en `%APPDATA%\HarvisLite` en Windows o
`$XDG_CONFIG_HOME/harvis-lite` en macOS/Linux. La variable `HARVIS_HOME` permite
elegir otra ruta. El perfil está separado del perfil antiguo de Harvis, por lo
que no reutiliza su configuración ni sus credenciales.

## Configuración

En una instalación nueva se inicia un asistente guiado, inspirado en el flujo
de onboarding de OpenClaw:

1. Elige **QuickStart** (configuración breve recomendada) o **Manual setup**
   (muestra las notas completas de seguridad) y define el nombre del agente.
2. Configura el proveedor, URL, modelo y API key (LM Studio, OpenAI o endpoint
   compatible). Puedes probar la conexión antes de continuar.
3. Instala y configura uno o más canales (WhatsApp, Telegram o Discord).
   WhatsApp muestra el QR en la terminal inmediatamente después de instalarlo;
   escanéalo antes de continuar con el resto del asistente.
4. Crea una skill Markdown local o instala una publicada en npm.
5. Configura búsqueda en tiempo real con DuckDuckGo (sin API key) o Brave Search
   (requiere API key), y habilita o deshabilita la extracción de páginas web.
   Después confirma MCP local por stdio y revisa el resumen. No hay paso de
   gateway de red. Al terminar, los canales se inician como servicio local en
   segundo plano.

El nombre elegido se utiliza como identidad del asistente en la consola: en el
encabezado de las respuestas, el indicador de actividad, los menús y los
mensajes de inicio. Puedes cambiarlo en **/configure > Perfil del agente**.

Al configurar LM Studio, Harvis consulta primero `GET /api/v1/models`, que
devuelve los modelos instalados, y muestra los modelos de tipo LLM usando su
identificador `key`. Si el servidor no ofrece la API nativa, prueba el endpoint
compatible `GET /v1/models`. Para otros proveedores compatibles consulta
`/models` bajo la URL configurada. La última opción permite introducir el ID
manualmente; los errores de conexión o autenticación se informan. Para chat,
si la URL de LM Studio es solo el host o termina en `/api/v1`, Harvis la
normaliza al endpoint compatible `/v1/chat/completions`. La prueba de conexión
espera hasta 120 segundos para permitir que un modelo local termine de cargar
y permite hasta 512 tokens de salida, para que los modelos con razonamiento
interno tengan espacio para producir la respuesta final.

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
| WhatsApp | `baileys` y `qrcode-terminal` | Al instalar se configura un número permitido en formato internacional y se muestra el QR de vinculación en la terminal |
| Telegram | `grammy` | Token de bot y autorización de usuarios por ID |
| Discord | `discord.js` | Token de bot y autorización de usuarios por ID |

### Archivos por WhatsApp

Harvis puede recibir adjuntos y guardarlos en `~/HarvisFiles/inbox`, así como
listar, leer, crear, reemplazar, eliminar y enviar archivos dentro de la carpeta
personal del usuario. Cada acceso o cambio requiere una aprobación individual:
Harvis envía por WhatsApp la acción y un código de seis dígitos; responde
`/aprobar <código>` o `/rechazar <código>`. El código vence en tres minutos.
Las operaciones solicitadas desde la consola muestran una confirmación local.
Sin un canal disponible para pedir autorización, la operación se rechaza.

El acceso no puede salir de la carpeta personal, no elimina carpetas y no crea
carpetas arbitrarias al escribir. Se admiten archivos de texto de hasta 1 MB,
PDF/DOCX y archivos de imagen de hasta 12 MB; las transferencias de WhatsApp
tienen un límite de 16 MB. La extracción de PDF requiere Node.js 20.16+ o
22.3+. La lectura de imágenes requiere un modelo con soporte de visión. Los PDF
escaneados sin capa de texto requieren OCR y no se procesan. Los archivos
recibidos se guardan después de aprobar su recepción; leerlos, modificarlos,
eliminarlos o reenviarlos requiere una aprobación aparte.

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
terminal. El acceso queda limitado al teléfono configurado durante la
instalación; se requiere un número internacional E.164 con `+` y código de país
(por ejemplo `+14155552671`). Otros remitentes se ignoran en silencio: no se
generan códigos OTP ni notificaciones de acceso. Para cambiar el remitente
permitido, usa `/configure channel whatsapp number <+código-país-número>`.
La API de control del servicio es autenticada, escucha únicamente en
`127.0.0.1`, no ofrece páginas web y no expone un gateway en la red ni cambia
el transporte MCP stdio. Las instalaciones de paquetes npm se autorizan desde
la consola interactiva. El registro del servicio se guarda en `service.log`
dentro del perfil local.

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

Los canales npm externos pueden instalarse mediante el menú. El paquete debe
exportar `createChannel(config)` y devolver un adaptador con
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
