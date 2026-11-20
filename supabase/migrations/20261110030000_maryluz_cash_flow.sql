alter table public.prestamos
  add column monto_desembolsado numeric(12, 2)
    check (monto_desembolsado is null or (
      monto_desembolsado >= 0 and monto_desembolsado <= monto
    ));

create table public.control_caja (
  cartera_id uuid primary key references public.carteras (id) on delete restrict,
  fecha_inicio date not null,
  iniciado_en timestamptz not null default now(),
  creado_por uuid not null default auth.uid()
    references auth.users (id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.movimientos_caja (
  id uuid primary key default gen_random_uuid(),
  cartera_id uuid not null references public.carteras (id) on delete restrict,
  tipo text not null check (tipo in (
    'saldo_inicial',
    'pago_recibido',
    'reinversion_prestamo',
    'gasto_personal',
    'ajuste_bancario',
    'reversion_pago_prueba',
    'reversion_prestamo_prueba'
  )),
  monto numeric(12, 2) not null,
  descripcion text not null check (length(trim(descripcion)) > 0),
  referencia_id uuid,
  creado_por uuid references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint movimientos_caja_monto_tipo_check check (
    (tipo = 'saldo_inicial' and monto >= 0)
    or (tipo in ('pago_recibido', 'reinversion_prestamo') and monto <> 0)
    or (tipo in (
      'gasto_personal',
      'ajuste_bancario',
      'reversion_pago_prueba',
      'reversion_prestamo_prueba'
    ) and monto <> 0)
  )
);

create unique index movimientos_caja_pago_referenciado_unique
  on public.movimientos_caja (referencia_id)
  where tipo = 'pago_recibido' and referencia_id is not null;

create unique index movimientos_caja_prestamo_referenciado_unique
  on public.movimientos_caja (referencia_id)
  where tipo = 'reinversion_prestamo' and referencia_id is not null;

create index movimientos_caja_cartera_created_idx
  on public.movimientos_caja (cartera_id, created_at desc);

alter table public.control_caja enable row level security;
alter table public.movimientos_caja enable row level security;

revoke all on table public.control_caja, public.movimientos_caja
  from public, anon, authenticated;
grant select on public.control_caja, public.movimientos_caja to authenticated;

create policy control_caja_admin_select
  on public.control_caja for select to authenticated
  using (
    public.is_admin()
    and cartera_id = (
      select c.id from public.carteras as c where c.clave = 'y'
    )
  );

create policy movimientos_caja_admin_select
  on public.movimientos_caja for select to authenticated
  using (
    public.is_admin()
    and cartera_id = (
      select c.id from public.carteras as c where c.clave = 'y'
    )
  );

create or replace function public.configurar_control_caja(
  p_saldo_inicial numeric,
  p_fecha_inicio date
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_cartera_id uuid;
  v_control public.control_caja%rowtype;
begin
  if v_actor_id is null or not public.is_admin() then
    raise exception 'Solo el administrador puede configurar el control de caja.'
      using errcode = '42501';
  end if;

  if p_saldo_inicial is null
    or p_saldo_inicial < 0
    or p_saldo_inicial > 9999999999.99
    or p_fecha_inicio is distinct from (now() at time zone 'America/New_York')::date
  then
    raise exception 'Ingresa un saldo válido y configura el control con la fecha de hoy.'
      using errcode = '22023';
  end if;

  select c.id
    into v_cartera_id
    from public.carteras as c
    where c.clave = 'y'
    for update;

  if v_cartera_id is null then
    raise exception 'No se encontró la cartera asignada a Maryluz.'
      using errcode = 'P0002';
  end if;

  insert into public.control_caja (cartera_id, fecha_inicio, iniciado_en, creado_por)
  values (v_cartera_id, p_fecha_inicio, now(), v_actor_id)
  on conflict (cartera_id) do nothing
  returning * into v_control;

  if v_control.cartera_id is null then
    raise exception 'El control de caja ya fue configurado y no se puede reiniciar.'
      using errcode = '23505';
  end if;

  insert into public.movimientos_caja (
    cartera_id, tipo, monto, descripcion, creado_por
  )
  values (
    v_cartera_id,
    'saldo_inicial',
    p_saldo_inicial,
    'Saldo confirmado en la cuenta bancaria al iniciar el control.',
    v_actor_id
  );

  return v_cartera_id;
end;
$$;

create or replace function public.registrar_movimiento_caja(
  p_tipo text,
  p_monto numeric,
  p_descripcion text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_cartera_id uuid;
  v_saldo numeric;
  v_monto numeric;
  v_control public.control_caja%rowtype;
  v_movimiento_id uuid;
begin
  if v_actor_id is null or not public.is_admin() then
    raise exception 'Solo el administrador puede registrar movimientos de caja.'
      using errcode = '42501';
  end if;

  if p_tipo is null
    or p_tipo not in ('gasto_personal', 'ajuste_bancario')
    or p_monto is null
    or p_monto = 0
    or p_monto < -9999999999.99
    or p_monto > 9999999999.99
    or nullif(trim(p_descripcion), '') is null
  then
    raise exception 'El tipo, monto o descripción del movimiento no son válidos.'
      using errcode = '22023';
  end if;

  select c.id
    into v_cartera_id
    from public.carteras as c
    where c.clave = 'y';

  if v_cartera_id is null then
    raise exception 'No se encontró la cartera asignada a Maryluz.'
      using errcode = 'P0002';
  end if;

  select *
    into v_control
    from public.control_caja as c
    where c.cartera_id = v_cartera_id
    for update;

  if not found then
    raise exception 'Configura primero el saldo inicial del control de caja.'
      using errcode = '23514';
  end if;

  v_monto := case when p_tipo = 'gasto_personal' then -abs(p_monto) else p_monto end;

  select coalesce(sum(m.monto), 0)
    into v_saldo
    from public.movimientos_caja as m
    where m.cartera_id = v_cartera_id;

  if p_tipo = 'gasto_personal' and v_saldo + v_monto < 0 then
    raise exception 'El saldo disponible no alcanza para este movimiento.'
      using errcode = '23514';
  end if;

  insert into public.movimientos_caja (
    cartera_id, tipo, monto, descripcion, creado_por
  )
  values (
    v_cartera_id,
    p_tipo,
    v_monto,
    trim(p_descripcion),
    v_actor_id
  )
  returning id into v_movimiento_id;

  return v_movimiento_id;
end;
$$;

create or replace function public.procesar_desembolso_caja()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cartera_caja_id uuid;
  v_saldo numeric;
  v_control public.control_caja%rowtype;
begin
  select c.id
    into v_cartera_caja_id
    from public.carteras as c
    where c.clave = 'y';

  if v_cartera_caja_id is null
    or new.cartera_id is distinct from v_cartera_caja_id
  then
    return new;
  end if;

  new.created_at := now();
  new.monto_desembolsado := coalesce(new.monto_desembolsado, new.monto);
  if new.monto_desembolsado < 0 or new.monto_desembolsado > new.monto then
    raise exception 'El efectivo a entregar debe estar entre cero y el monto del préstamo.'
      using errcode = '22023';
  end if;

  select *
    into v_control
    from public.control_caja as c
    where c.cartera_id = v_cartera_caja_id
    for update;

  if not found then
    raise exception 'Configura primero el saldo inicial del tablero de control financiero.'
      using errcode = '23514';
  end if;

  select coalesce(sum(m.monto), 0)
    into v_saldo
    from public.movimientos_caja as m
    where m.cartera_id = v_cartera_caja_id;

  if new.monto_desembolsado > v_saldo then
    raise exception 'El saldo disponible no alcanza para entregar este préstamo.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create or replace function public.registrar_desembolso_caja()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cartera_caja_id uuid;
begin
  select c.id
    into v_cartera_caja_id
    from public.carteras as c
    where c.clave = 'y';

  if v_cartera_caja_id is not null
    and new.cartera_id = v_cartera_caja_id
    and new.monto_desembolsado > 0
  then
    insert into public.movimientos_caja (
      cartera_id, tipo, monto, descripcion, referencia_id, creado_por, created_at
    )
    values (
      new.cartera_id,
      'reinversion_prestamo',
      -new.monto_desembolsado,
      case
        when new.monto_desembolsado < new.monto then
          format('Desembolso neto del préstamo %s después de refinanciar.', new.codigo)
        else format('Desembolso del préstamo %s.', new.codigo)
      end,
      new.id,
      auth.uid(),
      new.created_at
    );
  end if;

  return new;
end;
$$;

create or replace function public.registrar_pago_en_caja()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cartera_caja_id uuid;
  v_control public.control_caja%rowtype;
begin
  select c.id
    into v_cartera_caja_id
    from public.carteras as c
    where c.clave = 'y';

  if v_cartera_caja_id is null
    or new.cartera_id is distinct from v_cartera_caja_id
  then
    return new;
  end if;

  new.pagado_en := now();

  select *
    into v_control
    from public.control_caja as c
    where c.cartera_id = v_cartera_caja_id
    for update;

  if found and new.pagado_en >= v_control.iniciado_en then
    insert into public.movimientos_caja (
      cartera_id, tipo, monto, descripcion, referencia_id, creado_por, created_at
    )
    values (
      new.cartera_id,
      'pago_recibido',
      new.monto,
      format('Pago registrado para el préstamo %s.', new.prestamo_id),
      new.id,
      new.registrado_por,
      new.pagado_en
    );
  end if;

  return new;
end;
$$;

create or replace function public.compensar_pago_eliminado_de_caja()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_movimiento public.movimientos_caja%rowtype;
  v_control public.control_caja%rowtype;
begin
  select c.*
    into v_control
    from public.control_caja as c
    where c.cartera_id = old.cartera_id
    for update;

  select m.*
    into v_movimiento
    from public.movimientos_caja as m
    where m.tipo = 'pago_recibido'
      and m.referencia_id = old.id;

  if found then
    insert into public.movimientos_caja (
      cartera_id, tipo, monto, descripcion, referencia_id, creado_por
    )
    values (
      v_movimiento.cartera_id,
      'reversion_pago_prueba',
      -v_movimiento.monto,
      format('Compensación de movimiento por eliminación de pago de prueba %s.', old.id),
      old.id,
      auth.uid()
    );
  end if;

  return old;
end;
$$;

create or replace function public.compensar_prestamo_eliminado_de_caja()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_movimiento public.movimientos_caja%rowtype;
  v_control public.control_caja%rowtype;
begin
  select c.*
    into v_control
    from public.control_caja as c
    where c.cartera_id = old.cartera_id
    for update;

  select m.*
    into v_movimiento
    from public.movimientos_caja as m
    where m.tipo = 'reinversion_prestamo'
      and m.referencia_id = old.id;

  if found then
    insert into public.movimientos_caja (
      cartera_id, tipo, monto, descripcion, referencia_id, creado_por
    )
    values (
      v_movimiento.cartera_id,
      'reversion_prestamo_prueba',
      -v_movimiento.monto,
      format('Compensación de desembolso por eliminación de préstamo de prueba %s.', old.codigo),
      old.id,
      auth.uid()
    );
  end if;

  return old;
end;
$$;

create or replace function public.proteger_movimiento_caja()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Los movimientos de caja son inmutables; registra un ajuste para corregirlos.'
    using errcode = '23514';
end;
$$;

create trigger prestamos_validar_desembolso_caja
  before insert on public.prestamos
  for each row execute function public.procesar_desembolso_caja();

create trigger prestamos_registrar_desembolso_caja
  after insert on public.prestamos
  for each row execute function public.registrar_desembolso_caja();

create trigger pagos_registrar_movimiento_caja
  before insert on public.pagos
  for each row execute function public.registrar_pago_en_caja();

create trigger pagos_compensar_eliminacion_caja
  after delete on public.pagos
  for each row execute function public.compensar_pago_eliminado_de_caja();

create trigger prestamos_compensar_eliminacion_caja
  after delete on public.prestamos
  for each row execute function public.compensar_prestamo_eliminado_de_caja();

create trigger movimientos_caja_inmutables
  before update or delete on public.movimientos_caja
  for each row execute function public.proteger_movimiento_caja();

create or replace function public.refinanciar_prestamo(
  p_prestamo_anterior_id uuid,
  p_cartera_id uuid,
  p_deudor_id uuid,
  p_monto numeric,
  p_tasa_interes numeric,
  p_dia_pago_semana smallint,
  p_numero_cuotas integer,
  p_fecha_inicio date,
  p_fecha_fin date,
  p_notas text,
  p_cuotas jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_prestamo_anterior public.prestamos%rowtype;
  v_prestamo_nuevo public.prestamos%rowtype;
  v_cuotas_pendientes integer;
  v_saldo_pendiente numeric;
  v_cuotas_recibidas integer;
  v_numero_minimo integer;
  v_numero_maximo integer;
  v_numeros_distintos integer;
  v_capital_total numeric;
  v_nota_refinanciacion text;
  v_notas_nuevo_prestamo text;
begin
  if v_actor_id is null or not public.is_admin() then
    raise exception 'Solo el administrador puede refinanciar préstamos.'
      using errcode = '42501';
  end if;

  if p_prestamo_anterior_id is null
    or p_cartera_id is null
    or p_deudor_id is null
    or p_monto is null
    or p_tasa_interes is null
    or p_dia_pago_semana is null
    or p_numero_cuotas is null
    or p_fecha_inicio is null
    or p_fecha_fin is null
    or p_cuotas is null
    or p_numero_cuotas < 1
    or p_numero_cuotas > 520
    or p_monto <= 0
    or p_tasa_interes < 0
    or p_dia_pago_semana not between 1 and 7
    or p_fecha_fin < p_fecha_inicio
    or jsonb_typeof(p_cuotas) is distinct from 'array'
    or jsonb_array_length(p_cuotas) <> p_numero_cuotas
  then
    raise exception 'Los datos del nuevo préstamo o su cronograma no son válidos.'
      using errcode = '22023';
  end if;

  perform 1
    from public.deudores
    where id = p_deudor_id and cartera_id = p_cartera_id
    for update;

  if not found then
    raise exception 'El cliente no pertenece a la cartera seleccionada.'
      using errcode = '23503';
  end if;

  select *
    into v_prestamo_anterior
    from public.prestamos
    where id = p_prestamo_anterior_id
      and cartera_id = p_cartera_id
      and deudor_id = p_deudor_id
    for update;

  if not found or v_prestamo_anterior.estado = 'terminado' then
    raise exception 'El préstamo que se intenta refinanciar no está activo.'
      using errcode = '23514';
  end if;

  select count(*), coalesce(sum(monto), 0)
    into v_cuotas_pendientes, v_saldo_pendiente
    from public.cuotas
    where prestamo_id = p_prestamo_anterior_id
      and cartera_id = p_cartera_id
      and estado = 'pendiente';

  if v_cuotas_pendientes < 3 then
    raise exception 'Solo se puede refinanciar un préstamo con al menos 3 cuotas pendientes.'
      using errcode = '23514';
  end if;

  if p_monto < v_saldo_pendiente then
    raise exception 'El capital del nuevo préstamo no puede ser menor que el saldo pendiente que se descontará.'
      using errcode = '23514';
  end if;

  select
    count(*),
    coalesce(min(numero), 0),
    coalesce(max(numero), 0),
    count(distinct numero),
    coalesce(sum(capital), 0)
    into
      v_cuotas_recibidas,
      v_numero_minimo,
      v_numero_maximo,
      v_numeros_distintos,
      v_capital_total
    from jsonb_to_recordset(p_cuotas) as item(
      numero integer,
      fecha_vencimiento date,
      capital numeric,
      intereses numeric,
      monto numeric
    );

  if v_cuotas_recibidas <> p_numero_cuotas
    or v_numero_minimo <> 1
    or v_numero_maximo <> p_numero_cuotas
    or v_numeros_distintos <> p_numero_cuotas
    or v_capital_total <> p_monto
    or exists (
      select 1
        from jsonb_to_recordset(p_cuotas) as item(
          numero integer,
          fecha_vencimiento date,
          capital numeric,
          intereses numeric,
          monto numeric
        )
        where numero is null
          or fecha_vencimiento is null
          or fecha_vencimiento < p_fecha_inicio
          or capital is null
          or capital < 0
          or intereses is null
          or intereses < 0
          or monto is null
          or monto <= 0
          or monto <> capital + intereses
    )
    or exists (
      select 1
        from (
          select
            numero,
            fecha_vencimiento,
            lag(fecha_vencimiento) over (order by numero) as fecha_anterior
            from jsonb_to_recordset(p_cuotas) as item(
              numero integer,
              fecha_vencimiento date,
              capital numeric,
              intereses numeric,
              monto numeric
            )
        ) as cronograma
        where fecha_anterior is not null
          and fecha_vencimiento <> fecha_anterior + 7
    )
  then
    raise exception 'El cronograma del nuevo préstamo no es consistente.'
      using errcode = '23514';
  end if;

  update public.cuotas
    set estado = 'pagada'
    where prestamo_id = p_prestamo_anterior_id
      and cartera_id = p_cartera_id
      and estado = 'pendiente';

  update public.prestamos
    set estado = 'terminado'
    where id = p_prestamo_anterior_id;

  v_notas_nuevo_prestamo := concat_ws(
    E'\n\n',
    nullif(trim(p_notas), ''),
    format(
      'Refinancia el préstamo %s. Se descontaron %s por sus %s cuotas pendientes; efectivo neto entregado: %s. No se registró como pago en efectivo.',
      v_prestamo_anterior.codigo,
      v_saldo_pendiente,
      v_cuotas_pendientes,
      p_monto - v_saldo_pendiente
    )
  );

  insert into public.prestamos (
    cartera_id,
    deudor_id,
    monto,
    monto_desembolsado,
    tasa_interes,
    metodo_calculo,
    dia_pago_semana,
    numero_cuotas,
    fecha_inicio,
    fecha_fin,
    notas,
    estado
  )
  values (
    p_cartera_id,
    p_deudor_id,
    p_monto,
    p_monto - v_saldo_pendiente,
    p_tasa_interes,
    'fijo_capital_inicial',
    p_dia_pago_semana,
    p_numero_cuotas,
    p_fecha_inicio,
    p_fecha_fin,
    v_notas_nuevo_prestamo,
    'activo'
  )
  returning * into v_prestamo_nuevo;

  insert into public.cuotas (
    cartera_id, prestamo_id, numero, fecha_vencimiento,
    capital, intereses, monto, estado
  )
  select
    p_cartera_id,
    v_prestamo_nuevo.id,
    item.numero,
    item.fecha_vencimiento,
    item.capital,
    item.intereses,
    item.monto,
    'pendiente'
  from jsonb_to_recordset(p_cuotas) as item(
    numero integer,
    fecha_vencimiento date,
    capital numeric,
    intereses numeric,
    monto numeric
  )
  order by item.numero;

  v_nota_refinanciacion := format(
    'Liquidado por refinanciación el %s. Se descontaron %s de %s cuotas pendientes al crear el préstamo %s. Este registro no representa dinero recibido ni interés cobrado.',
    to_char(now() at time zone 'America/New_York', 'YYYY-MM-DD HH24:MI'),
    v_saldo_pendiente,
    v_cuotas_pendientes,
    v_prestamo_nuevo.codigo
  );

  update public.prestamos
    set notas = concat_ws(
      E'\n\n',
      nullif(trim(v_prestamo_anterior.notas), ''),
      v_nota_refinanciacion
    )
    where id = p_prestamo_anterior_id;

  return v_prestamo_nuevo.id;
end;
$$;

revoke all on function public.configurar_control_caja(numeric, date)
  from public, anon, authenticated;
revoke all on function public.registrar_movimiento_caja(text, numeric, text)
  from public, anon, authenticated;
revoke all on function public.procesar_desembolso_caja()
  from public, anon, authenticated;
revoke all on function public.registrar_desembolso_caja()
  from public, anon, authenticated;
revoke all on function public.registrar_pago_en_caja()
  from public, anon, authenticated;
revoke all on function public.compensar_pago_eliminado_de_caja()
  from public, anon, authenticated;
revoke all on function public.compensar_prestamo_eliminado_de_caja()
  from public, anon, authenticated;
revoke all on function public.proteger_movimiento_caja()
  from public, anon, authenticated;
revoke all on function public.refinanciar_prestamo(
  uuid, uuid, uuid, numeric, numeric, smallint, integer, date, date, text, jsonb
) from public, anon, authenticated;

grant execute on function public.configurar_control_caja(numeric, date)
  to authenticated;
grant execute on function public.registrar_movimiento_caja(text, numeric, text)
  to authenticated;
grant execute on function public.refinanciar_prestamo(
  uuid, uuid, uuid, numeric, numeric, smallint, integer, date, date, text, jsonb
) to authenticated;
