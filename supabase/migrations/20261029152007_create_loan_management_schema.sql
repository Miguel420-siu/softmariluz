-- Authenticated users get database-enforced access; the frontend is not a security boundary.

create table public.carteras (
  id uuid primary key default gen_random_uuid(),
  clave text not null unique check (clave ~ '^[a-z0-9_-]+$'),
  nombre text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.carteras (clave, nombre)
values ('x', 'Cartera X'), ('y', 'Cartera Y')
on conflict (clave) do nothing;

create table public.perfiles (
  usuario_id uuid primary key references auth.users (id) on delete cascade,
  rol text not null check (rol in ('admin', 'lector')),
  cartera_id uuid references public.carteras (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint perfiles_rol_cartera_check check (
    (rol = 'admin' and cartera_id is null)
    or (rol = 'lector' and cartera_id is not null)
  )
);

create table public.deudores (
  id uuid primary key default gen_random_uuid(),
  cartera_id uuid not null references public.carteras (id) on delete restrict,
  nombre text not null check (length(trim(nombre)) > 0),
  identificacion text not null check (length(trim(identificacion)) > 0),
  telefono text,
  direccion text,
  apartamento text,
  ciudad text,
  estado text,
  codigo_postal text,
  referido_por text,
  documento_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint deudores_cartera_identificacion_unique unique (cartera_id, identificacion),
  constraint deudores_id_cartera_unique unique (id, cartera_id),
  constraint deudores_documento_path_check check (
    documento_path is null
    or documento_path ~* (
      '^' || cartera_id::text || '/' || id::text || '/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
    )
  )
);

create table public.prestamos (
  id uuid primary key default gen_random_uuid(),
  cartera_id uuid not null references public.carteras (id) on delete restrict,
  deudor_id uuid not null,
  monto numeric(12, 2) not null check (monto > 0),
  tasa_interes numeric(7, 4) not null check (tasa_interes >= 0),
  metodo_calculo text not null default 'fijo_capital_inicial'
    check (metodo_calculo = 'fijo_capital_inicial'),
  dia_pago_semana smallint not null check (dia_pago_semana between 1 and 7),
  numero_cuotas integer not null check (numero_cuotas > 0),
  fecha_inicio date not null,
  fecha_fin date not null,
  notas text,
  estado text not null default 'activo'
    check (estado in ('activo', 'atrasado', 'terminado')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint prestamos_fechas_check check (fecha_fin >= fecha_inicio),
  constraint prestamos_deudor_cartera_fk
    foreign key (deudor_id, cartera_id)
    references public.deudores (id, cartera_id) on delete restrict,
  constraint prestamos_id_cartera_unique unique (id, cartera_id)
);

create table public.cuotas (
  id uuid primary key default gen_random_uuid(),
  cartera_id uuid not null references public.carteras (id) on delete restrict,
  prestamo_id uuid not null,
  numero integer not null check (numero > 0),
  fecha_vencimiento date not null,
  capital numeric(12, 2) not null check (capital >= 0),
  intereses numeric(12, 2) not null check (intereses >= 0),
  monto numeric(12, 2) not null check (monto > 0),
  estado text not null default 'pendiente'
    check (estado in ('pendiente', 'pagada')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cuotas_capital_interes_total_check check (monto = capital + intereses),
  constraint cuotas_prestamo_numero_unique unique (prestamo_id, numero),
  constraint cuotas_id_cartera_unique unique (id, cartera_id),
  constraint cuotas_prestamo_cartera_fk
    foreign key (prestamo_id, cartera_id)
    references public.prestamos (id, cartera_id) on delete restrict
);

create table public.pagos (
  id uuid primary key default gen_random_uuid(),
  cartera_id uuid not null references public.carteras (id) on delete restrict,
  prestamo_id uuid not null,
  cuota_id uuid,
  monto numeric(12, 2) not null check (monto <> 0),
  tipo text not null check (tipo in ('cuota_completa', 'solo_intereses', 'ajuste')),
  pagado_en timestamptz not null default now(),
  registrado_por uuid not null default auth.uid()
    references auth.users (id) on delete restrict,
  pago_referenciado_id uuid,
  notas text,
  created_at timestamptz not null default now(),
  constraint pagos_monto_tipo_check check (
    (tipo = 'ajuste' and monto <> 0)
    or (tipo <> 'ajuste' and monto > 0)
  ),
  constraint pagos_tipo_referencias_check check (
    (tipo = 'ajuste' and pago_referenciado_id is not null)
    or (
      tipo in ('cuota_completa', 'solo_intereses')
      and cuota_id is not null
      and pago_referenciado_id is null
    )
  ),
  constraint pagos_prestamo_cartera_fk
    foreign key (prestamo_id, cartera_id)
    references public.prestamos (id, cartera_id) on delete restrict,
  constraint pagos_cuota_cartera_fk
    foreign key (cuota_id, cartera_id)
    references public.cuotas (id, cartera_id) on delete restrict,
  constraint pagos_id_cartera_unique unique (id, cartera_id),
  constraint pagos_referenciado_cartera_fk
    foreign key (pago_referenciado_id, cartera_id)
    references public.pagos (id, cartera_id) on delete restrict
);

create table public.prorrogas (
  id uuid primary key default gen_random_uuid(),
  cartera_id uuid not null references public.carteras (id) on delete restrict,
  prestamo_id uuid not null,
  pago_intereses_id uuid not null unique,
  registrada_en timestamptz not null default now(),
  registrada_por uuid not null default auth.uid()
    references auth.users (id) on delete restrict,
  semanas_desplazadas integer not null default 1 check (semanas_desplazadas > 0),
  fecha_fin_anterior date not null,
  fecha_fin_nueva date not null,
  notas text,
  created_at timestamptz not null default now(),
  constraint prorrogas_fechas_check check (fecha_fin_nueva > fecha_fin_anterior),
  constraint prorrogas_prestamo_cartera_fk
    foreign key (prestamo_id, cartera_id)
    references public.prestamos (id, cartera_id) on delete restrict,
  constraint prorrogas_pago_cartera_fk
    foreign key (pago_intereses_id, cartera_id)
    references public.pagos (id, cartera_id) on delete restrict
);

create table public.auditoria (
  id bigint generated always as identity primary key,
  cartera_id uuid,
  actor_id uuid references auth.users (id) on delete set null,
  tabla text not null,
  registro_id uuid not null,
  accion text not null check (accion in ('INSERT', 'UPDATE', 'DELETE')),
  datos_anteriores jsonb,
  datos_nuevos jsonb,
  created_at timestamptz not null default now()
);

create index deudores_cartera_nombre_idx
  on public.deudores (cartera_id, nombre);
create index prestamos_cartera_estado_idx
  on public.prestamos (cartera_id, estado);
create index prestamos_deudor_idx
  on public.prestamos (deudor_id, cartera_id);
create index cuotas_cartera_vencimiento_idx
  on public.cuotas (cartera_id, fecha_vencimiento)
  where estado = 'pendiente';
create index pagos_cartera_pagado_en_idx
  on public.pagos (cartera_id, pagado_en desc);
create index pagos_prestamo_idx
  on public.pagos (prestamo_id, cartera_id);
create index auditoria_cartera_created_at_idx
  on public.auditoria (cartera_id, created_at desc);

create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.rol
  from public.perfiles as p
  where p.usuario_id = (select auth.uid())
$$;

create or replace function public.current_user_cartera_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.cartera_id
  from public.perfiles as p
  where p.usuario_id = (select auth.uid())
    and p.rol = 'lector'
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.current_user_role() = 'admin', false)
$$;

revoke all on function public.current_user_role() from public, anon;
revoke all on function public.current_user_cartera_id() from public, anon;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.current_user_role() to authenticated;
grant execute on function public.current_user_cartera_id() to authenticated;
grant execute on function public.is_admin() to authenticated;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger carteras_set_updated_at
  before update on public.carteras
  for each row execute function public.set_updated_at();
create trigger perfiles_set_updated_at
  before update on public.perfiles
  for each row execute function public.set_updated_at();
create trigger deudores_set_updated_at
  before update on public.deudores
  for each row execute function public.set_updated_at();
create trigger prestamos_set_updated_at
  before update on public.prestamos
  for each row execute function public.set_updated_at();
create trigger cuotas_set_updated_at
  before update on public.cuotas
  for each row execute function public.set_updated_at();

create or replace function public.prevent_ledger_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Los registros de pagos y prórrogas son inmutables; registra un ajuste para corregir un error.'
    using errcode = '55000';
end;
$$;

create trigger pagos_immutable
  before update or delete on public.pagos
  for each row execute function public.prevent_ledger_mutation();
create trigger prorrogas_immutable
  before update or delete on public.prorrogas
  for each row execute function public.prevent_ledger_mutation();

create or replace function public.validate_payment_references()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.cuota_id is not null and not exists (
    select 1
    from public.cuotas as c
    where c.id = new.cuota_id
      and c.cartera_id = new.cartera_id
      and c.prestamo_id = new.prestamo_id
  ) then
    raise exception 'La cuota debe pertenecer al mismo préstamo y cartera del pago.'
      using errcode = '23514';
  end if;

  if new.pago_referenciado_id is not null and not exists (
    select 1
    from public.pagos as original_payment
    where original_payment.id = new.pago_referenciado_id
      and original_payment.cartera_id = new.cartera_id
      and original_payment.prestamo_id = new.prestamo_id
  ) then
    raise exception 'El ajuste debe referenciar un pago del mismo préstamo y cartera.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create or replace function public.validate_prorroga_payment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.pagos as p
    where p.id = new.pago_intereses_id
      and p.cartera_id = new.cartera_id
      and p.prestamo_id = new.prestamo_id
      and p.tipo = 'solo_intereses'
  ) then
    raise exception 'La prórroga debe referenciar un pago de solo intereses del mismo préstamo.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.set_updated_at() from public, anon, authenticated;
revoke all on function public.prevent_ledger_mutation() from public, anon, authenticated;
revoke all on function public.validate_payment_references() from public, anon, authenticated;
revoke all on function public.validate_prorroga_payment() from public, anon, authenticated;

create trigger pagos_validate_references
  before insert on public.pagos
  for each row execute function public.validate_payment_references();
create trigger prorrogas_validate_payment
  before insert on public.prorrogas
  for each row execute function public.validate_prorroga_payment();

create or replace function public.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  old_record jsonb;
  new_record jsonb;
  record_data jsonb;
  row_id uuid;
  portfolio_id uuid;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    old_record := to_jsonb(old);
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    new_record := to_jsonb(new);
  end if;

  record_data := coalesce(new_record, old_record);
  row_id := coalesce(
    nullif(record_data ->> 'id', '')::uuid,
    nullif(record_data ->> 'usuario_id', '')::uuid
  );
  portfolio_id := coalesce(
    nullif(record_data ->> 'cartera_id', '')::uuid,
    case when tg_table_name = 'carteras' then row_id else null end
  );

  insert into public.auditoria (
    cartera_id,
    actor_id,
    tabla,
    registro_id,
    accion,
    datos_anteriores,
    datos_nuevos
  )
  values (
    portfolio_id,
    (select auth.uid()),
    tg_table_name,
    row_id,
    tg_op,
    old_record,
    new_record
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.audit_row_change() from public, anon, authenticated;

create trigger carteras_audit
  after insert or update or delete on public.carteras
  for each row execute function public.audit_row_change();
create trigger perfiles_audit
  after insert or update or delete on public.perfiles
  for each row execute function public.audit_row_change();
create trigger deudores_audit
  after insert or update or delete on public.deudores
  for each row execute function public.audit_row_change();
create trigger prestamos_audit
  after insert or update or delete on public.prestamos
  for each row execute function public.audit_row_change();
create trigger cuotas_audit
  after insert or update or delete on public.cuotas
  for each row execute function public.audit_row_change();
create trigger pagos_audit
  after insert or update or delete on public.pagos
  for each row execute function public.audit_row_change();
create trigger prorrogas_audit
  after insert or update or delete on public.prorrogas
  for each row execute function public.audit_row_change();

alter table public.carteras enable row level security;
alter table public.perfiles enable row level security;
alter table public.deudores enable row level security;
alter table public.prestamos enable row level security;
alter table public.cuotas enable row level security;
alter table public.pagos enable row level security;
alter table public.prorrogas enable row level security;
alter table public.auditoria enable row level security;

revoke all on table
  public.carteras,
  public.perfiles,
  public.deudores,
  public.prestamos,
  public.cuotas,
  public.pagos,
  public.prorrogas,
  public.auditoria
from anon, authenticated;
grant usage on schema public to authenticated;

grant select, insert, update, delete on table
  public.carteras,
  public.perfiles,
  public.deudores,
  public.prestamos,
  public.cuotas,
  public.prorrogas
to authenticated;
grant select, insert on table public.pagos to authenticated;
grant select on table public.auditoria to authenticated;

create policy carteras_select
  on public.carteras for select to authenticated
  using (public.is_admin() or id = (select public.current_user_cartera_id()));
create policy carteras_admin_insert
  on public.carteras for insert to authenticated
  with check (public.is_admin());
create policy carteras_admin_update
  on public.carteras for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy carteras_admin_delete
  on public.carteras for delete to authenticated
  using (public.is_admin());

create policy perfiles_select_self_or_admin
  on public.perfiles for select to authenticated
  using (usuario_id = (select auth.uid()) or public.is_admin());
create policy perfiles_admin_insert
  on public.perfiles for insert to authenticated
  with check (public.is_admin());
create policy perfiles_admin_update
  on public.perfiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy perfiles_admin_delete
  on public.perfiles for delete to authenticated
  using (public.is_admin());

create policy deudores_select_cartera
  on public.deudores for select to authenticated
  using (public.is_admin() or cartera_id = (select public.current_user_cartera_id()));
create policy deudores_admin_insert
  on public.deudores for insert to authenticated
  with check (public.is_admin());
create policy deudores_admin_update
  on public.deudores for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy deudores_admin_delete
  on public.deudores for delete to authenticated
  using (public.is_admin());

create policy prestamos_select_cartera
  on public.prestamos for select to authenticated
  using (public.is_admin() or cartera_id = (select public.current_user_cartera_id()));
create policy prestamos_admin_insert
  on public.prestamos for insert to authenticated
  with check (public.is_admin());
create policy prestamos_admin_update
  on public.prestamos for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy prestamos_admin_delete
  on public.prestamos for delete to authenticated
  using (public.is_admin());

create policy cuotas_select_cartera
  on public.cuotas for select to authenticated
  using (public.is_admin() or cartera_id = (select public.current_user_cartera_id()));
create policy cuotas_admin_insert
  on public.cuotas for insert to authenticated
  with check (public.is_admin());
create policy cuotas_admin_update
  on public.cuotas for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy cuotas_admin_delete
  on public.cuotas for delete to authenticated
  using (public.is_admin());

create policy pagos_select_cartera
  on public.pagos for select to authenticated
  using (public.is_admin() or cartera_id = (select public.current_user_cartera_id()));
create policy pagos_admin_insert
  on public.pagos for insert to authenticated
  with check (
    public.is_admin()
    and registrado_por = (select auth.uid())
  );

create policy prorrogas_select_cartera
  on public.prorrogas for select to authenticated
  using (public.is_admin() or cartera_id = (select public.current_user_cartera_id()));
create policy prorrogas_admin_insert
  on public.prorrogas for insert to authenticated
  with check (
    public.is_admin()
    and registrada_por = (select auth.uid())
  );

create policy auditoria_admin_select
  on public.auditoria for select to authenticated
  using (public.is_admin());

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'documentos-identidad',
  'documentos-identidad',
  false,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do update
set
  name = excluded.name,
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy documentos_select_cartera
  on storage.objects for select to authenticated
  using (
    bucket_id = 'documentos-identidad'
    and (
      public.is_admin()
      or (select public.current_user_cartera_id())::text
        = (storage.foldername(name))[1]
    )
  );
create policy documentos_admin_insert
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'documentos-identidad'
    and public.is_admin()
    and name ~* (
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
      || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
      || '[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
    )
  );
create policy documentos_admin_update
  on storage.objects for update to authenticated
  using (bucket_id = 'documentos-identidad' and public.is_admin())
  with check (
    bucket_id = 'documentos-identidad'
    and public.is_admin()
    and name ~* (
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
      || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
      || '[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'
    )
  );
create policy documentos_admin_delete
  on storage.objects for delete to authenticated
  using (bucket_id = 'documentos-identidad' and public.is_admin());
