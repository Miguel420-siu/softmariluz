import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/useAuth'
import { useWalletFilter } from '../hooks/useWalletFilter'
import { formatUsPhone, formatUsPhoneInput, phoneDigits } from '../lib/us-phone'
import { supabase } from '../lib/supabase'

interface Wallet {
  id: string
  clave: string
  nombre: string
}

interface Borrower {
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

interface BorrowerFormValues {
  nombre: string
  identificacion: string
  email: string
  telefono: string
  direccion: string
  apartamento: string
  ciudad: string
  estado: string
  codigo_postal: string
  referido_por: string
}

const emptyValues: BorrowerFormValues = {
  nombre: '',
  identificacion: '',
  email: '',
  telefono: '',
  direccion: '',
  apartamento: '',
  ciudad: '',
  estado: '',
  codigo_postal: '',
  referido_por: '',
}

function optionalValue(value: string) {
  return value.trim() || null
}

function isDuplicateBorrowerError(error: unknown) {
  if (typeof error !== 'object' || error === null) return false

  const details = [
    'code' in error && typeof error.code === 'string' ? error.code : '',
    'message' in error && typeof error.message === 'string'
      ? error.message
      : '',
    'details' in error && typeof error.details === 'string'
      ? error.details
      : '',
  ]
    .join(' ')
    .toLowerCase()

  return (
    details.includes('23505') ||
    details.includes('deudores_cartera_identificacion_unique') ||
    details.includes('deudores_cartera_email_unique') ||
    details.includes('deudores_cartera_telefono_unique')
  )
}

async function prepareIdentityDocument(file: File) {
  if (file.type === 'application/pdf') return file

  if (!file.type.startsWith('image/')) {
    throw new Error('El documento debe ser una imagen o un PDF.')
  }

  const image = await createImageBitmap(file)
  const maxDimension = 1800
  const scale = Math.min(1, maxDimension / Math.max(image.width, image.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(image.width * scale))
  canvas.height = Math.max(1, Math.round(image.height * scale))
  const context = canvas.getContext('2d')
  if (!context) {
    image.close()
    throw new Error('No fue posible preparar la imagen del documento.')
  }

  context.drawImage(image, 0, 0, canvas.width, canvas.height)
  image.close()

  const compressed = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/webp', 0.82),
  )
  if (!compressed) {
    throw new Error('No fue posible comprimir la imagen del documento.')
  }
  if (compressed.size > 5 * 1024 * 1024) {
    throw new Error('La imagen comprimida supera el límite de 5 MiB.')
  }

  return compressed
}

function Field({
  label,
  name,
  value,
  onChange,
  required = false,
  type = 'text',
  autoComplete,
  maxLength,
  pattern,
  placeholder,
}: {
  label: string
  name: keyof BorrowerFormValues
  value: string
  onChange: (name: keyof BorrowerFormValues, value: string) => void
  required?: boolean
  type?: string
  autoComplete?: string
  maxLength?: number
  pattern?: string
  placeholder?: string
}) {
  return (
    <label className="block text-sm font-medium text-slate-800">
      {label}
      <input
        name={name}
        type={type}
        autoComplete={autoComplete}
        maxLength={maxLength}
        pattern={pattern}
        placeholder={placeholder}
        required={required}
        value={value}
        onChange={(event) => onChange(name, event.target.value)}
        className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base font-normal text-slate-950 outline-none focus:border-emerald-700 focus:ring-2 focus:ring-emerald-700/15"
      />
    </label>
  )
}

export function BorrowersPage() {
  const { profile } = useAuth()
  const canManage = profile?.role === 'admin'
  const [wallets, setWallets] = useState<Wallet[]>([])
  const [borrowers, setBorrowers] = useState<Borrower[]>([])
  const [walletFilter, setWalletFilter] = useWalletFilter(
    canManage,
    profile?.carteraId,
  )
  const [formWalletId, setFormWalletId] = useState('')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Borrower | null>(null)
  const [values, setValues] = useState(emptyValues)
  const [document, setDocument] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [deletingBorrowerId, setDeletingBorrowerId] = useState<string | null>(null)
  const [reloadCounter, setReloadCounter] = useState(0)
  const formSectionRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (!formOpen) return
    const frame = window.requestAnimationFrame(() => {
      formSectionRef.current?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [formOpen])

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
      if (canManage) {
        const { data, error } = await supabase
          .from('carteras')
          .select('id, clave, nombre')
          .order('nombre')
        if (error) throw error
        permittedWallets = data ?? []
        setWallets(permittedWallets)
        if (!formWalletId && permittedWallets[0]) {
          setFormWalletId(walletFilter || permittedWallets[0].id)
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

      const { data, error } = await supabase
        .from('deudores')
        .select(
          'id, cartera_id, nombre, identificacion, email, telefono, direccion, apartamento, ciudad, estado, codigo_postal, referido_por, documento_path',
        )
        .order('nombre')
        .limit(500)
      if (error) throw error

      setBorrowers((data ?? []) as Borrower[])
    } catch (error) {
      console.error('No se pudieron cargar los deudores.', error)
      setErrorMessage(
        'No fue posible cargar los deudores. Revisa la conexión y las políticas RLS de Supabase.',
      )
    } finally {
      setLoading(false)
    }
  }, [canManage, formWalletId, profile, walletFilter])

  useEffect(() => {
    queueMicrotask(() => void loadData())
  }, [loadData, reloadCounter])

  function updateValue(name: keyof BorrowerFormValues, value: string) {
    if (name === 'telefono') value = formatUsPhoneInput(value)
    setValues((current) => ({ ...current, [name]: value }))
  }

  function beginCreate() {
    setEditing(null)
    setValues(emptyValues)
    setDocument(null)
    setErrorMessage(null)
    setSuccessMessage(null)
    setFormOpen(true)
  }

  function beginEdit(borrower: Borrower) {
    setEditing(borrower)
    setFormWalletId(borrower.cartera_id)
    setValues({
      nombre: borrower.nombre,
      identificacion: borrower.identificacion,
      email: borrower.email ?? '',
      telefono: formatUsPhoneInput(borrower.telefono ?? ''),
      direccion: borrower.direccion ?? '',
      apartamento: borrower.apartamento ?? '',
      ciudad: borrower.ciudad ?? '',
      estado: borrower.estado ?? '',
      codigo_postal: borrower.codigo_postal ?? '',
      referido_por: borrower.referido_por ?? '',
    })
    setDocument(null)
    setErrorMessage(null)
    setSuccessMessage(null)
    setFormOpen(true)
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!supabase) {
      setErrorMessage('La conexión con Supabase no está configurada.')
      return
    }
    if (!formWalletId) {
      setErrorMessage('Selecciona una cartera para este deudor.')
      return
    }
    if (document && document.size > 10 * 1024 * 1024) {
      setErrorMessage('El archivo original supera el límite de 10 MiB.')
      return
    }
    if (phoneDigits(values.telefono).length !== 10) {
      setErrorMessage('El teléfono debe tener exactamente 10 dígitos de Estados Unidos.')
      return
    }

    setBusy(true)
    setErrorMessage(null)
    setSuccessMessage(null)
    let borrowerId = editing?.id
    let borrowerPersisted = Boolean(editing)
    let saveNotice = editing ? 'Deudor actualizado.' : 'Deudor creado.'

    const payload = {
      cartera_id: formWalletId,
      nombre: values.nombre.trim(),
      identificacion: values.identificacion.trim(),
      email: optionalValue(values.email)?.toLowerCase() ?? null,
      telefono: phoneDigits(values.telefono),
      direccion: optionalValue(values.direccion),
      apartamento: optionalValue(values.apartamento),
      ciudad: optionalValue(values.ciudad),
      estado: optionalValue(values.estado),
      codigo_postal: optionalValue(values.codigo_postal),
      referido_por: optionalValue(values.referido_por),
    }

    try {
      if (editing) {
        const { error } = await supabase
          .from('deudores')
          .update(payload)
          .eq('id', editing.id)
        if (error) throw error
      } else {
        const { data, error } = await supabase
          .from('deudores')
          .insert(payload)
          .select('id')
          .single()
        if (error) throw error
        borrowerId = data.id
        borrowerPersisted = true
        setEditing({
          id: data.id,
          ...payload,
          documento_path: null,
        })
      }

      if (document && borrowerId) {
        const prepared = await prepareIdentityDocument(document)
        if (prepared.size > 5 * 1024 * 1024) {
          throw new Error('El documento supera el límite de 5 MiB después de prepararlo.')
        }

        const extension =
          prepared.type === 'application/pdf' ? 'pdf' : 'webp'
        const objectPath = `${formWalletId}/${borrowerId}/${crypto.randomUUID()}.${extension}`
        const { error: uploadError } = await supabase.storage
          .from('documentos-identidad')
          .upload(objectPath, prepared, {
            contentType: prepared.type,
            upsert: false,
          })
        if (uploadError) throw uploadError

        const { error: pathError } = await supabase
          .from('deudores')
          .update({ documento_path: objectPath })
          .eq('id', borrowerId)
        if (pathError) {
          const { error: cleanupError } = await supabase.storage
            .from('documentos-identidad')
            .remove([objectPath])
          if (cleanupError) {
            console.error('No se pudo limpiar el documento recién subido.', cleanupError)
          }
          throw pathError
        }

        if (editing?.documento_path) {
          const { error: oldDocumentError } = await supabase.storage
            .from('documentos-identidad')
            .remove([editing.documento_path])
          if (oldDocumentError) {
            console.error('No se pudo retirar el documento anterior.', oldDocumentError)
            saveNotice =
              'El deudor se guardó, pero no se pudo retirar el documento anterior. Pide al administrador que lo revise.'
          }
        }
      }

      setFormOpen(false)
      setEditing(null)
      setDocument(null)
      setSuccessMessage(saveNotice)
      setReloadCounter((counter) => counter + 1)
    } catch (error) {
      console.error('No se pudo guardar el deudor.', error)
      const isDuplicate = isDuplicateBorrowerError(error)
      setErrorMessage(
        isDuplicate
          ? 'Ya existe un cliente en esta cartera con ese número de identificación, teléfono o correo electrónico. Verifica los datos ingresados.'
          : borrowerPersisted && document
            ? 'Los datos del deudor se guardaron, pero el documento no. Vuelve a intentarlo para adjuntarlo.'
            : 'No fue posible guardar el deudor. Revisa los datos e inténtalo de nuevo.',
      )
      if (!isDuplicate && borrowerPersisted) {
        setReloadCounter((counter) => counter + 1)
      }
    } finally {
      setBusy(false)
    }
  }

  async function deleteBorrower(borrower: Borrower) {
    if (!supabase || !canManage) return
    const confirmed = window.confirm(
      `¿Eliminar a ${borrower.nombre}? Esta acción borrará también sus préstamos, cronogramas, pagos y prórrogas. Se conservará la auditoría histórica. No se puede deshacer.`,
    )
    if (!confirmed) return

    setDeletingBorrowerId(borrower.id)
    setErrorMessage(null)
    setSuccessMessage(null)
    try {
      const { data: documentPath, error } = await supabase.rpc(
        'eliminar_deudor_pruebas',
        {
          p_deudor_id: borrower.id,
        },
      )
      if (error) throw error
      setSuccessMessage(
        `Se eliminó a ${borrower.nombre} y sus datos relacionados.`,
      )
      if (documentPath) {
        const { error: storageError } = await supabase.storage
          .from('documentos-identidad')
          .remove([documentPath])
        if (storageError) {
          console.error(
            'Se eliminó el deudor, pero no se pudo retirar su documento de Storage.',
            storageError,
          )
          setErrorMessage(
            'El deudor se eliminó, pero no se pudo borrar su documento privado. Revisa las políticas de Storage.',
          )
        }
      }
      setFormOpen(false)
      setEditing(null)
      setReloadCounter((counter) => counter + 1)
    } catch (error) {
      console.error('No se pudo eliminar el deudor de prueba.', error)
      setErrorMessage(
        'No fue posible eliminar el deudor. Revisa las relaciones y los permisos de Supabase.',
      )
    } finally {
      setDeletingBorrowerId(null)
    }
  }

  const filteredBorrowers = borrowers.filter((borrower) => {
    const matchesWallet =
      !canManage || !walletFilter || borrower.cartera_id === walletFilter
    const normalizedSearch = search.trim().toLocaleLowerCase()
    const matchesSearch =
      !normalizedSearch ||
      borrower.nombre.toLocaleLowerCase().includes(normalizedSearch) ||
      borrower.identificacion.toLocaleLowerCase().includes(normalizedSearch) ||
      formatUsPhone(borrower.telefono)
        .toLocaleLowerCase()
        .includes(normalizedSearch) ||
      (phoneDigits(search).length > 0 &&
        phoneDigits(borrower.telefono ?? '').includes(phoneDigits(search))) ||
      (borrower.email ?? '').toLocaleLowerCase().includes(normalizedSearch)
    return matchesWallet && matchesSearch
  })

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6 sm:py-10 lg:px-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-semibold text-emerald-700">Carteras y clientes</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
            Deudores
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            {canManage
              ? 'Administra los perfiles de deudores y sus documentos privados.'
              : 'Consulta los deudores asignados a tu cartera.'}
          </p>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={beginCreate}
            className="min-h-11 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-700"
          >
            Nuevo deudor
          </button>
        )}
      </div>

      {canManage && wallets.length > 0 && (
        <label className="mt-6 block max-w-xs text-sm font-medium text-slate-800">
          Filtrar por cartera
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

      {formOpen && canManage && (
        <section
          ref={formSectionRef}
          tabIndex={-1}
          className="mt-6 scroll-mt-5 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm outline-none sm:p-6"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold text-slate-950">
                {editing ? 'Editar deudor' : 'Registrar deudor'}
              </h2>
              <p className="mt-1 text-sm text-slate-600">
                Un perfil se registra por separado en cada cartera.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setFormOpen(false)}
              className="min-h-10 rounded-lg px-3 text-sm font-medium text-slate-600 hover:bg-slate-100"
            >
              Cerrar
            </button>
          </div>

          <form onSubmit={(event) => void handleSubmit(event)} className="mt-5">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <label className="block text-sm font-medium text-slate-800">
                Cartera
                <select
                  required
                  value={formWalletId}
                  disabled={Boolean(editing)}
                  onChange={(event) => setFormWalletId(event.target.value)}
                  className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base disabled:bg-slate-100"
                >
                  <option value="" disabled>
                    Selecciona una cartera
                  </option>
                  {wallets.map((wallet) => (
                    <option key={wallet.id} value={wallet.id}>
                      {wallet.nombre}
                    </option>
                  ))}
                </select>
              </label>
              <Field
                label="Nombre completo"
                name="nombre"
                value={values.nombre}
                onChange={updateValue}
                required
                autoComplete="name"
              />
              <Field
                label="Identificación"
                name="identificacion"
                value={values.identificacion}
                onChange={updateValue}
                required
              />
              <Field
                label="Correo electrónico"
                name="email"
                value={values.email}
                onChange={updateValue}
                type="email"
                required
                autoComplete="email"
              />
              <Field
                label="Teléfono"
                name="telefono"
                value={values.telefono}
                onChange={updateValue}
                required
                type="tel"
                autoComplete="tel"
                maxLength={14}
                pattern="\(\d{3}\) \d{3}-\d{4}"
                placeholder="(415) 555-0123"
              />
              <Field
                label="Dirección"
                name="direccion"
                value={values.direccion}
                onChange={updateValue}
                autoComplete="street-address"
              />
              <Field
                label="Casa o apartamento"
                name="apartamento"
                value={values.apartamento}
                onChange={updateValue}
              />
              <Field
                label="Ciudad"
                name="ciudad"
                value={values.ciudad}
                onChange={updateValue}
                autoComplete="address-level2"
              />
              <Field
                label="Estado"
                name="estado"
                value={values.estado}
                onChange={updateValue}
                autoComplete="address-level1"
              />
              <Field
                label="Código postal"
                name="codigo_postal"
                value={values.codigo_postal}
                onChange={updateValue}
                autoComplete="postal-code"
              />
              <Field
                label="Referido por"
                name="referido_por"
                value={values.referido_por}
                onChange={updateValue}
              />
              <label className="block text-sm font-medium text-slate-800 sm:col-span-2">
                Documento de identidad (imagen o PDF)
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,application/pdf"
                  onChange={(event) =>
                    setDocument(event.target.files?.[0] ?? null)
                  }
                  className="mt-2 block min-h-11 w-full rounded-lg border border-slate-300 bg-white text-sm file:mr-3 file:min-h-11 file:border-0 file:bg-slate-100 file:px-3 file:font-semibold file:text-slate-700"
                />
                <span className="mt-1 block text-xs font-normal text-slate-500">
                  Las imágenes se comprimen en el dispositivo. Máximo 5 MiB al
                  subir; los documentos PDF se guardan sin modificación.
                </span>
              </label>
            </div>
            {editing?.documento_path && !document && (
              <p className="mt-4 text-sm text-slate-600">
                Este perfil ya tiene un documento adjunto. Sube otro solo si
                deseas reemplazarlo.
              </p>
            )}
            {errorMessage && (
              <p
                role="alert"
                className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"
              >
                {errorMessage}
              </p>
            )}
            <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center">
              <button
                type="submit"
                disabled={busy}
                className="min-h-11 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-wait disabled:opacity-60"
              >
                {busy ? 'Guardando…' : editing ? 'Guardar cambios' : 'Crear deudor'}
              </button>
              <button
                type="button"
                onClick={() => setFormOpen(false)}
                className="min-h-11 rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                Cancelar
              </button>
            </div>
          </form>
        </section>
      )}

      {errorMessage && (!formOpen || !canManage) && (
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

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-end">
        <label className="block flex-1 text-sm font-medium text-slate-800">
          Buscar por nombre, identificación, teléfono o correo
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar deudor"
            className="mt-2 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-base"
          />
        </label>
      </div>

      <section className="mt-5 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 px-4 py-4 sm:px-5">
          <h2 className="font-semibold text-slate-950">
            {filteredBorrowers.length} deudor
            {filteredBorrowers.length === 1 ? '' : 'es'}
          </h2>
        </div>
        {loading ? (
          <p className="px-5 py-8 text-sm text-slate-600">Cargando deudores…</p>
        ) : filteredBorrowers.length === 0 ? (
          <p className="px-5 py-8 text-sm text-slate-600">
            No hay deudores que coincidan con la búsqueda.
          </p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {filteredBorrowers.map((borrower) => (
              <li
                key={borrower.id}
                className="flex flex-col gap-4 px-4 py-4 sm:px-5"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <Link
                      to={`${canManage ? '/admin' : '/cartera'}/deudores/${borrower.id}`}
                      className="font-semibold text-slate-950 underline decoration-slate-300 underline-offset-4 hover:text-emerald-800"
                    >
                      {borrower.nombre}
                    </Link>
                    {canManage && (
                      <p className="mt-1 text-sm text-slate-500">
                        {wallets.find((wallet) => wallet.id === borrower.cartera_id)?.nombre ?? 'Cartera'}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Link
                      to={`${canManage ? '/admin' : '/cartera'}/deudores/${borrower.id}`}
                      className="inline-flex min-h-10 items-center rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                    >
                      Ver perfil
                    </Link>
                    {canManage && (
                      <>
                        <button
                          type="button"
                          onClick={() => beginEdit(borrower)}
                          className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                        >
                          Editar
                        </button>
                        <button
                          type="button"
                          disabled={deletingBorrowerId === borrower.id}
                          onClick={() => void deleteBorrower(borrower)}
                          className="min-h-10 rounded-lg border border-red-300 px-3 text-sm font-semibold text-red-800 hover:bg-red-50 disabled:cursor-wait disabled:opacity-60"
                        >
                          {deletingBorrowerId === borrower.id
                            ? 'Eliminando…'
                            : 'Eliminar'}
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <dl className="grid gap-3 rounded-xl bg-slate-50 p-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
                  <div>
                    <dt className="text-xs font-medium uppercase text-slate-500">
                      Identificación
                    </dt>
                    <dd className="mt-1 break-words text-slate-900">
                      {borrower.identificacion}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium uppercase text-slate-500">
                      Teléfono
                    </dt>
                    <dd className="mt-1 break-words text-slate-900">
                      {formatUsPhone(borrower.telefono) || 'Sin teléfono'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium uppercase text-slate-500">
                      Correo electrónico
                    </dt>
                    <dd className="mt-1 break-words text-slate-900">
                      {borrower.email || 'Sin correo registrado'}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium uppercase text-slate-500">
                      Ubicación
                    </dt>
                    <dd className="mt-1 text-slate-900">
                      {[borrower.ciudad, borrower.estado].filter(Boolean).join(', ') || 'Sin ubicación'}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
