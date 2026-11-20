update public.carteras
set nombre = case clave
  when 'x' then 'Cartera Francisco (Cartera X)'
  when 'y' then 'Cartera Maryluz (Cartera Y)'
end
where clave in ('x', 'y');

alter table public.prestamos
  add constraint prestamos_tasa_interes_opciones_check
  check (tasa_interes in (5, 10, 15, 20, 25, 30))
  not valid;