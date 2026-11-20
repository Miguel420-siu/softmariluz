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
    return new;
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

revoke all on function public.procesar_desembolso_caja()
  from public, anon, authenticated;
