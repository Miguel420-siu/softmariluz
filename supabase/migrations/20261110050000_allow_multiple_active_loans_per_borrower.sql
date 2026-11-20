drop trigger if exists prestamos_prevent_multiple_active_loans
  on public.prestamos;

drop function if exists public.prevent_multiple_active_loans();
