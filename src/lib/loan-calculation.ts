export interface InstallmentDraft {
  numero: number
  fecha_vencimiento: string
  capital: string
  intereses: string
  monto: string
}

export interface LoanCalculation {
  principalCents: bigint
  interestCents: bigint
  totalCents: bigint
  interestRateUnits: bigint
  installments: InstallmentDraft[]
  endDate: string
  paymentWeekday: number
}

export function addCalendarDays(date: string, days: number) {
  const [year, month, day] = date.split('-').map(Number)
  const value = new Date(Date.UTC(year, month - 1, day + days))
  return value.toISOString().slice(0, 10)
}

export function roundCentsToWholeDollars(cents: bigint) {
  const absolute = cents < 0n ? -cents : cents
  const rounded = (absolute + 50n) / 100n
  return cents < 0n ? -rounded : rounded
}

export function parseDecimalUnits(
  value: string,
  decimalPlaces: number,
): bigint | null {
  const normalized = value.trim()
  const match = normalized.match(
    new RegExp(`^(\\d+)(?:\\.(\\d{0,${decimalPlaces}}))?$`),
  )
  if (!match) return null

  const fraction = (match[2] ?? '').padEnd(decimalPlaces, '0')
  return BigInt(match[1]) * 10n ** BigInt(decimalPlaces) + BigInt(fraction || '0')
}

export function parseSignedDecimalUnits(
  value: string,
  decimalPlaces: number,
): bigint | null {
  const normalized = value.trim()
  const negative = normalized.startsWith('-')
  const unsignedValue = negative ? normalized.slice(1) : normalized
  const units = parseDecimalUnits(unsignedValue, decimalPlaces)
  return units === null ? null : negative ? -units : units
}

export function formatMoney(cents: bigint | number | string): string {
  const amount = typeof cents === 'bigint' ? cents : BigInt(cents)
  const sign = amount < 0n ? '-' : ''
  const absolute = amount < 0n ? -amount : amount
  const whole = (absolute + 50n) / 100n

  return `${sign}$${whole.toLocaleString('en-US')}`
}

function centsToDatabaseAmount(cents: bigint): string {
  if (cents % 100n !== 0n) {
    throw new Error('El cronograma debe usar importes en dólares enteros.')
  }
  return String(cents / 100n)
}

export function centsToDatabaseNumber(cents: bigint): number {
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < 0n) {
    throw new RangeError('El monto excede el límite numérico seguro.')
  }
  return Number(cents) / 100
}

export function rateUnitsToDatabaseNumber(units: bigint): number {
  return Number(units) / 10_000
}

function isoWeekday(date: string) {
  const [year, month, day] = date.split('-').map(Number)
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return weekday === 0 ? 7 : weekday
}

export function calculateLoanFromInstallment(
  principal: string,
  installmentAmount: string,
  installmentCount: number,
  firstInstallmentDate: string,
): LoanCalculation | null {
  const principalDollars = parseDecimalUnits(principal, 0)
  const installmentDollars = parseDecimalUnits(installmentAmount, 0)

  if (
    principalDollars === null ||
    principalDollars <= 0n ||
    installmentDollars === null ||
    installmentDollars <= 0n ||
    installmentCount < 1 ||
    installmentCount > 520 ||
    !Number.isInteger(installmentCount) ||
    !firstInstallmentDate
  ) {
    return null
  }

  const totalDollars = installmentDollars * BigInt(installmentCount)
  if (totalDollars < principalDollars) return null

  const principalCents = principalDollars * 100n
  const interestDollars = totalDollars - principalDollars
  const interestCents = interestDollars * 100n
  const totalCents = totalDollars * 100n
  const maximumAmountCents = 999_999_999_999n
  const interestRateUnits =
    (interestDollars * 1_000_000n + principalDollars / 2n) /
    principalDollars
  const maximumInterestRateUnits = 9_999_999_999_999_999n
  if (
    interestCents > maximumAmountCents ||
    totalCents > maximumAmountCents ||
    interestRateUnits > maximumInterestRateUnits
  ) {
    return null
  }
  const installmentPrincipalBase = principalDollars / BigInt(installmentCount)
  const installmentPrincipalRemainder = principalDollars % BigInt(installmentCount)

  const installments = Array.from({ length: installmentCount }, (_, index) => {
    const principalPart =
      installmentPrincipalBase + (BigInt(index) < installmentPrincipalRemainder ? 1n : 0n)
    const interestPart = installmentDollars - principalPart
    const principalPartCents = principalPart * 100n
    const interestPartCents = interestPart * 100n

    return {
      numero: index + 1,
      fecha_vencimiento: addCalendarDays(
        firstInstallmentDate,
        index * 7,
      ),
      capital: centsToDatabaseAmount(principalPartCents),
      intereses: centsToDatabaseAmount(interestPartCents),
      monto: centsToDatabaseAmount(installmentDollars * 100n),
    }
  })

  const firstInstallment = installments[0]
  const lastInstallment = installments[installments.length - 1]
  if (!firstInstallment || !lastInstallment) return null

  return {
    principalCents,
    interestCents,
    totalCents,
    interestRateUnits,
    installments,
    endDate: lastInstallment.fecha_vencimiento,
    paymentWeekday: isoWeekday(firstInstallment.fecha_vencimiento),
  }
}
