import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { useWalletFilter } from '../hooks/useWalletFilter'
import {
  addCalendarDays,
  calculateLoanFromInstallment,
  centsToDatabaseNumber,
  formatMoney,
  parseDecimalUnits,
  parseSignedDecimalUnits,
  rateUnitsToDatabaseNumber,
} from '../lib/loan-calculation'
import { formatUsPhone, phoneDigits } from '../lib/us-phone'
import {
  createClientLoanPdfBlob,
  generateClientLoanPdf,
  type PdfBorrower,
} from '../lib/pdf-reports'
import { supabase } from '../lib/supabase'

interface Wallet {
  id: string
  clave: string
  nombre: string
}

interface BorrowerOption {
  id: string
  cartera_id: string
  nombre: string
  identificacion: string | null
  telefono: string | null
}

interface RefinanceCandidate {
  id: string
  codigo: string
  pendingCount: number
  pendingCents: bigint
}

type CashAvailability =
  | { status: 'not_applicable' }
  | { status: 'loading' }
  | { status: 'unconfigured' }
  | { status: 'error' }
  | { status: 'ready'; balanceCents: bigint }

interface LoanDetailBorrower extends PdfBorrower {
  email: string | null
}

interface LoanRecord {
  id: string
  codigo: string
  cartera_id: string
  deudor_id: string
  monto: number
  tasa_interes: number
  numero_cuotas: number
  metodo_calculo: string
  dia_pago_semana: number
  fecha_inicio: string
  fecha_fin: string
  notas: string | null
  estado: string
}

interface InstallmentRecord {
  id: string
  numero: number
  fecha_vencimiento: string
  capital: number
  intereses: number
  monto: number
  estado: string
}

interface PaymentRecord {
  id: string
  cuota_id: string | null
  monto: number
  tipo: string
  pagado_en: string
  pago_referenciado_id: string | null
  notas: string | null
}

type PaymentAction =
  | {
      kind: 'register'
      loanId: string
      installmentId: string
      type: 'cuota_completa' | 'solo_intereses'
    }
  | {
      kind: 'reverse'
      loanId: string
      paymentId: string
    }

const paymentTimeZone = 'America/New_York'

function localDateValue() {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`
}

async function blobToBase64(blob: Blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}

function formattedDate(date: string) {
  return new Intl.DateTimeFormat('es-US', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`))
}

function formattedTimestamp(timestamp: string) {
  return new Intl.DateTimeFormat('es-US', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: paymentTimeZone,
  }).format(new Date(timestamp))
}

const stateLabels: Record<string, string> = {
  activo: 'Activo',
  atrasado: 'Atrasado',
  terminado: 'Terminado',
}

function formatNumericAmount(value: number) {
  const cents = parseDecimalUnits(String(value), 2)
  return cents === null ? 'Monto inválido' : formatMoney(cents)
}

function formatInterestRate(value: number) {
  return `${new Intl.NumberFormat('es-US', {
    maximumFractionDigits: 2,
  }).format(value)}%`
}

function decimalStringToDatabaseNumber(value: string) {
  const cents = parseDecimalUnits(value, 2)
  if (cents === null) {
    throw new Error('El cronograma generó un importe no válido.')
  }
  return centsToDatabaseNumber(cents)
}

function getErrorMessage(error: unknown) {
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message
  }
  return 'Error desconocido de Supabase.'
}

function formatSignedNumericAmount(value: number) {
  const isNegative = value < 0
  const cents = parseDecimalUnits(String(Math.abs(value)), 2)
  if (cents === null) return 'Monto inválido'
  return formatMoney(isNegative ? -cents : cents)
}

function paymentTypeLabel(type: string) {
  if (type === 'cuota_completa') return 'Cuota completa'
  if (type === 'solo_intereses') return 'Solo intereses'
  return 'Ajuste / modificación'
}

function signedAmountCents(value: number) {
  const negative = value < 0
  const cents = parseDecimalUnits(String(Math.abs(value)), 2)
  return cents === null ? null : negative ? -cents : cents
}

function sumPaymentCents(payments: PaymentRecord[]) {
  return payments.reduce<bigint | null>((total, payment) => {
    if (total === null) return null
    const cents = signedAmountCents(payment.monto)
    return cents === null ? null : total + cents
  }, 0n)
}

function sumPendingCents(installments: InstallmentRecord[]) {
  return installments
    .filter((installment) => installment.estado === 'pendiente')
    .reduce<bigint | null>((total, installment) => {
      if (total === null) return null
      const cents = parseDecimalUnits(String(installment.monto), 2)
      return cents === null ? null : total + cents
    }, 0n)
}

function currentPaymentZoneDate() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: paymentTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const part = (type: string) => parts.find((value) => value.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

export function LoansPage() {
  const { profile } = useAuth()
  const canManage = profile?.role === 'admin'
  const { prestamoId } = useParams()
  const isLoanDetail = Boolean(prestamoId)
  const [searchParams] = useSearchParams()
  const requestedBorrowerId = searchParams.get('deudor') ?? ''
  const [wallets, setWallets] = useState<Wallet[]>([])
  const [borrowers, setBorrowers] = useState<BorrowerOption[]>([])
  const [loans, setLoans] = useState<LoanRecord[]>([])
  const preselectedBorrowerId = useRef<string | null>(null)
  const walletManuallySelected = useRef(false)
  const loanFormRef = useRef<HTMLElement>(null)
  const paymentFormRefs = useRef(new Map<string, HTMLFormElement>())
  const previousPaymentFormKey = useRef<string | null>(null)
  const [detailBorrower, setDetailBorrower] =
    useState<LoanDetailBorrower | null>(null)
  const [filterWalletId, setFilterWalletId] = useWalletFilter(
    canManage,
    profile?.carteraId,
  )
  const [formWalletId, setFormWalletId] = useState('')
  const [cashAvailability, setCashAvailability] =
    useState<CashAvailability>({ status: 'not_applicable' })
  const [borrowerId, setBorrowerId] = useState(requestedBorrowerId)
  const [borrowerSearch, setBorrowerSearch] = useState('')
  const [activeRefinanceLoans, setActiveRefinanceLoans] = useState<
    RefinanceCandidate[]
  >([])
  const [refinanceLoanId, setRefinanceLoanId] = useState('')
  const [refinanceLoading, setRefinanceLoading] = useState(false)
  const [principal, setPrincipal] = useState('')
  const [installmentAmount, setInstallmentAmount] = useState('')
  const [installmentCount, setInstallmentCount] = useState('10')
  const [startDate, setStartDate] = useState(localDateValue)
  const [firstInstallmentDate, setFirstInstallmentDate] = useState(() =>
    addCalendarDays(localDateValue(), 7),
  )
  const [notes, setNotes] = useState('')
  const [formOpen, setFormOpen] = useState(Boolean(requestedBorrowerId))
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [installmentsByLoan, setInstallmentsByLoan] = useState<
    Record<string, InstallmentRecord[]>
  >({})
  const [paymentsByLoan, setPaymentsByLoan] = useState<
    Record<string, PaymentRecord[]>
  >({})
  const [paymentAction, setPaymentAction] = useState<PaymentAction | null>(null)
  const [paymentNotes, setPaymentNotes] = useState('')
  const [zellePaymentConfirmed, setZellePaymentConfirmed] = useState(false)
  const [paymentSubmitting, setPaymentSubmitting] = useState(false)
  const [paymentError, setPaymentError] = useState<string | null>(null)
  const [paymentSuccess, setPaymentSuccess] = useState<string | null>(null)
  const [paymentEmailError, setPaymentEmailError] = useState<string | null>(
    null,
  )
  const [deletingLoanId, setDeletingLoanId] = useState<string | null>(null)
  const [cleaningOrphanLoans, setCleaningOrphanLoans] = useState(false)
  const [generatingClientPdf, setGeneratingClientPdf] = useState(false)
  const [pdfError, setPdfError] = useState<string | null>(null)
  const [sendingStatementEmail, setSendingStatementEmail] = useState(false)
  const [statementEmailError, setStatementEmailError] = useState<string | null>(
    null,
  )
  const [statementEmailSuccess, setStatementEmailSuccess] = useState<
    string | null
  >(null)
  const [reloadCounter, setReloadCounter] = useState(0)

  useEffect(() => {
    if (!formOpen) return
    const frame = window.requestAnimationFrame(() => {
      loanFormRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [formOpen])

  useEffect(() => {
    const action = paymentAction
    if (!action) {
      previousPaymentFormKey.current = null
      return
    }

    const formKey = `${action.loanId}:${action.kind === 'register' ? action.installmentId : action.paymentId}`
    if (previousPaymentFormKey.current === formKey) return
    previousPaymentFormKey.current = formKey

    const frame = window.requestAnimationFrame(() => {
      const form = paymentFormRefs.current.get(formKey)
      if (!form) return
      form.scrollIntoView({ behavior: 'smooth', block: 'center' })
      form.focus({ preventScroll: true })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [paymentAction])

  const schedule = useMemo(() => {
    const count = Number(installmentCount)
    if (
      !Number.isInteger(count) ||
      count > 520 ||
      (startDate && firstInstallmentDate < startDate)
    ) {
      return null
    }
    return calculateLoanFromInstallment(
      principal,
      installmentAmount,
      count,
      firstInstallmentDate,
    )
  }, [
    firstInstallmentDate,
    installmentCount,
    installmentAmount,
    principal,
    startDate,
  ])
  const scheduleValidationMessage = useMemo(() => {
    const principalInput = principal.trim()
    const installmentInput = installmentAmount.trim()
    const principalDollars = parseDecimalUnits(principalInput, 0)
    const installmentDollars = parseDecimalUnits(installmentInput, 0)

    if (principalInput && principalDollars === null) {
      return 'El monto prestado debe ingresarse en dólares enteros.'
    }
    if (installmentInput && installmentDollars === null) {
      return 'El valor de la cuota debe ingresarse en dólares enteros.'
    }
    if (
      startDate &&
      firstInstallmentDate &&
      firstInstallmentDate < startDate
    ) {
      return 'La fecha de la primera cuota no puede ser anterior a la fecha del préstamo.'
    }
    const count = Number(installmentCount)
    if (
      installmentCount &&
      (!Number.isInteger(count) || count < 1 || count > 520)
    ) {
      return 'El número de cuotas debe estar entre 1 y 520.'
    }
    if (
      principalDollars !== null &&
      principalDollars > 0n &&
      installmentDollars !== null &&
      installmentDollars <= 0n
    ) {
      return 'El valor de cada cuota debe ser al menos $1.'
    }
    if (
      principalDollars !== null &&
      principalDollars > 0n &&
      installmentDollars !== null &&
      installmentDollars > 0n &&
      Number.isInteger(count) &&
      count > 0 &&
      installmentDollars * BigInt(count) < principalDollars
    ) {
      return 'El valor de la cuota no alcanza a pagar el total del préstamo, recalcule por favor.'
    }
    if (
      installmentDollars !== null &&
      installmentDollars > 0n &&
      Number.isInteger(count) &&
      count > 0 &&
      installmentDollars * BigInt(count) > 9_999_999_999n
    ) {
      return 'El total a cobrar supera el máximo permitido.'
    }
    if (
      principalDollars !== null &&
      principalDollars > 0n &&
      installmentDollars !== null &&
      installmentDollars > 0n &&
      Number.isInteger(count) &&
      count > 0 &&
      installmentDollars * BigInt(count) === principalDollars
    ) {
      return 'El total de las cuotas es igual al capital; este préstamo tendrá $0 de interés.'
    }

    return null
  }, [
    firstInstallmentDate,
    installmentCount,
    installmentAmount,
    principal,
    startDate,
  ])

  useEffect(() => {
    let cancelled = false

    async function loadActiveLoansForBorrower() {
      if (!supabase || !formOpen || !canManage || !formWalletId || !borrowerId) {
        setActiveRefinanceLoans([])
        setRefinanceLoanId('')
        setRefinanceLoading(false)
        return
      }

      setRefinanceLoading(true)
      setActiveRefinanceLoans([])
      setRefinanceLoanId('')
      try {
        const { data: activeLoans, error: activeLoansError } = await supabase
          .from('prestamos')
          .select('id, codigo')
          .eq('cartera_id', formWalletId)
          .eq('deudor_id', borrowerId)
          .neq('estado', 'terminado')
        if (activeLoansError) throw activeLoansError
        if (activeLoans.length === 0) return

        const { data: pendingInstallments, error: installmentsError } =
          await supabase
            .from('cuotas')
            .select('prestamo_id, monto')
            .in(
              'prestamo_id',
              activeLoans.map((loan) => loan.id),
            )
            .eq('estado', 'pendiente')
        if (installmentsError) throw installmentsError

        const options = activeLoans.map((loan) => {
          const pending = (pendingInstallments ?? []).filter(
            (installment) => installment.prestamo_id === loan.id,
          )
          const pendingCents = pending.reduce((total, installment) => {
            const cents = parseDecimalUnits(String(installment.monto), 2)
            if (cents === null) {
              throw new Error('El saldo pendiente contiene un monto no válido.')
            }
            return total + cents
          }, 0n)
          return {
            id: loan.id,
            codigo: loan.codigo,
            pendingCount: pending.length,
            pendingCents,
          }
        })
        if (!cancelled) setActiveRefinanceLoans(options)
      } catch (error) {
        if (!cancelled) {
          console.error(
            'No se pudieron cargar los préstamos activos del cliente.',
            error,
          )
          setErrorMessage(
            'No fue posible verificar los préstamos activos del cliente. Inténtalo de nuevo.',
          )
        }
      } finally {
        if (!cancelled) setRefinanceLoading(false)
      }
    }

    void loadActiveLoansForBorrower()
    return () => {
      cancelled = true
    }
  }, [borrowerId, canManage, formOpen, formWalletId])

  const isCashWallet = wallets.some(
    (wallet) => wallet.id === formWalletId && wallet.clave === 'y',
  )

  useEffect(() => {
    let cancelled = false

    async function loadCashAvailability() {
      if (!isCashWallet) {
        setCashAvailability({ status: 'not_applicable' })
        return
      }
      if (!supabase) {
        setCashAvailability({ status: 'error' })
        return
      }

      setCashAvailability({ status: 'loading' })
      try {
        const { data: control, error: controlError } = await supabase
          .from('control_caja')
          .select('cartera_id, iniciado_en')
          .eq('cartera_id', formWalletId)
          .maybeSingle()
        if (controlError) throw controlError
        if (!control) {
          if (!cancelled) setCashAvailability({ status: 'unconfigured' })
          return
        }

        const { data: movements, error: movementsError } = await supabase
          .from('movimientos_caja')
          .select('tipo, monto')
          .eq('cartera_id', formWalletId)
          .gte('created_at', control.iniciado_en)
          .limit(5000)
        if (movementsError) throw movementsError
        const balanceCents = (movements ?? [])
          .filter((row) => row.tipo !== 'saldo_inicial')
          .reduce<bigint>((total, row) => {
            const cents = parseSignedDecimalUnits(String(row.monto), 2)
            if (cents === null) {
              throw new Error('El saldo de caja contiene un importe inválido.')
            }
            return total + cents
          }, 0n)
        if (!cancelled) {
          setCashAvailability({ status: 'ready', balanceCents })
        }
      } catch (error) {
        console.error('No se pudo consultar el saldo disponible de Mariluz.', error)
        if (!cancelled) setCashAvailability({ status: 'error' })
      }
    }

    void loadCashAvailability()
    return () => {
      cancelled = true
    }
  }, [formWalletId, isCashWallet, reloadCounter])

  const loadData = useCallback(async () => {
    if (!supabase) {
      setErrorMessage('La conexión con Supabase no está configurada.')
      setLoading(false)
      return
    }

    setLoading(true)
    setErrorMessage(null)
    if (prestamoId) setDetailBorrower(null)
    try {
      let permittedWallets: Wallet[] = []
      if (canManage) {
        const { data, error } = await supabase
          .from('carteras')
          .select('id, clave, nombre')
          .order('nombre')
        if (error) throw error
        permittedWallets = data ?? []
        setWallets(permittedWallets)
        if (
          !prestamoId &&
          permittedWallets[0] &&
          !permittedWallets.some((wallet) => wallet.id === filterWalletId)
        ) {
          setFilterWalletId(permittedWallets[0].id)
        }
        if (permittedWallets[0]) {
          setFormWalletId((current) => current || permittedWallets[0].id)
        }
      } else if (profile?.carteraId) {
        const { data, error } = await supabase
          .from('carteras')
          .select('id, clave, nombre')
          .eq('id', profile.carteraId)
          .maybeSingle()
        if (error) throw error
        permittedWallets = data ? [data] : []
        setWallets(permittedWallets)
        setFormWalletId(profile.carteraId)
      }

      const { data: borrowerData, error: borrowerError } = await supabase
        .from('deudores')
        .select('id, cartera_id, nombre, identificacion, telefono')
        .order('nombre')
        .limit(500)
      if (borrowerError) throw borrowerError
      setBorrowers((borrowerData ?? []) as BorrowerOption[])
      if (!requestedBorrowerId) {
        preselectedBorrowerId.current = null
      } else if (preselectedBorrowerId.current !== requestedBorrowerId) {
        preselectedBorrowerId.current = requestedBorrowerId
        const preselectedBorrower = (borrowerData ?? []).find(
          (borrower) => borrower.id === requestedBorrowerId,
        )
        if (preselectedBorrower && !walletManuallySelected.current) {
          setBorrowerId(preselectedBorrower.id)
          setFormWalletId(preselectedBorrower.cartera_id)
        }
      }

      let query = supabase
        .from('prestamos')
        .select(
          'id, codigo, cartera_id, deudor_id, monto, tasa_interes, numero_cuotas, metodo_calculo, dia_pago_semana, fecha_inicio, fecha_fin, notas, estado',
        )
        .order('created_at', { ascending: false })
        .limit(500)
      if (prestamoId) {
        query = query.eq('id', prestamoId)
      } else {
        query = query.neq('estado', 'terminado')
      }
      if (!prestamoId && filterWalletId) {
        query = query.eq('cartera_id', filterWalletId)
      }
      const { data: loanData, error: loanError } = await query
      if (loanError) throw loanError
      const loadedLoans = (loanData ?? []) as LoanRecord[]
      setLoans(loadedLoans)

      if (prestamoId) {
        const selectedLoan = loadedLoans[0]
        if (selectedLoan) {
          const [borrowerResult, installmentResult, paymentResult] = await Promise.all([
            supabase
              .from('deudores')
              .select(
                'nombre, identificacion, email, telefono, direccion, apartamento, ciudad, estado, codigo_postal',
              )
              .eq('id', selectedLoan.deudor_id)
              .maybeSingle(),
            supabase
              .from('cuotas')
              .select(
                'id, numero, fecha_vencimiento, capital, intereses, monto, estado',
              )
              .eq('prestamo_id', prestamoId)
              .order('numero'),
            supabase
              .from('pagos')
              .select(
                'id, cuota_id, monto, tipo, pagado_en, pago_referenciado_id, notas',
              )
              .eq('prestamo_id', prestamoId)
              .order('pagado_en', { ascending: false }),
          ])
          if (borrowerResult.error) throw borrowerResult.error
          if (installmentResult.error) throw installmentResult.error
          if (paymentResult.error) throw paymentResult.error
          setDetailBorrower(borrowerResult.data)
          setInstallmentsByLoan((current) => ({
            ...current,
            [prestamoId]: (installmentResult.data ?? []) as InstallmentRecord[],
          }))
          setPaymentsByLoan((current) => ({
            ...current,
            [prestamoId]: (paymentResult.data ?? []) as PaymentRecord[],
          }))
          setStatementEmailError(null)
          setStatementEmailSuccess(null)
        }
      }
    } catch (error) {
      console.error('No se pudieron cargar los préstamos.', error)
      setErrorMessage(
        'No fue posible cargar los préstamos. Revisa la conexión y las políticas RLS de Supabase.',
      )
    } finally {
      setLoading(false)
    }
  }, [
    canManage,
    filterWalletId,
    prestamoId,
    profile,
    requestedBorrowerId,
    setFilterWalletId,
  ])

  useEffect(() => {
    queueMicrotask(() => void loadData())
  }, [loadData, reloadCounter])

  async function downloadClientStatement(loan: LoanRecord) {
    const installments = installmentsByLoan[loan.id]
    const payments = paymentsByLoan[loan.id]
    if (!detailBorrower || !installments || !payments) {
      setPdfError('Espera a que se cargue la información del préstamo e inténtalo de nuevo.')
      return
    }

    setGeneratingClientPdf(true)
    setPdfError(null)
    try {
      await generateClientLoanPdf(
        detailBorrower,
        loan,
        installments.map((installment) => ({
          ...installment,
          prestamo_id: loan.id,
        })),
        payments.map((payment) => ({
          prestamo_id: loan.id,
          monto: payment.monto,
          pagado_en: payment.pagado_en,
          notas: payment.notas,
        })),
      )
    } catch (error) {
      console.error('No se pudo generar el estado de cuenta del préstamo.', error)
      setPdfError('No fue posible generar el PDF de este préstamo. Inténtalo de nuevo.')
    } finally {
      setGeneratingClientPdf(false)
    }
  }

  async function emailClientStatement(loan: LoanRecord) {
    const installments = installmentsByLoan[loan.id]
    const payments = paymentsByLoan[loan.id]
    if (!canManage) {
      setStatementEmailError('Solo el administrador puede enviar extractos por correo.')
      return
    }
    if (!supabase || !detailBorrower?.email) {
      setStatementEmailError('Registra el correo del cliente antes de enviar el extracto.')
      return
    }
    if (!installments || !payments) {
      setStatementEmailError(
        'Espera a que se cargue la información del préstamo e inténtalo de nuevo.',
      )
      return
    }

    setSendingStatementEmail(true)
    setStatementEmailError(null)
    setStatementEmailSuccess(null)
    try {
      const email = await sendClientStatement(
        loan,
        detailBorrower,
        installments,
        payments,
      )
      setStatementEmailSuccess(
        `El extracto se envió a ${email}.`,
      )
    } catch (error) {
      console.error('No se pudo enviar el extracto por correo.', error)
      setStatementEmailError(
        error instanceof Error
          ? error.message
          : 'No fue posible enviar el extracto. Verifica la configuración de correo.',
      )
    } finally {
      setSendingStatementEmail(false)
    }
  }

  async function sendClientStatement(
    loan: LoanRecord,
    borrower: LoanDetailBorrower,
    installments: InstallmentRecord[],
    payments: PaymentRecord[],
  ) {
    if (!supabase) {
      throw new Error('La conexión con Supabase no está configurada.')
    }
    if (!borrower.email) {
      throw new Error('El cliente no tiene un correo registrado.')
    }

    const pdf = await createClientLoanPdfBlob(
      borrower,
      loan,
      installments.map((installment) => ({
        ...installment,
        prestamo_id: loan.id,
      })),
      payments.map((payment) => ({
        prestamo_id: loan.id,
        monto: payment.monto,
        pagado_en: payment.pagado_en,
        notas: payment.notas,
      })),
    )
    const { error } = await supabase.functions.invoke(
      'send-loan-statement',
      {
        body: {
          loanId: loan.id,
          pdfBase64: await blobToBase64(pdf),
        },
      },
    )
    if (error) {
      if ('context' in error && error.context instanceof Response) {
        const responseBody: unknown = await error.context
          .json()
          .catch(() => null)
        if (
          typeof responseBody === 'object' &&
          responseBody !== null &&
          'error' in responseBody &&
          typeof responseBody.error === 'string'
        ) {
          throw new Error(responseBody.error)
        }
      }
      throw error
    }
    return borrower.email
  }

  async function emailStatementAfterPayment(loan: LoanRecord) {
    if (!supabase) {
      throw new Error('La conexión con Supabase no está configurada.')
    }
    const [borrowerResult, installmentsResult, paymentsResult] =
      await Promise.all([
        supabase
          .from('deudores')
          .select(
            'nombre, identificacion, email, telefono, direccion, apartamento, ciudad, estado, codigo_postal',
          )
          .eq('id', loan.deudor_id)
          .maybeSingle(),
        supabase
          .from('cuotas')
          .select(
            'id, numero, fecha_vencimiento, capital, intereses, monto, estado',
          )
          .eq('prestamo_id', loan.id)
          .order('numero'),
        supabase
          .from('pagos')
          .select(
            'id, cuota_id, monto, tipo, pagado_en, pago_referenciado_id, notas',
          )
          .eq('prestamo_id', loan.id)
          .order('pagado_en', { ascending: false }),
      ])
    if (borrowerResult.error) throw borrowerResult.error
    if (installmentsResult.error) throw installmentsResult.error
    if (paymentsResult.error) throw paymentsResult.error
    if (!borrowerResult.data) {
      throw new Error('No fue posible encontrar al cliente del préstamo.')
    }

    const installments =
      (installmentsResult.data ?? []) as InstallmentRecord[]
    const payments = (paymentsResult.data ?? []) as PaymentRecord[]
    setInstallmentsByLoan((current) => ({ ...current, [loan.id]: installments }))
    setPaymentsByLoan((current) => ({ ...current, [loan.id]: payments }))
    return sendClientStatement(
      loan,
      borrowerResult.data as LoanDetailBorrower,
      installments,
      payments,
    )
  }

  const filteredBorrowers = useMemo(
    () => {
      const query = borrowerSearch.trim().toLocaleLowerCase()
      return borrowers.filter(
        (borrower) =>
          (!formWalletId || borrower.cartera_id === formWalletId) &&
          (!query ||
            borrower.nombre.toLocaleLowerCase().includes(query) ||
            formatUsPhone(borrower.telefono)
              .toLocaleLowerCase()
              .includes(query) ||
            (phoneDigits(query).length > 0 &&
              phoneDigits(borrower.telefono ?? '').includes(phoneDigits(query)))),
      )
    },
    [borrowerSearch, borrowers, formWalletId],
  )

  const borrowerNames = useMemo(
    () => new Map(borrowers.map((borrower) => [borrower.id, borrower.nombre])),
    [borrowers],
  )
  const walletNames = useMemo(
    () => new Map(wallets.map((wallet) => [wallet.id, wallet.nombre])),
    [wallets],
  )

  async function loadInstallments(loanId: string, forceReload = false) {
    if (!supabase) return
    const cached = installmentsByLoan[loanId]
    if (cached && !forceReload) return

    const [installmentResult, paymentResult] = await Promise.all([
      supabase
        .from('cuotas')
        .select('id, numero, fecha_vencimiento, capital, intereses, monto, estado')
        .eq('prestamo_id', loanId)
        .order('numero'),
      supabase
        .from('pagos')
        .select(
          'id, cuota_id, monto, tipo, pagado_en, pago_referenciado_id, notas',
        )
        .eq('prestamo_id', loanId)
        .order('pagado_en', { ascending: false }),
    ])
    if (installmentResult.error || paymentResult.error) {
      console.error(
        'No se pudo cargar el cronograma o el historial de pagos.',
        installmentResult.error ?? paymentResult.error,
      )
      setErrorMessage('No fue posible cargar el cronograma de este préstamo.')
      return
    }
    setInstallmentsByLoan((current) => ({
      ...current,
      [loanId]: (installmentResult.data ?? []) as InstallmentRecord[],
    }))
    setPaymentsByLoan((current) => ({
      ...current,
      [loanId]: (paymentResult.data ?? []) as PaymentRecord[],
    }))
  }

  function choosePaymentAction(action: PaymentAction) {
    setPaymentAction(action)
    setPaymentNotes('')
    setZellePaymentConfirmed(false)
    setPaymentError(null)
    setPaymentSuccess(null)
    setPaymentEmailError(null)
  }

  async function handlePaymentAction(
    event: FormEvent<HTMLFormElement>,
    action: PaymentAction,
  ) {
    event.preventDefault()
    if (!supabase || !canManage) {
      setPaymentError('Solo el administrador puede registrar pagos o hacer modificaciones.')
      return
    }
    if (action.kind === 'register' && !zellePaymentConfirmed) {
      setPaymentError('Confirma que el dinero ya ingresó a Zelle antes de registrar el pago.')
      return
    }

    setPaymentSubmitting(true)
    setPaymentError(null)
    setPaymentSuccess(null)
    setPaymentEmailError(null)
    try {
      const { error } =
        action.kind === 'register'
          ? await supabase.rpc('registrar_pago', {
              p_prestamo_id: action.loanId,
              p_cuota_id: action.installmentId,
              p_tipo: action.type,
              p_notas: paymentNotes.trim() || undefined,
            })
          : await supabase.rpc('revertir_pago', {
              p_pago_id: action.paymentId,
              p_motivo: paymentNotes.trim(),
            })
      if (error) throw error

      setPaymentAction(null)
      setPaymentNotes('')
      setZellePaymentConfirmed(false)
      setPaymentSuccess(
        action.kind === 'register'
          ? 'El pago se registró correctamente.'
          : 'La modificación quedó registrada como ajuste.',
      )
      setReloadCounter((counter) => counter + 1)
      await loadInstallments(action.loanId, true)
      if (action.kind === 'register') {
        const loan = loans.find((candidate) => candidate.id === action.loanId)
        if (!loan) {
          setPaymentEmailError(
            'El pago quedó registrado, pero no se pudo localizar el préstamo para enviar el extracto.',
          )
        } else {
          try {
            const email = await emailStatementAfterPayment(loan)
            setPaymentSuccess(
              `El pago se registró correctamente y se envió el extracto actualizado a ${email}.`,
            )
          } catch (emailError) {
            console.error(
              'El pago quedó registrado, pero no se pudo enviar el extracto actualizado.',
              emailError,
            )
            setPaymentEmailError(
              `El pago sí se registró, pero no se pudo enviar el extracto: ${
                emailError instanceof Error
                  ? emailError.message
                  : 'error desconocido'
              }`,
            )
          }
        }
      }
    } catch (error) {
      console.error('No se pudo completar la operación del pago.', error)
      setPaymentError(
        error instanceof Error
          ? error.message
          : 'No fue posible completar la operación del pago.',
      )
    } finally {
      setPaymentSubmitting(false)
    }
  }

  async function deleteLoan(loan: LoanRecord) {
    if (!supabase || !canManage) return
    const borrowerName = borrowerNames.get(loan.deudor_id) ?? 'este deudor'
    const confirmed = window.confirm(
      `¿Eliminar el préstamo de ${borrowerName} por ${formatNumericAmount(loan.monto)}? Se borrarán también sus cuotas, pagos y prórrogas. La auditoría se conservará y los movimientos de caja se compensarán para mantener la trazabilidad financiera. No se puede deshacer.`,
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
      setPaymentAction(null)
      setReloadCounter((counter) => counter + 1)
    } catch (error) {
      console.error('No se pudo eliminar el préstamo de prueba.', error)
      setErrorMessage(
        'No fue posible eliminar el préstamo. Revisa las relaciones y los permisos de Supabase.',
      )
    } finally {
      setDeletingLoanId(null)
    }
  }

  async function cleanupOrphanLoans() {
    if (!supabase || !canManage) return
    const confirmed = window.confirm(
      'Se eliminarán permanentemente los préstamos de prueba que ya no tengan un cliente asociado, junto con sus cuotas, pagos y prórrogas. La auditoría se conservará y los movimientos de caja se compensarán para mantener la trazabilidad financiera. ¿Continuar?',
    )
    if (!confirmed) return

    setCleaningOrphanLoans(true)
    setErrorMessage(null)
    setSuccessMessage(null)
    try {
      const { data: deletedCount, error } = await supabase.rpc(
        'eliminar_prestamos_huerfanos_pruebas',
      )
      if (error) throw error
      setSuccessMessage(
        deletedCount === 0
          ? 'No se encontraron préstamos huérfanos.'
          : `Se eliminaron ${deletedCount} préstamos huérfanos y sus datos relacionados.`,
      )
      setReloadCounter((counter) => counter + 1)
    } catch (error) {
      console.error('No se pudieron eliminar los préstamos huérfanos.', error)
      setErrorMessage(
        'No fue posible limpiar los préstamos huérfanos. Verifica que la migración de limpieza esté aplicada.',
      )
    } finally {
      setCleaningOrphanLoans(false)
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) {
      setErrorMessage('La conexión con Supabase no está configurada.')
      return
    }
    if (!canManage) {
      setErrorMessage('Solo el administrador puede crear préstamos.')
      return
    }
    if (!formWalletId || !borrowerId || !schedule) {
      setErrorMessage('Completa cartera, deudor y datos válidos del préstamo.')
      return
    }
    const loanToRefinance = refinanceLoanId
      ? activeRefinanceLoans.find((loan) => loan.id === refinanceLoanId)
      : undefined
    if (refinanceLoanId) {
      if (!loanToRefinance) {
        setErrorMessage(
          'No se encontró el préstamo seleccionado para refinanciar.',
        )
        return
      }
      if (
        loanToRefinance.pendingCount < 1 ||
        loanToRefinance.pendingCount > 3
      ) {
        setErrorMessage(
          'Solo se puede refinanciar un préstamo cuando tiene entre 1 y 3 cuotas pendientes.',
        )
        return
      }
      if (schedule.principalCents < loanToRefinance.pendingCents) {
        setErrorMessage(
          'El capital del nuevo préstamo no puede ser menor que el saldo que se descontará.',
        )
        return
      }
    }
    if (wallets.find((wallet) => wallet.id === formWalletId)?.clave === 'y') {
      if (
        cashAvailability.status !== 'unconfigured' &&
        cashAvailability.status !== 'ready'
      ) {
        setErrorMessage(
          'No fue posible verificar el saldo disponible de Mariluz. Inténtalo de nuevo.',
        )
        return
      }
      if (cashAvailability.status === 'ready') {
        const currentRefinance = activeRefinanceLoans.find(
          (loan) => loan.id === refinanceLoanId,
        )
        const cashNeeded =
          schedule.principalCents - (currentRefinance?.pendingCents ?? 0n)
        if (cashNeeded > cashAvailability.balanceCents) {
          setErrorMessage(
            'El saldo disponible no alcanza para entregar el efectivo de este préstamo.',
          )
          return
        }
      }
    }

    setSubmitting(true)
    setErrorMessage(null)
    setSuccessMessage(null)
    let createdLoanId: string | null = null
    const firstInstallment = schedule.installments[0]

    try {
      if (!firstInstallment) {
        throw new Error('No fue posible generar las cuotas del préstamo.')
      }
      if (refinanceLoanId) {
        const refinance = activeRefinanceLoans.find(
          (loan) => loan.id === refinanceLoanId,
        )
        if (!refinance) {
          throw new Error('No se encontró el préstamo seleccionado para refinanciar.')
        }
        const scheduleRows = schedule.installments.map((installment) => ({
          numero: installment.numero,
          fecha_vencimiento: installment.fecha_vencimiento,
          capital: decimalStringToDatabaseNumber(installment.capital),
          intereses: decimalStringToDatabaseNumber(installment.intereses),
          monto: decimalStringToDatabaseNumber(installment.monto),
        }))
        const { error } = await supabase.rpc('refinanciar_prestamo', {
          p_prestamo_anterior_id: refinance.id,
          p_cartera_id: formWalletId,
          p_deudor_id: borrowerId,
          p_monto: centsToDatabaseNumber(schedule.principalCents),
          p_tasa_interes: rateUnitsToDatabaseNumber(schedule.interestRateUnits),
          p_dia_pago_semana: schedule.paymentWeekday,
          p_numero_cuotas: schedule.installments.length,
          p_fecha_inicio: startDate,
          p_fecha_fin: schedule.endDate,
          p_notas: notes.trim() || null,
          p_cuotas: scheduleRows,
        })
        if (error) throw error

        const cashToDeliver =
          schedule.principalCents - refinance.pendingCents
        setSuccessMessage(
          `Préstamo refinanciado correctamente. Se descontaron ${formatMoney(refinance.pendingCents)} del préstamo ${refinance.codigo}; efectivo neto a entregar: ${formatMoney(cashToDeliver)}.`,
        )
        setPrincipal('')
        setInstallmentAmount('')
        setInstallmentCount('10')
        setNotes('')
        setBorrowerId('')
        setRefinanceLoanId('')
        setStartDate(localDateValue())
        setFirstInstallmentDate(addCalendarDays(localDateValue(), 7))
        setFormOpen(false)
        setReloadCounter((counter) => counter + 1)
        return
      }

      const { data, error } = await supabase
        .from('prestamos')
        .insert({
          cartera_id: formWalletId,
          deudor_id: borrowerId,
          monto: centsToDatabaseNumber(schedule.principalCents),
          monto_desembolsado: centsToDatabaseNumber(schedule.principalCents),
          tasa_interes: rateUnitsToDatabaseNumber(schedule.interestRateUnits),
          metodo_calculo: 'fijo_capital_inicial',
          dia_pago_semana: schedule.paymentWeekday,
          numero_cuotas: schedule.installments.length,
          fecha_inicio: startDate,
          fecha_fin: schedule.endDate,
          notas: notes.trim() || null,
          estado: 'activo',
        })
        .select('id')
        .single()
      if (error) throw error
      createdLoanId = data.id

      const rows = schedule.installments.map((installment) => ({
        cartera_id: formWalletId,
        prestamo_id: data.id,
        numero: installment.numero,
        fecha_vencimiento: installment.fecha_vencimiento,
        capital: decimalStringToDatabaseNumber(installment.capital),
        intereses: decimalStringToDatabaseNumber(installment.intereses),
        monto: decimalStringToDatabaseNumber(installment.monto),
        estado: 'pendiente',
      }))
      const { error: installmentError } = await supabase
        .from('cuotas')
        .insert(rows)
      if (installmentError) {
        const { error: cleanupError } = await supabase
          .from('prestamos')
          .delete()
          .eq('id', data.id)
        if (cleanupError) {
          console.error(
            'No se pudo retirar el préstamo creado sin cronograma.',
            cleanupError,
          )
        }
        throw installmentError
      }

      setSuccessMessage('Préstamo y cronograma creados correctamente.')
      setPrincipal('')
      setInstallmentAmount('')
      setInstallmentCount('10')
      setNotes('')
      setBorrowerId('')
      setStartDate(localDateValue())
      setFirstInstallmentDate(addCalendarDays(localDateValue(), 7))
      setFormOpen(false)
      setReloadCounter((counter) => counter + 1)
    } catch (error) {
      console.error('No se pudo crear el préstamo.', error)
      const message = getErrorMessage(error).toLowerCase()
      if (message.includes('ya tiene un préstamo activo')) {
        setErrorMessage(
          'Este cliente ya tiene un préstamo activo. Selecciona el préstamo para refinanciarlo si le quedan entre 1 y 3 cuotas.',
        )
        return
      }
      if (
        message.includes('saldo disponible') ||
        message.includes('configura primero el saldo inicial')
      ) {
        setErrorMessage(
          'El saldo disponible de Mariluz no alcanza o el Control financiero aún no se ha iniciado. Revisa el tablero antes de continuar.',
        )
        return
      }
      if (createdLoanId) {
        setErrorMessage(
          `No se pudo guardar el cronograma: ${getErrorMessage(error)} Se intentó retirar el préstamo incompleto; revisa la lista antes de volver a intentarlo.`,
        )
        setReloadCounter((counter) => counter + 1)
      } else {
        setErrorMessage(
          `No fue posible crear el préstamo: ${getErrorMessage(error)}`,
        )
      }
    } finally {
      setSubmitting(false)
    }
  }

  const visibleLoans = loans.filter(
    (loan) =>
      (isLoanDetail
        ? loan.id === prestamoId
        : loan.estado !== 'terminado' &&
          (!filterWalletId || loan.cartera_id === filterWalletId)),
  )
  const selectedRefinanceLoan = activeRefinanceLoans.find(
    (loan) => loan.id === refinanceLoanId,
  )
  const refinanceEligibleLoans = activeRefinanceLoans.filter(
    (loan) => loan.pendingCount >= 1 && loan.pendingCount <= 3,
  )
  const refinanceSelectionReady =
    !refinanceLoanId ||
    (selectedRefinanceLoan !== undefined &&
      selectedRefinanceLoan.pendingCount >= 1 &&
      selectedRefinanceLoan.pendingCount <= 3 &&
      schedule !== null &&
      schedule.principalCents >= selectedRefinanceLoan.pendingCents)
  const cashNeededCents =
    schedule === null
      ? null
      : schedule.principalCents -
        (refinanceLoanId && selectedRefinanceLoan
          ? selectedRefinanceLoan.pendingCents
          : 0n)
  const cashBalanceInsufficient =
    isCashWallet &&
    cashAvailability.status === 'ready' &&
    cashNeededCents !== null &&
    cashNeededCents > cashAvailability.balanceCents

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
        <p className="text-sm font-semibold text-emerald-700">
          {isLoanDetail ? 'Información completa' : 'Carteras y clientes'}
        </p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
          {isLoanDetail ? 'Detalle del préstamo' : 'Préstamos activos'}
        </h1>
        <p className="mt-2 text-sm leading-6 text-slate-600">
          {isLoanDetail
            ? 'Resumen, cronograma de cuotas e historial de pagos de este préstamo.'
            : 'Define el capital, el número de cuotas y el valor de cada pago.'}
        </p>
        {isLoanDetail && (
          <Link
            to={`${canManage ? '/admin' : '/cartera'}/prestamos`}
            className="mt-4 inline-flex min-h-10 items-center text-sm font-semibold text-emerald-800 underline underline-offset-4"
          >
            Volver a préstamos activos
          </Link>
        )}
        </div>
        {!isLoanDetail && canManage && (
          <button
            type="button"
            onClick={() => {
              setFormOpen((open) => !open)
              setErrorMessage(null)
              setSuccessMessage(null)
            }}
            className="min-h-11 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
          >
            {formOpen ? 'Cancelar' : 'Nuevo préstamo'}
          </button>
        )}
      </div>

      {!isLoanDetail && canManage && formOpen && (
        <section
          ref={loanFormRef}
          tabIndex={-1}
          className="mt-6 scroll-mt-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm outline-none sm:p-6"
        >
          <h2 className="text-lg font-semibold text-slate-950">Nuevo préstamo</h2>
          <p className="mt-1 text-sm leading-6 text-slate-600">
            El total se calcula multiplicando el valor de la cuota por el número
            de cuotas; el interés es la diferencia entre ese total y el capital.
            Las cuotas empiezan en la fecha indicada.
          </p>
          {isCashWallet && (
            <div className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm">
              {cashAvailability.status === 'loading' ? (
                <p className="text-slate-700">Consultando saldo de caja…</p>
              ) : cashAvailability.status === 'unconfigured' ? (
                <p className="text-amber-900">
                  El control financiero aún no se ha iniciado. Puedes crear
                  préstamos para hacer pruebas; sus desembolsos previos no se
                  incluirán en el saldo cuando inicies el control.{' '}
                  <Link
                    to="/admin/control-financiero"
                    className="font-semibold underline underline-offset-2"
                  >
                    Ir al Control financiero
                  </Link>
                </p>
              ) : cashAvailability.status === 'error' ? (
                <p role="alert" className="text-red-800">
                  No se pudo consultar el estado del control financiero.
                  Inténtalo de nuevo antes de crear el préstamo.
                </p>
              ) : cashAvailability.status === 'ready' ? (
                <div className="flex flex-wrap justify-between gap-2 text-slate-800">
                  <span>
                    Disponible en caja:{' '}
                    <strong>{formatMoney(cashAvailability.balanceCents)}</strong>
                  </span>
                  {cashNeededCents !== null && (
                    <span>
                      Efectivo a entregar:{' '}
                      <strong>{formatMoney(cashNeededCents)}</strong>
                    </span>
                  )}
                  {cashBalanceInsufficient && (
                    <p role="alert" className="basis-full font-medium text-red-800">
                      El saldo disponible no alcanza para este desembolso.
                    </p>
                  )}
                </div>
              ) : null}
            </div>
          )}

          <form onSubmit={(event) => void handleSubmit(event)} className="mt-5">
            <div className="grid gap-4 sm:grid-cols-3">
              <label className="block text-sm font-medium text-slate-800">
                Cartera
                <select
                  required
                  value={formWalletId}
                  onChange={(event) => {
                    walletManuallySelected.current = true
                    setFormWalletId(event.target.value)
                    setBorrowerId('')
                    setBorrowerSearch('')
                  }}
                  className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base"
                >
                  <option value="" disabled>
                    Selecciona cartera
                  </option>
                  {wallets.map((wallet) => (
                    <option key={wallet.id} value={wallet.id}>
                      {wallet.nombre}
                    </option>
                  ))}
                </select>
              </label>

              <div>
                <label
                  htmlFor="borrower-search"
                  className="block text-sm font-medium text-slate-800"
                >
                  Buscar deudor por nombre o teléfono
                </label>
                <input
                  id="borrower-search"
                  type="search"
                  value={borrowerSearch}
                  onChange={(event) => setBorrowerSearch(event.target.value)}
                  placeholder="Nombre o número de teléfono"
                  className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base"
                />
              </div>

              <label className="block text-sm font-medium text-slate-800">
                Deudor
                <select
                  id="borrower-select"
                  required
                  value={borrowerId}
                  onChange={(event) => setBorrowerId(event.target.value)}
                  className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base"
                >
                  <option value="" disabled>
                    Selecciona el deudor
                  </option>
                  {filteredBorrowers.map((borrower) => (
                    <option key={borrower.id} value={borrower.id}>
                      {borrower.nombre} ·{' '}
                      {formatUsPhone(borrower.telefono) || 'Sin teléfono'}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {borrowerId && refinanceLoading && (
              <p className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
                Verificando préstamos elegibles para refinanciar…
              </p>
            )}
            {borrowerId &&
              !refinanceLoading &&
              refinanceEligibleLoans.length > 0 && (
                <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <label className="block text-sm font-medium text-slate-800">
                    Préstamo que quieres refinanciar (opcional)
                    <select
                      value={refinanceLoanId}
                      onChange={(event) =>
                        setRefinanceLoanId(event.target.value)
                      }
                      className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base"
                    >
                      <option value="">Crear préstamo sin refinanciar</option>
                      {refinanceEligibleLoans.map((loan) => (
                        <option key={loan.id} value={loan.id}>
                          {loan.codigo} · Cuotas pendientes {loan.pendingCount}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="mt-2 text-sm text-slate-700">
                    Puedes crear otro préstamo para este cliente. Para
                    refinanciar, selecciona el código del préstamo con 1, 2 o 3
                    cuotas pendientes.
                  </p>
                  {refinanceLoanId && selectedRefinanceLoan && (
                    <>
                      <p className="mt-2 text-sm text-slate-700">
                        Al refinanciar se cerrará el préstamo seleccionado y
                        sus cuotas pendientes se descontarán del efectivo
                        entregado.
                      </p>
                      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-3">
                        <div>
                          <dt className="text-slate-600">Saldo descontado</dt>
                          <dd className="font-semibold text-slate-950">
                            {formatMoney(selectedRefinanceLoan.pendingCents)}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-slate-600">
                            Efectivo neto a entregar
                          </dt>
                          <dd className="font-semibold text-slate-950">
                            {schedule
                              ? formatMoney(
                                  schedule.principalCents -
                                    selectedRefinanceLoan.pendingCents,
                                )
                              : 'Completa el monto del préstamo'}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-slate-600">
                            Cuotas que se liquidarán
                          </dt>
                          <dd className="font-semibold text-slate-950">
                            {selectedRefinanceLoan.pendingCount}
                          </dd>
                        </div>
                      </dl>
                      {schedule &&
                        schedule.principalCents <
                          selectedRefinanceLoan.pendingCents && (
                          <p role="alert" className="mt-3 text-sm text-red-800">
                            El capital del nuevo préstamo debe cubrir el saldo
                            que se descontará.
                          </p>
                        )}
                    </>
                  )}
                </div>
              )}

            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <label className="block text-sm font-medium text-slate-800">
                Monto prestado (USD)
                <input
                  required
                  type="number"
                  min="1"
                  max="9999999999"
                  step="1"
                  value={principal}
                  onChange={(event) => setPrincipal(event.target.value)}
                  className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base"
                />
              </label>

              <label className="block text-sm font-medium text-slate-800">
                Número de cuotas
                <input
                  required
                  type="number"
                  min="1"
                  max="520"
                  step="1"
                  value={installmentCount}
                  onChange={(event) => setInstallmentCount(event.target.value)}
                  className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base"
                />
              </label>

              <label className="block text-sm font-medium text-slate-800">
                Valor de la cuota a pagar (USD)
                <input
                  required
                  type="number"
                  min="1"
                  max="9999999999"
                  step="1"
                  value={installmentAmount}
                  onChange={(event) => setInstallmentAmount(event.target.value)}
                  className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base"
                />
              </label>

              <label className="block text-sm font-medium text-slate-800">
                Interés total calculado (USD)
                <input
                  type="text"
                  readOnly
                  value={schedule ? formatMoney(schedule.interestCents) : ''}
                  placeholder="Se calcula automáticamente"
                  className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 text-base text-slate-700"
                />
              </label>

              <label className="block text-sm font-medium text-slate-800">
                Porcentaje de interés
                <input
                  type="text"
                  readOnly
                  value={
                    schedule
                      ? formatInterestRate(
                          rateUnitsToDatabaseNumber(schedule.interestRateUnits),
                        )
                      : ''
                  }
                  placeholder="Se calcula automáticamente"
                  className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 text-base text-slate-700"
                />
              </label>

              <label className="block text-sm font-medium text-slate-800">
                Total estimado a cobrar (USD)
                <input
                  type="text"
                  readOnly
                  value={schedule ? formatMoney(schedule.totalCents) : ''}
                  placeholder="Cuota × número de cuotas"
                  className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 text-base text-slate-700"
                />
              </label>

              <label className="block text-sm font-medium text-slate-800">
                Fecha del préstamo
                <input
                  required
                  type="date"
                  value={startDate}
                  onChange={(event) => setStartDate(event.target.value)}
                  className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base"
                />
              </label>

              <label className="block text-sm font-medium text-slate-800">
                Fecha de primera cuota
                <input
                  required
                  type="date"
                  min={startDate}
                  value={firstInstallmentDate}
                  onChange={(event) =>
                    setFirstInstallmentDate(event.target.value)
                  }
                  className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base"
                />
              </label>

              <label className="block text-sm font-medium text-slate-800">
                Fecha de última cuota
                <input
                  type="date"
                  readOnly
                  value={schedule?.endDate ?? ''}
                  className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-slate-50 px-3 text-base text-slate-700"
                />
              </label>
            </div>

            {schedule && (
              <div className="mt-5 rounded-xl bg-slate-50 p-4 sm:p-5">
                <h3 className="font-semibold text-slate-950">Cronograma de pagos</h3>
                <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <dt className="text-slate-500">Capital</dt>
                    <dd className="mt-1 font-semibold text-slate-950">
                      {formatMoney(schedule.principalCents)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Interés total</dt>
                    <dd className="mt-1 font-semibold text-slate-950">
                      {formatMoney(schedule.interestCents)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Total a pagar</dt>
                    <dd className="mt-1 font-semibold text-slate-950">
                      {formatMoney(schedule.totalCents)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Primer vencimiento</dt>
                    <dd className="mt-1 font-semibold text-slate-950">
                      {formattedDate(schedule.installments[0].fecha_vencimiento)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-slate-500">Fecha del préstamo</dt>
                    <dd className="mt-1 font-semibold text-slate-950">
                      {formattedDate(startDate)}
                    </dd>
                  </div>
                </dl>
                <div className="mt-4 max-h-56 overflow-auto rounded-lg border border-slate-200 bg-white">
                  <table className="w-full min-w-[560px] text-left text-sm">
                    <thead className="sticky top-0 bg-slate-100 text-xs uppercase text-slate-600">
                      <tr>
                        <th className="px-3 py-2">Cuota</th>
                        <th className="px-3 py-2">Vence</th>
                        <th className="px-3 py-2">Abono a capital</th>
                        <th className="px-3 py-2">Interés</th>
                        <th className="px-3 py-2">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {schedule.installments.map((installment) => (
                        <tr key={installment.numero}>
                          <td className="px-3 py-2">{installment.numero}</td>
                          <td className="px-3 py-2">
                            {formattedDate(installment.fecha_vencimiento)}
                          </td>
                          <td className="px-3 py-2">${installment.capital}</td>
                          <td className="px-3 py-2">${installment.intereses}</td>
                          <td className="px-3 py-2 font-semibold">
                            ${installment.monto}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {scheduleValidationMessage && (
              <p
                className={`mt-4 text-sm ${
                  scheduleValidationMessage.startsWith('El total de las cuotas es igual')
                    ? 'text-sky-800'
                    : 'text-amber-800'
                }`}
              >
                {scheduleValidationMessage}
              </p>
            )}

            <label className="mt-4 block text-sm font-medium text-slate-800">
              Notas
              <textarea
                rows={3}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base"
              />
            </label>

            {errorMessage && (
              <p
                role="alert"
                className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
              >
                {errorMessage}
              </p>
            )}
            <button
              type="submit"
              disabled={
                submitting ||
                !schedule ||
                refinanceLoading ||
                !refinanceSelectionReady ||
                (isCashWallet &&
                  (cashAvailability.status === 'loading' ||
                    cashAvailability.status === 'error' ||
                    cashBalanceInsufficient))
              }
              className="mt-5 min-h-11 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting
                ? 'Guardando…'
                : refinanceLoanId
                  ? 'Refinanciar y crear préstamo'
                  : 'Crear préstamo'}
            </button>
          </form>
        </section>
      )}

      {!isLoanDetail && canManage && successMessage && (
        <p
          role="status"
          className="mt-5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
        >
          {successMessage}
        </p>
      )}

      {(!canManage || isLoanDetail) && errorMessage && (
        <p
          role="alert"
          className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {errorMessage}
        </p>
      )}

      {!isLoanDetail && canManage && wallets.length > 0 && (
        <label className="mt-6 block max-w-xs text-sm font-medium text-slate-800">
          Filtrar por cartera
          <select
            value={filterWalletId}
            onChange={(event) => setFilterWalletId(event.target.value)}
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

      {!isLoanDetail && canManage && !loading && visibleLoans.length === 0 && (
        <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 sm:flex sm:items-center sm:justify-between sm:gap-4">
          <p className="text-sm leading-6 text-amber-950">
            ¿Borraste clientes durante las pruebas y quedaron préstamos sin
            cliente asociado? Puedes limpiar esos registros huérfanos aquí.
          </p>
          <button
            type="button"
            disabled={cleaningOrphanLoans}
            onClick={() => void cleanupOrphanLoans()}
            className="mt-3 min-h-11 shrink-0 rounded-lg border border-amber-700 px-4 py-2 text-sm font-semibold text-amber-950 hover:bg-amber-100 disabled:cursor-wait disabled:opacity-60 sm:mt-0"
          >
            {cleaningOrphanLoans
              ? 'Limpiando…'
              : 'Limpiar préstamos huérfanos'}
          </button>
        </div>
      )}

      <section className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-4 py-4 sm:px-5">
          <h2 className="font-semibold text-slate-950">
            {isLoanDetail
              ? 'Información del préstamo'
              : `Préstamos activos (${visibleLoans.length})`}
          </h2>
        </div>
        {loading ? (
          <p className="px-5 py-8 text-sm text-slate-600">Cargando préstamos…</p>
        ) : visibleLoans.length === 0 ? (
          <p className="px-5 py-8 text-sm text-slate-600">
            {isLoanDetail
              ? 'No se encontró el préstamo o no tienes acceso a esta cartera.'
              : 'No hay préstamos activos para mostrar.'}
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {visibleLoans.map((loan) => {
              const isExpanded = isLoanDetail
              const installments = installmentsByLoan[loan.id]
              const payments = paymentsByLoan[loan.id]
              const actionForLoan =
                paymentAction?.loanId === loan.id ? paymentAction : null
              const actionInstallment =
                actionForLoan?.kind === 'register'
                  ? installments?.find(
                      (installment) =>
                        installment.id === actionForLoan.installmentId,
                    )
                  : null
              const actionPayment =
                actionForLoan?.kind === 'reverse'
                  ? payments?.find(
                      (payment) => payment.id === actionForLoan.paymentId,
                    )
                  : null
              const renderPaymentForm = (className: string) => {
                if (!actionForLoan) return null
                return (
                  <form
                    ref={(element) => {
                      const formKey =
                        actionForLoan.kind === 'register'
                          ? `${actionForLoan.loanId}:${actionForLoan.installmentId}`
                          : `${actionForLoan.loanId}:${actionForLoan.paymentId}`
                      if (element) paymentFormRefs.current.set(formKey, element)
                      else paymentFormRefs.current.delete(formKey)
                    }}
                    tabIndex={-1}
                    onSubmit={(event) =>
                      void handlePaymentAction(event, actionForLoan)
                    }
                    className={`${className} scroll-mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4 outline-none focus-visible:ring-2 focus-visible:ring-emerald-700`}
                  >
                    <h3 className="font-semibold text-slate-950">
                      {actionForLoan.kind === 'register'
                        ? actionForLoan.type === 'cuota_completa'
                          ? 'Confirmar pago completo'
                          : 'Confirmar pago de intereses y prórroga'
                        : 'Registrar modificación'}
                    </h3>
                    {actionForLoan.kind === 'register' &&
                      actionInstallment && (
                        <p className="mt-2 text-sm text-slate-700">
                          Cuota {actionInstallment.numero}:{' '}
                          {formatNumericAmount(
                            actionForLoan.type === 'cuota_completa'
                              ? actionInstallment.monto
                              : actionInstallment.intereses,
                          )}
                          {actionForLoan.type === 'solo_intereses' &&
                            '. Se desplazará el capital y el cronograma una semana, sin interés adicional.'}
                        </p>
                      )}
                    {actionForLoan.kind === 'reverse' && actionPayment && (
                      <p className="mt-2 text-sm text-slate-700">
                        Se registrará un ajuste negativo de{' '}
                        {formatSignedNumericAmount(actionPayment.monto)} y se
                        restaurará el cronograma si es posible. Solo se puede
                        modificar el último pago del préstamo.
                      </p>
                    )}
                    {actionForLoan.kind === 'register' && (
                      <label className="mt-4 flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border border-emerald-200 bg-white p-3 text-sm font-medium text-slate-800">
                        <input
                          type="checkbox"
                          required
                          checked={zellePaymentConfirmed}
                          onChange={(event) =>
                            setZellePaymentConfirmed(event.target.checked)
                          }
                          className="mt-0.5 h-5 w-5 shrink-0 accent-emerald-700"
                        />
                        <span>¿El dinero ya ingresó a Zelle?</span>
                      </label>
                    )}
                    <label className="mt-3 block text-sm font-medium text-slate-800">
                      {actionForLoan.kind === 'reverse'
                        ? 'Motivo de la modificación'
                        : 'Notas (opcional)'}
                      <textarea
                        rows={2}
                        required={actionForLoan.kind === 'reverse'}
                        value={paymentNotes}
                        onChange={(event) => setPaymentNotes(event.target.value)}
                        className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base"
                      />
                    </label>
                    <p className="mt-2 text-xs leading-5 text-slate-600">
                      La fecha y hora se registrarán al confirmar, guardadas en
                      UTC y mostradas en {paymentTimeZone}. El usuario
                      autenticado queda asociado al registro.
                    </p>
                    {paymentError && (
                      <p
                        role="alert"
                        className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800"
                      >
                        {paymentError}
                      </p>
                    )}
                    <div className="mt-4 flex flex-col gap-2 sm:flex-row">
                      <button
                        type="submit"
                        disabled={
                          paymentSubmitting ||
                          (actionForLoan.kind === 'register' &&
                            !zellePaymentConfirmed) ||
                          (actionForLoan.kind === 'register' &&
                            !actionInstallment) ||
                          (actionForLoan.kind === 'reverse' && !actionPayment)
                        }
                        className="min-h-11 rounded-lg bg-emerald-700 px-4 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-wait disabled:opacity-60"
                      >
                        {paymentSubmitting ? 'Guardando…' : 'Confirmar'}
                      </button>
                      <button
                        type="button"
                        disabled={paymentSubmitting}
                        onClick={() => {
                          setPaymentAction(null)
                          setZellePaymentConfirmed(false)
                          setPaymentError(null)
                        }}
                        className="min-h-11 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                      >
                        Cancelar
                      </button>
                    </div>
                  </form>
                )
              }
              const pendingInstallments =
                installments?.filter(
                  (installment) => installment.estado === 'pendiente',
                ) ?? []
              const firstPendingInstallment = pendingInstallments[0]
              const paidTotal = payments ? sumPaymentCents(payments) : null
              const pendingTotal = installments
                ? sumPendingCents(installments)
                : null
              const paidInstallmentCount =
                installments?.filter(
                  (installment) => installment.estado === 'pagada',
                ).length ?? 0
              const reversedPaymentIds = new Set(
                (payments ?? [])
                  .filter(
                    (payment) =>
                      payment.tipo === 'ajuste' &&
                      payment.pago_referenciado_id !== null,
                  )
                  .map((payment) => payment.pago_referenciado_id),
              )
              const paidInterestTotal =
                payments?.reduce<bigint | null>((total, payment) => {
                  if (
                    total === null ||
                    payment.tipo === 'ajuste' ||
                    reversedPaymentIds.has(payment.id)
                  ) {
                    return total
                  }
                  const amount =
                    payment.tipo === 'solo_intereses'
                      ? payment.monto
                      : payment.tipo === 'cuota_completa'
                        ? installments?.find(
                            (installment) => installment.id === payment.cuota_id,
                          )?.intereses
                        : 0
                  const cents =
                    amount === undefined
                      ? null
                      : parseDecimalUnits(String(amount), 2)
                  return cents === null ? null : total + cents
                }, 0n) ?? null
              const firstInstallmentDate = installments?.[0]?.fecha_vencimiento
              const lastInstallmentDate =
                installments?.[installments.length - 1]?.fecha_vencimiento
              const nextDueDate = firstPendingInstallment?.fecha_vencimiento
              const today = currentPaymentZoneDate()
              const overdueAfterGraceDate = addCalendarDays(today, -1)
              const overdueCount = pendingInstallments.filter(
                (installment) =>
                  installment.fecha_vencimiento < overdueAfterGraceDate,
              ).length
              const loanStatus =
                loan.estado === 'terminado'
                  ? 'terminado'
                  : overdueCount > 0
                    ? 'atrasado'
                    : 'activo'
              return (
                <li key={loan.id} className="px-4 py-4 sm:px-5">
                  <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        {isLoanDetail && (
                          <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-emerald-800">
                            Préstamo {loan.codigo}
                          </p>
                        )}
                        <Link
                          to={`${canManage ? '/admin' : '/cartera'}/deudores/${loan.deudor_id}`}
                          className="font-semibold text-slate-950 underline decoration-slate-300 underline-offset-4 hover:text-emerald-800"
                        >
                          {borrowerNames.get(loan.deudor_id) ?? 'Deudor'}
                        </Link>
                        {canManage && (
                          <p className="mt-1 text-sm text-slate-500">
                            {walletNames.get(loan.cartera_id) ?? 'Cartera'}
                          </p>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded-full px-3 py-1 text-xs font-semibold ${
                            loanStatus === 'terminado'
                              ? 'bg-slate-100 text-slate-700'
                              : loanStatus === 'atrasado'
                                ? 'bg-amber-100 text-amber-800'
                                : 'bg-emerald-50 text-emerald-800'
                          }`}
                        >
                          {stateLabels[loanStatus] ?? loanStatus}
                        </span>
                        {isLoanDetail && loan.estado !== 'terminado' && (
                          <button
                            type="button"
                            onClick={() => void downloadClientStatement(loan)}
                            disabled={
                              generatingClientPdf ||
                              !detailBorrower ||
                              !installments ||
                              !payments
                            }
                            className="inline-flex min-h-10 items-center justify-center rounded-lg bg-emerald-700 px-3 text-center text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-wait disabled:opacity-60"
                          >
                            {generatingClientPdf
                              ? 'Generando PDF…'
                              : 'Descargar PDF para el cliente'}
                          </button>
                        )}
                        {isLoanDetail && canManage && (
                          <button
                            type="button"
                            onClick={() => void emailClientStatement(loan)}
                            disabled={
                              sendingStatementEmail ||
                              !detailBorrower?.email ||
                              !installments ||
                              !payments
                            }
                            title={
                              detailBorrower?.email
                                ? `Enviar a ${detailBorrower.email}`
                                : 'Registra el correo del cliente para enviar el extracto'
                            }
                            className="inline-flex min-h-10 items-center justify-center rounded-lg border border-emerald-700 px-3 text-center text-sm font-semibold text-emerald-800 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {sendingStatementEmail
                              ? 'Enviando correo…'
                              : 'Enviar extracto por correo'}
                          </button>
                        )}
                        {!isLoanDetail && (
                          <Link
                            to={`${canManage ? '/admin' : '/cartera'}/prestamos/${loan.id}`}
                            className="inline-flex min-h-10 items-center justify-center rounded-lg border border-slate-300 px-3 text-center text-sm font-semibold text-slate-700 hover:bg-slate-50"
                          >
                            Ver detalle y cronograma
                          </Link>
                        )}
                        {canManage && (
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
                    {isLoanDetail ? (
                      <>
                        {pdfError && (
                          <p
                            role="alert"
                            className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
                          >
                            {pdfError}
                          </p>
                        )}
                        {statementEmailError && (
                          <p
                            role="alert"
                            className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
                          >
                            {statementEmailError}
                          </p>
                        )}
                        {statementEmailSuccess && (
                          <p
                            role="status"
                            className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
                          >
                            {statementEmailSuccess}
                          </p>
                        )}
                        {canManage && !detailBorrower?.email && (
                          <p className="text-sm text-slate-600">
                            El cliente no tiene correo registrado. Agrégalo en su perfil para enviarle el extracto.
                          </p>
                        )}
                        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                          <div className="rounded-lg bg-slate-50 p-3 text-sm">
                            <dt className="text-xs font-medium uppercase text-slate-500">
                              Monto prestado
                            </dt>
                            <dd className="mt-1 font-semibold text-slate-900">
                              {formatNumericAmount(loan.monto)}
                            </dd>
                          </div>
                          <div className="rounded-lg bg-slate-50 p-3 text-sm">
                            <dt className="text-xs font-medium uppercase text-slate-500">
                              Pagado neto a la fecha
                            </dt>
                            <dd className="mt-1 font-semibold text-slate-900">
                              {paidTotal === null
                                ? 'Monto inválido'
                                : formatMoney(paidTotal)}
                            </dd>
                          </div>
                          <div className="rounded-lg bg-slate-50 p-3 text-sm">
                            <dt className="text-xs font-medium uppercase text-slate-500">
                              % de interés
                            </dt>
                            <dd className="mt-1 font-semibold text-slate-900">
                              {formatInterestRate(loan.tasa_interes)}
                            </dd>
                          </div>
                          <div className="rounded-lg bg-slate-50 p-3 text-sm">
                            <dt className="text-xs font-medium uppercase text-slate-500">
                              Interés pagado a la fecha
                            </dt>
                            <dd className="mt-1 font-semibold text-slate-900">
                              {paidInterestTotal === null
                                ? 'Monto inválido'
                                : formatMoney(paidInterestTotal)}
                            </dd>
                          </div>
                          <div className="rounded-lg bg-slate-50 p-3 text-sm">
                            <dt className="text-xs font-medium uppercase text-slate-500">
                              Saldo pendiente
                            </dt>
                            <dd className="mt-1 font-semibold text-slate-900">
                              {pendingTotal === null
                                ? 'Monto inválido'
                                : formatMoney(pendingTotal)}
                            </dd>
                          </div>
                          <div className="rounded-lg bg-slate-50 p-3 text-sm">
                            <dt className="text-xs font-medium uppercase text-slate-500">
                              Cuotas pagadas a la fecha
                            </dt>
                            <dd className="mt-1 font-semibold text-slate-900">
                              {paidInstallmentCount}
                            </dd>
                          </div>
                          <div className="rounded-lg bg-slate-50 p-3 text-sm">
                            <dt className="text-xs font-medium uppercase text-slate-500">
                              Cuotas pendientes
                            </dt>
                            <dd className="mt-1 font-semibold text-slate-900">
                              {pendingInstallments.length}
                            </dd>
                          </div>
                          <div className="rounded-lg bg-slate-50 p-3 text-sm">
                            <dt className="text-xs font-medium uppercase text-slate-500">
                              Total de cuotas
                            </dt>
                            <dd className="mt-1 font-semibold text-slate-900">
                              {installments?.length ?? loan.numero_cuotas}
                            </dd>
                          </div>
                          <div className="rounded-lg bg-slate-50 p-3 text-sm">
                            <dt className="text-xs font-medium uppercase text-slate-500">
                              Fecha del préstamo
                            </dt>
                            <dd className="mt-1 font-semibold text-slate-900">
                              {formattedDate(loan.fecha_inicio)}
                            </dd>
                          </div>
                          <div className="rounded-lg bg-slate-50 p-3 text-sm sm:col-span-2">
                            <dt className="text-xs font-medium uppercase text-slate-500">
                              Vigencia (primera a última cuota)
                            </dt>
                            <dd className="mt-1 font-semibold text-slate-900">
                              {firstInstallmentDate && lastInstallmentDate
                                ? `${formattedDate(firstInstallmentDate)} – ${formattedDate(lastInstallmentDate)}`
                                : 'No disponible'}
                            </dd>
                          </div>
                          <div className="rounded-lg bg-slate-50 p-3 text-sm sm:col-span-2">
                            <dt className="text-xs font-medium uppercase text-slate-500">
                              Próximo vencimiento
                            </dt>
                            <dd className="mt-1 font-semibold text-slate-900">
                              {nextDueDate
                                ? formattedDate(nextDueDate)
                                : 'Sin pagos pendientes'}
                            </dd>
                          </div>
                        </dl>
                      </>
                    ) : (
                      <dl className="grid gap-3 rounded-xl bg-slate-50 p-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                        <div>
                          <dt className="text-xs font-medium uppercase text-slate-500">
                            Monto prestado
                          </dt>
                          <dd className="mt-1 font-semibold text-slate-900">
                            {formatNumericAmount(loan.monto)}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs font-medium uppercase text-slate-500">
                            Interés total
                          </dt>
                          <dd className="mt-1 font-semibold text-slate-900">
                            {formatInterestRate(loan.tasa_interes)}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs font-medium uppercase text-slate-500">
                            Cuotas
                          </dt>
                          <dd className="mt-1 font-semibold text-slate-900">
                            {loan.numero_cuotas}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-xs font-medium uppercase text-slate-500">
                            Vigencia
                          </dt>
                          <dd className="mt-1 text-slate-900">
                            {formattedDate(loan.fecha_inicio)} –{' '}
                            {formattedDate(loan.fecha_fin)}
                          </dd>
                        </div>
                      </dl>
                    )}
                  </div>
                  {isExpanded && (
                    <div className="mt-4 space-y-4">
                      {!installments || !payments ? (
                        <p className="px-4 py-3 text-sm text-slate-600">
                          Cargando cronograma e historial de pagos…
                        </p>
                      ) : installments.length === 0 ? (
                        <p className="px-4 py-3 text-sm text-amber-800">
                          Este préstamo no tiene cuotas asociadas.
                        </p>
                      ) : (
                        <>
                          {isLoanDetail && (
                            <h2 className="text-lg font-semibold text-slate-950">
                              Cronograma de pagos
                            </h2>
                          )}

                          <div className="space-y-3 md:hidden">
                            {installments.map((installment) => {
                              const paid = installment.estado === 'pagada'
                              const overdue =
                                !paid &&
                                installment.fecha_vencimiento <
                                  overdueAfterGraceDate
                              const isNext =
                                firstPendingInstallment?.id === installment.id
                              return (
                                <article
                                  key={installment.id}
                                  className="rounded-xl border border-slate-200 p-3"
                                >
                                  <div className="flex items-center justify-between gap-3">
                                    <h3
                                      className={`font-semibold ${
                                        paid
                                          ? 'text-slate-500 line-through'
                                          : 'text-slate-950'
                                      }`}
                                    >
                                      Cuota {installment.numero}
                                    </h3>
                                    <span
                                      className={`text-sm ${
                                        overdue
                                          ? 'font-semibold text-red-700'
                                          : 'text-slate-600'
                                      }`}
                                    >
                                      {paid
                                        ? 'Pagada'
                                        : overdue
                                          ? 'Vencida'
                                          : 'Pendiente'}
                                    </span>
                                  </div>
                                  <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
                                    <div>
                                      <dt className="text-xs text-slate-500">
                                        Vence
                                      </dt>
                                      <dd className="mt-1">
                                        {formattedDate(installment.fecha_vencimiento)}
                                      </dd>
                                    </div>
                                    <div>
                                      <dt className="text-xs text-slate-500">
                                        Total
                                      </dt>
                                      <dd className="mt-1 font-semibold">
                                        {formatNumericAmount(installment.monto)}
                                      </dd>
                                    </div>
                                    <div>
                                      <dt className="text-xs text-slate-500">
                                        Abono a capital
                                      </dt>
                                      <dd className="mt-1">
                                        {formatNumericAmount(installment.capital)}
                                      </dd>
                                    </div>
                                    <div>
                                      <dt className="text-xs text-slate-500">
                                        Interés
                                      </dt>
                                      <dd className="mt-1">
                                        {formatNumericAmount(installment.intereses)}
                                      </dd>
                                    </div>
                                  </dl>
                                  {canManage && isNext && (
                                    <div className="mt-3 grid gap-2">
                                      <button
                                        type="button"
                                        onClick={() =>
                                          choosePaymentAction({
                                            kind: 'register',
                                            loanId: loan.id,
                                            installmentId: installment.id,
                                            type: 'cuota_completa',
                                          })
                                        }
                                        className="min-h-11 rounded-lg bg-emerald-700 px-3 text-sm font-semibold text-white hover:bg-emerald-800"
                                      >
                                        Registrar pago completo
                                      </button>
                                      <button
                                        type="button"
                                        disabled={installment.intereses <= 0}
                                        onClick={() =>
                                          choosePaymentAction({
                                            kind: 'register',
                                            loanId: loan.id,
                                            installmentId: installment.id,
                                            type: 'solo_intereses',
                                          })
                                        }
                                        className="min-h-11 rounded-lg border border-emerald-700 px-3 text-sm font-semibold text-emerald-800 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
                                      >
                                        Pagar solo intereses y prorrogar
                                      </button>
                                    </div>
                                  )}
                                  {actionForLoan?.kind === 'register' &&
                                    actionForLoan.installmentId ===
                                      installment.id &&
                                    renderPaymentForm('mt-3 md:hidden')}
                                </article>
                              )
                            })}
                          </div>

                          <div className="hidden overflow-x-auto rounded-lg border border-slate-200 md:block">
                            <table className="w-full min-w-[760px] text-left text-sm">
                              <thead className="bg-slate-100 text-xs uppercase text-slate-600">
                                <tr>
                                  <th className="px-3 py-2">Cuota</th>
                                  <th className="px-3 py-2">Vence</th>
                                  <th className="px-3 py-2">Abono a capital</th>
                                  <th className="px-3 py-2">Interés</th>
                                  <th className="px-3 py-2">Total</th>
                                  <th className="px-3 py-2">Estado</th>
                                  {canManage && (
                                    <th className="px-3 py-2">Acciones</th>
                                  )}
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-100">
                                {installments.map((installment) => {
                                  const paid = installment.estado === 'pagada'
                                  const overdue =
                                    !paid &&
                                    installment.fecha_vencimiento <
                                      overdueAfterGraceDate
                                  const isNext =
                                    firstPendingInstallment?.id === installment.id
                                  return (
                                    <tr
                                      key={installment.id}
                                      className={paid ? 'bg-slate-50 text-slate-500' : ''}
                                    >
                                      <td className="px-3 py-2">
                                        <span className={paid ? 'line-through' : ''}>
                                          {installment.numero}
                                        </span>
                                      </td>
                                      <td className="px-3 py-2">
                                        {formattedDate(installment.fecha_vencimiento)}
                                      </td>
                                      <td className="px-3 py-2">
                                        {formatNumericAmount(installment.capital)}
                                      </td>
                                      <td className="px-3 py-2">
                                        {formatNumericAmount(installment.intereses)}
                                      </td>
                                      <td className="px-3 py-2 font-semibold">
                                        {formatNumericAmount(installment.monto)}
                                      </td>
                                      <td className="px-3 py-2">
                                        <span
                                          className={
                                            overdue
                                              ? 'font-semibold text-red-700'
                                              : ''
                                          }
                                        >
                                          {paid
                                            ? 'Pagada'
                                            : overdue
                                              ? 'Vencida'
                                              : 'Pendiente'}
                                        </span>
                                      </td>
                                      {canManage && (
                                        <td className="px-3 py-2">
                                          {isNext && (
                                            <div className="flex flex-col gap-2">
                                              <button
                                                type="button"
                                                onClick={() =>
                                                  choosePaymentAction({
                                                    kind: 'register',
                                                    loanId: loan.id,
                                                    installmentId: installment.id,
                                                    type: 'cuota_completa',
                                                  })
                                                }
                                                className="min-h-9 rounded-md bg-emerald-700 px-2 text-xs font-semibold text-white hover:bg-emerald-800"
                                              >
                                                Pago completo
                                              </button>
                                              <button
                                                type="button"
                                                disabled={installment.intereses <= 0}
                                                onClick={() =>
                                                  choosePaymentAction({
                                                    kind: 'register',
                                                    loanId: loan.id,
                                                    installmentId: installment.id,
                                                    type: 'solo_intereses',
                                                  })
                                                }
                                                className="min-h-9 rounded-md border border-emerald-700 px-2 text-xs font-semibold text-emerald-800 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50"
                                              >
                                                Solo interés + prórroga
                                              </button>
                                            </div>
                                          )}
                                        </td>
                                      )}
                                    </tr>
                                  )
                                })}
                              </tbody>
                            </table>
                          </div>
                        </>
                      )}

                      {isLoanDetail && loan.notas && (
                        <section className="rounded-xl bg-slate-50 p-4">
                          <h3 className="text-sm font-semibold text-slate-900">
                            Notas del préstamo
                          </h3>
                          <p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-700">
                            {loan.notas}
                          </p>
                        </section>
                      )}

                      {actionForLoan &&
                        (actionForLoan.kind === 'reverse'
                          ? renderPaymentForm('')
                          : renderPaymentForm('hidden md:block'))}

                      {paymentSuccess && (
                        <p
                          role="status"
                          className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
                        >
                          {paymentSuccess}
                        </p>
                      )}

                      {paymentEmailError && (
                        <p
                          role="alert"
                          className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
                        >
                          {paymentEmailError}
                        </p>
                      )}

                      {payments && (
                        <section className="overflow-hidden rounded-xl border border-slate-200">
                          <div className="border-b border-slate-200 px-4 py-3">
                            <h3 className="font-semibold text-slate-950">
                              Historial de pagos
                            </h3>
                          </div>
                          {payments.length === 0 ? (
                            <p className="px-4 py-5 text-sm text-slate-600">
                              No hay pagos registrados.
                            </p>
                          ) : (
                            <ul className="divide-y divide-slate-100">
                              {payments.map((payment) => {
                                const isReversed = reversedPaymentIds.has(
                                  payment.id,
                                )
                                const paymentInstallment = installments.find(
                                  (installment) =>
                                    installment.id === payment.cuota_id,
                                )
                                const paymentDescription = paymentInstallment
                                  ? `Cuota ${paymentInstallment.numero} · ${
                                      payment.tipo === 'cuota_completa'
                                        ? 'Pago completo'
                                        : payment.tipo === 'solo_intereses'
                                          ? 'Pago de intereses'
                                          : 'Ajuste / modificación'
                                    }`
                                  : paymentTypeLabel(payment.tipo)
                                const canReverse =
                                  canManage &&
                                  payment.id === payments[0]?.id &&
                                  payment.tipo !== 'ajuste' &&
                                  !isReversed
                                return (
                                  <li
                                    key={payment.id}
                                    className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
                                  >
                                    <div className="min-w-0">
                                      <p className="font-semibold text-slate-900">
                                        {paymentDescription}
                                        {payment.tipo === 'solo_intereses'
                                          ? ' · Prórroga de una semana'
                                          : ''}
                                        {isReversed ? ' · Revertido' : ''}
                                      </p>
                                      <p className="mt-1 text-sm text-slate-600">
                                        {formattedTimestamp(payment.pagado_en)}
                                      </p>
                                      {payment.notas && (
                                        <p className="mt-1 break-words text-sm text-slate-500">
                                          {payment.notas.replace(
                                            /^Reverso:\s*/i,
                                            'Modificación: ',
                                          )}
                                        </p>
                                      )}
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                      <span className="font-semibold text-slate-950">
                                        {formatSignedNumericAmount(payment.monto)}
                                      </span>
                                      {canReverse && (
                                        <button
                                          type="button"
                                          onClick={() =>
                                            choosePaymentAction({
                                              kind: 'reverse',
                                              loanId: loan.id,
                                              paymentId: payment.id,
                                            })
                                          }
                                          className="min-h-10 rounded-lg border border-red-300 px-3 text-sm font-semibold text-red-800 hover:bg-red-50"
                                        >
                                          Modificar
                                        </button>
                                      )}
                                    </div>
                                  </li>
                                )
                              })}
                            </ul>
                          )}
                        </section>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </main>
  )
}
