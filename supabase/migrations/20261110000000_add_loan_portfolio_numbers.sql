create table public.prestamo_secuencias (
  cartera_id uuid primary key
    references public.carteras (id) on delete cascade,
  codigo_prefijo text not null unique
    check (codigo_prefijo ~ '^[A-Z0-9_-]+$'),
  ancho_codigo integer not null
    check (ancho_codigo between 3 and 10),
  ultimo_numero bigint not null default 0
    check (ultimo_numero >= 0)
);

alter table public.prestamo_secuencias enable row level security;
revoke all on table public.prestamo_secuencias from anon, authenticated;

insert into public.prestamo_secuencias (
  cartera_id,
  codigo_prefijo,
  ancho_codigo
)
select
  cartera.id,
  case lower(cartera.clave)
    when 'x' then 'F'
    when 'y' then 'M'
    else upper(cartera.clave)
  end,
  case lower(cartera.clave)
    when 'x' then 3
    when 'y' then 4
    else 4
  end
from public.carteras as cartera;

alter table public.prestamos
  add column numero_cartera bigint,
  add column codigo text;

with loans_numbered as (
  select
    prestamo.id,
    prestamo.cartera_id,
    row_number() over (
      partition by prestamo.cartera_id
      order by prestamo.created_at, prestamo.id
    ) as numero
  from public.prestamos as prestamo
)
update public.prestamos as prestamo
set
  numero_cartera = loans_numbered.numero,
  codigo = secuencia.codigo_prefijo || '-' ||
    lpad(
      loans_numbered.numero::text,
      greatest(secuencia.ancho_codigo, length(loans_numbered.numero::text)),
      '0'
    )
from loans_numbered
join public.prestamo_secuencias as secuencia
  on secuencia.cartera_id = loans_numbered.cartera_id
where prestamo.id = loans_numbered.id;

update public.prestamo_secuencias as secuencia
set ultimo_numero = coalesce(
  (
    select max(prestamo.numero_cartera)
    from public.prestamos as prestamo
    where prestamo.cartera_id = secuencia.cartera_id
  ),
  0
);

alter table public.prestamos
  alter column numero_cartera set not null,
  alter column codigo set not null,
  add constraint prestamos_cartera_numero_unique
    unique (cartera_id, numero_cartera),
  add constraint prestamos_codigo_unique unique (codigo);

create or replace function public.create_loan_sequence_for_wallet()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.prestamo_secuencias (
    cartera_id,
    codigo_prefijo,
    ancho_codigo
  )
  values (
    new.id,
    case lower(new.clave)
      when 'x' then 'F'
      when 'y' then 'M'
      else upper(new.clave)
    end,
    case lower(new.clave)
      when 'x' then 3
      when 'y' then 4
      else 4
    end
  )
  on conflict (cartera_id) do nothing;
  return new;
end;
$$;

create or replace function public.assign_loan_portfolio_number()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  next_number bigint;
  code_prefix text;
  code_width integer;
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
  returning ultimo_numero, codigo_prefijo, ancho_codigo
  into next_number, code_prefix, code_width;

  if next_number is null then
    raise exception 'No existe una secuencia para la cartera seleccionada.'
      using errcode = '23503';
  end if;

  new.numero_cartera := next_number;
  new.codigo := code_prefix || '-' ||
    lpad(next_number::text, greatest(code_width, length(next_number::text)), '0');
  return new;
end;
$$;

revoke all on function public.create_loan_sequence_for_wallet()
  from public, anon, authenticated;
revoke all on function public.assign_loan_portfolio_number()
  from public, anon, authenticated;

create trigger carteras_create_loan_sequence
  after insert on public.carteras
  for each row
  execute function public.create_loan_sequence_for_wallet();

create trigger prestamos_assign_portfolio_number
  before insert or update on public.prestamos
  for each row
  execute function public.assign_loan_portfolio_number();
