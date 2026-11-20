import { describe, expect, it } from 'vitest'
import {
  formatUsPhone,
  formatUsPhoneInput,
  phoneDigits,
} from './us-phone'

describe('US phone formatting', () => {
  it('formats the number as the user types', () => {
    expect(formatUsPhoneInput('4')).toBe('(4')
    expect(formatUsPhoneInput('4155')).toBe('(415) 5')
    expect(formatUsPhoneInput('415555')).toBe('(415) 555')
    expect(formatUsPhoneInput('4155550123')).toBe('(415) 555-0123')
  })

  it('limits input to ten digits and accepts a pasted US country prefix', () => {
    expect(formatUsPhoneInput('415555012399')).toBe('(415) 555-0123')
    expect(phoneDigits('+1 (415) 555-0123')).toBe('4155550123')
  })

  it('formats stored US numbers while preserving other legacy values', () => {
    expect(formatUsPhone('4155550123')).toBe('(415) 555-0123')
    expect(formatUsPhone('not a US number')).toBe('not a US number')
  })
})
