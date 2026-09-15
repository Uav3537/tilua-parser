export interface BaseToken {
    line: {
        start: number
        end: number
    }
    column: {
        start: number
        end: number
    }
}

export const Keywords = [
    'and', 'break', 'do', 'else', 'elseif',
    'end', 'false', 'for', 'function', 'if',
    'in', 'nil', 'not', 'or', 'repeat',
    'return', 'then', 'true', 'until', 'while',
    'continue',
    // tilua extensions. `local` is gone — declarations use `const` / `let`
    // (hard keywords). `type` stays a soft keyword.
    'const', 'let', 'import', 'export', 'from', 'as',
] as const

export interface KeywordToken extends BaseToken {
    type: "Keyword"
    value: typeof Keywords[number]
}

export interface IdentifierToken extends BaseToken {
    type: "Identifier"
    value: string
}

export type LiteralToken =
    | (BaseToken & { type: "Literal"; kind: "number"; value: number; raw: string })
    | (BaseToken & { type: "Literal"; kind: "string"; value: string; raw: string })
    | (BaseToken & { type: "Literal"; kind: "nil"; value: null })
    | (BaseToken & { type: "Literal"; kind: "boolean"; value: boolean })

export const Operators = [
    "+=", "-=", "*=", "/=", "//=", "%=", "^=", "..=",
    "==", "~=", "<=", ">=",
    "//", "..", "...",
    "+", "-", "*", "/", "%", "^", "#",
    "<", ">", "=",
] as const

export interface OperatorToken extends BaseToken {
    type: "Operator"
    value: typeof Operators[number]
}

export const Punctuators = [
    "::",
    "(", ")", "{", "}", "[", "]",
    ";", ":", ",", ".",
    "?", "=>", "->", "&", "|", "@",
] as const

export interface PunctuatorToken extends BaseToken {
    type: "Punctuator"
    value: typeof Punctuators[number]
}

export interface InterpolatedStringPart_String {
    kind: "string"
    value: string
    raw: string
}

export interface InterpolatedStringPart_Expression {
    kind: "expression"
    raw: string
    /** Where `raw` starts in the file, so what is parsed from it can be
     *  placed there rather than at the top of an imaginary one. */
    line: number
    column: number
}

export interface InterpolatedStringToken extends BaseToken {
    type: "InterpolatedString"
    parts: (InterpolatedStringPart_String | InterpolatedStringPart_Expression)[]
}

export interface EOFToken extends BaseToken {
    type: "EOF"
}

export type Token =
    | KeywordToken
    | LiteralToken
    | OperatorToken
    | PunctuatorToken
    | IdentifierToken
    | InterpolatedStringToken
    | EOFToken

// ============================================================
// Helpers
// ============================================================

function isDigit(ch: string): boolean {
    return ch >= "0" && ch <= "9"
}

function isHexDigit(ch: string): boolean {
    return isDigit(ch) || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F")
}

function isAlpha(ch: string): boolean {
    return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_"
}

function isAlphaNumeric(ch: string): boolean {
    return isAlpha(ch) || isDigit(ch)
}

const KeywordSet: ReadonlySet<string> = new Set(Keywords)

const OperatorSet: ReadonlySet<string> = new Set(Operators)
const SortedSymbols = [...Operators, ...Punctuators].sort((a, b) => b.length - a.length)

export class LexError extends Error {
    constructor(message: string, public line: number, public column: number) {
        super(`${message} (${line}:${column})`)
    }
}

// ============================================================
// Tokenizer
// ============================================================

/** A `--` comment: its text after the dashes (a long comment's content), and
 *  where it starts and ends. */
export interface SourceComment {
    text: string
    line: number
    column: number
    endLine: number
}

export interface TokenizeOptions {
    /** When given, a malformed token is recorded here instead of thrown, and
     *  lexing goes on: an unclosed string or comment ends at the end of its
     *  line (a long bracket at the end of the source), and a character that
     *  starts no token is skipped. An editor mid-keystroke still gets every
     *  other token. */
    errors?: LexError[]
    /** When given, every comment is collected here, in order. */
    comments?: SourceComment[]
}

export function tokenize(source: string, options: TokenizeOptions = {}): Token[] {
    const { errors, comments } = options
    const tokens: Token[] = []
    let cursor = 0
    let line = 1
    let column = 1

    function fail(message: string, atLine: number, atColumn: number): void {
        const error = new LexError(message, atLine, atColumn)
        if (!errors) throw error
        errors.push(error)
    }

    function peek(offset = 0): string {
        return source[cursor + offset] ?? ""
    }

    function isAtEnd(): boolean {
        return cursor >= source.length
    }

    function advance(): string {
        const ch = source[cursor]
        cursor++
        if (ch === "\n") {
            line++
            column = 1
        } else {
            column++
        }
        return ch
    }

    function match(str: string): boolean {
        if (source.startsWith(str, cursor)) {
            for (let i = 0; i < str.length; i++) advance()
            return true
        }
        return false
    }

    function makeBase(startLine: number, startColumn: number): BaseToken {
        return {
            line: { start: startLine, end: line },
            column: { start: startColumn, end: column },
        }
    }

    /**
     * `allowLevel0` — whether a bare `[[ ... ]]` (no `=` signs) counts as a
     * long bracket. tilua reuses `[` / `]` for array literals, so `[[` in
     * expression position is a nested array, NOT a long string. Level-0 long
     * brackets are therefore only recognized inside comments (`--[[ ... ]]`);
     * long string *literals* require `[=[ ... ]=]` (level ≥ 1).
     */
    function tryLongBracketOpen(allowLevel0 = true): number | null {
        const save = cursor
        const saveLine = line
        const saveColumn = column

        if (peek() !== "[") return null
        let i = cursor + 1
        let level = 0
        while (source[i] === "=") {
            level++
            i++
        }
        if (source[i] === "[" && (level > 0 || allowLevel0)) {
            advance()
            for (let k = 0; k < level; k++) advance()
            advance()
            return level
        }

        cursor = save
        line = saveLine
        column = saveColumn
        return null
    }

    function readLongBracketContent(level: number): string {
        if (peek() === "\r") advance()
        if (peek() === "\n") advance()

        let content = ""
        while (true) {
            if (isAtEnd()) {
                fail("Unterminated long bracket", line, column)
                return content
            }
            if (peek() === "]") {
                const save = cursor
                const saveLine = line
                const saveColumn = column
                advance()
                let eq = 0
                while (peek() === "=") {
                    eq++
                    advance()
                }
                if (eq === level && peek() === "]") {
                    advance()
                    return content
                }
                cursor = save
                line = saveLine
                column = saveColumn
                content += advance()
            } else {
                content += advance()
            }
        }
    }

    function skipLineComment() {
        while (!isAtEnd() && peek() !== "\n") advance()
    }

    function skipWhitespaceAndComments() {
        while (!isAtEnd()) {
            const ch = peek()
            if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
                advance()
                continue
            }
            if (ch === "-" && peek(1) === "-") {
                const startLine = line
                const startColumn = column
                advance()
                advance()
                if (peek() === "[") {
                    const level = tryLongBracketOpen()
                    if (level !== null) {
                        const text = readLongBracketContent(level)
                        comments?.push({ text, line: startLine, column: startColumn, endLine: line })
                        continue
                    }
                }
                const textStart = cursor
                skipLineComment()
                comments?.push({ text: source.slice(textStart, cursor).replace(/\r$/, ""), line: startLine, column: startColumn, endLine: startLine })
                continue
            }
            break
        }
    }

    function readNumber(): LiteralToken {
        const startLine = line
        const startColumn = column
        const start = cursor

        if (peek() === "0" && (peek(1) === "x" || peek(1) === "X")) {
            advance(); advance()
            while (isHexDigit(peek()) || peek() === "_") advance()
        } else if (peek() === "0" && (peek(1) === "b" || peek(1) === "B")) {
            advance(); advance()
            while (peek() === "0" || peek() === "1" || peek() === "_") advance()
        } else {
            while (isDigit(peek()) || peek() === "_") advance()
            if (peek() === "." && isDigit(peek(1))) {
                advance()
                while (isDigit(peek()) || peek() === "_") advance()
            } else if (peek() === "." && peek(1) !== "." && !isAlpha(peek(1))) {
                advance()
                while (isDigit(peek()) || peek() === "_") advance()
            }
            if (peek() === "e" || peek() === "E") {
                const save = cursor, saveLine = line, saveColumn = column
                advance()
                if (peek() === "+" || peek() === "-") advance()
                if (isDigit(peek())) {
                    while (isDigit(peek())) advance()
                } else {
                    cursor = save; line = saveLine; column = saveColumn
                }
            }
        }

        const raw = source.slice(start, cursor)
        const cleaned = raw.replace(/_/g, "")
        let value: number
        if (/^0[xX]/.test(cleaned)) {
            value = parseInt(cleaned, 16)
        } else if (/^0[bB]/.test(cleaned)) {
            value = parseInt(cleaned.slice(2), 2)
        } else {
            value = parseFloat(cleaned)
        }

        return {
            type: "Literal",
            kind: "number",
            value,
            raw,
            ...makeBase(startLine, startColumn),
        }
    }

    function readEscapeSequence(): string {
        const ch = advance()
        switch (ch) {
            case "n": return "\n"
            case "t": return "\t"
            case "r": return "\r"
            case "a": return "\x07"
            case "b": return "\b"
            case "f": return "\f"
            case "v": return "\v"
            case "\\": return "\\"
            case '"': return '"'
            case "'": return "'"
            case "`": return "`"
            case "\n": return "\n"
            case "z": {
                while (!isAtEnd() && /\s/.test(peek())) advance()
                return ""
            }
            case "x": {
                let hex = ""
                for (let i = 0; i < 2 && isHexDigit(peek()); i++) hex += advance()
                return String.fromCharCode(parseInt(hex, 16))
            }
            default: {
                if (isDigit(ch)) {
                    let dec = ch
                    for (let i = 0; i < 2 && isDigit(peek()); i++) dec += advance()
                    return String.fromCharCode(parseInt(dec, 10))
                }
                return ch
            }
        }
    }

    function readQuotedString(): LiteralToken {
        const startLine = line
        const startColumn = column
        const rawStart = cursor
        const quote = advance()

        let value = ""
        while (true) {
            const ch = peek()
            if (isAtEnd() || ch === "\n") {
                fail("Unterminated string", line, column)
                break
            }
            if (ch === quote) {
                advance()
                break
            }
            if (ch === "\\") {
                advance()
                value += readEscapeSequence()
                continue
            }
            value += advance()
        }

        const raw = source.slice(rawStart, cursor)
        return {
            type: "Literal",
            kind: "string",
            value,
            raw,
            ...makeBase(startLine, startColumn),
        }
    }

    function readLongString(): LiteralToken {
        const startLine = line
        const startColumn = column
        const rawStart = cursor

        const level = tryLongBracketOpen(false)
        if (level === null) {
            throw new LexError("Expected long string bracket", line, column)
        }
        const value = readLongBracketContent(level)
        const raw = source.slice(rawStart, cursor)

        return {
            type: "Literal",
            kind: "string",
            value,
            raw,
            ...makeBase(startLine, startColumn),
        }
    }

    function readInterpolatedString(): InterpolatedStringToken {
        const startLine = line
        const startColumn = column
        advance()

        const parts: (InterpolatedStringPart_String | InterpolatedStringPart_Expression)[] = []
        let currentRaw = ""
        let currentValue = ""

        function flushString() {
            parts.push({ kind: "string", value: currentValue, raw: currentRaw })
            currentRaw = ""
            currentValue = ""
        }

        while (true) {
            if (isAtEnd()) {
                fail("Unterminated interpolated string", line, column)
                flushString()
                break
            }
            const ch = peek()

            if (ch === "`") {
                advance()
                flushString()
                break
            }

            if (ch === "\\") {
                const escStart = cursor
                advance()
                currentValue += readEscapeSequence()
                currentRaw += source.slice(escStart, cursor)
                continue
            }

            // `${expr}` — JS/TS interpolation. A bare `{` is an ordinary
            // character (Luau's `{expr}` form is deliberately not supported),
            // and `\$` escapes a literal dollar sign.
            if (ch === "$" && peek(1) === "{") {
                flushString()
                advance() // '$'
                advance() // '{'
                const exprStart = cursor
                const exprLine = line
                const exprColumn = column
                let depth = 1
                let closed = true
                while (depth > 0) {
                    if (isAtEnd()) {
                        fail("Unterminated interpolation expression", line, column)
                        closed = false
                        break
                    }
                    if (peek() === "{") depth++
                    if (peek() === "}") {
                        depth--
                        if (depth === 0) break
                    }
                    advance()
                }
                const exprRaw = source.slice(exprStart, cursor)
                parts.push({ kind: "expression", raw: exprRaw, line: exprLine, column: exprColumn })
                if (!closed) {
                    flushString()
                    break
                }
                advance()
                continue
            }

            const chStart = cursor
            const consumed = advance()
            currentValue += consumed
            currentRaw += source.slice(chStart, cursor)
        }

        return {
            type: "InterpolatedString",
            parts,
            ...makeBase(startLine, startColumn),
        }
    }

    function readIdentifierOrKeyword(): KeywordToken | IdentifierToken | LiteralToken {
        const startLine = line
        const startColumn = column
        const start = cursor

        while (!isAtEnd() && isAlphaNumeric(peek())) advance()

        const value = source.slice(start, cursor)

        if (value === "true" || value === "false") {
            return {
                type: "Literal",
                kind: "boolean",
                value: value === "true",
                ...makeBase(startLine, startColumn),
            }
        }

        if (value === "nil") {
            return {
                type: "Literal",
                kind: "nil",
                value: null,
                ...makeBase(startLine, startColumn),
            }
        }

        if (KeywordSet.has(value)) {
            return {
                type: "Keyword",
                value: value as typeof Keywords[number],
                ...makeBase(startLine, startColumn),
            }
        }

        return {
            type: "Identifier",
            value,
            ...makeBase(startLine, startColumn),
        }
    }

    function readOperatorOrPunctuator(): OperatorToken | PunctuatorToken | undefined {
        const startLine = line
        const startColumn = column

        for (const sym of SortedSymbols) {
            if (source.startsWith(sym, cursor)) {
                for (let i = 0; i < sym.length; i++) advance()
                if (OperatorSet.has(sym)) {
                    return {
                        type: "Operator",
                        value: sym as typeof Operators[number],
                        ...makeBase(startLine, startColumn),
                    }
                }
                return {
                    type: "Punctuator",
                    value: sym as typeof Punctuators[number],
                    ...makeBase(startLine, startColumn),
                }
            }
        }

        fail(`Unexpected character '${peek()}'`, line, column)
        advance()
        return undefined
    }

    while (true) {
        skipWhitespaceAndComments()
        if (isAtEnd()) break

        const ch = peek()

        if (isDigit(ch) || (ch === "." && isDigit(peek(1)))) {
            tokens.push(readNumber())
            continue
        }

        if (ch === '"' || ch === "'") {
            tokens.push(readQuotedString())
            continue
        }

        if (ch === "`") {
            tokens.push(readInterpolatedString())
            continue
        }

        // Long string literal — only the leveled form `[=[ ... ]=]`. Bare `[[`
        // is two `[` punctuators (nested array literal), not a long string.
        if (ch === "[" && peek(1) === "=") {
            const save = cursor, saveLine = line, saveColumn = column
            const level = tryLongBracketOpen(false)
            if (level !== null) {
                cursor = save; line = saveLine; column = saveColumn
                tokens.push(readLongString())
                continue
            }
        }

        if (isAlpha(ch)) {
            tokens.push(readIdentifierOrKeyword())
            continue
        }

        const symbol = readOperatorOrPunctuator()
        if (symbol) tokens.push(symbol)
    }

    tokens.push({
        type: "EOF",
        line: { start: line, end: line },
        column: { start: column, end: column },
    })

    return tokens
}