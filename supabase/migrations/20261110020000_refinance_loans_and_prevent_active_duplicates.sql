create or replace function public.prevent_multiple_active_loans()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
    and new.estado is not distinct from old.estado
    and new.deudor_id is not distinct from old.deudor_id
    and new.cartera_id is not distinct from old.cartera_id
  then
    return new;
  end if;

  if new.estado = 'terminado' then
    return new;
  end if;

  perform 1
  from public.deudores
  where id = new.deudor_id
    and cartera_id = new.cartera_id
  for update;

  if not found then
    raise exception 'El cliente no pertenece a la cartera seleccionada.'
      using errcode = '23503';
  end if;

  if exists (
    select 1
    from public.prestamos
    where cartera_id = new.cartera_id
      and deudor_id = new.deudor_id
      and estado <> 'terminado'
      and id is distinct from new.id
  ) then
    raise exception 'El cliente ya tiene un préstamo activo. Refináncialo antes de crear otro.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.prevent_multiple_active_loans()
  from public, anon, authenticated;

create trigger prestamos_prevent_multiple_active_loans
  before insert or update on public.prestamos
  for each row
  execute function public.prevent_multiple_active_loans();

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
  where id = p_deudor_id
    and cartera_id = p_cartera_id
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
    cartera_id,
    prestamo_id,
    numero,
    fecha_vencimiento,
    capital,
    intereses,
    monto,
    estado
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

revoke all on function public.refinanciar_prestamo(
  uuid,
  uuid,
  uuid,
  numeric,
  numeric,
  smallint,
  integer,
  date,
  date,
  text,
  jsonb
) from public, anon, authenticated;

grant execute on function public.refinanciar_prestamo(
  uuid,
  uuid,
  uuid,
  numeric,
  numeric,
  smallint,
  integer,
  date,
  date,
  text,
  jsonb
) to authenticated;
