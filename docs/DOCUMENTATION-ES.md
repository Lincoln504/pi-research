# Documentación de pi-research (ES)

Este documento reúne en un solo archivo toda la documentación oficial de
**pi-research** — el motor de investigación web multiagente y almacén de conocimiento
gratuito e ilimitado para agentes — traducida al español (español de México, registro
formal de negocios). Agrupa, en orden, los seis documentos oficiales que en inglés existen
por separado:

1. [Extensión de Pi](#pi-extension)
2. [Habilidad de agente (Agent Skill)](#agent-skill)
3. [SDK](#sdk)
4. [Almacén de conocimiento](#knowledge-store)
5. [Configuración](#configuration)
6. [Arquitectura](#architecture)

Los originales en inglés viven en el directorio
[`docs/`](https://github.com/Lincoln504/pi-research/tree/main/docs) del repositorio; esta
versión los combina para lectura continua en un solo documento. Los identificadores
técnicos — variables de entorno, comandos, rutas, nombres de funciones y valores literales
de configuración — se conservan en inglés sin traducir, porque son nombres reales del
software y deben escribirse exactamente igual.

---

## Extensión de Pi {#pi-extension}

pi-research se integra como una **extensión** de
[pi](https://github.com/earendil-works/pi) (`src/index.ts`): un motor de investigación web
multiagente con una interfaz de usuario de terminal (TUI) en tiempo real, registrada
directamente dentro del proceso de pi.

### Uso

La herramienta `research` se registra automáticamente, de modo que el modelo la invoca a
partir del lenguaje natural, y la propia herramienta entiende la profundidad necesaria
(1–3) leyendo la consulta.

```bash
pi -p "investiga los últimos avances en WebAssembly"
pi -p "haz un análisis profundo del panorama del hardware de inferencia con IA"
```

También se registran tres comandos de barra diagonal (`/`):

| Comando | Descripción |
|---------|-------------|
| `/research <consulta>` | Invoca directamente la herramienta `research` a la profundidad predeterminada configurada (`PI_RESEARCH_DEFAULT_RESEARCH_DEPTH`, 1 por defecto): una ejecución en vivo normal, sin turno de LLM. No interpreta una profundidad escrita en la consulta y **no** consulta el almacén de conocimiento; use `/knowledge-store <consulta>` para una búsqueda exclusiva en el almacén. |
| `/research-config` | Abre el panel interactivo de ajustes (TUI). En hosts sin TUI (RPC, web hub, impresión, JSON, SDK) el menú no puede mostrarse, por lo que el comando explica el motivo y responde con los diagnósticos no interactivos que sí funcionan allí: `/research-config health` (estado del sistema) y `/research-config knowledge-status` (estado del almacén de conocimiento). |
| `/knowledge-store <consulta>` | Busca una consulta en el almacén de conocimiento local y devuelve una respuesta sintetizada a partir de hallazgos investigados con anterioridad. No disponible cuando el Modo de Conocimiento es `none`. El almacén gestiona su propia compactación automáticamente, así que no existe un subcomando de mantenimiento. |

![Ejecución de una investigación en vivo con el comando de barra /research](https://raw.githubusercontent.com/Lincoln504/pi-research/main/docs/media/01-slash-research.gif)

### Herramientas

La extensión registra tres herramientas:

| Herramienta | Registro |
|------|-----------|
| `research` | siempre |
| `health` | siempre |
| `research_knowledge_search` | siempre (ver nota) |

`research_knowledge_search` se registra incondicionalmente para que un cambio de Modo de
Conocimiento surta efecto sin reiniciar pi (pi no dispone de API para cancelar un registro).
Cuando `PI_RESEARCH_KNOWLEDGE_STORE_MODE` es `none`, la herramienta no se anuncia al agente
— se retira su orientación de prompt y cualquier llamada devuelve un resultado de "almacén
deshabilitado"; el comando `/knowledge-store` tampoco está disponible. El anuncio y las rutas
de lectura/escritura del almacén dependen del modo activo en ese momento, no del registro en sí.

Exclusión de herramientas: la herramienta `research` respeta una lista `excludeTools`
tomada del contexto de la sesión de pi cuando el host la envía.

### TUI

Durante una ejecución, pi-research muestra un panel de progreso en vivo:

- Franjas de investigadores — una por agente: estado, URLs extraídas, acciones realizadas.
- Animación de ondas — indicador de rastreo activo.
- Uso de tokens — tokens del modelo + costo estimado (con guardia anti-decremento).
- Destellos de estado — verde al éxito, rojo al fallo.
- Mensajes de dirección — orientación del usuario en cola y activa a mitad de ejecución.

| Tecla | Acción |
|-----|--------|
| `Escape` | Cancela la investigación activa |
| `Ctrl+C` | Con texto en el editor: solo lo borra. Con el editor vacío: cancela la ejecución (igual que `Escape`). |
| Flechas | Navegar por el menú de `/research-config` |
| `Enter` / `Espacio` | Avanzar por los valores de un ajuste |

### Configuración

Los ajustes se gestionan con `/research-config`, que edita dos capas:

- Global — archivo base `~/.pi/research/config.env` (aplica a todos los front-ends).
- Proyecto — el registro centralizado (`~/.pi/research/state/project-settings.json`),
  limitado por directorio de trabajo. Solo la profundidad y el modo de almacén de
  conocimiento tienen alcance de proyecto, de modo que un repositorio puede llevar su propia
  profundidad de investigación sin alterar su valor global.

Para configurar la extensión de pi de forma independiente de los demás front-ends, añada un
archivo de superposición opcional en `~/.pi/research/pi.env` (se apila sobre `config.env`
únicamente para la extensión de pi). El modelo completo de configuración, la precedencia y
la lista completa de variables de entorno se detallan en [Configuración](#configuration).

### Instalador de la habilidad de agente

El menú de `/research-config` puede instalar la habilidad `pi-research` en los demás
agentes de codificación detectados en esta máquina para que ejecuten investigación web a
través de la CLI, y volver a eliminarla — con una limpieza exacta, trazada mediante un
manifiesto. Consulte [Habilidad de agente](#agent-skill) para el flujo completo de
instalación.

### Ciclo de vida

- `activate` — registra comandos, herramientas, el controlador TUI e inicializa los servicios.
- `deactivate` — vacía la cola de escritura, cierra LanceDB, termina el grupo de navegadores
  y elimina el modelo de incrustaciones.
- `session_shutdown` — se ramifica según `event.reason`: `quit` dispara la limpieza de salida
  de proceso; recarga / nueva / reanudar / bifurcar limpian sin salir del proceso.

El estado de la extensión está aislado por sesión de pi, por lo que `/reload` es seguro.
## Habilidad de agente (Agent Skill) {#agent-skill}

pi-research se distribuye también como una
[Habilidad de agente](https://agentskills.io/specification) portable (Agent Skill), de modo
que cualquier agente de codificación compatible con habilidades que use el mismo modelo de
directorio `SKILL.md` — Claude, OpenAI Codex CLI y otros — pueda ejecutar investigación web
con el software pi-research.

### Instalación

¿Ya ejecuta la extensión de `pi` (`pi install npm:@lincoln504/pi-research`)? Ya tiene el
motor — instale la habilidad en sus demás agentes con `/research-config` → Instalar en
Agentes Externos (consulte [Flujo de instalación](#flujo-de-instalación)) y omita los
comandos de instalación siguientes. El paso del modelo sigue aplicándose: la habilidad se
ejecuta con su propio `PI_RESEARCH_MODEL` configurado, no con el modelo de su sesión de pi.

Para uso independiente sin pi, instale el motor globalmente y enlace la habilidad en cada
agente de codificación detectado en esta máquina:

```bash
npm install -g @lincoln504/pi-research   # el motor (deja `pi-research` en el PATH)
pi-research skill install                # enlaza la habilidad en cada agente detectado
```

En npm ≥11.19 (y npm 12) los scripts de instalación de dependencias se omiten por defecto —
y no se necesitan: better-sqlite3 13 trae binarios precompilados dentro de su propio
tarball, y el navegador sigiloso se autoabastece en su primer uso (la primera extracción
tarda unos minutos). No se requiere ninguna aprobación (consulte el
[README](https://github.com/Lincoln504/pi-research/blob/main/README.md#install)).

`skill install` solo apunta a agentes ya configurados bajo `$HOME`, nunca sobrescribe una
habilidad distinta en el mismo espacio, y registra lo que creó para que `pi-research skill
uninstall` elimine exactamente eso. Ejecute `pi-research skill status` para ver dónde quedó
instalada.

Después configure el modelo con el que se ejecutan las investigaciones — la habilidad y la
CLI independiente usan únicamente este modelo configurado explícitamente (nunca siguen el
modelo seleccionado dentro de la extensión de pi) y se niegan a arrancar sin uno:

```sh
# ~/.pi/research/config.env  (o exporte como variable de entorno)
PI_RESEARCH_MODEL=provider/model-id
```

Si usa `pi`, la clave de API proviene automáticamente de su configuración de pi
(`~/.pi/agent/auth.json`); de lo contrario defina también `PI_RESEARCH_API_KEY` (en el
mismo archivo o como variable de entorno). Consulte [Configuración](#configuration).

En Windows, ejecute `pi-research` desde `cmd` o use `pi-research.cmd`: la directiva de
ejecución predeterminada de PowerShell (`Restricted`) bloquea los shims `.ps1` de npm
("running scripts is disabled"); o ejecute una sola vez
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

![Instalando la habilidad de investigación en agentes externos](https://raw.githubusercontent.com/Lincoln504/pi-research/main/docs/media/05-agent-skill.gif)

### Cómo funciona

```
agente
  │  invoca al exterior (Bash / exec)
  ▼
run.mjs  —  lanzador sin dependencias (agent-skill/pi-research/scripts/)
  │  localiza el motor instalado, o falla rápido con indicaciones
  ▼
motor pi-research  —  la CLI (dist/cli.mjs)
  │  init → run → shutdown
  ▼
informe Markdown con citas  →  stdout  →  de vuelta al agente
```

El agente interpreta la `description` de `SKILL.md` y ejecuta el lanzador. `run.mjs` no
lleva dependencias; localiza el motor instalado (`PI_RESEARCH_BIN` apuntando a
`dist/cli.mjs` del motor, luego `PI_RESEARCH_PATH` apuntando a su directorio de paquete, y
después PATH / `node_modules` / `~/.pi/bin`) y termina con un mensaje accionable — incluidas
las ubicaciones de los archivos de configuración — si falta el paquete, un modelo o una
clave de API. Expone cuatro subcomandos: `research "<consulta>"` (investigación en vivo),
`knowledge "<consulta>"` (buscar hallazgos pasados), `knowledge-config [set <modo>]`
(mostrar/establecer el modo de almacén de conocimiento por directorio) y `status`
(inspeccionar detección/configuración).

### Flujo de instalación {#flujo-de-instalación}

El código fuente de la habilidad vive en `agent-skill/pi-research/` dentro del paquete.
Instalar significa enlazar ese directorio en la carpeta de habilidades de cada agente.

> El directorio no se llama deliberadamente `skills/`: `pi` trata un directorio `skills/`
> en la raíz del paquete como uno de sus propios recursos raíz y cargaría lo que encuentre
> allí, lo que ensombrecería la herramienta nativa de investigación de la extensión con una
> copia más lenta de sí misma ejecutada como subproceso.

Un clic (recomendado). Desde la extensión de `pi`, ejecute `/research-config` → Instalar en
Agentes Externos. El instalador:

1. Detecta qué agentes objetivo están presentes bajo `$HOME` — actualmente Claude
   (`~/.claude/skills`), OpenAI Codex CLI (`~/.codex/skills` — esta ruta no está confirmada
   por la documentación oficial de Codex; el soporte de habilidades de Codex aún está
   emergiendo) y OpenClaw (`~/.openclaw/skills`).
2. Enlaza simbólicamente `agent-skill/pi-research/` en cada agente presente, sin sobrescribir
   jamás una habilidad ajena que ya ocupe ese espacio.
3. Registra en un manifiesto lo que creó, para que Eliminar de Agentes Externos quite solo
   sus propios enlaces. Los enlaces obsoletos también se recogen al arrancar.

> **Desinstalar no elimina nada por sí solo.** El paquete incluye un script `preuninstall`,
> pero **npm 7 y versiones posteriores no ejecutan `preuninstall`** — verificado contra
> npm 11: `postinstall` se dispara, `preuninstall` no. Por lo tanto, `npm uninstall
> @lincoln504/pi-research` deja en su lugar los enlaces de la habilidad, el directorio de
> estado (`~/.pi/research/state`) y el directorio de caché (`~/.cache/pi-research`,
> incluidos los modelos de incrustación descargados). Ejecute `pi-research skill uninstall`
> **antes** de retirar el paquete para llevarse los enlaces con usted.

Independiente (sin extensión de pi). `pi-research skill install` y `pi-research skill
uninstall` hacen exactamente lo mismo desde la CLI — misma detección de agentes, mismo
manifiesto, misma garantía de no pisar una habilidad ajena — para quienes instalaron el
motor con `npm install -g` y nunca abren la extensión interactiva.

Un agente con su propia CLI de registro de habilidades puede apuntarse al directorio
distribuido en lugar de enlazarlo simbólicamente. Instale el motor y registre
`$(npm root -g)/@lincoln504/pi-research/agent-skill/pi-research` con ese agente — contiene
`SKILL.md` en su raíz, que es la disposición que estas herramientas esperan. Los agentes
que copian en lugar de enlazar recogen las actualizaciones del motor en el siguiente
`skill install`, no automáticamente.

Manual. Enlace simbólicamente el directorio en la carpeta de habilidades de cualquier agente:

| Agente | Personal | Proyecto |
|-------|----------|---------|
| Claude | `~/.claude/skills/pi-research/` | `<project>/.claude/skills/pi-research/` |
| OpenAI Codex CLI | `~/.codex/skills/pi-research/` | `<project>/.codex/skills/pi-research/` |
| OpenClaw | `~/.openclaw/skills/pi-research/` | `<workspace>/skills/pi-research/` |

### Requisitos previos

- Node.js >= 22.19.0
- `pi-research` instalado donde el lanzador pueda encontrarlo, además de un modelo
  configurado (`PI_RESEARCH_MODEL`) y una clave de API. Consulte
  [Configuración](#configuration).

```bash
npm install -g @lincoln504/pi-research
node "<skill_dir>/scripts/run.mjs" status   # verificar que el motor se detecta
```

![Verificación de estado y preparación en un solo comando](https://raw.githubusercontent.com/Lincoln504/pi-research/main/docs/media/06-health-check.gif)

Una vez instalado, pida al agente que investigue algo — su sistema de habilidades activa
pi-research automáticamente. El readme incluido en el paquete
(`agent-skill/pi-research/README.md`) y `agent-skill/pi-research/references/configuration.md`
contienen los mismos detalles para quien explore la habilidad directamente.
## SDK {#sdk}

Un SDK de investigación de alto nivel para scripts, CI y herramientas personalizadas. Para
la configuración (el modelo de capas, los ajustes de la TUI y todas las variables de
entorno) consulte [Configuración](#configuration).

### Instalación

Instálelo como dependencia de su proyecto para que las importaciones se resuelvan — incluso
si ya ejecuta la extensión de `pi`, que mantiene su propia copia privada que sus scripts no
pueden importar:

```bash
npm install @lincoln504/pi-research
```

En npm ≥11.19 (y npm 12), los scripts de instalación de dependencias se omiten por defecto.
Aquí no se necesita ninguno: better-sqlite3 13 trae binarios precompilados para todas las
plataformas compatibles y los carga en tiempo de ejecución, y el navegador sigiloso se
autoabastece en su primer uso. (El par `npm approve-scripts better-sqlite3` + `npm rebuild`
documentado por versiones anteriores reparaba better-sqlite3 12, que descargaba su binario
desde un script de instalación — 13 incluye el binario en el paquete, y en npm 12.0.2 una
aprobación no logra ejecutar un script omitido de todos modos.)

Después elija el modelo: pase `model` a `initResearchSDK`, o defina `PI_RESEARCH_MODEL`
(env o `~/.pi/research/config.env`). El SDK nunca sigue el modelo seleccionado dentro de la
extensión de pi; solo cuando no se define ninguno cae al primer modelo disponible en su
registro de pi. La clave de API proviene automáticamente de su configuración de pi
(`~/.pi/agent/auth.json`), o de la opción `apiKey` / la variable `PI_RESEARCH_API_KEY`.

`src/sdk.ts` es una biblioteca para scripts, CI y herramientas personalizadas. Se configura
desde código, no desde un archivo de superposición global — no existe `sdk.env`. Lee el
archivo base `~/.pi/research/config.env` como línea base, y todo puede sobrescribirse con
`options.config`. Pase `ignoreGlobalConfig: true` para ignorar por completo el archivo
global y ejecutarse únicamente con valores predeterminados + `process.env` + `options.config`
— autónomo y reproducible desde código.

> Requisito de tiempo de ejecución. Las exportaciones del paquete (`.` y `/sdk`) resuelven a
> código fuente TypeScript — no hay un `dist/sdk.js` transpilado. Debe ejecutarse en un
> entorno que *transforme* TypeScript, no solo que elimine tipos: el código fuente usa
> `enum` y propiedades de constructor por parámetro, que el modo de solo eliminación de
> Node (`--experimental-strip-types`, el predeterminado desde Node 23.6) rechaza con
> `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. Use uno de:
> - el host pi, que lo carga de forma nativa (vía `jiti`);
> - un cargador como `tsx` o `ts-node`.
>
> **Node puro no puede cargarlo en absoluto, con ninguna bandera.** Node se niega a eliminar
> o transformar TypeScript que viva bajo `node_modules` — como el código fuente de una
> dependencia instalada — fallando con
> `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`. Eso aplica a
> `--experimental-transform-types` exactamente igual que a `--experimental-strip-types`, así
> que ninguna bandera ayuda aquí; un cargador (o el host pi) es obligatorio.
> (`engines.node` es `>=22.19.0`.)

```typescript
import {
  initResearchSDK,
  runDeepResearch,
  runQuickResearch,
  getResearchReports,
  shutdownResearchSDK,
} from '@lincoln504/pi-research';

// 1. Inicializar (configurado enteramente en código; no requiere configuración global)
await initResearchSDK({
  model: 'openrouter/deepseek/deepseek-v4-flash', // string "provider/id" u objeto Model
  ignoreGlobalConfig: true,                       // hermético: ignora ~/.pi/research/config.env
  config: { MAX_SCRAPE_BATCHES: 4 },              // sobrescrituras de Config tipadas
});

// 2. Investigación profunda (profundidad 1–3)
const markdown = await runDeepResearch('tecnología de baterías de estado sólido', { depth: 2 });

// 3. Investigación rápida (profundidad 0)
const quick = await runQuickResearch('¿cuál es la capital de Francia?');

// 4. Recuperar los informes por investigador de la última ejecución
const reports = await getResearchReports();

// 5. Limpieza — OBLIGATORIA: vacía la cola de escritura, cierra LanceDB, termina workers
await shutdownResearchSDK();
```

`initResearchSDK` debe ejecutarse antes de cualquier llamada de investigación. La autenticación
se resuelve desde `options.apiKey` + `options.provider`, si no desde
`process.env.PI_RESEARCH_API_KEY` / `PI_RESEARCH_PROVIDER`, si no desde el `~/.pi/agent/auth.json`
de pi. Las cinco llamadas anteriores son el camino habitual; la [referencia de API](#referencia-de-api)
abajo lista cada exportación con su firma.

> Concurrencia: una única instancia inicializada del SDK ejecuta una llamada de investigación
> a la vez. Las llamadas superpuestas `runDeepResearch`/`runQuickResearch` sobre la misma
> instancia lanzan una excepción — ejecútelas secuencialmente, o use un proceso separado por
> ejecución concurrente.
>
> Los procesos separados están además limitados por un **límite de ejecuciones a nivel de
> máquina** (`PI_RESEARCH_MAX_CONCURRENT_RUNS`, predeterminado 3) que cubre todos los
> procesos pi-research del host, porque todos comparten un único grupo de navegador/incrustación
> elegido por liderazgo. Una ejecución que supera el límite hace cola hasta
> `PI_RESEARCH_RUN_ACQUIRE_TIMEOUT_MS` (predeterminado 10 min) y solo entonces rechaza con
> `ResearchRunCapacityError` — una condición temporal de "inténtelo de nuevo en breve",
> que la CLI presenta con el código de salida `75`. Proporcione un observador con
> `onRunQueued(slots, maxWaitMs)` para informar a un usuario en espera de que la ejecución
> está en cola y no colgada.

### Cancelación

`runDeepResearch`, `runQuickResearch`, `verifyUrl` y `scrapeUrl` aceptan todos un
`AbortSignal` opcional como **último argumento posicional** (no como campo del objeto de
opciones):

```js
const controller = new AbortController();
setTimeout(() => controller.abort(), 60_000);

const markdown = await runDeepResearch('…', { depth: 2 }, controller.signal);
```

El orquestador comprueba la señal en cada frontera de ronda y la propaga a la búsqueda, la
extracción y las llamadas de LLM, de modo que una cancelación detiene el trabajo en lugar de
solo desprenderse de él.

**Una cancelación no siempre rechaza.** El resultado depende de si se recopiló algo antes de
que llegara la señal:

| Estado al cancelar | Resultado | Observador |
|---|---|---|
| Se recopiló al menos un informe de investigador | **Resuelve** con una síntesis parcial construida con lo reunido | `onComplete` |
| Aún no se recopiló nada | **Rechaza** (`Research aborted` / `Research cancelled`) | `onError` |

Por lo tanto, un llamador no debe tratar "resuelto" como "se ejecutó hasta el final" cuando
él mismo canceló la ejecución — verifique su propia señal, no solo la promesa. Exactamente
uno de `onComplete` / `onError` se dispara en cualquier caso.

La CLI informa la cancelación por el código de salida, siempre: una ejecución con señal sale
en el rango de cancelación — **`128 + señal`** (`130` Ctrl-C/SIGINT, `143` SIGTERM,
`129` SIGHUP, `131` SIGQUIT) — y una cancelación programática sin señal implicada sale
`130`. Una ejecución cancelada nunca sale `0`, porque `0` significa que la investigación
tuvo éxito y un agente que lo retransmita informaría al usuario de una ejecución completada.

Que un informe *parcial* llegue a stdout antes depende de hasta dónde llegó la ejecución
antes de que aterrizara la cancelación: el manejador cancela la ejecución en curso antes de
desmontar, de modo que un orquestador que aún puede sintetizar lo reunido puede imprimir ese
material antes de la salida. Trátelo como un plus de mejor esfuerzo, no como una garantía —
el código de salida es la parte en la que puede confiar.

Trate cualquier código ≥ 128 como una cancelación; `pi-research --help` lista el conjunto
completo, y el contrato orientado al agente es la tabla de códigos de salida en
[`SKILL.md`](../agent-skill/pi-research/SKILL.md).

Estos no son deliberadamente el código `70` de error de tiempo de ejecución y nunca llevan
`retryable: true` — una cancelación es una intención completada, no una falla para reintentar.
Los códigos se derivan por señal en lugar de ser fijos porque la CLI *maneja* esas señales en
lugar de morir por ellas: un código fijo haría que el estado de salida observado dependiera
de si el manejador superó a un force-kill, mientras que `128 + N` coincide con lo que el
shell informa en ambos casos.

Aun así debe llamar a `shutdownResearchSDK()` después: cancelar una ejecución libera esa
ejecución, no el grupo de navegadores, los manejadores de LanceDB ni los procesos de worker.

El SDK no escribe archivos de informe. La exportación de informes es una preocupación del
front-end — la extensión de pi y la CLI / habilidad de agente la hacen cuando
`PI_RESEARCH_REPORT_EXPORT_ENABLED=true`.

### Referencia de API {#referencia-de-api}

Todo lo siguiente se exporta desde `@lincoln504/pi-research` y
`@lincoln504/pi-research/sdk`, salvo las dos marcadas *solo subruta sdk* — el punto de
entrada del paquete deliberadamente no las vuelve a publicar. Toda llamada excepto
`repairJson` y `getSDKContainer` exige `initResearchSDK()` primero y lanza
`SDK not initialized` de lo contrario.

**Ciclo de vida**

| Exportación | Firma | Notas |
|---|---|---|
| `initResearchSDK` | `(options?: ResearchSDKOptions) => Promise<void>` | Registra los servicios. No hace nada si ya está inicializado; espera a que termine un apagado en curso. |
| `shutdownResearchSDK` | `() => Promise<void>` | Obligatoria. Vacía la cola de escritura, cierra LanceDB, termina los procesos de worker. Limpia todos los accesores `getLast*`. |
| `getSDKContainer` | `() => ServiceContainer \| null` | *solo subruta sdk.* Superficie interna/de prueba — el contenedor de servicios vivo, o `null` antes de init. No cubierta por semver; el punto de entrada del paquete no la exporta. |

**Investigación**

| Exportación | Firma | Notas |
|---|---|---|
| `runDeepResearch` | `(query, options?, signal?) => Promise<string>` | Profundidad 1–3. Devuelve el informe Markdown. `options` es `ResearchOptions` menos los campos que posee el SDK (`ctx`, `query`, `model`, `sessionId`, `researchId`). |
| `runQuickResearch` | `(query, options?, signal?) => Promise<string>` | Profundidad 0. Igual que la anterior con `depth` fijo y, por tanto, no aceptado. |
| `runResearchDetailed` | `(query, options?, signal?) => Promise<ResearchRunResult>` | La misma ejecución que `runDeepResearch`, devolviendo `{ report, sessionId, runId, metrics, stats, reports }` en lugar de la cadena simple. |
| `getResearchReports` | `(researchId?) => Promise<Map<string, string>>` | Informes por investigador, indexados por id de investigador. Por defecto usa la ejecución más reciente; mapa vacío si no ha habido ninguna. |

**Acceso web**

| Exportación | Firma | Notas |
|---|---|---|
| `scrapeUrl` | `(url, signal?) => Promise<ScrapeResult>` | Una URL a través de todo el pipeline (filtro SSRF → fetch o navegador sigiloso → extracción PDF → Markdown). |
| `verifyUrl` | `(url, signal?) => Promise<boolean>` | Solo alcanzabilidad, sin devolver contenido. Resuelve `false` en lugar de lanzar cuando la URL está bloqueada o muerta. |

**Almacén de conocimiento**

| Exportación | Firma | Notas |
|---|---|---|
| `searchKnowledge` | `(queries: string[], signal?) => Promise<KnowledgeSearchResult>` | `{ text, found: 'yes' \| 'maybe' \| 'no', documentsSearched, citations }`. Resuelve `found: 'no'` cuando el almacén está deshabilitado, vacío o no disponible — no lanza. |
| `exportKnowledge` | `(outputPath: string) => Promise<void>` | Escribe el almacén en un archivo JSON consumible por la web. |

**Telemetría posterior a la ejecución** — todo refleja la ejecución completada más reciente,
es `null` hasta que una se completa, y se limpia con `shutdownResearchSDK()`.

| Exportación | Firma | Notas |
|---|---|---|
| `getLastRunStats` | `() => ResearchStats \| null` | Cifras principales (búsquedas, extracciones, tokens, costo) derivadas de la instantánea de la ejecución. |
| `getLastRunMetrics` | `() => IMetricsSnapshot \| null` | Los contadores/medidores/histogramas brutos de esa ejecución. |
| `getLastRunSummary` | `() => RunSummary \| null` | `{ runId, startedAt, completedAt, durationMs, status, snapshot }`. |
| `getLastErrorReport` | `() => ErrorReport \| null` | Errores agregados — totales, patrones, por dominio, por tipo. Permite que un llamador desatendido vea qué falló sin analizar registros. |
| `getLastResearcherOutcome` | `() => ResearcherOutcome \| null` | `{ planned, launched, succeeded, failed, failureReasons }`. Distingue un informe escaso por un tema disperso de uno donde la mayoría de los investigadores fallaron. |
| `getSessionMetrics` | `() => IMetricsSnapshot` | Acumulado en todas las ejecuciones desde init, en lugar de por ejecución. |
| `logRunErrorSummary` | `(report, depthLabel, status) => void` | *solo subruta sdk.* Emite una línea compacta y sin secretos para los errores registrados de una ejecución. No hace nada cuando el informe es null o vacío. |

**Estado y utilidades**

| Exportación | Firma | Notas |
|---|---|---|
| `getResearchHealth` | `(opts?: { force?: boolean }) => Promise<HealthReport>` | Ejecuta todas las verificaciones registradas. `force` omite el resultado en caché. |
| `repairJson` | `(json: string) => string` | Repara JSON de modelo truncado/malformado. Puro; utilizable antes de init. |

**Tipos** — `ResearchSDKOptions`, `ResearchRunResult`, `KnowledgeSearchResult`,
`ResearcherOutcome`, `ResearchOptions`, `ResearchObserver`, `IMetricsSnapshot`,
`IMetricHistogram`, `RunSummary` y `ResearchStats`.

**También en el punto de entrada del paquete**, para quienes quieran los orquestadores
directamente en lugar de a través del envoltorio del SDK: `DeepResearchOrchestrator`,
`QuickResearchOrchestrator`, `HeadlessObserver` (un observador que imprime el progreso en
stdout), `ServiceNames`, `shutdownManager`, `extractRunStats`, `normalizeUrl`, los accesores
de configuración `getConfig` / `setConfig` / `resetConfig` / `validateConfig`, y las
constantes de tamaño de equipo. Son de nivel más bajo que las funciones del SDK anteriores y
suponen que usted gestiona el contenedor de servicios por su cuenta.

### Opciones de init

| Opción | Descripción |
|--------|-------------|
| `model` | Cadena `"provider/id"` u objeto `Model`. Omita para usar el `PI_RESEARCH_MODEL` configurado; solo cuando no hay ninguno el SDK cae al primer modelo de pi disponible. |
| `apiKey` / `provider` | Credenciales explícitas (provider obligatorio junto con apiKey). |
| `config` | Sobrescrituras `Partial<Config>`, aplicadas sobre la base/los valores predeterminados. |
| `ignoreGlobalConfig` | Omite `config.env` por completo — solo valores predeterminados + `process.env` + `config`. |
| `cwd` | Directorio de trabajo para registros y el almacén de conocimiento. |
| `verbose` | Refleja los registros en la consola. |

Para la precedencia de configuración, las capas superpuestas por front-end y la referencia
completa de variables de entorno, consulte [Configuración](#configuration).

### APIs de estado y almacén de conocimiento

La herramienta `health` (y `getResearchHealth()` del SDK) ejecuta todas las verificaciones de
estado registradas — capacidad del navegador, tiempo de ejecución del navegador, almacén de
conocimiento y gestor de estado — y devuelve un informe estructurado:

```typescript
import { initResearchSDK, getResearchHealth } from '@lincoln504/pi-research/sdk';

await initResearchSDK();                 // obligatorio primero — lanza si no está inicializado
const result = await getResearchHealth();
// { success: boolean, status: 'healthy' | 'degraded' | 'unhealthy', components: [...] }
```

El almacén de conocimiento es un servicio interno, no una exportación pública. Se puebla
automáticamente durante las ejecuciones de investigación; consulte los hallazgos almacenados
con `searchKnowledge()` del SDK o con la herramienta `research_knowledge_search`. La
dimensión del vector depende del modelo (se detecta automáticamente); los campos almacenados
son `text`, `content`, `vector`, `url`, `metadata`, `timestamp`, `workspace`, `is_global` e
`ingestion_type`.

### Ejemplo de uso

El proyecto [Wall of Shame](https://wallofshame.io) ([repositorio](https://github.com/Lincoln504/wall-of-shame))
usa este SDK en su pipeline de agentes: llama a `initResearchSDK` y a los puntos de entrada de
investigación (`runQuickResearch` / `runDeepResearch`) por investigación, y usa las
exportaciones `scrapeUrl`, `verifyUrl` y `repairJson` directamente.
## Almacén de conocimiento {#knowledge-store}

El almacén de conocimiento es una base de datos vectorial local de hallazgos de
investigaciones anteriores. Es una caché opcional (la investigación funciona sin ella) y se
usa de dos maneras distintas:

- **Respuesta priorizando el conocimiento (orientativo).** La herramienta
  `research_knowledge_search` responde directamente desde los resultados almacenados a una
  pregunta repetida o superpuesta. Se pide al agente que la pruebe *antes* que la herramienta
  en vivo `research`, pero esto es una guía que el modelo sigue — no es obligatorio, y
  `research_knowledge_search` es una herramienta separada, no un candado frente a `research`.
- **Sembrar una ejecución en vivo (automático).** Una ejecución en vivo de `research` nunca
  responde desde el almacén; en su lugar, el orquestador entrega a cada investigador las URLs
  que fueron útiles antes para su objetivo, como puntos de partida para volver a extraerlas
  en vivo.

![Acierto del almacén de conocimiento: una respuesta en caché devuelta sin ejecución en vivo](https://raw.githubusercontent.com/Lincoln504/pi-research/main/docs/media/03-knowledge-store.gif)

En conjunto, esto hace que el trabajo repetido sea más rápido y barato.

### Qué almacena

El almacén es una tabla [LanceDB](https://lancedb.com) en disco. Después de cada ronda de
investigación, las URLs citadas en los informes de los investigadores se encolan y se
escriben en segundo plano: el resumen de cada fuente (y, cuando está disponible, su Markdown
completo extraído) se divide en fragmentos, cada fragmento se incrusta en un vector y las
filas se guardan.

Cada fila lleva el vector de incrustación, la URL de la fuente (normalizada para
deduplicación), el texto del resumen y el contenido completo, una marca de tiempo y
banderas de alcance. Un hash de contenido deduplica las URLs re-ingeridas: una página sin
cambios se omite; una página cambiada reemplaza las filas antiguas. El Markdown completo de
la página se guarda en caché una vez por documento, de modo que un hallazgo almacenado puede
rehidratarse después sin volver a extraerlo.

Las escrituras nunca bloquean una ejecución de investigación — pasan por una cola de
escritura asíncrona que se vacía al final de la ronda y al apagar.

### Alcances: none, project, global

El alcance del almacén lo fija el Modo de Conocimiento (`PI_RESEARCH_KNOWLEDGE_STORE_MODE`),
un ajuste con alcance de proyecto que puede cambiar por directorio:

| Modo | Comportamiento |
|------|----------|
| `global` (predeterminado) | Un único almacén compartido por todos los directorios. Un hallazgo guardado en un proyecto se puede recuperar desde cualquier otro. |
| `project` | Los hallazgos quedan limitados al directorio de trabajo donde se crearon; solo ese directorio los recupera. |
| `none` | El almacén se deshabilita — no se lee ni se escribe nada, la herramienta `research_knowledge_search` no se anuncia al agente y `/knowledge-store` no está disponible. Rehabilitarlo no requiere reinicio (consulte [Extensión de Pi](#pi-extension) para los detalles de registro). |

Cambie el modo del directorio actual con la TUI de `/research-config` (Modo de Conocimiento)
en la extensión de pi, o con `pi-research knowledge-config set <none|project|global>` (elija
un solo valor) en la CLI independiente. El ajuste persiste en el registro de proyectos por
directorio — consulte [Configuración](#configuration) para la cadena completa de precedencia.
El cambio aplica en la siguiente ejecución — sin reinicio.

Todos los alcances comparten un único directorio físico de LanceDB; las filas de proyecto y
global se distinguen por columnas (una ruta de workspace normalizada y una bandera global) y
se filtran en el momento de la consulta, no por carpetas separadas. El directorio de base de
datos predeterminado es `~/.pi/research/knowledge_db/` (sobrescriba con
`PI_RESEARCH_KNOWLEDGE_DIR`).

El modelo de incrustación es perezoso — solo se descarga e inicializa la primera vez que el
almacén se escribe o se consulta de verdad, de modo que el valor `global` predeterminado no
añade costo de arranque hasta que una ejecución guarda en caché su primera página.

### Cómo usa el almacén una ejecución

El almacén lo impulsa el orquestador, no los agentes investigadores a demanda, lo que
mantiene su uso determinista:

1. Antes de que cada investigador comience, el orquestador busca en el almacén el objetivo
   del investigador e inyecta en su prompt cualquier URL histórica que coincida — cada una
   con su resumen previo — como puntos de partida sugeridos para volver a extraer.
2. Después de la ronda, las URLs citadas y sus descripciones se encolan en la cola de
   escritura para la siguiente sesión.

Por separado, la herramienta `research_knowledge_search` (y `searchKnowledge()` del SDK)
permite al modelo consultar el almacén directamente: rehidrata los documentos almacenados
más relevantes, pregunta a un LLM en segundo plano si responden la pregunta, y devuelve una
respuesta sintetizada con citas — o informa de que se necesita investigación en vivo.

### Incrustaciones y el modelo

Las incrustaciones se calculan localmente con
[`@huggingface/transformers`](https://github.com/huggingface/transformers.js) sobre ONNX.
El modelo predeterminado es
`onnx-community/granite-embedding-small-english-r2-ONNX` (inglés; ventana de fragmentos de
512 tokens). Cada modelo compatible define su propio tamaño de fragmento, estrategia de
agrupación (pooling) y prefijos, y produce una dimensión de vector fija sobre la que se
construye el esquema de la tabla.

Modelos compatibles (`PI_RESEARCH_EMBEDDING_MODEL`):

| Modelo | Idiomas |
|-------|-----------|
| `onnx-community/granite-embedding-small-english-r2-ONNX` (predeterminado) | Inglés |
| `Xenova/multilingual-e5-small` | Multilingüe |
| `Xenova/multilingual-e5-base` | Multilingüe |
| `Xenova/bge-m3` | Multilingüe |
| `onnx-community/embeddinggemma-300m-ONNX` | Multilingüe |
| `onnx-community/Qwen3-Embedding-0.6B-ONNX` | Multilingüe |
| `Xenova/all-MiniLM-L6-v2` | Inglés |
| `Xenova/bge-small-en-v1.5` | Inglés |
| `Xenova/all-mpnet-base-v2` | Inglés |

Cambiar de modelo invalida los vectores existentes (tienen otra dimensión y otro significado),
así que el almacén se migra (consulte Cambio de modelo, abajo). El modelo se descarga de
Hugging Face en el primer uso y se guarda en caché; la primera descarga puede tardar unos
minutos (suba `PI_RESEARCH_EMBEDDING_MODEL_INIT_TIMEOUT_MS` en una conexión lenta).

### Selección de dispositivo

Las incrustaciones se ejecutan en la GPU (WebGPU, vía el backend Dawn integrado en el
entorno) o en la CPU. El backend lo elige `PI_RESEARCH_EMBEDDING_DEVICE`:

- `auto` (predeterminado; se muestra como GPU en la TUI) — pi-research comprueba la
  viabilidad de WebGPU en un proceso hijo desechable: carga el modelo y ejecuta allí una
  incrustación real. Si tiene éxito, se usa la GPU; si falla, se usa la CPU. El veredicto se
  guarda en caché, de modo que la prueba corre como máximo una vez por máquina + modelo.
- `cpu` (se muestra como CPU en la TUI) — fuerza la inferencia en CPU, sin prueba.
- `webgpu` — fuerza la ruta de GPU sin prueba. Avanzado / solo por entorno; ver abajo.

Por qué existe la prueba. Algunos hosts — VM, contenedores, runners de CI, máquinas sin
pantalla con un controlador Vulkan por software — exponen una GPU sobre la que el backend
nativo no puede ejecutar cómputo. Ese fallo es un segfault nativo, no un error capturable,
así que termina el proceso. La prueba `auto` verifica la viabilidad en un proceso hijo (cuyo
bloqueo no puede afectar al proceso principal) y cae a CPU. Forzar `webgpu` omite esta
comprobación y puede bloquearse en un host así, por lo que el menú de `/research-config`
ofrece solo GPU (= `auto`) y CPU. El `webgpu` crudo sigue disponible a través de la variable
de entorno para hacer benchmarks en un host con GPU conocida buena.

El veredicto en caché vive en `~/.cache/pi-research/webgpu-viability.json`, indexado por
plataforma, arquitectura, versión mayor de Node y modelo. Defina `PI_RESEARCH_WEBGPU_REPROBE=1`
para descartarlo y volver a probar (por ejemplo tras una actualización de controladores).

### Soporte de plataformas (sin Mac Intel)

El almacén depende de dos componentes nativos — el runtime ONNX para incrustaciones y
LanceDB para el almacenamiento vectorial — que distribuyen binarios precompilados solo para
ciertos pares plataforma/arquitectura:

| Plataforma | Arquitectura | Almacén de conocimiento |
|----------|--------------|-----------------|
| macOS | Apple Silicon (arm64) | Compatible |
| macOS | Intel (x64) | No disponible |
| Linux | x64 / arm64 | Compatible |
| Windows | x64 / arm64 | Compatible |

Los Mac Intel (`darwin-x64`) no tienen binario precompilado de ninguno de los dos
componentes, así que el almacén de conocimiento no puede funcionar allí. La misma
desactivación limpia aplica en cualquier plataforma cuando un paquete requerido no está
instalado en absoluto — `@huggingface/transformers` opcional se omite con
`npm install --omit=optional` (y por un bug de dependencias opcionales de npm), o la
instalación de `@lancedb/lancedb` está rota. La degradación es automática y rápida:

- La investigación sigue funcionando. La búsqueda, la extracción, los transcriptos de
  YouTube, las bases de datos de seguridad, Stack Exchange, la planificación y la síntesis no
  se ven afectados — solo falta el almacén.
- El almacén falla rápido. Los paquetes faltantes se detectan por resolución antes de
  intentar cualquier inicialización, de modo que no hay tormenta de reintentos — el almacén
  simplemente arranca en OFF.
- Las superficies de ajustes explican por qué. `pi-research knowledge-config`, el menú de
  `/research-config` y la verificación de estado nombran el paquete faltante y la reparación
  (instalar las dependencias opcionales) en lugar de anunciar un modo que el almacén no puede
  cumplir. Un fallo de `research_knowledge_search` informa de la ausencia del paquete en
  lugar de apuntar a un interruptor de ajustes que no puede ayudar.
- La verificación de estado informa del almacén como deshabilitado, no como insalubre, de
  modo que el componente faltante no arrastra el estado general a "unhealthy" ni bloquea una
  ejecución rápida (profundidad 0).

No se necesita configuración: instale el paquete (una instalación completa, con las
dependencias opcionales) y el almacén arranca; cambiar solo el modo no puede revivirlo a
mitad de proceso.

### Retención y expulsión

Los hallazgos en caché se conservan durante `PI_RESEARCH_CACHE_TTL_DAYS` (predeterminado 30;
rango 1–365). La expulsión se comprueba cuando el almacén se abre y elimina solo las filas
más antiguas que el corte dentro del alcance actual. Baje el valor para datos más frescos y
menos disco; súbalo para conservar el historial por más tiempo.

### Cambio de modelo: migración

Cuando el modelo de incrustación configurado difiere del que se usó para construir los
vectores almacenados, el almacén se migra según `PI_RESEARCH_MIGRATION_STRATEGY`:

| Estrategia | Qué ocurre |
|----------|--------------|
| `backup` (predeterminado) | La tabla antigua se renombra a un lado (`knowledge_backup_<timestamp>.lance`) y se crea una tabla nueva para el modelo nuevo. Los datos antiguos se conservan en disco pero no se buscan. |
| `drop` | La tabla antigua se descarta y se crea una nueva. Rápido; sin respaldo. |
| `re-embed` | Cada documento almacenado se re-incrusta con el modelo nuevo en una tabla nueva, conservando el historial. El más lento. |

Si `re-embed` falla, pi-research cae a `backup`. Una `backup` (o `drop`) fallida aborta la
migración en su lugar: el almacén permanece con el modelo antiguo y la siguiente apertura lo
reintenta — los datos nunca se descartan salvo que se elija `drop` explícitamente. Cambiar el
modelo desde el menú de `/research-config` pide confirmación antes de limpiar el almacén
actual y empezar de cero; si se rechaza, se revierte el cambio de modelo y el almacén queda
intacto.

### Gestión del almacén

Desde `/research-config`:

- Estado del Almacén — conteos de entradas (proyecto y usuario), el modelo de incrustación y
  el dispositivo activos, y la ruta en disco.
- Limpiar Almacén de Proyecto / Limpiar Almacén de Usuario — elimina permanentemente las
  filas con alcance de proyecto o global (se muestran según el modo actual).
- Ejecutar Verificación de Estado — ejercita el grupo de navegadores, GPU/incrustación y la
  conectividad del almacén de conocimiento, e informa del estado de salud del almacén.

El almacén crece con copia en escritura (cada ejecución añade una versión), así que se
compacta automáticamente después de cualquier ejecución que haya cambiado los datos
almacenados — las versiones e índices obsoletos se podan para mantenerlo acotado. No hay
comando manual de mantenimiento.

### Ajustes

| Ajuste | Variable | Predeterminado |
|---------|----------|---------|
| Modo de Conocimiento (alcance de proyecto) | `PI_RESEARCH_KNOWLEDGE_STORE_MODE` | `global` |
| Modelo de incrustación | `PI_RESEARCH_EMBEDDING_MODEL` | `onnx-community/granite-embedding-small-english-r2-ONNX` |
| Dispositivo de incrustación | `PI_RESEARCH_EMBEDDING_DEVICE` | `auto` |
| Retención de caché (días) | `PI_RESEARCH_CACHE_TTL_DAYS` | `30` |
| Estrategia de migración | `PI_RESEARCH_MIGRATION_STRATEGY` | `backup` |
| Directorio de la base de datos | `PI_RESEARCH_KNOWLEDGE_DIR` | `~/.pi/research/knowledge_db` |
| Tiempo de espera de init del modelo (ms) | `PI_RESEARCH_EMBEDDING_MODEL_INIT_TIMEOUT_MS` | `300000` |
| Volver a probar WebGPU | `PI_RESEARCH_WEBGPU_REPROBE` | _(sin definir)_ |

Consulte [Configuración](#configuration) para el modelo de configuración completo y
[Arquitectura](#architecture) para cómo encaja el almacén en el motor.
## Configuración {#configuration}

Todos los front-ends (la extensión de pi, la CLI independiente / habilidad de agente que
ejecutan Claude Code y otros hosts compatibles con habilidades, y el SDK) comparten un
único modelo de configuración. Este documento cubre primero los ajustes expuestos en la TUI
de `/research-config`, después la referencia completa de variables de entorno y por último
cómo se resuelven las capas de configuración.

![La TUI de ajustes /research-config](https://raw.githubusercontent.com/Lincoln504/pi-research/main/docs/media/04-config.gif)

### Ajustes en la TUI

Ejecute `/research-config` en la extensión de pi para abrir un menú interactivo. Seleccionar
un ajuste y presionar `Enter` / `Espacio` avanza por sus valores; el cambio se guarda de
inmediato. (En hosts sin TUI — RPC, web hub, impresión, JSON, SDK — el menú no puede
mostrarse: `/research-config` explica el motivo y responde con los diagnósticos no
interactivos `/research-config health` y `/research-config knowledge-status`. Allí los
ajustes se siguen leyendo del entorno y de los archivos de configuración, y las variables
`PI_RESEARCH_*` siguen surtiendo efecto.) Un ajuste se escribe en uno de dos alcances:

- `[project]` — se guarda por directorio de trabajo en el registro central de proyectos, de
  modo que un repositorio puede llevar su propio valor sin cambiar su valor global.
- usuario — se guarda en el archivo base compartido (`config.env`), aplicando a todos los
  directorios y front-ends salvo que una capa superior lo sobrescriba.

| Ajuste | Alcance | Valores | Variable |
|---------|-------|--------|---------|
| Profundidad de `/research` | proyecto | normal · deep · ultra | `PI_RESEARCH_DEFAULT_RESEARCH_DEPTH` |
| Modo de Conocimiento | proyecto | none · project · global | `PI_RESEARCH_KNOWLEDGE_STORE_MODE` |
| Tiempo de espera del investigador | usuario | 3 · 5 · 10 · 15 · 20 · 30 (minutos) | `PI_RESEARCH_TIMEOUT_MS` |
| Máxima concurrencia | usuario | 1 – 5 | `PI_RESEARCH_MAX_RESEARCHERS` |
| Lotes de extracción | usuario | unlimited · 1 · 2 · 3 · 5 · 10 · 15 | `PI_RESEARCH_MAX_SCRAPE_BATCHES` |
| Autoexportar informe | usuario | true · false | `PI_RESEARCH_REPORT_EXPORT_ENABLED` |
| Modelo de incrustación | usuario | uno de los modelos compatibles | `PI_RESEARCH_EMBEDDING_MODEL` |
| Dispositivo de incrustación | usuario | GPU · CPU | `PI_RESEARCH_EMBEDDING_DEVICE` |
| Retención de caché | usuario | 7 · 14 · 30 · 60 · 90 · 180 · 365 (días) | `PI_RESEARCH_CACHE_TTL_DAYS` |
| Registro de depuración | usuario | true · false | `PI_RESEARCH_DEBUG` |

El Dispositivo de Incrustación ofrece dos opciones en el menú. GPU corresponde a la ruta de
detección automática: pi-research comprueba si WebGPU funciona de verdad en esta máquina y
cae a CPU si no. CPU fuerza la inferencia solo en CPU. La GPU forzada cruda (sin prueba) solo
es alcanzable mediante la variable de entorno `PI_RESEARCH_EMBEDDING_DEVICE=webgpu`, para
hacer benchmarks — consulte el [documento del almacén de conocimiento](#knowledge-store).

Las filas Modelo de Incrustación, Dispositivo de Incrustación y Retención de Caché solo
aparecen cuando el Modo de Conocimiento no es `none`.

El menú también ofrece acciones que no son ajustes: Ejecutar Verificación de Estado, Estado
del Almacén, Limpiar Almacén de Proyecto / Usuario, Métricas de Sesión, Limpiar Registros de
Depuración e Instalar / Eliminar en Agentes Externos (el instalador de la habilidad de agente
de codificación). El número de workers del navegador está deliberadamente fuera del menú — es
sensible a CPU/RAM y solo se define con `PI_RESEARCH_WORKER_THREADS`.

### Variables de entorno

Todo ajuste es también una variable de entorno. El
[`.env.example`](https://github.com/Lincoln504/pi-research/blob/main/.env.example) del
repositorio es la lista canónica y exhaustiva, con notas en línea; esta sección agrupa las
mismas variables con sus valores predeterminados y rangos válidos. Los valores numéricos
fuera de rango se recortan (con advertencia); un valor enumerado no válido cae al
predeterminado (con advertencia).

Las variables expuestas en la TUI se marcan `(TUI)`. La marca `[project]` indica una clave
con alcance de proyecto (se guarda por directorio en el registro); todas las demás tienen
alcance de usuario.

Investigación

| Variable | Predeterminado | Rango | Descripción |
|----------|---------|-------|-------------|
| `PI_RESEARCH_TIMEOUT_MS` (TUI) | `300000` | 180000–1800000 | Tiempo de espera por investigador (3–30 min). |
| `PI_RESEARCH_MAX_RESEARCHERS` (TUI) | `3` | 1–5 | Investigadores en paralelo. |
| `PI_RESEARCH_DEFAULT_RESEARCH_DEPTH` (TUI) `[project]` | `1` | 1–3 | Profundidad para `/research` y la CLI cuando se omite `--depth` (1=normal, 2=deep, 3=ultra). |
| `PI_RESEARCH_MAX_SCRAPE_BATCHES` (TUI) | `2` | 0–99 | Lotes de extracción por investigador (0 = sin límite). Cuando se sabe que el caché de prompts está activo para el modelo de investigación resuelto (modelos de API de Anthropic, o una ruta de proveedor configurada explícitamente para control de caché estilo Anthropic), el límite efectivo es este valor más uno — el prefijo de prompt en caché hace que el lote adicional sea barato. |
| `PI_RESEARCH_MAX_GATHERING_CALLS` | `12` | 1–100 | Llamadas compartidas de recopilación web por investigador (`search` + `security_search` + `stackexchange` + `youtube_transcript`). |
| `PI_RESEARCH_MAX_CONCURRENT_SCRAPES` | `3` | 1–20 | URLs concurrentes obtenidas por lote de extracción. |
| `PI_RESEARCH_MAX_SCRAPE_URLS` | `8` | 1–20 | Número máximo de URLs obtenidas por lote de extracción. Las URLs sobre el tope se listan bajo "Not Fetched — Over Batch Cap" y deben pedirse en un lote posterior. (Promovido desde una constante fija para que sea ajustable por entorno/archivo de configuración como cualquier otra perilla de extracción.) |
| `PI_RESEARCH_MAX_RETRIES` | `2` | 0–5 | Reintentos por solicitud de investigador. |
| `PI_RESEARCH_RETRY_DELAY_MS` | `2000` | 100–10000 | Demora base entre reintentos. |
| `PI_RESEARCH_MAX_FAILED_RESEARCHERS` | `2` | 1–10 | Fallos únicos de investigador que abortan toda la ejecución. Súbalo para dejar que investigadores más lentos, aún en vuelo, terminen antes de rendirse. |
| `PI_RESEARCH_WORKER_THREADS` | `4` | 1–10 | Procesos de worker del navegador. Más = más rendimiento, más CPU/RAM. Define *qué tan rápido* se drena una ráfaga de búsquedas, no *qué tan grande* puede ser — una ráfaga mayor que el grupo espera su turno en lugar de recortarse o agotar el tiempo. |
| `PI_RESEARCH_WORKER_CONCURRENCY` | `2` | 1–10 | Tareas por proceso de worker. |
| `PI_RESEARCH_MAX_CONCURRENT_RUNS` | `3` | ≥1 | Límite de ejecuciones de investigación simultáneas a nivel de máquina, en **todos** los procesos (CLI, habilidad de agente, extensión de pi, SDK). Las ejecuciones que superan el límite hacen cola en lugar de fallar. Todas las ejecuciones concurrentes comparten un único grupo de navegador/incrustación elegido por liderazgo, así que sobresuscribirlo degrada a todas a la vez. |
| `PI_RESEARCH_RUN_ACQUIRE_TIMEOUT_MS` | `600000` | ≥0 | Cuánto espera una ejecución en cola por un espacio libre antes de fallar con "maximum concurrent research runs reached" (salida CLI `75`). `0` = fallar de inmediato en lugar de hacer cola. |
| `PI_RESEARCH_MODEL` | _(pi: modelo de sesión; CLI/skill: obligatorio)_ | — | El modelo en el que corren las investigaciones. **Obligatorio para la CLI / habilidad de agente independientes** — usan solo este modelo configurado (nunca el modelo seleccionado dentro de la extensión de pi) y se niegan a arrancar sin uno (la bandera `--model` por ejecución de la CLI también lo satisface). En el SDK selecciona el modelo de sesión cuando no se da una opción `model`. En la extensión de pi sobrescribe los subagentes investigadores y la síntesis de conocimiento, mientras que el coordinador y el líder de investigación siguen usando el modelo de sesión. Acepta `provider/id` o un id de modelo simple. |
| `PI_RESEARCH_DISABLED_TOOLS` | _(ninguna)_ | — | Herramientas de investigación separadas por comas para deshabilitar en una ejecución (`search`, `scrape`, `security_search`, `stackexchange`, `youtube_transcript`, `grep`, `read`). Se retiran del conjunto de herramientas de cada investigador y se nombran en los prompts del coordinador y del líder de investigación. Estrictamente aditivo — solo puede quitar capacidades, nunca conceder una, y se apila sobre las exclusiones predeterminadas en lugar de reemplazarlas. Un nombre no reconocido no excluye nada y genera una advertencia en lugar de fallar la ejecución. |
| `PI_RESEARCH_REPORT_EXPORT_ENABLED` (TUI) | `false` | — | Los front-ends escriben un informe Markdown en disco y muestran su ruta. |
| `PI_RESEARCH_REPORT_EXPORT_DIR` | _(cwd inteligente)_ | — | Fija los informes exportados a un directorio fijo, evitando la resolución relativa al cwd. Útil para la habilidad de agente, que se ejecuta desde el directorio arbitrario del agente anfitrión. |
| `PI_RESEARCH_MAX_SCRAPE_TOKEN_FRACTION_FOR_SCRAPING` | `0.15` | 0.05–1.0 | Fracción máxima de la ventana de contexto usada para el contexto inicial de extracción. |
| `PI_RESEARCH_AVG_TOKENS_PER_SCRAPE` | `2500` | 500–10000 | Tokens estimados por resultado de extracción, usados para la planificación. |

Transcriptos de YouTube

| Variable | Predeterminado | Rango | Descripción |
|----------|---------|-------|-------------|
| `PI_RESEARCH_YOUTUBE_TRANSCRIPT_MAX_VIDEOS` | `3` | 1–5 | Videos con transcripción por llamada `youtube_transcript`. |
| `PI_RESEARCH_YOUTUBE_TRANSCRIPT_TIMEOUT_MS` | `20000` | 5000–120000 | Tiempo de espera de transcripción por video. |
| `PI_RESEARCH_YOUTUBE_TRANSCRIPT_LANG` | `en` | — | Idioma de subtítulos preferido (prefijo BCP-47). |
| `PI_RESEARCH_YOUTUBE_QUERY_EVERY_N` | `5` | 1–100 | Añade `youtube` a aproximadamente una de cada N consultas de búsqueda (1 = todas). |
| `PI_RESEARCH_YOUTUBE_POTOKEN_REQUEST_KEY` | _(integrado)_ | — | Avanzado: sobrescribe la clave de solicitud web del PoToken de BotGuard (solo si YouTube rota la clave pública y los transcriptos empiezan a fallar). |

Tiempos de espera

| Variable | Predeterminado | Rango | Descripción |
|----------|---------|-------|-------------|
| `PI_RESEARCH_LLM_TIMEOUT_MS` | `300000` | 60000–1800000 | Tiempo de espera de llamadas LLM de coordinador / líder de investigación / reparación / conocimiento. |
| `PI_RESEARCH_SCRAPE_TIMEOUT_MS` | `15000` | 5000–120000 | Tiempo de espera por página extraída (carga de página). |
| `PI_RESEARCH_SEARCH_TIMEOUT_MS` | `45000` | 5000–120000 | Tiempo de espera de la página de búsqueda del navegador. |
| `PI_RESEARCH_BROWSER_TASK_TIMEOUT_MS` | `10000` | 2000–120000 | Margen adicional sumado al propio tiempo de espera de cada operación de navegador (un tope de tarea de búsqueda es `SEARCH_TIMEOUT_MS` + esto + un margen fijo de ~120s de arranque en frío; una extracción es `SCRAPE_TIMEOUT_MS` + esto + el mismo margen). El margen de arranque en frío cubre el primer lanzamiento real del navegador de un worker + la creación de contexto, que no es ajustable por el usuario. Estos topes acotan la **ejecución**: el reloj de una tarea arranca cuando un worker la toma, así que el tiempo esperando en cola detrás de otro trabajo no se le cobra y subir este valor para cubrir un grupo ocupado no es necesario ni efectivo. |
| `PI_RESEARCH_HEALTH_CHECK_TIMEOUT_MS` | `10000` | 2000–120000 | Tiempo de espera de la verificación de estado previa al vuelo. |

Salida de LLM y razonamiento

Estas son perillas avanzadas solo por entorno (no están en la TUI).

| Variable | Predeterminado | Rango | Descripción |
|----------|---------|-------|-------------|
| `PI_RESEARCH_LLM_THINKING_LEVEL` | `off` | off · minimal · low · medium · high | Nivel de cadena de pensamiento para todo el trabajo LLM del motor (coordinador, router, sintetizador, reparación JSON, extracción de conocimiento y subagentes investigadores). Desactivado por defecto — estas llamadas emiten JSON estructurado / informes citados, así que un bloque de pensamiento solo consume el presupuesto de salida y puede truncar la respuesta. Recortado por modelo por pi. |
| `PI_RESEARCH_PLANNING_MAX_TOKENS` | `16384` | 1024–131072 | Máximo de tokens de salida para el plan del coordinador. La decisión del router tiene su propio tope, menor; la síntesis final usa `PI_RESEARCH_SYNTHESIS_MAX_TOKENS`. Recortado al tope real del modelo. |
| `PI_RESEARCH_SYNTHESIS_MAX_TOKENS` | `32768` | 1024–131072 | Máximo de tokens de salida para el informe final sintetizado. Recortado al tope real del modelo. |

Almacén de conocimiento

Consulte el [documento del almacén de conocimiento](#knowledge-store) para saber qué hace
cada valor.

| Variable | Predeterminado | Rango | Descripción |
|----------|---------|-------|-------------|
| `PI_RESEARCH_KNOWLEDGE_STORE_MODE` (TUI) `[project]` | `global` | none · project · global | Alcance del almacén: un almacén compartido en todos los directorios (`global`), limitado al directorio actual (`project`) o deshabilitado (`none`). Independientemente de este ajuste, el almacén está en OFF limpio cuando sus paquetes requeridos no están instalados (`@huggingface/transformers` opcional omitido en la instalación, `@lancedb/lancedb` roto): init falla rápido en lugar de tormenta de reintentos, y `pi-research knowledge-config`, el menú de `/research-config` y la verificación de estado nombran el paquete faltante y la reparación. |
| `PI_RESEARCH_EMBEDDING_MODEL` (TUI) | `onnx-community/granite-embedding-small-english-r2-ONNX` | — | Modelo de incrustación. Cambiarlo limpia el almacén y empieza de cero. |
| `PI_RESEARCH_EMBEDDING_DEVICE` (TUI) | `auto` | auto · webgpu · cpu | Backend de inferencia. `auto` comprueba la viabilidad de WebGPU fuera de proceso y cae a CPU; `cpu` fuerza CPU; `webgpu` fuerza la ruta de GPU sin prueba (avanzado — puede bloquearse en una GPU por software). La TUI expone solo `auto` (como "GPU") y `cpu`. |
| `PI_RESEARCH_CACHE_TTL_DAYS` (TUI) | `30` | 1–365 | Cuánto se conservan los hallazgos en caché antes de la expulsión. |
| `PI_RESEARCH_KNOWLEDGE_STORE_MAX_SERVE_AGE_DAYS` | `0` | 0–3650 | Edad máxima que una extracción en caché puede *servirse* al leer antes de tratarse como fallo (miss) y re-extraerse fresca. `0` = deshabilitado (servir a cualquier edad hasta el TTL). La edad de la caché siempre se muestra al modelo, sin importar esto. |
| `PI_RESEARCH_MIGRATION_STRATEGY` | `backup` | drop · backup · re-embed | Qué hacer con los datos almacenados cuando cambia el modelo de incrustación. |
| `PI_RESEARCH_KNOWLEDGE_DIR` | _(auto)_ | — | Sobrescribe el directorio de la base de datos del almacén de conocimiento. Predeterminado: `~/.pi/research/knowledge_db`. |
| `PI_RESEARCH_EMBEDDING_MODEL_INIT_TIMEOUT_MS` | `300000` | 10000–600000 | Tiempo de espera de inicialización del modelo de incrustación (la primera descarga puede ser lenta). |
| `PI_RESEARCH_WEBGPU_REPROBE` | _(sin definir)_ | — | Defina `1` para descartar el veredicto de viabilidad de WebGPU en caché y volver a comprobar en el siguiente uso. |

Claves de API

| Variable | Descripción |
|----------|-------------|
| `PI_RESEARCH_API_KEY` / `PI_RESEARCH_PROVIDER` | Credenciales LLM explícitas para modo SDK / CLI (no necesarias cuando la configuración de pi suministra la clave). En la CLI / habilidad de agente ambas pueden vivir también en `config.env` / `cli.env`. El proveedor es obligatorio junto a la clave, o se infiere de un `PI_RESEARCH_MODEL` `provider/model-id`. Nota: las variables nativas del proveedor (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …) solo se honran como **variables de entorno reales** — poner una en `config.env` / `cli.env` no hace nada (los archivos solo puentean claves `PI_RESEARCH_*` más `STACKEXCHANGE_API_KEY` / `GITHUB_TOKEN` / `NVD_API_KEY`). |
| `STACKEXCHANGE_API_KEY` | Eleva el límite de la herramienta de Stack Exchange de 300/día a 10 000/día. Obtenga una en <https://stackapps.com/apps/oauth>. |
| `GITHUB_TOKEN` | Eleva el límite de Avisos de GitHub de la herramienta de seguridad de 60/hora a 5000/hora (cualquier token de alcance predeterminado). |
| `NVD_API_KEY` | Eleva el límite de NVD de la herramienta de seguridad ~10× y aprieta el espaciado de solicitudes. Solicítela en <https://nvd.nist.gov/developers/request-an-api-key>. Recomendada al usar búsquedas de seguridad filtradas por severidad: esas emiten una segunda consulta NVD (CVSS v2) para capturar CVE solo-v2, lo que aproximadamente duplica el tiempo de solicitud contra el límite de 6 s/solicitud sin autenticar. |

Diagnósticos y plataforma

| Variable | Predeterminado | Descripción |
|----------|---------|-------------|
| `PI_RESEARCH_DEBUG` (TUI) | `false` | Registro INFO+DEBUG verboso en el archivo de registro. Nota: una línea `DEBUG=true` guardada en `config.env` solo surte efecto de forma fiable para procesos donde se ha ejecutado un *guardado* de configuración (los guardados la sincronizan al entorno; las cargas simples no) — para garantizar registro verboso desde el arranque del proceso, exporte `PI_RESEARCH_DEBUG=true` en el entorno. |
| `PI_RESEARCH_CONSOLE_LOG` | `false` | Refleja los registros en stdout/stderr (útil en CI / sin pantalla). |
| `PI_RESEARCH_LOG_PATH` | _(temp del SO)_ | Sobrescribe la ruta del archivo de registro verboso. Los workers del navegador lo heredan automáticamente. |
| `PI_RESEARCH_LOG_FILE` | _(sin definir)_ | Envía los registros de los hilos de worker del navegador a un archivo separado. Si no está definido, los workers registran en `PI_RESEARCH_LOG_PATH`. |
| `PI_RESEARCH_TMP_DIR` | `~/.cache/pi-research/profiles` | Directorio transitorio de perfiles de navegador por worker. Respaldado en disco por defecto (se mantiene fuera de un `/tmp` respaldado en RAM para que los perfiles no añadan presión de memoria). Apunte bajo el directorio temp del sistema para optar por tmpfs/RAM. |
| `PI_RESEARCH_STATE_DIR` | `~/.pi/research/state` | Sobrescribe el directorio de estado (sesiones activas, estado del navegador, registro de proyectos). |
| `PI_RESEARCH_TUI_REFRESH_DEBOUNCE_MS` | `100` | Antirrebote de refresco de la TUI (0–1000 ms). |
| `PI_RESEARCH_SKIP_HEALTHCHECK` | _(sin definir)_ | Defina `1`/`true` para omitir la verificación de estado pre-vuelo de navegador/incrustación y depender de los tiempos de espera por tarea. **Solo profundidad 0 (rápida)** — las ejecuciones 1–3 no tienen esa verificación pre-vuelo, así que esto no tiene efecto en ellas. |
| `PI_RESEARCH_PDF_WORKER` | _(sin definir)_ | Defina `off` para forzar el análisis PDF al hilo principal (comportamiento previo a 1.6.6), evitando la descarga a los hilos de worker. Interruptor de emergencia para problemas de worker o empaquetado; el predeterminado ejecuta el análisis en un worker cuando su bundle está presente. |
| `PI_RESEARCH_USE_XVFB` | _(sin definir)_ | Solo Linux. Las ejecuciones en TTY puro son verdaderamente sin pantalla y no necesitan servidor X; defina `true` para optar a un framebuffer virtual (`sudo apt install xvfb`). |
| `PI_RESEARCH_SKILL_DIR` | _(auto)_ | Sobrescribe el directorio de código fuente de la habilidad de investigación incluida, usado por el instalador de habilidades. |
| `PI_RESEARCH_PURGE_BROWSERS` | _(sin definir)_ | Lo lee el `scripts/cleanup.cjs` incluido: defina `1` para borrar también la caché compartida del navegador camoufox (conservada por defecto porque otras instalaciones pueden usarla). Nota: npm ≥7 no ejecuta `preuninstall`, así que ese script no se dispara en `npm uninstall` — consulte [Habilidad de agente](#agent-skill). |
| `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` | _(sin definir)_ | Defina `1` durante `npm install` para omitir la descarga del navegador camoufox (se obtiene perezosamente en el primer uso; convención estándar de Playwright). |
| `CAMOUFOX_INSTALL_DIR` | _(caché de usuario)_ | La propia variable de camoufox-js, y la única que puede reubicar el navegador. Define dónde busca el binario pi-research, y se exporta a la descarga posterior a la instalación y a los workers del navegador. Efectiva en camoufox-js fijado a 0.12.0+, que la vuelve a honrar; en fijaciones antiguas (<0.12, que fijaban su directorio de caché en el código) solo reubicaba la búsqueda — consulte [Arquitectura](#architecture). |
| `PLAYWRIGHT_BROWSERS_PATH` | _(caché de usuario)_ | Alias de la anterior, aceptado por compatibilidad y exportado hacia adelante como `CAMOUFOX_INSTALL_DIR` — en camoufox-js 0.12.0+ reubica la propia descarga, exactamente como `CAMOUFOX_INSTALL_DIR`. |
| `XDG_CACHE_HOME` | `~/.cache` | Variable XDG estándar. Cuando está definida, toda ruta `~/.cache/pi-research/...` de abajo se ancla en `$XDG_CACHE_HOME/pi-research/...` en su lugar. |
| `PI_RESEARCH_BIN` (alias `PI_RESEARCH_PATH`) | _(auto)_ | Solo lanzador de la habilidad de agente: ruta explícita al binario del motor pi-research cuando debe omitirse la auto-resolución (PATH → instalación local → npx). Consulte [agent-skill/pi-research/references/configuration.md](../agent-skill/pi-research/references/configuration.md). |
| `PLAYWRIGHT_INSTALL_DEPS` | _(sin definir)_ | Solo Linux. Defina `true` durante `npm install` para instalar también las bibliotecas del sistema vía `npx playwright install-deps` (igual que `npm run install:system-deps`). |
| `PI_RESEARCH_STRICT_SETUP` | _(sin definir)_ | Lo lee el `scripts/setup.cjs` incluido durante `npm install`. Defina `1`/`true` para que una descarga fallida del navegador falle la instalación en lugar de diferirla al primer uso. |
| `PI_RESEARCH_CONFIG_DIR_NAME` | `.pi` | Sobrescribe el nombre del directorio de configuración del host bajo su directorio personal (avanzado; p. ej. defínalo para compartir la raíz de configuración de otro harness). |

Solo prueba — nunca habilite en producción

| Variable | Descripción |
|----------|-------------|
| `PI_RESEARCH_MOCK_SEARCH` | Devuelve resultados de búsqueda fabricados en lugar de datos web reales. |
| `PI_RESEARCH_MOCK_SCRAPE` | Devuelve resultados de extracción fabricados en lugar del contenido real de la página. |
| `PI_RESEARCH_FORCE_READY` | Omite las verificaciones de preparación y ejecuta incluso cuando servicios críticos fallaron al inicializar. **Solo extensión de pi** — la CLI, la habilidad de agente y el SDK no la consultan. |
| `PI_RESEARCH_ALLOW_LOOPBACK_SCRAPE` | Permite extraer direcciones **loopback** (`127.0.0.0/8`, `::1`, `*.localhost`, `::ffff:127.x`) para que las pruebas de integración puedan manejar el navegador real y el pipeline de extracción contra un servidor local. Deliberadamente limitado a loopback: las direcciones link-local `169.254.0.0/16` (metadatos de nube) y los rangos LAN RFC1918 siguen bloqueados incluso con esto definido, en el momento de la solicitud y de la conexión. |

### Cómo se apilan las capas de configuración

La configuración se resuelve desde las siguientes capas, de menor a mayor precedencia
(el último gana):

```
valores predeterminados integrados
  < ~/.pi/research/config.env                       (base, compartida; editada por /research-config)
  < ~/.pi/research/{pi,cli}.env                      (superposición opcional por front-end)
  < legacy .pi-research.env en el cwd               (obsoleta; migrada automáticamente al registro)
  < registro de proyectos                           (~/.pi/research/state/project-settings.json, por directorio)
  < process.env                                      (el entorno real de shell siempre gana)
```

Archivo base. `config.env` contiene sus ajustes compartidos con alcance de usuario. La TUI
de `/research-config` edita solo este archivo (y el registro de proyectos) — nunca las
superposiciones ni la vista combinada — así que los valores de superposición nunca se hornean
de vuelta a la base.

Superposiciones por front-end. Cada front-end lee solo su propia superposición opcional,
apilada sobre la base compartida, de modo que pueden configurarse independientemente.
Existen exactamente dos:

- `~/.pi/research/pi.env` — la extensión de pi
- `~/.pi/research/cli.env` — la CLI / habilidad de agente independiente (la superficie que
  ejecutan los hosts compatibles con habilidades)

Los archivos de superposición no existen por defecto; cree el que necesite a mano.
Deliberadamente no existe `sdk.env`: el SDK es una biblioteca configurada desde código
(consulte [SDK](#sdk)), no desde un archivo global.

Ejemplo — dar a la CLI / habilidad de agente independiente su propio modelo y profundidad sin
tocar la extensión de pi:

```sh
# ~/.pi/research/config.env   (línea base compartida)
PI_RESEARCH_KNOWLEDGE_STORE_MODE=project

# ~/.pi/research/cli.env       (solo CLI / habilidad de agente independiente)
PI_RESEARCH_MODEL=openrouter/anthropic/claude-sonnet-4-6
PI_RESEARCH_DEFAULT_RESEARCH_DEPTH=2
```

Registro de proyectos. Los ajustes con alcance de proyecto (profundidad de investigación y
modo de almacén de conocimiento) se guardan por directorio en `project-settings.json`,
indexados por ruta normalizada del directorio de trabajo. Sobrescriben la base y las
superposiciones solo para ese directorio. En la extensión de pi los escribe la TUI de
`/research-config`. En la CLI independiente puede definir el modo de almacén de conocimiento
por directorio directamente:

```sh
pi-research knowledge-config                       # muestra el modo aquí y de dónde viene
pi-research knowledge-config set <none|project|global>   # elija UN valor
```

Bajo la habilidad de agente no tiene que ejecutar esto usted mismo — pídaselo al agente
(p. ej. "deshabilita el almacén de conocimiento aquí" / "hazlo con alcance de proyecto") y
ejecuta el mismo comando en su nombre. De cualquier forma aterriza en el registro (por encima
de `config.env` en precedencia), así que un valor por directorio sobrescribe un
predeterminado de `config.env` de toda la máquina; una variable de entorno real aún supera a
ambos.

process.env. Una variable de entorno real siempre gana. Para una sobrescritura puntual,
exporte la variable para ese proceso.

> El archivo base no lo carga automáticamente su shell. Use la TUI de `/research-config`
> (que lo escribe), exporte las variables en su shell, o use un cargador como direnv.
> `.env.example` es una referencia, no un archivo de configuración activo.

### Caché de prompts

Una ejecución de investigación reenvía muchas veces un prompt grande y casi sin cambios: un
investigador reenvía toda su conversación (incluida cada página extraída) en cada turno de
herramienta, y el líder de investigación solía reenviar los hallazgos acumulados en cada
ronda. Todo proveedor servirá esa repetición desde un caché de prompts a una fracción del
precio de entrada — pero solo para un **prefijo exacto** de la solicitud, y solo si nada
variable se interpone delante.

Qué hace pi-research al respecto. El líder de investigación se divide en dos roles para que
la repetición se *elimine* en lugar de solo descontarse. El **router** decide cada ronda si
continuar, leyendo cada informe completo solo en la ronda en que llega y solo su breve
resumen de cobertura a partir de entonces, en lugar de releer todos los informes acumulados
hasta ahora. El **sintetizador** se ejecuta una sola vez, al final, y es la única llamada que
lee los informes completos. Antes de la división, una sola llamada hacía ambos trabajos y
reenviaba todo el corpus cada ronda, así que su entrada crecía con el cuadrado del número de
rondas. El corpus del sintetizador también se presupuesta contra la ventana de contexto del
modelo: sobre presupuesto, los informes se reducen en pasadas parciales y se fusionan en
lugar de truncarse o rechazarse.

Con qué frecuencia corre el router depende del presupuesto de rondas. Las profundidades 2 y 3
enrutan en cada ronda menos la última. El presupuesto base de la profundidad 1 es de dos
rondas y la última se omite, así que una ejecución normal de profundidad 1 nunca enruta —
pero la dirección (steering) eleva el presupuesto (hasta dos rondas extra), y una ejecución
de profundidad 1 dirigida sí enruta. Ese es también el caso de profundidad 1 que carga más
hallazgos, así que es donde más importa enrutar sobre resúmenes en lugar de sobre el corpus
completo.

Además, ambos prompts del líder están dispuestos estable-primero: interpolan solo valores
fijos para toda la ejecución (complejidad, tamaño de equipo, presupuesto de consulta,
herramientas deshabilitadas), y todo lo que cambia entre rondas — consulta raíz, número de
ronda, agenda, consultas ejecutadas, dirección, orientación de fase de ronda — se añade
después como un bloque `RUN CONTEXT`. Las pruebas unitarias fijan la disposición; si edita
`src/prompts/system-lead-router.md` o `src/prompts/system-lead-synthesizer.md`, mantenga el
texto variable por ronda fuera de ellos.

Qué hace su proveedor depende de a qué API habla pi (el campo `api` del proveedor en
`~/.pi/agent/models.json`) y, en endpoints compatibles con OpenAI, de una clave `compat`:

| API de proveedor | Comportamiento |
|--------------|-----------|
| `anthropic-messages` | pi inserta puntos de ruptura `cache_control` automáticamente — en el prompt del sistema, en la última definición de herramienta y en el último bloque usuario/asistente/resultado-de-herramienta. Nada que configurar. |
| `openai-completions` | pi inserta los **mismos** puntos de ruptura estilo Anthropic en el payload con forma OpenAI siempre que `compat.cacheControlFormat` sea `"anthropic"`. La auto-detección define esa clave exactamente para un caso — OpenRouter enrutando a un modelo `anthropic/*` — así que por defecto no se envían marcadores y se confía en el caché implícito de prefijo del propio proveedor. Ese predeterminado es correcto para OpenAI, DeepSeek, Gemini y GLM, que todos cachean implícitamente. |
| `openai-responses` | Sin marcadores en ningún ajuste; solo caché implícito. |

Nótese que el comportamiento de marcadores está regido por `cacheControlFormat`, **no** por
el campo `api` — definir la clave hace que un proveedor `openai-completions` emita puntos de
ruptura explícitos exactamente como uno `anthropic-messages`. Eso importa al leer los
contadores de abajo: en un proveedor configurado así, una lectura de caché en cero no es
evidencia de que faltan marcadores.

La brecha son los proveedores que necesitan marcadores explícitos pero se alcanzan sobre un
endpoint compatible con OpenAI y no son el caso auto-detectado. Cualquier cosa en esa
categoría (Qwen a través de OpenRouter, o cualquier gateway al frente de Claude) no cachea
**nada en absoluto**, silenciosamente y sin error. Arréglelo por proveedor con un bloque
`compat`:

```json
{
  "providers": {
    "openrouter": {
      "api": "openai-completions",
      "compat": {
        "cacheControlFormat": "anthropic",
        "sessionAffinityFormat": "openrouter",
        "sendSessionAffinityHeaders": true
      }
    }
  }
}
```

`cacheControlFormat: "anthropic"` fuerza los marcadores. Es seguro definirlo para un
proveedor entero: los modelos que no usan marcadores ignoran el campo extra. Las dos claves
de afinidad de sesión piden a OpenRouter mantener una conversación en la réplica que
calentó su caché; sin ellas, OpenRouter cae a hashear los primeros mensajes, que un bucle
agéntico muta.

`PI_CACHE_RETENTION=long` (una variable de pi, no de pi-research) pide retención de 1 hora
donde el proveedor la soporta. Eleva el multiplicador de escritura de caché de 1.25× a 2×,
así que solo compensa cuando los huecos entre llamadas de una ejecución superan la ventana
predeterminada del proveedor — nominalmente 5 minutos.

Mida antes de habilitarlo. En una prueba directa contra GLM sobre `anthropic-messages`, una
entrada se leyó de vuelta sin cambios después de **siete minutos con la retención
predeterminada**, y `long` produjo un número idéntico — así que en esa ruta el multiplicador
de escritura duplicado no compra nada. La cifra nominal de 5 minutos es un piso que los
proveedores pueden superar, no un plazo sobre el que pueda planear.

Verificar que funciona. Defina `PI_RESEARCH_DEBUG=true` y lea el registro de la ejecución:
toda llamada LLM registra `llm_cache_read_tokens_total` y `llm_cache_write_tokens_total`
junto a `llm_tokens_total`, etiquetadas por componente (`coordinator` / `router` /
`synthesizer` / `researcher`). Lecturas de caché que se mantienen en cero en un investigador
multi-turno significan que el prefijo no está coincidiendo — normalmente un proveedor con un
prefijo mínimo cacheable (comúnmente 1024–4096 tokens) que los prompts cortos nunca
alcanzan, o un proveedor de marcadores explícitos sin el bloque `compat` de arriba. Un
contador ausente en lugar de cero significa que el proveedor no reporta caché en absoluto.

Las **escrituras** de caché son la señal más débil de las dos. Varios proveedores reportan
lecturas y omiten las escrituras por completo — OpenRouter y el endpoint compatible con
Anthropic de Z.ai devuelven ambos `cache_read` no cero junto a un `cache_write` plano en
cero — así que un cero allí es normal y no dice nada sobre si el caché funciona. Júzguelo por
el contador de lecturas.

### Dónde viven los archivos

Todo el estado de pi-research vive bajo su propio espacio de nombres, `~/.pi/research/`:

| Ruta | Contenido |
|------|----------|
| `~/.pi/research/config.env` | Configuración base compartida (ajustes con alcance de usuario). |
| `~/.pi/research/{pi,cli}.env` | Superposiciones opcionales por front-end. |
| `~/.pi/research/state/project-settings.json` | Registro de proyectos (ajustes por directorio). |
| `~/.pi/research/state/` | Sesiones activas, estado del navegador, bloqueos. |
| `~/.pi/research/knowledge_db/` | El almacén de conocimiento (LanceDB), salvo que se defina `PI_RESEARCH_KNOWLEDGE_DIR`. |
| `~/.cache/pi-research/profiles/` | Perfiles de navegador transitorios, salvo que se defina `PI_RESEARCH_TMP_DIR`. Anclado en `$XDG_CACHE_HOME` cuando eso está definido. |
| `~/.cache/pi-research/webgpu-viability.json` | Veredicto de viabilidad de WebGPU en caché (consulte el documento del almacén de conocimiento). Anclado en `$XDG_CACHE_HOME` cuando eso está definido. |

Las rutas pueden reubicarse con `PI_RESEARCH_STATE_DIR`, `PI_RESEARCH_KNOWLEDGE_DIR` y
`PI_RESEARCH_TMP_DIR`.
## Arquitectura {#architecture}

pi-research es una extensión TUI de pi para investigación web multiagente. Se ejecuta dentro
del proceso de pi, registra sus herramientas y comandos, y gestiona su propio grupo de
procesos de navegador, su registro de servicios y su almacén de conocimiento local. Un solo
motor respalda todos los front-ends: además de la extensión de pi, se expone como CLI
independiente, como habilidad de agente portable (la misma habilidad que ejecuta cualquier
host compatible con habilidades) y como SDK programático (`src/sdk.ts`).

```
CLI de pi
└── extensión pi-research (src/index.ts)
    ├── Herramientas registradas   research, health, research_knowledge_search (siempre registradas; informa por qué cuando el almacén está deshabilitado)
    ├── Comandos           /research, /research-config, /knowledge-store
    ├── Eventos             input (dirección a mitad de ejecución), session_shutdown (limpieza), session_before_compact / session_compact, before_agent_start, after_provider_response
    └── Capas
        ├── Orquestación   coordinación de investigación rápida/profunda
        ├── Herramientas de agente     search, scrape, youtube_transcript, security_search, stackexchange, grep, read
        ├── Infraestructura  grupo de navegadores, almacén de conocimiento, gestor de estado
        └── Núcleo            registro de servicios, planificador, verificaciones de estado
```

1. Una consulta entra por `runResearch` — el único punto de entrada interno — con una
   profundidad. Los llamadores redactan la solicitud en lenguaje natural: cuando la
   herramienta `research` se invoca en sesión, el agente llamante elige la profundidad (1–3)
   a partir del redactado del usuario y la complejidad de la tarea, guiado por el prompt de
   uso de la herramienta (`src/prompts/research-tool-usage.md`). La CLI y el SDK pasan la
   profundidad explícitamente.
2. La profundidad 0 toma la ruta rápida; la 1–3 toma la ruta profunda (abajo). La
   herramienta de la extensión de pi y la TUI están restringidas a los niveles 1–3; la CLI,
   el SDK y la habilidad de agente pueden pasar 0.
3. En la ruta profunda, el coordinador planifica los ejes de investigación y ejecuta una
   ráfaga inicial de búsqueda, y luego entrega a cada investigador un conjunto de URLs de
   resultado desde las que comenzar.
4. Los investigadores extraen y leen esas páginas con las herramientas de extracción y
   devuelven informes citados. Solo consideran lo que extrajeron en esta sesión.
5. El **router** del líder de investigación revisa la ronda y o bien ejecuta otra ronda o
   termina el bucle; su **sintetizador** escribe entonces el informe final a partir de todos
   los informes recopilados.
6. El resultado se devuelve como un único informe Markdown citado; las URLs citadas y sus
   resúmenes se encolan en el almacén de conocimiento para futuras ejecuciones.

### Orquestación

`runResearch` (`IResearchOrchestration`, implementado en
`src/orchestration/research-orchestration-service.ts`) es el único punto de entrada
interno. Distribuye según la profundidad.

Profundidad 0 — rápida (`QuickResearchOrchestrator`): un solo investigador corre
directamente con todas las herramientas; no hay coordinador, ni fase de planificación, ni
rondas. La profundidad 0 solo es alcanzable vía SDK (`runQuickResearch`) o CLI (`--depth 0`,
que la habilidad de agente puede pasar). La herramienta `research` de la extensión de pi
tiene una profundidad mínima de 1, así que un agente en sesión nunca puede pedir modo rápido.

Profundidad 1–3 — profunda (`DeepResearchOrchestrator`): la ejecución avanza en **rondas**.
Una ronda es un ciclo coordenada → investigación → ruta: la agenda de la ronda se planifica
(por el coordinador en la ronda 1, por el **router** del líder de investigación a partir de
entonces), un lote de **investigadores** la ejecuta en paralelo, y el router decide entonces
si ejecutar otra ronda o terminar el bucle. Se aplican dos límites independientes: cuántos
investigadores corren *dentro* de una ronda, y cuántas rondas puede tomar la ejecución.

El líder de investigación son dos roles, no una llamada haciendo ambos trabajos. El router
solo decide; lee cada informe completo en la única ronda en que llega y solo el breve resumen
de cobertura de ese informe a partir de entonces, así que su entrada crece con el tamaño del
equipo, no con el cuadrado del número de rondas. El **sintetizador** corre exactamente una
vez, al final, lee cada informe completo y escribe el informe — bajo un presupuesto de corpus
derivado de la ventana de contexto del modelo, reduciendo en pasadas parciales y fusionando
cuando el corpus no cabe. Los dos prompts son `src/prompts/system-lead-router.md` y
`system-lead-synthesizer.md`.

| Profundidad | Etiqueta | Investigadores por ronda (máx.) | Rondas (máx.) |
|-------|--------|-----------------------------|--------------|
| 1     | normal | 2                           | 2            |
| 2     | deep   | 3                           | 3            |
| 3     | ultra  | 5                           | 3            |

Son techos, no metas: el coordinador y el router usan tantos investigadores y rondas como el
tema necesite. Una ejecución de profundidad 2, por ejemplo, puede lanzar hasta 3
investigadores en cada una de hasta 3 rondas. Los mensajes de dirección en cola (Alt+Enter)
pueden desbloquear unas rondas extra sobre el tope (`MAX_EXTRA_ROUNDS_WITH_STEERING`).

El coordinador también ejecuta la ráfaga inicial de búsqueda y distribuye sus URLs de
resultado a los investigadores de la ronda 1 (`distributeSearchResults`), así que en modo
profundo los propios investigadores no llaman a `search`.

Convenciones de llamadas LLM. Las llamadas de coordinador, router, sintetizador, reparación
JSON y extracción de conocimiento pasan por `completeSimple`
(`src/core/llm/pi-ai-completion.ts`) con `buildSafeOptions` (`src/core/llm/llm-utils.ts`);
los subagentes investigadores pasan por `createAgentSession`. Se aplican dos convenciones:

- El pensamiento está desactivado por defecto. Estas llamadas emiten JSON estructurado o
  informes citados, así que un bloque de cadena de pensamiento solo gasta presupuesto de
  tokens de salida (y puede truncar la respuesta). `PI_RESEARCH_LLM_THINKING_LEVEL`
  (predeterminado `off`) lo controla, recortado por proveedor.
- Los presupuestos de salida se dimensionan por rol y se recortan al tope del modelo:
  `PLANNING_MAX_TOKENS` para el plan/decisión, `SYNTHESIS_MAX_TOKENS` para el informe final.
  Una evaluación a mitad de ronda que no puede analizarse continúa la agenda existente en
  lugar de finalizar antes de tiempo, así que un fallo de análisis nunca trunca una ejecución.

### Inventario de herramientas

Esta es la lista canónica de todas las herramientas que expone el sistema, en ambas
superficies.

**Herramientas orientadas al host** — registradas con la sesión de pi (`src/index.ts`) para
que las invoque el agente llamante:

| Herramienta | Propósito |
|------|---------|
| `research` | Ejecuta una sesión de investigación multi-fuente completa y devuelve el informe Markdown citado |
| `research_knowledge_search` | Búsqueda local instantánea del almacén de conocimiento — se comprueba antes de la investigación en vivo; siempre registrada, informa por qué cuando el almacén está deshabilitado |
| `health` | Verifica el estado del sistema (grupo de navegadores, almacén de conocimiento, bloqueo GPU); prueba de actividad opcional |

**Herramientas de agente investigador** — el conjunto fijo con el que trabaja cada
subagente investigador (`src/tools/index.ts`). `search`, `security_search`, `stackexchange`
y `youtube_transcript` comparten un presupuesto de 12 llamadas de recopilación por fase
(`MAX_GATHERING_CALLS`); `scrape` y el `grep` local tienen sus propios presupuestos:

| Herramienta | Rápida | Profunda | Backend |
|------|-------|------|---------|
| `search` | ✓ | — | DuckDuckGo Lite vía el navegador sigiloso |
| `scrape` | ✓ | ✓ | Obtención por lotes de páginas → Markdown vía el navegador sigiloso (hasta MAX_SCRAPE_URLS URLs por llamada, predeterminado 8) |
| `youtube_transcript` | ✓ | ✓ | Subtítulos de YouTube vía youtubei.js + BotGuard PoToken (≤3 videos por defecto, configurable 1–5; una llamada por investigador) |
| `security_search` | ✓ | ✓ | NVD, CISA KEV, Avisos de GitHub, OSV |
| `stackexchange` | ✓ | ✓ | Red de Stack Exchange |
| `grep` | — | — | ripgrep local (de pi-coding-agent) — siempre excluida, ver abajo |
| `read` | ✓ | ✓ | Lectura local de archivos (de pi-coding-agent) |

En investigación profunda `search` está excluida — el coordinador ejecuta la ráfaga de
búsqueda y entrega las URLs directamente.

`grep` está excluida en **toda** profundidad y en todos los front-ends (CLI, SDK, habilidad
de agente, extensión de pi): esto es investigación web, y un modelo capaz de otro modo
gastaría turnos buscando en el sistema de archivos local. Ambas superficies de exclusión —
la lista `excludeTools` (`--exclude-tools` en la CLI, el parámetro de herramienta
`excludeTools` en la extensión) y `PI_RESEARCH_DISABLED_TOOLS` — son estrictamente aditivas
sobre ese predeterminado: solo pueden quitar capacidades (consulte
[Configuración](#configuration)). Antes de 1.3.10 una lista `excludeTools` no vacía
reemplazaba el predeterminado, de modo que nombrar cualquier otra herramienta re-habilitaba
silenciosamente `grep`.

Los investigadores no pueden escribir archivos, ejecutar comandos de shell ni alcanzar la
red fuera de estas herramientas.

### Infraestructura de navegador

Todo el trabajo de navegador (búsqueda, extracción, verificaciones de estado) pasa por un
`FixedClusterPool` de poolifier de procesos de worker — cada uno un proceso hijo de Node.js
que ejecuta su propia instancia de camoufox (Firefox sigiloso). Aislar el navegador en
workers significa que un bloqueo en un worker no puede derribar al orquestador ni a otras
sesiones.

```
BrowserTaskScheduler
└── FixedClusterPool (poolifier)
    ├── Worker 1  →  instancia de camoufox
    ├── Worker 2  →  instancia de camoufox
    └── Worker N  →  instancia de camoufox
```

Archivos clave:
- `src/infrastructure/browser/browser-task-scheduler.ts` — distribuye tareas al grupo
- `src/infrastructure/browser/thread-worker.ts` — punto de entrada del worker (empaquetado
  por separado por esbuild)
- `src/infrastructure/browser/thread-worker-messaging.ts` — protocolo IPC
- `src/infrastructure/browser/config.ts` — configuración del grupo, detección de la ruta del binario

### Almacén de conocimiento y manejo de datos

El almacén de conocimiento es una tabla vectorial LanceDB local de hallazgos pasados. Es
opcional (la investigación funciona sin él) y lo impulsa enteramente el orquestador — los
investigadores nunca lo llaman directamente:

- Antes de que cada investigador comience, el orquestador busca en el almacén el objetivo de
  ese investigador e inyecta en su prompt cualquier URL histórica que coincida (con
  resúmenes) como puntos de partida.
- Tras una ejecución, las URLs citadas y sus descripciones se encolan en la cola de escritura
  asíncrona y se guardan en segundo plano — las escrituras nunca bloquean una ejecución.

En la ingesta, el resumen de cada fuente y su Markdown completo extraído se dividen en
fragmentos e incrustan en vectores. Un hash de contenido SHA-256 de la página deduplica las
URLs re-ingeridas: una página sin cambios se omite, una página cambiada reemplaza sus filas
antiguas. Cada fila lleva el vector, la URL normalizada, el texto y el contenido completo,
una marca de tiempo y banderas de alcance (proyecto vs. global) que se filtran en el momento
de la consulta.

```
WriterQueue (asíncrona, no bloqueante)
└── KnowledgeStore
    ├── Embedder  (onnx-community/granite-embedding-small-english-r2-ONNX vía @huggingface/transformers)
    │   └── backend: auto (prueba WebGPU fuera de proceso → webgpu o cpu) / webgpu / cpu
    └── LanceDB   (directorio knowledge_db/, tabla vectorial respaldada por Arrow)
```

Archivos clave: `src/knowledge/store.ts` (operaciones LanceDB), `embedder.ts` (carga del
modelo + inferencia por lotes), `writer-queue.ts` (escrituras asíncronas + deduplicación por
hash de contenido), `chunker.ts` (fragmentación), `webgpu-viability.ts` (prueba de GPU fuera
de proceso + veredicto en caché), `migration.ts` (tipos de estrategia de migración — la
lógica drop / backup / re-embed en sí vive en `store.ts`).

El almacén necesita binarios nativos de runtime ONNX y LanceDB. En plataformas sin binario
precompilado — notablemente macOS Intel (`darwin-x64`) — está ausente: la verificación de
estado lo reporta deshabilitado-pero-saludable y la investigación corre sin la caché.
Consulte [Almacén de conocimiento](#knowledge-store) para el subsistema completo y la matriz
de plataformas.

### Servicios y ciclo de vida

Los servicios se registran con funciones de fábrica asíncronas y se resuelven a través de un
registro (`getService()`), inicializados perezosamente o con avidez, con las dependencias
conectadas en el momento del init.

```typescript
registerService(ServiceNames.FOO, async () => {
  const dep = await getService<IBar>(ServiceNames.BAR);
  return new FooService(dep);
}, { lazyInitialization: true });

const foo = await getService<IFoo>(ServiceNames.FOO);
```

Los servicios que mantienen recursos implementan `dispose()`; el registro los elimina en
orden inverso de dependencias. Resolver a través del registro (en lugar de importaciones
directas) impone disciplina de ciclo de vida (init → uso → dispose) y permite a las pruebas
intercambiar mocks.

- Núcleo (`src/core/`): `PlanningService`, `SchedulerService`
- Infraestructura (`src/infrastructure/`): `StateManagerService`, `KnowledgeStoreService`,
  `MetricsService`, `WorkerPoolManager`, `FileLockService`, `GPUResourceService` (más
  `WriterQueue`, definido en `src/knowledge/` y registrado aquí)
- Orquestación (`src/orchestration/`): `ResearchOrchestrationService`,
  `ResearchSessionService`, `ResearchSynthesisService`

El estado entre sesiones y procesos (sesiones activas, estado del navegador, métricas) vive
en `StateManagerService` (`src/infrastructure/state/`), que serializa las escrituras
concurrentes con bloqueo por archivos (`FileLockService`).

### Ejecuciones concurrentes (el límite de ejecuciones)

Todo proceso pi-research de una máquina — CLI, habilidad de agente, extensión de pi, SDK —
comparte un grupo de navegador elegido por liderazgo y un modelo de incrustación. Dejar un
número sin límite de ejecuciones de investigación sobre ese grupo compartido no las
ralentiza con gracia; satura la cola de prioridad y degrada *todas* a la vez.

`ResearchRunSemaphore` (`src/infrastructure/research-run-semaphore.ts`) por tanto pone
puerta a toda entrada de `runResearch()` sobre uno de N espacios, materializados como N
archivos de bloqueo bien conocidos en el directorio de estado y coordinados por el mismo
`FileLockService`. Como la propiedad del espacio se registra como PID + hora de arranque del
proceso, un espacio retenido por una ejecución que se estrelló se reclama de inmediato en la
siguiente adquisición, mientras que un titular *vivo* nunca se roba — una ejecución legítima
mantiene su espacio durante minutos, y robarlo admitiría la ejecución (N+1) que el límite
existe para impedir.

Las ejecuciones sobre el límite **hacen cola** en lugar de fallar: la adquisición sondea
hasta que un espacio se libera, anunciándose una vez a través del observador (`onRunQueued`,
presentado por la CLI como `• queued: …`) para que una ejecución en espera nunca se confunda
con una colgada. Solo si nada se libera dentro de toda la ventana de cola eleva
`ResearchRunCapacityError` — una condición temporal que la CLI reporta como código de salida
`75`, distinto de un bloqueo. El límite falla *abierto* ante cualquier error interno o de E/S,
así que una falla del propio semáforo nunca puede impedir que la investigación se ejecute.
Tanto el límite como la ventana de cola son configurables (`PI_RESEARCH_MAX_CONCURRENT_RUNS`,
`PI_RESEARCH_RUN_ACQUIRE_TIMEOUT_MS`).

### TUI

El panel de progreso en vivo usa `@earendil-works/pi-tui`, que maneja el estado del terminal
(protocolo de teclado, seguimiento del ratón, pegado con corchetes). La captura de stdio
(para que la salida dispersa no corrompa el panel y para garantizar una salida limpia) vive
en `src/utils/stdio-capture.ts`.

### Estructura del proyecto

```
src/
├── index.ts              punto de entrada de la extensión (herramientas, comandos, eventos, ciclo de vida)
├── cli.ts                punto de entrada de la CLI independiente
├── sdk.ts                SDK programático (uso fuera de la extensión)
├── config.ts             análisis de variables de entorno, validación, singleton
├── constants.ts          tamaños de equipo, topes de rondas, presupuestos de herramientas, límites de lotes
├── logger.ts             registrador estructurado (JSONL, seguro para TUI)
├── tool.ts               barrel de re-exportación de las definiciones de las herramientas research + health
├── research-config.ts    /research-config TUI
├── core/
│   ├── llm/              prompts, resolución de modelos, reparación JSON agéntica, inyección de fecha
│   ├── interfaces/       contratos de abstracción (observador, planificación, orquestación)
│   ├── planning-service.ts, scheduler-service.ts
│   ├── service-registry.ts, service-interfaces.ts, service-initialization.ts
│   └── planning-utils.ts
├── infrastructure/
│   ├── browser/          grupo de workers, planificador de tareas, IPC, config de camoufox
│   ├── state/            gestor de estado, seguimiento de sesiones, recolector de métricas
│   ├── embedding/        gestión del servidor de incrustación local
│   ├── knowledge-store-service.ts, metrics-service.ts, file-lock-service.ts
│   └── process-lifecycle-service.ts
├── orchestration/
│   ├── deep-research-orchestrator.ts, quick-research-orchestrator.ts
│   ├── research-orchestration-service.ts, research-synthesis-service.ts
│   ├── research-session-service.ts, session-state.ts, session-context.ts
│   ├── researcher-executor.ts, researcher.ts, headless-observer.ts
├── prompts/              plantillas de prompt Markdown para todos los agentes
├── tools/                search, scrape, youtube_transcript, security, stackexchange, grep, read, knowledge-search
├── knowledge/            embedder, store, cola de escritura, chunker, migration, sonda webgpu
├── web-research/         búsqueda DuckDuckGo, extracción, lógica de reintentos
├── security/             clientes NVD, CISA KEV, OSV, Avisos de GitHub
├── stackexchange/        cliente de API de Stack Exchange
├── youtube/              cliente de transcriptos de YouTube (InnerTube + BotGuard PoToken)
├── skill-install/        instalador de la habilidad de investigación para harnesses de agentes de codificación
├── tui/                  paneles, layout, controlador, animación de ondas, utilidades de terminal
├── healthcheck/          registro de verificaciones de estado y comprobaciones
├── cleanup/              limpieza de resultados de investigación
├── observers/            implementación del observador de investigación
├── types/                tipos compartidos y de TUI
└── utils/                interruptor de circuito, utilidades de texto, enlaces compartidos, métricas, seguimiento de errores
```

### Decisiones clave de diseño

Investigadores de solo lectura — los agentes investigadores están limitados al conjunto de
herramientas anterior. No pueden escribir archivos, lanzar procesos ni hacer llamadas de red
arbitrarias. *Sí* pueden leer archivos: `read` está registrada y la lista de exclusión del
investigador (`bash`, `write`, `edit`, `repl`, `git`, `terminal`) no la cubre. El `grep`
local está registrado pero siempre excluido (ver la tabla de herramientas). El `cwd` pasado a
`read` es una base de resolución, no una cárcel — una ruta absoluta se resuelve a sí misma —
así que la frontera es "sin mutación", no "solo este directorio".

Grupo de workers sobre navegador directo — los procesos de navegador se aíslan en workers
para que un bloqueo en uno no afecte al orquestador ni a otras sesiones.

Pila de navegador fijada — `playwright-core` e `impit` están fijados a versiones exactas y
`camoufox-js` está fijado a su línea `0.12.0`; los tres están acoplados y se actualizan
juntos, porque cada rango flotante rompió instalaciones de consumo nuevas que nuestro
lockfile enmascaraba. playwright-core se mantiene en `1.60.0` (1.61+ rechaza el Juggler de
camoufox y falla todo lanzamiento — corroborado arriba: camoufox-js `0.12.0` declara
`peerDependencies: { "playwright-core": "<1.61.0" }`, el mismo límite que esta fijación
sostiene a mano). `impit` está exacto en `0.14.4` (refrescado desde `0.13.0` el 2026-08-30
junto con el aumento de camoufox) — exacto porque los `overrides` de npm no se propagan a los
consumidores, así que una fijación exacta es la única forma de forzar una versión aguas
abajo; el incidente del guardia `only-allow pnpm` de preinstalación de impit (0.13.1/0.14.0,
retirado en 0.14.1) es por qué aquí no se confía en rangos flotantes. Razonamiento completo:
`src/infrastructure/browser/thread-worker-browser.ts`.

El aumento 0.10.x→0.12.0 de camoufox se había retenido durante dos ciclos de refresco por
tres bloqueadores, todos ya resueltos: camoufox restauró los binarios de Windows en
`v152.0.4-beta.26` (2026-07-16); el guardia pnpm de impit existió solo en 0.13.1/0.14.0; y la
actualización a better-sqlite3 13 de camoufox-js 0.12, que inicialmente pareció exigir una
cadena de herramientas C++ en cada instalación. Medido en 13.0.3: los `prebuilds/` de los
ocho pares plataforma/arquitectura viajan DENTRO de su tarball y se cargan en tiempo de
ejecución vía node-gyp-build — sin script de instalación, nada que un consumidor deba
aprobar. Lo que realmente se rompió fue la herramienta, no el binario: el `node-gyp rebuild`
inyectado por npm ≤11 recompila innecesariamente un binding.gyp sin script de instalación (y
su node-gyp 11.2 no puede detectar la imagen del runner VS2026 de CI), por lo que CI ejecuta
npm 12. Cualquier aumento futuro verifica better-sqlite3 primero, no camoufox.

El BINARIO del navegador, por el contrario, no está fijado y no puede estarlo. `camoufox-js
fetch` no toma argumento de versión: recorre los releases de GitHub de `daijro/camoufox`
del más nuevo al más viejo y toma el primer release no-prerelease que lleve un asset para
este SO/arquitectura. Así que el binario que recibe un consumidor es el que camoufox
publicó más recientemente en el momento de la instalación, sin importar qué versión de
camoufox-js esté instalada — los pines de npm no lo congelan, y un futuro release de
camoufox podría romper lanzamientos de instalaciones nuevas sin cambio de nuestro lado. Los
assets de Windows estuvieron de hecho ausentes de `v146-hardware` a `v152.0.2-alpha` y
volvieron en `v152.0.4-beta.26` (2026-07-16). El más nuevo actual es `v152.0.4-beta.28`
(Firefox 152); lanza y se maneja limpiamente bajo playwright-core `1.60.0`, verificado
directamente, igual que el más viejo `v135.0.1-beta.24` que una caché existente puede
conservar aún. La consecuencia práctica es que la frescura del navegador es independiente
del pin npm: un `camoufox-js` obsoleto no significa un Firefox obsoleto. Re-verifique un
lanzamiento real al aumentar esta pila — las suites unitarias y de integración simulan el
navegador y no pueden detectar un desajuste de Juggler.

Pila de datos fijada — `apache-arrow` es una dependencia directa en `21.1.0`, y los
`overrides` fuerzan todo el árbol a esa única versión para que LanceDB y Arrow compartan una
sola instancia de Arrow (las copias de Arrow desemparejadas no interoperan — los arreglos
construidos por una son rechazados por la otra). Esto se asienta por encima del techo de
peer de Arrow declarado por `@lancedb/lancedb` 0.37 (`>=15.0.0 <=18.1.0`) — npm ni siquiera
resuelve el emparejamiento sin el override — y está verificado que funciona, pero debe
revalidarse siempre que se actualice `@lancedb/lancedb`.

`21.1.0` es exacto por una razón medida, no por precaución. Subir el minor de apariencia de
patch a `21.2.0` rompe el almacén de plano: el lector Arrow del lado Rust de LanceDB no
puede analizar el esquema que Arrow 21.2 escribe, fallando cada apertura de tabla con
`Failed to read IPC file: Arrow error: Parser error: Unable to get root as footer:
RangeOutOfBounds … UnionVariant { variant: "Type::FixedSizeList" }` — 56 pruebas unitarias y
36 de integración, todas las que tocan una tabla real. No trate este rango como seguro para
caret. Nótese también que todo release de `@lancedb/lancedb` hasta 0.37 declara el mismo
techo Arrow `<=18.1.0`, así que actualizar LanceDB no resuelve el override; solo cambia qué
emparejamiento necesita revalidarse.

Biblioteca de validación fijada — `typebox` está fijado a la versión exacta de la que
dependen los paquetes del host pi (`@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent`
fijan `1.3.7` a lo largo de la línea 0.84.x). El esquema de parámetros de cada herramienta se
construye aquí con TypeBox y se entrega al sistema de herramientas de pi, así que ambos deben
coincidir en la semántica de `Value.Check`/`Convert`. Un rango flotante `^1.1.38` dejó que una
instalación de consumo nueva resolviera pi-research a un TypeBox más nuevo que el de pi,
distribuyendo un emparejamiento entre versiones no probado; la fijación exacta mantiene
pi-research en la misma versión con la que pi valida. Súbalo a la par del host pi, no de forma
independiente. (`undici`, por el contrario, sigue el major del host — el host está en undici
8, y pi-research solo usa la API estable del conector `Agent`, así que sigue `^8`.)

Resiliencia ante fallos transitorios — toda llamada LLM es un potencial punto único de fallo
en un endpoint de streaming que puede cortarse a mitad de respuesta (undici lo presenta como
`terminated`). Las llamadas del coordinador y del líder de investigación reintentan fallos
transitorios rápidos de transporte (abortos de socket, 5xx, 429, sobrecarga del proveedor)
con retroceso exponencial acotado — reflejando el reintento por investigador
(`PI_RESEARCH_MAX_RETRIES`) — y, si siguen fallando, degradan a un plan de respaldo
determinista en lugar de abortar la ejecución. Un tiempo de espera LLM a nivel de aplicación
no se reintenta (ya gastó todo el presupuesto); degrada directamente. Los conteos de
reintentos son constantes internas, no configuración.

Registro sobre importaciones directas — los servicios se registran y resuelven a través del
registro para soportar pruebas (sustitución con mocks) y para imponer el ciclo de vida
init → uso → dispose.

ESM puro — el código es Módulos ES (`"type": "module"`). Los bundles de workers se
construyen con esbuild (`npm run build:worker`) antes de las pruebas de integración o la
publicación.

Límites reforzados — `docs/deps.svg` se regenera en cada push (madge), y las reglas
arquitectónicas se refuerzan con dependency-cruiser (`config/tooling/dependency-cruiser.cjs`).

### Construido con

Navegador y extracción

- [Camoufox](https://camoufox.com) — Firefox sigiloso (manejado vía [Playwright](https://playwright.dev))
  para búsqueda y extracción no detectadas
- [poolifier](https://github.com/poolifier/poolifier) — el grupo de procesos de worker detrás
  de los workers del navegador
- [html-to-markdown](https://github.com/kreuzberg-dev/html-to-markdown) — convierte el HTML
  extraído a Markdown (node-html-markdown sirve como respaldo puro-JS)
- `pdf-oxide-wasm` — extracción de texto PDF (Rust/WASM)

Almacén de conocimiento e incrustaciones

- [Transformers.js](https://github.com/huggingface/transformers.js) — inferencia de
  incrustaciones local (ejecución del modelo vía ONNX Runtime)
- [Dawn](https://dawn.googlesource.com/dawn) de Google — el backend WebGPU, accedido a través
  del binding `webgpu` de Node
- [LanceDB](https://lancedb.com) — base de datos vectorial en disco
- [Apache Arrow](https://arrow.apache.org) — el esquema columnar sobre el que se construye la
  tabla vectorial

Transcriptos de YouTube

- [youtubei.js](https://github.com/LuanRT/YouTube.js) — cliente de API interna de YouTube
- [BgUtils](https://github.com/LuanRT/BgUtils) — generación del PoToken de BotGuard
- [jsdom](https://github.com/jsdom/jsdom) — entorno DOM para acuñar el PoToken

Host y runtime

- [pi](https://github.com/earendil-works/pi) — el host runtime, el SDK de agente y el kit de
  herramientas TUI
- [TypeBox](https://github.com/sinclairzx81/typebox) — esquema de configuración de runtime y
  validación

### Desarrollo

```bash
npm run test:unit         # pruebas unitarias, sin navegador requerido
npm run test:integration  # requiere camoufox (Xvfb solo para las pruebas opt-in de pantalla virtual)
npm run type-check        # modo estricto TypeScript (src)
npm run type-check:tests  # modo estricto TypeScript (pruebas)
npm run type-check:native        # LAS MISMAS comprobaciones en el compilador nativo TS7 (fijado; ~9x más rápido)
npm run type-check:native:tests  # comprobación nativa TS7, proyecto de pruebas
npm run lint              # ESLint
npm run deps:check        # refuerzo de reglas arquitectónicas
npm run build:worker      # empaqueta el worker del navegador (requerido antes de pruebas de integración / publicación)
```
