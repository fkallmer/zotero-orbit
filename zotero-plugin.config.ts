import { defineConfig } from 'zotero-plugin-scaffold'
import pkg from './package.json' with { type: 'json' }

export default defineConfig({
  source: ['src', 'addon'],
  dist: '.scaffold/build',
  name: pkg.config.addonName,
  id: pkg.config.addonID,
  namespace: pkg.config.addonRef,
  // No updateURL while this fork has no release channel of its own. The
  // template resolves {{owner}}/{{repo}} from the git remote, which still
  // points at upstream -- leaving it in would let Zotero silently "update"
  // this build back to daeh's release and drop the OpenAlex provider.
  // Restore it once the fork publishes its own update.json.
  xpiDownloadLink: 'https://github.com/{{owner}}/{{repo}}/releases/download/v{{version}}/{{xpiName}}.xpi',

  build: {
    assets: ['addon/**/*.*'],
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
        },
        bundle: true,
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
