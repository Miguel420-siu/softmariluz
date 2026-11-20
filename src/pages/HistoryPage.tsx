import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { useWalletFilter } from '../hooks/useWalletFilter'
import { formatMoney, parseDecimalUnits } from '../lib/loan-calculation'
import { supabase } from '../lib/supabase'

interface Wallet {
  id: string
  nombre: string
}

interface HistoryBorrower {
  id: string
  nombre: string
  identificacion: string
}

interface HistoryLoan {
  id: string
  codigo: string
  cartera_id: string
  deudor_id: string
  monto: number
  tasa_interes: number
  numero_cuotas: number
  fecha_inicio: string
  fecha_fin: string
  notas: string | null
  created_at: string
}

function formattedDate(date: string) {
  return new Intl.DateTimeFormat('es-US', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`))
}

function formatAmount(value: number) {
  const cents = parseDecimalUnits(String(value), 2)
  return cents === null ? 'Monto inválido' : formatMoney(cents)
}

export function HistoryPage() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [wallets, setWallets] = useState<Wallet[]>([])
  const [walletFilter, setWalletFilter] = useWalletFilter(
    isAdmin,
    profile?.carteraId,
  )
  const [borrowers, setBorrowers] = useState<HistoryBorrower[]>([])
  const [loans, setLoans] = useState<HistoryLoan[]>([])
  const [search, setSearch] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [deletingLoanId, setDeletingLoanId] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    if (!supabase) {
      setErrorMessage('La conexión con Supabase no está configurada.')
      setLoading(false)
      return
    }

    setLoading(true)
    setErrorMessage(null)
    try {
      let permittedWallets: Wallet[] = []
      if (isAdmin) {
        const { data, error } = await supabase
          .from('carteras')
          .select('id, nombre')
          .order('nombre')
        if (error) throw error
        permittedWallets = data ?? []
      } else if (profile?.carteraId) {
        const { data, error } = await supabase
          .from('carteras')
          .select('id, nombre')
          .eq('id', profile.carteraId)
          .maybeSingle()
        if (error) throw error
        permittedWallets = data ? [data] : []
      }

      const [borrowerResult, loanResult] = await Promise.all([
        supabase
          .from('deudores')
          .select('id, nombre, identificacion')
          .order('nombre')
          .limit(5000),
        supabase
          .from('prestamos')
          .select(
            'id, codigo, cartera_id, deudor_id, monto, tasa_interes, numero_cuotas, fecha_inicio, fecha_fin, notas, created_at',
          )
          .eq('estado', 'terminado')
          .order('fecha_fin', { ascending: false })
          .limit(5000),
      ])
      if (borrowerResult.error) throw borrowerResult.error
      if (loanResult.error) throw loanResult.error

      setWallets(permittedWallets)
      setBorrowers((borrowerResult.data ?? []) as HistoryBorrower[])
      setLoans((loanResult.data ?? []) as HistoryLoan[])
    } catch (error) {
      console.error('No se pudo cargar el historial de préstamos.', error)
      setErrorMessage(
        'No fue posible cargar el historial. Revisa la conexión y las políticas RLS.',
      )
    } finally {
      setLoading(false)
    }
  }, [isAdmin, profile])

  useEffect(() => {
    queueMicrotask(() => void loadData())
  }, [loadData])

  async function deleteLoan(loan: HistoryLoan) {
    if (!isAdmin || !supabase) return
    const confirmed = window.confirm(
      '¿Eliminar este préstamo terminado y sus cuotas, pagos y prórrogas? La auditoría histórica se conservará. Esta acción es irreversible.',
    )
    if (!confirmed) return

    setDeletingLoanId(loan.id)
    setErrorMessage(null)
    setSuccessMessage(null)
    try {
      const { error } = await supabase.rpc('eliminar_prestamo_pruebas', {
        p_prestamo_id: loan.id,
      })
      if (error) throw error
      setSuccessMessage('El préstamo y sus datos relacionados fueron eliminados.')
      await loadData()
    } catch (error) {
      console.error('No se pudo eliminar el préstamo terminado de prueba.', error)
      setErrorMessage(
        'No fue posible eliminar el préstamo. Revisa las relaciones y los permisos de Supabase.',
      )
    } finally {
      setDeletingLoanId(null)
    }
  }

  const borrowerById = useMemo(
    () => new Map(borrowers.map((borrower) => [borrower.id, borrower])),
    [borrowers],
  )
  const walletById = useMemo(
    () => new Map(wallets.map((wallet) => [wallet.id, wallet.nombre])),
    [wallets],
  )
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const visibleLoans = loans.filter((loan) => {
    const borrower = borrowerById.get(loan.deudor_id)
    const matchesWallet = !walletFilter || loan.cartera_id === walletFilter
    const matchesSearch =
      !normalizedSearch ||
      loan.codigo.toLocaleLowerCase().includes(normalizedSearch) ||
      borrower?.nombre.toLocaleLowerCase().includes(normalizedSearch) ||
      borrower?.identificacion.toLocaleLowerCase().includes(normalizedSearch)
    return (
      matchesWallet &&
      matchesSearch &&
      (!dateFrom || loan.fecha_fin >= dateFrom) &&
      (!dateTo || loan.fecha_fin <= dateTo)
    )
  })

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
      <div>
        <p className="text-sm font-semibold text-emerald-700">Consulta histórica</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
          Préstamos terminados
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          Busca por número de préstamo, nombre, identificación o fecha de finalización.
        </p>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {isAdmin && (
          <label className="block text-sm font-medium text-slate-800">
            Cartera
            <select
              value={walletFilter}
              onChange={(event) => setWalletFilter(event.target.value)}
              className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base"
            >
              <option value="">Todas las carteras</option>
              {wallets.map((wallet) => (
                <option key={wallet.id} value={wallet.id}>
                  {wallet.nombre}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="block text-sm font-medium text-slate-800">
          Buscar por número de préstamo, nombre o identificación
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Código, nombre o identificación"
            className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base"
          />
        </label>
        <label className="block text-sm font-medium text-slate-800">
          Finalizado desde
          <input
            type="date"
            value={dateFrom}
            onChange={(event) => setDateFrom(event.target.value)}
            className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base"
          />
        </label>
        <label className="block text-sm font-medium text-slate-800">
          Finalizado hasta
          <input
            type="date"
            value={dateTo}
            min={dateFrom || undefined}
            onChange={(event) => setDateTo(event.target.value)}
            className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base"
          />
        </label>
      </div>

      {errorMessage && (
        <p
          role="alert"
          className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {errorMessage}
        </p>
      )}
      {successMessage && (
        <p
          role="status"
          className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
        >
          {successMessage}
        </p>
      )}

      <section className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-4 py-4 sm:px-5">
          <h2 className="font-semibold text-slate-950">
            {visibleLoans.length} préstamo
            {visibleLoans.length === 1 ? '' : 's'}
          </h2>
        </div>
        {loading ? (
          <p className="px-5 py-8 text-sm text-slate-600">Cargando historial…</p>
        ) : visibleLoans.length === 0 ? (
          <p className="px-5 py-8 text-sm text-slate-600">
            No hay préstamos terminados que coincidan con los filtros.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {visibleLoans.map((loan) => {
              const borrower = borrowerById.get(loan.deudor_id)
              return (
                <li key={loan.id} className="px-4 py-4 sm:px-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <Link
                        to={`${isAdmin ? '/admin' : '/cartera'}/deudores/${loan.deudor_id}`}
                        className="font-semibold text-slate-950 underline decoration-slate-300 underline-offset-4 hover:text-emerald-800"
                      >
                        {borrower?.nombre ?? 'Deudor'}
                      </Link>
                      <p className="mt-1 text-sm text-slate-600">
                        Identificación: {borrower?.identificacion ?? 'No disponible'}
                      </p>
                      {isAdmin && (
                        <p className="mt-1 text-sm text-slate-500">
                          {walletById.get(loan.cartera_id) ?? 'Cartera'}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="w-fit rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-700">
                        {loan.notas?.includes('Liquidado por refinanciación')
                          ? 'Liquidado por refinanciación'
                          : 'Pagado en su totalidad'}
                      </span>
                      {isAdmin && (
                        <button
                          type="button"
                          disabled={deletingLoanId === loan.id}
                          onClick={() => void deleteLoan(loan)}
                          className="inline-flex min-h-10 items-center justify-center rounded-lg border border-red-300 px-3 text-center text-sm font-semibold text-red-800 hover:bg-red-50 disabled:cursor-wait disabled:opacity-60"
                        >
                          {deletingLoanId === loan.id
                            ? 'Eliminando…'
                            : 'Eliminar préstamo'}
                        </button>
                      )}
                    </div>
                  </div>
                  <dl className="mt-3 grid gap-3 rounded-xl bg-slate-50 p-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                    <div>
                      <dt className="text-xs font-medium uppercase text-slate-500">
                        Monto prestado
                      </dt>
                      <dd className="mt-1 font-semibold text-slate-900">
                        {formatAmount(loan.monto)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium uppercase text-slate-500">
                        Interés total
                      </dt>
                      <dd className="mt-1 text-slate-900">
                        {Math.round(loan.tasa_interes)}%
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium uppercase text-slate-500">
                        Cuotas finales
                      </dt>
                      <dd className="mt-1 text-slate-900">
                        {loan.numero_cuotas}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs font-medium uppercase text-slate-500">
                        Fecha final
                      </dt>
                      <dd className="mt-1 text-slate-900">
                        {formattedDate(loan.fecha_fin)}
                      </dd>
                    </div>
                  </dl>
                  <Link
                    to={`${isAdmin ? '/admin' : '/cartera'}/prestamos/${loan.id}`}
                    className="mt-4 inline-flex min-h-10 items-center justify-center rounded-lg border border-emerald-700 px-3 text-center text-sm font-semibold text-emerald-800 hover:bg-emerald-50"
                  >
                    Ver información y cronograma
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </main>
  )
}
