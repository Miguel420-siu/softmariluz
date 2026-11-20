alter table public.prorrogas
  add column cuota_id uuid,
  add column capital_desplazado numeric(12, 2),
  add column cuota_final boolean not null default false;

alter table public.prorrogas
  add constraint prorrogas_cuota_cartera_fk
    foreign key (cuota_id, cartera_id)
    references public.cuotas (id, cartera_id) on delete restrict,
  add constraint prorrogas_desplazamiento_datos_check
    check (cuota_id is not null and capital_desplazado is not null)
    not valid,
  add constraint prorrogas_capital_desplazado_check
    check (capital_desplazado >= 0)
    not valid;

create or replace function public.registrar_pago(
  p_prestamo_id uuid,
  p_cuota_id uuid,
  p_tipo text,
  p_notas text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_usuario_id uuid := auth.uid();
  v_prestamo public.prestamos%rowtype;
  v_cuota public.cuotas%rowtype;
  v_siguiente_cuota public.cuotas%rowtype;
  v_primera_cuota_id uuid;
  v_pago_id uuid;
  v_fecha_fin_nueva date;
  v_es_final boolean;
begin
  if v_usuario_id is null or not public.is_admin() then
    raise exception 'Solo el administrador puede registrar pagos.'
      using errcode = '42501';
  end if;

  if p_tipo is null or p_tipo not in ('cuota_completa', 'solo_intereses') then
    raise exception 'El tipo de pago solicitado no es válido.'
      using errcode = '22023';
  end if;

  select *
    into v_prestamo
    from public.prestamos
    where id = p_prestamo_id
    for update;

  if not found then
    raise exception 'No se encontró el préstamo solicitado.'
      using errcode = 'P0002';
  end if;

  select *
    into v_cuota
    from public.cuotas
    where id = p_cuota_id
      and prestamo_id = p_prestamo_id
      and cartera_id = v_prestamo.cartera_id
    for update;

  if not found or v_cuota.estado <> 'pendiente' then
    raise exception 'La cuota no existe o ya fue pagada.'
      using errcode = 'P0002';
  end if;

  select id
    into v_primera_cuota_id
    from public.cuotas
    where prestamo_id = p_prestamo_id
      and cartera_id = v_prestamo.cartera_id
      and estado = 'pendiente'
    order by numero
    limit 1
    for update;

  if v_cuota.id <> v_primera_cuota_id then
    raise exception 'Registra primero el pago de la cuota pendiente más antigua.'
      using errcode = '23514';
  end if;

  if p_tipo = 'cuota_completa' then
    insert into public.pagos (
      cartera_id,
      prestamo_id,
      cuota_id,
      monto,
      tipo,
      registrado_por,
      notas
    )
    values (
      v_prestamo.cartera_id,
      v_prestamo.id,
      v_cuota.id,
      v_cuota.monto,
      'cuota_completa',
      v_usuario_id,
      nullif(trim(p_notas), '')
    )
    returning id into v_pago_id;

    update public.cuotas
      set estado = 'pagada'
      where id = v_cuota.id;
  else
    if v_cuota.intereses <= 0 then
      raise exception 'Esta cuota no tiene un importe de interés que pueda pagarse por separado.'
        using errcode = '23514';
    end if;

    select *
      into v_siguiente_cuota
      from public.cuotas
      where prestamo_id = p_prestamo_id
        and cartera_id = v_prestamo.cartera_id
        and numero > v_cuota.numero
      order by numero
      limit 1
      for update;
    v_es_final := not found;

    if v_es_final and v_cuota.numero <> v_prestamo.numero_cuotas then
      raise exception 'El cronograma no coincide con el número de cuotas del préstamo.'
        using errcode = '23514';
    end if;
    if not v_es_final and v_siguiente_cuota.numero <> v_cuota.numero + 1 then
      raise exception 'El cronograma tiene una cuota faltante y no se puede prorrogar.'
        using errcode = '23514';
    end if;

    v_fecha_fin_nueva := v_prestamo.fecha_fin + 7;

    insert into public.pagos (
      cartera_id,
      prestamo_id,
      cuota_id,
      monto,
      tipo,
      registrado_por,
      notas
    )
    values (
      v_prestamo.cartera_id,
      v_prestamo.id,
      v_cuota.id,
      v_cuota.intereses,
      'solo_intereses',
      v_usuario_id,
      nullif(trim(p_notas), '')
    )
    returning id into v_pago_id;

    update public.cuotas
      set capital = 0,
          monto = intereses,
          estado = 'pagada'
      where id = v_cuota.id;

    if v_es_final then
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
      values (
        v_prestamo.cartera_id,
        v_prestamo.id,
        v_cuota.numero + 1,
        v_cuota.fecha_vencimiento,
        v_cuota.capital,
        0,
        v_cuota.capital,
        'pendiente'
      );
    else
      update public.cuotas
        set capital = capital + v_cuota.capital,
            monto = capital + v_cuota.capital + intereses
        where id = v_siguiente_cuota.id;
    end if;

    update public.cuotas
      set fecha_vencimiento = fecha_vencimiento + 7
      where prestamo_id = v_prestamo.id
        and cartera_id = v_prestamo.cartera_id
        and numero > v_cuota.numero;

    update public.prestamos
      set fecha_fin = v_fecha_fin_nueva,
          numero_cuotas = case
            when v_es_final then numero_cuotas + 1
            else numero_cuotas
          end
      where id = v_prestamo.id;

    insert into public.prorrogas (
      cartera_id,
      prestamo_id,
      pago_intereses_id,
      registrada_por,
      semanas_desplazadas,
      fecha_fin_anterior,
      fecha_fin_nueva,
      notas,
      cuota_id,
      capital_desplazado,
      cuota_final
    )
    values (
      v_prestamo.cartera_id,
      v_prestamo.id,
      v_pago_id,
      v_usuario_id,
      1,
      v_prestamo.fecha_fin,
      v_fecha_fin_nueva,
      nullif(trim(p_notas), ''),
      v_cuota.id,
      v_cuota.capital,
      v_es_final
    );
  end if;

  update public.prestamos
    set estado = case
      when not exists (
        select 1
        from public.cuotas
        where prestamo_id = v_prestamo.id
          and estado = 'pendiente'
      ) then 'terminado'
      when exists (
        select 1
        from public.cuotas
        where prestamo_id = v_prestamo.id
          and estado = 'pendiente'
          and fecha_vencimiento < (now() at time zone 'America/New_York')::date
      ) then 'atrasado'
      else 'activo'
    end
    where id = v_prestamo.id;

  return v_pago_id;
end;
$$;

create or replace function public.revertir_pago(
  p_pago_id uuid,
  p_motivo text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_usuario_id uuid := auth.uid();
  v_prestamo_id uuid;
  v_prestamo public.prestamos%rowtype;
  v_pago public.pagos%rowtype;
  v_cuota public.cuotas%rowtype;
  v_siguiente_cuota public.cuotas%rowtype;
  v_prorroga public.prorrogas%rowtype;
  v_ajuste_id uuid;
begin
  if v_usuario_id is null or not public.is_admin() then
    raise exception 'Solo el administrador puede revertir pagos.'
      using errcode = '42501';
  end if;
  if nullif(trim(p_motivo), '') is null then
    raise exception 'Indica el motivo del reverso.'
      using errcode = '22023';
  end if;

  select prestamo_id
    into v_prestamo_id
    from public.pagos
    where id = p_pago_id;
  if not found then
    raise exception 'No se encontró el pago que se desea revertir.'
      using errcode = 'P0002';
  end if;

  select *
    into v_prestamo
    from public.prestamos
    where id = v_prestamo_id
    for update;
  if not found then
    raise exception 'No se encontró el préstamo del pago.'
      using errcode = 'P0002';
  end if;

  select *
    into v_pago
    from public.pagos
    where id = p_pago_id
      and prestamo_id = v_prestamo.id
      and cartera_id = v_prestamo.cartera_id
    for update;
  if not found or v_pago.tipo not in ('cuota_completa', 'solo_intereses') then
    raise exception 'Solo se pueden revertir pagos de cuotas o de solo intereses.'
      using errcode = '23514';
  end if;
  if exists (
    select 1
    from public.pagos
    where pago_referenciado_id = v_pago.id
      and tipo = 'ajuste'
  ) then
    raise exception 'Este pago ya fue revertido.'
      using errcode = '23514';
  end if;
  if exists (
    select 1
    from public.pagos
    where prestamo_id = v_prestamo.id
      and created_at > v_pago.created_at
  ) then
    raise exception 'Solo se puede revertir el último pago registrado del préstamo.'
      using errcode = '23514';
  end if;
  if v_pago.cuota_id is null then
    raise exception 'El pago no tiene una cuota asociada y no puede revertirse automáticamente.'
      using errcode = '23514';
  end if;

  select *
    into v_cuota
    from public.cuotas
    where id = v_pago.cuota_id
      and prestamo_id = v_prestamo.id
      and cartera_id = v_prestamo.cartera_id
    for update;
  if not found or v_cuota.estado <> 'pagada' then
    raise exception 'La cuota ya no está en el estado esperado para revertir el pago.'
      using errcode = '23514';
  end if;

  if v_pago.tipo = 'solo_intereses' then
    select *
      into v_prorroga
      from public.prorrogas
      where pago_intereses_id = v_pago.id
        and prestamo_id = v_prestamo.id
        and cartera_id = v_prestamo.cartera_id
    for update;
    if not found or v_prorroga.cuota_id is null
      or v_prorroga.capital_desplazado is null then
      raise exception 'No se encontró el detalle necesario para revertir la prórroga.'
        using errcode = '23514';
    end if;
    if v_cuota.capital <> 0 or v_cuota.intereses <> v_pago.monto then
      raise exception 'La cuota fue modificada y ya no se puede revertir la prórroga automáticamente.'
        using errcode = '23514';
    end if;

    if v_prorroga.cuota_final then
      select *
        into v_siguiente_cuota
        from public.cuotas
        where prestamo_id = v_prestamo.id
          and cartera_id = v_prestamo.cartera_id
          and numero = v_cuota.numero + 1
        for update;
      if not found or v_siguiente_cuota.estado <> 'pendiente'
        or v_siguiente_cuota.capital <> v_prorroga.capital_desplazado
        or v_siguiente_cuota.intereses <> 0
        or v_prestamo.numero_cuotas <> v_cuota.numero + 1 then
        raise exception 'La cuota añadida por la prórroga ya cambió y no se puede eliminar automáticamente.'
          using errcode = '23514';
      end if;
      delete from public.cuotas where id = v_siguiente_cuota.id;
    else
      select *
        into v_siguiente_cuota
        from public.cuotas
        where prestamo_id = v_prestamo.id
          and cartera_id = v_prestamo.cartera_id
          and numero = v_cuota.numero + 1
        for update;
      if not found or v_siguiente_cuota.capital < v_prorroga.capital_desplazado then
        raise exception 'La cuota siguiente cambió y no se puede revertir la prórroga automáticamente.'
          using errcode = '23514';
      end if;
      update public.cuotas
        set capital = capital - v_prorroga.capital_desplazado,
            monto = capital - v_prorroga.capital_desplazado + intereses
        where id = v_siguiente_cuota.id;

      update public.cuotas
        set fecha_vencimiento = fecha_vencimiento - 7
        where prestamo_id = v_prestamo.id
          and cartera_id = v_prestamo.cartera_id
          and numero > v_cuota.numero;
    end if;

    update public.cuotas
      set capital = v_prorroga.capital_desplazado,
          monto = v_prorroga.capital_desplazado + intereses,
          estado = 'pendiente'
      where id = v_cuota.id;

    update public.prestamos
      set fecha_fin = v_prorroga.fecha_fin_anterior,
          numero_cuotas = case
            when v_prorroga.cuota_final then numero_cuotas - 1
            else numero_cuotas
          end
      where id = v_prestamo.id;
  else
    update public.cuotas
      set estado = 'pendiente'
      where id = v_cuota.id;
  end if;

  insert into public.pagos (
    cartera_id,
    prestamo_id,
    cuota_id,
    monto,
    tipo,
    registrado_por,
    pago_referenciado_id,
    notas
  )
  values (
    v_pago.cartera_id,
    v_pago.prestamo_id,
    v_pago.cuota_id,
    -v_pago.monto,
    'ajuste',
    v_usuario_id,
    v_pago.id,
    'Reverso: ' || trim(p_motivo)
  )
  returning id into v_ajuste_id;

  update public.prestamos
    set estado = case
      when not exists (
        select 1
        from public.cuotas
        where prestamo_id = v_prestamo.id
          and estado = 'pendiente'
      ) then 'terminado'
      when exists (
        select 1
        from public.cuotas
        where prestamo_id = v_prestamo.id
          and estado = 'pendiente'
          and fecha_vencimiento < (now() at time zone 'America/New_York')::date
      ) then 'atrasado'
      else 'activo'
    end
    where id = v_prestamo.id;

  return v_ajuste_id;
end;
$$;

revoke all on function public.registrar_pago(uuid, uuid, text, text)
  from public, anon, authenticated;
revoke all on function public.revertir_pago(uuid, text)
  from public, anon, authenticated;
grant execute on function public.registrar_pago(uuid, uuid, text, text)
  to authenticated;
grant execute on function public.revertir_pago(uuid, text)
  to authenticated;

revoke insert on table public.pagos, public.prorrogas from authenticated;