export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  public: {
    Tables: {
      auditoria: {
        Row: {
          accion: string
          actor_id: string | null
          cartera_id: string | null
          created_at: string
          datos_anteriores: Json | null
          datos_nuevos: Json | null
          id: number
          registro_id: string
          tabla: string
        }
        Insert: {
          accion: string
          actor_id?: string | null
          cartera_id?: string | null
          created_at?: string
          datos_anteriores?: Json | null
          datos_nuevos?: Json | null
          id?: never
          registro_id: string
          tabla: string
        }
        Update: {
          accion?: string
          actor_id?: string | null
          cartera_id?: string | null
          created_at?: string
          datos_anteriores?: Json | null
          datos_nuevos?: Json | null
          id?: never
          registro_id?: string
          tabla?: string
        }
        Relationships: []
      }
      carteras: {
        Row: {
          clave: string
          created_at: string
          id: string
          nombre: string
          updated_at: string
        }
        Insert: {
          clave: string
          created_at?: string
          id?: string
          nombre: string
          updated_at?: string
        }
        Update: {
          clave?: string
          created_at?: string
          id?: string
          nombre?: string
          updated_at?: string
        }
        Relationships: []
      }
      control_caja: {
        Row: {
          cartera_id: string
          creado_por: string
          created_at: string
          fecha_inicio: string
          iniciado_en: string
        }
        Insert: {
          cartera_id: string
          creado_por?: string
          created_at?: string
          fecha_inicio: string
          iniciado_en?: string
        }
        Update: {
          cartera_id?: string
          creado_por?: string
          created_at?: string
          fecha_inicio?: string
          iniciado_en?: string
        }
        Relationships: [
          {
            foreignKeyName: "control_caja_cartera_id_fkey"
            columns: ["cartera_id"]
            isOneToOne: true
            referencedRelation: "carteras"
            referencedColumns: ["id"]
          },
        ]
      }
      cuotas: {
        Row: {
          capital: number
          cartera_id: string
          created_at: string
          estado: string
          fecha_vencimiento: string
          id: string
          intereses: number
          monto: number
          numero: number
          prestamo_id: string
          updated_at: string
        }
        Insert: {
          capital: number
          cartera_id: string
          created_at?: string
          estado?: string
          fecha_vencimiento: string
          id?: string
          intereses: number
          monto: number
          numero: number
          prestamo_id: string
          updated_at?: string
        }
        Update: {
          capital?: number
          cartera_id?: string
          created_at?: string
          estado?: string
          fecha_vencimiento?: string
          id?: string
          intereses?: number
          monto?: number
          numero?: number
          prestamo_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "cuotas_cartera_id_fkey"
            columns: ["cartera_id"]
            isOneToOne: false
            referencedRelation: "carteras"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cuotas_prestamo_cartera_fk"
            columns: ["prestamo_id", "cartera_id"]
            isOneToOne: false
            referencedRelation: "prestamos"
            referencedColumns: ["id", "cartera_id"]
          },
        ]
      }
      deudores: {
        Row: {
          apartamento: string | null
          cartera_id: string
          ciudad: string | null
          codigo_postal: string | null
          created_at: string
          direccion: string | null
          documento_path: string | null
          email: string | null
          estado: string | null
          id: string
          identificacion: string | null
          nombre: string
          referido_por: string | null
          telefono: string | null
          updated_at: string
        }
        Insert: {
          apartamento?: string | null
          cartera_id: string
          ciudad?: string | null
          codigo_postal?: string | null
          created_at?: string
          direccion?: string | null
          documento_path?: string | null
          email?: string | null
          estado?: string | null
          id?: string
          identificacion?: string | null
          nombre: string
          referido_por?: string | null
          telefono?: string | null
          updated_at?: string
        }
        Update: {
          apartamento?: string | null
          cartera_id?: string
          ciudad?: string | null
          codigo_postal?: string | null
          created_at?: string
          direccion?: string | null
          documento_path?: string | null
          email?: string | null
          estado?: string | null
          id?: string
          identificacion?: string | null
          nombre?: string
          referido_por?: string | null
          telefono?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "deudores_cartera_id_fkey"
            columns: ["cartera_id"]
            isOneToOne: false
            referencedRelation: "carteras"
            referencedColumns: ["id"]
          },
        ]
      }
      pagos: {
        Row: {
          cartera_id: string
          created_at: string
          cuota_id: string | null
          id: string
          monto: number
          notas: string | null
          pagado_en: string
          pago_referenciado_id: string | null
          prestamo_id: string
          registrado_por: string
          tipo: string
        }
        Insert: {
          cartera_id: string
          created_at?: string
          cuota_id?: string | null
          id?: string
          monto: number
          notas?: string | null
          pagado_en?: string
          pago_referenciado_id?: string | null
          prestamo_id: string
          registrado_por?: string
          tipo: string
        }
        Update: {
          cartera_id?: string
          created_at?: string
          cuota_id?: string | null
          id?: string
          monto?: number
          notas?: string | null
          pagado_en?: string
          pago_referenciado_id?: string | null
          prestamo_id?: string
          registrado_por?: string
          tipo?: string
        }
        Relationships: [
          {
            foreignKeyName: "pagos_cartera_id_fkey"
            columns: ["cartera_id"]
            isOneToOne: false
            referencedRelation: "carteras"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pagos_cuota_cartera_fk"
            columns: ["cuota_id", "cartera_id"]
            isOneToOne: false
            referencedRelation: "cuotas"
            referencedColumns: ["id", "cartera_id"]
          },
          {
            foreignKeyName: "pagos_prestamo_cartera_fk"
            columns: ["prestamo_id", "cartera_id"]
            isOneToOne: false
            referencedRelation: "prestamos"
            referencedColumns: ["id", "cartera_id"]
          },
          {
            foreignKeyName: "pagos_referenciado_cartera_fk"
            columns: ["pago_referenciado_id", "cartera_id"]
            isOneToOne: false
            referencedRelation: "pagos"
            referencedColumns: ["id", "cartera_id"]
          },
        ]
      }
      movimientos_caja: {
        Row: {
          cartera_id: string
          creado_por: string | null
          created_at: string
          descripcion: string
          id: string
          intereses: number
          monto: number
          referencia_id: string | null
          tipo: string
        }
        Insert: {
          cartera_id: string
          creado_por?: string | null
          created_at?: string
          descripcion: string
          id?: string
          intereses?: number
          monto: number
          referencia_id?: string | null
          tipo: string
        }
        Update: {
          cartera_id?: string
          creado_por?: string | null
          created_at?: string
          descripcion?: string
          id?: string
          intereses?: number
          monto?: number
          referencia_id?: string | null
          tipo?: string
        }
        Relationships: [
          {
            foreignKeyName: "movimientos_caja_cartera_id_fkey"
            columns: ["cartera_id"]
            isOneToOne: false
            referencedRelation: "carteras"
            referencedColumns: ["id"]
          },
        ]
      }
      perfiles: {
        Row: {
          cartera_id: string | null
          created_at: string
          rol: string
          updated_at: string
          usuario_id: string
        }
        Insert: {
          cartera_id?: string | null
          created_at?: string
          rol: string
          updated_at?: string
          usuario_id: string
        }
        Update: {
          cartera_id?: string | null
          created_at?: string
          rol?: string
          updated_at?: string
          usuario_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "perfiles_cartera_id_fkey"
            columns: ["cartera_id"]
            isOneToOne: false
            referencedRelation: "carteras"
            referencedColumns: ["id"]
          },
        ]
      }
      prestamos: {
        Row: {
          cartera_id: string
          codigo: string
          created_at: string
          deudor_id: string
          dia_pago_semana: number
          estado: string
          fecha_fin: string
          fecha_inicio: string
          id: string
          metodo_calculo: string
          monto: number
          monto_desembolsado: number | null
          notas: string | null
          numero_cartera: number
          numero_cuotas: number
          tasa_interes: number
          updated_at: string
        }
        Insert: {
          cartera_id: string
          codigo?: string
          created_at?: string
          deudor_id: string
          dia_pago_semana: number
          estado?: string
          fecha_fin: string
          fecha_inicio: string
          id?: string
          metodo_calculo?: string
          monto: number
          monto_desembolsado?: number | null
          notas?: string | null
          numero_cartera?: number
          numero_cuotas: number
          tasa_interes: number
          updated_at?: string
        }
        Update: {
          cartera_id?: string
          codigo?: string
          created_at?: string
          deudor_id?: string
          dia_pago_semana?: number
          estado?: string
          fecha_fin?: string
          fecha_inicio?: string
          id?: string
          metodo_calculo?: string
          monto?: number
          monto_desembolsado?: number | null
          notas?: string | null
          numero_cartera?: number
          numero_cuotas?: number
          tasa_interes?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "prestamos_cartera_id_fkey"
            columns: ["cartera_id"]
            isOneToOne: false
            referencedRelation: "carteras"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prestamos_deudor_cartera_fk"
            columns: ["deudor_id", "cartera_id"]
            isOneToOne: false
            referencedRelation: "deudores"
            referencedColumns: ["id", "cartera_id"]
          },
        ]
      }
      prorrogas: {
        Row: {
          capital_desplazado: number | null
          cartera_id: string
          created_at: string
          cuota_final: boolean
          cuota_id: string | null
          fecha_fin_anterior: string
          fecha_fin_nueva: string
          id: string
          notas: string | null
          pago_intereses_id: string
          prestamo_id: string
          registrada_en: string
          registrada_por: string
          semanas_desplazadas: number
        }
        Insert: {
          capital_desplazado?: number | null
          cartera_id: string
          created_at?: string
          cuota_final?: boolean
          cuota_id?: string | null
          fecha_fin_anterior: string
          fecha_fin_nueva: string
          id?: string
          notas?: string | null
          pago_intereses_id: string
          prestamo_id: string
          registrada_en?: string
          registrada_por?: string
          semanas_desplazadas?: number
        }
        Update: {
          capital_desplazado?: number | null
          cartera_id?: string
          created_at?: string
          cuota_final?: boolean
          cuota_id?: string | null
          fecha_fin_anterior?: string
          fecha_fin_nueva?: string
          id?: string
          notas?: string | null
          pago_intereses_id?: string
          prestamo_id?: string
          registrada_en?: string
          registrada_por?: string
          semanas_desplazadas?: number
        }
        Relationships: [
          {
            foreignKeyName: "prorrogas_cartera_id_fkey"
            columns: ["cartera_id"]
            isOneToOne: false
            referencedRelation: "carteras"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "prorrogas_cuota_cartera_fk"
            columns: ["cuota_id", "cartera_id"]
            isOneToOne: false
            referencedRelation: "cuotas"
            referencedColumns: ["id", "cartera_id"]
          },
          {
            foreignKeyName: "prorrogas_pago_cartera_fk"
            columns: ["pago_intereses_id", "cartera_id"]
            isOneToOne: false
            referencedRelation: "pagos"
            referencedColumns: ["id", "cartera_id"]
          },
          {
            foreignKeyName: "prorrogas_prestamo_cartera_fk"
            columns: ["prestamo_id", "cartera_id"]
            isOneToOne: false
            referencedRelation: "prestamos"
            referencedColumns: ["id", "cartera_id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      current_user_cartera_id: { Args: never; Returns: string }
      current_user_role: { Args: never; Returns: string }
      iniciar_control_caja: {
        Args: never
        Returns: string
      }
      reiniciar_control_caja: {
        Args: never
        Returns: undefined
      }
      eliminar_deudor_pruebas: {
        Args: { p_deudor_id: string }
        Returns: string
      }
      eliminar_prestamos_huerfanos_pruebas: {
        Args: never
        Returns: number
      }
      eliminar_prestamo_pruebas: {
        Args: { p_prestamo_id: string }
        Returns: undefined
      }
      is_admin: { Args: never; Returns: boolean }
      refinanciar_prestamo: {
        Args: {
          p_cartera_id: string
          p_cuotas: Json
          p_deudor_id: string
          p_dia_pago_semana: number
          p_fecha_fin: string
          p_fecha_inicio: string
          p_monto: number
          p_notas: string | null
          p_numero_cuotas: number
          p_prestamo_anterior_id: string
          p_tasa_interes: number
        }
        Returns: string
      }
      registrar_pago: {
        Args: {
          p_cuota_id: string
          p_notas?: string
          p_prestamo_id: string
          p_tipo: string
        }
        Returns: string
      }
      registrar_movimiento_caja: {
        Args: {
          p_descripcion: string
          p_monto: number
          p_tipo: string
        }
        Returns: string
      }
      revertir_pago: {
        Args: { p_motivo: string; p_pago_id: string }
        Returns: string
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
