import {
  lazy,
  Suspense,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react'
import {
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom'
import type { AccountRole } from './auth/types'
import { useAuth } from './auth/useAuth'
import { WorkspaceLayout } from './components/WorkspaceLayout'

const BorrowerProfilePage = lazy(() =>
  import('./pages/BorrowerProfilePage').then((module) => ({
    default: module.BorrowerProfilePage,
  })),
)
const DashboardPage = lazy(() =>
  import('./pages/DashboardPage').then((module) => ({
    default: module.DashboardPage,
  })),
)
const CashControlPage = lazy(() =>
  import('./pages/CashControlPage').then((module) => ({
    default: module.CashControlPage,
  })),
)
const BorrowersPage = lazy(() =>
  import('./pages/BorrowersPage').then((module) => ({
    default: module.BorrowersPage,
  })),
)
const HistoryPage = lazy(() =>
  import('./pages/HistoryPage').then((module) => ({
    default: module.HistoryPage,
  })),
)
const LoansPage = lazy(() =>
  import('./pages/LoansPage').then((module) => ({
    default: module.LoansPage,
  })),
)

function LoadingScreen() {
  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 px-4">
      <div className="flex items-center gap-3 text-sm font-medium text-slate-600">
        <span className="size-5 animate-spin rounded-full border-2 border-slate-300 border-t-emerald-700" />
        Verificando acceso seguro…
      </div>
    </main>
  )
}

function AlertAutoScroll() {
  useEffect(() => {
    const observer = new MutationObserver((records) => {
      const alerts = new Set<Element>()

      function collectAlert(node: Node) {
        if (!(node instanceof Element)) return
        if (node.matches('[role="alert"]')) alerts.add(node)
        node.querySelectorAll('[role="alert"]').forEach((alert) => alerts.add(alert))
      }

      for (const record of records) {
        const target =
          record.target instanceof Element
            ? record.target
            : record.target.parentElement
        const targetAlert = target?.closest('[role="alert"]')
        if (targetAlert) alerts.add(targetAlert)
        record.addedNodes.forEach(collectAlert)
      }

      const visibleAlerts = [...alerts].filter(
        (alert) => alert.getClientRects().length > 0,
      )
      const alert = visibleAlerts[visibleAlerts.length - 1]
      if (!alert) return

      alert.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'instant'
          : 'smooth',
        block: 'center',
      })
    })

    observer.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    })
    return () => observer.disconnect()
  }, [])

  return null
}

function Brand({ inverse = false }: { inverse?: boolean }) {
  const nameClass = inverse ? 'text-white' : 'text-slate-950'
  const taglineClass = inverse ? 'text-emerald-100/70' : 'text-slate-500'

  return (
    <Link to="/" className="flex items-center gap-3" aria-label="Préstamos, inicio">
      <span className="flex size-10 items-center justify-center rounded-xl bg-emerald-700 text-lg font-bold text-white">
        P
      </span>
      <span>
        <span className={`block text-base font-semibold leading-tight ${nameClass}`}>
          Préstamos
        </span>
        <span className={`block text-xs ${taglineClass}`}>Control de cartera</span>
      </span>
    </Link>
  )
}

function ProfileProblem() {
  const { profileError, signOut } = useAuth()
  const [signOutError, setSignOutError] = useState<string | null>(null)

  async function handleSignOut() {
    setSignOutError(null)
    try {
      await signOut()
    } catch (error) {
      console.error('No se pudo cerrar la sesión.', error)
      setSignOutError('No fue posible cerrar la sesión. Inténtalo de nuevo.')
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 px-4 py-10">
      <section
        className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8"
        aria-labelledby="profile-problem-title"
      >
        <Brand />
        <div className="mt-8 rounded-xl bg-amber-50 p-4 text-sm leading-6 text-amber-950">
          <h1 id="profile-problem-title" className="font-semibold">
            No se pudo habilitar esta cuenta
          </h1>
          <p className="mt-2">{profileError}</p>
        </div>
        <p className="mt-4 text-sm leading-6 text-slate-600">
          Solo el administrador puede habilitar las cuentas y asignar una cartera.
          No hay registro público.
        </p>
        {signOutError && (
          <p role="alert" className="mt-4 text-sm text-red-700">
            {signOutError}
          </p>
        )}
        <button
          type="button"
          onClick={() => void handleSignOut()}
          className="mt-6 min-h-11 w-full rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
        >
          Cerrar sesión
        </button>
      </section>
    </main>
  )
}

function LoginPage() {
  const { isConfigured, loading, profile, profileError, signIn, user } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passwordVisible, setPasswordVisible] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  if (loading) return <LoadingScreen />
  if (user && profile) {
    return <Navigate to={homeForRole(profile.role)} replace />
  }
  if (user && profileError) return <ProfileProblem />

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setFormError(null)
    setSubmitting(true)

    try {
      await signIn(email.trim(), password)
    } catch (error) {
      console.error('No se pudo iniciar sesión.', error)
      const message = error instanceof Error ? error.message : ''
      setFormError(
        message.toLowerCase().includes('invalid login credentials')
          ? 'El correo o la contraseña no son correctos.'
          : 'No fue posible iniciar sesión. Revisa la conexión e inténtalo de nuevo.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="grid min-h-screen bg-slate-50 lg:grid-cols-2">
      <section className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-md">
          <Brand />
          <div className="mt-10 sm:mt-14">
            <p className="text-sm font-semibold uppercase tracking-[0.14em] text-emerald-700">
              Acceso privado
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950 sm:text-4xl">
              Iniciar sesión
            </h1>
            <p className="mt-3 text-sm leading-6 text-slate-600">
              Ingresa con la cuenta que te proporcionó el administrador.
            </p>
          </div>

          {!isConfigured && (
            <p
              role="alert"
              className="mt-6 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm leading-5 text-amber-900"
            >
              Falta configurar la conexión con Supabase. Revisa las variables
              locales y reinicia el servidor de desarrollo.
            </p>
          )}
          {!user && profileError && (
            <p
              role="alert"
              className="mt-6 rounded-lg border border-red-200 bg-red-50 p-3 text-sm leading-5 text-red-800"
            >
              {profileError}
            </p>
          )}

          <form onSubmit={handleSubmit} className="mt-8 space-y-5">
            <div>
              <label
                htmlFor="email"
                className="mb-2 block text-sm font-medium text-slate-800"
              >
                Correo electrónico
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className="min-h-12 w-full rounded-lg border border-slate-300 bg-white px-3.5 text-base text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-emerald-700 focus:ring-2 focus:ring-emerald-700/15"
                placeholder="nombre@ejemplo.com"
              />
            </div>

            <div>
              <label
                htmlFor="password"
                className="mb-2 block text-sm font-medium text-slate-800"
              >
                Contraseña
              </label>
              <div className="relative">
                <input
                  id="password"
                  name="password"
                  type={passwordVisible ? 'text' : 'password'}
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="min-h-12 w-full rounded-lg border border-slate-300 bg-white px-3.5 pr-20 text-base text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-emerald-700 focus:ring-2 focus:ring-emerald-700/15"
                  placeholder="Tu contraseña"
                />
                <button
                  type="button"
                  onClick={() => setPasswordVisible((visible) => !visible)}
                  aria-label={passwordVisible ? 'Ocultar contraseña' : 'Mostrar contraseña'}
                  className="absolute inset-y-0 right-0 rounded-r-lg px-3 text-sm font-medium text-slate-600 hover:text-slate-950 focus-visible:outline-2 focus-visible:outline-emerald-700"
                >
                  {passwordVisible ? 'Ocultar' : 'Mostrar'}
                </button>
              </div>
            </div>

            {formError && (
              <p
                role="alert"
                className="rounded-lg border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-800"
              >
                {formError}
              </p>
            )}

            <button
              type="submit"
              disabled={!isConfigured || submitting}
              className="min-h-12 w-full rounded-lg bg-emerald-700 px-4 py-3 text-sm font-semibold text-white transition hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {submitting ? 'Verificando…' : 'Entrar'}
            </button>
          </form>

          <p className="mt-6 text-center text-xs leading-5 text-slate-500">
            Acceso exclusivo para las cuentas autorizadas. No hay opción de
            registro.
          </p>
        </div>
      </section>

      <aside className="hidden flex-col justify-between bg-emerald-950 p-10 text-white lg:flex xl:p-14">
        <Brand inverse />
        <div className="max-w-lg py-12">
          <p className="text-sm font-semibold uppercase tracking-[0.16em] text-emerald-300">
            Control de cartera
          </p>
          <p className="mt-5 text-4xl font-semibold leading-tight tracking-tight xl:text-5xl">
            La información de cada cartera, protegida.
          </p>
          <p className="mt-5 max-w-md text-base leading-7 text-emerald-100/80">
            Cada persona accede únicamente a la información que le corresponde.
            Los permisos también se validan en la base de datos.
          </p>
        </div>
        <p className="text-xs text-emerald-100/60">
          Acceso seguro · Experiencia adaptable a tu dispositivo
        </p>
      </aside>
    </main>
  )
}

function homeForRole(role: AccountRole) {
  return role === 'admin' ? '/admin' : '/cartera'
}

function IndexRedirect() {
  const { loading, profile, profileError, user } = useAuth()
  if (loading) return <LoadingScreen />
  if (!user) return <Navigate to="/login" replace />
  if (profileError || !profile) return <ProfileProblem />
  return <Navigate to={homeForRole(profile.role)} replace />
}

function ProtectedRoute({
  role,
  children,
}: {
  role: AccountRole
  children: ReactNode
}) {
  const { loading, profile, profileError, user } = useAuth()
  const location = useLocation()

  if (loading) return <LoadingScreen />
  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }
  if (profileError || !profile) return <ProfileProblem />
  if (profile.role !== role) {
    return <Navigate to={homeForRole(profile.role)} replace />
  }

  return children
}

function WorkspaceRoutes({ role }: { role: AccountRole }) {
  const basePath = role === 'admin' ? '/admin' : '/cartera'

  return (
    <WorkspaceLayout>
      <Suspense fallback={<LoadingScreen />}>
        <Routes>
          <Route index element={<DashboardPage />} />
          <Route path="deudores" element={<BorrowersPage />} />
          <Route
            path="deudores/:deudorId"
            element={<BorrowerProfilePage />}
          />
          <Route path="prestamos" element={<LoansPage />} />
          <Route path="prestamos/:prestamoId" element={<LoansPage />} />
          <Route path="historial" element={<HistoryPage />} />
          {role === 'admin' && (
            <Route
              path="control-financiero"
              element={<CashControlPage />}
            />
          )}
          <Route path="*" element={<Navigate to={basePath} replace />} />
        </Routes>
      </Suspense>
    </WorkspaceLayout>
  )
}
function NotFoundPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-slate-50 px-4 text-center">
      <div>
        <p className="text-sm font-semibold text-emerald-700">404</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-950">
          No encontramos esa página
        </h1>
        <Link
          to="/"
          className="mt-5 inline-flex min-h-11 items-center rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
        >
          Volver al inicio
        </Link>
      </div>
    </main>
  )
}

function App() {
  return (
    <>
      <AlertAutoScroll />
      <Routes>
        <Route path="/" element={<IndexRedirect />} />
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/admin/*"
          element={
            <ProtectedRoute role="admin">
              <WorkspaceRoutes role="admin" />
            </ProtectedRoute>
          }
        />
        <Route
          path="/cartera/*"
          element={
            <ProtectedRoute role="lector">
              <WorkspaceRoutes role="lector" />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </>
  )
}

export default App
