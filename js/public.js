// Página pública: días, horarios y reserva individual.
import { api, DEMO } from './api.js';
import { CONFIG } from './config.js';
import {
  STATUS_LABEL, addDays, availabilityText, capitalize, cleanName, dayNumber, debounce, formatLongDate, h, icon,
  isValidDocument, isValidName, monthShort, normalizeDocument, toAppError, toast, weekdayShort,
} from './utils.js';

const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  slots: [],
  selectedDate: null,
  loading: true,
  error: null,
};

let booking = null; // reserva en curso: { slotId, submitting }
const dialog = $('booking-dialog');

// ---------------------------------------------------------------------
// Datos
// ---------------------------------------------------------------------

let refreshToken = 0;
async function refresh() {
  const token = ++refreshToken;
  try {
    const config = await api.getConfig();
    const slots = await api.getAvailability(config.today, addDays(config.today, config.horizonDays));
    if (token !== refreshToken) return; // llegó una respuesta más nueva
    const firstLoad = !state.config;
    state.config = config;
    state.slots = slots;
    state.error = null;
    const last = addDays(config.today, config.horizonDays);
    if (!state.selectedDate || state.selectedDate < config.today || state.selectedDate > last) {
      state.selectedDate = state.slots.find((s) => s.status === 'disponible')?.date ?? config.today;
    }
    state.loading = false;
    render();
    if (firstLoad) scrollSelectedIntoView();
  } catch (err) {
    if (token !== refreshToken) return;
    state.error = toAppError(err).message;
    state.loading = false;
    render();
  }
  updateBookingAvailability();
}

const slotsOn = (date) => state.slots.filter((s) => s.date === date);
const findSlot = (id) => state.slots.find((s) => s.id === id);

function daySummary(date) {
  const list = slotsOn(date);
  const note = list.find((s) => s.note)?.note ?? null;
  const open = list.filter((s) => s.status === 'disponible');
  const free = open.reduce((sum, s) => sum + s.available, 0);
  return { list, note, free, openCount: open.length };
}

// ---------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------

function render() {
  renderDays();
  renderSlots();
}

function renderDays() {
  const root = $('days');
  if (!state.config) {
    root.replaceChildren(...Array.from({ length: 7 }, () => h('div', { class: 'skeleton', style: 'flex: 0 0 96px; height: 128px; border-radius: 18px' })));
    return;
  }
  const { today, horizonDays } = state.config;
  $('horizon-note').textContent = `Podés reservar con hasta ${horizonDays} ${horizonDays === 1 ? 'día' : 'días'} de anticipación.`;

  const days = [];
  for (let d = today; d <= addDays(today, horizonDays); d = addDays(d, 1)) days.push(d);

  root.replaceChildren(...days.map((date) => {
    const { list, note, free } = daySummary(date);
    let kind = 'ok';
    let meta = `${free} ${free === 1 ? 'lugar' : 'lugares'}`;
    if (note) { kind = 'closed'; meta = note; }
    else if (!list.length) { kind = 'none'; meta = 'Sin turnos'; }
    else if (!free) { kind = 'full'; meta = 'Completo'; }
    const selectable = kind !== 'none';
    const label = `${formatLongDate(date)}: ${note ? `cerrado (${note})` : !list.length ? 'sin turnos' : free ? `${free} lugares disponibles` : 'sin lugares disponibles'}`;
    return h('button', {
      type: 'button',
      class: `day day--${kind}`,
      'aria-pressed': String(date === state.selectedDate),
      'aria-label': label,
      'aria-disabled': selectable ? null : 'true',
      dataset: { date },
      onclick: () => {
        if (!selectable) return;
        state.selectedDate = date;
        render();
      },
    },
    h('span', { class: 'day__dow' }, date === today ? 'Hoy' : weekdayShort(date)),
    h('span', { class: 'day__num' }, dayNumber(date)),
    h('span', { class: 'day__month' }, monthShort(date)),
    h('span', { class: 'day__meta' }, meta));
  }));
}

function scrollSelectedIntoView() {
  const el = $('days').querySelector('[aria-pressed="true"]');
  if (el) $('days').scrollLeft = Math.max(0, el.offsetLeft - $('days').offsetLeft - 28);
}

function renderSlots() {
  const root = $('slots');
  if (state.loading) {
    root.replaceChildren(h('div', { class: 'slot-grid' },
      Array.from({ length: 6 }, () => h('div', { class: 'skeleton', style: 'height: 150px; border-radius: 18px' }))));
    return;
  }
  if (state.error && !state.config) {
    root.replaceChildren(
      h('div', { class: 'notice notice--danger', role: 'alert' }, icon('alert'),
        h('div', null, h('strong', null, 'No pudimos cargar los horarios. '), state.error),
        h('button', { type: 'button', class: 'btn btn--ghost btn--sm notice__action', onclick: () => { state.loading = true; render(); refresh(); } }, 'Reintentar')),
    );
    return;
  }

  const date = state.selectedDate;
  const { list, note, free, openCount } = daySummary(date);
  $('slots-title').textContent = capitalize(formatLongDate(date));
  $('slots-sub').textContent = note ? 'Cerrado'
    : !list.length ? 'Sin horarios'
      : `${openCount} ${openCount === 1 ? 'horario' : 'horarios'} con lugar · ${free} ${free === 1 ? 'lugar libre' : 'lugares libres'}`;

  const content = [];
  if (state.error) {
    content.push(h('div', { class: 'notice notice--danger', role: 'alert', style: 'margin-bottom: 16px' }, icon('alert'),
      h('div', null, 'No se pudo actualizar la disponibilidad. Reintentando…')));
  }

  if (note) {
    content.push(h('div', { class: 'notice notice--warn' }, icon('ban'),
      h('div', null, h('strong', null, `Este día no hay pileta libre: ${note}.`), h('br'), 'Elegí otro día para reservar.')));
  } else if (!list.length) {
    content.push(h('div', { class: 'empty' }, icon('calendar', 32),
      h('strong', null, 'No hay horarios este día'), h('span', null, 'Elegí otro día de la lista.')));
  } else {
    const groups = [
      { title: 'Mañana', icon: 'sun', test: (s) => s.start < '12:00' },
      { title: 'Tarde', icon: 'sunset', test: (s) => s.start >= '12:00' && s.start < '19:00' },
      { title: 'Noche', icon: 'moon', test: (s) => s.start >= '19:00' },
    ];
    for (const g of groups) {
      const items = list.filter(g.test);
      if (!items.length) continue;
      content.push(h('div', { class: 'slot-group' },
        h('h3', { class: 'slot-group__title' }, icon(g.icon, 18), g.title),
        h('ul', { class: 'slot-grid' }, items.map(renderSlot))));
    }
  }
  root.replaceChildren(...content);
}

function renderSlot(slot) {
  const open = slot.status === 'disponible';
  const few = open && slot.available <= 3;
  const pct = slot.capacity ? Math.round(((slot.capacity - slot.available) / slot.capacity) * 100) : 100;
  const meterClass = `meter${pct >= 100 ? ' meter--full' : pct >= 80 ? ' meter--warn' : ''}`;
  const stateIcon = { lleno: 'users', cerrado: 'lock', finalizado: 'clock' }[slot.status];

  return h('li', { class: `slot slot--${slot.status}${few ? ' slot--few' : ''}` },
    h('div', { class: 'slot__top' },
      h('span', { class: 'slot__time' }, slot.start),
      h('span', { class: 'slot__end' }, `a ${slot.end}`)),
    (open || slot.status === 'lleno') && h('div', { class: meterClass, 'aria-hidden': 'true' }, h('span', { style: `width: ${Math.min(pct, 100)}%` })),
    open
      ? [
        h('div', { class: 'slot__avail' }, h('span', { class: 'dot' }),
          h('span', null, availabilityText(slot), few && h('span', { class: 'hide-sm' }, ' · ¡Últimos!'))),
        h('button', {
          type: 'button', class: 'btn btn--primary btn--block',
          'aria-label': `Reservar de ${slot.start} a ${slot.end}, ${availabilityText(slot)}`,
          onclick: () => openBooking(slot.id),
        }, 'Reservar'),
      ]
      : h('div', { class: 'slot__state' }, icon(stateIcon, 18), STATUS_LABEL[slot.status]),
  );
}

function renderInfo() {
  const item = (ic, title, text) => h('div', { class: 'info__item' },
    h('span', { class: 'info__icon' }, icon(ic, 22)),
    h('div', null, h('strong', null, title), h('p', null, text)));
  $('info').replaceChildren(
    item('user', 'Una reserva, una persona', 'Si querés anotar a alguien más, hacé otra reserva con sus datos.'),
    item('id', 'Traé tu documento', 'Te lo pueden pedir al ingresar para verificar tu reserva.'),
    item('clock', 'Lugares en tiempo real', 'La disponibilidad se actualiza sola mientras mirás la página.'),
  );
}

// ---------------------------------------------------------------------
// Diálogo de reserva
// ---------------------------------------------------------------------

function field({ id, label, autocomplete, hint, ic, placeholder }) {
  return h('div', { class: 'field' },
    h('label', { for: id }, label),
    h('div', { class: 'input-icon' },
      icon(ic, 19),
      h('input', {
        id, name: id, class: 'input', type: 'text', required: true, maxlength: id === 'f-doc' ? '20' : '60',
        autocomplete, placeholder, spellcheck: 'false',
        'aria-describedby': `${id}-error${hint ? ` ${id}-hint` : ''}`,
      })),
    hint && h('span', { class: 'hint', id: `${id}-hint` }, hint),
    h('span', { class: 'error', id: `${id}-error`, 'aria-live': 'polite' }),
  );
}

function openBooking(slotId) {
  booking = { slotId, submitting: false };
  const form = h('form', { id: 'booking-form', novalidate: true, onsubmit: submitBooking },
    h('div', { id: 'booking-chosen', class: 'chosen' }),
    h('div', { id: 'booking-alert', class: 'notice notice--danger', role: 'alert', hidden: true, style: 'margin-bottom: 16px' }),
    field({ id: 'f-first', label: 'Nombre', autocomplete: 'given-name', ic: 'user', placeholder: 'Ej.: Ana' }),
    field({ id: 'f-last', label: 'Apellido', autocomplete: 'family-name', ic: 'user', placeholder: 'Ej.: Pérez' }),
    field({ id: 'f-doc', label: 'Número de documento', autocomplete: 'off', ic: 'id', placeholder: 'Ej.: 30123456', hint: 'Con o sin puntos. Si tenés pasaporte, podés usar letras.' }),
    h('p', { class: 'note' }, icon('info', 18),
      h('span', null, 'Esta reserva es para una sola persona. Si querés anotar a otra, vas a poder hacer otra reserva con sus datos.')),
    h('div', { class: 'dialog__actions' },
      h('button', { type: 'button', class: 'btn btn--ghost', onclick: closeBooking }, 'Cancelar'),
      h('button', { type: 'submit', id: 'booking-submit', class: 'btn btn--primary' }, 'Confirmar reserva')),
  );

  dialog.replaceChildren(
    h('div', { class: 'dialog__head' },
      h('div', null,
        h('span', { class: 'eyebrow' }, h('b', null, '3'), 'Tus datos'),
        h('h2', { class: 'dialog__title', id: 'booking-title', style: 'margin-top: 4px' }, 'Completá la reserva')),
      h('button', { type: 'button', class: 'btn btn--plain btn--icon', 'aria-label': 'Cerrar', onclick: closeBooking }, icon('x'))),
    h('div', { class: 'dialog__body' }, form),
  );
  if (!dialog.open) dialog.showModal();
  updateBookingAvailability();
  $('f-first').focus();
}

// Mantiene el resumen del turno al día mientras el diálogo está abierto
// (por ejemplo, si otra persona toma el último lugar).
function updateBookingAvailability() {
  if (!booking || !dialog.open || !$('booking-chosen')) return;
  const slot = findSlot(booking.slotId);
  const available = slot?.status === 'disponible';
  if (slot) {
    const item = (ic, label, value) => h('div', { class: 'chosen__item' }, icon(ic),
      h('div', null, h('div', { class: 'chosen__label' }, label), h('div', { class: 'chosen__value' }, value)));
    $('booking-chosen').replaceChildren(
      item('calendar', 'Día', capitalize(formatLongDate(slot.date))),
      item('clock', 'Horario', `${slot.start} a ${slot.end}`),
      h('div', { class: `chosen__avail${available ? '' : ' is-off'}` }, h('span', { class: 'dot' }), availabilityText(slot)),
    );
  }
  const alert = $('booking-alert');
  if (!available) {
    const reason = !slot ? 'ya no existe' : slot.note ? `está cerrado (${slot.note})` : `ya no admite reservas (${STATUS_LABEL[slot.status].toLowerCase()})`;
    showFormAlert(`Este horario ${reason}. Cerrá esta ventana y elegí otro.`);
  } else if (alert.dataset.kind === 'availability') {
    alert.hidden = true;
  }
  $('booking-submit').disabled = !available || booking.submitting;
}

function showFormAlert(message, kind = 'availability') {
  const alert = $('booking-alert');
  alert.replaceChildren(icon('alert'), h('div', null, message));
  alert.dataset.kind = kind;
  alert.hidden = false;
}

function setFieldError(id, message) {
  $(id).setAttribute('aria-invalid', message ? 'true' : 'false');
  $(`${id}-error`).textContent = message ?? '';
}

async function submitBooking(event) {
  event.preventDefault();
  if (!booking || booking.submitting) return;

  const firstName = cleanName($('f-first').value);
  const lastName = cleanName($('f-last').value);
  const document = normalizeDocument($('f-doc').value);

  const errors = {
    'f-first': !firstName ? 'Ingresá tu nombre.' : !isValidName(firstName) ? 'Usá entre 2 y 60 letras, sin números.' : null,
    'f-last': !lastName ? 'Ingresá tu apellido.' : !isValidName(lastName) ? 'Usá entre 2 y 60 letras, sin números.' : null,
    'f-doc': !document ? 'Ingresá tu número de documento.' : !isValidDocument(document) ? 'Revisá el documento: entre 6 y 12 números (o letras y números si es pasaporte).' : null,
  };
  Object.entries(errors).forEach(([id, msg]) => setFieldError(id, msg));
  const firstInvalid = Object.keys(errors).find((id) => errors[id]);
  if (firstInvalid) {
    $(firstInvalid).focus();
    return;
  }

  booking.submitting = true;
  const button = $('booking-submit');
  button.disabled = true;
  button.textContent = 'Reservando…';
  $('booking-alert').hidden = true;

  try {
    const result = await api.book(booking.slotId, { firstName, lastName, document });
    showSuccess(result);
    refresh();
  } catch (err) {
    const e = toAppError(err);
    const fieldFor = { INVALID_FIRST_NAME: 'f-first', INVALID_LAST_NAME: 'f-last', INVALID_DOCUMENT: 'f-doc', DUPLICATE: 'f-doc' }[e.code];
    if (fieldFor) {
      setFieldError(fieldFor, e.message);
      $(fieldFor).focus();
    } else {
      showFormAlert(e.message, 'error');
    }
    if (['SLOT_FULL', 'SLOT_CLOSED', 'DAY_CLOSED', 'SLOT_FINISHED', 'SLOT_NOT_FOUND', 'OUT_OF_RANGE'].includes(e.code)) refresh();
  } finally {
    if (booking) booking.submitting = false;
    if ($('booking-submit')) {
      $('booking-submit').textContent = 'Confirmar reserva';
      updateBookingAvailability();
    }
  }
}

function showSuccess(r) {
  const slotId = booking.slotId;
  const row = (label, value, wide) => h('div', { class: wide ? 'wide' : null }, h('dt', null, label), h('dd', null, value));
  dialog.replaceChildren(h('div', { class: 'ticket' },
    h('div', { class: 'ticket__head' },
      h('div', { class: 'ticket__check' }, icon('check', 32)),
      h('h2', { id: 'booking-title' }, '¡Listo, tenés tu lugar!'),
      h('p', null, 'Te esperamos. Presentate con tu documento.')),
    h('div', { class: 'ticket__tear', 'aria-hidden': 'true' }),
    h('div', { class: 'ticket__body' },
      h('dl', { class: 'ticket__grid' },
        row('Día', capitalize(formatLongDate(r.date)), true),
        row('Horario', `${r.start} a ${r.end}`),
        row('Documento', r.document),
        row('Nombre y apellido', `${r.firstName} ${r.lastName}`, true)),
      h('div', { class: 'ticket__code' }, h('span', null, 'Código de reserva'), h('strong', null, r.code)),
      h('p', { class: 'note' }, icon('info', 18), h('span', null, 'Sacale una captura a esta pantalla para tenerla a mano.')),
      h('div', { class: 'dialog__actions' },
        h('button', {
          type: 'button', class: 'btn btn--ghost',
          onclick: () => {
            if (findSlot(slotId)?.status === 'disponible') openBooking(slotId);
            else {
              closeBooking();
              toast('Ese horario ya no tiene lugares. Elegí otro.', 'error');
            }
          },
        }, icon('plus', 18), 'Reservar para otra persona'),
        h('button', { type: 'button', class: 'btn btn--primary', onclick: closeBooking }, 'Listo'))),
  ));
  dialog.querySelector('.dialog__actions .btn--primary').focus();
}

function closeBooking() {
  booking = null;
  if (dialog.open) dialog.close();
}

// Escape o cierre del navegador.
dialog.addEventListener('cancel', () => { booking = null; });
dialog.addEventListener('close', () => { booking = null; });

// ---------------------------------------------------------------------
// Inicio
// ---------------------------------------------------------------------

$('site-title').textContent = CONFIG.nombreComplejo;
$('footer-name').textContent = CONFIG.nombreComplejo;
if (CONFIG.subtitulo) $('site-subtitle').textContent = CONFIG.subtitulo;
document.title = `Turnos · ${CONFIG.nombreComplejo}`;
$('brand-mark').append(icon('wave', 24));
$('days-prev').append(icon('chevronLeft'));
$('days-next').append(icon('chevronRight'));
$('days-prev').addEventListener('click', () => $('days').scrollBy({ left: -320, behavior: 'smooth' }));
$('days-next').addEventListener('click', () => $('days').scrollBy({ left: 320, behavior: 'smooth' }));
if (DEMO) $('demo-banner').hidden = false;

renderInfo();
render();
await refresh();

const refreshSoon = debounce(refresh, 250);
api.onSlotsChange(refreshSoon);
setInterval(refresh, 60_000); // respaldo, y para que los turnos pasen a "Finalizado"
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});
