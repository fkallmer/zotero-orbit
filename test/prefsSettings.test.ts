import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  NETWORK_SEED_LIMIT_DEFAULT,
  NETWORK_SEED_LIMIT_MAX,
  NETWORK_SEED_LIMIT_MIN,
  NETWORK_SEED_POLICY_DEFAULT,
  normalizeSeedLimit,
  normalizeSeedPolicy,
  OPENALEX_KEY_MESSAGE_IDS,
  openAlexKeyStatus,
} from '../src/modules/preferenceSettings.core.ts'

// Assertions are on message ids and arguments, not on rendered English.

const ZWSP = String.fromCodePoint(0x200b)

test('the seed-limit bounds and defaults match addon/prefs.js', () => {
  const prefs = readFileSync(join(import.meta.dirname, '../addon/prefs.js'), 'utf8')
  assert.match(prefs, new RegExp(`pref\\('networkSeedLimit', ${NETWORK_SEED_LIMIT_DEFAULT}\\)`))
  assert.match(prefs, new RegExp(`pref\\('networkSeedPolicy', '${NETWORK_SEED_POLICY_DEFAULT}'\\)`))
  assert.equal(NETWORK_SEED_LIMIT_MIN, 10)
  assert.equal(NETWORK_SEED_LIMIT_MAX, 5000)
})

test('a seed limit in range is kept, from a number or from typed text', () => {
  assert.equal(normalizeSeedLimit(300), 300)
  assert.equal(normalizeSeedLimit(10), 10)
  assert.equal(normalizeSeedLimit(5000), 5000)
  assert.equal(normalizeSeedLimit(' 120 '), 120)
  assert.equal(normalizeSeedLimit('42.6'), 43)
})

test('a seed limit out of range is clamped to the nearest end', () => {
  assert.equal(normalizeSeedLimit(9), 10)
  assert.equal(normalizeSeedLimit(0), 10)
  assert.equal(normalizeSeedLimit(-50), 10)
  assert.equal(normalizeSeedLimit('99999'), 5000)
  assert.equal(normalizeSeedLimit(5001), 5000)
})

test('a seed limit that is not a number falls back to the default', () => {
  for (const raw of [undefined, null, '', '   ', 'lots', '12abc', Number.NaN, Infinity, -Infinity, {}, true]) {
    assert.equal(normalizeSeedLimit(raw), 300, `expected ${String(raw)} to fall back`)
  }
})

test('a known seed policy is kept and anything else falls back to warn', () => {
  for (const policy of ['cap', 'warn', 'all'] as const) assert.equal(normalizeSeedPolicy(policy), policy)
  for (const raw of ['', 'CAP', ' all', 'never', undefined, null, 3]) {
    assert.equal(normalizeSeedPolicy(raw), 'warn', `expected ${String(raw)} to fall back`)
  }
})

test('an empty key reports not set, with no tone', () => {
  for (const raw of ['', '   ', undefined, null, 42]) {
    const status = openAlexKeyStatus(raw)
    assert.equal(status.key, '')
    assert.deepEqual(status.message, { id: 'pref-openalex-key-missing' })
    assert.equal(status.cleaned, null)
    assert.equal(status.tone, 'none')
  }
})

test('a clean key reports that it is sent', () => {
  const status = openAlexKeyStatus('  abc123  ')
  assert.equal(status.key, 'abc123')
  assert.deepEqual(status.message, { id: 'pref-openalex-key-in-use' })
  assert.equal(status.cleaned, null)
  assert.equal(status.tone, 'ok')
})

test('stripped paste artifacts are reported by label, never as raw characters', () => {
  const status = openAlexKeyStatus(`abc${ZWSP}def\n`)
  assert.equal(status.key, 'abcdef')
  assert.deepEqual(status.message, { id: 'pref-openalex-key-in-use' })
  assert.deepEqual(status.cleaned, { id: 'pref-openalex-key-cleaned', args: { characters: 'U+200B, U+000A' } })
})

test('a key a header cannot carry is reported as not sent', () => {
  const status = openAlexKeyStatus('abcé—def')
  assert.equal(status.tone, 'error')
  assert.deepEqual(status.message, { id: 'pref-openalex-key-unusable', args: { characters: 'U+2014' } })
  assert.equal(status.cleaned, null)
})

test('a key that is only paste artifacts reports both not set and what was removed', () => {
  const status = openAlexKeyStatus(`${ZWSP}${ZWSP}`)
  assert.deepEqual(status.message, { id: 'pref-openalex-key-missing' })
  assert.deepEqual(status.cleaned, { id: 'pref-openalex-key-cleaned', args: { characters: 'U+200B' } })
})

test('the key status never carries the key in a message argument', () => {
  const secret = 'sk-very-secret-value'
  for (const raw of [secret, `${secret}${ZWSP}`, `${secret}—`]) {
    const status = openAlexKeyStatus(raw)
    for (const message of [status.message, status.cleaned]) {
      assert.ok(!JSON.stringify(message).includes('secret'), `${JSON.stringify(message)} leaks the key`)
    }
  }
})

test('every OpenAlex-key and network id lives in preferences.ftl, with the expected variables', () => {
  const ftl = readFileSync(join(import.meta.dirname, '../addon/locale/en-US/preferences.ftl'), 'utf8')
  const declared = new Set([...ftl.matchAll(/^([a-zA-Z][\w-]*)\s*=/gm)].map((match) => match[1]))
  for (const id of OPENALEX_KEY_MESSAGE_IDS) assert.ok(declared.has(id), `preferences.ftl is missing ${id}`)
  for (const id of ['pref-openalex-key-cleaned', 'pref-openalex-key-unusable']) {
    const line = new RegExp(`^${id} = (.*)$`, 'm').exec(ftl)?.[1] ?? ''
    assert.match(line, /\{ \$characters \}/, `${id} must take $characters`)
  }

  const markup = readFileSync(join(import.meta.dirname, '../addon/content/preferences.xhtml'), 'utf8')
  const used = [...markup.matchAll(/data-l10n-id="(pref-(?:openalex-key|network)-[\w-]+)"/g)].map((m) => m[1])
  assert.ok(used.length >= 10, 'the pane should use the OpenAlex-key and network strings')
  for (const id of used) assert.ok(declared.has(id), `preferences.xhtml uses ${id}, which preferences.ftl lacks`)
})
