export function phoneDigits(value: string) {
  const digits = value.replace(/\D/g, '')
  return digits.length === 11 && digits.startsWith('1')
    ? digits.slice(1)
    : digits
}

export function formatUsPhoneInput(value: string) {
  const digits = phoneDigits(value).slice(0, 10)
  if (digits.length === 0) return ''

  const areaCode = digits.slice(0, 3)
  const centralOfficeCode = digits.slice(3, 6)
  const lineNumber = digits.slice(6, 10)

  if (digits.length <= 3) return `(${areaCode}`
  if (digits.length <= 6) {
    return `(${areaCode}) ${centralOfficeCode}`
  }
  return `(${areaCode}) ${centralOfficeCode}-${lineNumber}`
}

export function formatUsPhone(value: string | null | undefined) {
  if (!value) return ''
  const digits = phoneDigits(value)
  return digits.length === 10
    ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
    : value
}
