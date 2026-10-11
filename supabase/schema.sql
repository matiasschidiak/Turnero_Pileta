-- =====================================================================
-- Turnero de pileta libre — esquema de base de datos para Supabase
--
-- Cómo usarlo: Supabase → SQL Editor → New query → pegar todo → Run.
-- Se puede volver a ejecutar sin perder datos (crea solo lo que falta y
-- reemplaza funciones, triggers y permisos).
--
-- Cómo funcionan los horarios:
--   * El "horario semanal" (schedule_templates) dice qué turnos hay cada
--     lunes, cada martes, etc. Los turnos de cada fecha (slots) se crean
--     solos a partir de él cuando alguien consulta esa fecha.
--   * Si se cambia el horario semanal, se actualizan todos los turnos
--     futuros que siguen ese horario.
--   * Si el admin cambia un turno de una fecha puntual (capacidad, cerrarlo
--     o quitarlo), ese turno queda "modificado" y ya no se pisa con el
--     horario semanal, salvo que se lo restablezca.
--   * Los días cerrados (closed_days) bloquean las reservas de toda la fecha.
--
-- Modelo de seguridad:
--   * El público (rol "anon") solo puede leer los horarios (sin datos
--     personales) y llamar a get_public_config, get_availability y book_slot.
--   * Las reservas con datos personales no tienen permisos de lectura
--     directa para nadie: el panel las obtiene con funciones admin_* que
--     verifican que el usuario logueado esté en la tabla "admins".
--   * La capacidad y los duplicados se controlan con triggers e índices en
--     la base, así que no se pueden saltear desde el navegador.
-- =====================================================================


-- ---------------------------------------------------------------------
-- Tablas
-- ---------------------------------------------------------------------

-- Configuración general (una sola fila).
create table if not exists public.app_settings (
  id                   boolean primary key default true check (id),
  timezone             text not null default 'America/Argentina/Buenos_Aires',
  booking_horizon_days int  not null default 7 check (booking_horizon_days between 1 and 90)
);
insert into public.app_settings (id) values (true) on conflict do nothing;

-- Usuarios de Supabase Auth autorizados a usar el panel.
create table if not exists public.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Horario semanal: se repite todas las semanas.
create table if not exists public.schedule_templates (
  id         uuid primary key default gen_random_uuid(),
  weekday    smallint not null check (weekday between 0 and 6), -- 0 = domingo … 6 = sábado
  start_time time not null,
  end_time   time not null,
  capacity   int  not null check (capacity between 1 and 1000),
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  check (end_time > start_time),
  unique (weekday, start_time)
);

-- Turnos concretos (una fecha y un horario).
create table if not exists public.slots (
  id             uuid primary key default gen_random_uuid(),
  slot_date      date not null,
  start_time     time not null,
  end_time       time not null,
  capacity       int  not null check (capacity between 1 and 1000),
  reserved_count int  not null default 0 check (reserved_count >= 0), -- lo mantiene un trigger
  closed         boolean not null default false,
  template_id    uuid references public.schedule_templates (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (end_time > start_time),
  unique (slot_date, start_time)
);
-- true = el admin lo cambió para esta fecha; el horario semanal ya no lo toca.
alter table public.slots add column if not exists customized boolean not null default false;
-- true = el admin lo quitó de esta fecha (se guarda para que no se vuelva a crear).
alter table public.slots add column if not exists hidden boolean not null default false;
create index if not exists slots_date_idx on public.slots (slot_date);
create index if not exists slots_template_idx on public.slots (template_id);

-- Días sin actividad (feriados, mantenimiento, etc.).
create table if not exists public.closed_days (
  day        date primary key,
  reason     text not null check (char_length(reason) between 1 and 80),
  created_at timestamptz not null default now()
);

-- Reservas individuales: cada fila es una persona y ocupa un lugar.
create table if not exists public.reservations (
  id           uuid primary key default gen_random_uuid(),
  slot_id      uuid not null references public.slots (id) on delete restrict,
  first_name   text not null,
  last_name    text not null,
  document     text not null, -- normalizado (ver normalize_document)
  status       text not null default 'active' check (status in ('active', 'cancelled')),
  created_at   timestamptz not null default now(),
  cancelled_at timestamptz,
  cancelled_by uuid references auth.users (id) on delete set null
);
create index if not exists reservations_slot_idx on public.reservations (slot_id);
create index if not exists reservations_document_idx on public.reservations (document);

-- Un mismo documento no puede tener dos reservas activas en el mismo turno.
create unique index if not exists reservations_one_per_document_per_slot
  on public.reservations (slot_id, document) where status = 'active';


-- ---------------------------------------------------------------------
-- Funciones que cambiaron de forma o se reemplazaron (versiones anteriores)
-- ---------------------------------------------------------------------

drop function if exists public.get_availability(date, date);
drop function if exists public.admin_list_slots(date, date);
drop function if exists public.slot_status(public.slots);
drop function if exists public.admin_generate_slots(date, date);
drop function if exists public.admin_apply_template_capacity(uuid);


-- ---------------------------------------------------------------------
-- Funciones auxiliares
-- ---------------------------------------------------------------------

-- Fecha y hora actual en la zona horaria del complejo (sin zona).
create or replace function public.app_now() returns timestamp
language sql stable security definer set search_path = public as $$
  select now() at time zone (select timezone from public.app_settings where id)
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid())
$$;

create or replace function public.require_admin() returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'NOT_AUTHORIZED';
  end if;
end $$;

-- "12.345.678", "12 345 678" y "012345678" quedan todos como "12345678".
create or replace function public.normalize_document(p text) returns text
language plpgsql immutable as $$
declare
  d text := upper(regexp_replace(coalesce(p, ''), '[^0-9A-Za-z]', '', 'g'));
begin
  if d ~ '^[0-9]+$' then
    d := ltrim(d, '0');
  end if;
  return d;
end $$;

-- Entre 6 y 12 letras o números, con al menos un número (DNI o pasaporte).
create or replace function public.is_valid_document(p text) returns boolean
language sql immutable as $$
  select p ~ '^[A-Z0-9]{6,12}$' and p ~ '[0-9]'
$$;

create or replace function public.clean_name(p text) returns text
language sql immutable as $$
  select regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g')
$$;

-- Entre 2 y 60 caracteres, sin números ni símbolos raros.
create or replace function public.is_valid_name(p text) returns boolean
language sql immutable as $$
  select char_length(p) between 2 and 60
     and char_length(translate(p, '0123456789<>@#$%&*=+_/\|{}[]"!?;:¿¡()', '')) = char_length(p)
$$;

-- Minúsculas y sin acentos, para buscar "perez" y encontrar "Pérez".
create or replace function public.fold_text(p text) returns text
language sql immutable as $$
  select translate(lower(coalesce(p, '')),
                   'áéíóúüñÁÉÍÓÚÜÑàèìòùâêîôûäëïö',
                   'aeiouunaeiouunaeiouaeiouaeio')
$$;

create or replace function public.slot_started(s public.slots) returns boolean
language sql stable security definer set search_path = public as $$
  select (s.slot_date + s.start_time) <= public.app_now()
$$;

-- Estado visible de un turno. El orden importa: un turno que ya empezó es
-- "finalizado" aunque esté cerrado o lleno.
create or replace function public.slot_status(s public.slots) returns text
language sql stable security definer set search_path = public as $$
  select case
    when public.slot_started(s)                                              then 'finalizado'
    when s.closed or exists (select 1 from public.closed_days where day = s.slot_date) then 'cerrado'
    when s.reserved_count >= s.capacity                                      then 'lleno'
    else 'disponible'
  end
$$;

create or replace function public.active_reservations(p_slot_id uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.reservations where slot_id = p_slot_id and status = 'active'
$$;


-- ---------------------------------------------------------------------
-- Horario semanal → turnos de cada fecha
-- ---------------------------------------------------------------------

-- Crea los turnos que falten entre dos fechas según el horario semanal.
-- Los que ya existen (incluidos los modificados o quitados) no se tocan.
create or replace function public.generate_slots(p_from date, p_to date) returns int
language plpgsql volatile security definer set search_path = public as $$
declare
  n      int;
  v_from date := greatest(p_from, public.app_now()::date);
begin
  if p_to < v_from then return 0; end if;
  if p_to - v_from > 400 then raise exception 'INVALID_DATE_RANGE'; end if;
  insert into public.slots (slot_date, start_time, end_time, capacity, template_id)
  select v_from + i, t.start_time, t.end_time, t.capacity, t.id
  from generate_series(0, p_to - v_from) i
  join public.schedule_templates t
    on t.active and t.weekday = extract(dow from v_from + i)::int
  where (v_from + i + t.start_time) > public.app_now()
  on conflict (slot_date, start_time) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- Saca de circulación un turno que ya no corresponde al horario semanal:
-- si tiene reservas activas se conserva tal cual (para no dejar a nadie sin
-- turno); si tuvo reservas canceladas se oculta; si nunca tuvo, se borra.
create or replace function public.retire_slot(p_slot_id uuid) returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  if public.active_reservations(p_slot_id) > 0 then
    update public.slots set customized = true where id = p_slot_id;
  elsif exists (select 1 from public.reservations where slot_id = p_slot_id) then
    update public.slots set hidden = true, customized = true where id = p_slot_id;
  else
    delete from public.slots where id = p_slot_id;
  end if;
end $$;

-- Lleva los cambios de una fila del horario semanal a sus turnos futuros que
-- no fueron modificados a mano. La capacidad nunca baja de las reservas activas.
create or replace function public.sync_template_slots(p_template_id uuid) returns void
language plpgsql volatile security definer set search_path = public as $$
declare
  t      public.schedule_templates;
  s      public.slots;
  v_cap  int;
  v_days int;
begin
  select * into t from public.schedule_templates where id = p_template_id;

  for s in
    select * from public.slots
    where template_id = p_template_id and not customized and not public.slot_started(slots)
    order by slot_date
    for update
  loop
    if coalesce(t.active, false)
       and s.start_time = t.start_time
       and extract(dow from s.slot_date)::int = t.weekday then
      v_cap := greatest(t.capacity, public.active_reservations(s.id));
      if s.end_time <> t.end_time or s.capacity <> v_cap then
        update public.slots set end_time = t.end_time, capacity = v_cap where id = s.id;
      end if;
    else
      perform public.retire_slot(s.id);
    end if;
  end loop;

  select booking_horizon_days into v_days from public.app_settings where id;
  perform public.generate_slots(public.app_now()::date, public.app_now()::date + v_days);
end $$;


-- ---------------------------------------------------------------------
-- Triggers: las reglas de capacidad viven acá, no en la interfaz
-- ---------------------------------------------------------------------

-- Antes de insertar una reserva: bloquea la fila del turno (así dos personas
-- que reservan al mismo tiempo se atienden de a una) y verifica el lugar.
create or replace function public.trg_reservation_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  s public.slots;
begin
  select * into s from public.slots where id = new.slot_id for update;
  if not found or s.hidden then
    raise exception 'SLOT_NOT_FOUND';
  end if;
  if public.slot_started(s) then
    raise exception 'SLOT_FINISHED';
  end if;
  if exists (select 1 from public.closed_days where day = s.slot_date) then
    raise exception 'DAY_CLOSED';
  end if;
  if s.closed then
    raise exception 'SLOT_CLOSED';
  end if;
  if exists (select 1 from public.reservations
             where slot_id = s.id and document = new.document and status = 'active') then
    raise exception 'DUPLICATE';
  end if;
  if public.active_reservations(s.id) >= s.capacity then
    raise exception 'SLOT_FULL';
  end if;

  new.status       := 'active';
  new.cancelled_at := null;
  new.cancelled_by := null;
  return new;
end $$;

drop trigger if exists reservation_before_insert on public.reservations;
create trigger reservation_before_insert
  before insert on public.reservations
  for each row execute function public.trg_reservation_before_insert();

-- Una reserva cancelada no se puede reactivar ni mover de turno: se hace una nueva.
create or replace function public.trg_reservation_before_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.slot_id <> old.slot_id or new.document <> old.document then
    raise exception 'RESERVATION_IMMUTABLE';
  end if;
  if old.status = 'cancelled' and new.status = 'active' then
    raise exception 'RESERVATION_IMMUTABLE';
  end if;
  return new;
end $$;

drop trigger if exists reservation_before_update on public.reservations;
create trigger reservation_before_update
  before update on public.reservations
  for each row execute function public.trg_reservation_before_update();

-- Después de cualquier cambio en reservas: recalcula los lugares ocupados.
-- Ese UPDATE sobre "slots" es el que dispara la actualización en tiempo real.
create or replace function public.trg_reservation_after_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.slots s
     set reserved_count = (select count(*) from public.reservations r
                           where r.slot_id = s.id and r.status = 'active'),
         updated_at = now()
   where s.id in (new.slot_id, old.slot_id);
  return null;
end $$;

drop trigger if exists reservation_after_change on public.reservations;
create trigger reservation_after_change
  after insert or update or delete on public.reservations
  for each row execute function public.trg_reservation_after_change();

-- No se puede bajar la capacidad por debajo de las reservas activas.
create or replace function public.trg_slot_before_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  n int;
begin
  if new.capacity <> old.capacity then
    n := public.active_reservations(new.id);
    if new.capacity < n then
      raise exception 'CAPACITY_BELOW_RESERVED' using detail = n::text;
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists slot_before_update on public.slots;
create trigger slot_before_update
  before update on public.slots
  for each row execute function public.trg_slot_before_update();


-- ---------------------------------------------------------------------
-- API pública (sin login)
-- ---------------------------------------------------------------------

create or replace function public.get_public_config() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'today',        to_char(public.app_now(), 'YYYY-MM-DD'),
    'now',          to_char(public.app_now(), 'YYYY-MM-DD"T"HH24:MI:SS'),
    'horizon_days', booking_horizon_days,
    'timezone',     timezone
  )
  from public.app_settings where id
$$;

-- Disponibilidad entre dos fechas, limitada a hoy … hoy + días de anticipación.
-- Crea los turnos que falten según el horario semanal antes de responder.
-- Solo devuelve cantidades y estados, nunca datos de personas.
create or replace function public.get_availability(p_from date default null, p_to date default null)
returns table (slot_id uuid, slot_date date, start_time time, end_time time,
               capacity int, available int, status text, note text)
language plpgsql volatile security definer set search_path = public as $$
declare
  v_today date := public.app_now()::date;
  v_h     int;
  v_from  date;
  v_to    date;
begin
  select booking_horizon_days into v_h from public.app_settings where id;
  v_from := greatest(coalesce(p_from, v_today), v_today);
  v_to   := least(coalesce(p_to, v_today + v_h), v_today + v_h);
  perform public.generate_slots(v_from, v_to);

  return query
    select s.id, s.slot_date, s.start_time, s.end_time, s.capacity,
           greatest(s.capacity - s.reserved_count, 0), public.slot_status(s), cd.reason
    from public.slots s
    left join public.closed_days cd on cd.day = s.slot_date
    where s.slot_date between v_from and v_to and not s.hidden
    order by s.slot_date, s.start_time;
end $$;

-- Crea una reserva individual. Valida y normaliza los datos; la capacidad y
-- los duplicados los vuelve a verificar el trigger con el turno bloqueado.
create or replace function public.book_slot(p_slot_id uuid, p_first_name text,
                                            p_last_name text, p_document text)
returns json
language plpgsql volatile security definer set search_path = public as $$
declare
  v_first text := public.clean_name(p_first_name);
  v_last  text := public.clean_name(p_last_name);
  v_doc   text := public.normalize_document(p_document);
  v_id    uuid;
  s       public.slots;
  v_today date := public.app_now()::date;
  v_h     int;
begin
  if not public.is_valid_name(v_first) then raise exception 'INVALID_FIRST_NAME'; end if;
  if not public.is_valid_name(v_last)  then raise exception 'INVALID_LAST_NAME';  end if;
  if not public.is_valid_document(v_doc) then raise exception 'INVALID_DOCUMENT'; end if;

  select * into s from public.slots where id = p_slot_id;
  if not found then raise exception 'SLOT_NOT_FOUND'; end if;
  select booking_horizon_days into v_h from public.app_settings where id;
  if s.slot_date > v_today + v_h then raise exception 'OUT_OF_RANGE'; end if;

  begin
    insert into public.reservations (slot_id, first_name, last_name, document)
    values (p_slot_id, v_first, v_last, v_doc)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'DUPLICATE';
  end;

  return json_build_object(
    'id',         v_id,
    'code',       upper(left(replace(v_id::text, '-', ''), 8)),
    'slot_date',  s.slot_date,
    'start_time', to_char(s.start_time, 'HH24:MI'),
    'end_time',   to_char(s.end_time, 'HH24:MI'),
    'first_name', v_first,
    'last_name',  v_last,
    'document',   v_doc
  );
end $$;


-- ---------------------------------------------------------------------
-- API del panel (requiere usuario logueado que esté en "admins")
-- ---------------------------------------------------------------------

-- Turnos entre dos fechas (crea los que falten). Incluye los quitados
-- (hidden = true) para poder restaurarlos.
create or replace function public.admin_list_slots(p_from date, p_to date)
returns table (slot_id uuid, slot_date date, start_time time, end_time time, capacity int,
               reserved int, available int, closed boolean, status text, template_id uuid,
               customized boolean, hidden boolean, note text)
language plpgsql volatile security definer set search_path = public as $$
begin
  perform public.require_admin();
  if p_to - p_from > 62 then raise exception 'INVALID_DATE_RANGE'; end if;
  perform public.generate_slots(p_from, p_to);
  return query
    select s.id, s.slot_date, s.start_time, s.end_time, s.capacity, s.reserved_count,
           greatest(s.capacity - s.reserved_count, 0), s.closed, public.slot_status(s),
           s.template_id, s.customized, s.hidden, cd.reason
    from public.slots s
    left join public.closed_days cd on cd.day = s.slot_date
    where s.slot_date between p_from and p_to
    order by s.slot_date, s.start_time;
end $$;

-- Agrega un horario solo para una fecha (o restaura uno quitado a esa hora).
create or replace function public.admin_create_slot(p_date date, p_start time, p_end time, p_capacity int)
returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare
  v_id uuid;
begin
  perform public.require_admin();
  if p_end <= p_start then raise exception 'INVALID_TIME_RANGE'; end if;
  if (p_date + p_start) <= public.app_now() then raise exception 'SLOT_IN_PAST'; end if;
  if p_capacity is null or p_capacity < 1 or p_capacity > 1000 then raise exception 'INVALID_CAPACITY'; end if;

  update public.slots
     set hidden = false, closed = false, customized = true, end_time = p_end,
         capacity = greatest(p_capacity, public.active_reservations(id))
   where slot_date = p_date and start_time = p_start and hidden
  returning id into v_id;
  if v_id is not null then return v_id; end if;

  insert into public.slots (slot_date, start_time, end_time, capacity, customized)
  values (p_date, p_start, p_end, p_capacity, true)
  returning id into v_id;
  return v_id;
exception
  when unique_violation then raise exception 'SLOT_EXISTS';
end $$;

-- Cambia la capacidad y/o abre o cierra un turno de una fecha puntual.
-- Pasar null deja el valor como está. El turno queda "modificado".
create or replace function public.admin_update_slot(p_slot_id uuid, p_capacity int default null,
                                                    p_closed boolean default null)
returns void
language plpgsql volatile security definer set search_path = public as $$
declare
  s public.slots;
begin
  perform public.require_admin();
  select * into s from public.slots where id = p_slot_id for update;
  if not found or s.hidden then raise exception 'SLOT_NOT_FOUND'; end if;
  if public.slot_started(s) then raise exception 'SLOT_FINISHED'; end if;
  if p_capacity is not null and (p_capacity < 1 or p_capacity > 1000) then
    raise exception 'INVALID_CAPACITY';
  end if;
  update public.slots
     set capacity   = coalesce(p_capacity, capacity),
         closed     = coalesce(p_closed, closed),
         customized = true
   where id = p_slot_id;
end $$;

-- Vuelve a dejar un turno igual al horario semanal (deshace los cambios de
-- esa fecha y lo restaura si se había quitado).
create or replace function public.admin_reset_slot(p_slot_id uuid) returns void
language plpgsql volatile security definer set search_path = public as $$
declare
  s public.slots;
begin
  perform public.require_admin();
  select * into s from public.slots where id = p_slot_id for update;
  if not found then raise exception 'SLOT_NOT_FOUND'; end if;
  if s.template_id is null then raise exception 'SLOT_NOT_FROM_TEMPLATE'; end if;
  if public.slot_started(s) then raise exception 'SLOT_FINISHED'; end if;
  update public.slots set customized = false, closed = false, hidden = false where id = p_slot_id;
  perform public.sync_template_slots(s.template_id);
end $$;

-- Quita un turno de una fecha. Si viene del horario semanal (o tuvo
-- reservas) se oculta para que no se vuelva a crear; si no, se borra.
create or replace function public.admin_delete_slot(p_slot_id uuid) returns void
language plpgsql volatile security definer set search_path = public as $$
declare
  s public.slots;
begin
  perform public.require_admin();
  select * into s from public.slots where id = p_slot_id for update;
  if not found then raise exception 'SLOT_NOT_FOUND'; end if;
  if public.active_reservations(p_slot_id) > 0 then raise exception 'SLOT_HAS_RESERVATIONS'; end if;
  if s.template_id is not null or exists (select 1 from public.reservations where slot_id = p_slot_id) then
    update public.slots set hidden = true, customized = true where id = p_slot_id;
  else
    delete from public.slots where id = p_slot_id;
  end if;
end $$;

-- Busca por nombre, apellido o documento (sin importar acentos ni formato del documento).
create or replace function public.admin_search_reservations(
  p_query text default null, p_slot_id uuid default null,
  p_from date default null, p_to date default null, p_status text default null)
returns table (reservation_id uuid, slot_id uuid, slot_date date, start_time time, end_time time,
               first_name text, last_name text, document text, status text,
               created_at timestamptz, cancelled_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare
  q   text := public.fold_text(public.clean_name(p_query));
  doc text := public.normalize_document(p_query);
begin
  perform public.require_admin();
  return query
    select r.id, s.id, s.slot_date, s.start_time, s.end_time,
           r.first_name, r.last_name, r.document, r.status, r.created_at, r.cancelled_at
    from public.reservations r
    join public.slots s on s.id = r.slot_id
    where (p_slot_id is null or r.slot_id = p_slot_id)
      and (p_from is null or s.slot_date >= p_from)
      and (p_to is null or s.slot_date <= p_to)
      and (p_status is null or r.status = p_status)
      and (q = ''
           or strpos(public.fold_text(r.first_name || ' ' || r.last_name), q) > 0
           or strpos(public.fold_text(r.last_name || ' ' || r.first_name), q) > 0
           or (doc <> '' and strpos(r.document, doc) > 0))
    order by s.slot_date desc, s.start_time, r.last_name, r.first_name
    limit 500;
end $$;

create or replace function public.admin_cancel_reservation(p_reservation_id uuid) returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  perform public.require_admin();
  update public.reservations
     set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
   where id = p_reservation_id and status = 'active';
  if not found then raise exception 'RESERVATION_NOT_ACTIVE'; end if;
end $$;

create or replace function public.admin_list_templates()
returns table (template_id uuid, weekday smallint, start_time time, end_time time,
               capacity int, active boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_admin();
  return query
    select t.id, t.weekday, t.start_time, t.end_time, t.capacity, t.active
    from public.schedule_templates t
    order by t.weekday, t.start_time;
end $$;

-- Crea (p_template_id null) o edita una fila del horario semanal y aplica el
-- cambio a todos los turnos futuros que no se modificaron a mano.
create or replace function public.admin_save_template(p_template_id uuid, p_weekday int, p_start time,
                                                      p_end time, p_capacity int, p_active boolean)
returns uuid
language plpgsql volatile security definer set search_path = public as $$
declare
  v_id uuid;
begin
  perform public.require_admin();
  if p_end <= p_start then raise exception 'INVALID_TIME_RANGE'; end if;
  if p_capacity is null or p_capacity < 1 or p_capacity > 1000 then raise exception 'INVALID_CAPACITY'; end if;
  begin
    if p_template_id is null then
      insert into public.schedule_templates (weekday, start_time, end_time, capacity, active)
      values (p_weekday, p_start, p_end, p_capacity, coalesce(p_active, true))
      returning id into v_id;
    else
      update public.schedule_templates
         set weekday = p_weekday, start_time = p_start, end_time = p_end,
             capacity = p_capacity, active = coalesce(p_active, active)
       where id = p_template_id
      returning id into v_id;
      if v_id is null then raise exception 'TEMPLATE_NOT_FOUND'; end if;
    end if;
  exception
    when unique_violation then raise exception 'TEMPLATE_EXISTS';
  end;
  perform public.sync_template_slots(v_id);
  return v_id;
end $$;

-- Borra una fila del horario semanal. Sus turnos futuros sin reservas
-- desaparecen; los que tienen reservas activas se conservan.
create or replace function public.admin_delete_template(p_template_id uuid) returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  perform public.require_admin();
  update public.schedule_templates set active = false where id = p_template_id;
  perform public.sync_template_slots(p_template_id);
  delete from public.schedule_templates where id = p_template_id;
end $$;

create or replace function public.admin_list_closed_days(p_from date default null)
returns table (day date, reason text, active_reservations int)
language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_admin();
  return query
    select c.day, c.reason,
           (select count(*)::int from public.reservations r join public.slots s on s.id = r.slot_id
            where s.slot_date = c.day and r.status = 'active')
    from public.closed_days c
    where c.day >= coalesce(p_from, public.app_now()::date)
    order by c.day;
end $$;

-- Cierra un día o un rango de días. Opcionalmente cancela las reservas
-- activas de esas fechas. Devuelve cuántos días se cerraron y cuántas
-- reservas se cancelaron.
create or replace function public.admin_close_days(p_from date, p_to date, p_reason text,
                                                   p_cancel_reservations boolean default false)
returns json
language plpgsql volatile security definer set search_path = public as $$
declare
  v_reason    text := left(public.clean_name(p_reason), 80);
  v_to        date := coalesce(p_to, p_from);
  v_days      int;
  v_cancelled int := 0;
begin
  perform public.require_admin();
  if p_from is null or v_to < p_from or v_to - p_from > 366 then raise exception 'INVALID_DATE_RANGE'; end if;
  if v_to < public.app_now()::date then raise exception 'DAY_IN_PAST'; end if;
  if v_reason = '' then v_reason := 'Cerrado'; end if;

  insert into public.closed_days (day, reason)
  select p_from + i, v_reason from generate_series(0, v_to - p_from) i
  where p_from + i >= public.app_now()::date
  on conflict (day) do update set reason = excluded.reason;
  get diagnostics v_days = row_count;

  if p_cancel_reservations then
    update public.reservations r
       set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid()
      from public.slots s
     where s.id = r.slot_id and r.status = 'active'
       and s.slot_date between greatest(p_from, public.app_now()::date) and v_to;
    get diagnostics v_cancelled = row_count;
  end if;

  -- Avisa a los navegadores abiertos (tiempo real).
  update public.slots set updated_at = now() where slot_date between p_from and v_to;

  return json_build_object('days', v_days, 'cancelled', v_cancelled);
end $$;

create or replace function public.admin_open_day(p_day date) returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  perform public.require_admin();
  delete from public.closed_days where day = p_day;
  update public.slots set updated_at = now() where slot_date = p_day;
end $$;

create or replace function public.admin_update_settings(p_booking_horizon_days int) returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  perform public.require_admin();
  update public.app_settings set booking_horizon_days = p_booking_horizon_days where id;
exception
  when check_violation then raise exception 'INVALID_HORIZON';
end $$;


-- ---------------------------------------------------------------------
-- Permisos
-- ---------------------------------------------------------------------

alter table public.app_settings       enable row level security;
alter table public.admins             enable row level security;
alter table public.schedule_templates enable row level security;
alter table public.slots              enable row level security;
alter table public.closed_days        enable row level security;
alter table public.reservations       enable row level security;

-- Supabase da acceso a todas las tablas por defecto: se lo quitamos y damos
-- solo lectura de "slots" (no tiene datos personales y la necesita el tiempo real).
revoke all on public.app_settings, public.admins, public.schedule_templates,
              public.slots, public.closed_days, public.reservations from anon, authenticated;
grant select on public.slots to anon, authenticated;

drop policy if exists slots_public_read on public.slots;
create policy slots_public_read on public.slots for select to anon, authenticated using (true);

-- Las funciones nuevas se pueden ejecutar por cualquiera salvo que se revoque.
revoke execute on all functions in schema public from public, anon, authenticated;

grant execute on function public.get_public_config()                        to anon, authenticated;
grant execute on function public.get_availability(date, date)               to anon, authenticated;
grant execute on function public.book_slot(uuid, text, text, text)          to anon, authenticated;
grant execute on function public.is_admin()                                 to anon, authenticated;

grant execute on function public.admin_list_slots(date, date)               to authenticated;
grant execute on function public.admin_create_slot(date, time, time, int)   to authenticated;
grant execute on function public.admin_update_slot(uuid, int, boolean)      to authenticated;
grant execute on function public.admin_reset_slot(uuid)                     to authenticated;
grant execute on function public.admin_delete_slot(uuid)                    to authenticated;
grant execute on function public.admin_search_reservations(text, uuid, date, date, text) to authenticated;
grant execute on function public.admin_cancel_reservation(uuid)             to authenticated;
grant execute on function public.admin_list_templates()                     to authenticated;
grant execute on function public.admin_save_template(uuid, int, time, time, int, boolean) to authenticated;
grant execute on function public.admin_delete_template(uuid)                to authenticated;
grant execute on function public.admin_list_closed_days(date)               to authenticated;
grant execute on function public.admin_close_days(date, date, text, boolean) to authenticated;
grant execute on function public.admin_open_day(date)                       to authenticated;
grant execute on function public.admin_update_settings(int)                 to authenticated;


-- ---------------------------------------------------------------------
-- Tiempo real: avisar a los navegadores cuando cambia un turno
-- ---------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'slots') then
    alter publication supabase_realtime add table public.slots;
  end if;
end $$;
