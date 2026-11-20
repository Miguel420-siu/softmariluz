import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { User } from '@supabase/supabase-js'
import { AuthContext } from './AuthContext'
import { supabase } from '../lib/supabase'
import type { AccountProfile } from './types'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<AccountProfile | null>(null)
  const [loading, setLoading] = useState(supabase !== null)
  const [profileError, setProfileError] = useState<string | null>(null)
  const profileRequest = useRef(0)

  const loadProfile = useCallback(async (authenticatedUser: User) => {
    if (!supabase) return

    const requestId = ++profileRequest.current
    setLoading(true)
    setProfile(null)
    setProfileError(null)

    const { data, error } = await supabase
      .from('perfiles')
      .select('rol, cartera_id')
      .eq('usuario_id', authenticatedUser.id)
      .maybeSingle()

    if (requestId !== profileRequest.current) return

    if (error) {
      console.error('No se pudo cargar el perfil del usuario.', error)
      setProfileError(
        `No se pudo verificar tu perfil. Detalle: ${error.message}`,
      )
      setLoading(false)
      return
    }

    if (!data) {
      setProfileError(
        'Esta cuenta no tiene un perfil asignado. Pide al administrador que habilite tu acceso.',
      )
      setLoading(false)
      return
    }

    if (data.rol !== 'admin' && data.rol !== 'lector') {
      setProfileError(
        'El rol de esta cuenta no es válido. Pide al administrador que revise su perfil.',
      )
      setLoading(false)
      return
    }

    if (
      data.rol === 'lector' &&
      (typeof data.cartera_id !== 'string' || data.cartera_id.length === 0)
    ) {
      setProfileError(
        'Esta cuenta de lector no tiene una cartera asignada. Pide al administrador que revise su perfil.',
      )
      setLoading(false)
      return
    }

    setProfile({
      role: data.rol,
      carteraId: data.rol === 'lector' ? data.cartera_id : null,
    })
    setLoading(false)
  }, [])

  useEffect(() => {
    if (!supabase) return

    let authEventObserved = false
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      authEventObserved = true
      const authenticatedUser = session?.user ?? null
      setUser(authenticatedUser)

      if (authenticatedUser) {
        setLoading(true)
        queueMicrotask(() => void loadProfile(authenticatedUser))
        return
      }

      profileRequest.current += 1
      setProfile(null)
      setProfileError(null)
      setLoading(false)
    })

    void supabase.auth.getSession().then(({ data, error }) => {
      if (authEventObserved) return

      if (error) {
        console.error('No se pudo recuperar la sesión de Supabase.', error)
        setProfileError('No se pudo recuperar tu sesión. Vuelve a iniciar sesión.')
        setLoading(false)
        return
      }

      const authenticatedUser = data.session?.user ?? null
      setUser(authenticatedUser)
      if (authenticatedUser) {
        void loadProfile(authenticatedUser)
      } else {
        setLoading(false)
      }
    })

    return () => {
      subscription.unsubscribe()
      profileRequest.current += 1
    }
  }, [loadProfile])

  const signIn = useCallback(async (email: string, password: string) => {
    if (!supabase) {
      throw new Error('Falta configurar la conexión con Supabase.')
    }

    const { error } = await supabase.auth.signInWithPassword({
      email,
      password,
    })

    if (error) throw error
  }, [])

  const signOut = useCallback(async () => {
    if (!supabase) {
      throw new Error('Falta configurar la conexión con Supabase.')
    }

    const { error } = await supabase.auth.signOut()
    if (error) throw error
  }, [])

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        loading,
        profileError,
        isConfigured: supabase !== null,
        signIn,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}
