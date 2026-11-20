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

alter function public.eliminar_deudor_pruebas(uuid) owner to postgres;
revoke all on function public.eliminar_deudor_pruebas(uuid)
  from public, anon, authenticated;
grant execute on function public.eliminar_deudor_pruebas(uuid)
  to authenticated;
