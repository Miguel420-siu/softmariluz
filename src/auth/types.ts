import type { User } from '@supabase/supabase-js'

export type AccountRole = 'admin' | 'lector'

export interface AccountProfile {
  role: AccountRole
  carteraId: string | null
}

export interface AuthContextValue {
  user: User | null
  profile: AccountProfile | null
  loading: boolean
  profileError: string | null
  isConfigured: boolean
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
}
