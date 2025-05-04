import { sum } from '@/sum'
import { expect, it } from 'vitest'

it('adds 1 + 2 to equal 3', () => {
  expect(sum(1, 2)).toBe(3)
})
