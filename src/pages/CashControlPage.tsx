import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  LabelList,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { useAuth } from '../auth/useAuth'
import {
  centsToDatabaseNumber,
  formatMoney,
  parseDecimalUnits,
  parseSignedDecimalUnits,
} from '../lib/loan-calculation'
import { supabase } from '../lib/supabase'

interface CashControl {
  cartera_id: string
  fecha_inicio: string
  iniciado_en: string
}

interface CashMovement {
  id: string
  tipo: string
  monto: number
  intereses: number
  descripcion: string
  created_at: string
}

type MovementFormType = 'gasto_personal' | 'ingreso_salario'

const timeZone = 'America/New_York'

function currentDateInTimeZone() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date())
  const part = (type: string) => parts.find((value) => value.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

function amountToCents(value: number) {
  const cents = parseSignedDecimalUnits(String(value), 2)
  if (cents === null) {
    throw new Error('El control de caja contiene un importe inválido.')
  }
  return cents
}

function movementLabel(type: string) {
  switch (type) {
    case 'saldo_inicial':
      return 'Saldo inicial'
    case 'pago_recibido':
      return 'Pago recibido'
    case 'reinversion_prestamo':
      return 'Reinversión en préstamo'
    case 'gasto_personal':
      return 'Gasto personal'
    case 'ingreso_salario':
      return 'Ingreso proveniente de salario'
    case 'reversion_pago_prueba':
      return 'Reversión de pago de prueba'
    case 'reversion_prestamo_prueba':
      return 'Reversión de desembolso de prueba'
    default:
      return 'Movimiento'
  }
}

function monthKey(timestamp: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date(timestamp))
  const part = (type: string) => parts.find((value) => value.type === type)?.value
  return `${part('year')}-${part('month')}`
}

function recentMonthKeys(count: number) {
  const today = currentDateInTimeZone()
  const [year, month] = today.split('-').map(Number)
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(Date.UTC(year, month - 1 - (count - index - 1), 1))
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
  })
}

function displayTimestamp(timestamp: string) {
  return new Intl.DateTimeFormat('es-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  }).format(new Date(timestamp))
}

function signedMoney(value: number) {
  return formatMoney(amountToCents(value))
}

export function CashControlPage() {
  const { profile } = useAuth()
  const [control, setControl] = useState<CashControl | null>(null)
  const [movements, setMovements] = useState<CashMovement[]>([])
  const [movementType, setMovementType] =
    useState<MovementFormType>('gasto_personal')
  const [movementAmount, setMovementAmount] = useState('')
  const [description, setDescription] = useState('')
  const [period, setPeriod] = useState(1)
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    if (!supabase) {
      setErrorMessage('La conexión con Supabase no está configurada.')
      setLoading(false)
      return
    }

    setLoading(true)
    setErrorMessage(null)
    try {
      const { data: wallet, error: walletError } = await supabase
        .from('carteras')
        .select('id')
        .eq('clave', 'y')
        .maybeSingle()
      if (walletError) throw walletError
      if (!wallet) {
        throw new Error('No se encontró la cartera de Mariluz.')
      }

      const { data: controlData, error: controlError } = await supabase
        .from('control_caja')
        .select('cartera_id, fecha_inicio, iniciado_en')
        .eq('cartera_id', wallet.id)
        .maybeSingle()
      if (controlError) throw controlError
      setControl(controlData)

      if (!controlData) {
        setMovements([])
        return
      }

      const { data: movementData, error: movementError } = await supabase
        .from('movimientos_caja')
        .select('id, tipo, monto, intereses, descripcion, created_at')
        .eq('cartera_id', wallet.id)
        .gte('created_at', controlData.iniciado_en)
        .order('created_at', { ascending: false })
        .limit(5000)
      if (movementError) throw movementError
      setMovements(movementData ?? [])
    } catch (error) {
      console.error('No se pudo cargar el control financiero.', error)
      setErrorMessage(
        'No fue posible cargar el tablero financiero. Verifica las migraciones y permisos de Supabase.',
      )
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    queueMicrotask(() => void loadData())
  }, [loadData])

  const totals = useMemo(() => {
    const result = {
      balance: 0n,
      payments: 0n,
      interest: 0n,
      salary: 0n,
      reinvested: 0n,
      expenses: 0n,
    }

    for (const movement of movements) {
      const amount = amountToCents(movement.monto)
      const interest = amountToCents(movement.intereses)
      result.balance += amount

      if (
        movement.tipo === 'pago_recibido' ||
        movement.tipo === 'reversion_pago_prueba'
      ) {
        result.payments += amount
        result.interest += interest
      } else if (movement.tipo === 'ingreso_salario') {
        result.salary += amount
      } else if (
        movement.tipo === 'reinversion_prestamo' ||
        movement.tipo === 'reversion_prestamo_prueba'
      ) {
        result.reinvested -= amount
      } else if (movement.tipo === 'gasto_personal') {
        result.expenses -= amount
      }
    }

    return result
  }, [movements])

  const monthKeys = useMemo(() => recentMonthKeys(period), [period])
  const chartData = useMemo(() => {
    const includedMonths = new Set(monthKeys)
    const totalsByCategory = new Map([
      ['pago_recibido', 0n],
      ['ingreso_salario', 0n],
      ['reinversion_prestamo', 0n],
      ['gasto_personal', 0n],
    ])

    for (const movement of movements) {
      if (!includedMonths.has(monthKey(movement.created_at))) continue
      if (movement.tipo === 'pago_recibido' || movement.tipo === 'reversion_pago_prueba') {
        totalsByCategory.set(
          'pago_recibido',
          (totalsByCategory.get('pago_recibido') ?? 0n) +
            amountToCents(movement.monto),
        )
      } else if (movement.tipo === 'ingreso_salario') {
        totalsByCategory.set(
          'ingreso_salario',
          (totalsByCategory.get('ingreso_salario') ?? 0n) +
            amountToCents(movement.monto),
        )
      } else if (
        movement.tipo === 'reinversion_prestamo' ||
        movement.tipo === 'reversion_prestamo_prueba'
      ) {
        totalsByCategory.set(
          'reinversion_prestamo',
          (totalsByCategory.get('reinversion_prestamo') ?? 0n) -
            amountToCents(movement.monto),
        )
      } else if (movement.tipo === 'gasto_personal') {
        totalsByCategory.set(
          'gasto_personal',
          (totalsByCategory.get('gasto_personal') ?? 0n) -
            amountToCents(movement.monto),
        )
      }
    }

    return [
      {
        name: 'Pagos recibidos',
        value: Number(totalsByCategory.get('pago_recibido') ?? 0n) / 100,
        color: '#047857',
      },
      {
        name: 'Ingresos provenientes de salario',
        value: Number(totalsByCategory.get('ingreso_salario') ?? 0n) / 100,
        color: '#2563eb',
      },
      {
        name: 'Reinversión en préstamos',
        value: Number(totalsByCategory.get('reinversion_prestamo') ?? 0n) / 100,
        color: '#9333ea',
      },
      {
        name: 'Gastos personales',
        value: Number(totalsByCategory.get('gasto_personal') ?? 0n) / 100,
        color: '#f97316',
      },
    ]
  }, [monthKeys, movements])
  const doughnutData = useMemo(
    () => chartData.filter((category) => category.value > 0),
    [chartData],
  )

  async function handleStartControl() {
    if (!supabase) {
      setErrorMessage('La conexión con Supabase no está configurada.')
      return
    }
    setSubmitting(true)
    setErrorMessage(null)
    setSuccessMessage(null)
    try {
      const { error } = await supabase.rpc('iniciar_control_caja')
      if (error) throw error
      setSuccessMessage('Control financiero iniciado sin saldo inicial.')
      await loadData()
    } catch (error) {
      console.error('No se pudo iniciar el control financiero.', error)
      setErrorMessage(
        'No se pudo iniciar el control financiero. Verifica si ya está iniciado.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  async function handleResetControl() {
    if (!supabase) {
      setErrorMessage('La conexión con Supabase no está configurada.')
      return
    }
    if (
      !window.confirm(
        'Esto borrará de forma permanente los movimientos del control financiero de Mariluz y permitirá iniciarlo desde cero. ¿Quieres continuar?',
      )
    ) {
      return
    }

    setSubmitting(true)
    setErrorMessage(null)
    setSuccessMessage(null)
    try {
      const { error } = await supabase.rpc('reiniciar_control_caja')
      if (error) throw error
      setSuccessMessage('El control financiero se reinició.')
      await loadData()
    } catch (error) {
      console.error('No se pudo reiniciar el control financiero.', error)
      setErrorMessage('No se pudo reiniciar el control financiero.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleMovementSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) {
      setErrorMessage('La conexión con Supabase no está configurada.')
      return
    }
    const cents = parseDecimalUnits(movementAmount, 2)
    if (cents === null || cents === 0n || description.trim().length === 0) {
      setErrorMessage('Ingresa un monto válido y una descripción del movimiento.')
      return
    }
    if (cents < 0n) {
      setErrorMessage('Ingresa el monto como un valor positivo.')
      return
    }

    setSubmitting(true)
    setErrorMessage(null)
    setSuccessMessage(null)
    try {
      const { error } = await supabase.rpc('registrar_movimiento_caja', {
        p_tipo: movementType,
        p_monto: centsToDatabaseNumber(cents),
        p_descripcion: description.trim(),
      })
      if (error) throw error
      setMovementAmount('')
      setDescription('')
      setSuccessMessage('Movimiento agregado al control financiero.')
      await loadData()
    } catch (error) {
      console.error('No se pudo guardar el movimiento financiero.', error)
      setErrorMessage(
        'No se pudo registrar el movimiento. Revisa el saldo disponible y vuelve a intentarlo.',
      )
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-emerald-800">
            Solo administrador · Cartera Mariluz
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-slate-950">
            Control financiero
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            Sigue los pagos recibidos, el dinero reinvertido en préstamos y los
            gastos. El saldo empieza en cero al iniciar el control; los
            movimientos financieros se registran desde ese momento.
          </p>
        </div>
        {control ? (
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm font-medium text-slate-700">
              Periodo
              <select
                value={period}
                onChange={(event) => setPeriod(Number(event.target.value))}
                className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base"
              >
                <option value={1}>Último mes</option>
                <option value={3}>Últimos 3 meses</option>
                <option value={6}>Últimos 6 meses</option>
                <option value={12}>Últimos 12 meses</option>
              </select>
            </label>
            <button
              type="button"
              disabled={submitting || profile?.role !== 'admin'}
              onClick={() => void handleResetControl()}
              className="min-h-11 rounded-lg border border-red-300 px-4 py-2 text-sm font-semibold text-red-800 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Reiniciar y volver a iniciar
            </button>
          </div>
        ) : null}
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

      {loading ? (
        <p className="mt-8 text-sm text-slate-600">Cargando el control financiero…</p>
      ) : !control ? (
        <section className="mt-8 max-w-2xl rounded-2xl border border-amber-200 bg-amber-50 p-5 sm:p-6">
          <h2 className="text-lg font-semibold text-slate-950">
            Iniciar el control financiero
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-700">
            El control comienza sin saldo inicial. Desde este momento, los
            pagos, ingresos de salario, gastos y nuevos desembolsos de Mariluz
            se reflejarán automáticamente. Los préstamos creados antes de
            iniciarlo no se incluirán en el saldo inicial del control.
          </p>
          <p className="mt-2 text-xs text-slate-600">
            Fecha de inicio: {currentDateInTimeZone()} (hoy)
          </p>
          <button
            type="button"
            disabled={submitting || profile?.role !== 'admin'}
            onClick={() => void handleStartControl()}
            className="mt-5 min-h-11 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? 'Iniciando…' : 'Iniciar control financiero'}
          </button>
        </section>
      ) : (
        <>
          <section className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {[
              { label: 'Saldo disponible', value: formatMoney(totals.balance), primary: true },
              { label: 'Pagos recibidos', value: formatMoney(totals.payments) },
              {
                label: 'Intereses recibidos',
                value: formatMoney(totals.interest),
              },
              {
                label: 'Ingresos provenientes de salario',
                value: formatMoney(totals.salary),
              },
              {
                label: 'Dinero reinvertido',
                value: formatMoney(totals.reinvested),
              },
              {
                label: 'Gastos personales',
                value: formatMoney(totals.expenses),
              },
            ].map((card) => (
              <article
                key={card.label}
                className={`rounded-2xl border p-5 shadow-sm ${
                  card.primary
                    ? 'border-emerald-800 bg-emerald-800 text-white'
                    : 'border-slate-200 bg-white text-slate-950'
                }`}
              >
                <p
                  className={`text-sm ${
                    card.primary ? 'text-emerald-100' : 'text-slate-600'
                  }`}
                >
                  {card.label}
                </p>
                <p className="mt-2 text-2xl font-semibold">{card.value}</p>
              </article>
            ))}
          </section>

          <section className="mt-7 grid gap-5 lg:grid-cols-[1.4fr_1fr]">
            <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-950">
                Entradas y usos del dinero
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Totales del periodo seleccionado. La escala muestra importes en
                dólares, no porcentajes.
              </p>
              <div className="mt-5 h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart
                    data={chartData}
                    layout="vertical"
                    margin={{ top: 8, right: 100, left: 0, bottom: 8 }}
                    barCategoryGap={16}
                  >
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                    <XAxis type="number" hide />
                    <YAxis type="category" dataKey="name" hide />
                    <Tooltip
                      formatter={(value) => [
                        formatMoney(BigInt(Math.round(Number(value) * 100))),
                      ]}
                    />
                    <Bar dataKey="value" maxBarSize={40} radius={[0, 6, 6, 0]}>
                      {chartData.map((item) => (
                        <Cell key={item.name} fill={item.color} />
                      ))}
                      <LabelList
                        dataKey="name"
                        position="insideLeft"
                        fill="#ffffff"
                        fontSize={12}
                        fontWeight={600}
                      />
                      <LabelList
                        dataKey="value"
                        position="right"
                        formatter={(value) =>
                          formatMoney(BigInt(Math.round(Number(value) * 100)))
                        }
                        fill="#0f172a"
                        fontSize={12}
                        fontWeight={600}
                      />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </article>
            <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-950">
                Distribución del periodo
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Pagos, salario, reinversión y gastos del periodo seleccionado.
              </p>
              {doughnutData.length === 0 ? (
                <div className="mt-5 flex h-80 items-center justify-center rounded-xl bg-slate-50 text-center text-sm text-slate-500">
                  Aún no hay movimientos en este periodo.
                </div>
              ) : (
                <div className="mt-3 h-80">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={doughnutData}
                        dataKey="value"
                        nameKey="name"
                        cx="50%"
                        cy="46%"
                        innerRadius="55%"
                        outerRadius="78%"
                        paddingAngle={3}
                        cornerRadius={5}
                        stroke="#ffffff"
                        strokeWidth={3}
                      >
                        {doughnutData.map((item) => (
                          <Cell key={item.name} fill={item.color} />
                        ))}
                      </Pie>
                      <Tooltip
                        formatter={(value) => [
                          formatMoney(BigInt(Math.round(Number(value) * 100))),
                        ]}
                      />
                      <Legend
                        verticalAlign="bottom"
                        iconType="circle"
                        iconSize={8}
                        wrapperStyle={{ fontSize: '12px' }}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
            </article>
          </section>

          <section className="mt-7 grid gap-5 lg:grid-cols-2">
            <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-950">
                Registrar gasto o ingreso de salario
              </h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Los gastos se descuentan del saldo disponible. El ingreso de
                salario se agrega para poder usarlo en nuevos préstamos.
              </p>
              <form
                onSubmit={(event) => void handleMovementSubmit(event)}
                className="mt-5 space-y-4"
              >
                <label className="block text-sm font-medium text-slate-800">
                  Tipo de movimiento
                  <select
                    value={movementType}
                    onChange={(event) =>
                      setMovementType(event.target.value as MovementFormType)
                    }
                    className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base"
                  >
                    <option value="gasto_personal">Gasto personal</option>
                    <option value="ingreso_salario">
                      Ingreso proveniente de salario
                    </option>
                  </select>
                </label>
                <label className="block text-sm font-medium text-slate-800">
                  {movementType === 'gasto_personal'
                    ? 'Monto del gasto (USD)'
                    : 'Monto del salario (USD)'}
                  <input
                    required
                    type="number"
                    min="0.01"
                    max="9999999999.99"
                    step="0.01"
                    value={movementAmount}
                    onChange={(event) => setMovementAmount(event.target.value)}
                    className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base"
                  />
                </label>
                <label className="block text-sm font-medium text-slate-800">
                  Anotación / motivo
                  <textarea
                    required
                    rows={3}
                    maxLength={500}
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    className="mt-2 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base"
                  />
                </label>
                <button
                  type="submit"
                  disabled={submitting}
                  className="min-h-11 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {submitting ? 'Guardando…' : 'Agregar movimiento'}
                </button>
              </form>
            </article>

            <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <h2 className="text-lg font-semibold text-slate-950">
                    Movimientos recientes
                  </h2>
                  <p className="mt-1 text-sm text-slate-600">
                    Inicio del control: {control.fecha_inicio}
                  </p>
                </div>
                <span className="text-sm font-semibold text-slate-700">
                  {formatMoney(totals.balance)} disponible
                </span>
              </div>
              {movements.length === 0 ? (
                <p className="mt-6 text-sm text-slate-600">
                  Todavía no hay movimientos registrados.
                </p>
              ) : (
                <ul className="mt-4 max-h-[28rem] divide-y divide-slate-100 overflow-y-auto">
                  {movements.slice(0, 100).map((movement) => (
                    <li
                      key={movement.id}
                      className="flex items-start justify-between gap-4 py-3"
                    >
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-slate-900">
                          {movementLabel(movement.tipo)}
                        </p>
                        <p className="mt-0.5 break-words text-sm text-slate-600">
                          {movement.descripcion}
                        </p>
                        <time className="mt-1 block text-xs text-slate-500">
                          {displayTimestamp(movement.created_at)}
                        </time>
                      </div>
                      <span
                        className={`shrink-0 text-sm font-semibold ${
                          movement.monto < 0 ? 'text-red-700' : 'text-emerald-800'
                        }`}
                      >
                        {signedMoney(movement.monto)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          </section>
        </>
      )}
    </main>
  )
}
