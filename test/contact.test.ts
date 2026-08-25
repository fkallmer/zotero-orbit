import assert from 'node:assert/strict'
import { test } from 'node:test'

import { contactState, effectiveContact, looksLikeContactEmail, normalizeContact } from '../src/utils/contact.ts'

test('normalizeContact trims and drops a pasted mailto:', () => {
  assert.equal(normalizeContact('  you@example.org  '), 'you@example.org')
  assert.equal(normalizeContact('mailto:you@example.org'), 'you@example.org')
  assert.equal(normalizeContact('MAILTO: you@example.org'), 'you@example.org')
  assert.equal(normalizeContact(undefined), '')
  assert.equal(normalizeContact(null), '')
  assert.equal(normalizeContact('   '), '')
})

test('looksLikeContactEmail accepts ordinary addresses', () => {
  for (const value of ['you@example.org', 'a.b+c@sub.example.co.uk', "o'brien@example.ie"]) {
    assert.ok(looksLikeContactEmail(value), `should accept ${value}`)
  }
})

test('looksLikeContactEmail refuses what is certainly not an address', () => {
  // The point is not validation. It is that `mailto=Falk` claims a contact and
  // names nobody, which is worse for the provider than an anonymous request.
  for (const value of ['', 'Falk', 'you@example', 'you@.org', 'two words@example.org', 'a@b.c', '@example.org']) {
    assert.equal(looksLikeContactEmail(value), false, `should refuse ${JSON.stringify(value)}`)
  }
})

test('a set preference wins over the build', () => {
  assert.equal(effectiveContact('mine@example.org', 'builder@example.net'), 'mine@example.org')
})

test('an empty preference falls back to the build, so a local build is unchanged', () => {
  assert.equal(effectiveContact('', 'builder@example.net'), 'builder@example.net')
  assert.equal(effectiveContact(undefined, 'builder@example.net'), 'builder@example.net')
})

test('nothing anywhere means an anonymous request', () => {
  assert.equal(effectiveContact('', ''), '')
  assert.equal(effectiveContact(null, null), '')
})

test('an unusable preference sends nothing -- it does not fall through to the build', () => {
  // Someone who typed an address meant to use theirs. Quietly substituting the
  // builder's would send a stranger's address under their name.
  assert.equal(effectiveContact('Falk', 'builder@example.net'), '')
  assert.equal(effectiveContact('not an email', 'builder@example.net'), '')
})

test('an unusable build-time address is ignored rather than sent', () => {
  assert.equal(effectiveContact('', 'not-an-address'), '')
})

test('contactState names what the pane should say', () => {
  assert.equal(contactState('mine@example.org', ''), 'in-use')
  assert.equal(contactState('Falk', 'builder@example.net'), 'unusable')
  assert.equal(contactState('', 'builder@example.net'), 'built-in')
  assert.equal(contactState('', ''), 'anonymous')
})

test('state and effect agree: only in-use and built-in send anything', () => {
  const cases: [string, string][] = [
    ['mine@example.org', ''],
    ['Falk', 'builder@example.net'],
    ['', 'builder@example.net'],
    ['', ''],
    ['', 'nonsense'],
  ]
  for (const [preferred, builtIn] of cases) {
    const sends = effectiveContact(preferred, builtIn) !== ''
    const state = contactState(preferred, builtIn)
    assert.equal(sends, state === 'in-use' || state === 'built-in', `${preferred}|${builtIn} -> ${state}`)
  }
})
