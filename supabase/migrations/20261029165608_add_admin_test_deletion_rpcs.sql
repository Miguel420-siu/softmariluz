create or replace function public.prevent_ledger_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE'
    and current_user = 'postgres'
    and (select auth.uid()) is not null
    and public.is_admin() then
    return old;
  end if;

  raise exception 'Los registros de pagos y prórrogas son inmutables; solo el flujo administrativo de pruebas puede eliminarlos.'
    using errcode = '55000';
end;
$$;

create or replace function public.eliminar_prestamo_pruebas(
  p_prestamo_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null or not public.is_admin() then
    raise exception 'Solo el administrador puede eliminar préstamos de prueba.'
      using errcode = '42501';
  end if;

  perform 1
    from public.prestamos
    where id = p_prestamo_id
    for update;
  if not found then
    raise exception 'No se encontró el préstamo solicitado.'
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
end;
$$;

create or replace function public.eliminar_deudor_pruebas(
  p_deudor_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_documento_path text;
  v_prestamo_id uuid;
begin
  if (select auth.uid()) is null or not public.is_admin() then
    raise exception 'Solo el administrador puede eliminar deudores de prueba.'
      using errcode = '42501';
  end if;

  select documento_path
    into v_documento_path
    from public.deudores
    where id = p_deudor_id
    for update;
  if not found then
    raise exception 'No se encontró el deudor solicitado.'
      using errcode = 'P0002';
  end if;

  for v_prestamo_id in
    select id
      from public.prestamos
      where deudor_id = p_deudor_id
      order by id
      for update
  loop
    perform public.eliminar_prestamo_pruebas(v_prestamo_id);
  end loop;

  if v_documento_path is not null then
    delete from storage.objects
      where bucket_id = 'documentos-identidad'
        and name = v_documento_path;
  end if;

  delete from public.deudores
    where id = p_deudor_id;
end;
$$;

alter function public.eliminar_prestamo_pruebas(uuid) owner to postgres;
alter function public.eliminar_deudor_pruebas(uuid) owner to postgres;

revoke all on function public.eliminar_prestamo_pruebas(uuid)
  from public, anon, authenticated;
revoke all on function public.eliminar_deudor_pruebas(uuid)
  from public, anon, authenticated;
grant execute on function public.eliminar_prestamo_pruebas(uuid)
  to authenticated;
grant execute on function public.eliminar_deudor_pruebas(uuid)
  to authenticated;

revoke delete on table public.prestamos, public.deudores
  from authenticated;