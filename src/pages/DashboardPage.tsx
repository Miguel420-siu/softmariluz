import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  LabelList,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useAuth } from '../auth/useAuth'
import { useWalletFilter } from '../hooks/useWalletFilter'
import {
  addCalendarDays,
  formatMoney,
  parseDecimalUnits,
} from '../lib/loan-calculation'
import type {
  PdfBorrowerRow,
  PdfInstallment,
  PdfLoan,
  PdfPayment,
} from '../lib/pdf-reports'
import { supabase } from '../lib/supabase'

interface Wallet {
  id: string
  nombre: string
}

interface DashboardLoan {
  id: string
  codigo: string
  cartera_id: string
  deudor_id: string
  monto: number
  tasa_interes: number
  estado: string
  fecha_inicio: string
  fecha_fin: string
  created_at: string
}

interface DashboardBorrower {
  id: string
  nombre: string
}

interface DashboardInstallment {
  id: string
  prestamo_id: string
  fecha_vencimiento: string
  capital: number
  intereses: number
  monto: number
  estado: string
}

interface DashboardPayment {
  id: string
  prestamo_id: string
  cuota_id: string | null
  monto: number
  tipo: string
  pagado_en: string
  pago_referenciado_id: string | null
}

interface MonthlyPoint {
  month: string
  label: string
  lent: number
  borrowers: number
  interest: number
}

interface ActiveBorrowerRow {
  id: string
  loanId: string
  name: string
  walletName: string
  lentCents: bigint
  paidCents: bigint
  interestPaidCents: bigint
  dueCents: bigint
  interestRates: number[]
  paidCount: number
  pendingCount: number
  totalCount: number
  firstInstallmentDate: string | null
  lastInstallmentDate: string | null
  nextDueDate: string | null
}

const paymentTimeZone = 'America/New_York'
const pageSize = 500

function decimalCents(value: number) {
  return parseDecimalUnits(String(Math.abs(value)), 2)
}

function localMonthKey(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: paymentTimeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(date)
  const year = parts.find((part) => part.type === 'year')?.value
  const month = parts.find((part) => part.type === 'month')?.value
  return `${year}-${month}`
}

function localDateKey(date: Date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: paymentTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}

function monthLabel(month: string) {
  const [year, value] = month.split('-').map(Number)
  return new Intl.DateTimeFormat('es-US', {
    month: 'short',
    year: '2-digit',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, value - 1, 1)))
}

function formattedDate(date: string | null) {
  if (!date) return 'Sin pagos pendientes'
  return new Intl.DateTimeFormat('es-US', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`))
}

function currency(value: bigint) {
  return formatMoney(value)
}

function dateRange(first: string | null, last: string | null) {
  if (!first || !last) return 'No disponible'
  return `${formattedDate(first)} – ${formattedDate(last)}`
}

async function loadAll<T>(fetchPage: (from: number, to: number) => Promise<T[]>) {
  const allRows: T[] = []
  for (let from = 0; ; from += pageSize) {
    const page = await fetchPage(from, from + pageSize - 1)
    allRows.push(...page)
    if (page.length < pageSize) return allRows
  }
}

function getMonths(count: number): MonthlyPoint[] {
  const now = new Date()
  const currentMonth = new Date(now.getFullYear(), now.getMonth(), 1)
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(
      currentMonth.getFullYear(),
      currentMonth.getMonth() - count + index + 1,
      1,
    )
    const month = localMonthKey(date)
    return { month, label: monthLabel(month), lent: 0, borrowers: 0, interest: 0 }
  })
}

function InterestTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean
  payload?: Array<{ name?: string; value?: unknown; color?: string }>
  label?: string
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm shadow-lg">
      <p className="mb-2 font-semibold text-slate-900">{label}</p>
      {payload.map((item) => (
        <p key={item.name} style={{ color: item.color }}>
            {item.name}:{' '}
            {item.name === 'Clientes activos'
              ? Number(item.value).toLocaleString('es-US')
              : new Intl.NumberFormat('en-US', {
                  style: 'currency',
                  currency: 'USD',
                  maximumFractionDigits: 0,
                }).format(Number(item.value))}
          </p>
      ))}
    </div>
  )
}

export function DashboardPage() {
  const { profile } = useAuth()
  const isAdmin = profile?.role === 'admin'
  const [wallets, setWallets] = useState<Wallet[]>([])
  const [walletFilter, setWalletFilter] = useWalletFilter(
    isAdmin,
    profile?.carteraId,
  )
  const selectedWalletFilter = wallets.some(
    (wallet) => wallet.id === walletFilter,
  )
    ? walletFilter
    : wallets[0]?.id ?? ''
  const [loans, setLoans] = useState<DashboardLoan[]>([])
  const [borrowers, setBorrowers] = useState<DashboardBorrower[]>([])
  const [installments, setInstallments] = useState<DashboardInstallment[]>([])
  const [payments, setPayments] = useState<DashboardPayment[]>([])
  const [loading, setLoading] = useState(true)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [generatingReport, setGeneratingReport] = useState<string | null>(null)
  const [reportError, setReportError] = useState<string | null>(null)

  async function generateWalletReport(
    status: 'active' | 'finished',
    wallet: Wallet,
  ) {
    const client = supabase
    if (!client) return
    const reportKey = `${status}:${wallet.id}`
    setGeneratingReport(reportKey)
    setReportError(null)
    try {
      const stateFilter =
        status === 'active' ? ['activo', 'atrasado'] : ['terminado']
      const reportLoans = await loadAll(async (from, to) => {
        const { data, error } = await client
          .from('prestamos')
          .select(
            'id, codigo, cartera_id, deudor_id, monto, tasa_interes, fecha_inicio, fecha_fin, estado',
          )
          .in('estado', stateFilter)
          .eq('cartera_id', wallet.id)
          .order('fecha_inicio')
          .range(from, to)
        if (error) throw error
        return (data ?? []) as PdfLoan[]
      })

      const borrowerIds = [...new Set(reportLoans.map((loan) => loan.deudor_id))]
      const reportBorrowers: PdfBorrowerRow[] = []
      for (let index = 0; index < borrowerIds.length; index += 100) {
        const idBatch = borrowerIds.slice(index, index + 100)
        const { data, error } = await client
          .from('deudores')
          .select(
            'id, cartera_id, nombre, identificacion, telefono, direccion, apartamento, ciudad, estado, codigo_postal',
          )
          .in('id', idBatch)
        if (error) throw error
        reportBorrowers.push(...((data ?? []) as PdfBorrowerRow[]))
      }

      const reportInstallments: PdfInstallment[] = []
      const reportPayments: PdfPayment[] = []
      const loanIds = reportLoans.map((loan) => loan.id)
      for (let index = 0; index < loanIds.length; index += 100) {
        const loanBatch = loanIds.slice(index, index + 100)
        const [installmentBatch, paymentBatch] = await Promise.all([
          loadAll(async (from, to) => {
            const { data, error } = await client
              .from('cuotas')
              .select(
                'prestamo_id, numero, fecha_vencimiento, capital, intereses, monto, estado',
              )
              .in('prestamo_id', loanBatch)
              .order('numero')
              .range(from, to)
            if (error) throw error
            return (data ?? []) as PdfInstallment[]
          }),
          loadAll(async (from, to) => {
            const { data, error } = await client
              .from('pagos')
              .select('prestamo_id, monto, pagado_en')
              .in('prestamo_id', loanBatch)
              .order('pagado_en')
              .range(from, to)
            if (error) throw error
            return (data ?? []) as PdfPayment[]
          }),
        ])
        reportInstallments.push(...installmentBatch)
        reportPayments.push(...paymentBatch)
      }

      const { generateConsolidatedLoansPdf } = await import('../lib/pdf-reports')
      generateConsolidatedLoansPdf(
        status,
        reportLoans,
        reportBorrowers,
        reportInstallments,
        reportPayments,
        wallet.nombre,
      )
    } catch (error) {
      console.error('No se pudo generar el consolidado de préstamos.', error)
      setReportError(
        'No fue posible generar el PDF consolidado. Revisa la conexión y vuelve a intentarlo.',
      )
    } finally {
      setGeneratingReport(null)
    }
  }

  const loadData = useCallback(async () => {
    const client = supabase
    if (!client) {
      setErrorMessage('La conexión con Supabase no está configurada.')
      setLoading(false)
      return
    }

    setLoading(true)
    setErrorMessage(null)
    try {
      let permittedWallets: Wallet[] = []
      if (isAdmin) {
        const { data, error } = await client
          .from('carteras')
          .select('id, nombre')
          .order('nombre')
        if (error) throw error
        permittedWallets = data ?? []
      } else if (profile?.carteraId) {
        const { data, error } = await client
          .from('carteras')
          .select('id, nombre')
          .eq('id', profile.carteraId)
          .maybeSingle()
        if (error) throw error
        permittedWallets = data ? [data] : []
      }
      setWallets(permittedWallets)
      const [loanRows, borrowerRows, installmentRows, paymentRows] =
        await Promise.all([
          loadAll(async (from, to) => {
            let query = client
              .from('prestamos')
              .select(
                'id, codigo, cartera_id, deudor_id, monto, tasa_interes, estado, fecha_inicio, fecha_fin, created_at',
              )
              .order('created_at', { ascending: false })
              .range(from, to)
            if (!isAdmin && profile?.carteraId) {
              query = query.eq('cartera_id', profile.carteraId)
            }
            const { data, error } = await query
            if (error) throw error
            return data ?? []
          }),
          loadAll(async (from, to) => {
            let query = client
              .from('deudores')
              .select('id, nombre')
              .order('nombre')
              .range(from, to)
            if (!isAdmin && profile?.carteraId) {
              query = query.eq('cartera_id', profile.carteraId)
            }
            const { data, error } = await query
            if (error) throw error
            return data ?? []
          }),
          loadAll(async (from, to) => {
            let query = client
              .from('cuotas')
              .select('id, prestamo_id, fecha_vencimiento, capital, intereses, monto, estado')
              .order('fecha_vencimiento')
              .range(from, to)
            if (!isAdmin && profile?.carteraId) {
              query = query.eq('cartera_id', profile.carteraId)
            }
            const { data, error } = await query
            if (error) throw error
            return data ?? []
          }),
          loadAll(async (from, to) => {
            let query = client
              .from('pagos')
              .select(
                'id, prestamo_id, cuota_id, monto, tipo, pagado_en, pago_referenciado_id',
              )
              .order('pagado_en')
              .range(from, to)
            if (!isAdmin && profile?.carteraId) {
              query = query.eq('cartera_id', profile.carteraId)
            }
            const { data, error } = await query
            if (error) throw error
            return data ?? []
          }),
        ])
      setLoans(loanRows as DashboardLoan[])
      setBorrowers(borrowerRows as DashboardBorrower[])
      setInstallments(installmentRows as DashboardInstallment[])
      setPayments(paymentRows as DashboardPayment[])
    } catch (error) {
      console.error('No se pudo cargar el dashboard.', error)
      setErrorMessage(
        'No fue posible cargar el dashboard. Revisa la conexión y las políticas RLS.',
      )
    } finally {
      setLoading(false)
    }
  }, [isAdmin, profile])

  useEffect(() => {
    queueMicrotask(() => void loadData())
  }, [loadData])

  useEffect(() => {
    if (
      isAdmin &&
      wallets.length > 0 &&
      !wallets.some((wallet) => wallet.id === walletFilter)
    ) {
      setWalletFilter(wallets[0]!.id)
    }
  }, [isAdmin, setWalletFilter, walletFilter, wallets])

  const visibleData = useMemo(() => {
    const walletIds = new Set(
      wallets
        .filter((wallet) => wallet.id === selectedWalletFilter)
        .map((wallet) => wallet.id),
    )
    const selectedLoans = loans.filter((loan) => walletIds.has(loan.cartera_id))
    const loanIds = new Set(selectedLoans.map((loan) => loan.id))
    return {
      loans: selectedLoans,
      installments: installments.filter((row) => loanIds.has(row.prestamo_id)),
      payments: payments.filter((row) => loanIds.has(row.prestamo_id)),
    }
  }, [installments, loans, payments, selectedWalletFilter, wallets])

  const report = useMemo(() => {
    const months = getMonths(12)
    const monthIndex = new Map(months.map((point, index) => [point.month, index]))
    const activeLoans = visibleData.loans.filter(
      (loan) => loan.estado !== 'terminado',
    )
    const activeLoanIds = new Set(activeLoans.map((loan) => loan.id))
    const borrowerById = new Map(borrowers.map((borrower) => [borrower.id, borrower]))
    const walletById = new Map(wallets.map((wallet) => [wallet.id, wallet.nombre])    )
    const paymentsByLoan = new Map<string, DashboardPayment[]>()
    const installmentsById = new Map(
      visibleData.installments.map((installment) => [installment.id, installment]),
    )
    const installmentsByLoan = new Map<string, DashboardInstallment[]>()

    for (const payment of visibleData.payments) {
      const items = paymentsByLoan.get(payment.prestamo_id) ?? []
      items.push(payment)
      paymentsByLoan.set(payment.prestamo_id, items)
    }
    for (const installment of visibleData.installments) {
      const items = installmentsByLoan.get(installment.prestamo_id) ?? []
      items.push(installment)
      installmentsByLoan.set(installment.prestamo_id, items)
    }

    for (const loan of visibleData.loans) {
      const key = localMonthKey(new Date(loan.created_at))
      const index = monthIndex.get(key)
      if (index === undefined) continue
      const point = months[index]
      if (!point) continue
      const amount = decimalCents(loan.monto)
      if (amount !== null) point.lent += Number(amount) / 100
    }
    for (const point of months) {
      const [year, month] = point.month.split('-').map(Number)
      const monthEnd = new Date(Date.UTC(year, month, 0))
        .toISOString()
        .slice(0, 10)
      const activeBorrowerIds = new Set(
        visibleData.loans
          .filter(
            (loan) =>
              loan.fecha_inicio <= monthEnd &&
              (loan.estado !== 'terminado' || loan.fecha_fin >= monthEnd),
          )
          .map((loan) => loan.deudor_id),
      )
      point.borrowers = activeBorrowerIds.size
    }

    function interestComponent(payment: DashboardPayment): bigint {
      if (payment.tipo === 'solo_intereses') {
        return decimalCents(payment.monto) ?? 0n
      }
      if (payment.tipo === 'cuota_completa' && payment.cuota_id) {
        return decimalCents(
          installmentsById.get(payment.cuota_id)?.intereses ?? 0,
        ) ?? 0n
      }
      return 0n
    }

    const reversedPaymentIds = new Set(
      visibleData.payments
        .filter(
          (payment) =>
            payment.tipo === 'ajuste' &&
            payment.pago_referenciado_id !== null,
        )
        .map((payment) => payment.pago_referenciado_id),
    )
    let totalInterestCents = 0n
    let currentMonthInterestCents = 0n
    const currentMonth = localMonthKey(new Date())
    for (const payment of visibleData.payments) {
      if (payment.tipo === 'ajuste' || reversedPaymentIds.has(payment.id)) {
        continue
      }

      const month = localMonthKey(new Date(payment.pagado_en))
      const index = monthIndex.get(month)
      const interestCents = interestComponent(payment)
      totalInterestCents += interestCents
      if (month === currentMonth) currentMonthInterestCents += interestCents
      if (index !== undefined && months[index]) {
        months[index]!.interest += Number(interestCents) / 100
      }
    }

    let activeOutstandingPrincipal = 0n
    const activeBorrowerIds = new Set<string>()
    const activeRows = new Map<string, ActiveBorrowerRow>()
    for (const loan of activeLoans) {
      const borrower = borrowerById.get(loan.deudor_id)
      if (!borrower) continue
      activeBorrowerIds.add(borrower.id)
      const key = borrower.id
      const row = activeRows.get(key) ?? {
        id: borrower.id,
        loanId: loan.id,
        name: borrower.nombre,
        walletName: walletById.get(loan.cartera_id) ?? 'Cartera',
        lentCents: 0n,
        paidCents: 0n,
        interestPaidCents: 0n,
        dueCents: 0n,
        interestRates: [],
        paidCount: 0,
        pendingCount: 0,
        totalCount: 0,
        firstInstallmentDate: null,
        lastInstallmentDate: null,
        nextDueDate: null,
      }
      const lent = decimalCents(loan.monto)
      if (lent !== null) row.lentCents += lent
      if (!row.interestRates.includes(loan.tasa_interes)) {
        row.interestRates.push(loan.tasa_interes)
      }
      for (const payment of paymentsByLoan.get(loan.id) ?? []) {
        const cents = decimalCents(payment.monto)
        if (cents !== null) {
          row.paidCents += payment.monto < 0 ? -cents : cents
        }
        if (
          payment.tipo !== 'ajuste' &&
          !reversedPaymentIds.has(payment.id)
        ) {
          row.interestPaidCents += interestComponent(payment)
        }
      }
      const loanInstallments = installmentsByLoan.get(loan.id) ?? []
      row.totalCount += loanInstallments.length
      row.paidCount += loanInstallments.filter(
        (installment) => installment.estado === 'pagada',
      ).length
      for (const installment of loanInstallments) {
        if (
          !row.firstInstallmentDate ||
          installment.fecha_vencimiento < row.firstInstallmentDate
        ) {
          row.firstInstallmentDate = installment.fecha_vencimiento
        }
        if (
          !row.lastInstallmentDate ||
          installment.fecha_vencimiento > row.lastInstallmentDate
        ) {
          row.lastInstallmentDate = installment.fecha_vencimiento
        }
        if (installment.estado !== 'pendiente') continue
        const principalCents = decimalCents(installment.capital)
        const amountCents = decimalCents(installment.monto)
        if (principalCents !== null) activeOutstandingPrincipal += principalCents
        if (amountCents !== null) row.dueCents += amountCents
        row.pendingCount += 1
        if (
          !row.nextDueDate ||
          installment.fecha_vencimiento < row.nextDueDate
        ) {
          row.loanId = loan.id
          row.nextDueDate = installment.fecha_vencimiento
        }
      }
      activeRows.set(key, row)
    }

    const overdueCount = visibleData.installments.filter(
      (installment) =>
        installment.estado === 'pendiente' &&
        installment.fecha_vencimiento <
          addCalendarDays(localDateKey(new Date()), -1) &&
        activeLoanIds.has(installment.prestamo_id),
    ).length

    return {
      months,
      activeBorrowers: activeBorrowerIds.size,
      activeOutstandingPrincipal,
      totalInterestCents,
      currentMonthInterestCents,
      overdueCount,
      activeRows: [...activeRows.values()].sort(
        (left, right) => left.name.localeCompare(right.name),
      ),
    }
  }, [borrowers, visibleData, wallets])

  const currencyTick = (value: number) =>
    `$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`

  return (
    <main className="mx-auto max-w-7xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-emerald-700">
            {isAdmin ? 'Resumen de cartera' : 'Resumen de tu cartera'}
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
            Dashboard
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            Préstamos, pagos y fechas de vencimiento a partir del cronograma de pagos y el historial financiero.
          </p>
        </div>
      </div>

      {reportError && (
        <p
          role="alert"
          className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {reportError}
        </p>
      )}

      {wallets.length > 0 && (
        <section
          aria-labelledby="wallet-reports-heading"
          className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6"
        >
          <div className="mb-4">
            <h2
              id="wallet-reports-heading"
              className="text-lg font-semibold text-slate-900"
            >
              Reportes PDF
            </h2>
            <p className="mt-1 text-sm text-slate-600">
              {isAdmin
                ? 'Elige una cartera y descarga el consolidado de préstamos activos o terminados.'
                : 'Descarga los consolidados de préstamos activos o terminados de tu cartera.'}
            </p>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {wallets.map((wallet) => {
              const activeReportKey = `active:${wallet.id}`
              const finishedReportKey = `finished:${wallet.id}`
              return (
                <article
                  key={wallet.id}
                  className="rounded-xl border border-slate-200 bg-slate-50 p-4"
                >
                  <h3 className="mb-3 font-semibold text-slate-900">
                    {wallet.nombre}
                  </h3>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => void generateWalletReport('active', wallet)}
                      disabled={generatingReport !== null}
                      className="inline-flex min-h-11 items-center justify-center rounded-lg bg-emerald-700 px-4 text-center text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-wait disabled:opacity-60"
                    >
                      {generatingReport === activeReportKey
                        ? 'Generando…'
                        : 'PDF de préstamos activos'}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void generateWalletReport('finished', wallet)
                      }
                      disabled={generatingReport !== null}
                      className="inline-flex min-h-11 items-center justify-center rounded-lg border border-emerald-700 bg-white px-4 text-center text-sm font-semibold text-emerald-800 hover:bg-emerald-50 disabled:cursor-wait disabled:opacity-60"
                    >
                      {generatingReport === finishedReportKey
                        ? 'Generando…'
                        : 'PDF de préstamos terminados'}
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
        </section>
      )}

      {isAdmin && wallets.length > 0 && (
        <label className="mt-6 block max-w-sm text-sm font-medium text-slate-800">
          Filtrar por cartera
          <select
            value={selectedWalletFilter}
            onChange={(event) => setWalletFilter(event.target.value)}
            className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base"
          >
            {wallets.map((wallet) => (
              <option key={wallet.id} value={wallet.id}>
                {wallet.nombre}
              </option>
            ))}
          </select>
        </label>
      )}

      {errorMessage && (
        <p
          role="alert"
          className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {errorMessage}
        </p>
      )}

      {loading ? (
        <p className="mt-6 text-sm text-slate-600">Cargando resumen…</p>
      ) : (
        <>
          <section className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            {[
              {
                label: 'Clientes con prestamos activos',
                value: report.activeBorrowers.toLocaleString('es-US'),
                hint: 'Con préstamos por terminar',
              },
              {
                label: 'Capital pendiente de ser pagado',
                value: currency(report.activeOutstandingPrincipal),
                hint: 'Abono a capital de cuotas pendientes',
              },
              {
                label: 'Interés total pagado a la fecha',
                value: currency(report.totalInterestCents),
                hint: 'Total neto de modificaciones y reversos',
              },
              {
                label: 'Intereses cobrados este mes',
                value: currency(report.currentMonthInterestCents),
                hint: 'Neto de reversos',
              },
              {
                label: 'Cuotas vencidas',
                value: report.overdueCount.toLocaleString('es-US'),
                hint: 'Más de un día desde el vencimiento',
              },
            ].map((card) => (
              <article
                key={card.label}
                className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
              >
                <p className="text-sm font-medium text-slate-600">{card.label}</p>
                <p className="mt-3 text-2xl font-semibold tracking-tight text-slate-950">
                  {card.value}
                </p>
                <p className="mt-2 text-xs leading-5 text-slate-500">{card.hint}</p>
              </article>
            ))}
          </section>

          <section className="mt-6 grid gap-5 xl:grid-cols-2">
            <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
              <h2 className="font-semibold text-slate-950">
                Dinero prestado y clientes por mes
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Desembolsos y clientes con préstamos activos al cierre de cada mes · 12 meses
              </p>
              <div className="mt-5 h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={report.months} margin={{ top: 8, right: 4, left: 0, bottom: 4 }}>
                    <defs>
                      <linearGradient id="monthly-loan-gradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#10b981" stopOpacity={0.95} />
                        <stop offset="100%" stopColor="#047857" stopOpacity={0.75} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#e2e8f0" strokeDasharray="4 4" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#64748b' }} axisLine={false} tickLine={false} />
                    <YAxis
                      yAxisId="money"
                      tickFormatter={currencyTick}
                      tick={{ fontSize: 11, fill: '#64748b' }}
                      width={64}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      yAxisId="borrowers"
                      orientation="right"
                      allowDecimals={false}
                      tick={{ fontSize: 11, fill: '#64748b' }}
                      width={36}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip content={<InterestTooltip />} />
                    <Legend />
                    <Bar
                      yAxisId="money"
                      dataKey="lent"
                      name="Dinero prestado"
                      fill="url(#monthly-loan-gradient)"
                      radius={[6, 6, 0, 0]}
                    />
                    <Line
                      yAxisId="borrowers"
                      dataKey="borrowers"
                      name="Clientes activos"
                      stroke="#f59e0b"
                      strokeWidth={3}
                      type="monotone"
                      dot={{ r: 3, fill: '#f59e0b', strokeWidth: 0 }}
                      activeDot={{ r: 6, stroke: '#fff', strokeWidth: 2 }}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </article>

            <article className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
              <h2 className="font-semibold text-slate-950">
                Ganancias por intereses
              </h2>
              <p className="mt-1 text-sm text-slate-500">
                Intereses pagados · 12 meses
              </p>
              <div className="mt-5 h-72 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart data={report.months} margin={{ top: 24, right: 20, left: 0, bottom: 4 }}>
                    <defs>
                      <linearGradient id="monthly-interest-gradient" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#14b8a6" stopOpacity={0.95} />
                        <stop offset="100%" stopColor="#0f766e" stopOpacity={0.75} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#e2e8f0" strokeDasharray="4 4" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#64748b' }} axisLine={false} tickLine={false} />
                    <YAxis
                      tickFormatter={currencyTick}
                      domain={[0, (max: number) => (max === 0 ? 1 : max * 1.15)]}
                      tick={{ fontSize: 11, fill: '#64748b' }}
                      width={64}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip content={<InterestTooltip />} />
                    <Legend />
                    <Bar
                      dataKey="interest"
                      name="Interés neto pagado"
                      fill="url(#monthly-interest-gradient)"
                      radius={[6, 6, 0, 0]}
                    >
                      <LabelList
                        dataKey="interest"
                        position="top"
                        fill="#0f172a"
                        fontSize={10}
                        offset={8}
                        formatter={(value) =>
                          typeof value === 'number' && value > 0
                            ? currencyTick(value)
                            : ''
                        }
                      />
                    </Bar>
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </article>
          </section>

          <section className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-4 py-5 text-center sm:px-5">
              <h2 className="text-xl font-semibold text-slate-950 sm:text-2xl">
                Listado de clientes activos ({report.activeRows.length})
              </h2>
              <p className="mt-2 text-sm text-slate-500">
                Selecciona un cliente para consultar su resumen y acceder al préstamo.
              </p>
            </div>
            {report.activeRows.length === 0 ? (
              <p className="px-5 py-8 text-sm text-slate-600">
                No hay clientes con préstamos pendientes en esta cartera.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {report.activeRows.map((row) => (
                  <li key={row.id} className="px-3 py-3 sm:px-5 sm:py-4">
                    <details className="group overflow-hidden rounded-xl border border-slate-200 bg-white">
                      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-4 marker:hidden hover:bg-slate-50 [&::-webkit-details-marker]:hidden sm:px-5">
                        <div>
                          <span className="block text-lg font-semibold text-slate-950 sm:text-xl">
                          {row.name}
                          </span>
                          {isAdmin && (
                            <span className="mt-1 block text-sm text-slate-500">
                              {row.walletName}
                            </span>
                          )}
                        </div>
                        <svg
                          aria-hidden="true"
                          className="h-5 w-5 shrink-0 text-slate-500 transition-transform group-open:rotate-180"
                          viewBox="0 0 20 20"
                          fill="currentColor"
                        >
                          <path
                            fillRule="evenodd"
                            d="M5.22 7.47a.75.75 0 0 1 1.06 0L10 11.19l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 8.53a.75.75 0 0 1 0-1.06Z"
                            clipRule="evenodd"
                          />
                        </svg>
                      </summary>
                      <div className="border-t border-slate-200 p-3 sm:p-5">
                        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                          <div className="rounded-lg bg-slate-50 p-3">
                            <dt className="text-xs font-medium uppercase text-slate-500">
                              Monto prestado
                            </dt>
                            <dd className="mt-1 font-semibold text-slate-900">
                              {currency(row.lentCents)}
                            </dd>
                          </div>
                          <div className="rounded-lg bg-slate-50 p-3">
                            <dt className="text-xs font-medium uppercase text-slate-500">
                              Pagado neto a la fecha
                            </dt>
                            <dd className="mt-1 font-semibold text-slate-900">
                              {currency(row.paidCents)}
                            </dd>
                          </div>
                          <div className="rounded-lg bg-slate-50 p-3">
                            <dt className="text-xs font-medium uppercase text-slate-500">
                              % de interés
                            </dt>
                            <dd className="mt-1 font-semibold text-slate-900">
                              {row.interestRates
                                .sort((left, right) => left - right)
                                .map(
                                  (rate) =>
                                    `${new Intl.NumberFormat('es-US', {
                                      maximumFractionDigits: 2,
                                    }).format(rate)}%`,
                                )
                                .join(' / ')}
                            </dd>
                          </div>
                          <div className="rounded-lg bg-slate-50 p-3">
                            <dt className="text-xs font-medium uppercase text-slate-500">
                              Interés pagado a la fecha
                            </dt>
                            <dd className="mt-1 font-semibold text-slate-900">
                              {currency(row.interestPaidCents)}
                            </dd>
                          </div>
                          <div className="rounded-lg bg-slate-50 p-3">
                            <dt className="text-xs font-medium uppercase text-slate-500">
                              Saldo pendiente
                            </dt>
                            <dd className="mt-1 font-semibold text-slate-900">
                              {currency(row.dueCents)}
                            </dd>
                          </div>
                          <div className="rounded-lg bg-slate-50 p-3">
                            <dt className="text-xs font-medium uppercase text-slate-500">
                              Cuotas pagadas a la fecha
                            </dt>
                            <dd className="mt-1 font-semibold text-slate-900">
                              {row.paidCount}
                            </dd>
                          </div>
                          <div className="rounded-lg bg-slate-50 p-3">
                            <dt className="text-xs font-medium uppercase text-slate-500">
                              Cuotas pendientes
                            </dt>
                            <dd className="mt-1 font-semibold text-slate-900">
                              {row.pendingCount}
                            </dd>
                          </div>
                          <div className="rounded-lg bg-slate-50 p-3">
                            <dt className="text-xs font-medium uppercase text-slate-500">
                              Total de cuotas
                            </dt>
                            <dd className="mt-1 font-semibold text-slate-900">
                              {row.totalCount}
                            </dd>
                          </div>
                          <div className="rounded-lg bg-slate-50 p-3 sm:col-span-2">
                            <dt className="text-xs font-medium uppercase text-slate-500">
                              Vigencia (primera a última cuota)
                            </dt>
                            <dd className="mt-1 font-semibold text-slate-900">
                              {dateRange(
                                row.firstInstallmentDate,
                                row.lastInstallmentDate,
                              )}
                            </dd>
                          </div>
                          <div className="rounded-lg bg-slate-50 p-3 sm:col-span-2">
                            <dt className="text-xs font-medium uppercase text-slate-500">
                              Próximo vencimiento
                            </dt>
                            <dd className="mt-1 font-semibold text-slate-900">
                              {formattedDate(row.nextDueDate)}
                            </dd>
                          </div>
                        </dl>
                        <div className="mt-4 flex flex-wrap gap-2">
                          <Link
                            to={`${isAdmin ? '/admin' : '/cartera'}/deudores/${row.id}`}
                            className="inline-flex min-h-10 items-center justify-center rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                          >
                            Ver perfil del cliente
                          </Link>
                          <Link
                            to={`${isAdmin ? '/admin' : '/cartera'}/prestamos/${row.loanId}`}
                            className="inline-flex min-h-10 items-center justify-center rounded-lg bg-emerald-700 px-3 text-sm font-semibold text-white hover:bg-emerald-800"
                          >
                            Ver préstamo
                          </Link>
                        </div>
                      </div>
                    </details>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  )
}
