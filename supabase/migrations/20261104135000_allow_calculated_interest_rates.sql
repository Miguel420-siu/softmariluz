drop trigger if exists prestamos_tasa_interes_allowed
  on public.prestamos;

alter table public.prestamos
  alter column tasa_interes type numeric(16, 4)
  using tasa_interes::numeric(16, 4);

alter table public.prestamos
  drop constraint if exists prestamos_tasa_interes_opciones_check;

drop function if exists public.validate_loan_interest_rate();
