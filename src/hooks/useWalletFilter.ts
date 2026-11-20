import { useEffect, useState } from 'react'

const storageKey = 'prestamos:admin:wallet-filter'

function readStoredFilter() {
  try {
    return window.localStorage.getItem(storageKey) ?? ''
  } catch (error) {
    console.warn('No se pudo recuperar el filtro de cartera guardado.', error)
    return ''
  }
}

export function useWalletFilter(
  isAdmin: boolean,
  assignedWalletId: string | null | undefined,
) {
  const [adminFilter, setAdminFilter] = useState(readStoredFilter)

  useEffect(() => {
    if (!isAdmin) return
    try {
      window.localStorage.setItem(storageKey, adminFilter)
    } catch (error) {
      console.warn('No se pudo guardar el filtro de cartera.', error)
    }
  }, [adminFilter, isAdmin])

  if (!isAdmin) {
    return [assignedWalletId ?? '', () => undefined] as const
  }

  return [adminFilter, setAdminFilter] as const
}
