import { parse, parseTokens, parseExpressionFromSource, parseWithRecovery, ParseError } from '@ast/builders'
export type { RecoverResult, ParserOptions } from '@ast/builders'
import { tokenize, LexError } from '@lexer/lexer'
export type { SourceComment, TokenizeOptions } from '@lexer/lexer'

// Re-export every AST/token type so consumers can `import type { ... } from "@tilua/parser"`.
export * from '@lexer/token'
export * from '@ast/nodes'
import { analyzeScopes, getBinding, isGlobal, isUnassignedGlobal, LANGUAGE_GLOBALS } from '@ast/analyzeScopes'
export type { ScopeAnalysis, ScopeDiagnostic, Binding, BindingId, BindingKind } from '@ast/analyzeScopes'
import { analyzeTypes, moduleExports } from '@ast/analyzeTypes'
export type { TypeAnalysis, AnalyzeTypesOptions, TypeDiagnostic, ModuleExports, ExportedType } from '@ast/analyzeTypes'
export * from '@ast/typeModel'
// The language's own utility types (`Partial`, `ReturnType`, ...) are built
// in; see `PRELUDE_SOURCE`. No globals are — not even `print`. A project names
// the type libraries it wants in `tilua.config.json` (`"types": ["roblox"]`), and
// the project functions find and load them. See `findConfig` and
// `resolveTypeLibraries`.
export { PRELUDE_SOURCE } from '@ast/prelude'
export {
    readDirectives, directivesOf, applyDirectives, UNUSED_EXPECT_ERROR,
    type Directive, type DirectiveKind, type Directives, type DirectiveOutcome,
} from '@ast/directives'
export * from './project'
// Writing Luau as text, and the questions a lowering plugin asks of a type —
// shared by the compiler, the plugins and anything else that emits Luau.
export { LUAU_KEYWORDS, isIdentifier, isLuauName, escapeLuauString, luauString } from './luau'
export { withoutNil, isFunctionType, isInstanceOf, hasMembers, returnsTuple } from './loweringHelpers'

// This package is the tilua *front end* only: source -> tilua AST (+ scope
// analysis). Emitting Luau is the downstream compiler's job — it lowers the
// tilua AST to a plain Luau AST and runs its own Luau printer (which lives in
// a separate project). There is deliberately no printer here.
export {
    tokenize, LexError,
    parse, parseTokens, parseExpressionFromSource, parseWithRecovery, ParseError,
    analyzeScopes, getBinding, isGlobal, isUnassignedGlobal, LANGUAGE_GLOBALS,
    analyzeTypes, moduleExports,
}

export const tilua = {
    tokenize,
    parseTokens,
    parse,
    parseExpressionFromSource,
    parseWithRecovery,
    analyzeScopes,
    getBinding,
    isGlobal,
    isUnassignedGlobal,
    analyzeTypes,
} as const

export default tilua
