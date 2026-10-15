// DS Bot's browser half is built by `scripts/build-client.mjs` (esbuild) into the committed
// `client.js`, because `link:` and git installs load it without running a build. This config
// exists for the notices walk, which reads every `dsh.client` package's browser build: it names
// the real source entry and the real externals so the disclosure set matches what ships.
//
// It is not part of the workspace build. `pnpm run build:lib:host` runs tsdown once for the
// whole client face, and this package's artifacts are produced by its own `build` script.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const manifest = JSON.parse(readFileSync(join(import.meta.dirname, 'package.json'), 'utf8'))

export default {
  name: `${manifest.name}/client`,
  entry: { client: 'src/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  clean: false,
  deps: {
    // The shell seeds these through the module loader's require, so the bundle leaves them
    // external; DS Bot ships no third-party browser code of its own.
    neverBundle: (specifier) => ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives']
      .some(name => specifier === name || specifier.startsWith(`${name}/`)),
    alwaysBundle: () => false,
  },
}
