import { describe, expect, it } from 'vitest'
import { PredicateError, evaluatePredicate, readPath } from '../src/stages/predicate.js'

describe('readPath', () => {
  const output = {
    blocking: 0,
    review: { findings: [{ severity: 'suggestion' }, { severity: 'blocking' }] },
  }

  it('reads nested values', () => {
    expect(readPath(output, 'review.findings.1.severity')).toBe('blocking')
  })

  it('supports array length, which is what most gates want', () => {
    expect(readPath(output, 'review.findings.length')).toBe(2)
  })

  it('returns undefined for a missing path rather than throwing', () => {
    expect(readPath(output, 'nope.deeper')).toBeUndefined()
  })
})

describe('evaluatePredicate', () => {
  const review = { blocking: 0, total: 3, status: 'clean', passed: true, findings: [] }

  it('compares numbers', () => {
    expect(evaluatePredicate('blocking == 0', review)).toBe(true)
    expect(evaluatePredicate('blocking != 0', review)).toBe(false)
    expect(evaluatePredicate('total > 2', review)).toBe(true)
    expect(evaluatePredicate('total >= 3', review)).toBe(true)
    expect(evaluatePredicate('total < 3', review)).toBe(false)
    expect(evaluatePredicate('total <= 3', review)).toBe(true)
  })

  it('does not mistake >= for >', () => {
    expect(evaluatePredicate('total >= 4', review)).toBe(false)
    expect(evaluatePredicate('total > 3', review)).toBe(false)
  })

  it('compares quoted strings', () => {
    expect(evaluatePredicate("status == 'clean'", review)).toBe(true)
    expect(evaluatePredicate('status == "dirty"', review)).toBe(false)
  })

  it('compares booleans and null', () => {
    expect(evaluatePredicate('passed == true', review)).toBe(true)
    expect(evaluatePredicate('missing == null', review)).toBe(true)
  })

  it('treats a bare path as a truthiness check', () => {
    expect(evaluatePredicate('passed', review)).toBe(true)
    expect(evaluatePredicate('missing', review)).toBe(false)
  })

  it('compares two paths against each other', () => {
    expect(evaluatePredicate('blocking == findings.length', review)).toBe(true)
  })

  it('handles && and ||, with || binding loosest', () => {
    expect(evaluatePredicate('blocking == 0 && total > 2', review)).toBe(true)
    expect(evaluatePredicate('blocking == 1 && total > 2', review)).toBe(false)
    expect(evaluatePredicate('blocking == 1 || total > 2', review)).toBe(true)
    expect(evaluatePredicate('blocking == 1 && total > 99 || passed == true', review)).toBe(true)
  })

  it('never executes the expression as code', () => {
    // The value must come from the output object, not from the JS scope.
    expect(() => evaluatePredicate('process.exit(1) == 0', review)).not.toThrow()
    expect(evaluatePredicate('process.exit(1) == 0', review)).toBe(false)
  })

  it('rejects an ordering comparison on non-numbers, as a config error', () => {
    expect(() => evaluatePredicate('status > 1', review)).toThrow(PredicateError)
  })

  it('rejects an empty expression', () => {
    expect(() => evaluatePredicate('', review)).toThrow(PredicateError)
  })

  it('does not split on separators inside quotes', () => {
    expect(evaluatePredicate("status == 'a && b'", { status: 'a && b' })).toBe(true)
  })
})
