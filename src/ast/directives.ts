import { tokenize, type LexError, type SourceComment, type Token } from "@lexer/lexer"

/**
 * Comments that switch checking off, as TypeScript's `// @ts-...` comments do:
 *
 *     --@tilua-nocheck         no scope or type errors anywhere in this file
 *     --@tilua-ignore          none on the next line of code
 *     --@tilua-expect-error    none on the next line of code, and an error if
 *                              that line has none to suppress
 *
 * A space after `--` is fine, and so is text after the directive (a reason).
 * `nocheck` counts only in the comments before the first line of code, as in
 * TypeScript. Syntax errors are never suppressed: code that does not parse
 * cannot be compiled either way.
 */
export type DirectiveKind = "nocheck" | "ignore" | "expect-error"

export interface Directive {
    kind: DirectiveKind
    /** Where the comment starts. */
    line: number
    column: number
    /** `ignore` / `expect-error`: the line whose diagnostics it covers — the
     *  next line with code on it. */
    target?: number
}

export interface Directives {
    /** The file has `--@tilua-nocheck` before its first line of code. */
    nocheck: boolean
    /** Every directive, in order — a `nocheck` after the code starts included,
     *  so a tool can point out that it does nothing. */
    all: Directive[]
}

const DIRECTIVE = /^\s*@tilua-(nocheck|ignore|expect-error)(?![\w-])/

/** The directives in `comments`, placed against `tokens` (both from one
 *  `tokenize` of the file). */
export function readDirectives(comments: readonly SourceComment[], tokens: readonly Token[]): Directives {
    const codeLines = [...new Set(tokens.filter(t => t.type !== "EOF").map(t => t.line.start))].sort((a, b) => a - b)
    const firstCode = codeLines[0] ?? Infinity
    const all: Directive[] = []
    let nocheck = false
    for (const comment of comments) {
        const match = DIRECTIVE.exec(comment.text)
        if (!match) continue
        const kind = match[1] as DirectiveKind
        if (kind === "nocheck") {
            if (comment.line < firstCode) nocheck = true
            all.push({ kind, line: comment.line, column: comment.column })
            continue
        }
        const target = codeLines.find(l => l > comment.endLine)
        all.push({ kind, line: comment.line, column: comment.column, target })
    }
    return { nocheck, all }
}

/** The directives of `source`, for a caller that parsed it some other way. */
export function directivesOf(source: string): Directives {
    const comments: SourceComment[] = []
    const errors: LexError[] = []
    const tokens = tokenize(source, { errors, comments })
    return readDirectives(comments, tokens)
}

export interface DirectiveOutcome<T> {
    /** The diagnostics no directive suppresses. */
    kept: T[]
    /** `--@tilua-expect-error` comments with nothing to suppress. Each is an
     *  error to report: "Unused '@tilua-expect-error' directive". */
    unusedExpectErrors: Directive[]
}

/** Filter scope and type diagnostics — never syntax errors — through the
 *  file's directives. `lineOf` gives the line a diagnostic starts on. */
export function applyDirectives<T>(
    directives: Directives,
    diagnostics: readonly T[],
    lineOf: (diagnostic: T) => number,
): DirectiveOutcome<T> {
    if (directives.nocheck) return { kept: [], unusedExpectErrors: [] }
    const covering = new Map<number, Directive[]>()
    for (const d of directives.all) {
        if (d.target === undefined) continue
        covering.set(d.target, [...(covering.get(d.target) ?? []), d])
    }
    const used = new Set<Directive>()
    const kept = diagnostics.filter(diagnostic => {
        const on = covering.get(lineOf(diagnostic))
        if (!on) return true
        for (const d of on) used.add(d)
        return false
    })
    const unusedExpectErrors = directives.all.filter(d => d.kind === "expect-error" && !used.has(d))
    return { kept, unusedExpectErrors }
}

export const UNUSED_EXPECT_ERROR = "Unused '@tilua-expect-error' directive"
