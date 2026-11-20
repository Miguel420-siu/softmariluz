-- Run in Supabase SQL Editor after creating the three Auth users.
-- Replace the example email addresses with the exact emails of those accounts.
do $$
declare
  admin_id uuid;
  reader_x_id uuid;
  reader_y_id uuid;
  cartera_x_id uuid;
  cartera_y_id uuid;
begin
  select id into admin_id
  from auth.users
  where lower(email) = lower('admin@example.com');

  select id into reader_x_id
  from auth.users
  where lower(email) = lower('persona.x@example.com');

  select id into reader_y_id
  from auth.users
  where lower(email) = lower('persona.y@example.com');

  if admin_id is null or reader_x_id is null or reader_y_id is null then
    raise exception 'Crea primero las tres cuentas en Supabase Auth y actualiza los correos de este script.';
  end if;

  if admin_id = reader_x_id
    or admin_id = reader_y_id
    or reader_x_id = reader_y_id then
    raise exception 'El administrador y cada lector deben ser cuentas distintas.';
  end if;

  select id into cartera_x_id from public.carteras where clave = 'x';
  select id into cartera_y_id from public.carteras where clave = 'y';

  if cartera_x_id is null or cartera_y_id is null then
    raise exception 'No se encontraron las carteras X e Y. Aplica primero las migraciones.';
  end if;

  insert into public.perfiles (usuario_id, rol, cartera_id)
  values
    (admin_id, 'admin', null),
    (reader_x_id, 'lector', cartera_x_id),
    (reader_y_id, 'lector', cartera_y_id)
  on conflict (usuario_id) do update
  set
    rol = excluded.rol,
    cartera_id = excluded.cartera_id;
end;
$$;
