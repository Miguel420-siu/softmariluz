alter table public.deudores
  add column email text;

alter table public.deudores
  add constraint deudores_email_check
  check (email is null or email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$');
