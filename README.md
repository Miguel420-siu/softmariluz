# Préstamos

Aplicación web responsive para registrar y consultar préstamos semanales.

## Requisitos

- Node.js y npm
- Un proyecto de Supabase

## Desarrollo local

Desde la carpeta del proyecto (`prestamos/`):

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

Completa `.env.local` con los datos del proyecto en **Supabase → Project Settings → API**:

```dotenv
VITE_SUPABASE_URL=https://YOUR_PROJECT_ID.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_PUBLIC_KEY
```

Se puede usar la clave pública `anon` o `publishable`. Las variables `VITE_*` se
incluyen en el código enviado al navegador: nunca guardes aquí la clave
`service_role` ni otra credencial secreta. `.env.local` está excluido de Git.
Después de cambiar estas variables, reinicia el servidor de Vite.

## Comandos

```powershell
npm run dev      # Servidor local
npm run build    # Verificación TypeScript y compilación de producción
npm run lint     # ESLint
npm run preview  # Vista local de la compilación
```

## Acceso y roles

La aplicación no ofrece registro público. El inicio de sesión usa Supabase Auth
con correo y contraseña. Crea las cuentas autorizadas desde el panel de Supabase
y deshabilita el registro de nuevos usuarios en la configuración de Auth.

El cliente espera un registro en `public.perfiles` por usuario autenticado, con
estos campos:

| Campo | Uso |
| --- | --- |
| `usuario_id` | UUID de la cuenta en `auth.users` |
| `rol` | `admin` o `lector` |
| `cartera_id` | Cartera asignada al lector; nulo para un administrador |

El lector solo puede entrar a su pantalla de consulta y el administrador a su
panel de gestión. La interfaz bloquea rutas por rol, pero **eso no reemplaza
RLS**: los permisos y el aislamiento de datos se deben validar en PostgreSQL.

La etapa 1 dejó configurado Vite, React, TypeScript, Tailwind CSS, React Router y
el cliente de Supabase. La etapa 2 agregó el inicio de sesión y la protección de
rutas según el perfil.

## Base de datos y migraciones

La migración `supabase/migrations/20261029152007_create_loan_management_schema.sql`
crea las carteras, perfiles, deudores, préstamos, cuotas, pagos, prórrogas,
auditoría y el bucket privado `documentos-identidad`. La migración
`supabase/migrations/20261029163007_rename_wallets_and_limit_interest_rates.sql`
introdujo tasas predeterminadas para los nuevos préstamos; las migraciones
posteriores `supabase/migrations/20261031150000_whole_dollar_schedule_and_due_grace.sql`
y `supabase/migrations/20261104135000_allow_calculated_interest_rates.sql`
actualizan el cronograma a dólares enteros y permiten derivar la tasa desde el
total estimado, incluido el 0% de interés.
La migración `supabase/migrations/20261105002400_add_borrower_email.sql`
agrega el correo opcional del deudor para el envío de extractos.
La migración `supabase/migrations/20261110000000_add_loan_portfolio_numbers.sql`
asigna a cada préstamo un código consecutivo por cartera. La migración
`supabase/migrations/20261110010000_loan_codes_and_unique_borrower_contacts.sql`
usa códigos sin ceros a la izquierda y evita repetir correo o teléfono dentro
de la misma cartera.
La migración `supabase/migrations/20261110020000_refinance_loans_and_prevent_active_duplicates.sql`
permite refinanciar préstamos con entre una y tres cuotas pendientes. El saldo anterior se descuenta
del efectivo entregado, pero no se registra como pago en efectivo ni como
interés cobrado.
La migración `supabase/migrations/20261110040000_refinance_up_to_three_installments.sql`
ajusta esa regla tanto en la interfaz como en la función transaccional de
Supabase: los préstamos con 1, 2 o 3 cuotas pendientes se pueden refinanciar;
con 0 o más de 3 no se permite.
La migración `supabase/migrations/20261110050000_allow_multiple_active_loans_per_borrower.sql`
permite que un mismo cliente tenga varios préstamos activos. Al crear un
préstamo, la refinanciación es opcional y se puede escoger por código cuál
préstamo refinanciar.
La migración `supabase/migrations/20261029174430_simplify_wallet_display_names.sql`
establece los nombres visibles Cartera Francisco y Cartera Mariluz; las claves
internas de las carteras no cambian.
El esquema usa importes `numeric`, activa RLS, concede acceso al rol
`authenticated` y reserva las escrituras para el administrador. Los pagos y
prórrogas no se pueden editar ni borrar; los ajustes se registran como nuevos
pagos. La migración
`supabase/migrations/20261029163849_record_payments_and_extensions.sql` agrega
funciones transaccionales para pagos y reversos, y restringe las escrituras
directas del ledger. La migración
`supabase/migrations/20261029164630_preserve_existing_loan_rates.sql` valida las
tasas al crear o cambiar un préstamo sin bloquear el uso de tasas históricas.
Las migraciones `20261029165608_add_admin_test_deletion_rpcs.sql` y
`20261029170247_return_document_path_for_test_deletion.sql` habilitan el borrado
administrativo de datos de prueba y devuelven la ruta del documento para que el
cliente la retire usando la API de Storage. La migración
`20261120010000_cleanup_orphan_test_loans_and_reset_codes.sql` asegura que al
eliminar un deudor también se borren sus préstamos y permite limpiar préstamos
huérfanos desde la interfaz de administración. La secuencia de códigos se
reinicia al borrar el último préstamo de una cartera. La migración
`20261120020000_fix_borrower_deletion_storage_cleanup.sql` mantiene la
eliminación de documentos en la API de Storage, después de borrar el perfil.
La migración `supabase/migrations/20261110030000_maryluz_cash_flow.sql`
agrega el Control financiero, visible solo para el administrador y limitado en
la base de datos a la cartera Mariluz. El control inicia con saldo cero y no
reconstruye movimientos anteriores. Los préstamos pueden crearse antes de
iniciarlo para hacer pruebas; sus desembolsos previos no se incluyen en el
saldo del control. Una vez iniciado, los pagos y desembolsos nuevos se agregan
automáticamente, las refinanciaciones descuentan únicamente el efectivo neto,
y la base de datos impide crear préstamos o gastos personales por encima del
saldo disponible. Los gastos y los ingresos de salario requieren una
descripción. Los movimientos financieros son inmutables; al borrar datos de
prueba se agrega una compensación en lugar de borrar el historial.
Los lectores solo pueden consultar su cartera y leer sus documentos.

La configuración local de Supabase CLI está en `supabase/config.toml` y mantiene
desactivados el auto-registro y la exposición automática de tablas. Desactiva
también el registro en el panel remoto: **Authentication → Settings → User Signups**.
La configuración local no cambia por sí sola el proyecto alojado.

Para aplicar las migraciones al proyecto remoto, desde esta carpeta:

```powershell
npx supabase@latest login
npx supabase@latest link --project-ref TU_PROJECT_REF
npx supabase@latest db push --remote
```

La vinculación y `db push` necesitan acceso CLI y la contraseña de la base de
datos. No uses la clave `anon`/`publishable` para estas operaciones y no guardes
la contraseña de PostgreSQL en el frontend ni en el repositorio. Antes de
aplicarla, revisa el SQL y asegúrate de estar vinculando el proyecto correcto.

### Crear las tres cuentas iniciales

La migración crea las carteras, pero no usuarios ni contraseñas. Las tres cuentas autorizadas están vinculadas en `public.perfiles`:

- Administrador → rol `admin`, sin cartera asignada.
- Persona X → rol `lector`, Cartera Francisco.
- Persona Y → rol `lector`, Cartera Mariluz.

Las cuentas las crea el usuario en Supabase Auth; sus contraseñas no se escriben
en la migración, el código ni el script SQL. El archivo
`supabase/bootstrap_profiles.example.sql` queda como plantilla para volver a
asignar perfiles: reemplaza sus correos de ejemplo antes de ejecutarlo.

La creación remota de usuarios requiere privilegios administrativos de Supabase;
no se debe hacer desde el navegador ni con la clave pública. Una vez aplicadas
las tablas y creados los perfiles, el login valida los roles. Los tipos
TypeScript se generaron desde el esquema remoto y se usan en el cliente
Supabase. Para volver a generarlos después de una migración:

```powershell
npx supabase@latest gen types typescript --linked --schema public |
  Set-Content -Path src/types/database.types.ts -Encoding utf8
```

El bucket privado limita cada archivo a 5 MiB y acepta JPEG, PNG, WebP y PDF.
Guarda en `documento_path` solo la ruta del objeto, nunca una URL firmada. Los
lectores pueden ver archivos de su cartera; solo el administrador puede
subirlos, reemplazarlos o eliminarlos.

## Deudores y préstamos

Las rutas de trabajo son `/admin/deudores`, `/admin/prestamos`,
`/cartera/deudores` y `/cartera/prestamos`. El administrador puede crear y editar
deudores, elegir una cartera al registrarlos y crear préstamos para esa misma
cartera. Los lectores solo consultan sus registros y no ven controles de edición.
El perfil del deudor muestra su información y préstamos asociados.

Las imágenes de identidad se reducen en el dispositivo y se convierten a WebP;
los PDF se conservan sin cambios. El cliente utiliza URLs firmadas de dos
minutos para abrir documentos privados.

El cálculo aislado en `src/lib/loan-calculation.ts` usa centavos enteros
(`bigint`) para calcular y repartir capital e intereses sin redondeo de punto
flotante. Al crear un préstamo, se ingresan el capital, el número de cuotas y
el valor fijo de cada cuota; el total es la cuota multiplicada por el número de
cuotas, y el interés es la diferencia entre el total y el capital. Por ejemplo,
un préstamo de $1,500 con 10 cuotas de $190 genera un total de $1,900 y $400 de
interés. Se permiten préstamos sin interés si el total iguala el capital. Las
cuotas vencen semanalmente desde la fecha de primera cuota.

Cada préstamo recibe en la base de datos un código inmutable, consecutivo y
único por cartera: `F-1` para Francisco y `M-1` para Mariluz. El código solo
se muestra en la página de detalle del préstamo; los préstamos existentes se
renumeran al aplicar la migración sin ceros a la izquierda, manteniendo el
orden y número asignado. El número no se reutiliza al borrar préstamos
individuales; al eliminar el último préstamo de una cartera durante las
pruebas, la secuencia se reinicia para que el siguiente vuelva a ser `F-1` o
`M-1`.

Al crear o editar un deudor, nombre, teléfono y dirección son obligatorios;
identificación y correo son opcionales. No se repiten dentro de una cartera el
número de identificación si se registra, el correo ni el teléfono. El correo se
usa para enviar el extracto y el teléfono queda disponible para futuras
notificaciones SMS.

El perfil del deudor permite descargar un PDF con su nombre, identificación,
dirección, teléfono y un préstamo activo seleccionado, con pagos, saldo y
cronograma. Todos los importes del documento se muestran redondeados a dólares
enteros y el saldo se calcula al generar el PDF. El administrador puede generar
desde el dashboard consolidados de préstamos activos y terminados; cada
préstamo tiene su propia fila con su código y sus valores, incluso cuando un
cliente tenga varios préstamos. Los consolidados no incluyen notas de pagos y
cierran con una fila de totales. El selector de deudores al crear un
préstamo permite buscar por nombre o identificación. El cronograma muestra
“Abono a capital”. Para pruebas, el administrador puede eliminar deudores o
préstamos completos, además de limpiar préstamos huérfanos desde la página de
préstamos; la interfaz lo confirma explícitamente, la operación es irreversible
y la auditoría histórica se conserva. Los movimientos de caja se compensan para
mantener la trazabilidad. Si la eliminación del documento privado falla
después de borrar al deudor, la aplicación lo informa para que el objeto
pendiente se limpie desde Storage.

En el detalle de un préstamo, el administrador puede enviar el estado de cuenta
PDF al correo registrado en el perfil del deudor. El correo es opcional; si no
está registrado, la acción de envío permanece deshabilitada. El servidor valida
la sesión y el rol de administrador y obtiene el destinatario desde la base de
datos, no desde el navegador.

El envío usa la Edge Function
`supabase/functions/send-loan-statement/index.ts` y Gmail SMTP por TLS en el
puerto 465. La configuración SMTP de Supabase Auth no se comparte con Edge
Functions: configura los secretos `GMAIL_USER` y `GMAIL_APP_PASSWORD` en
**Supabase Dashboard → Edge Functions → Secrets**. `GMAIL_USER` contiene la
cuenta de Gmail y `GMAIL_APP_PASSWORD` su contraseña de aplicación; no uses la
contraseña habitual de Gmail ni guardes secretos en el repositorio o en
variables `VITE_*`. El SMTP de Gmail en Supabase requiere el puerto 465 porque
las conexiones salientes a 25 y 587 están bloqueadas.

Después de aplicar la migración del correo, despliega la función desde esta
carpeta:

```powershell
npx supabase@latest functions deploy send-loan-statement
```

## Pagos y prórrogas

En `/admin/prestamos`, el administrador puede registrar el pago completo de la
cuota pendiente más antigua o aceptar solo sus intereses. La segunda opción
marca como pagados esos intereses, desplaza el capital a la siguiente cuota,
mueve las cuotas restantes una semana y extiende el préstamo sin cobrar interés
adicional. Si se prorroga la última cuota, se agrega una cuota final solo de
capital. Cada operación se ejecuta en una función SQL transaccional para
mantener sincronizados el pago, el cronograma y el estado del préstamo.

El historial está disponible para administradores y lectores de la cartera
correspondiente. Los pagos se registran con la hora del servidor en `timestamptz`
(UTC) y se muestran en `America/New_York`. Los reversos crean un ajuste negativo
inmutable con motivo; por seguridad, solo se puede revertir automáticamente el
pago más reciente del préstamo.

El administrador también puede eliminar préstamos de prueba desde el historial
de préstamos terminados; se pide confirmación, los datos relacionados se
eliminan y la auditoría histórica se conserva.

La pestaña **Préstamos** muestra únicamente préstamos activos o atrasados. Cada
uno tiene una página propia con sus datos, cronograma, estado de pagos y las
acciones de pago disponibles para el administrador. Se puede abrir desde la
lista de préstamos, desde el perfil del deudor o desde el historial, incluidos
los préstamos terminados. El dashboard muestra desembolsos por mes y clientes
con préstamos activos al cierre de cada mes, aplicando el filtro de cartera del
administrador o la cartera asignada al lector.

Los formularios requieren que el proyecto remoto ya tenga aplicadas las migraciones
y que los perfiles estén asignados. La pantalla solo informa resultados
obtenidos por Supabase; RLS sigue siendo el límite efectivo de seguridad.

La aplicación y sus archivos de configuración están dentro de esta carpeta.

## Publicación en Cloudflare Pages

Conecta el repositorio privado de GitHub en Cloudflare Pages. Configura la
carpeta raíz del proyecto como `prestamos` si el repositorio contiene la carpeta
exterior `Prestamos/`; si el repositorio tiene directamente estos archivos, usa
la raíz del repositorio. Usa el comando de compilación `npm run build` y el
directorio de salida `dist`. Configura `VITE_SUPABASE_URL` y
`VITE_SUPABASE_ANON_KEY` en las variables de entorno de Pages para producción.
La clave pública se entrega al navegador; la seguridad depende de Auth y RLS,
no de ocultar esa clave.

`public/_redirects` configura el fallback de las rutas de React Router para que
las URL internas funcionen al abrirlas o recargarlas directamente.

## Actividad y respaldos

El workflow `.github/workflows/supabase-keepalive.yml` consulta la base de datos
dos veces por semana y también puede ejecutarse manualmente desde GitHub
Actions. Guarda la cadena de conexión PostgreSQL del proyecto como secreto
`SUPABASE_DB_URL` en **Settings → Secrets and variables → Actions**. Usa la
cadena de conexión de un usuario de base de datos dedicado que solo necesite
conectarse y ejecutar `select 1`; no uses el usuario administrador, la clave
`service_role` ni la clave pública. Usa una conexión con SSL y nunca publiques
la cadena en el repositorio. El workflow falla explícitamente si falta el
secreto o si la conexión no funciona. GitHub Actions en repositorios privados
puede estar sujeto a los límites de minutos del plan gratuito.

GitHub solo detecta workflows en `.github/workflows` en la raíz del
repositorio. El archivo incluido queda listo si el repositorio tiene como raíz
esta carpeta del proyecto; si el repositorio usa la carpeta exterior, mueve
allí `.github/workflows/supabase-keepalive.yml`.

Para un respaldo manual de las tablas de `public`, instala PostgreSQL
Command-Line Tools y ejecuta desde PowerShell:

```powershell
$secureConnection = Read-Host "Cadena de conexión PostgreSQL de Supabase" -AsSecureString
$connectionPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureConnection)
try {
  $connection = [Uri][Runtime.InteropServices.Marshal]::PtrToStringBSTR($connectionPointer)
  $credentials = $connection.UserInfo.Split(':', 2)
  if ($credentials.Length -ne 2) { throw "La cadena de conexión no tiene usuario y contraseña." }
  $dbUser = [Uri]::UnescapeDataString($credentials[0])
  $dbName = $connection.AbsolutePath.TrimStart('/')
  $env:PGPASSWORD = [Uri]::UnescapeDataString($credentials[1])
  $env:PGSSLMODE = "require"
  pg_dump "--host=$($connection.Host)" "--port=$($connection.Port)" `
    "--username=$dbUser" "--dbname=$dbName" `
    --schema=public --no-owner --no-acl --file="respaldo-public.sql"
  if ($LASTEXITCODE -ne 0) { throw "pg_dump no pudo completar el respaldo." }
} finally {
  Remove-Item Env:\PGPASSWORD, Env:\PGSSLMODE -ErrorAction SilentlyContinue
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($connectionPointer)
}
```

Protege el archivo de respaldo como información sensible, guárdalo fuera del
repositorio y verifica periódicamente que se pueda leer. Ese volcado no incluye
las cuentas de Auth ni el contenido de Storage. Respalda por separado los
documentos de identidad desde Storage y guárdalos cifrados en un lugar privado;
nunca los agregues al repositorio ni a una carpeta pública. Las cuentas de Auth
deben recrearse desde el panel si se restaura en otro proyecto.
