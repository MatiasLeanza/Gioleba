/* ===== al cargar la pagina ===== */
document.addEventListener('DOMContentLoaded', () => {

  /* marca el link activo segun el archivo actual.
     Cloudflare sirve /contacto (sin .html), asi que se comparan sin extension */
  const pagina = (location.pathname.split('/').pop() || 'index.html').replace(/\.html$/, '') || 'index';
  document.querySelectorAll('.menu a').forEach(a => {
    const destino = (a.getAttribute('href') || '').split('/').pop().replace(/\.html$/, '') || 'index';
    if (destino === pagina) a.classList.add('activo');
  });

  /* menu movil */
  const burger = document.querySelector('.burger');
  const menu = document.querySelector('.menu');
  if (burger) {
    burger.addEventListener('click', () => {
      const abierto = menu.classList.toggle('abierto');
      burger.classList.toggle('abierto', abierto);
      burger.setAttribute('aria-expanded', abierto);
    });
  }

  /* sombra en la cabecera al bajar */
  const cabecera = document.querySelector('.cabecera');
  const onScroll = () => cabecera.classList.toggle('scroll', window.scrollY > 10);
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* aparicion de elementos al hacer scroll */
  const obs = new IntersectionObserver((items) => {
    items.forEach(i => {
      if (i.isIntersecting) {
        const el = i.target;
        el.classList.add('visible');
        obs.unobserve(el);
        /* terminada la aparicion se quita el retraso, asi el hover responde al instante */
        setTimeout(() => { el.style.transitionDelay = ''; el.classList.add('listo'); }, 1000);
      }
    });
  }, { threshold: 0.15 });
  document.querySelectorAll('.reveal').forEach((el, n) => {
    el.style.transitionDelay = (n % 3) * 0.1 + 's'; /* escalonado suave */
    obs.observe(el);
  });

  /* filtros de proyectos */
  const filtros = document.querySelectorAll('.filtro');
  filtros.forEach(f => f.addEventListener('click', () => {
    filtros.forEach(x => x.classList.remove('activo'));
    f.classList.add('activo');
    const cat = f.dataset.filtro;
    document.querySelectorAll('.proyecto').forEach(p => {
      p.classList.toggle('oculto', cat !== 'todos' && p.dataset.cat !== cat);
    });
  }));

  /* formulario de contacto: validacion en el navegador + envio a /api/contacto */
  const form = document.querySelector('#form-contacto');
  if (form) {
    const reglas = {
      nombre: v => v.trim().length >= 2,
      email: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
      mensaje: v => v.trim().length >= 15
    };
    const boton = form.querySelector('button[type="submit"]');
    const aviso = document.querySelector('#form-aviso');
    const textoBoton = boton ? boton.textContent : '';

    const mostrarAviso = texto => {
      if (!aviso) return;
      aviso.textContent = texto || '';
      aviso.hidden = !texto;
    };

    form.addEventListener('submit', async e => {
      e.preventDefault();
      mostrarAviso('');
      let ok = true;
      Object.keys(reglas).forEach(nombre => {
        const campo = form.elements[nombre].closest('.campo');
        const valido = reglas[nombre](form.elements[nombre].value);
        campo.classList.toggle('error', !valido);
        if (!valido) ok = false;
      });
      if (!ok) return;

      const datos = new FormData(form);
      const cuerpo = {
        nombre: datos.get('nombre') || '',
        email: datos.get('email') || '',
        tel: datos.get('tel') || '',
        negocio: datos.get('negocio') || '',
        mensaje: datos.get('mensaje') || '',
        tipo: datos.getAll('tipo'),
        website: datos.get('website') || '', /* honeypot: un humano lo deja vacio */
        turnstileToken: datos.get('cf-turnstile-response') || ''
      };

      if (boton) {
        boton.disabled = true;
        boton.textContent = 'Enviando...';
      }

      try {
        const r = await fetch('/api/contacto', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cuerpo)
        });
        const res = await r.json().catch(() => ({}));

        if (!r.ok || !res.ok) {
          if (res.error === 'rate') {
            mostrarAviso('Recibimos varios mensajes seguidos. Esperá unos minutos o escribinos por WhatsApp.');
          } else if (res.error === 'datos') {
            mostrarAviso('Revisá los datos: hay algo que no pudimos validar.');
          } else {
            mostrarAviso('No pudimos enviar el mensaje. Escribinos a Gioleba@gmail.com y lo resolvemos.');
          }
          if (boton) {
            boton.disabled = false;
            boton.textContent = textoBoton;
          }
          return;
        }

        form.style.display = 'none';
        const exito = document.querySelector('.exito');
        if (exito) {
          exito.classList.add('visible');
          exito.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      } catch (err) {
        console.error('Error enviando el formulario:', err);
        mostrarAviso('No pudimos enviar el mensaje. Revisá tu conexión o escribinos a Gioleba@gmail.com.');
        if (boton) {
          boton.disabled = false;
          boton.textContent = textoBoton;
        }
      }
    });

    /* limpia el error mientras se escribe */
    form.addEventListener('input', e => e.target.closest('.campo')?.classList.remove('error'));
  }

  /* slider de testimonios */
  iniciarSlider();

  /* fotos y ventana de detalle de proyectos */
  iniciarProyectos();

  /* año actual en el pie */
  document.querySelectorAll('.anio').forEach(el => el.textContent = new Date().getFullYear());
});

/* ===== slider de testimonios con bucle infinito ===== */
function iniciarSlider() {
  const slider = document.querySelector('#slider-testimonios');
  if (!slider) return;
  const pista = slider.querySelector('.slider-pista');
  const reales = [...pista.children];
  const total = reales.length;
  const CLON = 3; /* copias a cada lado para que el bucle no tenga saltos */
  const copiar = s => { const c = s.cloneNode(true); c.setAttribute('aria-hidden', 'true'); return c; };
  pista.prepend(...reales.slice(-CLON).map(copiar));
  pista.append(...reales.slice(0, CLON).map(copiar));
  const diapos = [...pista.children];
  const reducir = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let idx = CLON, ocupado = false, timer = null, visible = false, pausado = false;

  /* cuantas tarjetas se ven a la vez (se define en el css) */
  const vista = () => parseInt(getComputedStyle(slider).getPropertyValue('--vista')) || 3;
  const paso = () => diapos[0].offsetWidth + (parseFloat(getComputedStyle(pista).columnGap) || 0);

  /* puntos de navegacion */
  const contPuntos = document.querySelector('.slider-puntos');
  const puntos = reales.map((_, i) => {
    const b = document.createElement('button');
    b.setAttribute('aria-label', 'Ver testimonio ' + (i + 1));
    b.addEventListener('click', () => { irA(CLON + i); autoplay(); });
    contPuntos.appendChild(b);
    return b;
  });

  /* mueve la pista a la posicion actual */
  const colocar = animar => {
    pista.style.transition = animar ? '' : 'none';
    pista.style.transform = 'translateX(' + (-idx * paso()) + 'px)';
    if (!animar) void pista.offsetWidth;
  };
  /* las tarjetas en vista quedan nitidas, el resto difuminado */
  const marcar = () => {
    const v = vista();
    diapos.forEach((d, i) => d.classList.toggle('en-vista', i >= idx && i < idx + v));
    const real = ((idx - CLON) % total + total) % total;
    puntos.forEach((p, i) => p.classList.toggle('activo', i === real));
  };
  /* si llegamos a las copias, saltamos sin animar a las tarjetas reales */
  const normalizar = () => {
    if (idx >= total + CLON) idx -= total;
    else if (idx < CLON) idx += total;
    else return;
    slider.classList.add('salto');
    colocar(false);
    marcar();
    void slider.offsetWidth;
    slider.classList.remove('salto');
  };
  const mover = () => {
    ocupado = true;
    colocar(true);
    marcar();
    setTimeout(() => { normalizar(); ocupado = false; }, 720);
  };
  const ir = dir => { if (ocupado) return; idx += dir; mover(); };
  const irA = destino => { if (ocupado || destino === idx) return; idx = destino; mover(); };

  /* botones anterior y siguiente */
  document.querySelectorAll('.slider-btn').forEach(b =>
    b.addEventListener('click', () => { ir(+b.dataset.dir); autoplay(); }));

  /* movimiento automatico: se pausa con el mouse, fuera de pantalla o con la pestaña oculta */
  const autoplay = () => {
    clearInterval(timer);
    if (visible && !pausado && !reducir && !document.hidden) timer = setInterval(() => ir(1), 4500);
  };
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; autoplay(); }, { threshold: 0.3 }).observe(slider);
  slider.addEventListener('mouseenter', () => { pausado = true; autoplay(); });
  slider.addEventListener('mouseleave', () => { pausado = false; autoplay(); });
  slider.addEventListener('focusin', () => { pausado = true; autoplay(); });
  slider.addEventListener('focusout', () => { pausado = false; autoplay(); });
  document.addEventListener('visibilitychange', autoplay);

  /* deslizar con el dedo en celulares */
  let x0 = null;
  slider.addEventListener('touchstart', e => { x0 = e.touches[0].clientX; pausado = true; autoplay(); }, { passive: true });
  slider.addEventListener('touchend', e => {
    if (x0 !== null) { const dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 40) ir(dx < 0 ? 1 : -1); }
    x0 = null; pausado = false; autoplay();
  });

  /* recalcula medidas si cambia el tamaño de la ventana */
  window.addEventListener('resize', () => { colocar(false); marcar(); });

  colocar(false);
  marcar();
}

/* ===== proyectos: fotos y ventana de detalle ===== */
function iniciarProyectos() {
  const tarjetas = document.querySelectorAll('.proyecto');
  if (!tarjetas.length) return;

  /* si la foto todavia no existe, se muestra el fondo de color */
  document.querySelectorAll('.thumb img').forEach(img => {
    const ocultar = () => img.classList.add('sin-foto');
    img.addEventListener('error', ocultar);
    if (img.complete && img.naturalWidth === 0) ocultar();
  });

  /* ventana de detalle, se crea una sola vez y se reutiliza */
  const modal = document.createElement('div');
  modal.className = 'modal';
  modal.hidden = true;
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-labelledby', 'modal-titulo');
  modal.innerHTML = `
    <div class="modal-fondo"></div>
    <div class="modal-caja">
      <button class="modal-cerrar" type="button" aria-label="Cerrar"><i class="fa-solid fa-xmark"></i></button>
      <div class="modal-foto"><i class="fa-regular fa-image"></i><img alt=""></div>
      <div class="modal-cuerpo" tabindex="0">
        <span class="etiqueta"></span>
        <h2 id="modal-titulo"></h2>
        <div class="modal-desc"></div>
      </div>
      <div class="modal-pie">
        <a class="btn btn-oscuro" target="_blank" rel="noopener">Visitar sitio <i class="fa-solid fa-arrow-up-right-from-square"></i></a>
      </div>
    </div>`;
  document.body.appendChild(modal);

  const caja = modal.querySelector('.modal-caja');
  const foto = modal.querySelector('.modal-foto');
  const imgModal = foto.querySelector('img');
  const btnCerrar = modal.querySelector('.modal-cerrar');
  const boton = modal.querySelector('.modal-pie a');
  imgModal.addEventListener('error', () => imgModal.classList.add('sin-foto'));

  let activa = null, cerrando = false;

  /* crece desde el centro de la tarjeta que se clickeo */
  const origen = card => {
    const c = card.getBoundingClientRect();
    caja.style.transformOrigin =
      (c.left + c.width / 2 - caja.offsetLeft) + 'px ' + (c.top + c.height / 2 - caja.offsetTop) + 'px';
  };

  const abrir = card => {
    activa = card;
    const thumb = card.querySelector('.thumb');
    const img = thumb.querySelector('img');
    foto.className = 'modal-foto ' + [...thumb.classList].filter(c => /^t\d+$/.test(c)).join(' ');
    imgModal.classList.remove('sin-foto');
    if (img && !img.classList.contains('sin-foto')) {
      imgModal.src = img.getAttribute('src');
      imgModal.alt = img.alt;
    } else {
      imgModal.removeAttribute('src');
      imgModal.classList.add('sin-foto');
    }
    modal.querySelector('.etiqueta').textContent = card.querySelector('.etiqueta').textContent;
    modal.querySelector('h2').textContent = card.querySelector('h3').textContent;
    modal.querySelector('.modal-desc').innerHTML = card.querySelector('.proyecto-detalle').innerHTML;
    boton.href = card.dataset.url || '#';
    modal.querySelector('.modal-cuerpo').scrollTop = 0;
    modal.hidden = false;
    document.documentElement.classList.add('modal-abierto');
    origen(card);
    void modal.offsetWidth; /* fuerza el estado inicial antes de animar */
    modal.classList.add('abierto');
    btnCerrar.focus({ preventScroll: true });
  };

  const cerrar = () => {
    if (!activa || cerrando) return;
    cerrando = true;
    const card = activa;
    origen(card);
    modal.classList.remove('abierto');
    setTimeout(() => {
      modal.hidden = true;
      document.documentElement.classList.remove('modal-abierto');
      cerrando = false;
      activa = null;
      card.focus({ preventScroll: true });
    }, 420);
  };

  tarjetas.forEach(t => {
    t.addEventListener('click', () => abrir(t));
    t.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); abrir(t); }
    });
  });
  btnCerrar.addEventListener('click', cerrar);
  modal.querySelector('.modal-fondo').addEventListener('click', cerrar);

  /* escape cierra y el tab no se escapa de la ventana */
  document.addEventListener('keydown', e => {
    if (modal.hidden) return;
    if (e.key === 'Escape') cerrar();
    if (e.key === 'Tab') {
      const f = [...caja.querySelectorAll('button, a[href], [tabindex="0"]')];
      const primero = f[0], ultimo = f[f.length - 1];
      if (e.shiftKey && document.activeElement === primero) { e.preventDefault(); ultimo.focus(); }
      else if (!e.shiftKey && document.activeElement === ultimo) { e.preventDefault(); primero.focus(); }
    }
  });
}
