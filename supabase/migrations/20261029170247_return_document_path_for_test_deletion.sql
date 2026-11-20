drop function public.eliminar_deudor_pruebas(uuid);

create function public.eliminar_deudor_pruebas(
  p_deudor_id uuid
)
returns text
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

  delete from public.deudores
    where id = p_deudor_id;

  return v_documento_path;
end;
$$;

alter function public.eliminar_deudor_pruebas(uuid) owner to postgres;
revoke all on function public.eliminar_deudor_pruebas(uuid)
  from public, anon, authenticated;
grant execute on function public.eliminar_deudor_pruebas(uuid)
  to authenticated;