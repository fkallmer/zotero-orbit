// Avoid instanceof checks because Zotero errors can originate in another JavaScript realm.
function getErrorStringProperty(error: unknown, property: 'message' | 'name'): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined

  try {
    const value = (error as { readonly message?: unknown; readonly name?: unknown })[property]
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

export function getErrorName(error: unknown): string | undefined {
  return getErrorStringProperty(error, 'name')
}

export function isErrorNamed(error: unknown, name: string): boolean {
  return getErrorName(error) === name
}

export function getErrorMessage(error: unknown): string {
  const message = getErrorStringProperty(error, 'message')
  if (message !== undefined) return message

  try {
    return String(error)
  } catch {
    return 'Unknown error'
  }
}

/**
 * A readable one-off description of a thrown value, for logs.
 *
 * `ztoolkit.log` serialises an Error as `{}`, because its fields are not own
 * enumerable properties, so the failure that dropped a count was invisible.
 */
export function describeError(error: unknown): string {
  const name = getErrorName(error)
  const message = getErrorMessage(error)
  let stack: string | undefined
  if (typeof error === 'object' && error !== null) {
    try {
      const value = (error as { readonly stack?: unknown }).stack
      if (typeof value === 'string' && value.trim() !== '') stack = value.trim()
    } catch {
      stack = undefined
    }
  }
  const head = name && name !== '' ? `${name}: ${message}` : message
  return stack ? `${head}\n${stack}` : head
}
