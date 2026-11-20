import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const maximumPdfBytes = 4 * 1024 * 1024
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function respond(status: number, body: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => {
    const replacements: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }
    return replacements[character] ?? character
  })
}

function safeFilename(value: string) {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'cliente'
}

function statementEmailHtml(clientName: string) {
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>Estado de cuenta</title>
  </head>
  <body style="margin:0;padding:0;background-color:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#0f172a;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color:#f1f5f9;padding:32px 12px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:600px;background-color:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px;background-color:#047857;color:#ffffff;">
                <p style="margin:0;font-size:12px;font-weight:bold;letter-spacing:1.5px;text-transform:uppercase;color:#d1fae5;">Préstamos</p>
                <h1 style="margin:10px 0 0;font-size:24px;line-height:1.3;font-weight:700;color:#ffffff;">Tu estado de cuenta</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <p style="margin:0 0 16px;font-size:16px;line-height:1.6;">Hola <strong>${clientName}</strong>,</p>
                <p style="margin:0 0 24px;font-size:15px;line-height:1.7;color:#475569;">Adjuntamos el estado de cuenta actualizado de tu préstamo. En el documento encontrarás el resumen y el cronograma de pagos al día.</p>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 24px;background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;">
                  <tr>
                    <td width="44" valign="top" style="padding:16px 0 16px 16px;font-size:24px;color:#047857;">&#128206;</td>
                    <td style="padding:17px 16px 16px 10px;">
                      <p style="margin:0;font-size:14px;font-weight:700;color:#0f172a;">Estado de cuenta adjunto</p>
                      <p style="margin:5px 0 0;font-size:13px;line-height:1.5;color:#64748b;">PDF actualizado para consultar o guardar.</p>
                    </td>
                  </tr>
                </table>
                <p style="margin:0;font-size:14px;line-height:1.7;color:#475569;">Si tienes preguntas sobre este estado de cuenta, comunícate con nosotros.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 28px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-top:1px solid #e2e8f0;padding-top:20px;">
                  <tr>
                    <td style="font-size:14px;line-height:1.8;color:#334155;">
                      <strong style="font-size:15px;color:#0f172a;">Investements RC</strong><br>
                      <a href="https://wa.me/17327096573" style="color:#166534;text-decoration:none;">
                        <span style="display:inline-block;width:20px;height:20px;border-radius:50%;background-color:#25d366;color:#ffffff;text-align:center;line-height:20px;font-size:13px;font-weight:bold;">&#9742;</span>
                        &nbsp;(732) 709-6573
                      </a><br>
                      <a href="mailto:investementsrc@gmail.com" style="color:#047857;text-decoration:underline;">investementsrc@gmail.com</a>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }
  if (request.method !== 'POST') {
    return respond(405, { error: 'Método no permitido.' })
  }

  const authorization = request.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) {
    return respond(401, { error: 'Debes iniciar sesión para enviar extractos.' })
  }

  let payload: { loanId?: unknown; pdfBase64?: unknown }
  try {
    payload = await request.json()
  } catch {
    return respond(400, { error: 'La solicitud no tiene un formato válido.' })
  }
  if (
    typeof payload.loanId !== 'string' ||
    typeof payload.pdfBase64 !== 'string' ||
    payload.pdfBase64.length > Math.ceil(maximumPdfBytes / 3) * 4 + 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(payload.pdfBase64) ||
    payload.pdfBase64.length % 4 !== 0
  ) {
    return respond(400, { error: 'El préstamo o el archivo PDF no son válidos.' })
  }

  let pdfBytes: Uint8Array
  try {
    const binary = atob(payload.pdfBase64)
    if (binary.length < 5 || binary.length > maximumPdfBytes) {
      return respond(400, { error: 'El PDF excede el tamaño permitido.' })
    }
    pdfBytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  } catch {
    return respond(400, { error: 'No fue posible leer el archivo PDF.' })
  }
  if (new TextDecoder().decode(pdfBytes.subarray(0, 5)) !== '%PDF-') {
    return respond(400, { error: 'El archivo adjunto no es un PDF válido.' })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')
  if (!supabaseUrl || !supabaseAnonKey) {
    return respond(500, { error: 'La función no está configurada correctamente.' })
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authorization } },
  })
  const accessToken = authorization.slice('Bearer '.length)
  const { data: userResult, error: userError } =
    await supabase.auth.getUser(accessToken)
  if (userError || !userResult.user) {
    return respond(401, { error: 'La sesión no es válida.' })
  }

  const { data: profile, error: profileError } = await supabase
    .from('perfiles')
    .select('rol')
    .eq('usuario_id', userResult.user.id)
    .maybeSingle()
  if (profileError) {
    return respond(500, { error: 'No fue posible validar tu permiso.' })
  }
  if (profile?.rol !== 'admin') {
    return respond(403, { error: 'Solo el administrador puede enviar extractos.' })
  }

  const { data: loan, error: loanError } = await supabase
    .from('prestamos')
    .select('deudor_id, cartera_id, fecha_inicio')
    .eq('id', payload.loanId)
    .maybeSingle()
  if (loanError) {
    return respond(500, { error: 'No fue posible consultar el préstamo.' })
  }
  if (!loan) {
    return respond(404, { error: 'No se encontró el préstamo solicitado.' })
  }

  const { data: borrower, error: borrowerError } = await supabase
    .from('deudores')
    .select('nombre, email')
    .eq('id', loan.deudor_id)
    .eq('cartera_id', loan.cartera_id)
    .maybeSingle()
  if (borrowerError) {
    return respond(500, { error: 'No fue posible consultar el correo del cliente.' })
  }
  if (!borrower?.email || !emailPattern.test(borrower.email)) {
    return respond(400, { error: 'El cliente no tiene un correo válido registrado.' })
  }

  const smtpUsername = Deno.env.get('GMAIL_USER')
  const smtpPassword = Deno.env.get('GMAIL_APP_PASSWORD')
  if (!smtpUsername || !smtpPassword) {
    return respond(500, {
      error: 'Configura los secretos SMTP de Gmail en Supabase antes de enviar.',
    })
  }

  const client = new SMTPClient({
    connection: {
      hostname: 'smtp.gmail.com',
      port: 465,
      tls: true,
      auth: { username: smtpUsername, password: smtpPassword },
    },
    debug: { log: false },
  })

  const clientName = borrower.nombre.replace(/[\r\n]/g, ' ').trim()
  const escapedClientName = escapeHtml(clientName)
  const filename = `estado-de-cuenta-${safeFilename(clientName)}-${loan.fecha_inicio}.pdf`
  try {
    await client.send({
      from: `Préstamos <${smtpUsername}>`,
      to: borrower.email,
      subject: 'Tu estado de cuenta - Préstamos',
      content: `Hola ${clientName}, adjuntamos el estado de cuenta actualizado de tu préstamo. En el documento encontrarás el resumen y el cronograma de pagos al día. Si tienes preguntas, comunícate con nosotros.

Investements RC
WhatsApp: (732) 709-6573
investementsrc@gmail.com`,
      html: statementEmailHtml(escapedClientName),
      attachments: [
        {
          filename,
          contentType: 'application/pdf',
          encoding: 'binary',
          content: pdfBytes,
        },
      ],
      headers: {},
    })
  } catch (error) {
    console.error('Falló el envío SMTP del estado de cuenta.', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    })
    return respond(502, {
      error: 'No fue posible enviar el correo. Verifica los secretos SMTP de Gmail.',
    })
  } finally {
    try {
      await client.close()
    } catch (error) {
      console.error('No se pudo cerrar la conexión SMTP.', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      })
    }
  }

  return respond(200, { message: 'El extracto fue enviado al correo registrado.' })
})
