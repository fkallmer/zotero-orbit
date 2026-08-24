/**
 * Teach Node the resolutions the bundler performs and it does not.
 *
 * `src/` is written for esbuild. It imports `../utils/locale` without an
 * extension, and it takes named exports off `../../package.json` -- neither of
 * which Node's ESM loader will do. So any test that imports a real module,
 * rather than one of the dependency-free `.core.ts` files, failed before it
 * ran. That is why the tab's render path had no coverage at all, and why a
 * plugin that drew nothing still passed 296 tests.
 *
 * Adding extensions across the whole module graph would be a sweep of dozens
 * of unrelated files. This applies the same two rules, only where Node would
 * otherwise give up.
 */
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
/** `package.json` has a "private" key, and `export const private` is a syntax error. */
const RESERVED = new Set([
  'private',
  'public',
  'protected',
  'static',
  'default',
  'class',
  'new',
  'delete',
  'import',
  'export',
  'const',
  'let',
  'var',
  'function',
  'return',
  'typeof',
  'void',
  'in',
  'of',
  'do',
  'if',
  'else',
  'for',
  'while',
  'switch',
  'case',
  'break',
  'continue',
  'this',
  'super',
  'null',
  'true',
  'false',
  'try',
  'catch',
  'finally',
  'throw',
  'with',
  'yield',
  'await',
  'enum',
  'extends',
  'implements',
  'interface',
  'package',
  'instanceof',
])

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context)
    } catch (error) {
      // Only real extensions count: `./semanticScholarClient.core` ends in a
      // dotted word and is still a module that wants `.ts` appended.
      if (specifier.startsWith('.') && !/\.(ts|tsx|js|mjs|cjs|json)$/i.test(specifier)) {
        return nextResolve(`${specifier}.ts`, context)
      }
      throw error
    }
  },

  load(url, context, nextLoad) {
    if (!url.endsWith('.json')) return nextLoad(url, context)
    // Re-published as a module with named exports, which is what the bundler
    // gives `import { config } from '../../package.json'` and Node does not.
    const raw = readFileSync(fileURLToPath(url), 'utf8')
    const named = Object.keys(JSON.parse(raw)).filter((key) => IDENTIFIER.test(key) && !RESERVED.has(key))
    const source =
      `const data = ${raw};\nexport default data;\n` +
      named.map((key) => `export const ${key} = data[${JSON.stringify(key)}];`).join('\n')
    return { format: 'module', shortCircuit: true, source }
  },
})
