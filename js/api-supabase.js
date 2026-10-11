// Backend real: llama a las funciones definidas en supabase/schema.sql.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { CONFIG } from './config.js';
import { AppError, toAppError } from './utils.js';

const sb = createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey);

async function rpc(fn, args) {
  let result;
  try {
    result = await sb.rpc(fn, args);
  } catch (err) {
    throw toAppError(err);
  }
  if (result.error) throw toAppError(result.error);
  return result.data;
}

const hhmm = (time) => time?.slice(0, 5);

const mapSlot = (r) => ({
  id: r.slot_id,
  date: r.slot_date,
  start: hhmm(r.start_time),
  end: hhmm(r.end_time),
  capacity: r.capacity,
  available: r.available,
  reserved: r.reserved ?? r.capacity - r.available,
  status: r.status,
  closed: r.closed ?? r.status === 'cerrado',
  templateId: r.template_id ?? null,
  customized: r.customized ?? false,
  hidden: r.hidden ?? false,
  note: r.note ?? null, // motivo si el día está cerrado
});

const mapReservation = (r) => ({
  id: r.reservation_id,
  slotId: r.slot_id,
  date: r.slot_date,
  start: hhmm(r.start_time),
  end: hhmm(r.end_time),
  firstName: r.first_name,
  lastName: r.last_name,
  document: r.document,
  status: r.status,
  createdAt: r.created_at,
  cancelledAt: r.cancelled_at,
});

const toSession = (session) => (session ? { email: session.user.email } : null);

export const api = {
  // ----- Público -----
  async getConfig() {
    const c = await rpc('get_public_config');
    return { today: c.today, now: c.now, horizonDays: c.horizon_days, timezone: c.timezone };
  },

  async getAvailability(from, to) {
    return (await rpc('get_availability', { p_from: from, p_to: to })).map(mapSlot);
  },

  async book(slotId, { firstName, lastName, document }) {
    const r = await rpc('book_slot', {
      p_slot_id: slotId, p_first_name: firstName, p_last_name: lastName, p_document: document,
    });
    return {
      id: r.id, code: r.code, date: r.slot_date, start: r.start_time, end: r.end_time,
      firstName: r.first_name, lastName: r.last_name, document: r.document,
    };
  },

  // Avisa cuando cambia cualquier horario (alguien reservó, se canceló, el
  // admin cambió la capacidad...). Devuelve una función para desuscribirse.
  onSlotsChange(callback) {
    const channel = sb
      .channel(`slots-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'slots' }, () => callback())
      .subscribe();
    return () => sb.removeChannel(channel);
  },

  // ----- Sesión del panel -----
  async getSession() {
    const { data } = await sb.auth.getSession();
    return toSession(data.session);
  },

  onAuthChange(callback) {
    sb.auth.onAuthStateChange((_event, session) => callback(toSession(session)));
  },

  async signIn(email, password) {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error.status === 400 ? new AppError('LOGIN_FAILED') : toAppError(error);
  },

  async signOut() {
    await sb.auth.signOut();
  },

  isAdmin: () => rpc('is_admin'),

  // ----- Panel -----
  async listSlots(from, to) {
    return (await rpc('admin_list_slots', { p_from: from, p_to: to })).map(mapSlot);
  },

  createSlot: ({ date, start, end, capacity }) =>
    rpc('admin_create_slot', { p_date: date, p_start: start, p_end: end, p_capacity: capacity }),

  updateSlot: (slotId, { capacity = null, closed = null }) =>
    rpc('admin_update_slot', { p_slot_id: slotId, p_capacity: capacity, p_closed: closed }),

  deleteSlot: (slotId) => rpc('admin_delete_slot', { p_slot_id: slotId }),

  resetSlot: (slotId) => rpc('admin_reset_slot', { p_slot_id: slotId }),

  async searchReservations({ query = null, slotId = null, from = null, to = null, status = null } = {}) {
    const rows = await rpc('admin_search_reservations', {
      p_query: query || null, p_slot_id: slotId, p_from: from || null, p_to: to || null, p_status: status || null,
    });
    return rows.map(mapReservation);
  },

  cancelReservation: (reservationId) => rpc('admin_cancel_reservation', { p_reservation_id: reservationId }),

  async listTemplates() {
    return (await rpc('admin_list_templates')).map((t) => ({
      id: t.template_id, weekday: t.weekday, start: hhmm(t.start_time), end: hhmm(t.end_time),
      capacity: t.capacity, active: t.active,
    }));
  },

  saveTemplate: ({ id = null, weekday, start, end, capacity, active = true }) =>
    rpc('admin_save_template', {
      p_template_id: id, p_weekday: weekday, p_start: start, p_end: end, p_capacity: capacity, p_active: active,
    }),

  deleteTemplate: (templateId) => rpc('admin_delete_template', { p_template_id: templateId }),

  async listClosedDays(from = null) {
    return (await rpc('admin_list_closed_days', { p_from: from })).map((d) => ({
      date: d.day, reason: d.reason, activeReservations: d.active_reservations,
    }));
  },

  closeDays: ({ from, to = null, reason, cancelReservations = false }) =>
    rpc('admin_close_days', { p_from: from, p_to: to || from, p_reason: reason, p_cancel_reservations: cancelReservations }),

  openDay: (date) => rpc('admin_open_day', { p_day: date }),

  updateSettings: ({ horizonDays }) => rpc('admin_update_settings', { p_booking_horizon_days: horizonDays }),
};
