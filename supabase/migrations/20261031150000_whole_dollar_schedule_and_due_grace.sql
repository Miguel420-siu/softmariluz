alter table public.prestamos
  drop constraint if exists prestamos_tasa_interes_opciones_check;

alter table public.prestamos
  add constraint prestamos_tasa_interes_opciones_check
  check (tasa_interes in (0, 5, 10, 15, 20, 25, 30, 35, 40))
  not valid;

create or replace function public.refresh_loan_state_from_installments()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prestamo_id uuid;
begin
  if tg_op = 'DELETE' then
    v_prestamo_id := old.prestamo_id;
  else
    v_prestamo_id := new.prestamo_id;
  end if;

  update public.prestamos as prestamo
    set estado = case
      when not exists (
        select 1
        from public.cuotas as cuota
        where cuota.prestamo_id = v_prestamo_id
          and cuota.estado = 'pendiente'
      ) then 'terminado'
      when exists (
        select 1
        from public.cuotas as cuota
        where cuota.prestamo_id = v_prestamo_id
          and cuota.estado = 'pendiente'
          and cuota.fecha_vencimiento <
            ((now() at time zone 'America/New_York')::date - 1)
      ) then 'atrasado'
      else 'activo'
    end
    where prestamo.id = v_prestamo_id;

  return null;
end;
$$;

revoke all on function public.refresh_loan_state_from_installments()
  from public, anon, authenticated;

drop trigger if exists refresh_loan_state_from_installments
  on public.cuotas;

create trigger refresh_loan_state_from_installments
  after insert or update of estado, fecha_vencimiento or delete
  on public.cuotas
  for each row
  execute function public.refresh_loan_state_from_installments();

update public.prestamos as prestamo
  set estado = case
    when not exists (
      select 1
      from public.cuotas as cuota
      where cuota.prestamo_id = prestamo.id
        and cuota.estado = 'pendiente'
    ) then 'terminado'
    when exists (
      select 1
      from public.cuotas as cuota
      where cuota.prestamo_id = prestamo.id
        and cuota.estado = 'pendiente'
        and cuota.fecha_vencimiento <
          ((now() at time zone 'America/New_York')::date - 1)
    ) then 'atrasado'
    else 'activo'
  end
  where prestamo.estado <> 'terminado';
