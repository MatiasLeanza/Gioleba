# Gioleba — sitio + formulario de contacto con Notion

Sitio estático (HTML/CSS/JS, sin framework) servido por **Cloudflare Pages**, con una
**Pages Function** que recibe el formulario de contacto y guarda cada consulta como una
fila en una base de **Notion**.

```
public/                     sitio estático (esto es lo que se publica)
  index.html  contacto.html  nosotros.html  proyectos.html  servicios.html
  main.js  style.css  img/  Proyects/

functions/api/contacto.js   backend: POST /api/contacto -> Notion

wrangler.toml               configuración de Pages
.dev.vars.example           plantilla de variables para probar en local
```

---

## ¿GitHub público o todo dentro de Cloudflare?

**El código va en GitHub. Cloudflare no reemplaza al repo, lo consume.**

- El repo puede ser **público o privado**: da lo mismo para el funcionamiento. Público
  no expone nada porque el sitio, una vez publicado, es público de todos modos.
- **Lo único secreto es el token de Notion**, y ese **no vive en el repo**: va como
  variable de entorno en el panel de Cloudflare. Por eso el repo público es seguro.
- **No subas archivos a mano** en el panel de Cloudflare. Cloudflare Pages no permite
  editar archivos; lo que hacés es conectar el repo y cada `git push` redeploya solo.
- Nunca commitees `.dev.vars` (ya está en `.gitignore`).

Flujo de trabajo:

```
edito en local  ->  git push a main  ->  Cloudflare buildea y publica
```

---

## 1. Crear la base en Notion

Creá una base de datos (página completa o inline) y nombrala, por ejemplo, **Consultas**.
Las propiedades tienen que llamarse **exactamente así** (importan los acentos):

| Propiedad | Tipo | ¿Obligatoria? |
|---|---|---|
| `Nombre` | Título | ✅ |
| `Email` | Email | ✅ |
| `Mensaje` | Texto | ✅ |
| `Estado` | Selección | ✅ (opciones: `Nuevo`, `Contactado`, `Cerrado`) |
| `Teléfono` | Teléfono | opcional |
| `Negocio` | Texto | opcional |
| `Tipo` | Selección múltiple | opcional |
| `Fecha` | Creado el | automática |

`Tipo` y `Estado` no hace falta llenarlos a mano: la API crea las opciones que falten.
El mensaje completo va en el **cuerpo de la página** (las propiedades de texto cortan en
2.000 caracteres), así que no se pierde nada aunque el mensaje sea largo.

## 2. Crear la integración de Notion

1. Entrá a <https://www.notion.so/my-integrations> → **New integration**.
2. Tipo **Internal**, nombre `Gioleba web`.
3. En **Capabilities** activá:
   - **Insert content** (para crear las filas) ← obligatorio
   - **Read content** (para el diagnóstico `?check=1`) ← recomendado
4. Guardá y copiá el **Internal Integration Secret** (`ntn_...`). Ese es el `NOTION_TOKEN`.

## 3. Conectar la base con la integración

Abrí la base en Notion → menú `···` (arriba a la derecha) → **Connections** →
**Connect to** → elegí `Gioleba web`.

> Sin este paso la API devuelve `404 object_not_found`. Es el error más común.

## 4. Obtener el ID de la base

Con la base abierta como página completa, copiá el link. El ID son los **32 caracteres
hexadecimales** antes del `?`:

```
https://www.notion.so/miespacio/1a2b3c4d5e6f7890abcdef1234567890?v=...
                                   └────────── este es el ID ──────────┘
```

Ese valor va en `NOTION_DATABASE_ID`. La función resuelve sola el *data source* que pide
la API nueva; no hace falta buscarlo a mano.

---

## 5. Publicar en Cloudflare Pages

1. Panel de Cloudflare → **Workers & Pages** → **Create** → pestaña **Pages** →
   **Connect to Git** → autorizá GitHub → elegí el repo `Gioleba`.
2. Configuración del build (usá el nombre `gioleba` para que coincida con `wrangler.toml`):

   | Campo | Valor |
   |---|---|
   | Project name | `gioleba` |
   | Production branch | `main` |
   | Build command | `exit 0` |
   | Build output directory | `public` |

   (`exit 0` es lo que recomienda Cloudflare para sitios sin build; es lo que habilita
   las Functions.)

3. **Save and Deploy**. Te queda una URL tipo `https://gioleba.pages.dev`.

## 6. Cargar las variables de entorno

En el proyecto de Pages → **Settings** → **Variables and Secrets** → **Add**:

| Nombre | Valor | Tipo |
|---|---|---|
| `NOTION_TOKEN` | `ntn_...` | **Secret** |
| `NOTION_DATABASE_ID` | el ID del paso 4 | Secret |
| `RESEND_API_KEY` | opcional | Secret |
| `NOTIFY_EMAIL` | opcional, ej. `Gioleba@gmail.com` | Text |
| `RESEND_FROM` | opcional | Text |
| `TURNSTILE_SECRET_KEY` | opcional | Secret |

> ⚠️ Las variables nuevas **no se aplican solas**: después de cargarlas hay que hacer
> **Deployments → Retry deployment** (o un `git push` vacío) para que la función las vea.

## 7. Verificar que quedó bien

Abrí en el navegador:

```
https://gioleba.pages.dev/api/contacto
```

Debería devolver `{"ok":true,"servicio":"contacto","config":{...}}` con `notion: true`.

Y después, el diagnóstico real:

```
https://gioleba.pages.dev/api/contacto?check=1
```

Te dice si el token funciona, si la integración ve la base y **qué propiedades faltan**:

```json
{
  "ok": true,
  "dataSourceId": "c174b72c-...",
  "propiedades": ["Nombre", "Email", "Mensaje", "Estado", "..."],
  "faltantesObligatorias": [],
  "propiedadesOpcionalesAusentes": [],
  "aviso": "Todo listo para recibir consultas."
}
```

Si `faltantesObligatorias` no está vacío, creá esas propiedades con ese nombre exacto.

Por último, probá el formulario en `/contacto.html`. La fila tiene que aparecer en Notion
en segundos.

---

## Probar en local

```bash
npx wrangler pages dev
```

Sirve el sitio y las funciones en `http://localhost:8788`, leyendo los secretos desde
`.dev.vars` (copialo de `.dev.vars.example`). Así el `fetch('/api/contacto')` funciona
igual que en producción, sin problemas de CORS.

> Abrir `contacto.html` con doble clic (`file://`) **no** funciona: no hay backend y el
> envío va a fallar. Es esperado.

> Nota: en producción Cloudflare redirige `/contacto.html` a `/contacto` (y lo mismo con
> las demás páginas). Es normal y no rompe los links; `main.js` ya contempla las dos
> formas al marcar el menú activo.

---

## Qué hace la función

`functions/api/contacto.js` — `POST /api/contacto`:

1. **Rate limit**: 5 envíos cada 10 minutos por IP (en memoria, best-effort).
2. **Honeypot**: si el campo oculto `website` viene completo, responde `ok` y descarta.
3. **Validación en el servidor**: nombre 2–100, email válido, mensaje 15–5.000, largos máximos.
4. **Turnstile** (opcional): solo si configurás `TURNSTILE_SECRET_KEY`.
5. **Notion**: crea la página con `Notion-Version: 2026-03-11`, `parent.data_source_id`,
   propiedades tipadas y el mensaje completo en el cuerpo. Reintenta una vez si Notion
   responde `429`/`5xx`.
6. **Resend** (opcional): manda el aviso con `reply_to` = email del visitante. Si falla,
   no rompe nada: la consulta ya está guardada en Notion.

El front (`public/main.js`) valida, muestra "Enviando...", deshabilita el botón y **solo
muestra el mensaje de éxito si el servidor confirma**. Si algo falla, muestra el error y
te deja reintentar.

### Sobre el rate limit

El límite en memoria vive en cada instancia del Worker: frena lo básico, no un ataque
distribuido. Si algún día hace falta algo serio:

- **WAF → Rate limiting rules** en el panel de Cloudflare (una regla gratis), o
- Cloudflare **Turnstile** (gratis) agregando el widget en el formulario.

Para activar Turnstile: agregá en `contacto.html` el `<div class="cf-turnstile" data-sitekey="...">`
dentro del form y el `<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer>`,
y cargá `TURNSTILE_SECRET_KEY` en Cloudflare. El front ya manda el token.

### Sobre el mail con Resend

- El plan gratis permite 100 mails/día.
- El remitente `onboarding@resend.dev` **solo puede enviarte mails a la casilla de tu
  cuenta de Resend**. Para mandar a otra casilla, verificá un dominio en Resend y ponelo
  en `RESEND_FROM` (ej. `Gioleba <web@tudominio.com>`).
- El aviso es un extra: la fuente de verdad es la base de Notion.

---

## Si algo falla

| Síntoma | Causa probable |
|---|---|
| `404 object_not_found` de Notion | La base no está conectada a la integración (paso 3) |
| `validation_error` / `property does not exist` | Nombre de propiedad distinto (¿acentos?) — corré `?check=1` |
| `config.notion: false` | Falta `NOTION_TOKEN` o no redeployaste después de cargarla |
| El form dice "No pudimos enviar" y en Notion no hay fila | Mirá **Deployments → Functions → Logs** en Cloudflare |
| Error de CORS | Estás abriendo el HTML con `file://`; usá `npx wrangler pages dev` |

Los logs de la función se ven en el panel: **Workers & Pages → tu proyecto → Deployments
→ (deployment) → Functions → Logs**, o en tiempo real con `npx wrangler pages deployment tail`.
