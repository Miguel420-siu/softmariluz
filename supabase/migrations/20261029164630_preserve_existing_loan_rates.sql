alter table public.prestamos
  drop constraint if exists prestamos_tasa_interes_opciones_check;

create or replace function public.validate_loan_interest_rate()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.tasa_interes not in (5, 10, 15, 20, 25, 30) then
    raise exception 'La tasa debe ser 5, 10, 15, 20, 25 o 30 por ciento.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.validate_loan_interest_rate()
  from public, anon, authenticated;

create trigger prestamos_tasa_interes_allowed
  before insert or update of tasa_interes on public.prestamos
  for each row execute function public.validate_loan_interest_rate();