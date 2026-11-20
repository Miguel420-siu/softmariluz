alter table public.deudores
  alter column identificacion drop not null;

alter table public.deudores
  add constraint deudores_telefono_required_check
    check (telefono is not null and length(trim(telefono)) > 0) not valid,
  add constraint deudores_direccion_required_check
    check (direccion is not null and length(trim(direccion)) > 0) not valid;

create or replace function public.registrar_desembolso_caja()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cartera_caja_id uuid;
  v_nombre_deudor text;
begin
  select cartera.id
    into v_cartera_caja_id
    from public.carteras as cartera
    where cartera.clave = 'y';

  if v_cartera_caja_id is not null
    and new.cartera_id = v_cartera_caja_id
    and new.monto_desembolsado > 0
  then
    select borrower.nombre
      into v_nombre_deudor
      from public.deudores as borrower
      where borrower.id = new.deudor_id
        and borrower.cartera_id = new.cartera_id;

    if v_nombre_deudor is null then
      raise exception 'No se encontró el deudor del préstamo para registrar el desembolso.'
        using errcode = 'P0002';
    end if;

    insert into public.movimientos_caja (
      cartera_id, tipo, monto, intereses, descripcion, referencia_id,
      creado_por, created_at
    )
    values (
      new.cartera_id,
      'reinversion_prestamo',
      -new.monto_desembolsado,
      0,
      case
        when new.monto_desembolsado < new.monto then
          format(
            'Desembolso del préstamo %s, %s después de refinanciar.',
            new.codigo,
            v_nombre_deudor
          )
        else format(
          'Desembolso del préstamo %s, %s.',
          new.codigo,
          v_nombre_deudor
        )
      end,
      new.id,
      auth.uid(),
      new.created_at
    );
  end if;

  return new;
end;
$$;

revoke all on function public.registrar_desembolso_caja()
  from public, anon, authenticated;
