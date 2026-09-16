/**
 * Projects: `tilua.config.json`, the type libraries it names, import paths,
 * and a sourcemap's instance tree. Node-only (it reads files), and separate
 * from the parsing and analysis, which never touch the file system.
 */
export { nodeHost, type ProjectHost } from "./host"
export {
    CONFIG_FILE_NAMES, findConfig, loadConfig, stripJsonComments,
    type TiluaConfig, type BuildTarget, type ConfigProblem, type ConfigLookup,
} from "./config"
export { resolveTypeLibraries, type TypeLibraries, type LoweringModule } from "./libraries"
export type {
    LoweringPlugin, MethodCall, MethodLowering, GlobalCall, GlobalValue, CallLowering, CallSite, ArgumentInfo,
} from "./lowering"
export { moduleCandidates, resolveModulePath } from "./modules"
export { sourceMapTypes, type SourceMapNode, type SourceMapOptions, type SourceMapTypes } from "./sourcemap"
