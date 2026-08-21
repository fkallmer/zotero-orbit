/**
 * Localization contract checks.
 *
 * The build has its own check, but it only inspects ids that appear in markup, it
 * only warns, and it never sees ids passed from TypeScript. These assertions
 * cover the rest: per-file parity between locales, the uniqueness `initLocale`
 * depends on, and the ids the pane sets dynamically.
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { PREFS_MESSAGE_IDS } from '../src/modules/preferenceMessages.ts'

const LOCALE_DIR = fileURLToPath(new URL('../addon/locale', import.meta.url))
const REFERENCE_LOCALE = 'en-US'

interface FtlMessage {
  attributes: Set<string>
  variables: Set<string>
  /** True when the message has a body, which Fluent writes as `textContent`. */
  hasValue: boolean
}

function collectVariables(text: string, into: Set<string>): void {
  for (const match of text.matchAll(/\{\s*\$([\w-]+)\s*\}/g)) into.add(match[1])
}

/**
 * Minimal FTL reader. Enough for this repo's flat messages, and cheaper than
 * taking a direct `@fluent/syntax` dependency, which is only transitive here.
 */
function parseFtl(source: string): { messages: Map<string, FtlMessage>; idOrder: string[] } {
  const messages = new Map<string, FtlMessage>()
  const idOrder: string[] = []
  let current: FtlMessage | null = null

  for (const line of source.split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      current = null // a blank line or comment ends the message
      continue
    }
    const idMatch = /^([a-zA-Z][\w-]*)\s*=(.*)$/.exec(line)
    if (idMatch) {
      current = { attributes: new Set(), variables: new Set(), hasValue: idMatch[2].trim() !== '' }
      idOrder.push(idMatch[1])
      messages.set(idMatch[1], current)
      collectVariables(idMatch[2], current.variables)
      continue
    }
    if (current === null) continue
    const attrMatch = /^\s+\.([\w-]+)\s*=(.*)$/.exec(line)
    if (attrMatch) {
      current.attributes.add(attrMatch[1])
      collectVariables(attrMatch[2], current.variables)
      continue
    }
    collectVariables(line, current.variables) // continuation of the previous value
  }
  return { messages, idOrder }
}

function localeNames(): string[] {
  return readdirSync(LOCALE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

function ftlNames(locale: string): string[] {
  return readdirSync(join(LOCALE_DIR, locale))
    .filter((name) => name.endsWith('.ftl'))
    .sort()
}

function read(locale: string, file: string) {
  return parseFtl(readFileSync(join(LOCALE_DIR, locale, file), 'utf8'))
}

const LOCALES = localeNames()
const REFERENCE_FILES = ftlNames(REFERENCE_LOCALE)

test('every locale ships the same set of FTL files', () => {
  assert.ok(LOCALES.includes(REFERENCE_LOCALE))
  for (const locale of LOCALES) {
    assert.deepEqual(ftlNames(locale), REFERENCE_FILES, `${locale} file set`)
  }
})

test('ids match per file, not merely across the union', () => {
  // A union comparison would pass if a `pref-*` id were misfiled into addon.ftl,
  // where the preferences document could never reach it.
  for (const file of REFERENCE_FILES) {
    const expected = [...read(REFERENCE_LOCALE, file).messages.keys()].sort()
    for (const locale of LOCALES) {
      if (locale === REFERENCE_LOCALE) continue
      assert.deepEqual([...read(locale, file).messages.keys()].sort(), expected, `${locale}/${file} ids`)
    }
  }
})

test('no id is declared twice in one file', () => {
  for (const locale of LOCALES) {
    for (const file of ftlNames(locale)) {
      const { messages, idOrder } = read(locale, file)
      assert.equal(idOrder.length, messages.size, `${locale}/${file} has a duplicate id`)
    }
  }
})

test('no id appears in two files of the same locale', () => {
  // initLocale registers all three FTLs in one Localization, so a collision would
  // make which file wins depend on load order.
  for (const locale of LOCALES) {
    const seen = new Map<string, string>()
    for (const file of ftlNames(locale)) {
      for (const id of read(locale, file).messages.keys()) {
        const previous = seen.get(id)
        assert.equal(previous, undefined, `${locale}: ${id} is in both ${previous} and ${file}`)
        seen.set(id, file)
      }
    }
  }
})

test('translations keep the same attributes and variables', () => {
  for (const file of REFERENCE_FILES) {
    const reference = read(REFERENCE_LOCALE, file).messages
    for (const locale of LOCALES) {
      if (locale === REFERENCE_LOCALE) continue
      const translated = read(locale, file).messages
      for (const [id, message] of reference) {
        const other = translated.get(id)
        assert.ok(other, `${locale}/${file} is missing ${id}`)
        assert.deepEqual(
          [...other.attributes].sort(),
          [...message.attributes].sort(),
          `${locale}/${file} ${id} attributes`,
        )
        assert.deepEqual(
          [...other.variables].sort(),
          [...message.variables].sort(),
          `${locale}/${file} ${id} variables`,
        )
      }
    }
  }
})

test('every id the pane sets dynamically lives in preferences.ftl', () => {
  // The generated FluentMessageId union spans all files, so the type system
  // cannot tell that a pane id is reachable from the pane's own bundle.
  for (const locale of LOCALES) {
    const ids = read(locale, 'preferences.ftl').messages
    for (const id of PREFS_MESSAGE_IDS) {
      assert.ok(ids.has(id), `${locale}/preferences.ftl is missing ${id}`)
    }
  }
})

test('messages taking arguments declare the expected variable names', () => {
  const preferences = read(REFERENCE_LOCALE, 'preferences.ftl').messages
  assert.deepEqual([...(preferences.get('pref-database-invalid')?.variables ?? [])], ['databases'])
  assert.deepEqual([...(preferences.get('pref-apikey-cleaned')?.variables ?? [])], ['characters'])
})

/**
 * XUL widgets render their text from the `label` attribute and keep their
 * indicator, arrow, or centering in internal content. Localizing one with a plain
 * *value* makes Fluent write `textContent`, which wipes that content — radios lose
 * their button, menulists stop opening, and button labels fall out of alignment.
 * They must therefore be localized with `.label` and carry no value.
 */
const XUL_LABEL_WIDGETS = ['button', 'radio', 'menuitem'] as const

function paneWidgetIds(): { tag: string; id: string }[] {
  const markup = readFileSync(fileURLToPath(new URL('../addon/content/preferences.xhtml', import.meta.url)), 'utf8')
  const found: { tag: string; id: string }[] = []
  for (const match of markup.matchAll(/<(\w+)\b([^>]*)>/g)) {
    const [, tag, attributes] = match
    if (!(XUL_LABEL_WIDGETS as readonly string[]).includes(tag)) continue
    const id = /data-l10n-id="([^"]+)"/.exec(attributes)?.[1]
    if (id !== undefined) found.push({ tag, id })
  }
  return found
}

test('XUL widgets are localized by attribute, never by value', () => {
  const widgets = paneWidgetIds()
  assert.ok(widgets.length > 0, 'expected the pane to bind some XUL widgets')

  for (const locale of LOCALES) {
    const messages = read(locale, 'preferences.ftl').messages
    for (const { tag, id } of widgets) {
      const message = messages.get(id)
      assert.ok(message, `${locale}: <${tag}> uses ${id}, which preferences.ftl does not define`)
      assert.ok(message.attributes.has('label'), `${locale}: ${id} is on a <${tag}> and needs a .label attribute`)
      assert.equal(
        message.hasValue,
        false,
        `${locale}: ${id} is on a <${tag}> and must have no value — Fluent would overwrite its content`,
      )
    }
  }
})

test('retired ids are gone', () => {
  // pref-database-count already covers zero; the pane heading comes from
  // getString('prefs-title') in addon.ftl.
  for (const locale of LOCALES) {
    const ids = read(locale, 'preferences.ftl').messages
    assert.equal(ids.has('pref-database-empty'), false, `${locale} still declares pref-database-empty`)
    assert.equal(ids.has('pref-title'), false, `${locale} still declares pref-title`)
  }
})

// --- Reachability ----------------------------------------------------------
//
// Two features once shipped as dead code: an info toggle that nothing called,
// and six explanations referenced from nowhere. Types, lint and every test
// stayed green -- an uncalled function is not a type error and an unreferenced
// string is not a lint violation -- and esbuild quietly dropped both from the
// bundle. These assertions are what would have caught it.

const SOURCE_DIR = fileURLToPath(new URL('../src', import.meta.url))
const MARKUP_FILES = ['../addon/content/preferences.xhtml']

function sourceText(): string {
  const parts: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.ts')) parts.push(readFileSync(path, 'utf8'))
    }
  }
  walk(SOURCE_DIR)
  for (const file of MARKUP_FILES) {
    parts.push(readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8'))
  }
  return parts.join('\n')
}

test('every translated string is reachable from the code', () => {
  const haystack = sourceText()
  const orphans: string[] = []

  for (const file of REFERENCE_FILES) {
    for (const id of read(REFERENCE_LOCALE, file).idOrder) {
      // Ids are written as string literals -- getString('x'), getLocaleID('x'),
      // data-l10n-id="x" -- so a plain substring search is enough and does not
      // care which of the three a given id goes through.
      if (haystack.includes(`'${id}'`) || haystack.includes(`"${id}"`)) continue
      orphans.push(`${file}: ${id}`)
    }
  }

  assert.deepEqual(
    orphans,
    [],
    `these strings are translated but referenced nowhere, so they cannot reach a user:\n  ${orphans.join('\n  ')}`,
  )
})

test('item pane section ids are attribute-only, like Zotero’s own', () => {
  // `pane-header = Citation Details` renders the section as bare text: Fluent
  // writes a message value into textContent, wiping collapsible-section's
  // internals, so the header loses its icon, its buttons and its twisty and the
  // body can never be opened. Zotero's own section-tags and sidenav-info are
  // attribute-only for exactly this reason.
  const expected: Record<string, string> = {
    'pane-header': 'label',
    'pane-sidenav': 'tooltiptext',
    'pane-refresh': 'tooltiptext',
  }

  for (const locale of LOCALES) {
    const messages = read(locale, 'addon.ftl').messages
    for (const [id, attribute] of Object.entries(expected)) {
      const message = messages.get(id)
      assert.ok(message, `${locale}: addon.ftl does not define ${id}`)
      assert.ok(message.attributes.has(attribute), `${locale}: ${id} needs a .${attribute} attribute`)
      assert.equal(
        message.hasValue,
        false,
        `${locale}: ${id} is handed to registerSection and must have no value — ` +
          `Fluent would write it into the section element and destroy its structure`,
      )
    }
  }
})
