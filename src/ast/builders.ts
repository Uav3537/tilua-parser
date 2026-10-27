import { tokenize, LexError, type Token, type SourceComment } from "@lexer/lexer"
import { readDirectives, type Directives } from "./directives"
import type {
    Program, Block, Statement, Expression, TypeNode,
    VariableDeclaration, FunctionDeclaration, FunctionDeclarationStatement,
    AssignmentStatement, CompoundAssignmentStatement, CallStatement,
    DoStatement, WhileStatement, RepeatStatement, IfStatement, IfClause,
    NumericForStatement, GenericForStatement, ReturnStatement,
    BreakStatement, ContinueStatement, ThrowStatement, TryStatement, CatchClause, TypeAliasStatement, ExportTypeAliasStatement,
    ImportStatement, ImportSpecifier, ExportStatement, ExportDefaultStatement, DeclareStatement,
    DeclareClassStatement, DeclareMetatableStatement, ExportNamedStatement, ExportSpecifier, ExportAllStatement,
    FunctionName, TypedIdentifier, GenericTypeParameter, FunctionSignature, TypePredicateNode,
    MappedTypeNode, ErrorStatement,
    BindingTarget, IdentifierPattern, ObjectPattern, ObjectPatternProperty,
    ArrayPattern, ArrayPatternElement, SpreadElement,
    Identifier, NilLiteral, BooleanLiteral, NumberLiteral, StringLiteral,
    InterpolatedStringExpression, InterpolatedStringPart,
    FunctionExpression, FunctionBody, FunctionParameter,
    TableExpression, TableField, ArrayExpression,
    BinaryExpression, UnaryExpression, MemberExpression, IndexExpression,
    CallExpression, MethodCallExpression, ParenthesizedExpression, ImportExpression,
    ClassDeclaration, ClassExpression, ClassMember, ClassAccessibility, SuperExpression,
    TypeAssertionExpression, AsConstExpression, IfElseExpression, ErrorExpression,
    TypeReference, TypeLiteralString, TypeLiteralBoolean, TypeLiteralNumber, TableTypeNode,
    ArrayTypeNode, TupleTypeNode, RestTypeNode,
    TableTypeProperty, FunctionTypeNode, FunctionTypeParameter,
    UnionTypeNode, IntersectionTypeNode, SatisfiesExpression,
    ParenthesizedTypeNode, TypeofTypeNode,
} from "@ast/nodes"

/** What bare `...` is instead. */
const NO_DOTS = "tilua has no bare '...': take a rest parameter, '...args: T[]', or 'scriptArgs' for the script's own"

/** `obj.` with nothing after it on the line. */
const NO_MEMBER_NAME = "Expected a name after '.'"

/** What `typeof(v)` is instead. */
const NO_TYPEOF_CALL = "'typeof' is an operator, not a function: write 'typeof v'"

/** tilua counts the way JavaScript does: `xs.length`, `text.length`. */
const NO_LENGTH_OPERATOR = "tilua has no '#': write 'xs.length' for how many a list holds or a string's length"

/** Words that can open a class member before what it is. */
const ACCESSIBILITIES: ReadonlySet<string> = new Set(["public", "private", "protected"])
const CLASS_MODIFIERS: ReadonlySet<string> = new Set([...ACCESSIBILITIES, "static", "abstract", "override", "readonly"])

/** Give a class method its receiver: a real first parameter named `this`,
 *  the way `function T:m()` gets a real `self`. It carries no annotation —
 *  the analyzer knows the class it belongs to, which is the only thing that
 *  works for a generic class (`Box<T>`) and for one written as a value. Every
 *  later pass then sees an ordinary parameter; it is marked `implicit`, as
 *  nothing in the source names it. */
function bindThis(func: FunctionBody, at: Span): void {
    bindThisParam(func.params, at)
    func.isMethod = true
}

function bindThisParam(params: FunctionParameter[], at: Span): void {
    params.unshift({ type: "FunctionParameter", name: "this", implicit: true, ...spanFrom(at, at) })
}

export class ParseError extends Error {
    constructor(message: string, public line: number, public column: number) {
        super(`${message} (${line}:${column})`)
    }
}

/** Thrown by `error()` in recovery mode and caught at the nearest statement
 *  boundary. Internal — never escapes the parser. */
class ParseRecover extends Error {}

/** Statements that bind a name, and so cannot be a braceless body: the name
 *  would be gone at the next line. TypeScript rejects the same set. */
/** Statements TypeScript has and tilua does not, and what to write instead. */
const UNSUPPORTED_STATEMENTS: Readonly<Record<string, string>> = {
    enum: "tilua has no 'enum': write a union of literals, 'type Color = \"Red\" | \"Green\"', or an object 'as const'",
    namespace: "tilua has no 'namespace': a module is a file, 'import * as N from \"./n\"'",
    switch: "tilua has no 'switch': write an 'if' / 'elseif' chain — one that leaves no value for an 'else' is exhaustive",
}

/** What a label may be written before: a loop, which `break` and `continue`
 *  can name. */
const LABELLED_LOOPS: ReadonlySet<string> = new Set(["for", "while", "repeat"])

const DECLARATION_STATEMENTS: ReadonlySet<string> = new Set([
    "VariableDeclaration", "FunctionDeclaration", "FunctionDeclarationStatement",
    "ClassDeclaration", "TypeAliasStatement", "ExportTypeAliasStatement",
    "ImportStatement", "ExportStatement", "ExportDefaultStatement",
    "ExportNamedStatement", "ExportAllStatement",
    "DeclareStatement", "DeclareClassStatement", "DeclareMetatableStatement",
])

// ------------------------------------------------------------
// Span helpers
// ------------------------------------------------------------

interface Span {
    line: { start: number; end: number }
    column: { start: number; end: number }
}

function spanFrom(start: Span, end: Span): Span {
    return {
        line: { start: start.line.start, end: end.line.end },
        column: { start: start.column.start, end: end.column.end },
    }
}

/** Move a tree parsed from a fragment to where that fragment sits in the file:
 *  `${a}` inside a template is parsed on its own, from 1:1. */
function shiftSpans<T>(node: T, line: number, column: number): T {
    const visit = (value: unknown): void => {
        if (!value || typeof value !== "object") return
        if (Array.isArray(value)) {
            for (const item of value) visit(item)
            return
        }
        const span = value as { line?: { start: number; end: number }; column?: { start: number; end: number } }
        if (span.line && span.column) {
            // Only the fragment's first line starts where the `${` does.
            if (span.column.start !== undefined && span.line.start === 1) span.column.start += column - 1
            if (span.column.end !== undefined && span.line.end === 1) span.column.end += column - 1
            span.line.start += line - 1
            span.line.end += line - 1
        }
        for (const child of Object.values(value)) visit(child)
    }
    visit(node)
    return node
}

/** An Identifier node for a name token. */
function tokenIdentifier(t: Span & { value?: unknown }): Identifier {
    return { type: "Identifier", name: t.value as string, ...spanFrom(t, t) }
}

/** An Identifier for a name that starts the node at `at` — for nodes built
 *  after the name token is gone, which still know where they begin. */
function nameIdentifier(name: string, at: Span): Identifier {
    return {
        type: "Identifier", name,
        line: { start: at.line.start, end: at.line.start },
        column: { start: at.column.start, end: at.column.start + name.length },
    }
}

// ------------------------------------------------------------
// Operator precedence
// ------------------------------------------------------------

export const BINARY_PRECEDENCE: Record<string, number> = {
    // `??` sits with `or`, and the two do not mix without parentheses — as
    // in TypeScript, where `a ?? b || c` is an error.
    "??": 1,
    "or": 1,
    "and": 2,
    "<": 3, ">": 3, "<=": 3, ">=": 3, "~=": 3, "==": 3,
    "in": 3, "instanceof": 3,
    "+": 5, "-": 5,
    "*": 6, "/": 6, "//": 6, "%": 6,
    "^": 8,
}
export const RIGHT_ASSOCIATIVE = new Set(["^"])

/** Is `side`, an operand of `op`, a `??` beside `and`/`or` (or the other way
 *  round) that no parentheses separate? */
function mixesNullish(side: Expression, op: string): boolean {
    if (side.type !== "BinaryExpression") return false
    const logical = (o: string): boolean => o === "and" || o === "or"
    return (op === "??" && logical(side.operator)) || (logical(op) && side.operator === "??")
}
export const UNARY_PRECEDENCE = 7

export const COMPOUND_ASSIGN_OPS = new Set(["+=", "-=", "*=", "/=", "//=", "%=", "^=", "??="])

// ============================================================
// Parser
// ============================================================

export interface ParserOptions {
    /** When true, `parseProgram` records syntax errors in `.errors` and
     *  synchronizes to the next statement boundary instead of throwing on the
     *  first one. The returned AST has an `ErrorStatement` wherever a statement
     *  could not be parsed. */
    recover?: boolean
    /** Recovery only: read where a block ends from indentation when an `end`
     *  is missing — a line indented no deeper than the line that opened the
     *  block is past it. Valid code never needs this; `parseWithRecovery`
     *  reparses with it when the first pass found an `end` missing. */
    indentation?: boolean
}

/** Keywords that start a statement or end a block: no expression contains one
 *  outside a function, so skipping a broken expression stops there. */
const STATEMENT_KEYWORDS = new Set([
    "const", "let", "while", "for", "return", "do", "repeat", "break", "continue",
    "import", "export", "end", "else", "elseif", "until", "then",
])

/** What a recovery skip is inside of. A `}` closing a block — a body of
 *  statements — is told from one closing a table, because statement keywords
 *  are at home in the first and mean a missing closer in the second.
 *  `functions` holds the depth of each function whose body is still ahead. */
interface Nesting {
    closers: { value: string; block: boolean }[]
    functions: number[]
}

export class Parser {
    private tokens: Token[]
    private cursor = 0
    private recover: boolean
    private indentation: boolean
    /** Populated in recovery mode. */
    readonly errors: ParseError[] = []
    /** Recovery found a block without its `}`. */
    missingEnd = false
    /** The column of the first token on each line, for `indentation`. */
    private lineIndent?: Map<number, number>
    /** Inside a class body, where `super` means the base class. Outside
     *  one it is an ordinary name, so existing code using it still reads. */
    private classDepth = 0
    /** Set while reading a ternary's consequent, to ration the `:`s that may
     *  be read as method calls at the `?`'s own bracket depth — one of them is
     *  the ternary's own. `allowance` is how many to allow (-1 for all),
     *  `used` counts how many were offered. Null inside brackets, where a `:`
     *  can only be a method call's. See `parseTernaryConsequent`. */
    private ternaryColons: { allowance: number; used: number } | null = null
    /** Recovery: the first token of the statement being read. */
    private statementStart?: Token

    constructor(tokens: Token[], options: ParserOptions = {}) {
        this.tokens = tokens
        this.recover = options.recover ?? false
        this.indentation = this.recover && (options.indentation ?? false)
    }

    private current(): Token {
        return this.tokens[this.cursor]
    }

    private peek(offset: number): Token {
        return this.tokens[Math.min(this.cursor + offset, this.tokens.length - 1)]
    }

    private previous(): Token {
        return this.tokens[this.cursor - 1]
    }

    private isAtEnd(): boolean {
        return this.current().type === "EOF"
    }

    private advance(): Token {
        const t = this.current()
        if (t.type !== "EOF") this.cursor++
        return t
    }

    private checkType(type: Token["type"]): boolean {
        return this.current().type === type
    }

    private checkKeyword(value: string): boolean {
        const t = this.current()
        return t.type === "Keyword" && (t as any).value === value
    }

    private checkOperator(value: string): boolean {
        const t = this.current()
        return t.type === "Operator" && (t as any).value === value
    }

    private checkPunctuator(value: string): boolean {
        const t = this.current()
        return t.type === "Punctuator" && (t as any).value === value
    }

    /** Match a word by spelling whether the lexer classified it as an
     *  identifier or a hard keyword (`as` is a keyword because of `as const`,
     *  but it is also the mapped-type key-remapping word). */
    private checkWord(value: string): boolean {
        const t = this.current()
        return (t.type === "Identifier" || t.type === "Keyword") &&
            (t as { value?: unknown }).value === value
    }

    private checkPunctuatorAt(offset: number, value: string): boolean {
        const t = this.peek(offset)
        return t.type === "Punctuator" && (t as { value?: unknown }).value === value
    }

    private checkIdentifierValue(value: string): boolean {
        const t = this.current()
        return t.type === "Identifier" && (t as any).value === value
    }

    private matchKeyword(value: string): boolean {
        if (this.checkKeyword(value)) { this.advance(); return true }
        return false
    }

    private matchOperator(value: string): boolean {
        if (this.checkOperator(value)) { this.advance(); return true }
        return false
    }

    private matchPunctuator(value: string): boolean {
        if (this.checkPunctuator(value)) { this.advance(); return true }
        return false
    }

    private expectKeyword(value: string): Token {
        if (!this.checkKeyword(value)) this.error(`Expected keyword '${value}'`)
        return this.advance()
    }

    private expectOperator(value: string): Token {
        if (!this.checkOperator(value)) this.error(`Expected '${value}'`)
        return this.advance()
    }

    private expectPunctuator(value: string): Token {
        if (!this.checkPunctuator(value)) this.error(`Expected '${value}'`)
        return this.advance()
    }

    private expectIdentifier(): Token & { value: string } {
        if (!this.checkType("Identifier")) this.error(`Expected identifier`)
        return this.advance() as Token & { value: string }
    }

    private error(message: string): never {
        const t = this.current()
        const err = new ParseError(`${message}, got '${this.describeToken(t)}'`, t.line.start, t.column.start)
        if (this.recover) {
            this.record(err)
            throw new ParseRecover(err.message)
        }
        throw err
    }

    // ============================================================
    // Recovery
    // ============================================================
    //
    // In recovery mode a syntax error costs as little of the tree as it can.
    // A broken expression becomes an `ErrorExpression` where it stood; a broken
    // field, element or argument is skipped up to the next `,`; a missing `)`,
    // `}`, `then`, `do` or `end` is recorded and parsing goes on as if it were
    // there. Only what none of these cover abandons a whole statement.

    /** An error at the position of the one before it is the same problem seen
     *  again, and is not recorded twice. */
    private record(error: ParseError): void {
        const last = this.errors[this.errors.length - 1]
        if (last && last.line === error.line && last.column === error.column) return
        this.errors.push(error)
    }

    /** Record an error without abandoning what is being parsed. */
    private softError(message: string): void {
        const t = this.current()
        this.record(new ParseError(`${message}, got '${this.describeToken(t)}'`, t.line.start, t.column.start))
    }

    /** `parse()`; in recovery mode, when it fails, skip to where parsing can go
     *  on and return `fallback` instead. */
    private attempt<T>(parse: () => T, stop: () => boolean, fallback: (start: Token, from: number) => T, what?: string): T {
        if (!this.recover) return parse()
        const from = this.cursor
        const start = this.current()
        const errors = this.errors.length
        try {
            return parse()
        } catch (e) {
            if (e instanceof ParseError) this.record(e)
            else if (!(e instanceof ParseRecover)) throw e
            // What failed began a line of its own, no deeper than the one
            // before: that line ended without what it needed, and this one
            // is what it begins, not the rest of it.
            if (what && this.beginsOwnLine(from)) {
                this.cursor = from
                this.errors.length = errors
                this.missingAtLineEnd(what)
                return fallback(start, from)
            }
            this.skip(stop, from, "expression")
            return fallback(start, from)
        }
    }

    /** Is the token at `index` the first on its line, indented no deeper than
     *  the statement it is in began? Then it is not the rest of that
     *  statement but the next one. */
    private beginsOwnLine(index: number): boolean {
        const t = this.tokens[index]
        const before = this.tokens[index - 1]
        if (!before || !this.statementStart || t.type === "EOF" || t.line.start <= before.line.end) return false
        return t.column.start <= this.indentOf(this.statementStart)
    }

    /** `what` is missing at the end of the line before the current token. */
    private missingAtLineEnd(what: string): void {
        const before = this.previous()
        this.record(new ParseError(`Expected ${what} before the end of the line`, before.line.end, before.column.end))
    }

    /** Recovery: the statement stops where its line does, without `what`:
     *  the line below is the next one. */
    private unfinishedLine(what: string): never {
        this.missingAtLineEnd(what)
        throw new ParseRecover(what)
    }

    /** Recovery: is `what` missing where the line ends, the next line — no
     *  deeper than the statement began — beginning another statement? In
     *  indentation mode, the line being no deeper is enough. */
    private valueMissing(what: string): boolean {
        if (!this.recover || !this.beginsOwnLine(this.cursor)) return false
        if (!this.indentation && !beginsStatement(this.tokens, this.cursor)) return false
        this.missingAtLineEnd(what)
        return true
    }

    /** An expression, or an `ErrorExpression` over what could not be parsed. */
    private expressionOr(stop: () => boolean): Expression {
        if (this.valueMissing("a value")) return this.errorExpression(this.current(), this.cursor)
        return this.attempt(() => this.parseExpression(), stop, (start, from) => this.errorExpression(start, from), "a value")
    }

    /** A comma-separated list of values where one belongs — a `return`'s, a
     *  declaration's, an assignment's — read whole, so that writing several
     *  is reported once and the rest still means something. A spread belongs
     *  in a call's arguments or an array, and is reported here too. */
    private expressionListOr(stop: () => boolean): Expression[] {
        const until = (): boolean => stop() || this.checkPunctuator(",")
        const item = (): Expression => {
            if (!(this.checkOperator("...") && this.startsSpread())) return this.expressionOr(until)
            this.problem("A spread goes in a call's arguments or an array: take values out of an array with a destructuring, 'const [a, b] = xs'")
            return this.parseSpreadArgument(until)
        }
        const list = [item()]
        while (this.matchPunctuator(",")) list.push(item())
        return list
    }

    /** A type annotation, or none when it could not be parsed. */
    private typeOr(stop: () => boolean): TypeNode | undefined {
        if (this.valueMissing("a type")) return undefined
        return this.attempt<TypeNode | undefined>(() => this.parseType(), stop, () => undefined, "a type")
    }

    private errorExpression(start: Token, from: number): ErrorExpression {
        if (this.cursor > from) return { type: "ErrorExpression", ...spanFrom(start, this.previous()) }
        return {
            type: "ErrorExpression",
            line: { start: start.line.start, end: start.line.start },
            column: { start: start.column.start, end: start.column.start },
        }
    }

    /** A closing bracket; in recovery mode a missing one is recorded and the
     *  construct ends where it is. */
    private expectCloser(value: string): void {
        if (this.matchPunctuator(value)) return
        if (!this.recover) this.error(`Expected '${value}'`)
        this.softError(`Expected '${value}'`)
    }

    /** `then` / `do` / `in`; in recovery mode a missing one is recorded and
     *  what follows is read as if it were there. */
    private expectKeywordSoft(value: string): void {
        if (this.matchKeyword(value)) return
        if (!this.recover) this.error(`Expected keyword '${value}'`)
        this.softError(`Expected keyword '${value}'`)
    }

    /** The `end` of the block `opener` began. */
    private expectEnd(opener: Token): void {
        if (this.checkKeyword("end") && !this.endBelongsOutside(opener)) {
            this.advance()
            return
        }
        if (!this.recover) this.error("Expected keyword 'end'")
        this.softError(`Expected 'end' to close '${this.describeToken(opener)}' on line ${opener.line.start}`)
        this.missingEnd = true
    }

    /** Indentation mode: an `end` indented less than the line that opened the
     *  block closes something outside it. */
    private endBelongsOutside(opener: Token): boolean {
        if (!this.indentation) return false
        const t = this.current()
        return t.line.start > opener.line.start && t.column.start < this.indentOf(opener)
    }

    /** Indentation mode: a statement indented no deeper than the line that
     *  opened the block is past the block. */
    private dedentedPast(opener: Token | undefined): boolean {
        if (!this.indentation || !opener) return false
        const t = this.current()
        return t.line.start > opener.line.start && t.column.start <= this.indentOf(opener)
    }

    private indentOf(token: Token): number {
        if (!this.lineIndent) {
            this.lineIndent = new Map()
            for (const t of this.tokens) {
                if (!this.lineIndent.has(t.line.start)) this.lineIndent.set(t.line.start, t.column.start)
            }
        }
        return this.lineIndent.get(token.line.start) ?? token.column.start
    }

    /** Is the current token on a later line than the one before it? */
    private onNewLine(): boolean {
        const previous = this.previous()
        return previous !== undefined && this.current().line.start > previous.line.end
    }

    /** Recovery: move past what could not be parsed.
     *
     *  Skipping stops at a token `stop` accepts, at a bracket closing something
     *  opened before the skip, at a keyword that starts a statement, and — for
     *  a statement — at the first token of a later line. The tokens from `from`
     *  on, including those the failed attempt already consumed, count towards
     *  nesting, so a bracket or a function body is skipped whole and a `}`
     *  inside it cannot end what encloses it. A statement keyword inside
     *  brackets but outside any block means a bracket was never closed, and it
     *  stops the skip as well. */
    private skip(stop: () => boolean, from: number, mode: "expression" | "statement"): void {
        const nesting: Nesting = { closers: [], functions: [] }
        for (let i = from; i < this.cursor; i++) this.nest(i, nesting, mode === "statement" && i === from)
        while (!this.isAtEnd()) {
            if (this.stopsSkip(nesting, stop, mode, from)) return
            const t = this.advance()
            this.nest(this.cursor - 1, nesting, false)
            if (mode === "statement" && nesting.closers.length === 0 && t.type === "Punctuator" && t.value === ";") return
        }
    }

    private nest(index: number, nesting: Nesting, statementStart: boolean): void {
        const t = this.tokens[index]
        const value = (t as { value?: unknown }).value
        const { closers, functions } = nesting
        const popTo = (closer: string): void => {
            for (let at = closers.length - 1; at >= 0; at--) {
                if (closers[at].value !== closer) continue
                closers.length = at
                while (functions.length && functions[functions.length - 1] > at) functions.pop()
                return
            }
        }
        if (t.type === "Punctuator") {
            if (value === "(") closers.push({ value: ")", block: false })
            else if (value === "[") closers.push({ value: "]", block: false })
            else if (value === "{") {
                const block = this.opensBlock(index, nesting)
                if (block && functions[functions.length - 1] === closers.length) functions.pop()
                closers.push({ value: "}", block })
            } else if (value === ")" || value === "]" || value === "}") popTo(value)
            return
        }
        if (t.type !== "Keyword") return
        switch (value) {
            // Its body is the next block at its own depth.
            case "function": functions.push(closers.length); return
            // Outside a block, `if` is an if-expression, inside which `then`
            // and `else` stop nothing.
            case "if":
                if (!statementStart && !closers.some(c => c.block)) closers.push({ value: "else", block: false })
                return
            case "else":
                if (closers[closers.length - 1]?.value === "else") closers.pop()
                return
        }
    }

    /** Is the `{` at `index` a block — a body of statements — rather than a
     *  table or an object type? */
    private opensBlock(index: number, nesting: Nesting): boolean {
        const before = this.tokens[index - 1] as Token | undefined
        if (!before) return false
        const value = (before as { value?: unknown }).value
        if (before.type === "Punctuator" && (value === ")" || value === "=>")) return true
        if (before.type === "Keyword" && (value === "do" || value === "else" || value === "repeat")) return true
        // `function f(): T {` — after a function's head, the first `{` at its
        // depth that does not continue a type.
        if (nesting.functions[nesting.functions.length - 1] !== nesting.closers.length) return false
        return !(before.type === "Punctuator" && typeof value === "string" && [":", "|", "&", ",", "<", "(", "[", "=", "?"].includes(value))
    }

    private stopsSkip(nesting: Nesting, stop: () => boolean, mode: "expression" | "statement", from: number): boolean {
        const { closers } = nesting
        const t = this.current()
        const value = (t as { value?: unknown }).value
        if (!closers.some(c => c.block) && t.type === "Keyword" && typeof value === "string") {
            // A line that begins a statement inside brackets: the bracket
            // was never closed.
            if (this.onNewLine() &&
                ((value === "if" && this.braceFollowsGroup(1)) || (value === "function" && this.peek(1).type === "Identifier"))) return true
            const inIfExpression = closers.some(c => c.value === "else") && (value === "then" || value === "elseif" || value === "else")
            // `import(` is an expression, and stops nothing; nor does `as const`.
            const importExpression = value === "import" && this.punctuatorAt(1, "(")
            const asConst = value === "const" && this.cursor > 0 &&
                this.previous().type === "Keyword" && (this.previous() as { value?: unknown }).value === "as"
            if (STATEMENT_KEYWORDS.has(value) && !importExpression && !asConst && !inIfExpression &&
                !(mode === "statement" && value === "then")) return true
            if (mode === "statement" && closers.length === 0 &&
                (value === "if" || (value === "function" && this.peek(1).type === "Identifier"))) return true
        }
        if (closers.length) return false
        if (t.type === "Punctuator" && (value === ")" || value === "]" || value === "}")) return true
        if (mode === "statement" && t.type === "Punctuator" && value === "@") return true
        // What is broken ends with its line: a line indented no deeper than
        // the one it began on is read again, as what it begins.
        if (this.cursor > from && this.onNewLine() && t.column.start <= this.indentOf(this.tokens[from])) return true
        if (mode === "expression" && t.type === "Punctuator" && value === ";") return true
        return stop()
    }

    private describeToken(t: Token): string {
        if (t.type === "EOF") return "<eof>"
        if ("value" in t) return String((t as any).value)
        return t.type
    }

    // ============================================================
    // Entry point
    // ============================================================

    parseProgram(): Program {
        const start = this.current()
        const body = this.parseBlock()
        if (!this.isAtEnd()) {
            if (!this.recover) this.error("Expected end of file")
            // A stray `end` (or `else`, `until`) at the top: skip it and read on.
            while (!this.isAtEnd()) {
                this.softError("Expected end of file")
                this.advance()
                body.statements.push(...this.parseBlock().statements)
            }
            Object.assign(body, spanFrom(body, this.previous() ?? start))
        }
        return { type: "Program", body, ...spanFrom(start, this.previous() ?? start) }
    }

    // ============================================================
    // Block / Statement
    // ============================================================

    private isBlockEnd(): boolean {
        return this.isAtEnd() ||
            this.checkPunctuator("}") ||
            this.checkKeyword("end") ||
            this.checkKeyword("else") ||
            this.checkKeyword("elseif") ||
            this.checkKeyword("until")
    }

    // ============================================================
    // Bodies
    // ------------------------------------------------------------
    // tilua writes a block in braces — `if (ready) { ... }`, `function f() {
    // ... }`. The `end` spellings Lua uses are still read, so a file written
    // in them keeps working while it is being moved over.
    //
    // A condition is in parentheses because `f {}` is a call: without them
    // `if ready { ... }` would be a call of `ready` and then a block. With
    // them the form is decided by looking past the closing parenthesis, which
    // is why a parenthesized condition in the older spelling still reads.
    // ============================================================

    /** `{ ... }` — a block in braces. */
    private parseBraceBlock(): Block {
        const brace = this.advance() // '{'
        const body = this.parseBlock(brace)
        if (this.matchPunctuator("}")) return body
        if (!this.recover) this.error(`Expected '}' to close the block opened on line ${brace.line.start}`)
        this.softError(`Expected '}' to close the block opened on line ${brace.line.start}`)
        // Without its `}` the block runs on to the end of the file. Where the
        // file is indented, a second pass reads the indentation instead — see
        // `parseWithRecovery`.
        this.missingEnd = true
        return body
    }

    /** The `{ ... }` a construct's body is written in. Half-written — the
     *  `{` not typed yet — it is empty and says so, rather than throwing the
     *  whole construct away: what has been written is what an editor answers
     *  from.
     *
     *  `braceless` marks the constructs that may take one statement instead of
     *  a block, as TypeScript writes `if (done) return`. A function body is not
     *  one of them, and neither is `do`, which is a block and nothing else. */
    private parseBracedBody(what: string, braceless = false): Block {
        if (this.checkPunctuator("{")) return this.parseBraceBlock()
        if (braceless && !this.isBlockEnd() && !this.checkPunctuator(";")) {
            return this.parseBracelessBody(what)
        }
        const at = this.current()
        if (!this.recover) this.error(`Expected '{' to open the body of '${what}'`)
        this.softError(`Expected '{' to open the body of '${what}'`)
        return { type: "Block", statements: [], ...spanFrom(at, at) }
    }

    /** `if (done) return` — the one statement a body may be written as, with
     *  no braces around it. It is still a block: what it narrows, and what a
     *  `break` or `continue` in it leaves, end with it, exactly as the braced
     *  form does.
     *
     *  A declaration is not a statement a body may be, as in TypeScript: the
     *  name it binds would be out of scope on the next line, so writing one
     *  here is a mistake rather than a shorthand. */
    private parseBracelessBody(what: string): Block {
        const start = this.current()
        // A braceless body ends at its line. In particular, without this
        // boundary `if (done) return` would let `parseReturnStatement` take
        // an `if` on the following line as an if-expression return value.
        const statement = this.checkKeyword("return")
            ? this.parseReturnStatement(true)
            : this.parseStatement()
        this.matchPunctuator(";")
        if (DECLARATION_STATEMENTS.has(statement.type)) {
            const error = new ParseError(
                `A declaration cannot be the body of '${what}' on its own, since nothing `
                + `could reach the name it binds; write the body in braces`,
                start.line.start, start.column.start,
            )
            if (!this.recover) throw error
            this.record(error)
        }
        return { type: "Block", statements: [statement], ...spanFrom(start, this.previous()) }
    }

    /** Does a `{` follow the parenthesized group starting here? That is what
     *  tells `if (ready) { ... }` from `if (ready) then ... end`. */
    private braceFollowsGroup(from = 0): boolean {
        if (!this.punctuatorAt(from, "(")) return false
        const closers: Record<string, string> = { "(": ")", "[": "]", "{": "}" }
        const stack: string[] = []
        for (let i = from; ; i++) {
            const token = this.peek(i)
            if (token.type === "EOF") return false
            if (token.type === "Punctuator") {
                const value = String((token as { value?: unknown }).value)
                if (closers[value]) stack.push(closers[value])
                else if (value === stack[stack.length - 1]) {
                    stack.pop()
                    if (!stack.length) {
                        const next = this.peek(i + 1)
                        return next.type === "Punctuator" && (next as { value?: unknown }).value === "{"
                    }
                }
            }
        }
    }



    /** `opener` is the token that began the block (`if`, `function`, ...), for
     *  indentation recovery. */
    private parseBlock(opener?: Token): Block {
        const start = this.current()
        const statements: Statement[] = []
        while (!this.isBlockEnd()) {
            if (this.matchPunctuator(";")) continue
            if (this.dedentedPast(opener)) break
            if (this.recover) {
                const at = this.cursor
                const errStart = this.current()
                const enclosing = this.statementStart
                this.statementStart = errStart
                try {
                    // `function`, and the line ends: what is below it is the
                    // next statement, not the rest of this one.
                    if (this.unfinishedOnItsLine()) {
                        this.error(`Expected the rest of '${this.describeToken(errStart)}' before the end of the line`)
                    }
                    statements.push(this.parseStatement())
                } catch (e) {
                    if (e instanceof ParseRecover) {
                        // error already recorded by error()
                    } else if (e instanceof ParseError) {
                        this.record(e)
                    } else {
                        throw e
                    }
                    this.skip(() => false, at, "statement")
                    // Guarantee forward progress even if synchronize() couldn't.
                    if (this.cursor === at) {
                        if (this.isAtEnd()) break
                        this.advance()
                    }
                    statements.push({
                        type: "ErrorStatement",
                        ...spanFrom(errStart, this.previous() ?? errStart),
                    })
                } finally {
                    this.statementStart = enclosing
                }
                continue
            }
            // What follows a `return`, a `break` or a `continue` is read,
            // as JavaScript reads it: it never runs, an editor shows it so,
            // and the compiler leaves it out — Luau allows nothing there.
            statements.push(this.parseStatement())
        }
        const end = this.previous() ?? start
        return { type: "Block", statements, ...spanFrom(start, end) }
    }

    /** Recovery: is the current token a word that begins a statement but
     *  cannot be one alone, with the line ending right after it? */
    private unfinishedOnItsLine(): boolean {
        const t = this.current()
        const value = (t as { value?: unknown }).value
        const opens = t.type === "Keyword"
            ? ["const", "let", "function", "import", "export", "if", "while", "for", "repeat", "do"].includes(String(value))
            : t.type === "Identifier"
                ? ["class", "interface", "type", "declare", "abstract", "local", "enum"].includes(String(value))
                : t.type === "Punctuator" && value === "@"
        if (!opens) return false
        const next = this.peek(1)
        if (next.type === "EOF") return true
        return this.beginsOwnLine(this.cursor + 1)
    }

    /** The label a `break` or `continue` names, written on its line. */
    private jumpLabel(): Identifier | undefined {
        if (!this.checkType("Identifier") || this.current().line.start !== this.previous().line.end) return undefined
        return this.parseIdentifier()
    }

    private parseAttributes(): { attributes: string[]; start: Token } {
        const start = this.current()
        const attributes: string[] = []
        while (this.current().type === "Punctuator" && (this.current() as any).value === "@") {
            this.advance()
            attributes.push(this.expectIdentifier().value)
        }
        return { attributes, start }
    }

    private parseStatement(): Statement {
        const t = this.current()

        if (t.type === "Punctuator" && (t as any).value === "@") {
            const { attributes, start } = this.parseAttributes()
            const next = this.current()
            if (next.type === "Keyword" && (next as any).value === "function") {
                const stmt = this.parseFunctionStatement()
                stmt.attributes = attributes
                stmt.line.start = start.line.start
                stmt.column.start = start.column.start
                return stmt
            }
            throw new ParseError("Expected 'function' after an attribute", next.line.start, next.column.start)
        }

        if (t.type === "Keyword") {
            switch ((t as any).value) {
                case "const":
                case "let": return this.parseVariableDeclaration()
                case "if": return this.parseIfStatement()
                case "while": return this.parseWhileStatement()
                case "repeat": return this.parseRepeatStatement()
                case "do": return this.parseDoStatement()
                case "for": return this.parseForStatement()
                case "function": return this.parseFunctionStatement()
                case "return": return this.parseReturnStatement()
                // `import("./m")` is an expression; anything else after
                // `import` is the statement.
                case "import":
                    if (this.punctuatorAt(1, "(")) break
                    return this.parseImportStatement()
                case "export": return this.parseExportStatement()
                case "break": {
                    this.advance()
                    const label = this.jumpLabel()
                    return { type: "BreakStatement", label, ...spanFrom(t, this.previous()) } as BreakStatement
                }
                case "continue": {
                    this.advance()
                    const label = this.jumpLabel()
                    return { type: "ContinueStatement", label, ...spanFrom(t, this.previous()) } as ContinueStatement
                }
            }
        }

        // `outer: for (...)` — a name and a `:` before a loop. Not a method
        // call: one of those has a name after its `:`.
        if (t.type === "Identifier" && this.punctuatorAt(1, ":") && this.peek(2).type === "Keyword" &&
            LABELLED_LOOPS.has(String((this.peek(2) as { value?: unknown }).value))) {
            const label = this.parseIdentifier()
            this.advance() // ':'
            const loop = this.parseStatement() as WhileStatement | RepeatStatement | NumericForStatement | GenericForStatement
            loop.label = label
            return { ...loop, ...spanFrom(t, loop) }
        }

        // `++n`: tilua writes it after the name. Read as what it meant.
        if (t.type === "Operator" && (t as any).value === "++") {
            this.problemAt(t, "tilua writes an increment after its target: 'n++'")
            this.advance()
            const target = this.parsePrefixExpression()
            this.rejectOptionalTarget(target)
            const one: NumberLiteral = { type: "NumberLiteral", value: 1, raw: "1", ...spanFrom(t, t) }
            return {
                type: "CompoundAssignmentStatement", operator: "+=", target, value: one, postfix: "++",
                ...spanFrom(t, this.previous()),
            }
        }

        // Lua's `local`, out of habit: say what tilua writes, and read it as `let`.
        if (this.recover && t.type === "Identifier" && (t as any).value === "local" &&
            (this.peek(1).type === "Identifier" || this.checkPunctuatorAt(1, "{") || this.checkPunctuatorAt(1, "["))) {
            this.softError("tilua has no 'local'; declare with 'const' or 'let'")
            return this.parseVariableDeclaration("let")
        }

        if (t.type === "Identifier" && (t as any).value === "type" &&
            this.peek(1).type === "Identifier") {
            return this.parseTypeAliasStatement()
        }

        // `try`, `catch`, `finally` and `throw` are soft keywords, as `class`
        // is: a promise's `p:catch(f)` and `p:finally(f)` are still methods.
        // `try {` is the statement — a function named `try` is still called
        // `try(f)` — and so is `throw` with something to throw on its line.
        if (t.type === "Identifier" && (t as any).value === "try" && this.punctuatorAt(1, "{")) {
            return this.parseTryStatement()
        }
        if (t.type === "Identifier" && (t as any).value === "throw" && this.startsThrow()) {
            return this.parseThrowStatement()
        }

        if (this.startsInterface()) return this.parseInterfaceStatement()

        // Words TypeScript has and tilua does not. A name followed by `{` is
        // a call with a table argument — `enum Color { ... }` would quietly
        // mean `enum(Color { ... })` — so each says what to write instead.
        if (t.type === "Identifier" && UNSUPPORTED_STATEMENTS[(t as any).value] && this.startsUnsupported()) {
            this.problemAt(t, UNSUPPORTED_STATEMENTS[(t as any).value])
            this.skipUnsupported()
            return { type: "ErrorStatement", ...spanFrom(t, this.previous()) } as ErrorStatement
        }

        // `class` is a soft keyword: it only starts a declaration when a name
        // follows it, so `const class = 1` and `t.class` still read as names.
        if (this.startsClassDeclaration()) {
            return this.parseClassDeclaration()
        }

        if (t.type === "Identifier" && (t as any).value === "declare") {
            const p1 = this.peek(1)
            // `class` is a soft keyword: `declare class: T` still declares a
            // global named `class`.
            if (p1.type === "Identifier" && (p1 as any).value === "class" &&
                this.peek(2).type === "Identifier") {
                return this.parseDeclareClassStatement()
            }
            // TypeScript's ambient blocks. A module is a file in tilua, and a
            // definitions file's top level is already global.
            const ambient = p1.type === "Identifier" && (p1 as any).value === "module" && this.peek(2).type === "Literal"
                ? "tilua has no 'declare module': a module is a file — point an import at a .d.tilua file with 'paths'"
                : p1.type === "Identifier" && (p1 as any).value === "global" && this.punctuatorAt(2, "{")
                ? "tilua has no 'declare global': a 'declare' at the top level of a definitions file is already global"
                : undefined
            if (ambient) {
                this.problemAt(t, ambient)
                this.skipUnsupported()
                return { type: "ErrorStatement", ...spanFrom(t, this.previous()) } as ErrorStatement
            }
            // `metatable` too: `declare metatable: T` is a global of that name.
            if (p1.type === "Identifier" && (p1 as any).value === "metatable" && !this.punctuatorAt(2, ":")) {
                return this.parseDeclareMetatableStatement()
            }
            if (p1.type === "Identifier" ||
                (p1.type === "Keyword" && (p1 as any).value === "function")) {
                return this.parseDeclareStatement()
            }
        }

        return this.parseExpressionStatement()
    }

    // `declare NAME: T` / `declare function NAME<G>(params): R` — ambient
    // declarations for a `.d.tilua` definitions file. `declare type X = ...`
    // is written as a plain `type X = ...` (aliases are ambient already).
    private parseDeclareStatement(): DeclareStatement {
        const start = this.current()
        this.advance() // 'declare'

        if (this.matchKeyword("function")) {
            const nameTok = this.expectIdentifier()
            const head = this.parseFunctionHead()
            // Each parameter keeps its own span (and its name's), so tools can
            // point at `name` in `declare function f(name: string)` rather than
            // at the whole statement.
            const params: FunctionTypeParameter[] = head.params.map(p => ({
                type: "FunctionTypeParameter",
                name: p.name || undefined,
                id: p.name ? nameIdentifier(p.name, p) : undefined,
                optional: p.optional,
                rest: p.rest,
                typeAnnotation: p.typeAnnotation ?? { type: "TypeReference", base: "any", typeArguments: [], line: p.line, column: p.column },
                line: p.line,
                column: p.column,
            }))
            const valueType: FunctionTypeNode = {
                type: "FunctionTypeNode",
                generics: head.generics,
                params,
                returnType: head.returnType ??
                    { type: "TypeReference", base: head.predicate ? "boolean" : "unknown", typeArguments: [], ...spanFrom(start, start) },
                predicate: head.predicate,
                ...spanFrom(start, this.previous()),
            }
            return { type: "DeclareStatement", name: nameTok.value as string, id: tokenIdentifier(nameTok), valueType, ...spanFrom(start, this.previous()) }
        }

        const nameTok = this.expectIdentifier()
        this.expectPunctuator(":")
        const valueType = this.parseType()
        return { type: "DeclareStatement", name: nameTok.value as string, id: tokenIdentifier(nameTok), valueType, ...spanFrom(start, this.previous()) }
    }

    /** A declared type's name. It may be qualified once — `Enum.Material` —
     *  which is how a definitions file names types under a namespace, and how
     *  they are then written (`const m: Enum.Material`). */
    private parseTypeName(): Identifier {
        const first = this.expectIdentifier()
        if (this.checkPunctuator(".") && this.peek(1).type === "Identifier") {
            this.advance()
            const second = this.expectIdentifier()
            return { type: "Identifier", name: `${first.value}.${second.value}`, ...spanFrom(first, second) }
        }
        return tokenIdentifier(first)
    }

    // `declare metatable<T> T[]: { __index: { ... } }`
    private parseDeclareMetatableStatement(): DeclareMetatableStatement {
        const start = this.current()
        this.advance() // 'declare'
        this.advance() // 'metatable'
        const generics = this.checkOperator("<") ? this.parseGenericTypeParameterList() : []
        const target = this.parseType()
        this.expectPunctuator(":")
        const metatable = this.parseType()
        return { type: "DeclareMetatableStatement", generics, target, metatable, ...spanFrom(start, this.previous()) }
    }

    // `declare class Name extends Base { member: T, ... }`
    private parseDeclareClassStatement(): DeclareClassStatement {
        const start = this.current()
        this.advance() // 'declare'
        this.advance() // 'class'
        const name = this.parseTypeName()
        let superclass: TypeReference | undefined
        if (this.checkIdentifierValue("extends")) {
            this.advance()
            const base = this.parseType()
            if (base.type !== "TypeReference") this.error("A class can only extend another class, written by name")
            superclass = base as TypeReference
        }
        if (!this.checkPunctuator("{")) this.error("Expected '{' to start the class body")
        const body = this.parseTableType()
        if (body.type !== "TableTypeNode") this.error("A class body lists members ('name: T'), not a mapped type")
        return { type: "DeclareClassStatement", name, superclass, body: body as TableTypeNode, ...spanFrom(start, this.previous()) }
    }

    // `import { a, b as c } from '...'` / `import Default from '...'` /
    // `import Default, { a } from '...'`. Compiled away entirely by the
    // bundler — never survives into emitted Luau.
    private parseImportStatement(): ImportStatement {
        const start = this.current()
        this.advance() // consume 'import'

        // `import "./setup"`: the module runs, and nothing is named.
        if (this.current().type === "Literal" && (this.current() as any).kind === "string") {
            const sourceTok = this.advance()
            const source: StringLiteral = {
                type: "StringLiteral",
                value: (sourceTok as any).value,
                raw: (sourceTok as any).raw,
                ...spanFrom(sourceTok, sourceTok),
            }
            return { type: "ImportStatement", specifiers: [], source, ...spanFrom(start, this.previous()) }
        }

        // `import type { A } from` / `import type D from` / `import type * as M from`.
        // `import type from "./m"` is still a default import named `type`.
        const next = this.peek(1)
        const isTypeOnly = this.checkIdentifierValue("type") && (
            (next.type === "Punctuator" && (next as any).value === "{") ||
            (next.type === "Operator" && (next as any).value === "*") ||
            next.type === "Identifier")
        if (isTypeOnly) this.advance()

        let defaultImport: Identifier | undefined
        const specifiers: ImportSpecifier[] = []

        let namespaceImport: Identifier | undefined
        // `{ a, b as c }` or `* as Module`, after an optional default import.
        const parseBindings = (): void => {
            if (this.checkOperator("*")) {
                this.advance()
                if (!this.checkKeyword("as")) this.error("Expected 'as' after 'import *'")
                this.advance()
                namespaceImport = this.parseIdentifier()
                return
            }
            this.expectPunctuator("{")
            this.parseImportSpecifierList(specifiers)
            this.expectPunctuator("}")
        }
        if (this.checkType("Identifier")) {
            const nameTok = this.expectIdentifier()
            defaultImport = { type: "Identifier", name: nameTok.value as string, ...spanFrom(nameTok, nameTok) }
            if (this.matchPunctuator(",")) parseBindings()
        } else {
            parseBindings()
        }

        if (!this.checkKeyword("from")) {
            this.error("Expected 'from' in import statement")
        }
        this.advance() // consume 'from'

        const sourceTok = this.current()
        if (sourceTok.type !== "Literal" || (sourceTok as any).kind !== "string") {
            this.error("Expected string literal module path after 'from'")
        }
        this.advance()
        const source: StringLiteral = {
            type: "StringLiteral",
            value: (sourceTok as any).value,
            raw: (sourceTok as any).raw,
            ...spanFrom(sourceTok, sourceTok),
        }

        return {
            type: "ImportStatement", defaultImport, namespaceImport, specifiers, source,
            isTypeOnly: isTypeOnly || undefined,
            ...spanFrom(start, this.previous()),
        }
    }

    private parseImportSpecifierList(out: ImportSpecifier[]): void {
        if (this.checkPunctuator("}")) return
        out.push(this.parseImportSpecifier())
        while (this.matchPunctuator(",")) {
            if (this.checkPunctuator("}")) break // trailing comma
            out.push(this.parseImportSpecifier())
        }
    }

    private parseImportSpecifier(): ImportSpecifier {
        const importedTok = this.expectIdentifier()
        const imported: Identifier = { type: "Identifier", name: importedTok.value as string, ...spanFrom(importedTok, importedTok) }
        let local = imported
        if (this.checkKeyword("as")) {
            this.advance()
            const localTok = this.expectIdentifier()
            local = { type: "Identifier", name: localTok.value as string, ...spanFrom(localTok, localTok) }
        }
        return { type: "ImportSpecifier", imported, local, ...spanFrom(imported, local) }
    }

    /** `from "<path>"`: consumes `from` and the module string. */
    private parseModuleSource(): StringLiteral {
        this.advance() // 'from'
        const sourceTok = this.current()
        if (sourceTok.type !== "Literal" || (sourceTok as any).kind !== "string") {
            this.error("Expected string literal module path after 'from'")
        }
        this.advance()
        return {
            type: "StringLiteral",
            value: (sourceTok as any).value,
            raw: (sourceTok as any).raw,
            ...spanFrom(sourceTok, sourceTok),
        }
    }

    // `export const ...` / `export let ...` / `export function ...` /
    // `export type ...` / `export default <expr>`
    private parseExportStatement():
        ExportStatement | ExportTypeAliasStatement | ExportDefaultStatement | ExportNamedStatement | ExportAllStatement {
        const start = this.current()
        this.advance() // consume 'export'

        if (this.checkIdentifierValue("default")) {
            this.advance()
            // `export default class Name ... end` declares `Name` here too,
            // as TypeScript's does; anonymous, it is an ordinary expression.
            const declaration = this.startsClassDeclaration()
                ? this.parseClassDeclaration()
                : this.parseExpression(0)
            return { type: "ExportDefaultStatement", declaration, ...spanFrom(start, this.previous()) }
        }

        if (this.checkIdentifierValue("type") && this.peek(1).type === "Identifier") {
            const alias = this.parseTypeAliasStatement()
            return { type: "ExportTypeAliasStatement", alias, ...spanFrom(start, this.previous()) }
        }

        if (this.startsInterface()) {
            const alias = this.parseInterfaceStatement()
            return { type: "ExportTypeAliasStatement", alias, ...spanFrom(start, this.previous()) }
        }

        // `export type { A, B }`, `export type { A } from "./m"`
        const typeOnly = this.checkIdentifierValue("type") && this.punctuatorAt(1, "{")
        if (typeOnly) this.advance()

        if (this.checkKeyword("const") || this.checkKeyword("let")) {
            const declaration = this.parseVariableDeclaration()
            return { type: "ExportStatement", declaration, ...spanFrom(start, this.previous()) }
        }

        if (this.startsClassDeclaration()) {
            const declaration = this.parseClassDeclaration()
            return { type: "ExportStatement", declaration, ...spanFrom(start, this.previous()) }
        }

        if (this.checkKeyword("function")) {
            const declaration = this.parseFunctionStatement(true)
            if (declaration.type !== "FunctionDeclaration") this.error("An exported function needs a plain name: 'export function name()'")
            return { type: "ExportStatement", declaration: declaration as FunctionDeclaration, ...spanFrom(start, this.previous()) }
        }

        // `export { a, b as c }` / `export { a } from "./x"`
        if (this.checkPunctuator("{")) {
            this.advance()
            const specifiers: ExportSpecifier[] = []
            while (!this.checkPunctuator("}")) {
                const local = this.parseIdentifier()
                let exported = local
                if (this.checkKeyword("as")) {
                    this.advance()
                    exported = this.parseIdentifier()
                }
                specifiers.push({ type: "ExportSpecifier", local, exported, ...spanFrom(local, exported) })
                if (!this.matchPunctuator(",")) break
            }
            this.expectPunctuator("}")
            const source = this.checkKeyword("from") ? this.parseModuleSource() : undefined
            return {
                type: "ExportNamedStatement", specifiers, source,
                ...(typeOnly ? { typeOnly: true } : {}),
                ...spanFrom(start, this.previous()),
            }
        }

        // `export * from "./x"`
        if (this.checkOperator("*")) {
            this.advance()
            if (!this.checkKeyword("from")) this.error("Expected 'from' after 'export *'")
            const source = this.parseModuleSource()
            return { type: "ExportAllStatement", source, ...spanFrom(start, this.previous()) }
        }

        this.error("Expected 'const', 'let', 'function', 'class', 'type', 'interface', 'default', '{' or '*' after 'export'")
    }

    // `const x = ...` / `let [a, b] = ...`.
    // tilua has no `local` — `const` bindings are immutable, `let` mutable.
    /** `kind` reads the leading word as that keyword (recovery's `local`). */
    private parseVariableDeclaration(as?: "let"): VariableDeclaration {
        const start = this.current()
        const word = (this.advance() as any).value as "const" | "let"
        const kind = as ?? word

        if (this.checkKeyword("function")) {
            this.error(`A function is declared as 'function name()'; '${kind}' does not apply to functions`)
        }

        const names = [this.parseBindingTarget(true)]
        while (this.matchPunctuator(",")) {
            names.push(this.parseBindingTarget(true))
        }

        let values: Expression[] = []
        if (this.matchOperator("=")) {
            values = this.expressionListOr(() => false)
        } else if (kind === "const") {
            // Keep the name declared: everything after it refers to it.
            if (!this.recover) this.error("'const' declaration requires an initializer")
            this.softError("'const' declaration requires an initializer")
        }

        // Luau's `local a, b = x, y`. tilua declares one name and one value;
        // several are an array, taken apart with a destructuring — which is
        // what the rest of the file is read as once this is reported.
        let name = names[0]
        let init: Expression | undefined = values[0]
        if (names.length > 1 || values.length > 1) {
            this.problemAt(start, `A declaration takes one value: take several from an array, '${kind} [a, b] = [x, y]'`)
            if (names.length > 1) name = this.namesAsPattern(names)
            if (values.length > 1) init = this.valuesAsArray(values)
        }

        return { type: "VariableDeclaration", kind, name, init, ...spanFrom(start, this.previous()) }
    }

    /** `a, b` written where one name goes, read as `[a, b]`. */
    private namesAsPattern(names: BindingTarget[]): ArrayPattern {
        const elements = names.map((value): ArrayPatternElement => ({
            type: "ArrayPatternElement", value, ...spanFrom(value, value),
        }))
        return { type: "ArrayPattern", elements, ...spanFrom(names[0], names[names.length - 1]) }
    }

    /** `x, y` written where one value goes, read as `[x, y]`. */
    private valuesAsArray(values: Expression[]): ArrayExpression {
        return { type: "ArrayExpression", elements: values, ...spanFrom(values[0], values[values.length - 1]) }
    }

    /** Does `throw` begin a statement here: is something to throw written
     *  after it on its line? Not `throw = f`, `throw.x` or `throw:m()`. */
    private startsThrow(): boolean {
        const next = this.peek(1)
        if (next.type === "EOF" || next.line.start !== this.current().line.end) return false
        const value = (next as { value?: unknown }).value
        switch (next.type) {
            case "Literal": case "InterpolatedString": case "Identifier": return true
            case "Keyword": return ["function", "if", "not", "nil", "true", "false"].includes(String(value))
            case "Punctuator": return value === "(" || value === "{" || value === "["
            case "Operator": return value === "-" || value === "#"
            default: return false
        }
    }

    private parseThrowStatement(): ThrowStatement {
        const start = this.advance() // 'throw'
        const argument = this.expressionOr(() => false)
        return { type: "ThrowStatement", argument, ...spanFrom(start, this.previous()) }
    }

    /** `try { } catch (e) { } finally { }`. */
    private parseTryStatement(): TryStatement {
        const start = this.advance() // 'try'
        const block = this.parseBracedBody("try")
        let handler: CatchClause | undefined
        if (this.checkIdentifierValue("catch")) {
            const catchStart = this.advance()
            let param: IdentifierPattern | undefined
            // `catch { }`: what was thrown is not wanted.
            if (this.matchPunctuator("(")) {
                const name = this.expectIdentifier()
                param = { type: "IdentifierPattern", name: name.value, ...spanFrom(name, name) }
                if (this.matchPunctuator(":")) param.typeAnnotation = this.typeOr(() => this.checkPunctuator(")"))
                this.expectCloser(")")
            }
            const body = this.parseBracedBody("catch")
            handler = { type: "CatchClause", param, body, ...spanFrom(catchStart, this.previous()) }
        }
        let finalizer: Block | undefined
        if (this.checkIdentifierValue("finally")) {
            this.advance()
            finalizer = this.parseBracedBody("finally")
        }
        if (!handler && !finalizer) this.problem("A 'try' needs a 'catch' or a 'finally'")
        return { type: "TryStatement", block, handler, finalizer, ...spanFrom(start, this.previous()) }
    }

    private parseIfStatement(): IfStatement {
        const start = this.current()
        this.expectKeyword("if")
        return this.parseBracedIf(start)
    }

    private parseBracedIf(start: Token): IfStatement {
        const clauses: IfClause[] = []
        const clause = (): void => {
            const clauseStart = this.current()
            this.expectPunctuator("(")
            const condition = this.expressionOr(() => this.checkPunctuator(")"))
            this.expectCloser(")")
            const body = this.parseBracedBody("if", true)
            clauses.push({ type: "IfClause", condition, body, ...spanFrom(clauseStart, this.previous()) })
        }
        clause()
        let alternate: Block | undefined
        while (this.checkKeyword("elseif") || this.checkKeyword("else")) {
            const isElse = this.checkKeyword("else")
            this.advance()
            if (!isElse) {
                clause()
                continue
            }
            alternate = this.parseBracedBody("else", true)
            break
        }
        return { type: "IfStatement", clauses, alternate, ...spanFrom(start, this.previous()) }
    }

    private parseWhileStatement(): WhileStatement {
        const start = this.current()
        this.expectKeyword("while")
        this.expectPunctuator("(")
        const condition = this.expressionOr(() => this.checkPunctuator(")"))
        this.expectCloser(")")
        const body = this.parseBracedBody("while", true)
        return { type: "WhileStatement", condition, body, ...spanFrom(start, this.previous()) }
    }

    private parseRepeatStatement(): RepeatStatement {
        const start = this.current()
        this.expectKeyword("repeat")
        const body = this.parseBracedBody("repeat")
        this.expectKeyword("until")
        this.expectPunctuator("(")
        const condition = this.expressionOr(() => this.checkPunctuator(")"))
        this.expectCloser(")")
        return { type: "RepeatStatement", body, condition, ...spanFrom(start, this.previous()) }
    }

    private parseDoStatement(): DoStatement {
        const start = this.current()
        this.expectKeyword("do")
        const body = this.parseBracedBody("do")
        return { type: "DoStatement", body, ...spanFrom(start, this.previous()) }
    }

    private parseForStatement(): NumericForStatement | GenericForStatement {
        const start = this.current()
        this.expectKeyword("for")
        // `for (i = 1, 10) { ... }` — the header is in parentheses, and what
        // ends it is the `)`.
        this.expectPunctuator("(")

        // `for (const item of source)`: one value each time, named the way
        // any other value is — `let` when the body assigns to it.
        const declared = this.checkKeyword("const") || this.checkKeyword("let")
            ? ((this.advance() as { value: string }).value as "const" | "let")
            : undefined
        const first = this.parseBindingTarget(true)

        const untilDo = (): boolean => this.checkPunctuator(")")
        if (first.type === "IdentifierPattern" && this.matchOperator("=")) {
            // A counting loop names its own variable: `for (i = 1, 10)`.
            if (declared) this.problemAt(start, `A counting loop names its variable without '${declared}': 'for (i = 1, 10)'`)
            const from = this.expressionOr(() => untilDo() || this.checkPunctuator(","))
            this.expectPunctuator(",")
            const to = this.expressionOr(() => untilDo() || this.checkPunctuator(","))
            let step: Expression | undefined
            if (this.matchPunctuator(",")) {
                step = this.expressionOr(untilDo)
            }
            const body = this.parseForBody()
            return {
                type: "NumericForStatement",
                variable: this.identifierPatternToTypedIdentifier(first),
                start: from, end: to, step, body,
                ...spanFrom(start, this.previous()),
            }
        }

        // Luau's `for k, v in ...` takes several values each time; tilua's
        // loop takes one, and an array is taken apart like any other. That is
        // the whole of what is wrong with the line, so a missing `const` goes
        // unsaid here.
        if (this.checkPunctuator(",")) {
            this.problemAt(this.current(), "A loop takes one value each time: take its parts with a destructuring, 'for (const [k, v] of pairs(t))'")
            while (this.matchPunctuator(",")) this.parseBindingTarget(true)
        } else if (!declared) {
            this.problemAt(start, "A loop over a source names its value with 'const' or 'let': 'for (const item of source)'")
        }
        // `of` walks the values, `in` the keys, as in TypeScript. `of` is a
        // keyword only here: anywhere else it is a name like any other.
        let over: "values" | "keys" = "values"
        if (this.checkIdentifierValue("of")) this.advance()
        else {
            this.expectKeyword("in")
            over = "keys"
        }
        const iterator = this.expressionOr(() => untilDo() || this.checkPunctuator(","))
        // `in f, s, v` is Luau's pack of three; tilua's is one array.
        if (this.checkPunctuator(",")) {
            this.problemAt(this.current(), "A loop has one source: an array, a table, an iterator function or an iteration '[step, state, first]'")
            while (this.matchPunctuator(",")) this.expressionOr(() => untilDo() || this.checkPunctuator(","))
        }
        const body = this.parseForBody()
        return {
            type: "GenericForStatement",
            kind: declared ?? "const",
            over,
            variable: first, iterator, body,
            ...spanFrom(start, this.previous()),
        }
    }

    private parseForBody(): Block {
        this.expectCloser(")")
        return this.parseBracedBody("for", true)
    }

    /** `function name() end` declares `name`; `function a.b() end` and
     *  `function T:m() end` define a member. */
    /** `exported` — the `export` before this `function` has been consumed, so
     *  each overload signature after it must carry one as well. */
    private parseFunctionStatement(exported = false): FunctionDeclaration | FunctionDeclarationStatement {
        const start = this.current()
        this.expectKeyword("function")
        const target = this.parseFunctionName()
        const isMethod = target.method !== undefined
        // Overloads are only recognized for a plain `function name(...)` — not
        // `function a.b()` or `function T:m()`.
        const simpleName = !isMethod && target.path.length === 0 ? target.base.name : undefined

        const signatures: FunctionSignature[] = []
        // Each line of an overload set is written with the name again; every
        // one of them is a node, so each can be pointed at and coloured.
        let written = target.base
        while (true) {
            const head = this.parseFunctionHead()
            if (simpleName !== undefined && this.isOverloadContinuation(simpleName)) {
                signatures.push({ ...this.headToSignature(head), name: written })
                // As in TypeScript, every signature of an overload set agrees
                // about `export` — the set is one declaration.
                const nextExported = this.matchKeyword("export")
                if (nextExported !== exported) {
                    this.problem("Overload signatures must all be exported or non-exported")
                }
                this.expectKeyword("function")
                written = this.parseFunctionName().base
                continue
            }
            const func = this.headToBody(head, start)
            if (simpleName !== undefined) {
                return {
                    type: "FunctionDeclaration", name: target.base, func,
                    signatures: signatures.length ? signatures : undefined,
                    implementationName: signatures.length ? written : undefined,
                    ...spanFrom(start, this.previous()),
                }
            }
            if (isMethod) {
                // `function T:m(a)` is `function T.m(self, a)`. The `self`
                // parameter is made real here so every later pass — scopes,
                // types, arity — sees an ordinary first parameter.
                func.params.unshift({ type: "FunctionParameter", name: "self", implicit: true, ...spanFrom(target, target) })
                func.isMethod = true
            }
            return {
                type: "FunctionDeclarationStatement", target, isMethod, func,
                signatures: signatures.length ? signatures : undefined,
                ...spanFrom(start, this.previous()),
            }
        }
    }

    /** After a bodyless function head, is the next token the start of another
     *  declaration for the same simple `name` (making the head an overload
     *  signature rather than an implementation)? */
    private isOverloadContinuation(name: string): boolean {
        const named = (offset: number): boolean =>
            this.peek(offset).type === "Identifier" && (this.peek(offset) as { value?: unknown }).value === name
        if (this.checkKeyword("function")) return named(1)
        // `export function f(...)` repeated: an exported overload set.
        return this.checkKeyword("export") &&
            this.peek(1).type === "Keyword" && (this.peek(1) as { value?: unknown }).value === "function" &&
            named(2)
    }

    /** A mistake that does not stop the parse: refused outside recovery, where
     *  the compiler must not accept it, and recorded inside. The message says
     *  what is wrong on its own — no token is appended. */
    private problem(message: string): void {
        this.problemAt(this.current(), message)
    }

    /** `problem`, pointed at `t` rather than at where parsing has got to. */
    private problemAt(t: Token, message: string): void {
        const error = new ParseError(message, t.line.start, t.column.start)
        if (!this.recover) throw error
        this.record(error)
    }

    /** `class Name extends Base <members> end`.
     *
     *  The body is a block like every other in tilua, closed by `end` — not a
     *  brace-delimited list. Members are written the way the same thing is
     *  written outside a class: a field like a field (`x: number`), a method
     *  like a function (`function m() ... end`). */
    private parseClassDeclaration(): ClassDeclaration {
        const start = this.current()
        const isAbstract = this.checkIdentifierValue("abstract")
        if (isAbstract) this.advance()
        this.advance() // 'class'
        const name = this.parseIdentifier()
        const typeParams = this.checkOperator("<") ? this.parseGenericTypeParameterList() : []
        const { superclass, superArguments } = this.parseExtends()
        const shapes = this.parseImplements()
        const members = this.parseClassBody(start)
        return {
            type: "ClassDeclaration", name, typeParams, superclass, superArguments,
            ...(shapes ? { implements: shapes } : {}),
            ...(isAbstract ? { isAbstract } : {}),
            members,
            ...spanFrom(start, this.previous()),
        }
    }

    /** `class Name` or `abstract class Name` — all three words soft, so a name
     *  has to follow for either to be a declaration: `class: T`, `class = 1`
     *  and `abstract(x)` are names. */
    private startsClassDeclaration(): boolean {
        const offset = this.checkIdentifierValue("abstract") ? 1 : 0
        const word = this.peek(offset)
        if (word.type !== "Identifier" || (word as { value?: unknown }).value !== "class") return false
        return this.peek(offset + 1).type === "Identifier"
            && !this.punctuatorAt(offset + 2, ":") && !this.operatorAt(offset + 2, "=") && !this.punctuatorAt(offset + 2, "(")
    }

    /** `class ... end` as a value. It may be named — the name is for the class
     *  itself, not for the scope around it — and takes no type parameters,
     *  since nothing could write the arguments. */
    private parseClassExpression(): ClassExpression {
        const start = this.current()
        this.advance() // 'class'
        const name = this.checkType("Identifier") && !this.checkIdentifierValue("extends") &&
            !this.punctuatorAt(1, ":") && !this.operatorAt(1, "=") && !this.punctuatorAt(1, "(")
            ? this.parseIdentifier()
            : undefined
        if (this.checkOperator("<")) {
            this.error("A class written as a value takes no type parameters: nothing could write the arguments")
        }
        const { superclass, superArguments } = this.parseExtends()
        const shapes = this.parseImplements()
        const members = this.parseClassBody(start)
        return {
            type: "ClassExpression", name, superclass, superArguments,
            ...(shapes ? { implements: shapes } : {}),
            members, ...spanFrom(start, this.previous()),
        }
    }

    /** `implements Shape, Named` — each a type, checked against the instance. */
    private parseImplements(): TypeNode[] | undefined {
        if (!this.checkIdentifierValue("implements")) return undefined
        this.advance()
        const shapes = [this.parseType()]
        while (this.matchPunctuator(",")) shapes.push(this.parseType())
        return shapes
    }

    /** `extends Base` / `extends Box<number>`. */
    private parseExtends(): { superclass?: Identifier; superArguments?: TypeNode[] } {
        if (!this.checkIdentifierValue("extends")) return {}
        this.advance()
        if (this.recover && this.beginsOwnLine(this.cursor)) this.unfinishedLine("the class it extends")
        const superclass = this.parseIdentifier()
        let superArguments: TypeNode[] | undefined
        if (this.checkOperator("<")) {
            const written = this.tryTypeArguments()
            if (written) superArguments = written
        }
        return { superclass, superArguments }
    }

    private parseClassBody(start: Token): ClassMember[] {
        void start
        if (this.recover && !this.checkPunctuator("{") && this.beginsOwnLine(this.cursor)) this.unfinishedLine("'{'")
        if (!this.checkPunctuator("{")) this.error("Expected '{' to open the class body")
        const brace = this.advance()
        const members: ClassMember[] = []
        this.classDepth++
        try {
            while (!this.checkPunctuator("}") && !this.isAtEnd()) {
                // A stray `,` or `;` between members is allowed and means
                // nothing, as a `;` between statements does.
                if (this.matchPunctuator(",") || this.matchPunctuator(";")) continue
                if (this.dedentedPast(brace)) break
                if (!this.recover) {
                    const member = this.parseClassMember()
                    if (member) members.push(member)
                    continue
                }
                // A member that cannot be read costs that member, not the
                // class: the ones around it are still what the class has.
                const at = this.cursor
                const first = this.current()
                try {
                    const member = this.parseClassMember()
                    if (member) members.push(member)
                } catch (e) {
                    if (e instanceof ParseError) this.record(e)
                    else if (!(e instanceof ParseRecover)) throw e
                    this.skipClassMember(first, at)
                }
            }
        } finally {
            this.classDepth--
        }
        if (this.matchPunctuator("}")) return members
        if (!this.recover) this.error(`Expected '}' to close the class opened on line ${brace.line.start}`)
        this.softError(`Expected '}' to close the class opened on line ${brace.line.start}`)
        // As a block without its `}`: the indentation says where it ended.
        this.missingEnd = true
        return members
    }

    /** Recovery: move past a member that could not be read, to the next one
     *  or to the `}` that closes the class. Brackets opened on the way are
     *  skipped whole. A line indented no deeper than the member began is the
     *  next member whatever the brackets say — one left open is the usual
     *  reason a member could not be read. */
    private skipClassMember(first: Token, from: number): void {
        const closers: string[] = []
        const nest = (t: Token): void => {
            if (t.type !== "Punctuator") return
            const value = (t as { value?: unknown }).value
            if (value === "(") closers.push(")")
            else if (value === "[") closers.push("]")
            else if (value === "{") closers.push("}")
            else if (value === ")" || value === "]" || value === "}") {
                const open = closers.lastIndexOf(value)
                if (open >= 0) closers.length = open
            }
        }
        for (let i = from; i < this.cursor; i++) nest(this.tokens[i])
        while (!this.isAtEnd()) {
            const t = this.current()
            if (this.cursor > from && this.onNewLine() &&
                t.line.start > first.line.start && t.column.start <= first.column.start) return
            if (!closers.length && this.checkPunctuator("}")) return
            this.advance()
            nest(t)
            if (!closers.length && t.type === "Punctuator" && (t.value === ";" || t.value === ",")) return
        }
    }

    /** Recovery: is this the start of a line that opens the next member —
     *  `name(`, `name:`, `name =`, a modifier, `function`? It is where a
     *  field left half-written ends. */
    private atNextClassMember(): boolean {
        if (!this.recover || !this.onNewLine()) return false
        if (this.checkKeyword("function") || this.startsClassModifier()) return true
        return this.checkType("Identifier") &&
            (this.punctuatorAt(1, "(") || this.punctuatorAt(1, ":") || this.operatorAt(1, "="))
    }

    /** `<A, B>` in a type position that is not a call: the arguments a class
     *  extends its base with. */
    private tryTypeArguments(): TypeNode[] | undefined {
        const saved = this.cursor
        try {
            this.expectOperator("<")
            const args: TypeNode[] = [this.parseType()]
            while (this.matchPunctuator(",")) args.push(this.parseType())
            this.expectOperator(">")
            return args
        } catch (error) {
            if (error instanceof ParseError || error instanceof ParseRecover) {
                this.cursor = saved
                return undefined
            }
            throw error
        }
    }

    private parseClassMember(): ClassMember | undefined {
        const start = this.current()
        // Every modifier is a soft keyword: `private: boolean`, `readonly = 1`
        // and `static()` still name a member. A word is a modifier only when
        // the member goes on after it.
        let accessibility: ClassAccessibility | undefined
        const modifiers = new Set<string>()
        while (this.startsClassModifier()) {
            const token = this.advance()
            const word = (token as { value: string }).value
            if (ACCESSIBILITIES.has(word)) {
                if (accessibility) this.problemAt(token, `A member has one accessibility: '${accessibility}' is already written`)
                accessibility = word as ClassAccessibility
            } else {
                if (modifiers.has(word)) this.problemAt(token, `'${word}' is written twice`)
                modifiers.add(word)
            }
        }
        const member = this.parseClassMemberAfterModifiers(start, modifiers)
        if (!member) return member
        const misplaced = (message: string): void => this.problemAt(start, message)
        if (member.type === "ClassConstructor") {
            const written = [...(accessibility ? [accessibility] : []), ...modifiers]
            if (written.length) misplaced(`A constructor cannot be '${written[0]}'`)
            return member
        }
        if (modifiers.has("readonly") && member.type !== "ClassField") misplaced("Only a field can be 'readonly'")
        if (modifiers.has("abstract") && member.type !== "ClassMethod") misplaced("Only a method can be 'abstract'")
        if (modifiers.has("abstract") && member.isStatic) misplaced("A static method cannot be 'abstract'")
        if (modifiers.has("override") && member.isStatic) misplaced("A static member cannot be 'override'")
        return {
            ...member,
            ...(accessibility ? { accessibility } : {}),
            ...(modifiers.has("readonly") && member.type === "ClassField" ? { isReadonly: true } : {}),
            ...(modifiers.has("override") ? { isOverride: true } : {}),
        }
    }

    /** Is the word here a member modifier, rather than a member's name? */
    private startsClassModifier(): boolean {
        const t = this.current()
        if (t.type !== "Identifier" || !CLASS_MODIFIERS.has((t as { value: string }).value)) return false
        const next = this.peek(1)
        return next.type === "Identifier" || (next.type === "Keyword" && (next as { value?: unknown }).value === "function")
    }

    private parseClassMemberAfterModifiers(start: Token, modifiers: ReadonlySet<string>): ClassMember | undefined {
        const isStatic = modifiers.has("static")

        if (this.checkKeyword("function")) {
            this.advance()
            return this.parseClassMethod(start, modifiers)
        }

        // `constructor(...)` — a soft keyword too.
        if (!isStatic && this.checkIdentifierValue("constructor") && this.punctuatorAt(1, "(")) {
            this.advance()
            const head = this.parseFunctionHead()
            if (head.returnType) this.problem("A constructor has no return type; it always builds the instance")
            const func = this.headToBody(head, start)
            bindThis(func, start)
            return { type: "ClassConstructor", func, ...spanFrom(start, this.previous()) }
        }

        // TypeScript's method: `name() {}`, `name<T>() {}` — `function` left
        // out. After `constructor`, which has the same shape.
        if (this.startsMethodShorthand(0)) {
            return this.parseClassMethod(start, modifiers)
        }

        // `get name(): T ... end` / `set name(v: T) ... end`
        if ((this.checkIdentifierValue("get") || this.checkIdentifierValue("set")) &&
            this.peek(1).type === "Identifier" && this.punctuatorAt(2, "(")) {
            const kind = (this.advance() as { value: string }).value as "get" | "set"
            const memberName = this.parseIdentifier()
            const head = this.parseFunctionHead()
            const func = this.headToBody(head, start)
            if (!isStatic) bindThis(func, start)
            const written = func.params.length - (isStatic ? 0 : 1)
            if (kind === "get" && written > 0) {
                this.problem("A getter takes no parameters")
            }
            if (kind === "set" && written !== 1) {
                this.problem("A setter takes exactly one parameter: the value being assigned")
            }
            return { type: "ClassAccessor", kind, name: memberName, isStatic, func, ...spanFrom(start, this.previous()) }
        }

        // `name: T`, `name = v`, `name: T = v`
        if (this.checkType("Identifier")) {
            const memberName = this.parseIdentifier()
            // Half-written, a field is still a member of that name: what
            // follows the `:` or `=` is missing, and says so.
            const known = this.errors.length
            let typeAnnotation: TypeNode | undefined
            if (this.matchPunctuator(":")) {
                if (this.atNextClassMember() || (this.recover && this.checkPunctuator("}"))) this.softError("Expected a type")
                else typeAnnotation = this.typeOr(() => this.checkOperator("=") || this.atNextClassMember())
            }
            let init: Expression | undefined
            if (this.matchOperator("=")) {
                if (this.atNextClassMember()) {
                    this.softError("Expected a value")
                    init = this.errorExpression(this.current(), this.cursor)
                } else {
                    init = this.expressionOr(() => this.atNextClassMember())
                }
            }
            if (!typeAnnotation && !init && this.errors.length === known) {
                this.problemAt(memberName as unknown as Token, "A class field needs a type ('name: T') or a value ('name = v')")
            }
            return { type: "ClassField", name: memberName, isStatic, typeAnnotation, init, ...spanFrom(start, this.previous()) }
        }

        this.error("Expected a class member: a field, a method, 'constructor', 'get' or 'set'")
    }

    /** A name at `offset` opening a method without `function`: `name(` or
     *  `name<T>(`. A field's name is followed by `:` or `=` instead. */
    private startsMethodShorthand(offset: number): boolean {
        if (this.peek(offset).type !== "Identifier") return false
        const next = this.peek(offset + 1)
        return (next.type === "Punctuator" || next.type === "Operator") &&
            ((next as { value?: unknown }).value === "(" || (next as { value?: unknown }).value === "<")
    }

    /** A method, from its name on: `function` (if written) and the modifiers
     *  are behind. */
    private parseClassMethod(start: Token, modifiers: ReadonlySet<string>): ClassMember {
        const isStatic = modifiers.has("static")
        const memberName = this.parseIdentifier()
        // `abstract area(): number` — the head is all there is.
        if (modifiers.has("abstract")) {
            const head = this.parseFunctionHead()
            const func: FunctionBody = {
                type: "FunctionBody",
                generics: head.generics, params: head.params, hasVarargs: head.hasVarargs,
                returnType: head.returnType,
                predicate: head.predicate,
                body: { type: "Block", statements: [], ...spanFrom(head.start, this.previous()) } as Block,
                ...spanFrom(head.start, this.previous()),
            }
            if (!isStatic) bindThis(func, start)
            if (!head.returnType) this.problem("An abstract method has no body to infer from: write its return type")
            if (this.checkPunctuator("{")) this.problem("An abstract method has no body")
            return { type: "ClassMethod", name: memberName, isStatic, func, isAbstract: true, ...spanFrom(start, this.previous()) }
        }
        // Overloads inside a class are written as they are outside one:
        // bodyless heads for the same name, then the implementation.
        const signatures: FunctionSignature[] = []
        let written = memberName
        while (true) {
            const head = this.parseFunctionHead()
            const skip = this.classOverloadContinuation(memberName.name, isStatic)
            if (skip !== undefined) {
                if (!isStatic) bindThisParam(head.params, start)
                signatures.push({ ...this.headToSignature(head), name: written })
                for (let i = 0; i < skip; i++) this.advance()
                written = this.parseIdentifier()
                continue
            }
            const func = this.headToBody(head, start)
            if (!isStatic) bindThis(func, start)
            return {
                type: "ClassMethod", name: memberName, isStatic, func,
                signatures: signatures.length ? signatures : undefined,
                ...spanFrom(start, this.previous()),
            }
        }
    }

    /** After a bodyless head inside a class body, does another declaration of
     *  the same member follow? Then the head was an overload signature, and
     *  this is how many tokens stand before the next one's name: a `;` that
     *  ends the head, as TypeScript writes it, the modifiers, and `function`
     *  when it is written. `undefined` when no overload follows. Each head may
     *  be written either way, with `function` or without. */
    private classOverloadContinuation(name: string, isStatic: boolean): number | undefined {
        let offset = 0
        if (this.punctuatorAt(0, ";")) offset++
        let sawStatic = false
        while (true) {
            const t = this.peek(offset)
            const word = t.type === "Identifier" ? (t as { value: string }).value : undefined
            if (word === undefined || !CLASS_MODIFIERS.has(word) || this.startsMethodShorthand(offset)) break
            if (word === "static") sawStatic = true
            offset++
        }
        if (sawStatic !== isStatic) return undefined
        const keyword = this.peek(offset)
        const hasKeyword = keyword.type === "Keyword" && (keyword as { value?: unknown }).value === "function"
        if (hasKeyword) offset++
        const named = this.peek(offset)
        if (!(named.type === "Identifier" && (named as { value?: unknown }).value === name)) return undefined
        if (!hasKeyword && !this.startsMethodShorthand(offset)) return undefined
        return offset
    }

    private operatorAt(ahead: number, value: string): boolean {
        const token = this.peek(ahead)
        return token.type === "Operator" && (token as { value?: unknown }).value === value
    }

    private parseFunctionName(): FunctionName {
        const start = this.current()
        const base = this.parseIdentifier()
        const path: Identifier[] = []
        while (this.checkPunctuator(".")) {
            this.advance()
            path.push(this.parseIdentifier())
        }
        let method: Identifier | undefined
        if (this.matchPunctuator(":")) {
            method = this.parseIdentifier()
        }
        return { type: "FunctionName", base, path, method, ...spanFrom(start, this.previous()) }
    }

    private isExpressionStart(): boolean {
        const t = this.current()
        if (t.type === "Literal" || t.type === "InterpolatedString" || t.type === "Identifier") return true
        if (t.type === "Keyword") {
            return ["function", "if", "not", "nil", "true", "false"].includes((t as any).value) || this.startsImportExpression()
        }
        if (t.type === "Operator") {
            return ["...", "-", "#"].includes((t as any).value)
        }
        if (t.type === "Punctuator") {
            const v = (t as any).value
            return v === "(" || v === "{" || v === "["
        }
        return false
    }

    private parseReturnStatement(stopAtNewline = false): ReturnStatement {
        const start = this.current()
        this.expectKeyword("return")
        let argument: Expression | undefined
        const pastLine = (): boolean => stopAtNewline && this.current().line.start > start.line.start
        // A bare `return` before the next statement returns nothing: code
        // may follow it, and what begins a statement on the next line is that.
        const nextStatement = this.onNewLine() && beginsStatement(this.tokens, this.cursor)
        if (!pastLine() && !nextStatement && this.isExpressionStart()) {
            const values = this.expressionListOr(pastLine)
            argument = values[0]
            // A function gives back one value. Several are an array, which
            // is what the rest of the file is read as once this is reported.
            if (values.length > 1) {
                this.problemAt(start, "A function returns one value: return several as an array, 'return [a, b]'")
                argument = this.valuesAsArray(values)
            }
        }
        return { type: "ReturnStatement", argument, ...spanFrom(start, this.previous()) }
    }

    private parseTypeAliasStatement(): TypeAliasStatement {
        const start = this.current()
        this.advance()
        const name = this.parseTypeName()

        let generics: GenericTypeParameter[] = []
        if (this.checkOperator("<")) {
            generics = this.parseGenericTypeParameterList(true)
        }
        this.expectOperator("=")
        const definition = this.parseType()
        return { type: "TypeAliasStatement", name, generics, definition, ...spanFrom(start, this.previous()) }
    }

    /** `interface` is a soft keyword: a declaration only when a name and
     *  then `{`, `<` or `extends` follow it. */
    private startsInterface(): boolean {
        if (!this.checkIdentifierValue("interface") || this.peek(1).type !== "Identifier") return false
        const after = this.peek(2)
        return (after.type === "Punctuator" && (after as { value?: unknown }).value === "{")
            || (after.type === "Operator" && (after as { value?: unknown }).value === "<")
            || (after.type === "Identifier" && (after as { value?: unknown }).value === "extends")
    }

    /** `interface Name<T> extends A, B<T> { members }` — a type alias for the
     *  bases and the members together (see `InterfaceParts`). */
    private parseInterfaceStatement(): TypeAliasStatement {
        const start = this.advance() // 'interface'
        const name = this.parseTypeName()
        const generics = this.checkOperator("<") ? this.parseGenericTypeParameterList(true) : []
        const bases: TypeReference[] = []
        if (this.checkIdentifierValue("extends")) {
            this.advance()
            do {
                const base = this.parsePrimaryType()
                if (base.type !== "TypeReference") {
                    this.problemAt(this.previous(), "An interface extends named types: 'interface B extends A { ... }'")
                } else {
                    bases.push(base)
                }
            } while (this.matchPunctuator(","))
        }
        const bodyStart = this.current()
        this.expectPunctuator("{")
        const members = this.parseTypeMembers(bodyStart)
        this.expectPunctuator("}")
        const body: TableTypeNode = { ...members, ...spanFrom(bodyStart, this.previous()) }
        const definition: TypeNode = bases.length
            ? { type: "IntersectionTypeNode", types: [...bases, body], ...spanFrom(bases[0], body) } as TypeNode
            : body
        return {
            type: "TypeAliasStatement", name, generics, definition,
            interface: { extends: bases, body },
            ...spanFrom(start, this.previous()),
        }
    }

    /** `enum Color {`, `namespace N {`, `try {`, `switch (x) {`: the
     *  word, then what TypeScript would write after it. */
    private startsUnsupported(): boolean {
        const word = (this.current() as { value?: unknown }).value
        if (word === "try") return this.punctuatorAt(1, "{")
        if (word === "switch") return this.punctuatorAt(1, "(") && this.braceFollowsGroupAt(1)
        return this.peek(1).type === "Identifier" && this.punctuatorAt(2, "{")
    }

    /** Is the `(` at `offset` closed by a `)` followed by `{`? */
    private braceFollowsGroupAt(offset: number): boolean {
        let depth = 0
        for (let i = offset; this.peek(i).type !== "EOF"; i++) {
            const t = this.peek(i)
            if (t.type !== "Punctuator") continue
            const v = (t as { value?: unknown }).value
            if (v === "(") depth++
            else if (v === ")" && --depth === 0) return this.punctuatorAt(i + 1, "{")
        }
        return false
    }

    /** Past the statement an unsupported word starts: up to the `{` that
     *  opens its body, then to the `}` that closes it — and, for `try`, its
     *  `catch` and `finally` blocks too. */
    private skipUnsupported(): void {
        const skipBraces = (): void => {
            while (!this.checkPunctuator("{") && !this.isAtEnd()) this.advance()
            let depth = 0
            while (!this.isAtEnd()) {
                const t = this.advance()
                if (t.type !== "Punctuator") continue
                const v = (t as { value?: unknown }).value
                if (v === "{") depth++
                else if (v === "}" && --depth === 0) return
            }
        }
        skipBraces()
        while (this.checkIdentifierValue("catch") || this.checkIdentifierValue("finally")) skipBraces()
    }

    private parseExportTypeAliasStatement(): ExportTypeAliasStatement {
        const start = this.current()
        this.advance()
        const alias = this.parseTypeAliasStatement()
        return { type: "ExportTypeAliasStatement", alias, ...spanFrom(start, this.previous()) }
    }

    private parseExpressionStatement(): Statement {
        const start = this.current()

        // Destructuring assignment: `{a, b} = t` / `[a, b] = t`. A statement
        // can't otherwise begin with `{` or `[`, so this is unambiguous (no
        // parens required, unlike JS).
        if (this.checkPunctuator("{") || this.checkPunctuator("[")) {
            // `[1, 2]:forEach(f)`, `{ a: 1 }:keys()`: a call on a literal,
            // not a pattern being assigned to.
            const call = this.tryParse(() => {
                const errors = this.errors.length
                const expression = this.parseAtom()
                if (expression.type !== "MethodCallExpression" && expression.type !== "CallExpression") throw new ParseRecover("not a call")
                if (this.errors.length > errors) throw new ParseRecover("not a call")
                return expression
            })
            if (call) return { type: "CallStatement", expression: call, ...spanFrom(start, this.previous()) }
            const target = this.checkPunctuator("{") ? this.parseObjectPattern(true) : this.parseArrayPattern(true)
            return this.parseAssignmentRest(start, target)
        }

        const statementStart = this.cursor
        const errorsAtStart = this.errors.length
        const first = this.parsePrefixExpression()

        if (this.checkOperator("=") || this.checkPunctuator(",")) {
            this.rejectOptionalTarget(first)
            return this.parseAssignmentRest(start, first)
        }

        const t = this.current()
        // `n++` / `n--`: a statement, as Luau's `n += 1` is — it gives no
        // value, so it cannot be written inside an expression.
        if (t.type === "Operator" && ((t as any).value === "++" || (t as any).value === "--")) {
            this.rejectOptionalTarget(first)
            const op = this.advance() as Token & { value: "++" | "--" }
            const one: NumberLiteral = { type: "NumberLiteral", value: 1, raw: "1", ...spanFrom(op, op) }
            return {
                type: "CompoundAssignmentStatement",
                operator: op.value === "++" ? "+=" : "-=",
                target: first,
                value: one,
                postfix: op.value,
                ...spanFrom(start, op),
            }
        }
        if (t.type === "Operator" && COMPOUND_ASSIGN_OPS.has((t as any).value)) {
            this.rejectOptionalTarget(first)
            const op = (this.advance() as any).value
            const value = this.expressionOr(() => false)
            return {
                type: "CompoundAssignmentStatement",
                operator: op,
                target: first,
                value,
                ...spanFrom(start, this.previous()),
            }
        }

        if (first.type === "CallExpression" || first.type === "MethodCallExpression") {
            return { type: "CallStatement", expression: first, ...spanFrom(start, this.previous()) }
        }

        // Any other expression on a line of its own. Lua has no such statement
        // and the compiler drops it, but writing a name and asking the editor
        // about it is how code gets written: making that a syntax error stops
        // the file being analysed exactly when the help is wanted.
        //
        // `parsePrefixExpression` stopped at the first thing that cannot start
        // a call or an assignment, so an expression that continues past it
        // (`value + 1`, `a ? b : c`) is only half read. Read the statement
        // again as a whole expression, from where it started.
        let expression: Expression = first
        if (this.isBinaryOperator() || this.checkPunctuator("?") ||
            this.checkIdentifierValue("as") || this.checkIdentifierValue("satisfies")) {
            this.cursor = statementStart
            this.errors.length = errorsAtStart
            expression = this.parseExpression()
        }
        return { type: "ExpressionStatement", expression, ...spanFrom(start, this.previous()) }
    }

    /** From after an assignment's target: `= value`. Luau's `a, b = x, y`
     *  is reported, and read as its first target taking its first value. */
    private parseAssignmentRest(start: Token, target: Expression | ObjectPattern | ArrayPattern): AssignmentStatement {
        let several = false
        while (this.matchPunctuator(",")) { this.parseAssignTarget(); several = true }
        this.expectOperator("=")
        const values = this.expressionListOr(() => false)
        if (several || values.length > 1) {
            this.problemAt(start, "An assignment takes one value: take several from an array, '[a, b] = [x, y]'")
        }
        return { type: "AssignmentStatement", target, value: values[0], ...spanFrom(start, this.previous()) }
    }

    // ============================================================
    // Expressions
    // ============================================================

    private parseExpressionList(): Expression[] {
        const list = [this.parseExpression()]
        while (this.matchPunctuator(",")) {
            list.push(this.parseExpression())
        }
        return list
    }

    private isBinaryOperator(): string | null {
        const t = this.current()
        if (t.type === "Keyword" && ((t as any).value === "and" || (t as any).value === "or" || (t as any).value === "in")) {
            return (t as any).value
        }
        // `instanceof` is a soft keyword: an operator only where one can
        // stand, after an operand on the same line.
        if (t.type === "Identifier" && (t as any).value === "instanceof" && this.previous()?.line.end === t.line.start) {
            return "instanceof"
        }
        if (t.type === "Operator" && (t as any).value in BINARY_PRECEDENCE) {
            return (t as any).value
        }
        return null
    }

    /** Is the `:` at the cursor the start of a method call (`obj:name(...)`)
     *  rather than the `:` of a ternary (`cond ? obj : other`)? Lua requires a
     *  method call to be called, so the answer is exact rather than heuristic:
     *  `:` Identifier followed by one of Lua's call forms. */
    private startsMethodCall(offset = 0): boolean {
        if (this.peek(offset + 1).type !== "Identifier") return false
        if (this.startsOwnLine(this.peek(offset), this.peek(offset + 1))) return false
        const after = this.peek(offset + 2)
        if (after.type === "Punctuator") {
            const v = String((after as { value?: unknown }).value)
            return v === "(" || v === "{"
        }
        if (after.type === "InterpolatedString") return true
        if (after.type === "Literal" && (after as { kind?: unknown }).kind === "string") return true
        // `obj:m<T>(...)` — a method call too, if a call really follows the
        // type arguments. `cond ? obj : name < 3` must stay a ternary.
        if (after.type === "Operator" && String((after as { value?: unknown }).value) === "<") {
            const save = this.cursor
            this.cursor += offset + 2
            const found = this.tryCallTypeArguments() !== undefined
            this.cursor = save
            return found
        }
        return false
    }

    /** A string written straight before a method call — `"a":upper()`, or
     *  `` `{n}`:rep(2) ``. Luau only takes `("a"):upper()`; the compiler adds
     *  the parentheses. Anything else after a string (`"a".x`, `"a"(1)`) is
     *  not a prefix expression here either. */
    private startsStringMethodCall(): boolean {
        const t = this.current()
        const isString = t.type === "InterpolatedString" ||
            (t.type === "Literal" && (t as { kind?: unknown }).kind === "string")
        return isString && ((this.punctuatorAt(1, ":") && this.startsMethodCall(1)) || this.startsDotMember(1))
    }

    /** `"a".length`, `[1, 2].concat(xs)`: a `.` and a name on the same line,
     *  at `offset`. */
    private startsDotMember(offset: number): boolean {
        return this.punctuatorAt(offset, ".") && this.peek(offset + 1).type === "Identifier" &&
            !this.startsOwnLine(this.peek(offset), this.peek(offset + 1))
    }

    /** Is there no member name at `offset`, after the `.` or `:` before it? */
    private namelessAfter(offset: number): boolean {
        const name = this.peek(offset)
        if (name.type !== "Identifier") return true
        const before = offset === 0 ? this.previous() : this.peek(offset - 1)
        return before !== undefined && this.startsOwnLine(before, name)
    }

    /** Recovery only. `obj.` may go on to its name on a later line, as in
     *  JavaScript — but while `obj.` is still being typed, the line below is
     *  whatever statement was already there, and reading it as the name turns
     *  one unfinished line into errors about the next. So, as a missing `}`
     *  is placed, the indentation says which: a line that carries the access
     *  on is indented deeper than the line it carries on from. */
    private startsOwnLine(before: Token, name: Token): boolean {
        if (!this.recover || name.line.start <= before.line.end) return false
        return this.indentOf(name) <= this.indentOf(before)
    }

    /** Does the next token start right where the current one ends? */
    private touchesNext(): boolean {
        const current = this.current()
        const next = this.peek(1)
        return current.line.end === next.line.start && current.column.end === next.column.start
    }

    /** `a?.b = 1` cannot be written: there may be nothing to assign to. */
    private rejectOptionalTarget(target: Expression | ObjectPattern | ArrayPattern): void {
        for (let e: unknown = target; e && typeof e === "object";) {
            const node = e as { type?: string; optional?: boolean; object?: unknown; callee?: unknown }
            if (node.optional) {
                const at = target as Expression
                const err = new ParseError("An optional chain cannot be assigned to", at.line.start, at.column.start)
                if (!this.recover) throw err
                this.record(err)
                return
            }
            e = node.type === "MemberExpression" || node.type === "IndexExpression" || node.type === "MethodCallExpression"
                ? node.object
                : node.type === "CallExpression" ? node.callee : undefined
        }
    }

    /** `->` where `=>` belongs. tilua has one arrow, for the type and for the
     *  function; Luau's is still lexed only so that writing it says so. In
     *  recovery the `->` is read as the arrow it was meant to be, so the rest
     *  of the file still analyses. */
    private mistypedArrow(): boolean {
        if (!this.checkPunctuator("->")) return false
        const at = this.current()
        const error = new ParseError(
            "tilua writes a function type with '=>', not '->'", at.line.start, at.column.start)
        if (!this.recover) throw error
        this.record(error)
        this.advance()
        return true
    }

    private isUnaryOperator(): string | null {
        const t = this.current()
        if (t.type === "Keyword" && (t as any).value === "not") return "not"
        if (t.type === "Operator" && ((t as any).value === "-" || (t as any).value === "#")) return (t as any).value
        // `typeof v`: an operator, as `not` is.
        if (t.type === "Identifier" && (t as any).value === "typeof") return "typeof"
        return null
    }

    /** Runs `fn` inside a bracket, where a `:` can only ever be a method
     *  call's: an enclosing ternary's `:` lives outside the bracket. */
    private inBrackets<T>(fn: () => T): T {
        const saved = this.ternaryColons
        this.ternaryColons = null
        try {
            return fn()
        } finally {
            this.ternaryColons = saved
        }
    }

    /** A `:` at the cursor reads as a method call's — unless it is one of a
     *  ternary consequent's rationed `:`s and the ration has run out. */
    private takeMethodColon(): boolean {
        const colons = this.ternaryColons
        if (!colons) return true
        colons.used++
        return colons.allowance < 0 || colons.used <= colons.allowance
    }

    /** The consequent of `cond ? a : b`.
     *
     *  `a : b()` is ambiguous — Lua reads `a:b()` as a method call, which eats
     *  the ternary's `:`. Method calls win, since `cond ? obj:m() : other` is
     *  real code, so read the consequent that way first and fall back to
     *  refusing a method-call `:` at this depth only when the first reading
     *  leaves the ternary without its `:`. */
    private parseTernaryConsequent(): Expression {
        // Greediest first: every `:` at this depth is a method call's.
        const greedy = this.tryTernaryConsequent(-1)
        if (greedy.expression) return greedy.expression
        // That overshot the ternary's `:`. Give back one `:` at a time, so the
        // consequent keeps as many method calls as it can and the ternary
        // still gets its own.
        for (let allowance = greedy.colons - 1; allowance >= 0; allowance--) {
            const attempt = this.tryTernaryConsequent(allowance)
            if (attempt.expression) return attempt.expression
        }
        // No reading reaches a `:`. Take the ordinary one and let the caller
        // report the missing `:` where it really is.
        return this.parseExpression()
    }

    /** One reading of a ternary's consequent, or `undefined` if it does not
     *  end at the ternary's `:` — in which case the cursor and any recorded
     *  errors are left exactly as they were. */
    private tryTernaryConsequent(allowance: number): { expression?: Expression; colons: number } {
        const start = this.cursor
        const errors = this.errors.length
        const missingEnd = this.missingEnd
        const saved = this.ternaryColons
        const colons = { allowance, used: 0 }
        this.ternaryColons = colons
        try {
            const expression = this.parseExpression()
            if (this.checkPunctuator(":")) return { expression, colons: colons.used }
        } catch (error) {
            if (!(error instanceof ParseError)) throw error
        } finally {
            this.ternaryColons = saved
        }
        this.cursor = start
        this.errors.length = errors
        this.missingEnd = missingEnd
        return { colons: colons.used }
    }

    parseExpression(minPrec = 0): Expression {
        const expr = this.parseBinaryExpression(minPrec)
        // `cond ? a : b`. Lowest precedence and right-associative, as in
        // TypeScript, so `a ? b : c ? d : e` nests to the right. It produces
        // the same `IfElseExpression` node as `if a then b else c` — one node
        // for the compiler to lower, two ways to write it.
        if (minPrec > 0 || !this.checkPunctuator("?")) return expr
        this.advance()
        const consequent = this.parseTernaryConsequent()
        this.expectPunctuator(":")
        const alternate = this.parseExpression()
        return {
            type: "IfElseExpression",
            clauses: [{ condition: expr, body: consequent }],
            alternate,
            ...spanFrom(expr, alternate),
        }
    }

    private parseBinaryExpression(minPrec: number): Expression {
        let left = this.parseUnaryOrAtom()

        while (true) {
            const op = this.isBinaryOperator()
            if (!op) break
            const prec = BINARY_PRECEDENCE[op]
            if (prec < minPrec) break

            const opToken = this.advance()
            const rightAssoc = RIGHT_ASSOCIATIVE.has(op)
            const nextMinPrec = rightAssoc ? prec : prec + 1
            // `a +` at the end of a line, and the next statement below it.
            const right = this.valueMissing("a value")
                ? this.errorExpression(this.current(), this.cursor)
                : this.parseBinaryExpression(nextMinPrec)
            if (mixesNullish(left, op) || mixesNullish(right, op)) {
                this.problemAt(opToken, "'??' cannot be mixed with 'and' or 'or' without parentheses")
            }
            left = {
                type: "BinaryExpression",
                operator: op as any,
                left, right,
                ...spanFrom(left, right),
            }
        }

        return left
    }

    private parseUnaryOrAtom(): Expression {
        const op = this.isUnaryOperator()
        if (op) {
            const opTok = this.advance()
            // `typeof(v)` is the call of a function tilua does not have. A
            // parenthesised operand stands apart from it: `typeof (a or b)`.
            const next = this.current()
            if (op === "typeof" && this.checkPunctuator("(")
                && next.line.start === opTok.line.end && next.column.start === opTok.column.end) {
                this.problemAt(next, NO_TYPEOF_CALL)
            }
            if (op === "#") this.problemAt(opTok, NO_LENGTH_OPERATOR)
            const argument = this.parseExpression(UNARY_PRECEDENCE)
            // In recovery `#xs` is read as the `xs.length` it meant.
            if (op === "#") {
                return {
                    type: "MemberExpression",
                    object: argument,
                    property: { type: "Identifier", name: "length", ...spanFrom(opTok, opTok) },
                    ...spanFrom(opTok, argument),
                }
            }
            return {
                type: "UnaryExpression",
                operator: op as any,
                argument,
                ...spanFrom(opTok, argument),
            }
        }
        return this.parseAtomWithAssertion()
    }

    private parseAtomWithAssertion(): Expression {
        let expr = this.parseAtom()
        // tilua drops Luau's `::` assertion syntax entirely in favor of `as`,
        // mirroring TypeScript. `as const` is a special case with no TypeNode
        // on the right — the checker infers the narrowest literal type itself.
        while (this.checkKeyword("as") || this.checkIdentifierValue("satisfies")) {
            // `expr satisfies T` validates without changing the type; `as T`
            // reinterprets. `satisfies` is a soft keyword.
            if (this.checkIdentifierValue("satisfies")) {
                this.advance()
                const typeAnnotation = this.parseType()
                expr = {
                    type: "SatisfiesExpression",
                    expression: expr,
                    typeAnnotation,
                    ...spanFrom(expr, typeAnnotation),
                }
                continue
            }
            this.advance()
            if (this.checkKeyword("const")) {
                const constTok = this.advance()
                expr = {
                    type: "AsConstExpression",
                    expression: expr,
                    ...spanFrom(expr, constTok),
                }
                continue
            }
            const typeAnnotation = this.parseType()
            expr = {
                type: "TypeAssertionExpression",
                expression: expr,
                typeAnnotation,
                ...spanFrom(expr, typeAnnotation),
            }
        }
        return expr
    }

    private parseAtom(): Expression {
        const t = this.current()

        // `"a".upper()`: Luau wants the string in parentheses; tilua does not.
        if (this.startsStringMethodCall()) return this.parsePrefixExpression()

        if (t.type === "Literal") {
            this.advance()
            const lit = t as any
            switch (lit.kind) {
                case "nil":
                    return { type: "NilLiteral", ...spanFrom(t, t) } as NilLiteral
                case "boolean":
                    return { type: "BooleanLiteral", value: lit.value, ...spanFrom(t, t) } as BooleanLiteral
                case "number":
                    return { type: "NumberLiteral", value: lit.value, raw: lit.raw, ...spanFrom(t, t) } as NumberLiteral
                case "string":
                    return { type: "StringLiteral", value: lit.value, raw: lit.raw, ...spanFrom(t, t) } as StringLiteral
            }
        }

        if (t.type === "InterpolatedString") {
            this.advance()
            return this.buildInterpolatedString(t as any)
        }

        if (t.type === "Operator" && (t as any).value === "...") {
            this.problem(NO_DOTS)
            this.advance()
            return { type: "ErrorExpression", ...spanFrom(t, t) } as ErrorExpression
        }

        if (t.type === "Keyword" && (t as any).value === "function") {
            this.advance()
            const func = this.parseFunctionBody(t)
            return { type: "FunctionExpression", func, ...spanFrom(t, this.previous()) } as FunctionExpression
        }

        if (t.type === "Keyword" && (t as any).value === "if") {
            return this.parseIfElseExpression()
        }

        // `class` where a value goes is always a class — as in TypeScript. It
        // is a soft keyword everywhere a name is written (`const class = 1`,
        // `t.class`), just not here.
        if (t.type === "Identifier" && (t as any).value === "class") {
            return this.parseClassExpression()
        }

        // `{ a: 1 }.keys()`, `[1, 2].map(f)`: like a string, a literal is
        // called on without the parentheses Luau would want.
        if (t.type === "Punctuator" && ((t as any).value === "{" || (t as any).value === "[")) {
            const literal = (t as any).value === "{" ? this.parseTableExpression() : this.parseArrayExpression()
            return (this.checkPunctuator(":") && this.startsMethodCall()) || this.startsDotMember(0)
                ? this.parseSuffixes(literal)
                : literal
        }

        // `x => x * 2`, `(a, b) => a + b`, `(a: number): string => a`.
        // A lone name followed by `=>` can be nothing else; anything starting
        // with `(` or `<` is tried as one and put back if it is not.
        if (this.checkType("Identifier") && this.punctuatorAt(1, "=>")) return this.parseArrow()
        if (this.checkPunctuator("(") || this.checkOperator("<")) {
            const arrow = this.tryParse(() => this.parseArrow())
            if (arrow) return arrow
        }

        if (t.type === "Identifier" || (t.type === "Punctuator" && (t as any).value === "(") || this.startsImportExpression()) {
            return this.parsePrefixExpression()
        }

        this.error("Unexpected token in expression")
    }

    private buildInterpolatedString(token: {
        parts: { kind: "string"; value: string; raw: string }[] | any
        line: any; column: any
    }): InterpolatedStringExpression {
        const parts: InterpolatedStringPart[] = []
        for (const p of (token as any).parts as any[]) {
            if (p.kind === "string") {
                parts.push({ kind: "string", value: p.value, raw: p.raw })
            } else {
                let expression: Expression
                try {
                    expression = shiftSpans(parseExpressionFromSource(p.raw, this.classDepth > 0), p.line, p.column)
                } catch (e) {
                    if (!this.recover || !(e instanceof ParseError || e instanceof LexError)) throw e
                    const at = token as unknown as Span
                    this.record(new ParseError(
                        `In '\${${p.raw}}': ${e.message.replace(/ \(\d+:\d+\)$/, "")}`, at.line.start, at.column.start))
                    expression = { type: "ErrorExpression", ...spanFrom(at, at) }
                }
                parts.push({ kind: "expression", expression })
            }
        }
        return { type: "InterpolatedStringExpression", parts, ...spanFrom(token as any, token as any) }
    }

    private parseIfElseExpression(): IfElseExpression {
        const start = this.current()
        this.expectKeyword("if")
        const clauses: { condition: Expression; body: Expression }[] = []
        const cond = this.parseExpression()
        this.expectKeyword("then")
        const body = this.parseExpression()
        clauses.push({ condition: cond, body })

        while (this.checkKeyword("elseif")) {
            this.advance()
            const c = this.parseExpression()
            this.expectKeyword("then")
            const b = this.parseExpression()
            clauses.push({ condition: c, body: b })
        }

        this.expectKeyword("else")
        const alternate = this.parseExpression()
        return { type: "IfElseExpression", clauses, alternate, ...spanFrom(start, this.previous()) }
    }

    private parsePrefixExpression(): Expression {
        const start = this.current()
        let base: Expression

        if (this.startsNew()) {
            // Luau builds an instance with the class's own function; tilua
            // writes it the same way. Reported, then read as the name after it
            // so the rest of the expression still means something to tooling.
            this.problem("tilua has no 'new' operator: construct with 'Name.new(...)'")
            this.advance()
        }
        if (this.classDepth > 0 && this.checkIdentifierValue("super") && this.startsSuperUse()) {
            this.advance()
            base = { type: "SuperExpression", ...spanFrom(start, start) }
        } else if (this.checkType("Identifier")) {
            base = this.parseIdentifier()
        } else if (this.startsStringMethodCall()) {
            const t = this.advance() as any
            base = t.type === "InterpolatedString"
                ? this.buildInterpolatedString(t)
                : { type: "StringLiteral", value: t.value, raw: t.raw, ...spanFrom(t, t) } as StringLiteral
        } else if (this.startsImportExpression()) {
            base = this.parseImportExpression()
        } else if (this.matchPunctuator("(")) {
            const inner = this.inBrackets(() => this.parseExpression())
            this.expectPunctuator(")")
            base = { type: "ParenthesizedExpression", expression: inner, ...spanFrom(start, this.previous()) }
        } else {
            this.error("Expected identifier or '('")
        }
        return this.parseSuffixes(base)
    }

    /** `import(` — the expression, not the statement that starts `import {`. */
    private startsImportExpression(): boolean {
        return this.checkKeyword("import") && this.punctuatorAt(1, "(")
    }

    /** `import("./module")`: the module's exports, loaded when this runs. */
    private parseImportExpression(): ImportExpression {
        const start = this.advance() // consume 'import'
        this.expectPunctuator("(")
        const source = this.inBrackets(() => this.parseExpression())
        this.expectPunctuator(")")
        return { type: "ImportExpression", source, ...spanFrom(start, this.previous()) }
    }

    /** What follows a prefix expression's base: `.name`, `[key]`, `:m(...)`,
     *  a call, and their optional forms. */
    private parseSuffixes(base: Expression): Expression {
        while (true) {
            // `a?.b` / `a?:m()`: the `?` must touch what follows it, as one
            // token would. `?` alone still starts a ternary's middle.
            if (this.checkPunctuator("?") && this.touchesNext()) {
                const next = this.peek(1)
                const punct = next.type === "Punctuator" ? String((next as { value?: unknown }).value) : undefined
                if (punct === "." && this.recover && this.namelessAfter(2) && !this.punctuatorAt(2, "[") && !this.punctuatorAt(2, "(")) {
                    // `obj?.` mid-typing.
                    this.advance()
                    this.advance()
                    this.problemAt(this.previous(), NO_MEMBER_NAME)
                    base = { type: "ErrorExpression", expression: base, ...spanFrom(base, this.previous()) }
                    break
                }
                if (punct === "." && this.peek(2).type === "Identifier") {
                    this.advance()
                    this.advance()
                    const prop = this.parseIdentifier()
                    base = { type: "MemberExpression", object: base, property: prop, optional: true, ...spanFrom(base, prop) }
                    continue
                }
                if (punct === "." && this.punctuatorAt(2, "[")) {
                    this.advance()
                    this.advance()
                    this.expectPunctuator("[")
                    const index = this.inBrackets(() => this.parseExpression())
                    this.expectPunctuator("]")
                    base = {
                        type: "IndexExpression",
                        object: base, index, optional: true,
                        ...spanFrom(base, this.previous()),
                    }
                    continue
                }
                if (punct === "." && this.punctuatorAt(2, "(")) {
                    this.advance()
                    this.advance()
                    const args = this.parseCallArguments()
                    base = {
                        type: "CallExpression",
                        callee: base, arguments: args, optional: true,
                        ...spanFrom(base, this.previous()),
                    }
                    continue
                }
                if (punct === ":" && this.startsMethodCall(1) && this.takeMethodColon()) {
                    this.advance()
                    this.advance()
                    const method = this.parseIdentifier()
                    const typeArguments = this.tryCallTypeArguments()
                    const args = this.parseCallArguments()
                    base = {
                        type: "MethodCallExpression",
                        object: base, method, arguments: args, typeArguments, optional: true,
                        ...spanFrom(base, this.previous()),
                    }
                    continue
                }
            }
            if (this.matchPunctuator(".")) {
                // `obj.` mid-typing: the access has no name yet — or, in
                // recovery, the only name is the line below's own.
                if (this.namelessAfter(0)) {
                    this.problemAt(this.previous(), NO_MEMBER_NAME)
                    base = { type: "ErrorExpression", expression: base, ...spanFrom(base, this.previous()) }
                    break
                }
                const prop = this.parseIdentifier()
                base = { type: "MemberExpression", object: base, property: prop, ...spanFrom(base, prop) }
                continue
            }
            if (this.matchPunctuator("[")) {
                const index = this.inBrackets(() => this.parseExpression())
                this.expectPunctuator("]")
                base = { type: "IndexExpression", object: base, index, ...spanFrom(base, this.previous()) }
                continue
            }
            // `obj:` mid-typing, the last thing on its line: as `obj.` is. Not
            // in a ternary's consequent, whose own `:` may end a line.
            if (this.recover && !this.ternaryColons && this.checkPunctuator(":")
                && this.peek(1).line.start > this.current().line.end && !this.startsMethodCall()) {
                this.advance()
                this.problemAt(this.previous(), "Expected a name after ':'")
                base = { type: "ErrorExpression", expression: base, ...spanFrom(base, this.previous()) }
                break
            }
            if (this.checkPunctuator(":") && this.startsMethodCall() && this.takeMethodColon()) {
                this.advance()
                const method = this.parseIdentifier()
                const typeArguments = this.tryCallTypeArguments()
                const args = this.parseCallArguments()
                base = {
                    type: "MethodCallExpression",
                    object: base, method, arguments: args, typeArguments,
                    ...spanFrom(base, this.previous()),
                }
                continue
            }
            if (this.checkOperator("<")) {
                const typeArguments = this.tryCallTypeArguments()
                if (typeArguments) {
                    const args = this.parseCallArguments()
                    base = {
                        type: "CallExpression",
                        callee: base, arguments: args, typeArguments,
                        ...spanFrom(base, this.previous()),
                    }
                    continue
                }
            }
            if (this.startsCallArguments()) {
                // `x\n("a")` is a call of `x`: worth telling the analyzer, so
                // it can point out what was almost certainly two statements.
                const onNewLine: boolean = this.current().line.start > base.line.end
                const args = this.parseCallArguments()
                base = {
                    type: "CallExpression",
                    callee: base, arguments: args,
                    argumentsOnNewLine: onNewLine || undefined,
                    ...spanFrom(base, this.previous()),
                }
                continue
            }
            break
        }

        return base
    }

    /** `new Name(...)`, the way other languages build an instance — only to
     *  say so. A function or field called `new` — `Instance.new(x)`, and
     *  `Vec.new(1)` itself — is untouched. */
    private startsNew(): boolean {
        return this.checkIdentifierValue("new") && this.peek(1).type === "Identifier"
    }

    /** `super` on its own means the base class, and only `super(...)` and
     *  `super.member` say anything; anything else is a name that happens to
     *  be spelled that way. */
    private startsSuperUse(): boolean {
        return this.punctuatorAt(1, "(") || (this.punctuatorAt(1, ".") && this.peek(2).type === "Identifier")
    }

    /** After `...`, is there something to spread? tilua has no bare `...`:
     *  a varying number of arguments is a rest parameter, `...args: T[]`. */
    private startsSpread(): boolean {
        const next = this.peek(1)
        if (next.type === "Punctuator") {
            const value = (next as { value?: unknown }).value
            return value === "(" || value === "{" || value === "["
        }
        return next.type === "Identifier" || next.type === "Literal" || next.type === "InterpolatedString"
    }

    private parseSpreadArgument(stop: () => boolean): SpreadElement {
        const dots = this.advance()
        const argument = this.expressionOr(stop)
        return { type: "SpreadElement", argument, ...spanFrom(dots, argument) }
    }

    /** Is the token `ahead` places on the punctuator `value`? */
    private punctuatorAt(ahead: number, value: string): boolean {
        const token = this.peek(ahead)
        return token.type === "Punctuator" && (token as { value?: unknown }).value === value
    }

    /** An assignment target after the first — Luau's `a, b = ...`, read only
     *  to be reported: a prefix expression or a destructuring pattern. */
    private parseAssignTarget(): Expression | ObjectPattern | ArrayPattern {
        if (this.checkPunctuator("{")) return this.parseObjectPattern(true)
        if (this.checkPunctuator("[")) return this.parseArrayPattern(true)
        return this.parsePrefixExpression()
    }

    /** Does a call's argument list start here? Lua's three forms: `(`, a
     *  string, or a table. */
    private startsCallArguments(): boolean {
        return this.checkPunctuator("(") || this.checkPunctuator("{") ||
            this.checkType("InterpolatedString") ||
            (this.checkType("Literal") && (this.current() as { kind?: unknown }).kind === "string")
    }

    /** `f<A, B>(x)` — type arguments, when that is what this is. `a < b > (c)`
     *  is three operators, and only what follows the `>` tells them apart, so
     *  this reads ahead and puts the cursor back when the guess was wrong. */
    private tryCallTypeArguments(): TypeNode[] | undefined {
        if (!this.checkOperator("<")) return undefined
        const start = this.cursor
        const errors = this.errors.length
        try {
            this.advance()
            const list: TypeNode[] = [this.parseType()]
            while (this.matchPunctuator(",") && !this.checkOperator(">")) list.push(this.parseType())
            this.expectOperator(">")
            if (!this.startsCallArguments()) throw new ParseRecover("not a call")
            return list
        } catch (e) {
            if (!(e instanceof ParseError || e instanceof ParseRecover)) throw e
            this.cursor = start
            this.errors.length = errors
            return undefined
        }
    }

    private parseCallArguments(): Expression[] {
        return this.inBrackets(() => this.parseCallArgumentsInner())
    }

    private parseCallArgumentsInner(): Expression[] {
        if (this.matchPunctuator("(")) {
            const list: Expression[] = []
            const stop = (): boolean => this.checkPunctuator(",")
            if (!this.checkPunctuator(")")) {
                while (true) {
                    // `f(,` and then `Key: value` on the next line: the call
                    // was never closed, and that is the enclosing object's field.
                    if (this.recover && this.onNewLine() && this.startsTableField() && !this.startsMethodCall(1)) break
                    const before = this.cursor
                    // `f(...xs)` spreads an array.
                    const argument = this.checkOperator("...") && this.startsSpread()
                        ? this.parseSpreadArgument(stop)
                        : this.expressionOr(stop)
                    // `f(` with nothing written yet is no argument.
                    if (argument.type !== "ErrorExpression" || this.cursor > before || list.length) list.push(argument)
                    if (this.matchPunctuator(",") && !this.checkPunctuator(")")) continue
                    if (!this.recover || this.checkPunctuator(")")) break
                    // `print(a` and then the next line: the `)` is what is missing.
                    if (this.onNewLine() && (this.checkType("Identifier") || this.checkType("Keyword"))) break
                    this.softError("Expected ',' or ')'")
                    this.skip(stop, this.cursor, "expression")
                    if (this.matchPunctuator(",")) continue
                    break
                }
            }
            this.expectCloser(")")
            return list
        }

        const t = this.current()
        if (t.type === "Literal" && (t as any).kind === "string") {
            this.advance()
            return [{ type: "StringLiteral", value: (t as any).value, raw: (t as any).raw, ...spanFrom(t, t) }]
        }
        if (t.type === "InterpolatedString") {
            this.advance()
            return [this.buildInterpolatedString(t as any)]
        }
        if (t.type === "Punctuator" && (t as any).value === "{") {
            return [this.parseTableExpression()]
        }

        this.error("Expected function call arguments")
    }

    private parseIdentifier(): Identifier {
        const t = this.expectIdentifier()
        return { type: "Identifier", name: t.value as string, ...spanFrom(t, t) }
    }

    // `{}` is an OBJECT literal only in tilua: `{ a = 1, [k] = v, shorthand }`.
    // Positional entries (`{ 1, 2, 3 }`) are gone — use an array literal `[...]`.
    private parseTableExpression(): TableExpression {
        return this.inBrackets(() => this.parseTableExpressionInner())
    }

    private parseTableExpressionInner(): TableExpression {
        const start = this.current()
        this.expectPunctuator("{")
        const fields: TableField[] = []
        const stop = (): boolean =>
            this.checkPunctuator(",") || this.checkPunctuator(";") || (this.onNewLine() && this.startsTableField())

        while (!this.checkPunctuator("}")) {
            const field = this.attempt<TableField | undefined>(() => this.parseTableField(stop), stop, () => undefined)
            if (field) fields.push(field)
            if (this.matchPunctuator(",") || this.matchPunctuator(";")) continue
            if (!this.recover || this.checkPunctuator("}")) break
            // A field on its own line after one without a comma: the comma is
            // what is missing, not the field.
            if (this.onNewLine() && this.startsTableField()) {
                this.softError("Expected ','")
                continue
            }
            if (this.isAtEnd() || this.onNewLine() && this.checkType("Keyword")) break
            this.softError("Expected ',' or '}'")
            const before = this.cursor
            this.skip(stop, this.cursor, "expression")
            if (this.matchPunctuator(",") || this.matchPunctuator(";")) continue
            if (this.cursor > before && this.onNewLine() && this.startsTableField()) continue
            break
        }

        this.expectCloser("}")
        return { type: "TableExpression", fields, ...spanFrom(start, this.previous()) }
    }

    /** Does a `key: value` field, or a spread, start here? */
    private startsTableField(): boolean {
        if (this.startsAccessorField()) return true
        const next = this.peek(1)
        const colon = next.type === "Punctuator" && (next as { value?: unknown }).value === ":"
        if (this.checkType("Identifier")) return colon
        if (this.checkType("Literal") && (this.current() as { kind?: unknown }).kind === "string") return colon
        return this.checkOperator("...")
    }

    /** `get name(` / `set name(`: an accessor, not a field named `get`. */
    private startsAccessorField(): boolean {
        if (!this.checkIdentifierValue("get") && !this.checkIdentifierValue("set")) return false
        const key = this.peek(1)
        const named = key.type === "Identifier" || (key.type === "Literal" && (key as { kind?: unknown }).kind === "string")
        return named && this.punctuatorAt(2, "(")
    }

    private parseTableField(stop: () => boolean): TableField {
        if (this.startsAccessorField()) {
            const start = this.advance() as Token & { value: "get" | "set" }
            const keyTok = this.advance() as Token & { value?: unknown; raw?: string }
            const key: Identifier | StringLiteral = keyTok.type === "Identifier"
                ? tokenIdentifier(keyTok)
                : { type: "StringLiteral", value: String(keyTok.value), raw: keyTok.raw ?? "", ...spanFrom(keyTok, keyTok) }
            const func = this.parseFunctionBody(start)
            bindThis(func, start)
            const written = func.params.length - 1
            if (start.value === "get" && written !== 0) this.problemAt(start, "A 'get' accessor takes no parameters")
            if (start.value === "set" && written !== 1) this.problemAt(start, "A 'set' accessor takes exactly one parameter")
            return { type: "TableFieldAccessor", kind: start.value, key, func, ...spanFrom(start, this.previous()) }
        }
        if (this.checkOperator("...")) {
            this.advance()
            return { type: "TableFieldSpread", argument: this.expressionOr(stop) }
        }
        if (this.matchPunctuator("[")) {
            const key = this.expressionOr(() => this.checkPunctuator("]"))
            this.expectPunctuator("]")
            this.expectPunctuator(":")
            return { type: "TableFieldComputed", key, value: this.expressionOr(stop) }
        }
        // `m() { ... }` — a method, written as a class writes one.
        if ((this.checkType("Identifier") || (this.checkType("Literal") && (this.current() as any).kind === "string")) &&
            (this.punctuatorAt(1, "(") || this.operatorAt(1, "<"))) {
            const keyTok = this.advance() as Token & { value?: unknown; raw?: string }
            const key: Identifier | StringLiteral = keyTok.type === "Identifier"
                ? tokenIdentifier(keyTok)
                : { type: "StringLiteral", value: String(keyTok.value), raw: keyTok.raw ?? "", ...spanFrom(keyTok, keyTok) }
            const func = this.parseFunctionBody(keyTok)
            bindThis(func, keyTok)
            const value: Expression = { type: "FunctionExpression", func, ...spanFrom(keyTok, this.previous()) }
            return { type: "TableFieldNamed", key, value, method: true }
        }
        if (this.checkType("Literal") && (this.current() as any).kind === "string") {
            const t = this.advance() as any
            const key: StringLiteral = { type: "StringLiteral", value: t.value, raw: t.raw, ...spanFrom(t, t) }
            this.expectPunctuator(":")
            return { type: "TableFieldNamed", key, value: this.expressionOr(stop) }
        }
        if (this.checkType("Identifier") && this.peek(1).type === "Punctuator" && (this.peek(1) as any).value === ":") {
            const key = this.parseIdentifier()
            this.expectPunctuator(":")
            return { type: "TableFieldNamed", key, value: this.expressionOr(stop) }
        }
        if (this.checkType("Identifier")) {
            return { type: "TableFieldShorthand", name: this.parseIdentifier() }
        }
        this.error("Expected object field ('key: value', '[expr]: value', shorthand, or '...spread'); use '[...]' for arrays")
    }

    // `[1, 2, 3]` — array literal (trailing comma allowed).
    private parseArrayExpression(): ArrayExpression {
        return this.inBrackets(() => this.parseArrayExpressionInner())
    }

    private parseArrayExpressionInner(): ArrayExpression {
        const start = this.current()
        this.expectPunctuator("[")
        const elements: (Expression | SpreadElement)[] = []
        const stop = (): boolean => this.checkPunctuator(",")
        while (!this.checkPunctuator("]")) {
            if (this.checkOperator("...")) {
                const dots = this.advance()
                // `[...xs]` spreads `xs`; `[...]` spreads nothing tilua has.
                if (this.checkPunctuator("]") || this.checkPunctuator(",")) {
                    this.problemAt(dots, NO_DOTS)
                } else {
                    const argument = this.expressionOr(stop)
                    elements.push({ type: "SpreadElement", argument, ...spanFrom(dots, argument) })
                }
            } else {
                const at = this.cursor
                elements.push(this.expressionOr(stop))
                // Nothing was read: the array was never closed.
                if (this.cursor === at && !this.checkPunctuator(",") && !this.checkPunctuator("]")) break
            }
            if (this.matchPunctuator(",")) continue
            if (!this.recover || this.checkPunctuator("]")) break
            // An element on its own line after one without a comma.
            if (this.onNewLine() && this.isExpressionStart() && !this.checkType("Keyword")) {
                this.softError("Expected ','")
                continue
            }
            if (this.isAtEnd() || this.onNewLine() && this.checkType("Keyword")) break
            this.softError("Expected ',' or ']'")
            this.skip(stop, this.cursor, "expression")
            if (this.matchPunctuator(",")) continue
            break
        }
        this.expectCloser("]")
        return { type: "ArrayExpression", elements, ...spanFrom(start, this.previous()) }
    }

    // ============================================================
    // Destructuring patterns (JS-style)
    // ============================================================

    /** Parses a binding target. When `topLevel`, also consumes a trailing
     *  `<attr>` list (identifier only) and a `: Type` annotation — these are
     *  only valid at the outermost level of a `local` / parameter binding,
     *  never nested inside another pattern. When `assign`, the pattern is a
     *  destructuring assignment's (`[t[i], t[j]] = ...`), and a leaf is any
     *  place a value can be assigned to: a name, a member or an index. */
    private parseBindingTarget(topLevel: boolean, assign = false): BindingTarget {
        let target: BindingTarget

        if (this.checkPunctuator("{")) {
            target = this.parseObjectPattern(assign)
        } else if (this.checkPunctuator("[")) {
            target = this.parseArrayPattern(assign)
        } else if (assign) {
            return this.parseAssignPatternLeaf()
        } else {
            const nameTok = this.expectIdentifier()
            let attributes: string[] | undefined
            if (topLevel && this.checkOperator("<")) {
                this.advance()
                attributes = [this.expectIdentifier().value as string]
                while (this.matchPunctuator(",")) attributes.push(this.expectIdentifier().value as string)
                this.expectOperator(">")
            }
            target = {
                type: "IdentifierPattern",
                name: nameTok.value as string,
                attributes,
                ...spanFrom(nameTok, this.previous()),
            }
        }

        if (topLevel && this.matchPunctuator(":")) {
            target.typeAnnotation = this.typeOr(() => this.checkOperator("=") || this.checkPunctuator(","))
        }
        return target
    }

    /** A leaf of a destructuring assignment: `a`, `a.b` or `a[i]`. */
    private parseAssignPatternLeaf(): BindingTarget {
        const expression = this.parsePrefixExpression()
        if (expression.type === "Identifier") {
            return { type: "IdentifierPattern", name: expression.name, line: expression.line, column: expression.column }
        }
        if (expression.type === "MemberExpression" || expression.type === "IndexExpression") {
            this.rejectOptionalTarget(expression)
            return expression
        }
        const err = new ParseError("Only a name, a member or an index can be assigned to", expression.line.start, expression.column.start)
        if (!this.recover) throw err
        this.record(err)
        return { type: "IdentifierPattern", name: "", line: expression.line, column: expression.column }
    }

    private parseObjectPattern(assign = false): ObjectPattern {
        return this.inBrackets(() => this.parseObjectPatternInner(assign))
    }

    private parseObjectPatternInner(assign: boolean): ObjectPattern {
        const start = this.current()
        this.expectPunctuator("{")
        const properties: ObjectPatternProperty[] = []
        let rest: BindingTarget | undefined

        while (!this.checkPunctuator("}")) {
            if (this.checkOperator("...")) {
                this.advance()
                rest = this.parseBindingTarget(false, assign)
                break
            }

            const propStart = this.current()
            let key: ObjectPatternProperty["key"]
            let computed = false
            let value: BindingTarget
            let shorthand = false

            if (this.matchPunctuator("[")) {
                computed = true
                key = this.parseExpression()
                this.expectPunctuator("]")
                this.expectPunctuator(":")
                value = this.parseBindingTarget(false, assign)
            } else if (this.checkType("Literal") && (this.current() as any).kind === "string") {
                const t = this.advance() as any
                key = { type: "StringLiteral", value: t.value, raw: t.raw, ...spanFrom(t, t) }
                this.expectPunctuator(":")
                value = this.parseBindingTarget(false, assign)
            } else {
                const nameTok = this.expectIdentifier()
                key = { type: "Identifier", name: nameTok.value as string, ...spanFrom(nameTok, nameTok) }
                if (this.matchPunctuator(":")) {
                    value = this.parseBindingTarget(false, assign)
                } else {
                    shorthand = true
                    value = { type: "IdentifierPattern", name: nameTok.value as string, ...spanFrom(nameTok, nameTok) }
                }
            }

            let def: Expression | undefined
            if (this.matchOperator("=")) def = this.parseExpression()

            properties.push({
                type: "ObjectPatternProperty",
                key, computed, value, default: def, shorthand,
                ...spanFrom(propStart, this.previous()),
            })

            if (this.matchPunctuator(",")) continue
            break
        }

        this.expectPunctuator("}")
        return { type: "ObjectPattern", properties, rest, ...spanFrom(start, this.previous()) }
    }

    private parseArrayPattern(assign = false): ArrayPattern {
        return this.inBrackets(() => this.parseArrayPatternInner(assign))
    }

    private parseArrayPatternInner(assign: boolean): ArrayPattern {
        const start = this.current()
        this.expectPunctuator("[")
        const elements: (ArrayPatternElement | null)[] = []
        let rest: BindingTarget | undefined

        while (!this.checkPunctuator("]")) {
            if (this.checkOperator("...")) {
                this.advance()
                rest = this.parseBindingTarget(false, assign)
                break
            }
            if (this.checkPunctuator(",")) {
                elements.push(null) // elision hole
                this.advance()
                continue
            }

            const elStart = this.current()
            const value = this.parseBindingTarget(false, assign)
            let def: Expression | undefined
            if (this.matchOperator("=")) def = this.parseExpression()
            elements.push({ type: "ArrayPatternElement", value, default: def, ...spanFrom(elStart, this.previous()) })

            if (this.matchPunctuator(",")) continue
            break
        }

        this.expectPunctuator("]")
        return { type: "ArrayPattern", elements, rest, ...spanFrom(start, this.previous()) }
    }

    private identifierPatternToTypedIdentifier(p: IdentifierPattern): TypedIdentifier {
        return {
            type: "TypedIdentifier",
            name: p.name,
            typeAnnotation: p.typeAnnotation,
            attributes: p.attributes,
            line: p.line, column: p.column,
        }
    }

    /** `T...` written where a type goes: a pack, which tilua does not have. */
    private rejectPackReference(): void {
        if (this.checkType("Identifier") && this.peek(1).type === "Operator" && (this.peek(1) as any).value === "...") {
            this.problemAt(this.peek(1),
                "tilua has no type packs: several values are a tuple, '[A, B]', and a varying number an array, 'T[]'")
            this.advance()
            this.advance()
        }
    }

    /** The part shared by a real function body and an overload signature:
     *  `<generics>(params): ReturnType`, up to (but not including) the block. */
    private parseFunctionHead(): {
        start: Token
        generics: GenericTypeParameter[]
        params: FunctionParameter[]
        hasVarargs: boolean
        returnType?: TypeNode
        predicate?: TypePredicateNode
    } {
        const start = this.current()
        let generics: GenericTypeParameter[] = []
        if (this.checkOperator("<")) {
            generics = this.parseGenericTypeParameterList()
        }

        this.expectPunctuator("(")
        const params: FunctionParameter[] = []
        let hasVarargs = false

        if (!this.checkPunctuator(")")) {
            while (true) {
                // `function f(` and then the body on the lines below: the
                // `)` is what is missing, not more parameters.
                if (this.recover && this.onNewLine() && !this.startsParameter()) break
                if (this.checkOperator("...")) {
                    const dots = this.advance()
                    hasVarargs = true
                    // `...rest: T[]` — JavaScript's rest parameter: everything
                    // from here on, as an array. It is the only way to take a
                    // varying number of arguments.
                    if (this.checkType("Identifier")) {
                        const nameTok = this.expectIdentifier()
                        let typeAnnotation: TypeNode | undefined
                        if (this.matchPunctuator(":")) {
                            typeAnnotation = this.typeOr(() => this.checkPunctuator(")"))
                        }
                        params.push({
                            type: "FunctionParameter",
                            name: nameTok.value as string,
                            typeAnnotation, rest: true,
                            // The name alone, as every binding's span is.
                            ...spanFrom(nameTok, nameTok),
                        })
                        if (this.checkPunctuator(",")) {
                            this.problem("A rest parameter is the last one: nothing can follow '...'")
                        }
                        break
                    }
                    // `...` or `...: T`: reported, and read as the rest
                    // parameter it would be — `...args: T[]`.
                    this.problemAt(dots, NO_DOTS)
                    let typeAnnotation: TypeNode | undefined
                    if (this.matchPunctuator(":")) {
                        this.rejectPackReference()
                        const element = this.parseType()
                        typeAnnotation = { type: "ArrayTypeNode", element, ...spanFrom(element, element) } as TypeNode
                    }
                    params.push({
                        type: "FunctionParameter", name: "args", typeAnnotation, rest: true,
                        ...spanFrom(dots, this.previous()),
                    })
                    break
                }
                const paramStart = this.current()
                let name = ""
                let pattern: ObjectPattern | ArrayPattern | undefined
                if (this.checkPunctuator("{")) {
                    pattern = this.parseObjectPattern()
                } else if (this.checkPunctuator("[")) {
                    pattern = this.parseArrayPattern()
                } else {
                    name = this.expectIdentifier().value as string
                }
                // `name?: T` — the argument may be omitted.
                const optional = this.matchPunctuator("?")
                let typeAnnotation: TypeNode | undefined
                const paramEnd = (): boolean => this.checkPunctuator(",")
                if (this.matchPunctuator(":")) {
                    typeAnnotation = this.typeOr(() => paramEnd() || this.checkOperator("="))
                }
                let def: Expression | undefined
                if (this.matchOperator("=")) {
                    def = this.expressionOr(paramEnd)
                }
                params.push({
                    type: "FunctionParameter",
                    name, pattern, typeAnnotation, default: def,
                    optional: optional || undefined,
                    // A named parameter's span is its name alone, as every
                    // binding's is; a destructured one has only its pattern.
                    ...(pattern ? spanFrom(paramStart, this.previous()) : spanFrom(paramStart, paramStart)),
                })
                // A trailing comma is allowed, as in TypeScript: a parameter
                // list written one per line ends with one.
                if (this.matchPunctuator(",") && !this.checkPunctuator(")")) continue
                break
            }
        }
        this.expectCloser(")")

        let returnType: TypeNode | undefined
        let predicate: TypePredicateNode | undefined
        if (this.matchPunctuator(":")) {
            predicate = this.tryParseTypePredicate()
            if (!predicate) {
                returnType = this.attempt<TypeNode | undefined>(() => this.parseReturnType(), () => false, () => undefined)
            }
        }

        return { start, generics, params, hasVarargs, returnType, predicate }
    }

    /** Could a parameter begin here — a pattern, a rest parameter, or a name
     *  followed by what follows a parameter's name? */
    private startsParameter(): boolean {
        if (this.checkPunctuator("{") || this.checkPunctuator("[") || this.checkOperator("...")) return true
        if (!this.checkType("Identifier")) return false
        const next = this.peek(1)
        const value = (next as { value?: unknown }).value
        return (next.type === "Punctuator" && (value === ":" || value === "," || value === ")" || value === "?")) ||
            (next.type === "Operator" && value === "=")
    }

    /** What a function returns: one type. `T...` is reported as the pack it
     *  is, and the type after it read. */
    private parseReturnType(): TypeNode {
        this.rejectPackReference()
        return this.parseType()
    }

    /** TypeScript-style type-guard return annotations, in return position only:
     *
     *      : v is string          -- narrows `v` in the caller's true branch
     *      : asserts v            -- narrows `v` for the rest of the caller's block
     *      : asserts v is string
     *      : implies v is string  -- the true branch only: false says nothing
     *
     *  `is`, `asserts` and `implies` are *soft* keywords -- they lex as plain identifiers,
     *  so a return type that merely happens to be named `is` still parses. We
     *  only commit when the two-token lookahead can't mean anything else. */
    private tryParseTypePredicate(): TypePredicateNode | undefined {
        const start = this.current()
        const isWord = (t: Token, v: string): boolean =>
            t.type === "Identifier" && (t as { value?: unknown }).value === v

        // `asserts x` / `asserts x is T`
        if (isWord(start, "asserts") && this.peek(1).type === "Identifier") {
            this.advance()
            const parameterName = this.expectIdentifier().value as string
            let typeAnnotation: TypeNode | undefined
            if (isWord(this.current(), "is")) {
                this.advance()
                typeAnnotation = this.parseType()
            }
            return {
                type: "TypePredicateNode", parameterName, asserts: true, typeAnnotation,
                ...spanFrom(start, this.previous()),
            }
        }

        // `implies x is T`
        if (isWord(start, "implies") && this.peek(1).type === "Identifier" && isWord(this.peek(2), "is")) {
            this.advance()
            const parameterName = this.expectIdentifier().value as string
            this.advance() // 'is'
            const typeAnnotation = this.parseType()
            return {
                type: "TypePredicateNode", parameterName, asserts: false, implies: true, typeAnnotation,
                ...spanFrom(start, this.previous()),
            }
        }

        // `x is T`
        if (start.type === "Identifier" && isWord(this.peek(1), "is")) {
            const parameterName = this.expectIdentifier().value as string
            this.advance() // 'is'
            const typeAnnotation = this.parseType()
            return {
                type: "TypePredicateNode", parameterName, asserts: false, typeAnnotation,
                ...spanFrom(start, this.previous()),
            }
        }

        return undefined
    }

    /** Run `parse`, and put the parser back where it was if it fails. Used
     *  where two forms start alike and only their end tells them apart: `(a,
     *  b) => a + b` and `(a + b)` both open with a `(`. */
    private tryParse<T>(parse: () => T): T | undefined {
        const cursor = this.cursor
        const errors = this.errors.length
        try {
            return parse()
        } catch (error) {
            if (!(error instanceof ParseError || error instanceof ParseRecover)) throw error
            this.cursor = cursor
            this.errors.length = errors
            return undefined
        }
    }

    /** `x => x * 2` — a function, written short. The body is an expression,
     *  which is returned, or a block in braces, as in TypeScript. */
    private parseArrow(): FunctionExpression {
        const start = this.current()
        const head = this.checkType("Identifier")
            ? (() => {
                const name = this.expectIdentifier()
                return {
                    start,
                    generics: [] as GenericTypeParameter[],
                    params: [{ type: "FunctionParameter", name: name.value as string, ...spanFrom(name, name) } as FunctionParameter],
                    hasVarargs: false,
                    returnType: undefined as TypeNode | undefined,
                    predicate: undefined as TypePredicateNode | undefined,
                }
            })()
            : this.parseFunctionHead()
        this.expectPunctuator("=>")
        const body = this.checkPunctuator("{")
            ? this.parseBraceBlock()
            : this.parseArrowExpressionBody()
        const func: FunctionBody = {
            type: "FunctionBody",
            generics: head.generics, params: head.params, hasVarargs: head.hasVarargs,
            returnType: head.returnType,
            predicate: head.predicate, body,
            ...spanFrom(start, this.previous()),
        }
        return { type: "FunctionExpression", func, ...spanFrom(start, this.previous()) }
    }

    /** `() => value` returns the value. `() => a = 1` and `() => n += 1` are
     *  an assignment, which is a statement: the body is that
     *  statement, and the function returns nothing. */
    private parseArrowExpressionBody(): Block {
        const start = this.cursor
        const errors = this.errors.length
        const expression = this.parseExpression(0)
        const t = this.current()
        const assigns = t.type === "Operator" &&
            ((t as any).value === "=" || COMPOUND_ASSIGN_OPS.has((t as any).value))
        if (!assigns) return this.returnOf(expression)
        // Read the target again, as a statement reads one.
        this.cursor = start
        this.errors.length = errors
        const first = this.current()
        const target = this.parsePrefixExpression()
        this.rejectOptionalTarget(target)
        const opToken = this.current()
        const op = (opToken as any).value as CompoundAssignmentStatement["operator"] | "="
        if (opToken.type !== "Operator" || (op !== "=" && !COMPOUND_ASSIGN_OPS.has(op))) this.error("Expected '='")
        this.advance()
        const value = this.expressionOr(() => false)
        const statement: AssignmentStatement | CompoundAssignmentStatement = op === "="
            ? { type: "AssignmentStatement", target, value, ...spanFrom(first, this.previous()) }
            : { type: "CompoundAssignmentStatement", operator: op, target, value, ...spanFrom(first, this.previous()) }
        return { type: "Block", statements: [statement], ...spanFrom(statement, statement) }
    }

    /** A one-expression body: the value is what the function returns. */
    private returnOf(expression: Expression): Block {
        const statement: ReturnStatement = {
            type: "ReturnStatement", argument: expression, ...spanFrom(expression, expression),
        }
        return { type: "Block", statements: [statement], ...spanFrom(expression, expression) }
    }

    private parseFunctionBody(opener: Token): FunctionBody {
        const head = this.parseFunctionHead()
        const body = this.parseStatementBody(opener)
        return {
            type: "FunctionBody",
            generics: head.generics, params: head.params, hasVarargs: head.hasVarargs,
            returnType: head.returnType,
            predicate: head.predicate, body,
            ...spanFrom(head.start, this.previous()),
        }
    }

    private headToSignature(head: ReturnType<Parser["parseFunctionHead"]>): FunctionSignature {
        return {
            type: "FunctionSignature",
            generics: head.generics, params: head.params, hasVarargs: head.hasVarargs,
            returnType: head.returnType,
            predicate: head.predicate,
            ...spanFrom(head.start, this.previous()),
        }
    }

    /** A function's statements. */
    private parseStatementBody(opener: Token): Block {
        if (this.recover && this.bodyWithoutBrace(opener)) return this.parseIndentedBody(opener)
        return this.parseBracedBody("function")
    }

    /** Recovery: is the `{` of `opener`'s body missing, with the body itself
     *  written on the lines below, indented deeper than `opener`? */
    private bodyWithoutBrace(opener: Token): boolean {
        if (this.checkPunctuator("{") || !this.onNewLine()) return false
        if (this.current().column.start <= this.indentOf(opener)) return false
        const t = this.current()
        return t.type === "Identifier" || (t.type === "Keyword" && STATEMENT_KEYWORDS.has(String((t as { value?: unknown }).value))) ||
            this.checkKeyword("if") || this.checkKeyword("function")
    }

    /** The statements of a body without its `{`, read for as long as they are
     *  indented deeper than `opener`; a `}` under `opener` is its own. */
    private parseIndentedBody(opener: Token): Block {
        this.softError("Expected '{' to open the body of 'function'")
        const indentation = this.indentation
        this.indentation = true
        try {
            const body = this.parseBlock(opener)
            if (this.checkPunctuator("}") && this.current().column.start === this.indentOf(opener)) this.advance()
            return body
        } finally {
            this.indentation = indentation
        }
    }

    private headToBody(head: ReturnType<Parser["parseFunctionHead"]>, opener: Token): FunctionBody {
        const body = this.parseStatementBody(opener)
        return {
            type: "FunctionBody",
            generics: head.generics, params: head.params, hasVarargs: head.hasVarargs,
            returnType: head.returnType,
            predicate: head.predicate, body,
            ...spanFrom(head.start, this.previous()),
        }
    }

    // ============================================================
    // Types
    // ============================================================

    parseType(): TypeNode {
        return this.parseConditionalType()
    }

    /** `C extends E ? A : B`. `?` in type position always means this — tilua
     *  has no `T?` shorthand — so the grammar needs no lookahead beyond the
     *  `extends`, which stays a soft keyword. */
    private parseConditionalType(): TypeNode {
        const start = this.current()
        const checkType = this.parseUnionType()
        if (!this.checkIdentifierValue("extends")) return checkType
        this.advance()
        const extendsType = this.parseUnionType()
        this.expectPunctuator("?")
        const trueType = this.parseConditionalType()
        this.expectPunctuator(":")
        const falseType = this.parseConditionalType()
        return {
            type: "ConditionalTypeNode",
            checkType, extendsType, trueType, falseType,
            ...spanFrom(start, this.previous()),
        }
    }

    private parseUnionType(): TypeNode {
        const start = this.current()
        this.matchPunctuator("|")
        let left = this.parseDifferenceType()
        if (this.checkPunctuator("|")) {
            const types = [left]
            while (this.matchPunctuator("|")) {
                types.push(this.parseDifferenceType())
            }
            return { type: "UnionTypeNode", types, ...spanFrom(start, this.previous()) }
        }
        return left
    }

    /** tilua once wrote set difference `A - B`; it is `Exclude<A, B>` now,
     *  one spelling for one thing. Writing `-` is reported, and in recovery
     *  read as the `Exclude` it meant. */
    private parseDifferenceType(): TypeNode {
        let left = this.parseIntersectionType()
        while (this.checkOperator("-")) {
            this.problem("A type has no '-': write 'Exclude<A, B>' for what of 'A' is not a 'B'")
            this.advance()
            const excluded = this.parseIntersectionType()
            left = {
                type: "TypeReference", base: "Exclude", typeArguments: [left, excluded],
                ...spanFrom(left, excluded),
            } as TypeReference
        }
        return left
    }

    private parseIntersectionType(): TypeNode {
        const start = this.current()
        this.matchPunctuator("&")
        let left = this.parseSuffixType()
        if (this.checkPunctuator("&")) {
            const types = [left]
            while (this.matchPunctuator("&")) {
                types.push(this.parseSuffixType())
            }
            return { type: "IntersectionTypeNode", types, ...spanFrom(start, this.previous()) }
        }
        return left
    }

    /** Postfix type suffixes. There is deliberately **no `T?` shorthand**:
     *  `?` in type position always belongs to a conditional type
     *  (`C extends E ? A : B`). Write `T | nil` for a nilable type, and
     *  `name?: T` for an optional property or parameter. */
    private parseSuffixType(): TypeNode {
        if (this.checkIdentifierValue("readonly")) {
            const start = this.current()
            this.advance()
            const t = this.parseSuffixType()
            // A list is the one thing `readonly` says something about here:
            // a property says it where the property is written.
            if (t.type === "ArrayTypeNode" || t.type === "TupleTypeNode") return { ...t, isReadonly: true }
            this.problemAt(start, "'readonly' belongs on an array or a tuple: a property is marked where it is written")
            return t
        }

        let t = this.parsePrimaryType()
        while (true) {
            if (this.checkPunctuator("[")) {
                if (this.peek(1).type === "Punctuator" && (this.peek(1) as any).value === "]") {
                    this.advance()
                    this.advance()
                    t = { type: "ArrayTypeNode", element: t, ...spanFrom(t, this.previous()) }
                    continue
                }
                this.advance()
                const indexType = this.parseType()
                this.expectPunctuator("]")
                t = { type: "IndexedAccessTypeNode", objectType: t, indexType, ...spanFrom(t, this.previous()) }
                continue
            }
            break
        }
        return t
    }

    private parsePrimaryType(): TypeNode {
        const t = this.current()

        // `` `on${string}` `` — the lexer already split the backtick string
        // into literal chunks and raw interpolation sources; each of those
        // sources is re-parsed here as a *type* rather than an expression.
        if (t.type === "InterpolatedString") {
            this.advance()
            const quasis: string[] = []
            const types: TypeNode[] = []
            let pending = ""
            for (const part of (t as unknown as { parts: { kind: string; value?: string; raw: string; line: number; column: number }[] }).parts) {
                if (part.kind === "string") {
                    pending += part.value ?? ""
                } else {
                    quasis.push(pending)
                    pending = ""
                    // Placed where it is written, as an expression's is.
                    types.push(shiftSpans(parseTypeFromSource(part.raw), part.line, part.column))
                }
            }
            quasis.push(pending)
            return { type: "TemplateLiteralTypeNode", quasis, types, ...spanFrom(t, this.previous()) }
        }

        // `new (x: T) => R`: a type whose `new` makes an `R` — a class
        // table's shape. tilua builds with `Name.new(x)`, so this is
        // `{ new: (x: T) => R }`, written the way TypeScript writes it.
        if (this.checkIdentifierValue("new") && (this.punctuatorAt(1, "(") || (this.peek(1).type === "Operator" && (this.peek(1) as { value?: unknown }).value === "<"))) {
            const newTok = this.advance()
            const generics = this.checkOperator("<") ? this.parseGenericTypeParameterList() : []
            const parenStart = this.current()
            this.expectPunctuator("(")
            const made = this.parseFunctionTypeAfterParen(parenStart, generics)
            if (made.type !== "FunctionTypeNode") this.error("Expected '=>' after the parameters of a constructor type")
            return {
                type: "TableTypeNode",
                properties: [{
                    type: "TableTypeProperty", name: "new", key: tokenIdentifier(newTok), valueType: made,
                    optional: false, readonly: true, ...spanFrom(newTok, this.previous()),
                }],
                ...spanFrom(newTok, this.previous()),
            } as TableTypeNode
        }

        // `keyof T` / `infer U` — soft-keyword prefixes. Both require a type to
        // follow, so an ordinary type actually named `keyof` still parses.
        // `keyof` takes the type with its suffixes, as TypeScript reads it:
        // `keyof string[]` is the keys of a list, `(keyof T)[]` a list of keys.
        if (this.checkIdentifierValue("keyof") && this.startsType(this.peek(1))) {
            this.advance()
            const target = this.parseSuffixType()
            return { type: "KeyofTypeNode", target, ...spanFrom(t, this.previous()) }
        }
        if (this.checkIdentifierValue("infer") && this.peek(1).type === "Identifier") {
            this.advance()
            const nameTok = this.expectIdentifier()
            const name = nameTok.value as string
            // `infer N extends number` — unless the `extends` opens a
            // conditional of its own (`infer U extends string ? A : B`),
            // which only the `?` after it tells.
            let constraint: TypeNode | undefined
            if (this.checkIdentifierValue("extends")) {
                const cursor = this.cursor
                const errors = this.errors.length
                const read = this.tryParse(() => {
                    this.advance()
                    return this.parseUnionType()
                })
                if (read && !this.checkPunctuator("?")) {
                    constraint = read
                } else {
                    this.cursor = cursor
                    this.errors.length = errors
                }
            }
            return {
                type: "InferTypeNode", name, id: tokenIdentifier(nameTok),
                ...(constraint ? { constraint } : {}),
                ...spanFrom(t, this.previous()),
            }
        }

        if (t.type === "Operator" && (t as any).value === "<") {
            const generics = this.parseGenericTypeParameterList()
            this.expectPunctuator("(")
            return this.parseFunctionTypeAfterParen(t, generics)
        }

        if (t.type === "Punctuator" && (t as any).value === "(") {
            this.advance()
            return this.parseFunctionTypeAfterParen(t, [])
        }

        if (t.type === "Operator" && (t as any).value === "...") {
            // Reported, and read as the array it would be.
            this.problem("'...' in a type goes before a rest parameter, '...args: T[]', or inside a tuple, '[A, ...B]'")
            this.advance()
            const element = this.parseType()
            return { type: "ArrayTypeNode", element, ...spanFrom(t, this.previous()) } as TypeNode
        }

        if (t.type === "Punctuator" && (t as any).value === "{") {
            return this.parseTableType()
        }

        // `[number, string]` — tuple type; `[string, ...number[]]` ends in a
        // rest of as many as there are. A spread may stand anywhere —
        // `[...T, U]`, `[infer H, ...infer R]` — and an element may be named,
        // `[x: number, y?: number]`, as in TypeScript.
        if (t.type === "Punctuator" && (t as any).value === "[") {
            this.advance()
            const elements: TypeNode[] = []
            const labels: (string | undefined)[] = []
            const optionals: boolean[] = []
            let labelled = false
            while (!this.checkPunctuator("]")) {
                if (this.checkOperator("...")) {
                    const dots = this.advance()
                    // `...rest: T[]` — a named spread.
                    if (this.checkType("Identifier") && this.punctuatorAt(1, ":")) {
                        labels.push(this.expectIdentifier().value as string)
                        labelled = true
                        this.advance()
                    } else {
                        labels.push(undefined)
                    }
                    const spread = this.parseType()
                    elements.push({ type: "RestTypeNode", typeAnnotation: spread, ...spanFrom(dots, this.previous()) } as RestTypeNode)
                    optionals.push(false)
                } else {
                    let label: string | undefined
                    let optional = false
                    if (this.checkType("Identifier") && (this.punctuatorAt(1, ":") ||
                        (this.punctuatorAt(1, "?") && this.punctuatorAt(2, ":")))) {
                        label = this.expectIdentifier().value as string
                        labelled = true
                        optional = this.matchPunctuator("?")
                        this.advance()
                    }
                    const start = this.current()
                    let element = this.parseType()
                    // `[A, B?]` — an element that may be left out; read as one
                    // that may be nil, which in Lua is the same thing.
                    if (!label && this.checkPunctuator("?")) { this.advance(); optional = true }
                    if (optional) {
                        element = {
                            type: "UnionTypeNode",
                            types: [element, { type: "TypeReference", base: "nil", typeArguments: [], ...spanFrom(start, start) } as TypeReference],
                            ...spanFrom(start, this.previous()),
                        }
                    }
                    elements.push(element)
                    labels.push(label)
                    optionals.push(optional)
                }
                if (this.matchPunctuator(",")) continue
                break
            }
            this.expectPunctuator("]")
            // A spread of an array at the very end is the tuple's rest, as it
            // always was.
            let rest: TypeNode | undefined
            const last = elements[elements.length - 1]
            if (last?.type === "RestTypeNode" && last.typeAnnotation.type === "ArrayTypeNode") {
                rest = last.typeAnnotation
                elements.pop()
                labels.pop()
                optionals.pop()
            }
            // An element that has to be there cannot follow one that may be
            // left out, as in TypeScript.
            const firstOptional = optionals.indexOf(true)
            if (firstOptional >= 0 && optionals.slice(firstOptional).some(o => !o)) {
                this.problemAt(t, "A required element cannot follow an optional one")
            }
            return {
                type: "TupleTypeNode", elements,
                ...(rest ? { rest } : {}),
                ...(labelled ? { labels } : {}),
                ...(firstOptional >= 0 ? { optional: optionals } : {}),
                ...spanFrom(t, this.previous()),
            } as TupleTypeNode
        }

        // `typeof(x)` is Luau's spelling, and tilua has no such function, in a
        // type or out of one. In recovery it is read as the query it was
        // meant to be, so the rest of the file still analyses.
        if (t.type === "Identifier" && (t as any).value === "typeof" && this.peek(1).type === "Punctuator" && (this.peek(1) as any).value === "(") {
            this.problemAt(this.peek(1), NO_TYPEOF_CALL)
            this.advance()
            this.advance()
            const expression = this.parseExpression()
            this.expectPunctuator(")")
            return { type: "TypeofTypeNode", expression, ...spanFrom(t, this.previous()) } as TypeofTypeNode
        }

        // `typeof x` / `typeof x.y.z` — TypeScript's type query: the type of a
        // value, without parentheses. Only a name path is allowed, as in
        // TypeScript.
        if (t.type === "Identifier" && (t as any).value === "typeof" && this.peek(1).type === "Identifier") {
            this.advance()
            let expression: Expression = this.parseIdentifier()
            while (this.checkPunctuator(".") && this.peek(1).type === "Identifier") {
                this.advance()
                const property = this.parseIdentifier()
                expression = { type: "MemberExpression", object: expression, property, ...spanFrom(expression, property) }
            }
            return { type: "TypeofTypeNode", expression, ...spanFrom(t, this.previous()) } as TypeofTypeNode
        }

        if (t.type === "Literal" && (t as any).kind === "string") {
            this.advance()
            return { type: "TypeLiteralString", value: (t as any).value, ...spanFrom(t, t) } as TypeLiteralString
        }

        if (t.type === "Literal" && (t as any).kind === "boolean") {
            this.advance()
            return { type: "TypeLiteralBoolean", value: (t as any).value, ...spanFrom(t, t) } as TypeLiteralBoolean
        }

        if (t.type === "Literal" && (t as any).kind === "number") {
            this.advance()
            return { type: "TypeLiteralNumber", value: (t as any).value, ...spanFrom(t, t) } as TypeLiteralNumber
        }

        if (t.type === "Literal" && (t as any).kind === "nil") {
            this.advance()
            return { type: "TypeReference", base: "nil", typeArguments: [], ...spanFrom(t, t) } as TypeReference
        }

        if (t.type === "Identifier") {
            this.advance()
            let namespace: string | undefined
            let base = (t as any).value as string
            if (this.matchPunctuator(".")) {
                namespace = base
                base = this.expectIdentifier().value as string
            }
            const typeArguments: TypeNode[] = []
            if (this.checkOperator("<")) {
                this.advance()
                if (!this.checkOperator(">")) {
                    typeArguments.push(this.parseType())
                    while (this.matchPunctuator(",") && !this.checkOperator(">")) {
                        typeArguments.push(this.parseType())
                    }
                }
                this.expectOperator(">")
            }
            return { type: "TypeReference", base, namespace, typeArguments, ...spanFrom(t, this.previous()) } as TypeReference
        }

        this.error("Unexpected token in type annotation")
    }

    /** `(x: number): string` after a member's name, in an object type — a
     *  signature, which says what it returns after a `:` rather than `=>`.
     *  The cursor is at the `(` (or at the `<` of its type parameters). */
    private parseSignatureType(start: Token): FunctionTypeNode {
        const generics = this.checkOperator("<") ? this.parseGenericTypeParameterList() : []
        this.expectPunctuator("(")
        const { params } = this.parseFunctionTypeParams()
        let returnType: TypeNode
        let predicate: TypePredicateNode | undefined
        if (this.matchPunctuator(":")) {
            predicate = this.tryParseTypePredicate()
            returnType = predicate
                ? { type: "TypeReference", base: "boolean", typeArguments: [], ...spanFrom(start, this.previous()) } as TypeReference
                : this.parseReturnType()
        } else {
            // TypeScript reads a signature with no return type as `any`;
            // tilua says what it returns, so it is `nil` — it returns nothing.
            returnType = { type: "TypeReference", base: "nil", typeArguments: [], ...spanFrom(this.previous(), this.previous()) } as TypeReference
        }
        return { type: "FunctionTypeNode", generics, params, returnType, predicate, ...spanFrom(start, this.previous()) }
    }

    /** The parameters of a function type, from after its `(` to past its `)`. */
    private parseFunctionTypeParams(): { params: FunctionTypeParameter[]; rested: boolean } {
        const params: FunctionTypeParameter[] = []
        let rested = false
        if (!this.checkPunctuator(")")) {
            while (true) {
                if (this.checkOperator("...")) {
                    const dots = this.advance()
                    rested = true
                    // `(...rest: T[]) => R` — the only way a function type
                    // takes a varying number of arguments.
                    if (this.checkType("Identifier") && this.punctuatorAt(1, ":")) {
                        const nameTok = this.expectIdentifier()
                        this.advance() // ':'
                        params.push({
                            type: "FunctionTypeParameter",
                            name: nameTok.value as string,
                            id: tokenIdentifier(nameTok),
                            typeAnnotation: this.parseType(),
                            rest: true,
                            ...spanFrom(dots, this.previous()),
                        })
                        break
                    }
                    // `(...T)`: reported, and read as `(...args: T[])`.
                    this.problemAt(dots, "A function type takes the rest of its arguments as an array: '(...args: T[]) => R'")
                    this.rejectPackReference()
                    const element = this.parseType()
                    params.push({
                        type: "FunctionTypeParameter", name: "args", rest: true,
                        typeAnnotation: { type: "ArrayTypeNode", element, ...spanFrom(element, element) } as TypeNode,
                        ...spanFrom(dots, this.previous()),
                    })
                    break
                }

                if (this.checkType("Identifier") && this.peek(1).type === "Operator" && (this.peek(1) as any).value === "...") {
                    this.rejectPackReference()
                    continue
                }

                let name: string | undefined
                let optional = false
                const named = this.checkType("Identifier") && this.peek(1).type === "Punctuator" &&
                    ((this.peek(1) as any).value === ":" ||
                     ((this.peek(1) as any).value === "?" && this.peek(2).type === "Punctuator" &&
                      (this.peek(2) as any).value === ":"))
                let nameTok: Token | undefined
                if (named) {
                    const tok = this.expectIdentifier()
                    nameTok = tok
                    name = tok.value as string
                    optional = this.matchPunctuator("?")
                    this.advance() // ':'
                }
                const paramStart = nameTok ?? this.current()
                const typeAnnotation = this.parseType()
                params.push({
                    type: "FunctionTypeParameter",
                    name, typeAnnotation,
                    id: nameTok && tokenIdentifier(nameTok),
                    optional: optional || undefined,
                    ...spanFrom(paramStart, this.previous()),
                })
                if (this.matchPunctuator(",") && !this.checkPunctuator(")")) continue
                break
            }
        }
        this.expectPunctuator(")")
        return { params, rested }
    }

    private parseFunctionTypeAfterParen(start: Token, generics: GenericTypeParameter[]): TypeNode {
        const { params, rested } = this.parseFunctionTypeParams()

        // `->` is Luau's arrow, and reading both spellings only invited the
        // question of whether they differ. They never did: one arrow, for the
        // type and for the function. It is still lexed, so writing it gets an
        // answer rather than a puzzle — and in recovery it is read as the
        // arrow it was meant to be, so the rest of the file still analyses.
        if (this.matchPunctuator("=>") || this.mistypedArrow()) {
            const predicate = this.tryParseTypePredicate()
            const returnType: TypeNode = predicate
                ? { type: "TypeReference", base: "boolean", typeArguments: [], ...spanFrom(start, this.previous()) }
                : this.parseReturnType()
            return {
                type: "FunctionTypeNode",
                generics, params, returnType, predicate,
                ...spanFrom(start, this.previous()),
            } as FunctionTypeNode
        }

        if (params.length === 1 && !params[0].name && !rested) {
            return {
                type: "ParenthesizedTypeNode",
                typeAnnotation: params[0].typeAnnotation,
                ...spanFrom(start, this.previous()),
            } as ParenthesizedTypeNode
        }

        if (params.some(p => p.name !== undefined)) {
            this.error("Expected '=>' for function type")
        }

        // `()` and `(A, B)` are packs, which tilua does not have: nothing is
        // `nil`, and several values are a tuple. Reported, and read as that.
        if (!params.length) {
            this.problemAt(start, "'()' is not a type: a function that returns nothing returns 'nil'")
            return { type: "TypeReference", base: "nil", typeArguments: [], ...spanFrom(start, this.previous()) } as TypeReference
        }
        this.problemAt(start, "Several types in parentheses are a pack, which tilua does not have: write a tuple, '[A, B]'")
        return {
            type: "TupleTypeNode",
            elements: params.map(p => p.typeAnnotation),
            ...spanFrom(start, this.previous()),
        } as TupleTypeNode
    }

    /** Could this token begin a type? Used to keep `keyof` a soft keyword. */
    private startsType(t: Token): boolean {
        if (t.type === "Identifier" || t.type === "Literal") return true
        if (t.type === "Keyword") return ["nil", "true", "false", "function"].includes(String((t as { value?: unknown }).value))
        if (t.type === "Punctuator") return ["{", "[", "("].includes(String((t as { value?: unknown }).value))
        return false
    }

    /** `{ [K in C]: V }`, with the optional `as` remap and `?` / `readonly`
     *  modifiers (`-?` / `-readonly` strip them). Recognised by the `in` that
     *  follows the bound name — an ordinary `[K]: V` indexer has none. */
    private parseMappedType(start: Token): MappedTypeNode {
        let readonly: boolean | undefined
        if (this.checkIdentifierValue("readonly")) {
            this.advance()
            readonly = true
        } else if (this.checkOperator("-") && this.peek(1).type === "Identifier" &&
            (this.peek(1) as { value?: unknown }).value === "readonly") {
            this.advance()
            this.advance()
            readonly = false
        }

        this.expectPunctuator("[")
        const parameterTok = this.expectIdentifier()
        const parameter = parameterTok.value as string
        this.advance() // 'in'
        const constraint = this.parseType()
        let nameType: TypeNode | undefined
        if (this.checkWord("as")) {
            this.advance()
            nameType = this.parseType()
        }
        this.expectPunctuator("]")

        let optional: boolean | undefined
        if (this.matchPunctuator("?")) optional = true
        else if (this.checkOperator("-") && this.peek(1).type === "Punctuator" &&
            (this.peek(1) as { value?: unknown }).value === "?") {
            this.advance()
            this.advance()
            optional = false
        }

        this.expectPunctuator(":")
        const template = this.parseType()
        this.matchPunctuator(",")
        this.matchPunctuator(";")
        this.expectPunctuator("}")
        return {
            type: "MappedTypeNode",
            parameter, parameterId: tokenIdentifier(parameterTok), constraint, nameType, template, optional, readonly,
            ...spanFrom(start, this.previous()),
        }
    }

    /** Does `{` open a mapped type rather than an object type? Looks for
     *  `[ Ident in`, optionally behind a `readonly` / `-readonly` modifier. */
    private looksLikeMappedType(): boolean {
        let i = 1
        const val = (n: number): string => String((this.peek(n) as { value?: unknown }).value)
        if (this.peek(i).type === "Identifier" && val(i) === "readonly") i += 1
        else if (this.peek(i).type === "Operator" && val(i) === "-" &&
            this.peek(i + 1).type === "Identifier" && val(i + 1) === "readonly") i += 2
        return this.peek(i).type === "Punctuator" && val(i) === "[" &&
            this.peek(i + 1).type === "Identifier" &&
            this.peek(i + 2).type === "Keyword" && val(i + 2) === "in"
    }

    private parseTableType(): TableTypeNode | MappedTypeNode {
        const start = this.current()
        if (this.looksLikeMappedType()) {
            this.expectPunctuator("{")
            return this.parseMappedType(start)
        }
        this.expectPunctuator("{")
        const body = this.parseTypeMembers(start)
        this.expectCloser("}")
        return { ...body, ...spanFrom(start, this.previous()) }
    }

    /** The members of an object type or an interface, up to its `}`: each
     *  separated from the next by `,`, `;` or a line break, as TypeScript
     *  separates them.
     *
     *      name: T                 name?: T          readonly name: T
     *      "Not An Identifier": T  [K]: V
     *      name(x: T): R           name?<U>(x: U): R           -- a method
     *      get name(): T           set name(value: T)          -- an accessor
     *      (x: T): R                                           -- a call
     *      new (x: T): R                                       -- what `new` makes
     */
    private parseTypeMembers(start: Token): TableTypeNode {
        const properties: TableTypeProperty[] = []
        const callSignatures: FunctionTypeNode[] = []
        /** Accessors already read, by name, so a `get` and a `set` of one
         *  name are one property. */
        const accessors = new Map<string, Extract<TableTypeProperty, { type: "TableTypeProperty" }>>()

        /** A member's name: an identifier, or a string for one that is not. */
        const atKey = (offset = 0): boolean => {
            const t = this.peek(offset)
            return t.type === "Identifier" || (t.type === "Literal" && (t as { kind?: unknown }).kind === "string")
        }
        const keyAt = (offset: number, what: string): boolean =>
            this.punctuatorAt(offset, what) || (what === "<" && this.peek(offset).type === "Operator" && (this.peek(offset) as { value?: unknown }).value === "<")
        const takeKey = (): { name: string; key: Identifier } => {
            const tok = this.advance() as Token & { value?: unknown }
            return { name: String(tok.value), key: tokenIdentifier(tok) }
        }

        /** One member. In recovery, one that cannot be read is skipped up to
         *  the next, and the rest of the type is kept. */
        const member = (): void => {
            const propStart = this.current()
            if (this.checkPunctuator("[")) {
                this.advance()
                // `[key: string]: V`, TypeScript's spelling: the name says
                // nothing, the type after it is the key.
                if (this.checkType("Identifier") && this.punctuatorAt(1, ":")) {
                    this.advance()
                    this.advance()
                }
                const keyType = this.parseType()
                this.expectPunctuator("]")
                this.expectPunctuator(":")
                const valueType = this.parseType()
                properties.push({ type: "TableTypeIndexer", keyType, valueType, ...spanFrom(propStart, this.previous()) })
            } else if (this.checkPunctuator("(") || this.checkOperator("<")) {
                // `(x: T): R` — calling the value.
                callSignatures.push(this.parseSignatureType(propStart))
            } else if (this.checkIdentifierValue("new") && (keyAt(1, "(") || keyAt(1, "<"))) {
                // `new (x: T): R` — what the type's `new` makes. A class table
                // is built with `Name.new(...)`, called with `.`: no receiver.
                const { name, key } = takeKey()
                const valueType = this.parseSignatureType(propStart)
                properties.push({
                    type: "TableTypeProperty", name, key, valueType, optional: false, readonly: true,
                    ...spanFrom(propStart, this.previous()),
                })
            } else if ((this.checkIdentifierValue("get") || this.checkIdentifierValue("set")) && atKey(1) && keyAt(2, "(")) {
                // `get name(): T` / `set name(value: T)`: what the property
                // holds, read-only when there is no setter.
                const kind = (this.advance() as Token & { value: "get" | "set" }).value
                const { name, key } = takeKey()
                const signature = this.parseSignatureType(propStart)
                const held = kind === "get" ? signature.returnType : signature.params[0]?.typeAnnotation
                if (kind === "set" && signature.params.length !== 1) this.problemAt(propStart, "A 'set' accessor takes exactly one parameter")
                if (kind === "get" && signature.params.length) this.problemAt(propStart, "A 'get' accessor takes no parameters")
                const valueType: TypeNode = held ?? { type: "TypeReference", base: "unknown", typeArguments: [], ...spanFrom(propStart, propStart) } as TypeReference
                const earlier = accessors.get(name)
                if (earlier && earlier.accessor !== "both" && earlier.accessor !== kind) {
                    earlier.accessor = "both"
                    earlier.readonly = undefined
                    // The getter says what is read.
                    if (kind === "get") earlier.valueType = valueType
                } else {
                    if (earlier) this.problemAt(propStart, `Duplicate '${kind}' accessor '${name}'`)
                    const property: Extract<TableTypeProperty, { type: "TableTypeProperty" }> = {
                        type: "TableTypeProperty", name, key, valueType, optional: false,
                        readonly: kind === "get" ? true : undefined, accessor: kind,
                        ...spanFrom(propStart, this.previous()),
                    }
                    accessors.set(name, property)
                    properties.push(property)
                }
            } else {
                // `readonly name: T` — the property may not be assigned to.
                // Still a soft keyword: a property actually named `readonly`
                // is followed by `:`, `?` or `(`, not by a name.
                const readonly = this.checkIdentifierValue("readonly") && atKey(1) || undefined
                if (readonly) this.advance()
                if (!atKey()) {
                    this.error("Expected object type property ('name: T', '\"name\": T', 'name(x: T): R' or '[K]: V'); use 'T[]' for arrays and '[T, U]' for tuples")
                }
                const afterName = this.punctuatorAt(1, "?") ? 2 : 1
                if (keyAt(afterName, "(") || keyAt(afterName, "<")) {
                    // `name(x: T): R` — a method: called with `:`, it is
                    // handed its receiver first, as a class's methods are.
                    const { name, key } = takeKey()
                    const optional = this.matchPunctuator("?")
                    const signature = this.parseSignatureType(propStart)
                    const self: FunctionTypeParameter = {
                        type: "FunctionTypeParameter", name: "self",
                        typeAnnotation: { type: "TypeReference", base: "this", typeArguments: [], ...spanFrom(key, key) } as TypeReference,
                        ...spanFrom(key, key),
                    }
                    signature.params.unshift(self)
                    properties.push({
                        type: "TableTypeProperty", name, key, valueType: signature, optional, readonly, method: true,
                        ...spanFrom(propStart, this.previous()),
                    })
                } else if (this.punctuatorAt(afterName, ":")) {
                    // tilua uses TS-style `name?: T` for an optional property
                    // (it may be absent). A required property whose value may
                    // be nil is written `name: T | nil`.
                    const { name, key } = takeKey()
                    const optional = this.matchPunctuator("?")
                    this.expectPunctuator(":")
                    const valueType = this.parseType()
                    properties.push({
                        type: "TableTypeProperty", name, key, valueType, optional, readonly,
                        ...spanFrom(propStart, this.previous()),
                    })
                } else {
                    this.error("Expected object type property ('name: T', '\"name\": T', 'name(x: T): R' or '[K]: V'); use 'T[]' for arrays and '[T, U]' for tuples")
                }
            }
        }
        const nextMember = (): boolean =>
            this.checkPunctuator(",") || this.checkPunctuator(";") || (this.onNewLine() && atKey())

        while (!this.checkPunctuator("}") && !this.isAtEnd()) {
            const at = this.cursor
            this.attempt(member, nextMember, () => undefined)
            // A member that is only a name, with the next one on the line
            // after it, stops its own skip before it is passed.
            if (this.cursor === at && !this.checkPunctuator(",") && !this.checkPunctuator(";")) this.advance()
            if (this.matchPunctuator(",") || this.matchPunctuator(";")) continue
            // A member on a line of its own needs nothing between it and the
            // one before, as in TypeScript.
            if (!this.checkPunctuator("}") && this.current().line.start > this.previous().line.end) continue
            break
        }

        return {
            type: "TableTypeNode", properties,
            ...(callSignatures.length ? { callSignatures } : {}),
            ...spanFrom(start, this.previous()),
        }
    }

    private parseGenericTypeParameterList(allowVariance = false): GenericTypeParameter[] {
        const list: GenericTypeParameter[] = []
        this.expectOperator("<")
        while (true) {
            // `<const T>` — a hard keyword here, and unambiguous: a type
            // parameter cannot itself be named `const`.
            const isConst = this.matchKeyword("const")
            // `<in T>`, `<out T>`, `<in out T>`: soft words, a modifier only
            // when a name follows (`<out>` is a parameter called `out`).
            let variance: "in" | "out" | "in out" | undefined
            const varianceStart = this.current()
            if (this.checkKeyword("in")) {
                this.advance()
                variance = "in"
            }
            if (this.checkIdentifierValue("out") && this.peek(1).type === "Identifier") {
                this.advance()
                variance = variance ? "in out" : "out"
            }
            // A function's or a class's parameter is read off what it is
            // given, not compared by: only a type's says how it compares.
            if (variance && !allowVariance) {
                this.problemAt(varianceStart, "'in' and 'out' can only be written on the type parameters of a type alias or an interface")
                variance = undefined
            }
            const nameTok = this.expectIdentifier()
            // `T...`: a pack parameter. The arguments it stood for are a
            // tuple type now — `<T extends unknown[]>`, taken by `...args: T`.
            const dots = this.checkOperator("...") ? this.advance() : undefined
            if (dots) {
                this.problemAt(dots, "tilua has no pack parameters: write '<T extends unknown[]>', and take it as '...args: T'")
            }
            let constraint: TypeNode | undefined
            if (this.checkIdentifierValue("extends")) {
                this.advance()
                constraint = this.parseType()
            }
            let def: TypeNode | undefined
            if (this.matchOperator("=")) {
                this.rejectPackReference()
                def = this.parseType()
            }
            list.push({
                type: "GenericTypeParameter",
                name: nameTok.value as string,
                id: tokenIdentifier(nameTok),
                isConst: isConst || undefined,
                constraint,
                default: def,
                ...(variance ? { variance } : {}),
                ...spanFrom(nameTok, this.previous()),
            })
            if (this.matchPunctuator(",") && !this.checkOperator(">")) continue
            break
        }
        this.expectOperator(">")
        return list
    }
}

// ============================================================
// Public API
// ============================================================

export function parse(source: string): Program {
    const tokens = tokenize(source)
    const parser = new Parser(tokens)
    return parser.parseProgram()
}

export function parseTokens(tokens: Token[]): Program {
    const parser = new Parser(tokens)
    return parser.parseProgram()
}

/** Parse a standalone *type* from source — used for the interpolated slots of
 *  a template literal type, whose raw text the lexer hands over unparsed. */
export function parseTypeFromSource(raw: string): TypeNode {
    const parser = new Parser(tokenize(raw))
    return (parser as unknown as { parseType(): TypeNode }).parseType()
}

/** `inClass` carries the enclosing class in. A template's `${...}` is parsed
 *  on its own, so without it a `super` written inside one in a class method
 *  would read as an ordinary name. */
export function parseExpressionFromSource(raw: string, inClass = false): Expression {
    const tokens = tokenize(raw)
    const parser = new Parser(tokens)
    if (inClass) (parser as unknown as { classDepth: number }).classDepth = 1
    const expr = (parser as any).parseExpression() as Expression
    return expr
}

export interface RecoverResult {
    program: Program
    errors: ParseError[]
    /** The file's `--@tilua-...` comments; see `applyDirectives`. */
    directives: Directives
}

/**
 * Recovery: close, by indentation, the brackets that were never closed.
 *
 * A line indented no deeper than the line a `(`, `[` or `{` was opened on is
 * past that bracket — unless it begins with the bracket's own closer, as a
 * `})` or `} else {` does. Before such a line, the closers that are missing
 * are put in, each recorded as an error, and what follows reads as the
 * statement it is rather than as one more argument, element or field.
 */
function closeByIndentation(tokens: Token[]): { tokens: Token[]; errors: ParseError[] } {
    const indent = new Map<number, number>()
    for (const t of tokens) if (!indent.has(t.line.start)) indent.set(t.line.start, t.column.start)
    const closerOf: Record<string, string> = { "(": ")", "[": "]", "{": "}" }
    const open: Token[] = []
    const out: Token[] = []
    const errors: ParseError[] = []
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i]
        const value = (t as { value?: unknown }).value
        const before = tokens[i - 1]
        if (before && t.type !== "EOF" && t.line.start > before.line.end) {
            let missing = ""
            let outermost: Token | undefined
            // No statement is in a `(` or `[` but in a function's body.
            const statement = beginsStatement(tokens, i)
            while (open.length) {
                const opener = open[open.length - 1]
                const closer = closerOf[String((opener as { value?: unknown }).value)]
                const inside = statement && closer !== "}"
                if (!inside && t.column.start > indent.get(opener.line.start)!) break
                if (t.type === "Punctuator" && value === closer) break
                // Where the open bracket's last line ends, so that what it
                // spans does not reach into the line after it.
                out.push({
                    type: "Punctuator", value: closer,
                    line: { start: before.line.end, end: before.line.end },
                    column: { start: before.column.end, end: before.column.end },
                } as Token)
                missing += closer
                outermost = open.pop()
            }
            if (outermost) {
                const what = missing.length === 1
                    ? `the '${(outermost as { value?: unknown }).value}' on line ${outermost.line.start}`
                    : `the brackets opened on line ${outermost.line.start}`
                errors.push(new ParseError(`Expected '${missing}' to close ${what}, got '${describe(t)}'`, t.line.start, t.column.start))
            }
        }
        out.push(t)
        if (t.type !== "Punctuator") continue
        if (value === "(" || value === "[" || value === "{") open.push(t)
        else if (value === ")" || value === "]" || value === "}") {
            const at = open.map(o => closerOf[String((o as { value?: unknown }).value)]).lastIndexOf(String(value))
            if (at >= 0) open.length = at
        }
    }
    return { tokens: out, errors }
}

/** Does the token at `index` begin a statement, whatever encloses it? An
 *  `if` does when it is followed by a `(...)` and a `{`, which an
 *  if-expression is not; a `function` does when a name follows it. */
function beginsStatement(tokens: Token[], index: number): boolean {
    const t = tokens[index]
    if (t.type !== "Keyword") return false
    const value = (t as { value?: unknown }).value
    const next = tokens[index + 1]
    if (value === "function") return next?.type === "Identifier"
    if (value === "if") {
        if (next?.type !== "Punctuator" || (next as { value?: unknown }).value !== "(") return false
        let depth = 0
        for (let i = index + 1; i < tokens.length; i++) {
            const v = tokens[i].type === "Punctuator" ? (tokens[i] as { value?: unknown }).value : undefined
            if (v === "(" || v === "[" || v === "{") depth++
            else if (v === ")" || v === "]" || v === "}") {
                if (--depth === 0) {
                    const after = tokens[i + 1]
                    return after?.type === "Punctuator" && (after as { value?: unknown }).value === "{"
                }
            }
        }
        return false
    }
    return value === "const" || value === "let" || value === "return" || value === "for" ||
        value === "while" || value === "repeat" || value === "break" || value === "continue"
}

function describe(t: Token): string {
    if (t.type === "EOF") return "<eof>"
    if ("value" in t) return String((t as { value?: unknown }).value)
    return t.type
}

/**
 * Like `parse`, but never throws on a syntax error: it records every error and
 * returns a best-effort AST. A broken expression becomes an `ErrorExpression`,
 * a broken field or argument is skipped to the next `,`, a missing `)`, `}`,
 * `then`, `do` or `end` is recorded and read past, and only what none of those
 * cover becomes an `ErrorStatement`. A malformed token (an unclosed string) is
 * an error too, and the rest of the file still lexes.
 *
 * This is the entry point a language server should use for open documents.
 */
export function parseWithRecovery(source: string): RecoverResult {
    const comments: SourceComment[] = []
    let read = readTokens(source, { comments })
    // A template string left open runs on to the next backtick, wherever that
    // is, and turns what lies between inside out. Ended at their lines
    // instead, the file may read better; that reading is kept if it does —
    // and always when one ran on to the end of the file, which hides
    // everything after it from the error count.
    if (read.errors.length && read.tokens.some(t => t.type === "InterpolatedString" && t.line.end > t.line.start)) {
        const byLine = readTokens(source, { lineTemplates: true })
        const toEnd = read.tokens[read.tokens.length - 1]
        const ranToEnd = read.errors.some(e =>
            e.message.startsWith("Unterminated interpolat") && e.line === toEnd.line.start && e.column === toEnd.column.start)
        if (ranToEnd || byLine.errors.length <= read.errors.length) read = byLine
    }
    const errors = read.errors.sort((a, b) => a.line - b.line || a.column - b.column)
    return { program: read.program, errors, directives: readDirectives(comments, read.tokens) }
}

/** Lex and parse `source` in recovery mode. */
function readTokens(source: string, options: { comments?: SourceComment[]; lineTemplates?: boolean }): {
    tokens: Token[]; program: Program; errors: ParseError[]
} {
    const lexErrors: LexError[] = []
    const tokens = tokenize(source, { errors: lexErrors, ...options })
    const lexed = lexErrors.map(e => new ParseError(e.message.replace(/ \(\d+:\d+\)$/, ""), e.line, e.column))

    const first = new Parser(tokens, { recover: true })
    let program = first.parseProgram()
    let errors = first.errors
    // A bracket left open runs on over what follows it, to the end of the
    // file if nothing closes it. Where the file is indented, the indentation
    // says where it really ended: a second reading closes it there, and is
    // kept when it is no worse than the first.
    if (errors.length || first.missingEnd) {
        const closed = closeByIndentation(tokens)
        const second = new Parser(closed.tokens, { recover: true, indentation: true })
        const reparsed = second.parseProgram()
        // A closer put in where none was missing leaves the real one stray,
        // which is an error of the second reading's own.
        if (second.errors.length <= errors.length) {
            program = reparsed
            errors = [...closed.errors, ...second.errors]
        }
    }
    return { tokens, program, errors: [...lexed, ...errors] }
}
