import assert from 'node:assert/strict'
import { test } from 'node:test'

import { describeError } from '../src/utils/errors.ts'

test('an Error is described by name, message and stack, not as {}', () => {
  const error = new TypeError('boom')
  const text = describeError(error)
  assert.ok(text.startsWith('TypeError: boom'))
  assert.ok(text.includes('errors.test.ts'), 'stack is included')
  assert.equal(JSON.stringify(error), '{}', 'the serialisation this replaces')
})

test('an error without a stack is still named', () => {
  const error = new Error('no stack')
  error.stack = undefined
  assert.equal(describeError(error), 'Error: no stack')
})

test('thrown non-errors fall back to their string form', () => {
  assert.equal(describeError('plain string'), 'plain string')
  assert.equal(describeError(42), '42')
  assert.equal(describeError({ message: 'shaped like one' }), 'shaped like one')
})

test('a cross-realm error is read by property, not instanceof', () => {
  const foreign = { name: 'DOMException', message: 'aborted', stack: 'frame@x:1:1' }
  assert.equal(describeError(foreign), 'DOMException: aborted\nframe@x:1:1')
})
