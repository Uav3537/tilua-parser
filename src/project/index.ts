/**
 * Projects: `tilua.config.json`, the type libraries it names, import paths,
 * and a sourcemap's instance tree. Node-only (it reads files), and separate
 * from the parsing and analysis, which never touch the file system.
 */
export { nodeHost, type ProjectHost } from "./host"
export {
    CONFIG_FILE_NAMES, CONFIG_OPTIONS, findConfig, loadConfig, stripJsonComments,
    type TiluaConfig, type OutputMode, type ConfigProblem, type ConfigLookup,
} from "./config"
export {
    resolveTypeLibraries, type TypeLibraries, type LoweringModule, type LibraryOption, type LibraryOptionType,
} from "./libraries"
export type {
    LoweringPlugin, LuaSyntax, MethodCall, MethodLowering, GlobalCall, GlobalValue, CallLowering, CallSite, ArgumentInfo,
    PluginContext, EntryExports, EntryExportsLowering, FilesLayout, FilesAnswer,
} from "./lowering"
export { moduleCandidates, resolveModulePath, importExpressions } from "./modules"
export { sourceMapTypes, type SourceMapNode, type SourceMapOptions, type SourceMapTypes } from "./sourcemap"
