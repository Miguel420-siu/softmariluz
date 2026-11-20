create unique index deudores_cartera_email_unique
  on public.deudores (cartera_id, lower(btrim(email)))
  where email is not null and btrim(email) <> '';

create unique index deudores_cartera_telefono_unique
  on public.deudores (
    cartera_id,
    regexp_replace(btrim(telefono), '[^0-9]', '', 'g')
  )
  where telefono is not null
    and regexp_replace(btrim(telefono), '[^0-9]', '', 'g') <> '';

drop trigger prestamos_assign_portfolio_number on public.prestamos;

update public.prestamos as prestamo
set codigo = secuencia.codigo_prefijo || '-' || prestamo.numero_cartera::text
from public.prestamo_secuencias as secuencia
where secuencia.cartera_id = prestamo.cartera_id;

create or replace function public.assign_loan_portfolio_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  next_number bigint;
  code_prefix text;
begin
  if tg_op = 'UPDATE' then
    if new.cartera_id is distinct from old.cartera_id
      or new.numero_cartera is distinct from old.numero_cartera
      or new.codigo is distinct from old.codigo
    then
      raise exception 'El identificador del préstamo no se puede cambiar.'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if new.numero_cartera is not null or new.codigo is not null then
    raise exception 'El identificador del préstamo se asigna automáticamente.'
      using errcode = '23514';
  end if;

  update public.prestamo_secuencias
  set ultimo_numero = ultimo_numero + 1
  where cartera_id = new.cartera_id
  returning ultimo_numero, codigo_prefijo
  into next_number, code_prefix;

  if next_number is null then
    raise exception 'No existe una secuencia para la cartera seleccionada.'
      using errcode = '23503';
  end if;

  new.numero_cartera := next_number;
  new.codigo := code_prefix || '-' || next_number::text;
  return new;
end;
$$;

create trigger prestamos_assign_portfolio_number
  before insert or update on public.prestamos
  for each row
  execute function public.assign_loan_portfolio_number();
