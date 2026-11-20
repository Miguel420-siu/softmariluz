update public.carteras
set nombre = 'Cartera Mariluz'
where clave = 'y'
  and nombre is distinct from 'Cartera Mariluz';

do $$
declare
  v_function_oid oid;
  v_function_definition text;
begin
  for v_function_oid in
    select p.oid
    from pg_catalog.pg_proc as p
    join pg_catalog.pg_namespace as n
      on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosrc like '%Maryluz%'
  loop
    v_function_definition :=
      pg_catalog.pg_get_functiondef(v_function_oid);
    execute replace(v_function_definition, 'Maryluz', 'Mariluz');
  end loop;
end;
$$;
