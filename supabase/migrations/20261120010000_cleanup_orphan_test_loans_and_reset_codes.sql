create or replace function public.eliminar_prestamo_pruebas(
  p_prestamo_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cartera_id uuid;
  v_prestamo public.prestamos%rowtype;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Solo el administrador puede eliminar préstamos de prueba.'
      using errcode = '42501';
  end if;

  select loan.cartera_id
    into v_cartera_id
    from public.prestamos as loan
    where loan.id = p_prestamo_id;
  if not found then
    raise exception 'No se encontró el préstamo solicitado.'
      using errcode = 'P0002';
  end if;

  perform 1
    from public.prestamo_secuencias as loan_sequence
    where loan_sequence.cartera_id = v_cartera_id
    for update;
  if not found then
    raise exception 'No se encontró la secuencia de la cartera del préstamo.'
      using errcode = 'P0002';
  end if;

  select *
    into v_prestamo
    from public.prestamos as loan
    where loan.id = p_prestamo_id
    for update;
  if not found or v_prestamo.cartera_id is distinct from v_cartera_id then
    raise exception 'El préstamo ya no está disponible para eliminar.'
      using errcode = 'P0002';
  end if;

  delete from public.prorrogas
    where prestamo_id = p_prestamo_id;
  delete from public.pagos
    where prestamo_id = p_prestamo_id
      and tipo = 'ajuste';
  delete from public.pagos
    where prestamo_id = p_prestamo_id;
  delete from public.cuotas
    where prestamo_id = p_prestamo_id;
  delete from public.prestamos
    where id = p_prestamo_id;

  if not exists (
    select 1
      from public.prestamos as loan
      where loan.cartera_id = v_prestamo.cartera_id
  ) then
    update public.prestamo_secuencias
      set ultimo_numero = 0
      where cartera_id = v_prestamo.cartera_id;
  end if;
end;
$$;

create or replace function public.eliminar_deudor_pruebas(
  p_deudor_id uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deudor public.deudores%rowtype;
  v_cartera_id uuid;
  v_prestamo_id uuid;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Solo el administrador puede eliminar deudores de prueba.'
      using errcode = '42501';
  end if;

  select borrower.cartera_id
    into v_cartera_id
    from public.deudores as borrower
    where borrower.id = p_deudor_id;
  if not found then
    raise exception 'No se encontró el deudor solicitado.'
      using errcode = 'P0002';
  end if;

  perform 1
    from public.prestamo_secuencias as loan_sequence
    where loan_sequence.cartera_id = v_cartera_id
    for update;
  if not found then
    raise exception 'No se encontró la secuencia de la cartera del deudor.'
      using errcode = 'P0002';
  end if;

  select *
    into v_deudor
    from public.deudores as borrower
    where borrower.id = p_deudor_id
      and borrower.cartera_id = v_cartera_id
    for update;
  if not found then
    raise exception 'El deudor ya no está disponible para eliminar.'
      using errcode = 'P0002';
  end if;

  for v_prestamo_id in
    select loan.id
      from public.prestamos as loan
      where loan.deudor_id = p_deudor_id
        and loan.cartera_id = v_deudor.cartera_id
      order by loan.id
  loop
    perform public.eliminar_prestamo_pruebas(v_prestamo_id);
  end loop;

  delete from public.deudores
    where id = p_deudor_id
      and cartera_id = v_deudor.cartera_id;

  return v_deudor.documento_path;
end;
$$;

create or replace function public.eliminar_prestamos_huerfanos_pruebas()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prestamo_id uuid;
  v_eliminados integer := 0;
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'Solo el administrador puede limpiar préstamos huérfanos.'
      using errcode = '42501';
  end if;

  for v_prestamo_id in
    select loan.id
      from public.prestamos as loan
      where not exists (
        select 1
          from public.deudores as borrower
          where borrower.id = loan.deudor_id
            and borrower.cartera_id = loan.cartera_id
      )
      order by loan.cartera_id, loan.numero_cartera
  loop
    perform public.eliminar_prestamo_pruebas(v_prestamo_id);
    v_eliminados := v_eliminados + 1;
  end loop;

  return v_eliminados;
end;
$$;

alter function public.eliminar_prestamo_pruebas(uuid) owner to postgres;
alter function public.eliminar_deudor_pruebas(uuid) owner to postgres;
alter function public.eliminar_prestamos_huerfanos_pruebas() owner to postgres;

revoke all on function public.eliminar_prestamo_pruebas(uuid)
  from public, anon, authenticated;
revoke all on function public.eliminar_deudor_pruebas(uuid)
  from public, anon, authenticated;
revoke all on function public.eliminar_prestamos_huerfanos_pruebas()
  from public, anon, authenticated;

grant execute on function public.eliminar_prestamo_pruebas(uuid)
  to authenticated;
grant execute on function public.eliminar_deudor_pruebas(uuid)
  to authenticated;
grant execute on function public.eliminar_prestamos_huerfanos_pruebas()
  to authenticated;
