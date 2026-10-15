// Source entry for the `auto` web-search provider.
//
// Like the package entry, the implementation is plain JavaScript staged into `lib/` by the
// build script; this module gives the `./web-search` export a workspace-source target so the
// tsx source launch and the tsconfig-paths gates resolve source rather than built output.
export * from '../web-search.js'
