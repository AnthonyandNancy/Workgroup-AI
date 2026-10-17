// Source entry for the Bot team host.
//
// The Host half is authored as plain JavaScript (`../index.js` and the modules under
// `src/host` and `src/shared`), and the package's build script stages that tree into `lib/`
// unchanged. This module exists so the package resolves to *workspace source* wherever the
// repository resolves workspace packages: the tsx source launch and the gates that read
// `tsconfig.base.json` paths both require a TypeScript entry point, and pointing them at
// `lib/` would make a source launch depend on built output.
export * from '../index.js';
//# sourceMappingURL=index.js.map