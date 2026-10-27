import { tokenize, type LexError, type SourceComment, type Token } from "@lexer/lexer"

/**
 * Comments that switch checking off, as TypeScript's `// @ts-...` comments do:
 *
 *     --@tilua-nocheck          no scope or type errors or warnings anywhere
 *                               in this file
 *     --@tilua-ignore           none on the next line of code
 *     --@tilua-expect-error     no errors on the next line of code, and an
 *                               error if that line has none to suppress
 *     --@tilua-expect-warning   no warnings on the next line of code, and a
 *                               warning if that line has none to suppress
 *
 * An `expect-` directive covers its own kind only: an error is not what an
 * `expect-warning` is there for, nor a warning what an `expect-error` waits
 * for, so neither hides the other or is answered by it.
 *
 * A space after `--` is fine, and so is text after the directive (a reason).
 * `nocheck` counts only in the comments before the first line of code, as in
 * TypeScript. Syntax errors are never suppressed: code that does not parse
 * cannot be compiled either way.
 */
export type DirectiveKind = "nocheck" | "ignore" | "expect-error" | "expect-warning"

export interface Directive {
    kind: DirectiveKind
    /** Where the comment starts. */
    line: number
    column: number
    /** `ignore` / `expect-...`: the line whose diagnostics it covers — the
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

const DIRECTIVE = /^\s*@tilua-(nocheck|ignore|expect-error|expect-warning)(?![\w-])/

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
    /** `--@tilua-expect-error` comments with no error to suppress. Each is an
     *  error to report: "Unused '@tilua-expect-error' directive". */
    unusedExpectErrors: Directive[]
    /** `--@tilua-expect-warning` comments with no warning to suppress. Each
     *  is a warning to report: "Unused '@tilua-expect-warning' directive". */
    unusedExpectWarnings: Directive[]
}

/** Filter scope and type diagnostics — never syntax errors — through the
 *  file's directives. `lineOf` gives the line a diagnostic starts on, and
 *  `isWarning` whether it is a warning; without it, every one is an error. */
export function applyDirectives<T>(
    directives: Directives,
    diagnostics: readonly T[],
    lineOf: (diagnostic: T) => number,
    isWarning: (diagnostic: T) => boolean = () => false,
): DirectiveOutcome<T> {
    if (directives.nocheck) return { kept: [], unusedExpectErrors: [], unusedExpectWarnings: [] }
    const covering = new Map<number, Directive[]>()
    for (const d of directives.all) {
        if (d.target === undefined) continue
        covering.set(d.target, [...(covering.get(d.target) ?? []), d])
    }
    const used = new Set<Directive>()
    const kept = diagnostics.filter(diagnostic => {
        const covers = (covering.get(lineOf(diagnostic)) ?? []).filter(d =>
            d.kind === "ignore" || d.kind === (isWarning(diagnostic) ? "expect-warning" : "expect-error"))
        for (const d of covers) used.add(d)
        return covers.length === 0
    })
    const unused = (kind: DirectiveKind): Directive[] => directives.all.filter(d => d.kind === kind && !used.has(d))
    return { kept, unusedExpectErrors: unused("expect-error"), unusedExpectWarnings: unused("expect-warning") }
}

export const UNUSED_EXPECT_ERROR = "Unused '@tilua-expect-error' directive"
export const UNUSED_EXPECT_WARNING = "Unused '@tilua-expect-warning' directive"
