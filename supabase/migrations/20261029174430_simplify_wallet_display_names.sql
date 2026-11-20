update public.carteras
set nombre = case clave
  when 'x' then 'Cartera Francisco'
  when 'y' then 'Cartera Maryluz'
end
where clave in ('x', 'y')
  and nombre in (
    'Cartera Francisco (Cartera X)',
    'Cartera Maryluz (Cartera Y)'
  );
