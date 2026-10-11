// Panel de administración: turnos del día, reservas, horario semanal y días cerrados.
import { api, DEMO } from './api.js';
import { CONFIG } from './config.js';
import {
  STATUS_LABEL, WEEKDAYS, WEEKDAY_ORDER, addDays, capitalize, confirmDialog, dayNumber, debounce, formatDateTime,
  formatLongDate, formatShortDate, h, icon, monthShort, toAppError, toast,
} from './utils.js';

const $ = (id) => document.getElementById(id);
const view = $('view');

const state = {
  config: null,
  tab: 'day',
  date: null,
  expanded: new Set(), // turnos con la lista de anotados abierta
};

const toMinutes = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const fromMinutes = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const fullName = (r) => `${r.firstName} ${r.lastName}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const weekdayPlural = (wd) => (wd === 0 || wd === 6 ? `${WEEKDAYS[wd].toLowerCase()}s` : WEEKDAYS[wd].toLowerCase());

// Ejecuta una acción mostrando el error (si lo hay) como aviso.
async function run(action, successMessage) {
  try {
    const result = await action();
    if (successMessage) toast(typeof successMessage === 'function' ? successMessage(result) : successMessage, 'success');
    return { ok: true, result };
  } catch (err) {
    toast(toAppError(err).message, 'error');
    return { ok: false };
  }
}

// Deshabilita un botón mientras corre una acción.
async function busy(button, fn) {
  if (button) button.disabled = true;
  try {
    return await fn();
  } finally {
    if (button) button.disabled = false;
  }
}

const btn = (label, { kind = 'ghost', size = 'sm', ic, onclick, title, disabled, type = 'button', attrs = {} } = {}) =>
  h('button', { type, class: `btn btn--${kind}${size ? ` btn--${size}` : ''}${label ? '' : ' btn--icon'}`, onclick, title, 'aria-label': label ? null : title, disabled, ...attrs },
    ic && icon(ic, size === 'sm' ? 17 : 19), label);

// ---------------------------------------------------------------------
// Sesión
// ---------------------------------------------------------------------

function showLogin(message) {
  $('session-box').hidden = true;
  const alert = h('div', { class: 'notice notice--danger', role: 'alert', hidden: !message, style: 'margin-bottom: 16px' }, icon('alert'), h('div', { class: 'msg' }, message ?? ''));
  const setAlert = (text) => {
    alert.querySelector('.msg').textContent = text;
    alert.hidden = false;
  };
  const form = h('form', {
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      const email = form.email.value.trim();
      const password = form.password.value;
      if (!email || !password) return setAlert('Completá el email y la contraseña.');
      const button = form.querySelector('button[type=submit]');
      button.disabled = true;
      button.textContent = 'Ingresando…';
      try {
        await api.signIn(email, password);
        await enter();
      } catch (err) {
        setAlert(toAppError(err).message);
        button.disabled = false;
        button.textContent = 'Ingresar';
      }
    },
  },
  alert,
  h('div', { class: 'field' },
    h('label', { for: 'email' }, 'Email'),
    h('input', { id: 'email', name: 'email', type: 'email', class: 'input', autocomplete: 'username', required: true })),
  h('div', { class: 'field' },
    h('label', { for: 'password' }, 'Contraseña'),
    h('input', { id: 'password', name: 'password', type: 'password', class: 'input', autocomplete: 'current-password', required: true })),
  h('button', { type: 'submit', class: 'btn btn--primary btn--block', style: 'margin-top: 20px' }, 'Ingresar'));

  view.replaceChildren(h('section', { class: 'card login', 'aria-labelledby': 'login-title' },
    h('span', { class: 'brand__mark', style: 'background: linear-gradient(140deg, var(--hero-2), var(--hero-3)); color: #fff' }, icon('lock', 24)),
    h('h1', { class: 'card__title', id: 'login-title', style: 'font-size: 1.5rem' }, 'Ingresar al panel'),
    h('p', { class: 'card__subtitle', style: 'margin-bottom: 20px' }, 'Solo para el personal autorizado del complejo.'),
    form));
  form.email.focus();
}

async function enter() {
  const session = await api.getSession();
  if (!session) return showLogin();
  let allowed = false;
  try {
    allowed = await api.isAdmin();
  } catch (err) {
    return showLogin(toAppError(err).message);
  }
  $('session-email').textContent = session.email;
  $('session-avatar').textContent = session.email.slice(0, 1).toUpperCase();
  $('session-box').hidden = false;
  if (!allowed) {
    view.replaceChildren(h('section', { class: 'card login' },
      h('h1', { class: 'card__title' }, 'Sin permiso'),
      h('p', { class: 'card__subtitle', style: 'margin: 6px 0 18px' },
        `El usuario ${session.email} no está autorizado para usar el panel. Pedile a quien administra el sistema que lo agregue.`),
      btn('Cerrar sesión', { size: '', onclick: logout })));
    return;
  }
  state.config = await api.getConfig();
  state.date ??= state.config.today;
  showApp();
}

async function logout() {
  $('session-box').hidden = true;
  await api.signOut();
  showLogin();
}

// ---------------------------------------------------------------------
// Estructura con pestañas
// ---------------------------------------------------------------------

const TABS = [
  { id: 'day', label: 'Turnos del día', ic: 'calendar', render: renderDayTab },
  { id: 'reservations', label: 'Reservas', ic: 'search', render: renderReservationsTab },
  { id: 'week', label: 'Horario semanal', ic: 'clock', render: renderWeekTab },
  { id: 'closed', label: 'Días cerrados', ic: 'ban', render: renderClosedTab },
];

let panel;
function showApp() {
  panel = h('div', { id: 'tab-panel', role: 'tabpanel' });
  const nav = h('nav', { class: 'nav', role: 'tablist', 'aria-label': 'Secciones del panel' },
    TABS.map((t) => h('button', {
      type: 'button', role: 'tab', class: 'nav__tab', id: `tab-${t.id}`, 'aria-selected': String(state.tab === t.id),
      'aria-controls': 'tab-panel', onclick: () => goTo(t.id),
    }, icon(t.ic, 18), t.label)));
  view.replaceChildren(nav, panel);
  goTo(state.tab);
}

function goTo(tabId) {
  state.tab = tabId;
  document.querySelectorAll('.nav__tab').forEach((b) => b.setAttribute('aria-selected', String(b.id === `tab-${tabId}`)));
  TABS.find((t) => t.id === tabId).render(panel);
}

// ---------------------------------------------------------------------
// Pestaña: turnos del día
// ---------------------------------------------------------------------

let refreshDay = () => {};

function renderDayTab(root) {
  const dateInput = h('input', {
    type: 'date', class: 'input', value: state.date, 'aria-label': 'Elegir fecha',
    onchange: () => {
      if (!dateInput.value) return;
      state.date = dateInput.value;
      load();
    },
  });
  const setDate = (date) => {
    state.date = date;
    dateInput.value = date;
    load();
  };
  const title = h('h2', { class: 'day-title' });
  const subtitle = h('p', { class: 'card__subtitle' });
  const dayNotice = h('div');
  const stats = h('div', { class: 'stats' });
  const list = h('div', { 'aria-live': 'polite' });
  const hiddenBox = h('div');

  const addForm = h('form', {
    class: 'form-row',
    onsubmit: async (e) => {
      e.preventDefault();
      const button = addForm.querySelector('button[type=submit]');
      const capacity = Number(addForm.capacity.value);
      await busy(button, async () => {
        const { ok } = await run(
          () => api.createSlot({ date: state.date, start: addForm.start.value, end: addForm.end.value, capacity }),
          'Horario agregado a este día.');
        if (ok) {
          addForm.reset();
          load();
        }
      });
    },
  },
  h('div', { class: 'field' }, h('label', { for: 'new-start' }, 'Desde'), h('input', { id: 'new-start', name: 'start', type: 'time', class: 'input', required: true, step: '300' })),
  h('div', { class: 'field' }, h('label', { for: 'new-end' }, 'Hasta'), h('input', { id: 'new-end', name: 'end', type: 'time', class: 'input', required: true, step: '300' })),
  h('div', { class: 'field' }, h('label', { for: 'new-cap' }, 'Capacidad'), h('input', { id: 'new-cap', name: 'capacity', type: 'number', class: 'input input--num', min: '1', max: '1000', value: '20', required: true })),
  btn('Agregar horario', { kind: 'primary', size: '', ic: 'plus', type: 'submit' }));

  root.replaceChildren(
    h('section', { class: 'card' },
      h('div', { class: 'card__head' },
        h('div', null, h('span', { class: 'eyebrow' }, 'Turnos del día'), title, subtitle),
        h('div', { class: 'datebar' },
          btn(null, { size: '', ic: 'chevronLeft', title: 'Día anterior', onclick: () => setDate(addDays(state.date, -1)) }),
          dateInput,
          btn(null, { size: '', ic: 'chevronRight', title: 'Día siguiente', onclick: () => setDate(addDays(state.date, 1)) }),
          btn('Hoy', { size: '', onclick: () => setDate(state.config.today) }))),
      dayNotice,
      stats,
      list,
      hiddenBox),
    h('section', { class: 'card' },
      h('div', { class: 'card__head' },
        h('div', null,
          h('h2', { class: 'card__title' }, 'Agregar un horario solo para este día'),
          h('p', { class: 'card__subtitle' }, 'Para horarios que se repiten todas las semanas usá «Horario semanal».'))),
      addForm),
  );

  let token = 0;
  async function load({ quiet = false } = {}) {
    const my = ++token;
    const date = state.date;
    title.textContent = capitalize(formatLongDate(date));
    subtitle.textContent = date === state.config.today ? 'Hoy' : date < state.config.today ? 'Día pasado' : '';
    if (!quiet) list.replaceChildren(h('div', { class: 'skeleton', style: 'height: 76px' }), h('div', { class: 'skeleton', style: 'height: 76px; margin-top: 10px' }));

    let slots;
    const reservations = new Map();
    try {
      slots = await api.listSlots(date, date);
      const open = slots.filter((s) => state.expanded.has(s.id));
      const lists = await Promise.all(open.map((s) => api.searchReservations({ slotId: s.id })));
      open.forEach((s, i) => reservations.set(s.id, lists[i]));
    } catch (err) {
      if (my !== token) return;
      list.replaceChildren(h('div', { class: 'notice notice--danger', role: 'alert' }, icon('alert'), h('div', null, toAppError(err).message)));
      return;
    }
    if (my !== token) return;

    const visible = slots.filter((s) => !s.hidden);
    const removed = slots.filter((s) => s.hidden);
    const note = slots.find((s) => s.note)?.note ?? null;
    const past = date < state.config.today;

    // Aviso de día cerrado / botón para cerrarlo.
    if (note) {
      dayNotice.replaceChildren(h('div', { class: 'notice notice--warn', style: 'margin-bottom: 18px' }, icon('ban'),
        h('div', null, h('strong', null, `Día cerrado: ${note}.`), h('br'), 'No se aceptan reservas. Las que ya existían siguen en la lista.'),
        !past && btn('Reabrir día', {
          ic: 'unlock', attrs: { class: 'btn btn--ghost btn--sm notice__action' },
          onclick: async (e) => {
            const button = e.currentTarget;
            await busy(button, async () => {
              const { ok } = await run(() => api.openDay(date), 'Día reabierto.');
              if (ok) load({ quiet: true });
            });
          },
        })));
    } else if (!past) {
      dayNotice.replaceChildren(h('div', { style: 'display: flex; justify-content: flex-end; margin: -8px 0 14px' },
        btn('Cerrar este día', { kind: 'danger-ghost', ic: 'ban', onclick: () => openCloseDaysDialog(date, () => load({ quiet: true })) })));
    } else {
      dayNotice.replaceChildren();
    }

    const totals = visible.reduce((t, s) => ({ cap: t.cap + s.capacity, res: t.res + s.reserved }), { cap: 0, res: 0 });
    const stat = (ic, label, value) => h('div', { class: 'stat' }, h('div', { class: 'stat__label' }, icon(ic, 16), label), h('div', { class: 'stat__value' }, value));
    stats.replaceChildren(
      stat('clock', 'Horarios', visible.length),
      stat('users', 'Reservas activas', totals.res),
      stat('check', 'Lugares libres', Math.max(totals.cap - totals.res, 0)),
      stat('list', 'Capacidad total', totals.cap),
    );

    list.replaceChildren(visible.length
      ? h('div', { class: 'rows' }, visible.map((s) => slotRow(s, reservations.get(s.id), () => load({ quiet: true }))))
      : h('div', { class: 'empty' }, icon('calendar', 32), h('strong', null, 'No hay horarios este día'),
        h('span', null, 'Podés agregar uno abajo o cargar el horario semanal.')));

    hiddenBox.replaceChildren(removed.length ? h('div', { style: 'margin-top: 18px' },
      h('p', { class: 'label', style: 'margin-bottom: 8px' }, 'Horarios quitados de este día'),
      h('div', { class: 'chips' }, removed.map((s) => h('span', { class: 'tpl', style: 'padding: 6px 6px 6px 12px' },
        h('span', { class: 'tpl__time' }, `${s.start}–${s.end}`),
        s.templateId && !past && btn('Restaurar', {
          kind: 'soft', ic: 'undo',
          onclick: async (e) => {
            const button = e.currentTarget;
            await busy(button, async () => {
              const { ok } = await run(() => api.resetSlot(s.id), `Horario de las ${s.start} restaurado.`);
              if (ok) load({ quiet: true });
            });
          },
        }))))) : '');
  }

  // Si el admin está escribiendo, se espera a que termine para refrescar.
  let pending = false;
  refreshDay = debounce(() => {
    if (!list.isConnected) return;
    if (list.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') {
      pending = true;
      return;
    }
    load({ quiet: true });
  }, 300);
  list.addEventListener('focusout', () => {
    if (pending) {
      pending = false;
      setTimeout(() => refreshDay(), 200);
    }
  });

  load();
}

function slotRow(slot, reservations, reload) {
  const finished = slot.status === 'finalizado';
  const pct = slot.capacity ? Math.round((slot.reserved / slot.capacity) * 100) : 0;
  const min = Math.max(slot.reserved, 1);

  // Capacidad con botones − / +
  const capInput = h('input', {
    type: 'number', min: String(min), max: '1000', value: String(slot.capacity), disabled: finished,
    'aria-label': `Capacidad de ${slot.start} a ${slot.end}`, inputmode: 'numeric',
  });
  const save = btn('Guardar', { kind: 'primary', disabled: true, onclick: (e) => saveCapacity(e.currentTarget) });
  const sync = () => { save.disabled = finished || Number(capInput.value) === slot.capacity || !capInput.value; };
  capInput.addEventListener('input', sync);
  capInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveCapacity(save); });
  const step = (delta) => {
    capInput.value = String(Math.min(1000, Math.max(min, (Number(capInput.value) || 0) + delta)));
    sync();
  };

  async function saveCapacity(button) {
    const capacity = Number(capInput.value);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000) {
      toast('La capacidad tiene que ser un número entre 1 y 1000.', 'error');
      return;
    }
    if (capacity < slot.reserved) {
      toast(`No podés bajar la capacidad a ${capacity}: ya hay ${slot.reserved} reservas activas.`, 'error');
      return;
    }
    if (capacity === slot.capacity) return;
    await busy(button, async () => {
      const { ok } = await run(() => api.updateSlot(slot.id, { capacity }), `Capacidad de las ${slot.start} cambiada a ${capacity} (solo este día).`);
      if (ok) reload();
    });
  }

  const toggleClosed = async (e) => {
    const button = e.currentTarget; // después de un await, e.currentTarget ya es null
    if (!slot.closed && slot.reserved > 0) {
      const yes = await confirmDialog({
        title: `¿Cerrar el horario de las ${slot.start}?`,
        message: `Las ${slot.reserved} reservas existentes se mantienen, pero no se van a aceptar reservas nuevas.`,
        confirmText: 'Cerrar horario',
      });
      if (!yes) return;
    }
    await busy(button, async () => {
      const { ok } = await run(() => api.updateSlot(slot.id, { closed: !slot.closed }), slot.closed ? 'Horario abierto.' : 'Horario cerrado para este día.');
      if (ok) reload();
    });
  };

  const reset = async (e) => {
    const button = e.currentTarget;
    const yes = await confirmDialog({
      title: '¿Volver al horario semanal?',
      message: 'Se deshacen los cambios hechos solo para este día (capacidad y cierre). La capacidad nunca baja de las reservas activas.',
      confirmText: 'Restablecer',
    });
    if (!yes) return;
    await busy(button, async () => {
      const { ok } = await run(() => api.resetSlot(slot.id), 'Horario restablecido.');
      if (ok) reload();
    });
  };

  const remove = async () => {
    const yes = await confirmDialog({
      title: `¿Quitar el horario de las ${slot.start} de este día?`,
      message: slot.templateId
        ? 'Solo se quita de esta fecha; las demás semanas siguen igual. Lo podés restaurar después.'
        : 'Este horario se había agregado solo para este día.',
      confirmText: 'Quitar', danger: true,
    });
    if (!yes) return;
    const { ok } = await run(() => api.deleteSlot(slot.id), 'Horario quitado de este día.');
    if (ok) reload();
  };

  const expanded = state.expanded.has(slot.id);
  const toggleList = () => {
    if (expanded) state.expanded.delete(slot.id);
    else state.expanded.add(slot.id);
    reload();
  };

  const tags = [
    h('span', { class: `badge badge--${slot.status}` }, STATUS_LABEL[slot.status]),
    slot.customized && slot.templateId && h('span', { class: 'badge badge--custom', title: 'Cambiado solo para esta fecha' }, 'Modificado este día'),
    !slot.templateId && h('span', { class: 'badge badge--custom' }, 'Solo este día'),
  ];

  return h('div', { class: `row${finished ? ' row--muted' : ''}` },
    h('div', null,
      h('div', { class: 'row__time' }, `${slot.start} – ${slot.end}`),
      h('div', { class: 'row__tags' }, tags)),
    h('div', { class: 'row__occ' },
      h('div', { class: 'row__occ-text' }, h('strong', null, slot.reserved), ` de ${slot.capacity} ocupados · `,
        h('strong', null, slot.available), slot.available === 1 ? ' libre' : ' libres'),
      h('div', { class: `meter${pct >= 100 ? ' meter--full' : pct >= 80 ? ' meter--warn' : ''}`, 'aria-hidden': 'true' },
        h('span', { style: `width: ${Math.min(pct, 100)}%` }))),
    h('div', { class: 'row__actions' },
      !finished && h('span', { class: 'stepper', title: 'Capacidad de este día' },
        h('button', { type: 'button', 'aria-label': 'Restar uno', onclick: () => step(-1) }, icon('minus', 16)),
        capInput,
        h('button', { type: 'button', 'aria-label': 'Sumar uno', onclick: () => step(1) }, icon('plus', 16))),
      !finished && save,
      !finished && btn(null, { ic: slot.closed ? 'unlock' : 'lock', title: slot.closed ? 'Abrir horario' : 'Cerrar horario', onclick: toggleClosed }),
      btn(`Anotados (${slot.reserved})`, { kind: expanded ? 'soft' : 'ghost', ic: 'users', onclick: toggleList, attrs: { 'aria-expanded': String(expanded) } }),
      !finished && slot.customized && slot.templateId && btn(null, { ic: 'undo', title: 'Volver al horario semanal', onclick: reset }),
      !finished && slot.reserved === 0 && btn(null, { kind: 'danger-ghost', ic: 'trash', title: 'Quitar de este día', onclick: remove })),
    expanded && h('div', { class: 'row__details' }, reservationsTable(reservations ?? [], reload, { showSlot: false })),
  );
}

// ---------------------------------------------------------------------
// Tabla de reservas
// ---------------------------------------------------------------------

function reservationsTable(rows, reload, { showSlot = true } = {}) {
  if (!rows.length) {
    return h('div', { class: 'empty', style: 'padding: 20px' }, icon('users', 28), h('span', null, 'No hay reservas.'));
  }
  const cancel = async (r, button) => {
    const yes = await confirmDialog({
      title: '¿Cancelar esta reserva?',
      message: `${fullName(r)} · Documento ${r.document} · ${capitalize(formatLongDate(r.date))}, ${r.start} a ${r.end}. Se va a liberar un lugar.`,
      confirmText: 'Sí, cancelar reserva', cancelText: 'No, volver', danger: true,
    });
    if (!yes) return;
    await busy(button, async () => {
      const { ok } = await run(() => api.cancelReservation(r.id), `Reserva de ${fullName(r)} cancelada.`);
      if (ok) reload();
    });
  };

  return h('div', { class: 'table-wrap' },
    h('table', { class: 'table' },
      h('thead', null, h('tr', null,
        h('th', null, 'Nombre y apellido'),
        h('th', null, 'Documento'),
        showSlot && h('th', null, 'Día'),
        showSlot && h('th', null, 'Horario'),
        h('th', null, 'Estado'),
        h('th', null, 'Reservó'),
        h('th', null, h('span', { class: 'sr-only' }, 'Acciones')))),
      h('tbody', null, rows.map((r) => h('tr', null,
        h('td', { class: 'person' }, fullName(r)),
        h('td', { class: 'mono' }, r.document),
        showSlot && h('td', null, formatShortDate(r.date)),
        showSlot && h('td', { class: 'tabular' }, `${r.start}–${r.end}`),
        h('td', null, h('span', { class: `badge badge--${r.status}` }, r.status === 'active' ? 'Activa' : 'Cancelada')),
        h('td', { class: 'muted' }, formatDateTime(r.createdAt)),
        h('td', { style: 'text-align: right' }, r.status === 'active' && btn('Cancelar', {
          kind: 'danger-ghost', onclick: (e) => cancel(r, e.currentTarget),
        })))))));
}

// ---------------------------------------------------------------------
// Pestaña: reservas
// ---------------------------------------------------------------------

const search = { query: '', status: 'active', from: null, to: null };

function renderReservationsTab(root) {
  search.from ??= state.config.today;
  const results = h('div', { 'aria-live': 'polite' });
  const form = h('form', {
    class: 'form-row',
    onsubmit: (e) => {
      e.preventDefault();
      search.query = form.query.value.trim();
      search.status = form.status.value;
      search.from = form.from.value || null;
      search.to = form.to.value || null;
      load();
    },
  },
  h('div', { class: 'field field--grow' },
    h('label', { for: 'q' }, 'Nombre, apellido o documento'),
    h('div', { class: 'input-icon' }, icon('search', 19),
      h('input', { id: 'q', name: 'query', type: 'search', class: 'input', value: search.query, placeholder: 'Ej.: Pérez o 30.123.456' }))),
  h('div', { class: 'field' },
    h('label', { for: 'q-status' }, 'Estado'),
    h('select', { id: 'q-status', name: 'status', class: 'input' },
      [['active', 'Activas'], ['cancelled', 'Canceladas'], ['', 'Todas']].map(([v, l]) =>
        h('option', { value: v, selected: search.status === v }, l)))),
  h('div', { class: 'field' },
    h('label', { for: 'q-from' }, 'Desde'),
    h('input', { id: 'q-from', name: 'from', type: 'date', class: 'input', value: search.from ?? '' })),
  h('div', { class: 'field' },
    h('label', { for: 'q-to' }, 'Hasta'),
    h('input', { id: 'q-to', name: 'to', type: 'date', class: 'input', value: search.to ?? '' })),
  btn('Buscar', { kind: 'primary', size: '', ic: 'search', type: 'submit' }));

  root.replaceChildren(h('section', { class: 'card' },
    h('div', { class: 'card__head' },
      h('div', null,
        h('h2', { class: 'card__title' }, 'Buscar reservas'),
        h('p', { class: 'card__subtitle' }, 'No importan los acentos ni los puntos del documento.'))),
    form,
    h('div', { style: 'margin-top: 20px' }, results)));

  let token = 0;
  async function load() {
    const my = ++token;
    results.replaceChildren(h('div', { class: 'skeleton', style: 'height: 160px' }));
    try {
      const rows = await api.searchReservations({ query: search.query, status: search.status || null, from: search.from, to: search.to });
      if (my !== token) return;
      results.replaceChildren(
        h('p', { class: 'muted', style: 'margin-bottom: 10px; font-weight: 600' },
          rows.length === 500 ? 'Se muestran las primeras 500. Acotá la búsqueda.' : plural(rows.length, 'resultado', 'resultados')),
        reservationsTable(rows, load));
    } catch (err) {
      if (my !== token) return;
      results.replaceChildren(h('div', { class: 'notice notice--danger', role: 'alert' }, icon('alert'), h('div', null, toAppError(err).message)));
    }
  }
  load();
}

// ---------------------------------------------------------------------
// Pestaña: horario semanal
// ---------------------------------------------------------------------

function renderWeekTab(root) {
  const week = h('div', { class: 'week' });

  // --- Carga rápida
  const quick = h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const days = [...quick.querySelectorAll('input[name=wd]:checked')].map((c) => Number(c.value));
      const ranges = quickRanges();
      if (!days.length || !ranges.length) {
        toast('Elegí al menos un día y un rango horario válido.', 'error');
        return;
      }
      const capacity = Number(quick.capacity.value);
      await busy(quick.querySelector('button[type=submit]'), async () => {
        let created = 0;
        let skipped = 0;
        for (const weekday of days) {
          for (const [start, end] of ranges) {
            try {
              await api.saveTemplate({ weekday, start, end, capacity, active: true });
              created++;
            } catch (err) {
              const e2 = toAppError(err);
              if (e2.code === 'TEMPLATE_EXISTS') skipped++;
              else {
                toast(e2.message, 'error');
                loadTemplates();
                return;
              }
            }
          }
        }
        toast(`${created === 1 ? 'Se agregó 1 horario' : `Se agregaron ${created} horarios`}${skipped ? ` (${skipped} ya existían)` : ''}.`, 'success');
        loadTemplates();
      });
    },
  },
  h('div', { class: 'field' },
    h('span', { class: 'label' }, 'Días'),
    h('div', { class: 'chips' }, WEEKDAY_ORDER.map((wd) => h('label', { class: 'chip-check' },
      h('input', { type: 'checkbox', name: 'wd', value: String(wd), checked: wd >= 1 && wd <= 5 }),
      h('span', null, WEEKDAYS[wd]))))),
  h('div', { class: 'form-grid', style: 'margin-top: 14px' },
    h('div', { class: 'field' }, h('label', { for: 'q-start' }, 'Desde'), h('input', { id: 'q-start', name: 'start', type: 'time', class: 'input', value: '08:00', step: '300' })),
    h('div', { class: 'field' }, h('label', { for: 'q-end' }, 'Hasta'), h('input', { id: 'q-end', name: 'end', type: 'time', class: 'input', value: '21:00', step: '300' })),
    h('div', { class: 'field' }, h('label', { for: 'q-len' }, 'Cada turno dura'),
      h('select', { id: 'q-len', name: 'slotLength', class: 'input' },
        [30, 45, 60, 90, 120].map((m) => h('option', { value: String(m), selected: m === 60 }, `${m} minutos`)))),
    h('div', { class: 'field' }, h('label', { for: 'q-cap' }, 'Personas por turno'), h('input', { id: 'q-cap', name: 'capacity', type: 'number', class: 'input', min: '1', max: '1000', value: '20' }))),
  h('div', { class: 'form-row', style: 'margin-top: 16px; justify-content: space-between; align-items: center' },
    h('p', { class: 'hint', id: 'quick-preview' }),
    btn('Agregar horarios', { kind: 'primary', size: '', ic: 'plus', type: 'submit' })));

  function quickRanges() {
    const start = quick.start.value;
    const end = quick.end.value;
    const len = Number(quick.slotLength.value);
    if (!start || !end || toMinutes(end) <= toMinutes(start)) return [];
    const out = [];
    for (let m = toMinutes(start); m + len <= toMinutes(end); m += len) out.push([fromMinutes(m), fromMinutes(m + len)]);
    return out;
  }
  const updatePreview = () => {
    const ranges = quickRanges();
    const days = quick.querySelectorAll('input[name=wd]:checked').length;
    quick.querySelector('#quick-preview').textContent = ranges.length && days
      ? `Se van a crear ${ranges.length * days} horarios: ${ranges.length} por día, de ${ranges[0][0]} a ${ranges.at(-1)[1]}.`
      : 'Revisá los días y el rango horario.';
  };
  quick.addEventListener('input', updatePreview);
  quick.addEventListener('change', updatePreview);

  // --- Días de anticipación
  const horizonForm = h('form', {
    class: 'form-row',
    onsubmit: async (e) => {
      e.preventDefault();
      const horizonDays = Number(horizonForm.horizon.value);
      await busy(horizonForm.querySelector('button'), async () => {
        const { ok } = await run(() => api.updateSettings({ horizonDays }), 'Días de anticipación guardados.');
        if (ok) state.config = await api.getConfig();
      });
    },
  },
  h('div', { class: 'field' },
    h('label', { for: 'horizon' }, 'Días de anticipación'),
    h('input', { id: 'horizon', name: 'horizon', type: 'number', class: 'input input--num', min: '1', max: '90', value: String(state.config.horizonDays) })),
  btn('Guardar', { size: '', type: 'submit' }));

  root.replaceChildren(
    h('section', { class: 'card' },
      h('div', { class: 'card__head' },
        h('div', null,
          h('h2', { class: 'card__title' }, 'Horario semanal'),
          h('p', { class: 'card__subtitle' },
            'Se repite todas las semanas: lo que cargues para el lunes vale para todos los lunes. Los cambios se aplican a todas las fechas futuras, salvo a los días que modificaste a mano en «Turnos del día».'))),
      week),
    h('div', { class: 'grid-2' },
      h('section', { class: 'card' },
        h('div', { class: 'card__head' },
          h('div', null,
            h('h2', { class: 'card__title' }, 'Carga rápida'),
            h('p', { class: 'card__subtitle' }, 'Crea varios horarios seguidos para los días elegidos.'))),
        quick),
      h('section', { class: 'card' },
        h('div', { class: 'card__head' },
          h('div', null,
            h('h2', { class: 'card__title' }, 'Reservas anticipadas'),
            h('p', { class: 'card__subtitle' }, 'Hasta cuántos días antes puede reservar el público. Por ejemplo, 7 = desde hoy hasta dentro de una semana.'))),
        horizonForm)),
  );
  updatePreview();

  let templates = [];
  let editing = null; // id en edición, o `new:<weekday>`

  async function loadTemplates() {
    try {
      templates = await api.listTemplates();
    } catch (err) {
      week.replaceChildren(h('div', { class: 'notice notice--danger', role: 'alert' }, icon('alert'), h('div', null, toAppError(err).message)));
      return;
    }
    renderWeek();
  }

  function renderWeek() {
    week.replaceChildren(...WEEKDAY_ORDER.map((wd) => {
      const items = templates.filter((t) => t.weekday === wd);
      const total = items.filter((t) => t.active).reduce((n, t) => n + t.capacity, 0);
      return h('div', { class: 'weekday' },
        h('div', { class: 'weekday__head' },
          h('div', null,
            h('div', { class: 'weekday__name' }, WEEKDAYS[wd]),
            h('div', { class: 'weekday__count' }, items.length ? `${plural(items.length, 'horario', 'horarios')} · ${total} lugares` : 'Sin horarios')),
          btn(null, { kind: 'soft', ic: 'plus', title: `Agregar horario los ${weekdayPlural(wd)}`, onclick: () => { editing = `new:${wd}`; renderWeek(); } })),
        items.map((t) => (editing === t.id ? templateForm(t, wd) : templateItem(t))),
        editing === `new:${wd}` && templateForm(null, wd),
        !items.length && editing !== `new:${wd}` && h('div', { class: 'weekday__empty' }, 'No hay pileta libre este día.'));
    }));
    week.querySelector('.tpl-form input')?.focus();
  }

  function templateItem(t) {
    return h('div', { class: `tpl${t.active ? '' : ' tpl--off'}` },
      h('span', { class: 'tpl__time' }, `${t.start} – ${t.end}`),
      h('span', { class: 'tpl__cap', title: 'Personas por turno' }, icon('users', 15), t.capacity),
      !t.active && h('span', { class: 'badge badge--finalizado' }, 'Pausado'),
      btn(null, { kind: 'plain', ic: 'edit', title: 'Editar', onclick: () => { editing = t.id; renderWeek(); } }),
      btn(null, { kind: 'plain', ic: 'trash', title: 'Eliminar', onclick: () => removeTemplate(t) }));
  }

  function templateForm(t, wd) {
    const form = h('form', {
      class: 'tpl-form',
      onsubmit: async (e) => {
        e.preventDefault();
        const button = form.querySelector('button[type=submit]');
        const values = {
          id: t?.id ?? null, weekday: wd, start: form.start.value, end: form.end.value,
          capacity: Number(form.capacity.value), active: form.active.checked,
        };
        await busy(button, async () => {
          const { ok } = await run(() => api.saveTemplate(values),
            `Horario guardado. Se aplica a todos los ${weekdayPlural(wd)} que vienen.`);
          if (ok) {
            editing = null;
            loadTemplates();
          }
        });
      },
    },
    h('div', { class: 'tpl-form__row' },
      h('div', { class: 'field' }, h('label', { class: 'label' }, 'Desde', h('input', { name: 'start', type: 'time', class: 'input input--sm', value: t?.start ?? '', step: '300', required: true }))),
      h('div', { class: 'field' }, h('label', { class: 'label' }, 'Hasta', h('input', { name: 'end', type: 'time', class: 'input input--sm', value: t?.end ?? '', step: '300', required: true }))),
      h('div', { class: 'field' }, h('label', { class: 'label' }, 'Personas', h('input', { name: 'capacity', type: 'number', class: 'input input--sm', min: '1', max: '1000', value: String(t?.capacity ?? 20), required: true })))),
    h('div', { class: 'form-row', style: 'justify-content: space-between; align-items: center' },
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'active', checked: t?.active ?? true }), 'Activo'),
      h('div', { class: 'form-row', style: 'gap: 6px' },
        btn('Cancelar', { kind: 'plain', onclick: () => { editing = null; renderWeek(); } }),
        btn('Guardar', { kind: 'primary', type: 'submit', ic: 'check' }))));
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        editing = null;
        renderWeek();
      }
    });
    return form;
  }

  async function removeTemplate(t) {
    const yes = await confirmDialog({
      title: `¿Eliminar el horario de los ${weekdayPlural(t.weekday)} a las ${t.start}?`,
      message: 'Se quitan los turnos futuros de este horario que no tengan reservas. Los que ya tienen reservas se conservan.',
      confirmText: 'Eliminar', danger: true,
    });
    if (!yes) return;
    const { ok } = await run(() => api.deleteTemplate(t.id), 'Horario semanal eliminado.');
    if (ok) loadTemplates();
  }

  week.replaceChildren(...Array.from({ length: 6 }, () => h('div', { class: 'skeleton', style: 'height: 180px' })));
  loadTemplates();
}

// ---------------------------------------------------------------------
// Pestaña: días cerrados
// ---------------------------------------------------------------------

const REASONS = ['Feriado', 'Mantenimiento', 'Evento', 'Clima', 'Cerrado'];

// Formulario para cerrar uno o varios días. Se usa en la pestaña y en un diálogo.
function closeDaysForm({ from = '', onDone, onCancel }) {
  const preview = h('p', { class: 'hint', 'aria-live': 'polite' });
  const form = h('form', {
    novalidate: true,
    onsubmit: async (e) => {
      e.preventDefault();
      const button = form.querySelector('button[type=submit]');
      const values = {
        from: form.from.value, to: form.to.value || form.from.value,
        reason: form.reason.value.trim() || 'Cerrado', cancelReservations: form.cancel.checked,
      };
      if (!values.from) {
        toast('Elegí la fecha que querés cerrar.', 'error');
        return;
      }
      const range = values.to === values.from ? formatLongDate(values.from) : `del ${formatShortDate(values.from)} al ${formatShortDate(values.to)}`;
      const count = await countReservations(values.from, values.to);
      const yes = await confirmDialog({
        title: `¿Cerrar ${range}?`,
        message: `Motivo: ${values.reason}. ${count === 0 ? 'No hay reservas en esas fechas.'
          : values.cancelReservations ? `Se van a cancelar ${plural(count, 'reserva', 'reservas')}.`
            : `Hay ${plural(count, 'reserva activa', 'reservas activas')}: se conservan, pero no se aceptan nuevas.`}`,
        confirmText: 'Cerrar días', danger: true,
      });
      if (!yes) return;
      await busy(button, async () => {
        const { ok } = await run(() => api.closeDays(values), ({ days, cancelled }) =>
          `${days === 1 ? 'Se cerró 1 día' : `Se cerraron ${days} días`}${cancelled ? ` y se cancelaron ${plural(cancelled, 'reserva', 'reservas')}` : ''}.`);
        if (ok) onDone?.();
      });
    },
  },
  h('div', { class: 'form-grid' },
    h('div', { class: 'field' }, h('label', { for: 'cd-from' }, 'Fecha'), h('input', { id: 'cd-from', name: 'from', type: 'date', class: 'input', value: from, min: state.config.today, required: true })),
    h('div', { class: 'field' }, h('label', { for: 'cd-to' }, 'Hasta (opcional)'), h('input', { id: 'cd-to', name: 'to', type: 'date', class: 'input', min: state.config.today }))),
  h('div', { class: 'field', style: 'margin-top: 14px' },
    h('label', { for: 'cd-reason' }, 'Motivo'),
    h('input', { id: 'cd-reason', name: 'reason', type: 'text', class: 'input', maxlength: '80', placeholder: 'Ej.: Feriado nacional', list: 'cd-reasons' }),
    h('datalist', { id: 'cd-reasons' }, REASONS.map((r) => h('option', { value: r }))),
    h('div', { class: 'chips', style: 'margin-top: 4px' }, REASONS.slice(0, 4).map((r) => h('button', {
      type: 'button', class: 'btn btn--soft btn--sm', onclick: () => { form.reason.value = r; },
    }, r))),
    h('span', { class: 'hint' }, 'Se muestra en la página pública.')),
  h('label', { class: 'check', style: 'margin-top: 16px' }, h('input', { type: 'checkbox', name: 'cancel' }), 'Cancelar también las reservas de esos días'),
  h('div', { style: 'margin-top: 6px' }, preview),
  h('div', { class: 'dialog__actions' },
    onCancel && btn('Volver', { size: '', onclick: onCancel }),
    btn('Cerrar días', { kind: 'danger', size: '', ic: 'ban', type: 'submit' })));

  async function countReservations(fromDate, toDate) {
    try {
      return (await api.searchReservations({ from: fromDate, to: toDate || fromDate, status: 'active' })).length;
    } catch {
      return 0;
    }
  }
  const updatePreview = debounce(async () => {
    if (!form.from.value) {
      preview.textContent = '';
      return;
    }
    const n = await countReservations(form.from.value, form.to.value);
    preview.textContent = n ? `En esas fechas hay ${plural(n, 'reserva activa', 'reservas activas')}.` : 'En esas fechas no hay reservas.';
  }, 250);
  form.addEventListener('change', updatePreview);
  updatePreview();
  return form;
}

function openCloseDaysDialog(date, onDone) {
  const dialog = h('dialog', { class: 'dialog', 'aria-labelledby': 'cd-title' });
  const close = () => {
    if (dialog.open) dialog.close();
    dialog.remove();
  };
  dialog.append(
    h('div', { class: 'dialog__head' },
      h('div', null,
        h('h2', { class: 'dialog__title', id: 'cd-title' }, 'Cerrar día'),
        h('p', { class: 'dialog__text' }, 'Nadie va a poder reservar en las fechas cerradas.')),
      btn(null, { kind: 'plain', size: '', ic: 'x', title: 'Cerrar', onclick: close })),
    h('div', { class: 'dialog__body' }, closeDaysForm({ from: date, onDone: () => { close(); onDone?.(); }, onCancel: close })));
  dialog.addEventListener('cancel', () => setTimeout(() => dialog.remove(), 0));
  document.body.append(dialog);
  dialog.showModal();
}

function renderClosedTab(root) {
  const listBox = h('div');
  root.replaceChildren(h('div', { class: 'grid-2' },
    h('section', { class: 'card' },
      h('div', { class: 'card__head' },
        h('div', null,
          h('h2', { class: 'card__title' }, 'Cerrar días'),
          h('p', { class: 'card__subtitle' }, 'Para feriados, mantenimiento o cualquier situación en la que no haya pileta libre.'))),
      closeDaysForm({ onDone: () => renderClosedTab(root) })),
    h('section', { class: 'card' },
      h('div', { class: 'card__head' },
        h('div', null,
          h('h2', { class: 'card__title' }, 'Próximos días cerrados'),
          h('p', { class: 'card__subtitle' }, 'Al reabrir un día vuelven sus horarios normales.'))),
      listBox)));

  (async () => {
    listBox.replaceChildren(h('div', { class: 'skeleton', style: 'height: 120px' }));
    let days;
    try {
      days = await api.listClosedDays(state.config.today);
    } catch (err) {
      listBox.replaceChildren(h('div', { class: 'notice notice--danger', role: 'alert' }, icon('alert'), h('div', null, toAppError(err).message)));
      return;
    }
    if (!days.length) {
      listBox.replaceChildren(h('div', { class: 'empty' }, icon('calendar', 32), h('strong', null, 'No hay días cerrados'),
        h('span', null, 'Todos los días siguen el horario semanal.')));
      return;
    }
    listBox.replaceChildren(h('div', { class: 'closed-list' }, days.map((d) => h('div', { class: 'closed-item' },
      h('div', { class: 'closed-item__date' }, h('b', null, dayNumber(d.date)), h('small', null, monthShort(d.date))),
      h('div', { class: 'closed-item__info' },
        h('strong', null, d.reason),
        h('span', null, capitalize(formatLongDate(d.date)), d.activeReservations ? ` · ${plural(d.activeReservations, 'reserva activa', 'reservas activas')}` : '')),
      btn('Ver', { kind: 'plain', onclick: () => { state.date = d.date; goTo('day'); } }),
      btn('Reabrir', {
        ic: 'unlock',
        onclick: async (e) => {
          const button = e.currentTarget;
          await busy(button, async () => {
            const { ok } = await run(() => api.openDay(d.date), `${capitalize(formatLongDate(d.date))} reabierto.`);
            if (ok) renderClosedTab(root);
          });
        },
      })))));
  })();
}

// ---------------------------------------------------------------------
// Inicio
// ---------------------------------------------------------------------

$('site-name').textContent = CONFIG.nombreComplejo;
$('brand-mark').append(icon('wave', 22));
$('logout').append(icon('logout', 17), h('span', { class: 'hide-sm' }, 'Salir'));
$('logout').setAttribute('aria-label', 'Cerrar sesión');
document.title = `Panel de turnos · ${CONFIG.nombreComplejo}`;
if (DEMO) $('demo-banner').hidden = false;
$('logout').addEventListener('click', logout);

api.onAuthChange((session) => {
  if (!session && $('session-box').hidden === false) showLogin('La sesión se cerró.');
});
api.onSlotsChange(() => {
  if (state.tab === 'day') refreshDay();
});

await enter();
