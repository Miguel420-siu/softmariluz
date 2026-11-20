do $$
declare
  v_function_definition text;
begin
  select pg_get_functiondef(
    'public.refinanciar_prestamo(uuid,uuid,uuid,numeric,numeric,smallint,integer,date,date,text,jsonb)'::regprocedure
  )
    into v_function_definition;

  if position('if v_cuotas_pendientes < 3 then' in v_function_definition) = 0
    or position('al menos 3 cuotas pendientes' in v_function_definition) = 0
  then
    raise exception 'La validación de cuotas pendientes de refinanciación no coincide con la versión esperada.';
  end if;

  v_function_definition := replace(
    v_function_definition,
    'if v_cuotas_pendientes < 3 then',
    'if v_cuotas_pendientes < 1 or v_cuotas_pendientes > 3 then'
  );
  v_function_definition := replace(
    v_function_definition,
    'al menos 3 cuotas pendientes',
    'entre 1 y 3 cuotas pendientes'
  );

  execute v_function_definition;
end;
$$;
