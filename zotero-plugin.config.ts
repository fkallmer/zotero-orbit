import { existsSync, readFileSync } from 'node:fs'
import process from 'node:process'

import { defineConfig } from 'zotero-plugin-scaffold'

import pkg from './package.json' with { type: 'json' }

/**
 * The address OpenAlex is given for its polite pool.
 *
 * Read from the environment or from an untracked `.orbit-contact`, never from
 * a file in the repository: it identifies whoever runs the build, and anyone
 * forking this must not go on sending an address that is not theirs. Unset is
 * a supported state -- OpenAlex answers from the common pool, more slowly.
 */
const contact = (
  process.env.ORBIT_CONTACT ?? (existsSync('.orbit-contact') ? readFileSync('.orbit-contact', 'utf8') : '')
).trim()

export default defineConfig({
  source: ['src', 'addon'],
  dist: '.scaffold/build',
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  // updateURL is left at the scaffold's default, which resolves to
  // fkallmer/zotero-orbit and is served from the `release` tag. It once had to
  // be suppressed, because {{owner}}/{{repo}} resolved to upstream and Zotero
  // would have "updated" this build back to daeh's release; the remote is this
  // fork's now, and the release channel exists.
  xpiDownloadLink: 'https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi',

  build: {
    // The licences travel with the package. MPL-2.0 section 3.1 and AGPL
    // section 5 both require them wherever the thing is distributed, and an
    // XPI is exactly that the moment it leaves this machine.
    assets: ['addon/**/*.*', 'LICENSE', 'LICENSE-MPL-2.0'],
    define: {
      ...pkg.config,
      author: pkg.author,
      description: pkg.description,
      homepage: pkg.homepage,
      buildVersion: pkg.version,
      buildTime: '{{buildTime}}',
      // Substituted into raw assets (bootstrap.js) — the bundle gets __env__ from esbuild below.
      buildEnv: process.env.NODE_ENV === 'development' ? 'development' : 'production',
    },
    prefs: {
      prefix: pkg.config.prefsPrefix,
    },
    esbuildOptions: [
      {
        entryPoints: ['src/index.ts'],
        define: {
          __env__: `"${process.env.NODE_ENV}"`,
          __contact__: JSON.stringify(contact),
        },
        bundle: true,
        // Keep licence comments. esbuild drops every comment otherwise, and
        // the MPL notice on the Google Scholar client has to reach whoever
        // receives the built file.
        legalComments: 'eof',
        target: 'firefox140',
        outfile: `.scaffold/build/addon/content/scripts/${pkg.config.addonRef}.js`,
      },
    ],
  },

  test: {
    // Only this directory is bundled into the Zotero test window; the Node
    // unit tests under test/ must not be swept into the browser environment.
    entries: 'test/zotero',
    mocha: {
      timeout: 30000,
    },
    waitForPlugin: `() => Zotero.${pkg.config.addonInstance}.data.initialized`,
  },

  // For detailed logging, uncomment:
  // logLevel: "trace",
})
