/**
 * Pure decisions behind the OpenAlex key field and the collection-network
 * limit in the preferences pane.
 *
 * Like `preferenceMessages.ts`, nothing here touches Zotero, so the Node tests
 * reach it, and nothing renders text: a status is a Fluent message id plus its
 * variables. `preferenceScript.ts` binds the result to the DOM, and passes each
 * id through `getLocaleID`, which is typed on the generated `FluentMessageId`.
 *
 * The seed-limit and seed-policy normalizers are exported for whoever reads
 * those preferences, so the pane and the network builder agree on what an
 * out-of-range or unknown stored value means.
 */

import { normalizeApiKey } from '../utils/apiKey.ts'

import type { SeedPolicy } from './collectionTypes.ts'
import type { StatusTone } from './preferenceMessages.ts'

export const NETWORK_SEED_LIMIT_MIN = 10
export const NETWORK_SEED_LIMIT_MAX = 5000
export const NETWORK_SEED_LIMIT_DEFAULT = 300
export const NETWORK_SEED_POLICY_DEFAULT: SeedPolicy = 'warn'
export const NETWORK_SEED_POLICIES: readonly SeedPolicy[] = ['cap', 'warn', 'all']

/**
 * The stored or typed seed limit, as a whole number in range.
 *
 * A fraction is rounded. Anything else that is not a whole number from 10 to
 * 5000 -- empty, text, NaN, out of range -- falls back to the default.
 *
 * @example
 * normalizeSeedLimit('120') // 120
 * normalizeSeedLimit(9999) // 300
 * normalizeSeedLimit('lots') // 300
 */
export function normalizeSeedLimit(raw: unknown): number {
  let value: number
  if (typeof raw === 'number') value = raw
  else if (typeof raw === 'string' && raw.trim() !== '') value = Number(raw.trim())
  else return NETWORK_SEED_LIMIT_DEFAULT
  if (!Number.isFinite(value)) return NETWORK_SEED_LIMIT_DEFAULT
  const rounded = Math.round(value)
  return rounded >= NETWORK_SEED_LIMIT_MIN && rounded <= NETWORK_SEED_LIMIT_MAX ? rounded : NETWORK_SEED_LIMIT_DEFAULT
}

/** The stored seed policy, or the default for anything that is not one of the three. */
export function normalizeSeedPolicy(raw: unknown): SeedPolicy {
  return typeof raw === 'string' && (NETWORK_SEED_POLICIES as readonly string[]).includes(raw)
    ? (raw as SeedPolicy)
    : NETWORK_SEED_POLICY_DEFAULT
}

export type OpenAlexKeyMessage =
  | { readonly id: 'pref-openalex-key-in-use' | 'pref-openalex-key-missing' }
  | {
      readonly id: 'pref-openalex-key-cleaned' | 'pref-openalex-key-unusable'
      readonly args: { readonly characters: string }
    }

/** Every id the key status can set, for the locale test. */
export const OPENALEX_KEY_MESSAGE_IDS: readonly OpenAlexKeyMessage['id'][] = [
  'pref-openalex-key-in-use',
  'pref-openalex-key-missing',
  'pref-openalex-key-cleaned',
  'pref-openalex-key-unusable',
]

export interface OpenAlexKeyStatus {
  /** The key as it would be stored. Never logged or rendered. */
  readonly key: string
  /** What happens to the key: sent, not set, or unusable. */
  readonly message: OpenAlexKeyMessage
  /** What normalization stripped, when it stripped anything. */
  readonly cleaned: OpenAlexKeyMessage | null
  readonly tone: StatusTone
}

/**
 * What the OpenAlex key row says for a typed or stored value.
 *
 * Mirrors `setOpenAlexApiKey`: a key with characters a header cannot carry is
 * not sent at all, so the row must not claim it is.
 */
export function openAlexKeyStatus(raw: unknown): OpenAlexKeyStatus {
  const normalized = normalizeApiKey(raw)
  const cleaned: OpenAlexKeyMessage | null =
    normalized.removed.length === 0
      ? null
      : { id: 'pref-openalex-key-cleaned', args: { characters: normalized.removed.join(', ') } }

  if (normalized.key === '') {
    return { key: '', message: { id: 'pref-openalex-key-missing' }, cleaned, tone: 'none' }
  }
  if (normalized.unusable.length > 0) {
    return {
      key: normalized.key,
      message: { id: 'pref-openalex-key-unusable', args: { characters: normalized.unusable.join(', ') } },
      cleaned,
      tone: 'error',
    }
  }
  return { key: normalized.key, message: { id: 'pref-openalex-key-in-use' }, cleaned, tone: 'ok' }
}
