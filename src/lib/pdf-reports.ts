import { jsPDF } from 'jspdf'
import { autoTable } from 'jspdf-autotable'
import { addCalendarDays, parseDecimalUnits } from './loan-calculation'
import { formatUsPhone } from './us-phone'

const paymentTimeZone = 'America/New_York'

export interface PdfBorrower {
  nombre: string
  identificacion: string | null
  email?: string | null
  telefono: string | null
  direccion: string | null
  apartamento: string | null
  ciudad: string | null
  estado: string | null
  codigo_postal: string | null
}

export interface PdfLoan {
  id: string
  codigo: string
  cartera_id: string
  deudor_id: string
  monto: number
  tasa_interes: number
  fecha_inicio: string
  fecha_fin: string
  estado: string
}

export interface PdfInstallment {
  prestamo_id: string
  numero: number
  fecha_vencimiento: string
  capital: number
  intereses: number
  monto: number
  estado: string
}

export interface PdfPayment {
  prestamo_id: string
  monto: number
  pagado_en: string
}

export interface PdfBorrowerRow extends PdfBorrower {
  id: string
  cartera_id: string
}

interface ConsolidatedReportRow {
  nombre: string
  codigo: string
  fechaPrestamo: string
  fechaPrimeraCuota: string | null
  fechaUltimaCuota: string | null
  principal: bigint
  interes: bigint
  debe: bigint
  pagado: bigint
  cuotasPagadas: number
  cuotasRestantes: number
}

function cents(value: number) {
  const parsed = parseDecimalUnits(String(Math.abs(value)), 2)
  if (parsed === null) throw new Error('El PDF contiene un importe no válido.')
  return value < 0 ? -parsed : parsed
}

function money(centsValue: bigint) {
  const rounded =
    centsValue < 0n
      ? -((-centsValue + 50n) / 100n)
      : (centsValue + 50n) / 100n
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(rounded)
}

function whole(value: number) {
  return new Intl.NumberFormat('es-US', {
    maximumFractionDigits: 0,
  }).format(Math.round(value))
}

function rateLabel(value: number) {
  return `${new Intl.NumberFormat('es-US', {
    maximumFractionDigits: 2,
  }).format(value)}%`
}

function dateLabel(date: string, short = false) {
  return new Intl.DateTimeFormat('es-US', {
    day: 'numeric',
    month: short ? 'short' : 'long',
    year: short ? undefined : 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`))
}

function generatedAtLabel() {
  return new Intl.DateTimeFormat('es-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date())
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

function safeFilename(value: string) {
  return (
    value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9-]+/g, '-')
      .replace(/^-|-$/g, '') || 'prestamo'
  )
}

function loanTotals(
  installments: PdfInstallment[],
  payments: PdfPayment[],
) {
  return {
    principal: installments.reduce((sum, item) => sum + cents(item.capital), 0n),
    interest: installments.reduce(
      (sum, item) => sum + cents(item.intereses),
      0n,
    ),
    total: installments.reduce((sum, item) => sum + cents(item.monto), 0n),
    due: installments.reduce(
      (sum, item) =>
        item.estado === 'pendiente' ? sum + cents(item.monto) : sum,
      0n,
    ),
    paid: payments.reduce((sum, item) => sum + cents(item.monto), 0n),
    paidCount: installments.filter((item) => item.estado === 'pagada').length,
    remainingCount: installments.filter((item) => item.estado === 'pendiente')
      .length,
  }
}

function addressLabel(borrower: PdfBorrower) {
  return [
    borrower.direccion,
    borrower.apartamento,
    [borrower.ciudad, borrower.estado, borrower.codigo_postal]
      .filter(Boolean)
      .join(', '),
  ]
    .filter(Boolean)
    .join(' · ') || 'No registrada'
}

async function loadWhatsAppLogo() {
  const response = await fetch(
    `${import.meta.env.BASE_URL}whatsapp-svg.svg`,
  )
  if (!response.ok) {
    throw new Error('No se pudo cargar el logo de WhatsApp.')
  }

  const svgBlob = await response.blob()
  const imageUrl = URL.createObjectURL(svgBlob)
  try {
    const image = new Image()
    image.src = imageUrl
    await image.decode()

    const canvas = document.createElement('canvas')
    canvas.width = 128
    canvas.height = 128
    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('No se pudo preparar el logo de WhatsApp para el PDF.')
    }

    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png')
  } finally {
    URL.revokeObjectURL(imageUrl)
  }
}

function drawClientPdfFooter(pdf: jsPDF, whatsappLogo: string) {
  const pageWidth = pdf.internal.pageSize.getWidth()
  const pageHeight = pdf.internal.pageSize.getHeight()
  const left = 14
  const top = pageHeight - 25

  pdf.setDrawColor(203, 213, 225)
  pdf.setLineWidth(0.25)
  pdf.line(left, top, pageWidth - left, top)

  pdf.addImage(whatsappLogo, 'PNG', left, top + 2, 6, 6)

  pdf.setFont('helvetica', 'normal')
  pdf.setFontSize(7.5)
  pdf.setTextColor(15, 23, 42)
  pdf.text(
    'Revisa la información de tu estado de cuenta. Si tienes dudas o sugerencias, escríbenos por WhatsApp al (732) 709-6573.',
    left + 8,
    top + 6,
  )

  pdf.setFontSize(7)
  pdf.setTextColor(71, 85, 105)
  const privacyLines = pdf.splitTextToSize(
    'Tus datos personales se mantienen confidenciales y se usan solo para administrar tu préstamo y tus pagos. Si encuentras algún dato incorrecto, comunícate con nosotros para revisarlo.',
    pageWidth - left * 2,
  ) as string[]
  pdf.text(privacyLines, left, top + 12)
}

async function buildClientLoanPdf(
  borrower: PdfBorrower,
  loan: PdfLoan,
  installments: PdfInstallment[],
  payments: PdfPayment[],
): Promise<jsPDF> {
  const pdf = new jsPDF()
  const whatsappLogo = await loadWhatsAppLogo()
  const totals = loanTotals(installments, payments)
  const overdueAfterGraceDate = addCalendarDays(
    currentPaymentZoneDate(),
    -1,
  )
  const hasOverdueInstallment = installments.some(
    (item) =>
      item.estado === 'pendiente' &&
      item.fecha_vencimiento < overdueAfterGraceDate,
  )
  const status =
    loan.estado === 'terminado'
      ? 'Terminado'
      : hasOverdueInstallment
      ? 'Atrasado'
      : 'Activo'

  const pageWidth = pdf.internal.pageSize.getWidth()
  const contentLeft = 14
  const contentWidth = pageWidth - contentLeft * 2
  const columnWidth = contentWidth / 3

  pdf.setFontSize(18)
  pdf.setTextColor(15, 23, 42)
  pdf.text('Estado de cuenta', 14, 19)
  pdf.setFontSize(10)
  pdf.setFont('helvetica', 'bold')
  pdf.setTextColor(4, 120, 87)
  pdf.text(`Estado del crédito: ${status}`, pageWidth - contentLeft, 19, {
    align: 'right',
  })
  pdf.setFont('helvetica', 'normal')
  pdf.setTextColor(71, 85, 105)
  pdf.text(`Fecha de generación: ${generatedAtLabel()}`, 14, 25)

  function drawSectionTitle(title: string, y: number) {
    pdf.setFont('helvetica', 'bold')
    pdf.setFontSize(9)
    pdf.setTextColor(4, 120, 87)
    pdf.text(title.toLocaleUpperCase('es-US'), contentLeft + 5, y)
    pdf.setDrawColor(203, 213, 225)
    pdf.setLineWidth(0.25)
    pdf.line(contentLeft + 5, y + 2, pageWidth - contentLeft - 5, y + 2)
    pdf.setFont('helvetica', 'normal')
  }

  function drawField(label: string, value: string, x: number, y: number, width: number) {
    pdf.setFont('helvetica', 'normal')
    pdf.setFontSize(8)
    pdf.setTextColor(100, 116, 139)
    pdf.text(label, x, y)
    pdf.setFont('helvetica', 'bold')
    pdf.setFontSize(10)
    pdf.setTextColor(15, 23, 42)
    const lines = pdf.splitTextToSize(value || 'No registrado', width) as string[]
    pdf.text(lines, x, y + 5)
    pdf.setFont('helvetica', 'normal')
    return lines.length
  }

  const customerTop = 31
  const customerColumnWidth = columnWidth - 12
  const addressWidth = customerColumnWidth
  const phoneWidth = customerColumnWidth
  const addressLines = pdf.splitTextToSize(addressLabel(borrower), addressWidth) as string[]
  const phoneLines = pdf.splitTextToSize(
    formatUsPhone(borrower.telefono) || 'No registrado',
    phoneWidth,
  ) as string[]
  const customerHeight =
    43 + Math.max(0, Math.max(addressLines.length, phoneLines.length) - 1) * 4.5
  pdf.setFillColor(248, 250, 252)
  pdf.setDrawColor(226, 232, 240)
  pdf.roundedRect(contentLeft, customerTop, contentWidth, customerHeight, 2, 2, 'FD')
  drawSectionTitle('Información del cliente', customerTop + 8)
  drawField('Nombre', borrower.nombre, contentLeft + 6, customerTop + 17, columnWidth - 12)
  drawField(
    'Identificación',
    borrower.identificacion || 'No registrada',
    contentLeft + columnWidth + 4,
    customerTop + 17,
    customerColumnWidth,
  )
  const contactY = customerTop + 31
  drawField(
    'Dirección',
    addressLabel(borrower),
    contentLeft + 6,
    contactY,
    addressWidth,
  )
  drawField(
    'Teléfono',
    formatUsPhone(borrower.telefono) || 'No registrado',
    contentLeft + columnWidth + 4,
    contactY,
    phoneWidth,
  )

  const loanTop = customerTop + customerHeight + 5
  const loanHeight = 68
  pdf.setFillColor(248, 250, 252)
  pdf.setDrawColor(226, 232, 240)
  pdf.roundedRect(contentLeft, loanTop, contentWidth, loanHeight, 2, 2, 'FD')
  drawSectionTitle('Información del préstamo', loanTop + 7)

  const loanFields = [
    [
      ['Código del préstamo', loan.codigo],
      ['Fecha del préstamo', dateLabel(loan.fecha_inicio)],
      ['Fecha fin', dateLabel(loan.fecha_fin)],
    ],
    [
      ['Monto prestado', money(cents(loan.monto))],
      ['Total estimado', money(totals.total)],
      ['Interés total', money(totals.interest)],
    ],
    [
      ['Tasa', rateLabel(loan.tasa_interes)],
      ['Pagado neto a la fecha', money(totals.paid)],
      ['Saldo por pagar', money(totals.due)],
    ],
    [
      ['Cuotas pagadas', whole(totals.paidCount)],
      ['Cuotas pendientes', whole(totals.remainingCount)],
      ['Total de cuotas', whole(totals.paidCount + totals.remainingCount)],
    ],
  ] as const

  loanFields.forEach((row, rowIndex) => {
    row.forEach(([label, value], columnIndex) => {
      drawField(
        label,
        value,
        contentLeft + 6 + columnIndex * columnWidth,
        loanTop + 15 + rowIndex * 12.5,
        columnWidth - 12,
      )
    })
  })

  const tableStart = loanTop + loanHeight + 5

  autoTable(pdf, {
    startY: tableStart,
    head: [[
      'Cuota',
      'Vencimiento',
      'Abono a capital',
      'Interés',
      'Total cuota',
      'Saldo por pagar',
      'Estado',
    ]],
    body: installments.map((item) => [
      whole(item.numero),
      dateLabel(item.fecha_vencimiento, true),
      money(cents(item.capital)),
      money(cents(item.intereses)),
      money(cents(item.monto)),
      money(item.estado === 'pendiente' ? cents(item.monto) : 0n),
      item.estado === 'pagada' ? 'Pagada' : 'Pendiente',
    ]),
    foot: [[
      'TOTAL',
      '',
      money(totals.principal),
      money(totals.interest),
      money(totals.total),
      money(totals.due),
      '',
    ]],
    showFoot: 'lastPage',
    styles: { fontSize: 7, cellPadding: 1.5 },
    headStyles: { fillColor: [4, 120, 87] },
    footStyles: { fillColor: [226, 232, 240], textColor: [15, 23, 42], fontStyle: 'bold' },
    margin: { left: contentLeft, right: contentLeft, bottom: 30 },
    didDrawPage: () => drawClientPdfFooter(pdf, whatsappLogo),
    columnStyles: {
      0: { cellWidth: 14 },
      1: { cellWidth: 26 },
      2: { cellWidth: 32 },
      3: { cellWidth: 25 },
      4: { cellWidth: 28 },
      5: { cellWidth: 33 },
      6: { cellWidth: 24 },
    },
  })

  return pdf
}

function clientLoanPdfFilename(borrower: PdfBorrower, loan: PdfLoan) {
  return `estado-de-cuenta-${safeFilename(borrower.nombre)}-${loan.fecha_inicio}.pdf`
}

export async function generateClientLoanPdf(
  borrower: PdfBorrower,
  loan: PdfLoan,
  installments: PdfInstallment[],
  payments: PdfPayment[],
): Promise<void> {
  const pdf = await buildClientLoanPdf(borrower, loan, installments, payments)
  pdf.save(clientLoanPdfFilename(borrower, loan))
}

export async function createClientLoanPdfBlob(
  borrower: PdfBorrower,
  loan: PdfLoan,
  installments: PdfInstallment[],
  payments: PdfPayment[],
): Promise<Blob> {
  const pdf = await buildClientLoanPdf(borrower, loan, installments, payments)
  return pdf.output('blob')
}

function reportRows(
  loans: PdfLoan[],
  borrowers: PdfBorrowerRow[],
  installments: PdfInstallment[],
  payments: PdfPayment[],
): ConsolidatedReportRow[] {
  const borrowerById = new Map(borrowers.map((item) => [item.id, item]))
  const installmentsByLoan = new Map<string, PdfInstallment[]>()
  const paymentsByLoan = new Map<string, PdfPayment[]>()

  for (const installment of installments) {
    const items = installmentsByLoan.get(installment.prestamo_id) ?? []
    items.push(installment)
    installmentsByLoan.set(installment.prestamo_id, items)
  }
  for (const payment of payments) {
    const items = paymentsByLoan.get(payment.prestamo_id) ?? []
    items.push(payment)
    paymentsByLoan.set(payment.prestamo_id, items)
  }

  const loanRows = loans.map((loan) => {
    const borrower = borrowerById.get(loan.deudor_id)
    if (!borrower) {
      throw new Error('No se encontró el cliente de uno de los préstamos.')
    }
    const loanInstallments = installmentsByLoan.get(loan.id) ?? []
    const loanPayments = paymentsByLoan.get(loan.id) ?? []
    const totals = loanTotals(loanInstallments, loanPayments)
    const installmentDates = loanInstallments
      .map((item) => item.fecha_vencimiento)
      .sort()
    return {
      nombre: borrower.nombre,
      codigo: loan.codigo,
      fechaPrestamo: loan.fecha_inicio,
      fechaPrimeraCuota: installmentDates[0] ?? null,
      fechaUltimaCuota: installmentDates[installmentDates.length - 1] ?? null,
      principal: cents(loan.monto),
      interes: totals.interest,
      debe: totals.due,
      pagado: totals.paid,
      cuotasPagadas: totals.paidCount,
      cuotasRestantes: totals.remainingCount,
    }
  })
  return loanRows
}

export function generateConsolidatedLoansPdf(
  status: 'active' | 'finished',
  loans: PdfLoan[],
  borrowers: PdfBorrowerRow[],
  installments: PdfInstallment[],
  payments: PdfPayment[],
  walletName: string,
) {
  const rows = reportRows(
    loans,
    borrowers,
    installments,
    payments,
  )
  const active = status === 'active'
  const pdf = new jsPDF({ orientation: 'landscape' })
  const totals = rows.reduce(
    (sum, row) => ({
      principal: sum.principal + row.principal,
      interes: sum.interes + row.interes,
      due: sum.due + row.debe,
    }),
    { principal: 0n, interes: 0n, due: 0n },
  )

  pdf.setFontSize(17)
  pdf.setTextColor(15, 23, 42)
  pdf.text(
    active
      ? `Consolidado de préstamos activos · ${walletName}`
      : `Consolidado de préstamos terminados · ${walletName}`,
    12,
    16,
  )
  pdf.setFontSize(9)
  pdf.setTextColor(71, 85, 105)
  pdf.text(`Fecha de generación: ${generatedAtLabel()}`, 12, 23)

  autoTable(pdf, {
    startY: 29,
    head: [[
      'Cliente',
      'Código de préstamo',
      'Fecha del préstamo',
      'Fecha primera cuota',
      'Fecha última cuota',
      'Monto prestado',
      'Interés',
      'Debe',
      'Ha pagado',
      'Cuotas pagadas',
      'Cuotas\npendientes',
    ]],
    body: rows.map((row) => [
      row.nombre,
      row.codigo,
      dateLabel(row.fechaPrestamo, true),
      row.fechaPrimeraCuota ? dateLabel(row.fechaPrimeraCuota, true) : '—',
      row.fechaUltimaCuota ? dateLabel(row.fechaUltimaCuota, true) : '—',
      money(row.principal),
      money(row.interes),
      money(row.debe),
      money(row.pagado),
      whole(row.cuotasPagadas),
      whole(row.cuotasRestantes),
    ]),
    foot: [[
      `TOTAL (${whole(rows.length)} registros)`,
      '',
      '',
      '',
      '',
      money(totals.principal),
      money(totals.interes),
      money(totals.due),
      '',
      '',
      '',
    ]],
    showFoot: 'lastPage',
    styles: { fontSize: 7, cellPadding: 2, overflow: 'linebreak' },
    headStyles: { fillColor: [4, 120, 87] },
    footStyles: {
      fillColor: [226, 232, 240],
      textColor: [15, 23, 42],
      fontStyle: 'bold',
    },
    margin: { left: 10, right: 10, bottom: 14 },
    columnStyles: {
      0: { cellWidth: 32 },
      1: { cellWidth: 18 },
      2: { cellWidth: 25 },
      3: { cellWidth: 17 },
      4: { cellWidth: 17 },
      5: { cellWidth: 22 },
      6: { cellWidth: 20 },
      7: { cellWidth: 20 },
      8: { cellWidth: 22 },
      9: { cellWidth: 20 },
      10: { cellWidth: 22 },
    },
  })

  pdf.save(
    `consolidado-prestamos-${active ? 'activos' : 'terminados'}-${safeFilename(walletName)}.pdf`,
  )
}
