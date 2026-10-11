// Utilidades compartidas: validaciones (las mismas reglas que la base de
// datos), fechas, mensajes de error y helpers de interfaz.

// ---------- Validaciones (espejo de supabase/schema.sql) ----------

export function normalizeDocument(value) {
  let d = String(value ?? '').replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  if (/^[0-9]+$/.test(d)) d = d.replace(/^0+/, '');
  return d;
}

export function isValidDocument(normalized) {
  return /^[A-Z0-9]{6,12}$/.test(normalized) && /[0-9]/.test(normalized);
}

export function cleanName(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

export function isValidName(cleaned) {
  const length = [...cleaned].length;
  return length >= 2 && length <= 60 && !/[0-9<>@#$%&*=+_/\\|{}[\]"!?;:¿¡()]/.test(cleaned);
}

export function foldText(value) {
  return String(value ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

// ---------- Fechas ----------
// Las fechas viajan como 'YYYY-MM-DD' y las horas como 'HH:MM'. Para formatear
// se usa UTC, así el día no se corre por la zona horaria del dispositivo.

const parts = (date, timeZone) =>
  Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );

// 'YYYY-MM-DDTHH:MM' en la zona horaria indicada.
export function nowInTimeZone(timeZone) {
  const p = parts(new Date(), timeZone);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

const toUTC = (iso) => new Date(`${iso}T00:00:00Z`);

export function addDays(iso, days) {
  const d = toUTC(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const weekdayOf = (iso) => toUTC(iso).getUTCDay();

const longDateFmt = new Intl.DateTimeFormat('es-AR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const monthFmt = new Intl.DateTimeFormat('es-AR', { month: 'long', year: 'numeric', timeZone: 'UTC' });

export const formatLongDate = (iso) => longDateFmt.format(toUTC(iso));
export const formatMonth = (year, month) => monthFmt.format(new Date(Date.UTC(year, month, 1)));

const WEEKDAY_SHORT = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const MONTH_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
export const weekdayShort = (iso) => WEEKDAY_SHORT[weekdayOf(iso)];
export const monthShort = (iso) => MONTH_SHORT[Number(iso.slice(5, 7)) - 1];
export const dayNumber = (iso) => Number(iso.slice(8, 10));
// "Lun 12 oct"
export const formatShortDate = (iso) => `${weekdayShort(iso)} ${dayNumber(iso)} ${monthShort(iso)}`;

export function formatDateTime(isoTimestamp) {
  if (!isoTimestamp) return '';
  return new Intl.DateTimeFormat('es-AR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(isoTimestamp));
}

export const WEEKDAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
// Orden de lunes a domingo para mostrar.
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------- Estados de un horario ----------

export const STATUS_LABEL = {
  disponible: 'Disponible',
  lleno: 'Horario lleno',
  cerrado: 'Cerrado',
  finalizado: 'Finalizado',
};

export function availabilityText(slot) {
  if (slot.status !== 'disponible') return STATUS_LABEL[slot.status];
  return slot.available === 1 ? '1 lugar disponible' : `${slot.available} lugares disponibles`;
}

// ---------- Errores ----------

const MESSAGES = {
  SLOT_FULL: 'Este horario se acaba de llenar. Elegí otro horario.',
  SLOT_CLOSED: 'Este horario está cerrado.',
  SLOT_FINISHED: 'Este horario ya comenzó o terminó.',
  DAY_CLOSED: 'Ese día el complejo está cerrado.',
  DAY_IN_PAST: 'No se pueden cerrar días que ya pasaron.',
  SLOT_NOT_FROM_TEMPLATE: 'Este horario se agregó solo para este día: no hay horario semanal al que volver.',
  SLOT_NOT_FOUND: 'El horario ya no existe.',
  OUT_OF_RANGE: 'Todavía no se puede reservar para esa fecha.',
  DUPLICATE: 'Ya hay una reserva con ese documento para este horario.',
  INVALID_FIRST_NAME: 'Revisá el nombre: entre 2 y 60 letras, sin números.',
  INVALID_LAST_NAME: 'Revisá el apellido: entre 2 y 60 letras, sin números.',
  INVALID_DOCUMENT: 'Revisá el documento: entre 6 y 12 números (o letras y números si es pasaporte).',
  NOT_AUTHORIZED: 'Tu usuario no tiene permiso para usar el panel.',
  LOGIN_FAILED: 'Email o contraseña incorrectos.',
  CAPACITY_BELOW_RESERVED: (n) => `La capacidad no puede ser menor que las reservas activas (${n}).`,
  SLOT_EXISTS: 'Ya existe un horario que empieza a esa hora ese día.',
  SLOT_IN_PAST: 'No se pueden crear horarios en el pasado.',
  SLOT_HAS_RESERVATIONS: 'Este horario tiene reservas activas: cancelalas primero o cerrá el horario.',
  INVALID_TIME_RANGE: 'La hora de fin tiene que ser posterior a la de inicio.',
  INVALID_CAPACITY: 'La capacidad tiene que estar entre 1 y 1000.',
  INVALID_DATE_RANGE: 'Revisá las fechas: la de fin tiene que ser igual o posterior a la de inicio.',
  INVALID_HORIZON: 'Los días de anticipación tienen que estar entre 1 y 90.',
  RESERVATION_NOT_ACTIVE: 'La reserva ya estaba cancelada.',
  RESERVATION_IMMUTABLE: 'Una reserva cancelada no se puede reactivar.',
  TEMPLATE_EXISTS: 'Ya hay un horario que empieza a esa hora ese día de la semana.',
  TEMPLATE_NOT_FOUND: 'Ese horario semanal ya no existe.',
  NETWORK: 'No se pudo conectar. Revisá tu conexión e intentá de nuevo.',
};

export class AppError extends Error {
  constructor(code, detail) {
    const m = MESSAGES[code];
    super(typeof m === 'function' ? m(detail) : (m ?? 'Ocurrió un error inesperado. Intentá de nuevo.'));
    this.code = code;
    this.detail = detail;
  }
}

// Convierte un error de Supabase (o de red) en un AppError con mensaje en castellano.
export function toAppError(error) {
  if (error instanceof AppError) return error;
  const code = error?.message?.trim();
  if (code && code in MESSAGES) return new AppError(code, error.details);
  if (error instanceof TypeError || /fetch|network/i.test(error?.message ?? '')) return new AppError('NETWORK');
  console.error(error);
  return new AppError('UNKNOWN');
}

// ---------- Interfaz ----------

// Crea elementos sin usar innerHTML, así ningún dato escrito por un usuario
// se interpreta como HTML.
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value' || key === 'checked') el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

// Íconos de línea (24×24, trazo). Se dibujan con currentColor.
const ICONS = {
  calendar: '<rect x="3" y="4.5" width="18" height="16" rx="3"/><path d="M8 2.5v4M16 2.5v4M3 9.5h18"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5M16 4.8a3.5 3.5 0 0 1 0 6.4M18.5 14.8c1.7.8 2.7 2.5 3 5.2"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c.8-4.2 3.9-6.5 8-6.5s7.2 2.3 8 6.5"/>',
  id: '<rect x="2.5" y="5" width="19" height="14" rx="3"/><circle cx="8.5" cy="11" r="2.2"/><path d="M5.5 16c.5-1.5 1.6-2.3 3-2.3s2.5.8 3 2.3M14.5 10h4M14.5 13.5h3"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  chevronLeft: '<path d="M15 5l-7 7 7 7"/>',
  chevronRight: '<path d="M9 5l7 7-7 7"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 7.7-1.5"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20.5 20.5L16 16"/>',
  edit: '<path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  logout: '<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l4-4-4-4M14 12H4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.6v.1"/>',
  alert: '<path d="M12 3.5l9.5 16.5h-19L12 3.5z"/><path d="M12 10v4.5M12 17.3v.1"/>',
  wave: '<path d="M2 15c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2M2 20c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2"/><circle cx="15" cy="6" r="2.3"/><path d="M6 11l4.5-4 3.5 2.5"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4"/>',
  sunset: '<path d="M3 18h18M6.3 18a5.7 5.7 0 0 1 11.4 0M12 4v4M4.9 9.9l1.4 1.4M19.1 9.9l-1.4 1.4M8 21h8"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  ticket: '<path d="M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4V8z"/><path d="M14 6v12" stroke-dasharray="2 2.5"/>',
};

export function icon(name, size = 20) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.9');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  svg.innerHTML = ICONS[name] ?? '';
  return svg;
}

export function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

let toastRegion;
export function toast(message, type = 'info') {
  if (!toastRegion) {
    toastRegion = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastRegion);
  }
  const el = h('div', { class: `toast toast--${type}` }, message);
  toastRegion.append(el);
  setTimeout(() => el.classList.add('toast--out'), 3800);
  setTimeout(() => el.remove(), 4200);
}

// Diálogo de confirmación accesible. Devuelve true si el usuario confirma.
export function confirmDialog({ title, message, confirmText = 'Confirmar', cancelText = 'Volver', danger = false }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      resolve(ok);
    };
    const dialog = h('dialog', { class: 'dialog dialog--small', 'aria-labelledby': 'confirm-title' },
      h('h2', { id: 'confirm-title', class: 'dialog__title' }, title),
      message && h('p', { class: 'dialog__text' }, message),
      h('div', { class: 'dialog__actions' },
        h('button', { type: 'button', class: 'btn btn--ghost', onclick: () => finish(false) }, cancelText),
        h('button', { type: 'button', class: `btn ${danger ? 'btn--danger' : 'btn--primary'}`, onclick: () => finish(true) }, confirmText),
      ),
    );
    // Escape o cierre por otra vía = no confirmar.
    dialog.addEventListener('cancel', () => finish(false));
    dialog.addEventListener('close', () => finish(false));
    document.body.append(dialog);
    dialog.showModal();
  });
}
