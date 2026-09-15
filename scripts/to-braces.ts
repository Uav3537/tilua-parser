/**
 * Rewrite tilua's older `end` spelling into braces.
 *
 *     if x then ... end        ->   if (x) { ... }
 *     while x do ... end       ->   while (x) { ... }
 *     for i = 1, 10 do ... end ->   for (i = 1, 10) { ... }
 *     repeat ... until x       ->   repeat { ... } until (x)
 *     do ... end               ->   do { ... }
 *     function f() ... end     ->   function f() { ... }
 *     class C ... end          ->   class C { ... }
 *     (a: number) -> string    ->   (a: number) => string
 *
 * Two passes, because each knows something the other does not. The *tokens*
 * say where `then`, `do` and `end` are written, which the tree does not
 * record. The *tree* says where a function's header ends — past its return
 * type, which only a type parser can find — and which `if` is a statement
 * rather than the expression of the same name.
 *
 * Everything between the tokens it touches is left byte for byte, so comments,
 * strings and spacing come through unchanged. A rewrite that does not parse,
 * or that parses into a different tree, is reported and the file is left alone.
 *
 *     npx tsx scripts/to-braces.ts <file|dir>... [--check]
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tokenize, type Token } from "@lexer/lexer"
import { parse } from "@ast/builders"

interface Edit { start: number; end: number; text: string }

/** Line/column spans, as the parser writes them, into string offsets. */
class Offsets {
    private readonly lines: number[] = [0]

    constructor(source: string) {
        for (let i = 0; i < source.length; i++) if (source[i] === "\n") this.lines.push(i + 1)
    }

    start(node: { line: { start: number }; column: { start: number } }): number {
        return this.lines[node.line.start - 1] + node.column.start - 1
    }

    end(node: { line: { end: number }; column: { end: number } }): number {
        return this.lines[node.line.end - 1] + node.column.end - 1
    }
}

type AnyNode = Record<string, unknown> & { type?: string }

/** What the tree knows: where a body's `{` goes, and which `if` is a
 *  statement. */
function fromTree(source: string, offsets: Offsets, tokens: readonly Token[]): {
    opens: Set<number>
    statements: Set<number>
} {
    const opens = new Set<number>()
    const statements = new Set<number>()
    const span = (n: unknown): { line: { start: number; end: number }; column: { start: number; end: number } } | undefined =>
        n && typeof n === "object" && "line" in (n as object) ? n as never : undefined

    walk(parse(source), node => {
        if (node.type === "IfStatement" || node.type === "ClassDeclaration") {
            const at = span(node)
            if (at) statements.add(offsets.start(at))
        }
        if (node.type === "FunctionBody") {
            // Past the return type when there is one, and otherwise past the
            // `)` that closed the parameters.
            const after = span(node.returnType) ?? span(node.predicate)
            opens.add(after ? offsets.end(after) : closeOfParams(tokens, offsets, offsets.start(span(node)!)))
        }
        if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
            // `class Box<T>` and `class Ints extends Box<number>` both end
            // past a `>`, which is not part of the argument it closes.
            const args = (node.superArguments as unknown[] | undefined) ?? []
            const params = (node.typeParams as unknown[] | undefined) ?? []
            const past = (n: unknown): number => afterAngle(tokens, offsets, offsets.end(span(n)!))
            const at = span(node)
            opens.add(
                args.length ? past(args[args.length - 1])
                : node.superclass ? offsets.end(span(node.superclass)!)
                : params.length ? past(params[params.length - 1])
                : node.name ? offsets.end(span(node.name)!)
                : at ? offsets.start(at) + "class".length
                : 0,
            )
        }
    })
    return { opens, statements }
}

/** The offset just past the first `>` at or after `from`. */
function afterAngle(tokens: readonly Token[], offsets: Offsets, from: number): number {
    for (const token of tokens) {
        if (offsets.start(token) < from) continue
        if (token.type === "Operator" && String((token as { value?: unknown }).value) === ">") {
            return offsets.end(token)
        }
    }
    return from
}

/** The offset just past the `)` that closes a function's parameter list.
 *
 *  A generic list comes first, and is skipped whole: the parentheses inside a
 *  constraint — `<T extends (typeof Skills)[number]>` — are a type's, not the
 *  ones being looked for. */
function closeOfParams(tokens: readonly Token[], offsets: Offsets, from: number): number {
    const symbol = (token: Token): string | undefined =>
        token.type === "Punctuator" || token.type === "Operator"
            ? String((token as { value?: unknown }).value)
            : undefined

    let i = 0
    while (i < tokens.length && offsets.start(tokens[i]) < from) i++

    // The generic list, if there is one.
    if (i < tokens.length && symbol(tokens[i]) === "<") {
        let angle = 0
        let nested = 0
        for (; i < tokens.length; i++) {
            const value = symbol(tokens[i])
            if (value === "(" || value === "[" || value === "{") nested++
            else if (value === ")" || value === "]" || value === "}") nested--
            else if (nested === 0 && value === "<") angle++
            else if (nested === 0 && value === ">") {
                angle--
                if (angle === 0) { i++; break }
            }
        }
    }

    // Then the parameters.
    let depth = 0
    for (; i < tokens.length; i++) {
        const value = symbol(tokens[i])
        if (value === "(") depth++
        else if (value === ")") {
            depth--
            if (depth === 0) return offsets.end(tokens[i])
        }
    }
    return from
}

function walk(node: unknown, visit: (node: AnyNode) => void): void {
    if (!node || typeof node !== "object") return
    if (Array.isArray(node)) {
        for (const item of node) walk(item, visit)
        return
    }
    visit(node as AnyNode)
    for (const [key, value] of Object.entries(node)) {
        if (key !== "line" && key !== "column" && value && typeof value === "object") walk(value, visit)
    }
}

export function toBraces(source: string): string {
    const tokens = tokenize(source)
    const offsets = new Offsets(source)
    const { opens, statements } = fromTree(source, offsets, tokens)

    const word = (token: Token | undefined): string | undefined =>
        token && (token.type === "Keyword" || token.type === "Identifier")
            ? String((token as { value?: unknown }).value)
            : undefined

    /** Is the next thing written at `from` already a `{`? */
    const braced = (from: number): boolean => {
        for (const token of tokens) {
            if (offsets.start(token) < from) continue
            return token.type === "Punctuator" && String((token as { value?: unknown }).value) === "{"
        }
        return false
    }

    const edits: Edit[] = [...opens]
        .filter(at => !braced(at))
        .map(at => ({ start: at, end: at, text: " {" }))
    // A function type is written `=>`, as TypeScript writes it. `->` is only
    // ever that arrow, so the token alone decides it.
    for (const token of tokens) {
        if (token.type === "Punctuator" && String((token as { value?: unknown }).value) === "->") {
            edits.push({ start: offsets.start(token), end: offsets.end(token), text: "=>" })
        }
    }
    /** `if` blocks close each clause; everything else closes once. */
    const stack: ("if" | "block" | "repeat")[] = []

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i]
        const here = offsets.start(token)
        switch (word(token)) {
            case "if": {
                if (!statements.has(here)) break
                const then = matching(tokens, i, "then")
                if (then === undefined) break
                edits.push(header(source, offsets, token, tokens[then], "{"))
                stack.push("if")
                i = then
                break
            }
            case "elseif": {
                const then = matching(tokens, i, "then")
                if (then === undefined) break
                edits.push({ start: here, end: offsets.end(token), text: "} elseif" })
                edits.push(header(source, offsets, token, tokens[then], "{"))
                i = then
                break
            }
            case "else":
                if (stack[stack.length - 1] !== "if") break
                edits.push({ start: here, end: offsets.end(token), text: "} else {" })
                break
            case "while":
            case "for": {
                const doAt = matching(tokens, i, "do")
                if (doAt === undefined) break
                edits.push(header(source, offsets, token, tokens[doAt], "{"))
                stack.push("block")
                i = doAt
                break
            }
            case "repeat":
                if (braced(offsets.end(token))) break
                edits.push({ start: here, end: offsets.end(token), text: "repeat {" })
                stack.push("repeat")
                break
            case "until": {
                if (stack.pop() !== "repeat") break
                const last = endOfCondition(tokens, offsets, i + 1)
                edits.push({ start: here, end: offsets.end(token), text: "} until (" })
                edits.push({ start: offsets.end(last), end: offsets.end(last), text: ")" })
                break
            }
            case "do":
                // A loop's `do` was consumed with its header above; this one
                // opens a block of its own.
                if (braced(offsets.end(token))) break
                edits.push({ start: here, end: offsets.end(token), text: "do {" })
                stack.push("block")
                break
            case "function":
            case "class":
                if (word(token) === "class" && !statements.has(here)) break
                stack.push("block")
                break
            case "end":
                stack.pop()
                edits.push({ start: here, end: offsets.end(token), text: "}" })
                break
        }
    }

    return apply(source, edits)
}

/** `if <cond> then` -> `if (<cond>) {`. */
function header(source: string, offsets: Offsets, head: Token, close: Token, open: string): Edit {
    const between = source.slice(offsets.end(head), offsets.start(close))
    return { start: offsets.end(head), end: offsets.end(close), text: ` (${between.trim()}) ${open}` }
}

/** The `word` closing the header that starts at `from`, at the same nesting. */
function matching(tokens: readonly Token[], from: number, word: string): number | undefined {
    let depth = 0
    for (let i = from + 1; i < tokens.length; i++) {
        const token = tokens[i]
        if (token.type === "Punctuator") {
            const value = String((token as { value?: unknown }).value)
            if (value === "(" || value === "[" || value === "{") depth++
            if (value === ")" || value === "]" || value === "}") depth--
        }
        if (depth !== 0) continue
        const w = token.type === "Keyword" || token.type === "Identifier"
            ? String((token as { value?: unknown }).value)
            : undefined
        if (w === word) return i
        if (w === "end" || w === "else" || w === "elseif" || w === "until" || w === "function") return undefined
    }
    return undefined
}

/** The last token of a `repeat`'s condition: it runs to the end of its line,
 *  or to whatever closes the block around it. */
function endOfCondition(tokens: readonly Token[], offsets: Offsets, from: number): Token {
    let depth = 0
    let last = tokens[from]
    for (let i = from; i < tokens.length; i++) {
        const token = tokens[i]
        if (token.type === "EOF") break
        if (token.type === "Punctuator") {
            const value = String((token as { value?: unknown }).value)
            if (value === "(" || value === "[" || value === "{") depth++
            if (value === ")" || value === "]" || value === "}") depth--
        }
        if (depth < 0) break
        if (depth === 0 && i > from && token.line.start > last.line.end) break
        last = token
        void offsets
    }
    return last
}

function apply(source: string, edits: readonly Edit[]): string {
    const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end)
    let out = ""
    let cursor = 0
    for (const edit of sorted) {
        if (edit.start < cursor) continue
        out += source.slice(cursor, edit.start) + edit.text
        cursor = edit.end
    }
    return out + source.slice(cursor)
}

// ------------------------------------------------------------
// CLI
// ------------------------------------------------------------

function files(path: string): string[] {
    if (statSync(path).isFile()) return path.endsWith(".tilua") ? [path] : []
    return readdirSync(path).flatMap(entry => files(join(path, entry)))
}

/** Spans move when punctuation does; everything else must match. */
function withoutSpans(key: string, value: unknown): unknown {
    return key === "line" || key === "column" ? undefined : value
}

if (process.argv[1]?.endsWith("to-braces.ts")) {
const args = process.argv.slice(2)
    const check = args.includes("--check")
    const targets = args.filter(a => !a.startsWith("--"))
    if (!targets.length) {
        console.error("usage: tsx scripts/to-braces.ts <file|dir>... [--check]")
        process.exit(2)
    }
    
    let changed = 0
    let failed = 0
    for (const target of targets.flatMap(files)) {
        const before = readFileSync(target, "utf8")
        let after: string
        try {
            after = toBraces(before)
        } catch (error) {
            console.error(`${target}: ${(error as Error).message}`)
            failed++
            continue
        }
        if (after === before) continue
        // The rewrite has to parse, and has to say the same thing: the tree it
        // makes is compared with the tree the original made.
        try {
            if (JSON.stringify(parse(before), withoutSpans) !== JSON.stringify(parse(after), withoutSpans)) {
                console.error(`${target}: the rewrite does not say the same thing`)
                failed++
                continue
            }
        } catch (error) {
            console.error(`${target}: the rewrite does not parse: ${(error as Error).message}`)
            failed++
            continue
        }
        changed++
        if (!check) writeFileSync(target, after)
        console.log(`${check ? "would rewrite" : "rewrote"} ${target}`)
    }
    console.log(`${changed} file${changed === 1 ? "" : "s"}${failed ? `, ${failed} left alone` : ""}`)
    process.exit(failed ? 1 : 0)
}
