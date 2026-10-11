// Pruebas del esquema de base de datos sobre un Postgres real (PGlite, corre en Node).
// Se simulan las partes de Supabase que usa el esquema: auth.users, auth.uid(),
// los roles anon/authenticated y la publicación de tiempo real.
//
//   npm install
//   npm test

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const schema = await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8');

const SUPABASE_STUB = `
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create role anon nologin;
  create role authenticated nologin;
  grant usage on schema public, auth to anon, authenticated;
  grant execute on function auth.uid() to anon, authenticated;
  create publication supabase_realtime;
`;

let db;
let adminId;
let userId;
let today; // fecha de hoy en la zona horaria del complejo, 'YYYY-MM-DD'

// PGlite devuelve las columnas "date" como Date; las pasamos a 'YYYY-MM-DD'.
const iso = (value) => (value instanceof Date ? value.toISOString().slice(0, 10) : value);

function day(offset) {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

// Ejecuta una consulta como lo haría Supabase: con el rol y el usuario de la sesión.
async function as(role, uid, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.query(`set local role ${role}`);
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid ?? '']);
    return (await tx.query(sql, params)).rows;
  });
}
const anon = (sql, params) => as('anon', null, sql, params);
const admin = (sql, params) => as('authenticated', adminId, sql, params);

async function rejects(promise, pattern) {
  await assert.rejects(promise, (err) => {
    assert.match(err.message, pattern);
    return true;
  });
}

// Crea un turno directamente (como superusuario). offset: días desde hoy.
async function makeSlot({ offset = 1, start = '10:00', end = '11:00', capacity = 20, closed = false } = {}) {
  const { rows } = await db.query(
    `insert into public.slots (slot_date, start_time, end_time, capacity, closed)
     values (public.app_now()::date + $1::int, $2, $3, $4, $5) returning id`,
    [offset, start, end, capacity, closed],
  );
  return rows[0].id;
}

const book = (slotId, first = 'Ana', last = 'Pérez', doc = '30.123.456') =>
  anon(`select public.book_slot($1, $2, $3, $4) as r`, [slotId, first, last, doc]).then((rows) => rows[0].r);

const availability = async (slotId) =>
  (await anon(`select * from public.get_availability()`)).find((s) => s.slot_id === slotId);

before(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUB);
  await db.exec(schema);
  await db.exec(schema); // debe poder ejecutarse dos veces sin errores

  ({ rows: [{ id: adminId }] } = await db.query(`insert into auth.users (email) values ('admin@test') returning id`));
  ({ rows: [{ id: userId }] } = await db.query(`insert into auth.users (email) values ('user@test') returning id`));
  await db.query(`insert into public.admins (user_id) values ($1)`, [adminId]);
  ({ rows: [{ today }] } = await db.query(`select public.app_now()::date::text as today`));
});

test('reserva individual: normaliza datos y devuelve la confirmación', async () => {
  const slot = await makeSlot({ start: '08:00', end: '09:00' });
  const r = await book(slot, '  ana   maría ', 'Pérez', '30.123.456');
  assert.equal(r.first_name, 'ana maría');
  assert.equal(r.document, '30123456');
  assert.equal(r.start_time, '08:00');
  assert.equal(r.end_time, '09:00');
  assert.match(r.code, /^[0-9A-F]{8}$/);

  const a = await availability(slot);
  assert.equal(a.available, 19);
  assert.equal(a.status, 'disponible');
});

test('el mismo documento no puede reservar dos veces el mismo turno, aunque cambie el formato', async () => {
  const slot = await makeSlot({ start: '09:00', end: '10:00' });
  await book(slot, 'Juan', 'Gómez', '25111222');
  await rejects(book(slot, 'Juan', 'Gómez', '25.111.222'), /DUPLICATE/);
  await rejects(book(slot, 'Otro', 'Nombre', '025 111 222'), /DUPLICATE/);
  // Pero puede reservar otro turno.
  const other = await makeSlot({ start: '11:00', end: '12:00' });
  await book(other, 'Juan', 'Gómez', '25111222');
});

test('no se supera la capacidad y el estado pasa a "lleno" y vuelve a "disponible"', async () => {
  const slot = await makeSlot({ start: '12:00', end: '13:00', capacity: 2 });
  await book(slot, 'Uno', 'Uno', '11111111');
  const second = await book(slot, 'Dos', 'Dos', '22222222');
  await rejects(book(slot, 'Tres', 'Tres', '33333333'), /SLOT_FULL/);

  let a = await availability(slot);
  assert.equal(a.available, 0);
  assert.equal(a.status, 'lleno');

  await admin(`select public.admin_cancel_reservation($1)`, [second.id]);
  a = await availability(slot);
  assert.equal(a.available, 1);
  assert.equal(a.status, 'disponible');

  await book(slot, 'Tres', 'Tres', '33333333');
  assert.equal((await availability(slot)).status, 'lleno');
});

test('turnos cerrados y finalizados no aceptan reservas', async () => {
  const closed = await makeSlot({ start: '13:00', end: '14:00', closed: true });
  await rejects(book(closed), /SLOT_CLOSED/);
  assert.equal((await availability(closed)).status, 'cerrado');

  const past = await makeSlot({ offset: 0, start: '00:00', end: '00:01' });
  await rejects(book(past), /SLOT_FINISHED/);
  assert.equal((await availability(past)).status, 'finalizado');

  const yesterday = await makeSlot({ offset: -1 });
  await rejects(book(yesterday), /SLOT_FINISHED/);
  assert.equal(await availability(yesterday), undefined, 'no se listan días pasados');
});

test('no se puede reservar más allá de los días de anticipación', async () => {
  const far = await makeSlot({ offset: 30 });
  await rejects(book(far), /OUT_OF_RANGE/);
  assert.equal(await availability(far), undefined);
});

test('valida nombre, apellido y documento', async () => {
  const slot = await makeSlot({ start: '14:00', end: '15:00' });
  await rejects(book(slot, '', 'Pérez', '30123456'), /INVALID_FIRST_NAME/);
  await rejects(book(slot, 'Ana', 'X', '30123456'), /INVALID_LAST_NAME/);
  await rejects(book(slot, 'Ana2', 'Pérez', '30123456'), /INVALID_FIRST_NAME/);
  await rejects(book(slot, 'Ana', '<script>', '30123456'), /INVALID_LAST_NAME/);
  await rejects(book(slot, 'Ana', 'Pérez', '123'), /INVALID_DOCUMENT/);
  await rejects(book(slot, 'Ana', 'Pérez', 'ABCDEFG'), /INVALID_DOCUMENT/);
  await rejects(book(slot, 'Ana', 'Pérez', '1234567890123'), /INVALID_DOCUMENT/);
  // Nombres con apóstrofo, guion y acentos son válidos; pasaporte alfanumérico también.
  await book(slot, "María José", "O'Connor-Ñáñez", 'AAB123456');
});

test('el público no puede leer reservas ni usar funciones del panel', async () => {
  await rejects(anon(`select * from public.reservations`), /permission denied/);
  await rejects(anon(`insert into public.slots (slot_date, start_time, end_time, capacity) values (current_date, '10:00', '11:00', 5)`), /permission denied/);
  await rejects(anon(`update public.slots set capacity = 999`), /permission denied/);
  await rejects(anon(`select * from public.admin_search_reservations()`), /permission denied/);
  await rejects(anon(`select public.trg_reservation_before_insert()`), /permission denied|trigger/);

  // get_availability no expone columnas con datos personales.
  const cols = Object.keys((await anon(`select * from public.get_availability()`))[0]);
  assert.deepEqual(cols.sort(), ['available', 'capacity', 'end_time', 'note', 'slot_date', 'slot_id', 'start_time', 'status']);
});

test('un usuario logueado que no es admin no puede usar el panel', async () => {
  const user = (sql) => as('authenticated', userId, sql);
  await rejects(user(`select * from public.admin_list_slots(current_date, current_date + 7)`), /NOT_AUTHORIZED/);
  await rejects(user(`select public.admin_update_settings(30)`), /NOT_AUTHORIZED/);
  await rejects(user(`select public.app_now()`), /permission denied/);
  await rejects(user(`select public.generate_slots(current_date, current_date + 7)`), /permission denied/);
  await rejects(anon(`select public.generate_slots(current_date, current_date + 7)`), /permission denied/);
  await rejects(user(`select * from public.admin_search_reservations('a')`), /NOT_AUTHORIZED/);
  await rejects(user(`select * from public.reservations`), /permission denied/);
  assert.equal((await user(`select public.is_admin() as ok`))[0].ok, false);
  assert.equal((await admin(`select public.is_admin() as ok`))[0].ok, true);
});

test('admin: capacidad respeta las reservas existentes', async () => {
  const slot = await makeSlot({ start: '15:00', end: '16:00', capacity: 5 });
  await book(slot, 'Uno', 'Uno', '41111111');
  await book(slot, 'Dos', 'Dos', '42222222');
  await book(slot, 'Tres', 'Tres', '43333333');

  await rejects(admin(`select public.admin_update_slot($1, 2)`, [slot]), /CAPACITY_BELOW_RESERVED/);
  await admin(`select public.admin_update_slot($1, 3)`, [slot]);
  assert.equal((await availability(slot)).status, 'lleno');
  await admin(`select public.admin_update_slot($1, 10)`, [slot]);
  assert.equal((await availability(slot)).available, 7);

  await admin(`select public.admin_update_slot($1, null, true)`, [slot]);
  assert.equal((await availability(slot)).status, 'cerrado');
  await admin(`select public.admin_update_slot($1, null, false)`, [slot]);
  assert.equal((await availability(slot)).status, 'disponible');

  await rejects(admin(`select public.admin_delete_slot($1)`, [slot]), /SLOT_HAS_RESERVATIONS/);
});

test('admin: crear, borrar y no editar turnos pasados', async () => {
  const create = (date, start, end, capacity) =>
    admin(`select public.admin_create_slot($1, $2, $3, $4) as id`, [date, start, end, capacity]);
  const [{ id }] = await create(day(2), '18:00', '19:00', 15);
  await rejects(create(day(2), '18:00', '19:30', 15), /SLOT_EXISTS/);
  await rejects(create(day(2), '20:00', '19:00', 15), /INVALID_TIME_RANGE/);
  await rejects(create(day(-1), '18:00', '19:00', 15), /SLOT_IN_PAST/);
  await rejects(create(day(2), '06:00', '07:00', 0), /INVALID_CAPACITY/);
  await admin(`select public.admin_delete_slot($1)`, [id]);

  const past = await makeSlot({ offset: -2 });
  await rejects(admin(`select public.admin_update_slot($1, 50)`, [past]), /SLOT_FINISHED/);
});

test('admin: búsqueda por nombre (sin acentos) y por documento con cualquier formato', async () => {
  const slot = await makeSlot({ start: '16:00', end: '17:00' });
  await book(slot, 'Lucía', 'Fernández', '28.999.111');

  const byName = await admin(`select * from public.admin_search_reservations('lucia fernandez')`);
  assert.equal(byName.length, 1);
  assert.equal(byName[0].document, '28999111');
  const byLast = await admin(`select * from public.admin_search_reservations('FERNÁNDEZ')`);
  assert.equal(byLast.length, 1);
  const byDoc = await admin(`select * from public.admin_search_reservations('28 999 111')`);
  assert.equal(byDoc.length, 1);
  const bySlot = await admin(`select * from public.admin_search_reservations(null, $1)`, [slot]);
  assert.equal(bySlot.length, 1);

  await admin(`select public.admin_cancel_reservation($1)`, [byDoc[0].reservation_id]);
  await rejects(admin(`select public.admin_cancel_reservation($1)`, [byDoc[0].reservation_id]), /RESERVATION_NOT_ACTIVE/);
  const active = await admin(`select * from public.admin_search_reservations('28999111', null, null, null, 'active')`);
  assert.equal(active.length, 0);
  const cancelled = await admin(`select * from public.admin_search_reservations('28999111', null, null, null, 'cancelled')`);
  assert.equal(cancelled.length, 1);
  assert.ok(cancelled[0].cancelled_at);
});

test('una reserva cancelada no se puede reactivar', async () => {
  const slot = await makeSlot({ start: '17:00', end: '18:00', capacity: 1 });
  const r = await book(slot, 'Solo', 'Uno', '51111111');
  await admin(`select public.admin_cancel_reservation($1)`, [r.id]);
  await book(slot, 'Otra', 'Persona', '52222222');
  await rejects(db.query(`update public.reservations set status = 'active' where id = $1`, [r.id]), /RESERVATION_IMMUTABLE/);
});

// Turno de las 21:00 de una fecha, visto desde el panel (lo crea si falta).
async function slotAt(date, start = '21:00') {
  const rows = await admin(`select * from public.admin_list_slots($1, $1)`, [date]);
  return rows.find((s) => s.start_time.startsWith(start));
}

test('horario semanal: cada fecha tiene sus turnos sin generarlos a mano', async () => {
  for (let weekday = 0; weekday < 7; weekday++) {
    await admin(`select public.admin_save_template(null, $1, '21:00', '22:00', 4, true)`, [weekday]);
  }
  await rejects(admin(`select public.admin_save_template(null, 1, '21:00', '22:30', 4, true)`), /TEMPLATE_EXISTS/);
  await rejects(admin(`select public.admin_save_template(null, 1, '23:00', '22:00', 4, true)`), /INVALID_TIME_RANGE/);
  await rejects(admin(`select public.admin_save_template(null, 1, '06:00', '07:00', 0, true)`), /INVALID_CAPACITY/);
  assert.equal((await admin(`select * from public.admin_list_templates()`)).length, 7);

  // El público ve el turno de las 21:00 en cada uno de los próximos días.
  const slots = await anon(`select * from public.get_availability()`);
  for (let d = 1; d <= 7; d++) {
    const s = slots.find((x) => iso(x.slot_date) === day(d) && x.start_time.startsWith('21:00'));
    assert.ok(s, `falta el turno de ${day(d)}`);
    assert.equal(s.capacity, 4);
  }
  // Consultar de nuevo no modifica nada (cada cambio dispara el tiempo real
  // en todos los navegadores: tiene que ser estable).
  const stamp = async () => (await db.query(`select count(*)::int n, max(updated_at) m from public.slots`)).rows[0];
  const before = await stamp();
  await anon(`select * from public.get_availability()`);
  assert.deepEqual(await stamp(), before);

  // Y el panel puede ver (y crear) los de fechas lejanas.
  assert.equal((await slotAt(day(40))).capacity, 4);
  await rejects(admin(`select * from public.admin_list_slots($1, $2)`, [day(1), day(100)]), /INVALID_DATE_RANGE/);
});

test('horario semanal: los cambios llegan a todas las semanas, salvo a los días modificados', async () => {
  const tomorrow = await slotAt(day(1));
  const tmpl = tomorrow.template_id;
  const [t] = (await admin(`select * from public.admin_list_templates()`)).filter((x) => x.template_id === tmpl);
  const save = (start, end, cap, active = true) =>
    admin(`select public.admin_save_template($1, $2, $3, $4, $5, $6)`, [tmpl, t.weekday, start, end, cap, active]);

  for (const doc of ['61111111', '62222222', '63333333']) await book(tomorrow.slot_id, 'Nombre', 'Apellido', doc);
  await slotAt(day(8)); // se crea
  await slotAt(day(15));

  // Bajar la capacidad a 2: mañana (3 reservas) queda en 3 = lleno; la otra semana pasa a 2.
  await save('21:00', '22:00', 2);
  assert.equal((await slotAt(day(1))).capacity, 3);
  assert.equal((await slotAt(day(1))).status, 'lleno');
  assert.equal((await slotAt(day(8))).capacity, 2);
  assert.equal((await slotAt(day(15))).capacity, 2);

  // Modificar solo el día 8: ya no lo pisa el horario semanal.
  await admin(`select public.admin_update_slot($1, 10)`, [(await slotAt(day(8))).slot_id]);
  await save('21:00', '22:30', 6);
  const d8 = await slotAt(day(8));
  assert.equal(d8.capacity, 10);
  assert.equal(d8.customized, true);
  assert.equal((await slotAt(day(15))).capacity, 6);
  assert.equal((await slotAt(day(15))).end_time.slice(0, 5), '22:30');

  // Restablecer el día 8: vuelve al horario semanal.
  await admin(`select public.admin_reset_slot($1)`, [d8.slot_id]);
  assert.equal((await slotAt(day(8))).capacity, 6);
  assert.equal((await slotAt(day(8))).customized, false);

  // Quitar el turno del día 15: queda oculto y no se vuelve a crear.
  const d15 = await slotAt(day(15));
  await admin(`select public.admin_delete_slot($1)`, [d15.slot_id]);
  assert.equal((await slotAt(day(15))).hidden, true);
  await save('21:00', '22:30', 7);
  assert.equal((await slotAt(day(15))).hidden, true);
  // Y se puede restaurar.
  await admin(`select public.admin_reset_slot($1)`, [d15.slot_id]);
  const restored = await slotAt(day(15));
  assert.equal(restored.hidden, false);
  assert.equal(restored.capacity, 7);

  // No se puede quitar un turno con reservas activas.
  await rejects(admin(`select public.admin_delete_slot($1)`, [tomorrow.slot_id]), /SLOT_HAS_RESERVATIONS/);

  // Mover el horario a las 21:30: los turnos sin reservas se mueven; el de
  // mañana (con reservas) se conserva a las 21:00.
  await save('21:30', '22:30', 7);
  assert.ok(await slotAt(day(1), '21:00'), 'el turno con reservas se conserva');
  assert.ok(await slotAt(day(1), '21:30'));
  assert.equal(await slotAt(day(8), '21:00'), undefined);
  assert.equal((await slotAt(day(8), '21:30')).capacity, 7);

  // Borrar la fila del horario semanal: desaparecen sus turnos futuros sin reservas.
  await admin(`select public.admin_delete_template($1)`, [tmpl]);
  assert.equal(await slotAt(day(8), '21:30'), undefined);
  assert.ok(await slotAt(day(1), '21:00'), 'el turno con reservas sigue');
  assert.equal((await admin(`select * from public.admin_list_templates()`)).length, 6);
});

test('días cerrados: bloquean reservas, avisan el motivo y se pueden reabrir', async () => {
  const slot = await makeSlot({ offset: 3, start: '07:00', end: '08:00', capacity: 5 });
  await book(slot, 'Ana', 'Feriado', '71111111');

  const [{ r }] = await admin(`select public.admin_close_days($1, $1, 'Feriado nacional') as r`, [day(3)]);
  assert.deepEqual(r, { days: 1, cancelled: 0 });
  let a = await availability(slot);
  assert.equal(a.status, 'cerrado');
  assert.equal(a.note, 'Feriado nacional');
  await rejects(book(slot, 'Otra', 'Persona', '72222222'), /DAY_CLOSED/);

  const closed = await admin(`select * from public.admin_list_closed_days()`);
  const row = closed.find((c) => iso(c.day) === day(3));
  assert.equal(row.reason, 'Feriado nacional');
  assert.equal(row.active_reservations, 1);

  await admin(`select public.admin_open_day($1)`, [day(3)]);
  a = await availability(slot);
  assert.equal(a.status, 'disponible');
  assert.equal(a.note, null);

  // Cerrar cancelando las reservas de ese día.
  const [{ r: r2 }] = await admin(`select public.admin_close_days($1, $1, 'Mantenimiento', true) as r`, [day(3)]);
  assert.equal(r2.cancelled, 1);
  assert.equal((await availability(slot)).available, 5);

  // Rango de días y validaciones.
  const [{ r: r3 }] = await admin(`select public.admin_close_days($1, $2, '') as r`, [day(4), day(5)]);
  assert.equal(r3.days, 2);
  assert.equal((await admin(`select * from public.admin_list_closed_days()`)).find((c) => iso(c.day) === day(4)).reason, 'Cerrado');
  await rejects(admin(`select public.admin_close_days($1, $1, 'x')`, [day(-3)]), /DAY_IN_PAST/);
  await rejects(admin(`select public.admin_close_days($1, $2, 'x')`, [day(5), day(4)]), /INVALID_DATE_RANGE/);
  await rejects(anon(`select public.admin_close_days(current_date, current_date, 'x')`), /permission denied/);
  await rejects(as('authenticated', userId, `select public.admin_close_days(current_date, current_date, 'x')`), /NOT_AUTHORIZED/);
  await admin(`select public.admin_open_day($1)`, [day(3)]);
  await admin(`select public.admin_open_day($1)`, [day(4)]);
  await admin(`select public.admin_open_day($1)`, [day(5)]);
});

test('admin: días de anticipación', async () => {
  await rejects(admin(`select public.admin_update_settings(0)`), /INVALID_HORIZON/);
  await admin(`select public.admin_update_settings(30)`);
  const [{ c }] = await anon(`select public.get_public_config() as c`);
  assert.equal(c.horizon_days, 30);
  await admin(`select public.admin_update_settings(7)`);
});

test('el contador de lugares ocupados coincide con las reservas activas', async () => {
  const { rows } = await db.query(`
    select s.id from public.slots s
    where s.reserved_count <> (select count(*) from public.reservations r
                               where r.slot_id = s.id and r.status = 'active')`);
  assert.equal(rows.length, 0);
});
