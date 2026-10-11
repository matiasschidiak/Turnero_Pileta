// MODO DEMO: imita el backend de Supabase guardando todo en localStorage.
// Sirve para probar la app sin configurar nada. Los datos existen solo en
// este navegador (las pestañas del mismo navegador se sincronizan entre sí).
// Las reglas son las mismas que en supabase/schema.sql.
import {
  AppError, addDays, cleanName, foldText, isValidDocument, isValidName, normalizeDocument,
  nowInTimeZone, weekdayOf,
} from './utils.js';

const KEY = 'turnero-pileta-demo-v2';
const SESSION_KEY = 'turnero-pileta-demo-session';
const listeners = new Set();
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(KEY) : null;
channel?.addEventListener('message', () => listeners.forEach((fn) => fn()));

const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  }));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const latency = () => sleep(100 + Math.random() * 150);

let memory = null;
function read() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* storage bloqueado: se usan datos en memoria */ }
  return memory ?? (memory = seed());
}

function write(state) {
  memory = state;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch { /* idem */ }
  channel?.postMessage('change');
  listeners.forEach((fn) => fn());
}

// Lee, modifica y guarda en un solo paso (si fn lanza un error, no se guarda nada).
function mutate(fn) {
  const state = read();
  const result = fn(state);
  write(state);
  return result;
}

// ---------- Reglas (espejo de schema.sql) ----------

const now = (state) => nowInTimeZone(state.settings.timezone);
const today = (state) => now(state).slice(0, 10);
const started = (state, slot) => `${slot.date}T${slot.start}` <= now(state);
const activeCount = (state, slotId) =>
  state.reservations.filter((r) => r.slotId === slotId && r.status === 'active').length;
const bySlotOrder = (a, b) => (a.date + a.start).localeCompare(b.date + b.start);

function statusOf(state, slot) {
  if (started(state, slot)) return 'finalizado';
  if (slot.closed || state.closedDays[slot.date]) return 'cerrado';
  if (activeCount(state, slot.id) >= slot.capacity) return 'lleno';
  return 'disponible';
}

function slotView(state, slot) {
  const reserved = activeCount(state, slot.id);
  return {
    id: slot.id, date: slot.date, start: slot.start, end: slot.end, capacity: slot.capacity,
    reserved, available: Math.max(slot.capacity - reserved, 0), closed: slot.closed,
    status: statusOf(state, slot), templateId: slot.templateId, customized: slot.customized,
    hidden: slot.hidden, note: state.closedDays[slot.date] ?? null,
  };
}

// Crea los turnos que falten según el horario semanal. Devuelve cuántos creó.
function generate(state, from, to) {
  let created = 0;
  for (let d = from > today(state) ? from : today(state); d <= to; d = addDays(d, 1)) {
    for (const t of state.templates) {
      if (!t.active || t.weekday !== weekdayOf(d)) continue;
      if (`${d}T${t.start}` <= now(state)) continue;
      if (state.slots.some((s) => s.date === d && s.start === t.start)) continue;
      state.slots.push({
        id: uuid(), date: d, start: t.start, end: t.end, capacity: t.capacity,
        closed: false, templateId: t.id, customized: false, hidden: false,
      });
      created++;
    }
  }
  return created;
}

function retire(state, slot) {
  if (activeCount(state, slot.id) > 0) slot.customized = true;
  else if (state.reservations.some((r) => r.slotId === slot.id)) Object.assign(slot, { hidden: true, customized: true });
  else state.slots = state.slots.filter((s) => s !== slot);
}

function syncTemplate(state, templateId) {
  const t = state.templates.find((x) => x.id === templateId);
  for (const s of state.slots.filter((x) => x.templateId === templateId && !x.customized && !started(state, x))) {
    if (t?.active && s.start === t.start && weekdayOf(s.date) === t.weekday) {
      s.end = t.end;
      s.capacity = Math.max(t.capacity, activeCount(state, s.id));
    } else {
      retire(state, s);
    }
  }
  generate(state, today(state), addDays(today(state), state.settings.horizonDays));
}

function requireAdmin() {
  if (!readSession()) throw new AppError('NOT_AUTHORIZED');
}

function readSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}

const validCapacity = (c) => Number.isInteger(c) && c >= 1 && c <= 1000;

// ---------- Datos de ejemplo ----------
// Lunes a viernes de 8 a 12 y de 17 a 21, sábados de 9 a 13, y un feriado.
function seed() {
  const state = {
    settings: { timezone: 'America/Argentina/Buenos_Aires', horizonDays: 7 },
    templates: [], slots: [], reservations: [], closedDays: {},
  };
  const hours = (from, to) => Array.from({ length: to - from }, (_, i) => from + i);
  const hhmm = (h) => `${String(h).padStart(2, '0')}:00`;
  for (const weekday of [1, 2, 3, 4, 5]) {
    for (const h of [...hours(8, 12), ...hours(17, 21)]) {
      state.templates.push({ id: uuid(), weekday, start: hhmm(h), end: hhmm(h + 1), capacity: 20, active: true });
    }
  }
  for (const h of hours(9, 13)) {
    state.templates.push({ id: uuid(), weekday: 6, start: hhmm(h), end: hhmm(h + 1), capacity: 25, active: true });
  }
  const t0 = today(state);
  generate(state, t0, addDays(t0, state.settings.horizonDays));

  // Un feriado de ejemplo: el primer día hábil desde dentro de 4 días.
  let holiday = addDays(t0, 4);
  while ([0, 6].includes(weekdayOf(holiday))) holiday = addDays(holiday, 1);
  state.closedDays[holiday] = 'Feriado';

  const names = ['Lucía', 'Martín', 'Sofía', 'Juan', 'Valentina', 'Mateo', 'Camila', 'Tomás', 'Julieta', 'Benjamín'];
  const surnames = ['González', 'Rodríguez', 'Fernández', 'López', 'Martínez', 'Pérez', 'Gómez', 'Díaz', 'Romero', 'Sosa'];
  let doc = 30000000;
  const fill = (slot, count) => {
    for (let i = 0; i < count; i++) {
      state.reservations.push({
        id: uuid(), slotId: slot.id, firstName: names[(i + doc) % names.length], lastName: surnames[(i * 3) % surnames.length],
        document: String(doc += 7919), status: 'active', createdAt: new Date().toISOString(), cancelledAt: null,
      });
    }
  };
  const upcoming = state.slots.filter((s) => !started(state, s) && s.date !== holiday).sort(bySlotOrder);
  upcoming.forEach((slot, i) => fill(slot, [3, 8, 0, 17, 5, 12, 0, 2][i % 8]));
  if (upcoming[1]) fill(upcoming[1], upcoming[1].capacity - activeCount(state, upcoming[1].id)); // uno lleno
  if (upcoming[4]) Object.assign(upcoming[4], { closed: true, customized: true }); // uno cerrado
  return state;
}

// ---------- API ----------

export const api = {
  mode: 'demo',

  // ----- Público -----
  async getConfig() {
    await latency();
    const state = read();
    return { today: today(state), now: now(state), horizonDays: state.settings.horizonDays, timezone: state.settings.timezone };
  },

  async getAvailability(from, to) {
    await latency();
    const state = read();
    const min = today(state);
    const max = addDays(min, state.settings.horizonDays);
    const lo = from && from > min ? from : min;
    const hi = to && to < max ? to : max;
    if (generate(state, lo, hi)) write(state); // solo se guarda si hubo cambios
    return state.slots.filter((s) => s.date >= lo && s.date <= hi && !s.hidden).sort(bySlotOrder).map((s) => {
      const v = slotView(state, s);
      return { id: v.id, date: v.date, start: v.start, end: v.end, capacity: v.capacity, available: v.available, status: v.status, note: v.note };
    });
  },

  async book(slotId, { firstName, lastName, document }) {
    await latency();
    const first = cleanName(firstName);
    const last = cleanName(lastName);
    const doc = normalizeDocument(document);
    if (!isValidName(first)) throw new AppError('INVALID_FIRST_NAME');
    if (!isValidName(last)) throw new AppError('INVALID_LAST_NAME');
    if (!isValidDocument(doc)) throw new AppError('INVALID_DOCUMENT');

    return mutate((state) => {
      const slot = state.slots.find((s) => s.id === slotId);
      if (!slot || slot.hidden) throw new AppError('SLOT_NOT_FOUND');
      if (slot.date > addDays(today(state), state.settings.horizonDays)) throw new AppError('OUT_OF_RANGE');
      if (started(state, slot)) throw new AppError('SLOT_FINISHED');
      if (state.closedDays[slot.date]) throw new AppError('DAY_CLOSED');
      if (slot.closed) throw new AppError('SLOT_CLOSED');
      if (state.reservations.some((r) => r.slotId === slotId && r.document === doc && r.status === 'active')) {
        throw new AppError('DUPLICATE');
      }
      if (activeCount(state, slotId) >= slot.capacity) throw new AppError('SLOT_FULL');

      const reservation = {
        id: uuid(), slotId, firstName: first, lastName: last, document: doc,
        status: 'active', createdAt: new Date().toISOString(), cancelledAt: null,
      };
      state.reservations.push(reservation);
      return {
        id: reservation.id, code: reservation.id.replace(/-/g, '').slice(0, 8).toUpperCase(),
        date: slot.date, start: slot.start, end: slot.end, firstName: first, lastName: last, document: doc,
      };
    });
  },

  onSlotsChange(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
  },

  // ----- Sesión del panel (en demo acepta cualquier email y contraseña) -----
  async getSession() {
    return readSession();
  },

  onAuthChange(callback) {
    this.authCallback = callback;
  },

  async signIn(email, password) {
    await latency();
    if (!email || !password) throw new AppError('LOGIN_FAILED');
    const session = { email };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    this.authCallback?.(session);
  },

  async signOut() {
    sessionStorage.removeItem(SESSION_KEY);
    this.authCallback?.(null);
  },

  async isAdmin() {
    return Boolean(readSession());
  },

  // ----- Panel -----
  async listSlots(from, to) {
    await latency();
    requireAdmin();
    if (addDays(from, 62) < to) throw new AppError('INVALID_DATE_RANGE');
    const state = read();
    if (generate(state, from, to)) write(state);
    return state.slots.filter((s) => s.date >= from && s.date <= to).sort(bySlotOrder).map((s) => slotView(state, s));
  },

  async createSlot({ date, start, end, capacity }) {
    await latency();
    requireAdmin();
    return mutate((state) => {
      if (end <= start) throw new AppError('INVALID_TIME_RANGE');
      if (`${date}T${start}` <= now(state)) throw new AppError('SLOT_IN_PAST');
      if (!validCapacity(capacity)) throw new AppError('INVALID_CAPACITY');
      const existing = state.slots.find((s) => s.date === date && s.start === start);
      if (existing?.hidden) {
        Object.assign(existing, { hidden: false, closed: false, customized: true, end, capacity: Math.max(capacity, activeCount(state, existing.id)) });
        return existing.id;
      }
      if (existing) throw new AppError('SLOT_EXISTS');
      const slot = { id: uuid(), date, start, end, capacity, closed: false, templateId: null, customized: true, hidden: false };
      state.slots.push(slot);
      return slot.id;
    });
  },

  async updateSlot(slotId, { capacity = null, closed = null }) {
    await latency();
    requireAdmin();
    mutate((state) => {
      const slot = state.slots.find((s) => s.id === slotId);
      if (!slot || slot.hidden) throw new AppError('SLOT_NOT_FOUND');
      if (started(state, slot)) throw new AppError('SLOT_FINISHED');
      if (capacity != null) {
        if (!validCapacity(capacity)) throw new AppError('INVALID_CAPACITY');
        const n = activeCount(state, slotId);
        if (capacity < n) throw new AppError('CAPACITY_BELOW_RESERVED', n);
        slot.capacity = capacity;
      }
      if (closed != null) slot.closed = closed;
      slot.customized = true;
    });
  },

  async resetSlot(slotId) {
    await latency();
    requireAdmin();
    mutate((state) => {
      const slot = state.slots.find((s) => s.id === slotId);
      if (!slot) throw new AppError('SLOT_NOT_FOUND');
      if (!slot.templateId) throw new AppError('SLOT_NOT_FROM_TEMPLATE');
      if (started(state, slot)) throw new AppError('SLOT_FINISHED');
      Object.assign(slot, { customized: false, closed: false, hidden: false });
      syncTemplate(state, slot.templateId);
    });
  },

  async deleteSlot(slotId) {
    await latency();
    requireAdmin();
    mutate((state) => {
      const slot = state.slots.find((s) => s.id === slotId);
      if (!slot) throw new AppError('SLOT_NOT_FOUND');
      if (activeCount(state, slotId) > 0) throw new AppError('SLOT_HAS_RESERVATIONS');
      if (slot.templateId || state.reservations.some((r) => r.slotId === slotId)) {
        Object.assign(slot, { hidden: true, customized: true });
      } else {
        state.slots = state.slots.filter((s) => s !== slot);
      }
    });
  },

  async searchReservations({ query = '', slotId = null, from = null, to = null, status = null } = {}) {
    await latency();
    requireAdmin();
    const state = read();
    const q = foldText(cleanName(query));
    const doc = normalizeDocument(query);
    const slots = new Map(state.slots.map((s) => [s.id, s]));
    return state.reservations
      .map((r) => ({ r, s: slots.get(r.slotId) }))
      .filter(({ r, s }) => s
        && (!slotId || r.slotId === slotId)
        && (!from || s.date >= from)
        && (!to || s.date <= to)
        && (!status || r.status === status)
        && (!q
          || foldText(`${r.firstName} ${r.lastName}`).includes(q)
          || foldText(`${r.lastName} ${r.firstName}`).includes(q)
          || (doc && r.document.includes(doc))))
      .sort((a, b) => (b.s.date.localeCompare(a.s.date)) || a.s.start.localeCompare(b.s.start)
        || a.r.lastName.localeCompare(b.r.lastName) || a.r.firstName.localeCompare(b.r.firstName))
      .slice(0, 500)
      .map(({ r, s }) => ({
        id: r.id, slotId: s.id, date: s.date, start: s.start, end: s.end, firstName: r.firstName,
        lastName: r.lastName, document: r.document, status: r.status, createdAt: r.createdAt, cancelledAt: r.cancelledAt,
      }));
  },

  async cancelReservation(reservationId) {
    await latency();
    requireAdmin();
    mutate((state) => {
      const r = state.reservations.find((x) => x.id === reservationId && x.status === 'active');
      if (!r) throw new AppError('RESERVATION_NOT_ACTIVE');
      r.status = 'cancelled';
      r.cancelledAt = new Date().toISOString();
    });
  },

  async listTemplates() {
    await latency();
    requireAdmin();
    return read().templates.slice().sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start));
  },

  async saveTemplate({ id = null, weekday, start, end, capacity, active = true }) {
    await latency();
    requireAdmin();
    return mutate((state) => {
      if (end <= start) throw new AppError('INVALID_TIME_RANGE');
      if (!validCapacity(capacity)) throw new AppError('INVALID_CAPACITY');
      if (state.templates.some((t) => t.id !== id && t.weekday === weekday && t.start === start)) {
        throw new AppError('TEMPLATE_EXISTS');
      }
      let t = state.templates.find((x) => x.id === id);
      if (id && !t) throw new AppError('TEMPLATE_NOT_FOUND');
      if (!t) {
        t = { id: uuid() };
        state.templates.push(t);
      }
      Object.assign(t, { weekday, start, end, capacity, active });
      syncTemplate(state, t.id);
      return t.id;
    });
  },

  async deleteTemplate(templateId) {
    await latency();
    requireAdmin();
    mutate((state) => {
      const t = state.templates.find((x) => x.id === templateId);
      if (!t) return;
      t.active = false;
      syncTemplate(state, templateId);
      state.templates = state.templates.filter((x) => x.id !== templateId);
      for (const s of state.slots) if (s.templateId === templateId) s.templateId = null;
    });
  },

  async listClosedDays(from = null) {
    await latency();
    requireAdmin();
    const state = read();
    const min = from ?? today(state);
    return Object.entries(state.closedDays)
      .filter(([date]) => date >= min)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, reason]) => ({
        date, reason,
        activeReservations: state.slots.filter((s) => s.date === date).reduce((n, s) => n + activeCount(state, s.id), 0),
      }));
  },

  async closeDays({ from, to = null, reason, cancelReservations = false }) {
    await latency();
    requireAdmin();
    return mutate((state) => {
      const end = to || from;
      if (!from || end < from || addDays(from, 366) < end) throw new AppError('INVALID_DATE_RANGE');
      if (end < today(state)) throw new AppError('DAY_IN_PAST');
      const text = cleanName(reason).slice(0, 80) || 'Cerrado';
      let days = 0;
      let cancelled = 0;
      for (let d = from; d <= end; d = addDays(d, 1)) {
        if (d < today(state)) continue;
        state.closedDays[d] = text;
        days++;
        if (!cancelReservations) continue;
        const ids = new Set(state.slots.filter((s) => s.date === d).map((s) => s.id));
        for (const r of state.reservations) {
          if (ids.has(r.slotId) && r.status === 'active') {
            r.status = 'cancelled';
            r.cancelledAt = new Date().toISOString();
            cancelled++;
          }
        }
      }
      return { days, cancelled };
    });
  },

  async openDay(date) {
    await latency();
    requireAdmin();
    mutate((state) => {
      delete state.closedDays[date];
    });
  },

  async updateSettings({ horizonDays }) {
    await latency();
    requireAdmin();
    mutate((state) => {
      if (!(Number.isInteger(horizonDays) && horizonDays >= 1 && horizonDays <= 90)) throw new AppError('INVALID_HORIZON');
      state.settings.horizonDays = horizonDays;
    });
  },
};
