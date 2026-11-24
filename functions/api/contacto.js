/**
 * POST /api/contacto
 *
 * Recibe el formulario de contacto, valida los datos y crea una fila (page)
 * en la base de datos de Notion. Opcionalmente manda un aviso por mail con
 * Resend y valida Cloudflare Turnstile.
 *
 * Variables de entorno (Cloudflare Pages > Settings > Variables and Secrets):
 *   NOTION_TOKEN           obligatoria   token de la integracion (ntn_...)
 *   NOTION_DATA_SOURCE_ID  obligatoria*  id de la data source de la base
 *   NOTION_DATABASE_ID     alternativa   si no hay data source, se resuelve sola
 *   RESEND_API_KEY         opcional      para el aviso por mail
 *   NOTIFY_EMAIL           opcional      casilla que recibe el aviso
 *   RESEND_FROM            opcional      remitente verificado en Resend
 *   TURNSTILE_SECRET_KEY   opcional      activa la verificacion anti-bot
 *
 * (*) Alcanza con una de las dos: data source o database.
 *
 * GET /api/contacto          -> estado del servicio
 * GET /api/contacto?check=1  -> verifica token, acceso y propiedades de Notion
 */

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2026-03-11';

/* Etiquetas de los checkboxes de contacto.html (value -> nombre en Notion) */
const TIPOS = {
  web: 'Sitio web',
  tienda: 'Tienda online',
  sistema: 'Sistema a medida',
  rediseno: 'Rediseño de web',
  'no-se': 'Todavía no lo sé'
};

const LIMITES = { nombre: 100, email: 254, tel: 40, negocio: 150, mensaje: 5000 };

/* Propiedades que la funcion escribe en Notion */
const PROPS_OBLIGATORIAS = ['Nombre', 'Email', 'Mensaje', 'Estado'];
const PROPS_OPCIONALES = ['Teléfono', 'Negocio', 'Tipo'];

/* Rate limit basico: vive en la memoria de cada isolate (best-effort).
   Para algo serio, sumar una regla de Rate Limiting en el WAF de Cloudflare. */
const intentos = new Map();
const VENTANA_MS = 10 * 60 * 1000;
const MAX_POR_VENTANA = 5;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function onRequestPost({ request, env }) {
  const ip = request.headers.get('CF-Connecting-IP') || '';

  if (limitado(ip)) {
    return json({ ok: false, error: 'rate' }, 429);
  }

  /* 1. body */
  let datos;
  try {
    const texto = await request.text();
    if (texto.length > 12_000) return json({ ok: false, error: 'datos' }, 413);
    datos = JSON.parse(texto);
  } catch {
    return json({ ok: false, error: 'datos' }, 400);
  }
  if (!datos || typeof datos !== 'object') {
    return json({ ok: false, error: 'datos' }, 400);
  }

  /* 2. honeypot: si viene completo es un bot, respondemos ok y no guardamos nada */
  if (limpio(datos.website).length > 0) {
    return json({ ok: true });
  }

  /* 3. validacion en el servidor (la del navegador se saltea facil) */
  const d = {
    nombre: limpio(datos.nombre),
    email: limpio(datos.email).toLowerCase(),
    tel: limpio(datos.tel),
    negocio: limpio(datos.negocio),
    mensaje: limpio(datos.mensaje).slice(0, LIMITES.mensaje)
  };

  const errores = [];
  if (d.nombre.length < 2 || d.nombre.length > LIMITES.nombre) errores.push('nombre');
  if (!EMAIL_RE.test(d.email) || d.email.length > LIMITES.email) errores.push('email');
  if (d.mensaje.length < 15) errores.push('mensaje');
  if (d.tel.length > LIMITES.tel) errores.push('tel');
  if (d.negocio.length > LIMITES.negocio) errores.push('negocio');
  if (errores.length) {
    return json({ ok: false, error: 'datos', campos: errores }, 400);
  }

  const tipos = (Array.isArray(datos.tipo) ? datos.tipo : [])
    .filter(t => typeof t === 'string' && TIPOS[t])
    .map(t => TIPOS[t]);

  /* 4. captcha (solo si esta configurado) */
  if (!(await captchaOk(env, datos.turnstileToken, ip))) {
    return json({ ok: false, error: 'captcha' }, 403);
  }

  /* 5. Notion */
  if (!env.NOTION_TOKEN) {
    console.error('Falta NOTION_TOKEN en las variables de entorno');
    return json({ ok: false, error: 'servidor' }, 500);
  }

  try {
    const parent = await parentDeNotion(env);
    const respuesta = await notionFetch(env, '/pages', {
      method: 'POST',
      body: JSON.stringify({
        parent,
        notifications: { mode: 'silent' },
        markdown_version: 'v2',
        markdown: cuerpoDeLaPagina(d, tipos),
        properties: propiedades(d, tipos)
      })
    });

    if (!respuesta.ok) {
      console.error('Notion respondio', respuesta.status, await respuesta.text());
      return json({ ok: false, error: 'servidor' }, 502);
    }
  } catch (err) {
    console.error('Error guardando en Notion:', err && err.message ? err.message : err);
    return json({ ok: false, error: 'servidor' }, 502);
  }

  /* 6. aviso por mail: si falla no rompe el envio, la consulta ya esta en Notion */
  try {
    await avisarPorMail(env, d, tipos);
  } catch (err) {
    console.error('Error mandando el aviso por mail:', err && err.message ? err.message : err);
  }

  return json({ ok: true });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);

  if (url.searchParams.get('check') !== '1') {
    return json({
      ok: true,
      servicio: 'contacto',
      config: {
        notion: Boolean(env.NOTION_TOKEN),
        dataSource: Boolean(env.NOTION_DATA_SOURCE_ID || env.NOTION_DATABASE_ID),
        mail: Boolean(env.RESEND_API_KEY && env.NOTIFY_EMAIL),
        captcha: Boolean(env.TURNSTILE_SECRET_KEY)
      }
    });
  }

  /* Diagnostico: confirma token, acceso a la base y nombres de propiedades */
  if (!env.NOTION_TOKEN) {
    return json({ ok: false, error: 'Falta NOTION_TOKEN' }, 500);
  }

  try {
    const dataSourceId = await dataSourceDeNotion(env);
    const r = await notionFetch(env, '/data_sources/' + dataSourceId);
    if (!r.ok) {
      return json(
        { ok: false, error: 'No se pudo leer la base', status: r.status, detalle: await r.text() },
        502
      );
    }
    const base = await r.json();
    const existentes = Object.keys(base.properties || {});
    const faltantes = PROPS_OBLIGATORIAS.filter(p => !existentes.includes(p));
    const opcionales = PROPS_OPCIONALES.filter(p => !existentes.includes(p));

    return json({
      ok: faltantes.length === 0,
      dataSourceId,
      propiedades: existentes,
      faltantesObligatorias: faltantes,
      propiedadesOpcionalesAusentes: opcionales,
      aviso: faltantes.length
        ? 'Crea las propiedades faltantes (con ese nombre exacto) o la funcion va a fallar.'
        : 'Todo listo para recibir consultas.'
    });
  } catch (err) {
    return json({ ok: false, error: String(err && err.message ? err.message : err) }, 502);
  }
}

/* ===== helpers ===== */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function limpio(valor) {
  return typeof valor === 'string' ? valor.trim().replace(/\s+/g, ' ') : '';
}

function limitado(ip) {
  if (!ip) return false;
  const ahora = Date.now();
  const previos = (intentos.get(ip) || []).filter(t => ahora - t < VENTANA_MS);

  if (previos.length >= MAX_POR_VENTANA) {
    intentos.set(ip, previos);
    return true;
  }
  previos.push(ahora);
  intentos.set(ip, previos);

  /* limpieza barata para que el Map no crezca sin control */
  if (intentos.size > 5000) {
    for (const [clave, marcas] of intentos) {
      if (!marcas.some(t => ahora - t < VENTANA_MS)) intentos.delete(clave);
    }
  }
  return false;
}

async function captchaOk(env, token, ip) {
  if (!env.TURNSTILE_SECRET_KEY) return true;
  if (typeof token !== 'string' || !token) return false;

  const cuerpo = new URLSearchParams({
    secret: env.TURNSTILE_SECRET_KEY,
    response: token
  });
  if (ip) cuerpo.set('remoteip', ip);

  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: cuerpo
    });
    const data = await r.json();
    return data.success === true;
  } catch (err) {
    console.error('Turnstile no respondio:', err);
    return false;
  }
}

async function notionFetch(env, ruta, opciones = {}) {
  const headers = {
    Authorization: 'Bearer ' + env.NOTION_TOKEN,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
    ...(opciones.headers || {})
  };
  const init = { method: opciones.method || 'GET', headers };
  if (opciones.body) init.body = opciones.body;

  /* un reintento si Notion limita (429) o falla del lado suyo (5xx) */
  for (let intento = 1; intento <= 2; intento++) {
    const r = await fetch(NOTION_API + ruta, init);
    if (r.status !== 429 && r.status < 500) return r;
    if (intento === 2) return r;
    const espera = Number(r.headers.get('Retry-After') || 1);
    await new Promise(ok => setTimeout(ok, Math.min(espera, 5) * 1000));
  }
}

/* Resuelve el parent que pide la API 2026-03-11: data source > database */
let cacheDataSource = null;

async function dataSourceDeNotion(env) {
  if (env.NOTION_DATA_SOURCE_ID) return env.NOTION_DATA_SOURCE_ID;
  if (cacheDataSource) return cacheDataSource;

  if (!env.NOTION_DATABASE_ID) {
    throw new Error('Configura NOTION_DATA_SOURCE_ID o NOTION_DATABASE_ID');
  }

  const r = await notionFetch(env, '/databases/' + env.NOTION_DATABASE_ID);
  if (!r.ok) throw new Error('No se pudo leer la base (' + r.status + ')');

  const base = await r.json();
  const id = base.data_sources && base.data_sources[0] && base.data_sources[0].id;
  if (!id) throw new Error('La base no tiene data sources visibles para la integracion');

  cacheDataSource = id;
  return id;
}

async function parentDeNotion(env) {
  if (env.NOTION_DATA_SOURCE_ID) {
    return { type: 'data_source_id', data_source_id: env.NOTION_DATA_SOURCE_ID };
  }
  /* si solo hay database id, lo resolvemos a data source para no depender del formato viejo */
  return { type: 'data_source_id', data_source_id: await dataSourceDeNotion(env) };
}

function propiedades(d, tipos) {
  const props = {
    Nombre: { title: [{ text: { content: d.nombre } }] },
    Email: { email: d.email },
    Mensaje: { rich_text: [{ text: { content: d.mensaje.slice(0, 2000) } }] },
    Estado: { select: { name: 'Nuevo' } }
  };

  if (d.tel) props['Teléfono'] = { phone_number: d.tel };
  if (d.negocio) props.Negocio = { rich_text: [{ text: { content: d.negocio } }] };
  if (tipos.length) props.Tipo = { multi_select: tipos.map(name => ({ name })) };

  return props;
}

/* El mensaje completo va en el cuerpo de la pagina: las propiedades de texto
   de Notion cortan en 2000 caracteres. */
function cuerpoDeLaPagina(d, tipos) {
  /* se escapa "<" para que un mensaje con etiquetas no rompa el parser de markdown */
  const texto = d.mensaje.replace(/</g, '&lt;');
  const lineas = ['## Mensaje', '', texto, '', '---', '', '**Contacto**', ''];
  lineas.push('- Nombre: ' + d.nombre);
  lineas.push('- Email: ' + d.email);
  if (d.tel) lineas.push('- Teléfono / WhatsApp: ' + d.tel);
  if (d.negocio) lineas.push('- Negocio: ' + d.negocio);
  if (tipos.length) lineas.push('- Necesita: ' + tipos.join(', '));
  return lineas.join('\n');
}

async function avisarPorMail(env, d, tipos) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_EMAIL) return;

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const filas = [
    ['Nombre', d.nombre],
    ['Email', d.email],
    ['Teléfono', d.tel],
    ['Negocio', d.negocio],
    ['Necesita', tipos.join(', ')]
  ].filter(([, v]) => v);

  const html =
    '<h2>Nueva consulta desde la web</h2>' +
    '<table cellpadding="6" style="border-collapse:collapse">' +
    filas.map(([k, v]) => `<tr><td><strong>${esc(k)}</strong></td><td>${esc(v)}</td></tr>`).join('') +
    '</table>' +
    `<p style="white-space:pre-wrap;border-left:3px solid #ccc;padding-left:12px">${esc(d.mensaje)}</p>`;

  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + env.RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: env.RESEND_FROM || 'Gioleba <onboarding@resend.dev>',
      to: [env.NOTIFY_EMAIL],
      reply_to: d.email,
      subject: 'Nueva consulta: ' + d.nombre,
      html
    })
  });

  if (!r.ok) {
    console.error('Resend respondio', r.status, await r.text());
  }
}
