alter table public.movimientos_caja
  add column intereses numeric(12, 2) not null default 0;

alter table public.movimientos_caja
  drop constraint movimientos_caja_tipo_check,
  drop constraint movimientos_caja_monto_tipo_check;

alter table public.movimientos_caja
  add constraint movimientos_caja_tipo_check check (tipo in (
    'saldo_inicial',
    'pago_recibido',
    'reinversion_prestamo',
    'gasto_personal',
    'ajuste_bancario',
    'ingreso_salario',
    'reversion_pago_prueba',
    'reversion_prestamo_prueba'
  )),
  add constraint movimientos_caja_monto_tipo_check check (
    (tipo = 'saldo_inicial' and monto >= 0)
    or (tipo in ('pago_recibido', 'ingreso_salario') and monto <> 0)
    or (tipo = 'reinversion_prestamo' and monto <> 0)
    or (tipo = 'ajuste_bancario' and monto <> 0)
    or (tipo in (
      'gasto_personal',
      'reversion_pago_prueba',
      'reversion_prestamo_prueba'
    ) and monto <> 0)
  );

drop function if exists public.configurar_control_caja(numeric, date);

create or replace function public.iniciar_control_caja()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_cartera_id uuid;
begin
  if v_actor_id is null or not public.is_admin() then
    raise exception 'Solo el administrador puede iniciar el control financiero.'
      using errcode = '42501';
  end if;

  select cartera.id
    into v_cartera_id
    from public.carteras as cartera
    where cartera.clave = 'y'
    for update;

  if v_cartera_id is null then
    raise exception 'No se encontró la cartera asignada a Maryluz.'
      using errcode = 'P0002';
  end if;

  insert into public.control_caja (
    cartera_id, fecha_inicio, iniciado_en, creado_por
  )
  values (
    v_cartera_id,
    (now() at time zone 'America/New_York')::date,
    now(),
    v_actor_id
  )
  on conflict (cartera_id) do nothing;

  if not found then
    raise exception 'El control financiero ya está iniciado.'
      using errcode = '23505';
  end if;

  return v_cartera_id;
end;
$$;

create or replace function public.reiniciar_control_caja()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_cartera_id uuid;
begin
  if v_actor_id is null or not public.is_admin() then
    raise exception 'Solo el administrador puede reiniciar el control financiero.'
      using errcode = '42501';
  end if;

  select cartera.id
    into v_cartera_id
    from public.carteras as cartera
    where cartera.clave = 'y'
    for update;

  if v_cartera_id is null then
    raise exception 'No se encontró la cartera asignada a Maryluz.'
      using errcode = 'P0002';
  end if;

  perform set_config('app.reset_cash_control', 'on', true);
  delete from public.movimientos_caja
    where cartera_id = v_cartera_id;
  delete from public.control_caja
    where cartera_id = v_cartera_id;
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
    or p_tipo not in ('gasto_personal', 'ingreso_salario')
    or p_monto is null
    or p_monto <= 0
    or p_monto > 9999999999.99
    or nullif(trim(p_descripcion), '') is null
  then
    raise exception 'El tipo, monto o descripción del movimiento no son válidos.'
      using errcode = '22023';
  end if;

  select cartera.id
    into v_cartera_id
    from public.carteras as cartera
    where cartera.clave = 'y';

  if v_cartera_id is null then
    raise exception 'No se encontró la cartera asignada a Maryluz.'
      using errcode = 'P0002';
  end if;

  select *
    into v_control
    from public.control_caja as control
    where control.cartera_id = v_cartera_id
    for update;

  if not found then
    raise exception 'Inicia primero el control financiero.'
      using errcode = '23514';
  end if;

  v_monto := case
    when p_tipo = 'gasto_personal' then -p_monto
    else p_monto
  end;

  select coalesce(sum(movement.monto), 0)
    into v_saldo
    from public.movimientos_caja as movement
    where movement.cartera_id = v_cartera_id
      and movement.created_at >= v_control.iniciado_en
      and movement.tipo <> 'saldo_inicial';

  if p_tipo = 'gasto_personal' and v_saldo + v_monto < 0 then
    raise exception 'El saldo disponible no alcanza para este gasto.'
      using errcode = '23514';
  end if;

  insert into public.movimientos_caja (
    cartera_id, tipo, monto, intereses, descripcion, creado_por
  )
  values (
    v_cartera_id, p_tipo, v_monto, 0, trim(p_descripcion), v_actor_id
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
  select cartera.id
    into v_cartera_caja_id
    from public.carteras as cartera
    where cartera.clave = 'y';

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
    from public.control_caja as control
    where control.cartera_id = v_cartera_caja_id
    for update;

  if not found then
    raise exception 'Inicia primero el control financiero de Maryluz.'
      using errcode = '23514';
  end if;

  select coalesce(sum(movement.monto), 0)
    into v_saldo
    from public.movimientos_caja as movement
    where movement.cartera_id = v_cartera_caja_id
      and movement.created_at >= v_control.iniciado_en
      and movement.tipo <> 'saldo_inicial';

  if new.monto_desembolsado > v_saldo then
    raise exception 'El saldo disponible no alcanza para entregar este préstamo.'
      using errcode = '23514';
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
  v_codigo text;
  v_nombre text;
  v_numero_cuota integer;
  v_intereses numeric := 0;
  v_pago_original public.movimientos_caja%rowtype;
begin
  select cartera.id
    into v_cartera_caja_id
    from public.carteras as cartera
    where cartera.clave = 'y';

  if v_cartera_caja_id is null
    or new.cartera_id is distinct from v_cartera_caja_id
  then
    return new;
  end if;

  new.pagado_en := now();

  select *
    into v_control
    from public.control_caja as control
    where control.cartera_id = v_cartera_caja_id
    for update;

  if not found or new.pagado_en < v_control.iniciado_en then
    return new;
  end if;

  select
    loan.codigo,
    borrower.nombre,
    installment.numero,
    coalesce(installment.intereses, 0)
    into v_codigo, v_nombre, v_numero_cuota, v_intereses
    from public.prestamos as loan
    join public.deudores as borrower
      on borrower.id = loan.deudor_id
      and borrower.cartera_id = loan.cartera_id
    left join public.cuotas as installment
      on installment.id = new.cuota_id
      and installment.prestamo_id = loan.id
      and installment.cartera_id = loan.cartera_id
    where loan.id = new.prestamo_id
      and loan.cartera_id = new.cartera_id;

  if new.tipo = 'solo_intereses' then
    v_intereses := new.monto;
  elsif new.tipo = 'ajuste' then
    if new.pago_referenciado_id is not null then
      select *
        into v_pago_original
        from public.movimientos_caja as movement
        where movement.tipo = 'pago_recibido'
          and movement.referencia_id = new.pago_referenciado_id;

      if found and v_pago_original.monto <> 0 then
        v_intereses := round(
          v_pago_original.intereses * new.monto / v_pago_original.monto,
          2
        );
      else
        v_intereses := 0;
      end if;
    else
      v_intereses := 0;
    end if;
  elsif new.tipo <> 'cuota_completa' then
    v_intereses := 0;
  end if;

  insert into public.movimientos_caja (
    cartera_id, tipo, monto, intereses, descripcion, referencia_id,
    creado_por, created_at
  )
  values (
    new.cartera_id,
    'pago_recibido',
    new.monto,
    v_intereses,
    format(
      'Pago registrado para el préstamo: %s, %s, cuota %s.',
      coalesce(v_codigo, 'sin código'),
      coalesce(v_nombre, 'cliente'),
      coalesce(v_numero_cuota::text, 'sin número')
    ),
    new.id,
    new.registrado_por,
    new.pagado_en
  );

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
  select control.*
    into v_control
    from public.control_caja as control
    where control.cartera_id = old.cartera_id
    for update;
  if not found then
    return old;
  end if;

  select movement.*
    into v_movimiento
    from public.movimientos_caja as movement
    where movement.tipo = 'pago_recibido'
      and movement.referencia_id = old.id
      and movement.created_at >= v_control.iniciado_en;

  if found then
    insert into public.movimientos_caja (
      cartera_id, tipo, monto, intereses, descripcion, referencia_id, creado_por
    )
    values (
      v_movimiento.cartera_id,
      'reversion_pago_prueba',
      -v_movimiento.monto,
      -v_movimiento.intereses,
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
  select control.*
    into v_control
    from public.control_caja as control
    where control.cartera_id = old.cartera_id
    for update;

  if not found then
    return old;
  end if;

  select movement.*
    into v_movimiento
    from public.movimientos_caja as movement
    where movement.tipo = 'reinversion_prestamo'
      and movement.referencia_id = old.id
      and movement.created_at >= v_control.iniciado_en;

  if found then
    insert into public.movimientos_caja (
      cartera_id, tipo, monto, intereses, descripcion, referencia_id, creado_por
    )
    values (
      v_movimiento.cartera_id,
      'reversion_prestamo_prueba',
      -v_movimiento.monto,
      0,
      format(
        'Compensación de desembolso por eliminación de préstamo de prueba %s.',
        old.codigo
      ),
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
  if tg_op = 'DELETE'
    and current_setting('app.reset_cash_control', true) = 'on'
    and auth.uid() is not null
    and public.is_admin()
  then
    return old;
  end if;

  raise exception 'Los movimientos de caja son inmutables; reinicia el control solo durante las pruebas o registra un nuevo movimiento.'
    using errcode = '23514';
end;
$$;

revoke all on function public.iniciar_control_caja()
  from public, anon, authenticated;
revoke all on function public.reiniciar_control_caja()
  from public, anon, authenticated;
revoke all on function public.registrar_movimiento_caja(text, numeric, text)
  from public, anon, authenticated;
revoke all on function public.procesar_desembolso_caja()
  from public, anon, authenticated;
revoke all on function public.registrar_pago_en_caja()
  from public, anon, authenticated;
revoke all on function public.compensar_pago_eliminado_de_caja()
  from public, anon, authenticated;
revoke all on function public.compensar_prestamo_eliminado_de_caja()
  from public, anon, authenticated;
revoke all on function public.proteger_movimiento_caja()
  from public, anon, authenticated;

grant execute on function public.iniciar_control_caja() to authenticated;
grant execute on function public.reiniciar_control_caja() to authenticated;
grant execute on function public.registrar_movimiento_caja(text, numeric, text)
  to authenticated;

update public.control_caja
set fecha_inicio = (now() at time zone 'America/New_York')::date,
    iniciado_en = now();
