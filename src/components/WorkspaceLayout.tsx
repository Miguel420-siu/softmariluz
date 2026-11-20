import { useEffect, useState, type ReactNode } from 'react'
import { Link, NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'

function Brand() {
  return (
    <Link to="/" className="flex items-center gap-3" aria-label="Préstamos, inicio">
      <span className="flex size-10 items-center justify-center rounded-xl bg-emerald-700 text-lg font-bold text-white">
        P
      </span>
      <span>
        <span className="block text-base font-semibold leading-tight text-slate-950">
          Préstamos
        </span>
        <span className="block text-xs text-slate-500">Control de cartera</span>
      </span>
    </Link>
  )
}

export function WorkspaceLayout({
  children,
}: {
  children: ReactNode
}) {
  const { profile, signOut, user } = useAuth()
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const [showBackToTop, setShowBackToTop] = useState(false)
  const navigate = useNavigate()
  const isAdmin = profile?.role === 'admin'
  const basePath = isAdmin ? '/admin' : '/cartera'

  async function handleSignOut() {
    setSignOutError(null)
    try {
      await signOut()
      navigate('/login', { replace: true })
    } catch (error) {
      console.error('No se pudo cerrar la sesión.', error)
      setSignOutError('No fue posible cerrar la sesión. Inténtalo de nuevo.')
    }
  }

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `min-h-10 rounded-lg px-3 py-2 text-sm font-medium transition ${
      isActive
        ? 'bg-emerald-50 text-emerald-800'
        : 'text-slate-600 hover:bg-slate-100 hover:text-slate-950'
    }`

  useEffect(() => {
    function updateBackToTopVisibility() {
      setShowBackToTop(window.scrollY > 300)
    }

    updateBackToTopVisibility()
    window.addEventListener('scroll', updateBackToTopVisibility, {
      passive: true,
    })
    return () => window.removeEventListener('scroll', updateBackToTopVisibility)
  }, [])

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <Brand />
          <div className="flex items-center gap-3">
            <span className="hidden max-w-52 truncate text-sm text-slate-600 sm:block">
              {user?.email}
            </span>
            <button
              type="button"
              onClick={() => void handleSignOut()}
              className="min-h-10 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
            >
              Cerrar sesión
            </button>
          </div>
        </div>
        <nav
          aria-label="Navegación principal"
          className="mx-auto flex max-w-6xl gap-2 overflow-x-auto px-4 pb-3 sm:px-6 lg:px-8"
        >
          <NavLink to={basePath} end className={linkClass}>
            Dashboard
          </NavLink>
          <NavLink to={`${basePath}/deudores`} className={linkClass}>
            Deudores
          </NavLink>
          <NavLink to={`${basePath}/prestamos`} className={linkClass}>
            Préstamos
          </NavLink>
          <NavLink to={`${basePath}/historial`} className={linkClass}>
            Historial
          </NavLink>
          {isAdmin && (
            <NavLink
              to="/admin/control-financiero"
              className={linkClass}
            >
              Control financiero
            </NavLink>
          )}
        </nav>
      </header>
      {signOutError && (
        <p
          role="alert"
          className="mx-auto mt-4 max-w-6xl px-4 text-sm text-red-700 sm:px-6 lg:px-8"
        >
          {signOutError}
        </p>
      )}
      {children}
      {showBackToTop && (
        <button
          type="button"
          onClick={() =>
            window.scrollTo({
              top: 0,
              behavior: window.matchMedia('(prefers-reduced-motion: reduce)')
                .matches
                ? 'instant'
                : 'smooth',
            })
          }
          className="fixed bottom-5 right-4 z-40 inline-flex min-h-11 items-center gap-2 rounded-full bg-emerald-700 px-4 text-sm font-semibold text-white shadow-lg transition hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700 md:hidden"
          aria-label="Volver arriba"
        >
          <svg
            aria-hidden="true"
            className="h-4 w-4"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M9.47 4.22a.75.75 0 0 1 1.06 0l5.25 5.25a.75.75 0 1 1-1.06 1.06L10 5.81l-4.72 4.72a.75.75 0 1 1-1.06-1.06l5.25-5.25ZM10 8.25a.75.75 0 0 1 .75.75v6a.75.75 0 0 1-1.5 0V9a.75.75 0 0 1 .75-.75Z"
              clipRule="evenodd"
            />
          </svg>
          Volver arriba
        </button>
      )}
    </div>
  )
}
