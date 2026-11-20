// Runtime validation coverage for whole-dollar loan schedules and formatting.
import { describe, expect, it } from 'vitest'
import {
  calculateLoanFromInstallment,
  formatMoney,
  parseSignedDecimalUnits,
} from './loan-calculation'

describe('loan calculation from installment amount', () => {
  it('derives interest and total from principal and a fixed installment amount', () => {
    const loan = calculateLoanFromInstallment('1500', '190', 10, '2026-11-11')

    expect(loan).not.toBeNull()
    expect(loan?.principalCents).toBe(150_000n)
    expect(loan?.interestCents).toBe(40_000n)
    expect(loan?.totalCents).toBe(190_000n)
    expect(loan?.interestRateUnits).toBe(266_667n)
    expect(loan?.installments[0]?.fecha_vencimiento).toBe('2026-11-11')
    expect(loan?.endDate).toBe('2027-01-13')
    expect(loan?.installments.map((item) => item.monto)).toEqual(
      Array(10).fill('190'),
    )
    expect(loan?.installments.every((item) =>
      [item.capital, item.intereses, item.monto].every((amount) =>
        /^\d+$/.test(amount),
      ),
    )).toBe(true)
    expect(
      loan?.installments.reduce(
        (total, item) => total + BigInt(item.monto),
        0n,
      ),
    ).toBe(1900n)
  })

  it('distributes principal remainders while keeping each installment fixed', () => {
    const loan = calculateLoanFromInstallment('10', '4', 3, '2026-11-11')

    expect(loan?.installments.map((item) => item.capital)).toEqual(['4', '3', '3'])
    expect(loan?.installments.map((item) => item.intereses)).toEqual(['0', '1', '1'])
    expect(loan?.installments.map((item) => item.monto)).toEqual(['4', '4', '4'])
    expect(
      loan?.installments.reduce(
        (total, item) => total + BigInt(item.monto),
        0n,
      ),
    ).toBe(12n)
  })

  it('supports zero interest and rejects payments whose total is below principal', () => {
    const noInterest = calculateLoanFromInstallment('10', '5', 2, '2026-11-11')

    expect(noInterest?.interestCents).toBe(0n)
    expect(noInterest?.installments.map((item) => item.capital)).toEqual(['5', '5'])
    expect(calculateLoanFromInstallment('10', '3', 3, '2026-11-11')).toBeNull()
    expect(calculateLoanFromInstallment('10', '0', 3, '2026-11-11')).toBeNull()
  })
})

describe('whole-dollar amount formatting', () => {
  it('rounds amounts to the nearest dollar, including negative adjustments', () => {
    expect(formatMoney(149n)).toBe('$1')
    expect(formatMoney(150n)).toBe('$2')
    expect(formatMoney(-150n)).toBe('-$2')
  })
})

describe('signed decimal amounts', () => {
  it('parses negative ledger amounts without changing unsigned parsing', () => {
    expect(parseSignedDecimalUnits('-125.40', 2)).toBe(-12_540n)
    expect(parseSignedDecimalUnits('125.40', 2)).toBe(12_540n)
    expect(parseSignedDecimalUnits('-1.234', 2)).toBeNull()
  })
})
