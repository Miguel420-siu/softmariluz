import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { formatUsPhone } from '../lib/us-phone'
import { formatMoney, parseDecimalUnits } from '../lib/loan-calculation'
import {
  generateClientLoanPdf,
  type PdfInstallment,
  type PdfPayment,
} from '../lib/pdf-reports'
import { supabase } from '../lib/supabase'

interface BorrowerProfile {
  id: string
  cartera_id: string
  nombre: string
  identificacion: string
  email: string | null
  telefono: string | null
  direccion: string | null
  apartamento: string | null
  ciudad: string | null
  estado: string | null
  codigo_postal: string | null
  referido_por: string | null
  documento_path: string | null
}

interface BorrowerLoan {
  id: string
  codigo: string
  monto: number
  tasa_interes: number
  numero_cuotas: number
  fecha_inicio: string
  fecha_fin: string
  estado: string
}

function formatInterestRate(value: number) {
  return `${Math.round(value)}%`
}

function formattedDate(date: string) {
  return new Intl.DateTimeFormat('es-US', {
    dateStyle: 'medium',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`))
}

export function BorrowerProfilePage() {
  const { profile } = useAuth()
  const { deudorId } = useParams()
  const [borrower, setBorrower] = useState<BorrowerProfile | null>(null)
  const [loans, setLoans] = useState<BorrowerLoan[]>([])
  const [loading, setLoading] = useState(true)
  const [generatingPdfLoanId, setGeneratingPdfLoanId] = useState<string | null>(
    null,
  )
  const [pdfError, setPdfError] = useState<string | null>(null)
  const [signedDocument, setSignedDocument] = useState<string | null>(null)
  const [openingDocument, setOpeningDocument] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const isAdmin = profile?.role === 'admin'
  const basePath = isAdmin ? '/admin' : '/cartera'

  async function openIdentityDocument() {
    if (!supabase || !borrower?.documento_path) return
    setOpeningDocument(true)
    setSignedDocument(null)
    setErrorMessage(null)
    try {
      const { data, error } = await supabase.storage
        .from('documentos-identidad')
        .createSignedUrl(borrower.documento_path, 120)
      if (error) throw error
      setSignedDocument(data.signedUrl)
    } catch (error) {
      console.error('No se pudo crear el enlace temporal del documento.', error)
      setErrorMessage(
        'No fue posible abrir el documento. Revisa el acceso a Storage y la política RLS.',
      )
    } finally {
      setOpeningDocument(false)
    }
  }

  async function generateLoanStatement(loan: BorrowerLoan) {
    if (!supabase || !borrower) return
    setGeneratingPdfLoanId(loan.id)
    setPdfError(null)
    try {
      const [installmentResult, paymentResult] = await Promise.all([
        supabase
          .from('cuotas')
          .select(
            'prestamo_id, numero, fecha_vencimiento, capital, intereses, monto, estado',
          )
          .eq('prestamo_id', loan.id)
          .order('numero'),
        supabase
          .from('pagos')
          .select('prestamo_id, monto, pagado_en, notas')
          .eq('prestamo_id', loan.id)
          .order('pagado_en'),
      ])
      if (installmentResult.error) throw installmentResult.error
      if (paymentResult.error) throw paymentResult.error

      await generateClientLoanPdf(
        borrower,
        {
          ...loan,
         codigo: loan.codigo,
         cartera_id: borrower.cartera_id,
          deudor_id: borrower.id,
        },
        (installmentResult.data ?? []) as PdfInstallment[],
        (paymentResult.data ?? []) as PdfPayment[],
      )
    } catch (error) {
      console.error('No se pudo generar el estado de cuenta del préstamo.', error)
      setPdfError('No fue posible generar el PDF de este préstamo. Inténtalo de nuevo.')
    } finally {
      setGeneratingPdfLoanId(null)
    }
  }

  useEffect(() => {
    let active = true
    async function loadProfile() {
      if (!supabase || !deudorId) {
        setErrorMessage('No se pudo identificar al deudor solicitado.')
        setLoading(false)
        return
      }

      setLoading(true)
      setErrorMessage(null)
      const { data: borrowerData, error: borrowerError } = await supabase
        .from('deudores')
        .select(
          'id, cartera_id, nombre, identificacion, email, telefono, direccion, apartamento, ciudad, estado, codigo_postal, referido_por, documento_path',
        )
        .eq('id', deudorId)
        .maybeSingle()

      if (!active) return
      if (borrowerError) {
        console.error('No se pudo cargar el perfil del deudor.', borrowerError)
        setErrorMessage('No fue posible cargar el perfil del deudor.')
        setLoading(false)
        return
      }
      if (!borrowerData) {
        setErrorMessage('No se encontró el deudor o no tienes acceso a su cartera.')
        setLoading(false)
        return
      }

      setBorrower(borrowerData as BorrowerProfile)
      const { data: loanData, error: loanError } = await supabase
        .from('prestamos')
        .select('id, codigo, monto, tasa_interes, numero_cuotas, fecha_inicio, fecha_fin, estado')
        .eq('deudor_id', deudorId)
        .order('created_at', { ascending: false })
        .limit(100)

      if (!active) return
      if (loanError) {
        console.error('No se pudieron cargar los préstamos del deudor.', loanError)
        setErrorMessage(
          'Se cargó el perfil, pero no fue posible consultar sus préstamos.',
        )
      } else {
        setLoans((loanData ?? []) as BorrowerLoan[])
      }
      setLoading(false)
    }

    void loadProfile()
    return () => {
      active = false
    }
  }, [deudorId])

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
      <Link
        to={`${basePath}/deudores`}
        className="text-sm font-semibold text-emerald-800 underline underline-offset-4"
      >
        Volver a deudores
      </Link>

      {errorMessage && (
        <p
          role="alert"
          className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
        >
          {errorMessage}
        </p>
      )}
      {loading ? (
        <p className="mt-6 text-sm text-slate-600">Cargando perfil…</p>
      ) : borrower ? (
        <>
          <div className="mt-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-emerald-700">
                Perfil del deudor
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
                {borrower.nombre}
              </h1>
              <p className="mt-2 text-sm text-slate-600">
                Identificación: {borrower.identificacion}
              </p>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              {isAdmin && (
                <Link
                  to={`/admin/prestamos?deudor=${borrower.id}`}
                  className="inline-flex min-h-11 items-center justify-center rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800"
                >
                  Crear préstamo
                </Link>
              )}
            </div>
          </div>

          {pdfError && (
            <p
              role="alert"
              className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
            >
              {pdfError}
            </p>
          )}
          <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
            <h2 className="font-semibold text-slate-950">Información de contacto</h2>
            <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <dt className="text-xs font-medium uppercase text-slate-500">
                  Correo electrónico
                </dt>
                <dd className="mt-1 break-words text-sm text-slate-900">
                  {borrower.email || 'Sin correo registrado'}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase text-slate-500">
                  Teléfono
                </dt>
                <dd className="mt-1 text-sm text-slate-900">
                  {formatUsPhone(borrower.telefono) || 'Sin teléfono'}
                </dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-xs font-medium uppercase text-slate-500">
                  Dirección
                </dt>
                <dd className="mt-1 break-words text-sm text-slate-900">
                  {borrower.direccion || 'Sin dirección registrada'}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase text-slate-500">
                  Casa o apartamento
                </dt>
                <dd className="mt-1 text-sm text-slate-900">
                  {borrower.apartamento || 'No registrado'}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase text-slate-500">
                  Ciudad
                </dt>
                <dd className="mt-1 text-sm text-slate-900">
                  {borrower.ciudad || 'No registrada'}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase text-slate-500">
                  Estado
                </dt>
                <dd className="mt-1 text-sm text-slate-900">
                  {borrower.estado || 'No registrado'}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase text-slate-500">
                  Código postal
                </dt>
                <dd className="mt-1 text-sm text-slate-900">
                  {borrower.codigo_postal || 'No registrado'}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase text-slate-500">
                  Referido por
                </dt>
                <dd className="mt-1 text-sm text-slate-900">
                  {borrower.referido_por || 'No registrado'}
                </dd>
              </div>
            </dl>
            {borrower.documento_path && (
              <div className="mt-5 border-t border-slate-200 pt-4">
                <h3 className="text-sm font-semibold text-slate-900">
                  Documento de identidad
                </h3>
                <button
                  type="button"
                  onClick={() => void openIdentityDocument()}
                  disabled={openingDocument}
                  className="mt-2 inline-flex min-h-10 items-center justify-center rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-wait disabled:opacity-60"
                >
                  {openingDocument ? 'Preparando documento…' : 'Ver documento'}
                </button>
                {signedDocument && (
                  <p className="mt-2 text-sm text-slate-600">
                    Enlace privado válido por 2 minutos.{' '}
                    <a
                      href={signedDocument}
                      target="_blank"
                      rel="noreferrer"
                      className="font-semibold text-emerald-800 underline underline-offset-2"
                    >
                      Abrir documento
                    </a>
                  </p>
                )}
              </div>
            )}
          </section>

          <section className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-200 px-4 py-4 sm:px-5">
              <h2 className="font-semibold text-slate-950">
                Préstamos ({loans.length})
              </h2>
            </div>
            {loans.length === 0 ? (
              <p className="px-5 py-6 text-sm text-slate-600">
                Este deudor todavía no tiene préstamos registrados.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100">
                {loans.map((loan) => {
                  const cents = parseDecimalUnits(String(loan.monto), 2)
                  return (
                    <li
                      key={loan.id}
                      className="flex flex-col gap-3 px-4 py-4 sm:px-5"
                    >
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                        <h3 className="font-semibold text-slate-950">
                          Préstamo
                        </h3>
                        <span className="w-fit rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold capitalize text-slate-700">
                          {loan.estado}
                        </span>
                      </div>
                      <dl className="grid gap-3 rounded-xl bg-slate-50 p-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
                        <div>
                          <dt className="text-xs font-medium uppercase text-slate-500">
                            Monto prestado
                          </dt>
                          <dd className="mt-1 font-semibold text-slate-900">
                            {cents === null ? 'Monto inválido' : formatMoney(cents)}
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
                          <dd className="mt-1 text-slate-900">
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
                      <Link
                        to={`${basePath}/prestamos/${loan.id}`}
                        className="inline-flex min-h-10 items-center justify-center rounded-lg border border-emerald-700 px-3 text-center text-sm font-semibold text-emerald-800 hover:bg-emerald-50"
                      >
                        Ver información y cronograma
                      </Link>
                      {loan.estado !== 'terminado' && (
                        <button
                          type="button"
                          onClick={() => void generateLoanStatement(loan)}
                          disabled={generatingPdfLoanId !== null}
                          className="inline-flex min-h-10 items-center justify-center rounded-lg bg-emerald-700 px-3 text-center text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-wait disabled:opacity-60"
                        >
                          {generatingPdfLoanId === loan.id
                            ? 'Generando PDF…'
                            : 'Descargar estado de cuenta'}
                        </button>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </main>
  )
}
