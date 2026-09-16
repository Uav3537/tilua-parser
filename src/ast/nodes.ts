// ============================================================
// Luau AST Node Definitions
// ============================================================

export interface BaseNode {
    line: { start: number; end: number }
    column: { start: number; end: number }
}

// ============================================================
// Program / Block
// ============================================================

export interface Program extends BaseNode {
    type: "Program"
    body: Block
}

export interface Block extends BaseNode {
    type: "Block"
    statements: Statement[]
}

// ============================================================
// Modules (tilua extension — Luau itself has no import/export;
// these are compiled away by the bundler into the dependency-tree
// IIFE, so they never survive to emitted Luau)
// ============================================================

export interface ImportSpecifier extends BaseNode {
    type: "ImportSpecifier"
    /** the exported name in the source module */
    imported: Identifier
    /** the local binding name — same as `imported` unless renamed with `as` */
    local: Identifier
}

export interface ImportStatement extends BaseNode {
    type: "ImportStatement"
    /** `import Default from '...'` */
    defaultImport?: Identifier
    /** `import * as Module from '...'` — the module's exports as one value. */
    namespaceImport?: Identifier
    /** `import type { A } from '...'`: every name it brings in is a type and
     *  may only be used as one — never as a value. It exists for the type
     *  checker alone, and leaves nothing in compiled code. */
    isTypeOnly?: boolean
    /** `import { a, b as c } from '...'` */
    specifiers: ImportSpecifier[]
    source: StringLiteral
}

/** `export const x = 1`, `export let y = 2`, `export function f() end` */
export interface ExportStatement extends BaseNode {
    type: "ExportStatement"
    declaration: VariableDeclaration | FunctionDeclaration | ClassDeclaration
}

/** `export default <expr>` — mirrors JS default export / dynamic import()'s
 *  `{ default: ... }` shape. Distinct from ExportStatement because the
 *  right-hand side is any expression, not necessarily a declaration. */
export interface ExportDefaultStatement extends BaseNode {
    type: "ExportDefaultStatement"
    /** `export default class Name ... end` keeps its name: it declares the
     *  class here as well as exporting it, the way TypeScript's does. */
    declaration: Expression | ClassDeclaration
}

export interface ExportSpecifier extends BaseNode {
    type: "ExportSpecifier"
    /** The name in this module — or, with `from`, in the other module. */
    local: Identifier
    /** The name it is exported as — same as `local` unless renamed with `as`. */
    exported: Identifier
}

/** `export { a, b as c }` exports names declared elsewhere in the module;
 *  `export { a, b as c } from "./x"` re-exports another module's names. */
export interface ExportNamedStatement extends BaseNode {
    type: "ExportNamedStatement"
    specifiers: ExportSpecifier[]
    source?: StringLiteral
}

/** `export * from "./x"` — every named export of another module (not its
 *  default), except names this module exports itself. */
export interface ExportAllStatement extends BaseNode {
    type: "ExportAllStatement"
    source: StringLiteral
}

// ============================================================
// Statements
// ============================================================

export type Statement =
    | VariableDeclaration
    | FunctionDeclaration
    | FunctionDeclarationStatement
    | ClassDeclaration
    | AssignmentStatement
    | CompoundAssignmentStatement
    | CallStatement
    | ExpressionStatement
    | DoStatement
    | WhileStatement
    | RepeatStatement
    | IfStatement
    | NumericForStatement
    | GenericForStatement
    | ReturnStatement
    | BreakStatement
    | ContinueStatement
    | TypeAliasStatement
    | ExportTypeAliasStatement
    | ImportStatement
    | ExportStatement
    | ExportDefaultStatement
    | ExportNamedStatement
    | ExportAllStatement
    | DeclareStatement
    | DeclareClassStatement
    | ErrorStatement

/** `declare game: DataModel` / `declare function require(m: string): unknown`
 *  — an ambient value/function declaration for a definitions file (`.d.tilua`).
 *  Contributes a global type; emits no runtime code. */
export interface DeclareStatement extends BaseNode {
    type: "DeclareStatement"
    name: string
    /** The name as a node, so tools can point at it — `name` has no span. */
    id: Identifier
    /** the declared value's type (function form is lowered to a FunctionTypeNode) */
    valueType: TypeNode
}

/** `declare class Part extends BasePart { Shape: EnumItem }` — a *nominal*
 *  type for a definitions file, the way Roblox's own classes are: a `Part` is
 *  an `Instance` because it extends one, not because it has the same members,
 *  and no table literal is ever a `Part`. The body lists the members the class
 *  adds; it inherits the rest. Declares a type only, no value. */
export interface DeclareClassStatement extends BaseNode {
    type: "DeclareClassStatement"
    name: Identifier
    /** `extends Base` — another class. */
    superclass?: TypeReference
    body: TableTypeNode
}

/** A statement position that could not be parsed. Only produced when parsing
 *  in recovery mode (`parseWithRecovery`); its span covers the skipped tokens
 *  so tools can still map a cursor there. */
export interface ErrorStatement extends BaseNode {
    type: "ErrorStatement"
}

/** `const x = 1` / `let x, y = a, b` — the only variable-binding form in tilua
 *  (Luau's `local` is gone). `const` bindings are immutable and infer literal
 *  types (`const n = 1` → `1`); `let` bindings are mutable and widen. */
export interface VariableDeclaration extends BaseNode {
    type: "VariableDeclaration"
    kind: "const" | "let"
    names: BindingTarget[]
    init: Expression[]
}

// ============================================================
// Destructuring patterns (tilua extension — JS-style)
// ------------------------------------------------------------
// Appear in binding positions: `local <pattern> = ...`,
// `<pattern> = ...` assignment, `for <pattern> in ...`, and
// function parameters. Lowered by the compiler into a sequence
// of plain member/index reads (`local a = z.a`, etc).
// ============================================================

export type BindingTarget = IdentifierPattern | ObjectPattern | ArrayPattern

export interface IdentifierPattern extends BaseNode {
    type: "IdentifierPattern"
    name: string
    /** only meaningful at the top level of a binding (`local x: T`, `{a}: T`) */
    typeAnnotation?: TypeNode
    /** `local x <const>` attribute list */
    attributes?: string[]
}

export interface ObjectPattern extends BaseNode {
    type: "ObjectPattern"
    properties: ObjectPatternProperty[]
    /** `...rest` — collects the remaining own keys into a new object */
    rest?: BindingTarget
    typeAnnotation?: TypeNode
}

export interface ObjectPatternProperty extends BaseNode {
    type: "ObjectPatternProperty"
    /** identifier/string key, or any expression when `computed` */
    key: Identifier | StringLiteral | Expression
    computed: boolean
    /** binding target; for shorthand this is an IdentifierPattern named after `key` */
    value: BindingTarget
    /** `{ a = 1 }` / `{ a: b = 1 }` default */
    default?: Expression
    shorthand: boolean
}

export interface ArrayPattern extends BaseNode {
    type: "ArrayPattern"
    /** `null` entries are elision holes (`[, a]`) */
    elements: (ArrayPatternElement | null)[]
    /** `...rest` — collects the remaining elements into a new array */
    rest?: BindingTarget
    typeAnnotation?: TypeNode
}

export interface ArrayPatternElement extends BaseNode {
    type: "ArrayPatternElement"
    value: BindingTarget
    default?: Expression
}

/** `function f() ... end` — declares `f` in the enclosing scope, visible to
 *  its own body (so it can recurse). Like TypeScript's function declaration,
 *  the name cannot be reassigned. `function a.b() end` and `function T:m() end`
 *  assign to a member instead: see `FunctionDeclarationStatement`. */
export interface FunctionDeclaration extends BaseNode {
    type: "FunctionDeclaration"
    /** The name on the line the body is written on, when the declaration is
     *  an overload set — `name` is the first signature's. */
    implementationName?: Identifier
    name: Identifier
    func: FunctionBody
    attributes?: string[]
    /** TS-style overload signatures preceding the implementation (`func`). */
    signatures?: FunctionSignature[]
}

/** `function a.b() end` / `function T:m() end` — defines a member. */
export interface FunctionDeclarationStatement extends BaseNode {
    type: "FunctionDeclarationStatement"
    target: FunctionName
    isMethod: boolean
    func: FunctionBody
    attributes?: string[]
    /** TS-style overload signatures preceding the implementation (`func`). */
    signatures?: FunctionSignature[]
}

/** A bodyless function declaration — an overload signature. tilua uses the
 *  exact TS shape: one or more `function f(...): T` lines with no `end`,
 *  followed by the implementation `function f(...) ... end`. */
export interface FunctionSignature extends BaseNode {
    type: "FunctionSignature"
    /** The name this signature was written with — one line of an overload
     *  set, each of which a tool can point at on its own. */
    name?: Identifier
    generics: GenericTypeParameter[]
    params: FunctionParameter[]
    hasVarargs: boolean
    varargTypeAnnotation?: TypeNode
    returnType?: TypeNode
    /** `: v is T` / `: asserts v` instead of a plain return type. */
    predicate?: TypePredicateNode
}

export interface FunctionName extends BaseNode {
    type: "FunctionName"
    base: Identifier
    path: Identifier[]
    method?: Identifier
}

/** `class Name extends Base ... end` — tilua's one runtime class form.
 *
 *  It is sugar, and the shape it stands for is the ordinary Lua one: the
 *  class is a single table holding the methods and the statics, and an
 *  instance is a table whose metatable points at it. An instance therefore
 *  references *the class*, not a copy and not a prototype chain of its own —
 *  one class, one place its behaviour lives.
 *
 *  The declaration contributes both a type (the instance type, nominal, as
 *  `declare class` does) and a value (the class table, with `new` and the
 *  statics on it). */
export interface ClassDeclaration extends BaseNode {
    type: "ClassDeclaration"
    name: Identifier
    /** `class Box<T>` — the instance type is then generic, and `Box<number>`
     *  instantiates it. */
    typeParams: GenericTypeParameter[]
    /** `extends Base` / `extends Box<number>` — another class declared in
     *  this file or imported, with its own arguments filled in. */
    superclass?: Identifier
    /** The arguments `extends Box<number>` was written with. */
    superArguments?: TypeNode[]
    members: ClassMember[]
}

/** `class ... end` written where a value goes: `const Counter = class ... end`,
 *  `export default class ... end`. The name is optional and, when written, is
 *  visible only inside the class — as in JavaScript. An expression has no name
 *  to instantiate, so it takes no type parameters. */
export interface ClassExpression extends BaseNode {
    type: "ClassExpression"
    name?: Identifier
    superclass?: Identifier
    superArguments?: TypeNode[]
    members: ClassMember[]
}

export type ClassMember = ClassField | ClassMethod | ClassAccessor | ClassConstructor

/** The two ways a class is written. Everything after parsing treats them
 *  alike: only the name and the type parameters differ. */
export type ClassLike = ClassDeclaration | ClassExpression

/** `public` / `private` written before a member. Only the type checker reads
 *  it: a private member is still an ordinary key at runtime. */
export type ClassAccessibility = "public" | "private"

/** `x: number` / `x = 1` / `static count = 0`. An instance field is assigned
 *  when the instance is built, before the constructor body runs; a `static`
 *  one is assigned on the class table, once. */
export interface ClassField extends BaseNode {
    type: "ClassField"
    /** Left out, the member is public. */
    accessibility?: ClassAccessibility
    name: Identifier
    isStatic: boolean
    typeAnnotation?: TypeNode
    init?: Expression
}

/** `function name(...) ... end` inside a class body — `this` is bound in it.
 *  A `static` one is a plain function on the class table, with no `this`. */
export interface ClassMethod extends BaseNode {
    type: "ClassMethod"
    /** Left out, the member is public. */
    accessibility?: ClassAccessibility
    name: Identifier
    isStatic: boolean
    func: FunctionBody
    /** TS-style overload signatures preceding the implementation. */
    signatures?: FunctionSignature[]
}

/** `get name(): T ... end` / `set name(v: T) ... end` — read and written as a
 *  property, run as a function. */
export interface ClassAccessor extends BaseNode {
    type: "ClassAccessor"
    /** Left out, the member is public. */
    accessibility?: ClassAccessibility
    kind: "get" | "set"
    name: Identifier
    isStatic: boolean
    func: FunctionBody
}

/** `constructor(...) ... end` — runs on a fresh instance. A class that
 *  extends another must call `super(...)` before touching `this`. */
export interface ClassConstructor extends BaseNode {
    type: "ClassConstructor"
    func: FunctionBody
}

/** `new Name(args)` — builds an instance. Lowers to the class's own
 *  `Name.new(args)`, which is also callable by hand. */
export interface NewExpression extends BaseNode {
    type: "NewExpression"
    callee: Expression
    arguments: Expression[]
    typeArguments?: (TypeNode | TypePackNode)[]
}

/** `super` — only inside a class that extends another: `super(...)` in the
 *  constructor runs the base's on this instance, and `super.method(...)` in a
 *  method calls the base's version of it. */
export interface SuperExpression extends BaseNode {
    type: "SuperExpression"
}

export interface AssignmentStatement extends BaseNode {
    type: "AssignmentStatement"
    targets: (Expression | ObjectPattern | ArrayPattern)[]
    values: Expression[]
}

export interface CompoundAssignmentStatement extends BaseNode {
    type: "CompoundAssignmentStatement"
    operator: "+=" | "-=" | "*=" | "/=" | "//=" | "%=" | "^=" | "..="
    target: Expression
    value: Expression
}

export interface CallStatement extends BaseNode {
    type: "CallStatement"
    expression: CallExpression | MethodCallExpression | NewExpression
}

/** An expression written as a statement, where Lua would want a call or an
 *  assignment: `value` on a line of its own.
 *
 *  It does nothing, and the compiler drops it. It is here because writing a
 *  name and asking the editor about it — hover, completion — is how code gets
 *  written, and making that a syntax error means the file stops being
 *  analysable exactly when the help is wanted. A call is a `CallStatement`
 *  still; this is every other shape. */
export interface ExpressionStatement extends BaseNode {
    type: "ExpressionStatement"
    expression: Expression
}

export interface DoStatement extends BaseNode {
    type: "DoStatement"
    body: Block
}

export interface WhileStatement extends BaseNode {
    type: "WhileStatement"
    condition: Expression
    body: Block
}

export interface RepeatStatement extends BaseNode {
    type: "RepeatStatement"
    body: Block
    condition: Expression
}

export interface IfClause extends BaseNode {
    type: "IfClause"
    condition: Expression
    body: Block
}

export interface IfStatement extends BaseNode {
    type: "IfStatement"
    clauses: IfClause[]
    alternate?: Block
}

export interface NumericForStatement extends BaseNode {
    type: "NumericForStatement"
    variable: TypedIdentifier
    start: Expression
    end: Expression
    step?: Expression
    body: Block
}

export interface GenericForStatement extends BaseNode {
    type: "GenericForStatement"
    variables: BindingTarget[]
    iterators: Expression[]
    body: Block
}

export interface ReturnStatement extends BaseNode {
    type: "ReturnStatement"
    arguments: Expression[]
}

export interface BreakStatement extends BaseNode {
    type: "BreakStatement"
}

export interface ContinueStatement extends BaseNode {
    type: "ContinueStatement"
}

export interface TypeAliasStatement extends BaseNode {
    type: "TypeAliasStatement"
    name: Identifier
    generics: GenericTypeParameter[]
    definition: TypeNode
}

export interface ExportTypeAliasStatement extends BaseNode {
    type: "ExportTypeAliasStatement"
    alias: TypeAliasStatement
}

export interface GenericTypeParameter extends BaseNode {
    type: "GenericTypeParameter"
    name: string
    /** The name as a node. Absent on parameters the analyzer synthesizes. */
    id?: Identifier
    isPack?: boolean
    /** `<const T>` — infer the argument at its narrowest instead of widening
     *  it: literals stay literal and array literals become tuples. */
    isConst?: boolean
    /** `<T extends C>` upper bound (TS style). */
    constraint?: TypeNode
    default?: TypeNode | TypePackNode
}

// ============================================================
// Expressions
// ============================================================

export type Expression =
    | Identifier
    | NilLiteral
    | BooleanLiteral
    | NumberLiteral
    | StringLiteral
    | InterpolatedStringExpression
    | VarargExpression
    | FunctionExpression
    | TableExpression
    | ArrayExpression
    | BinaryExpression
    | UnaryExpression
    | MemberExpression
    | IndexExpression
    | CallExpression
    | MethodCallExpression
    | NewExpression
    | SuperExpression
    | ClassExpression
    | SpreadElement
    | ParenthesizedExpression
    | TypeAssertionExpression
    | SatisfiesExpression
    | AsConstExpression
    | IfElseExpression
    | ErrorExpression

/** An expression that could not be parsed. Only produced in recovery mode
 *  (`parseWithRecovery`), where a broken initializer, condition, field value or
 *  argument keeps its place in the tree; its span covers the skipped tokens
 *  (and is empty when nothing was written). Its type is `any`. */
export interface ErrorExpression extends BaseNode {
    type: "ErrorExpression"
}

export interface Identifier extends BaseNode {
    type: "Identifier"
    name: string
}

export interface TypedIdentifier extends BaseNode {
    type: "TypedIdentifier"
    name: string
    typeAnnotation?: TypeNode
    attributes?: string[]
}

export interface NilLiteral extends BaseNode {
    type: "NilLiteral"
}

export interface BooleanLiteral extends BaseNode {
    type: "BooleanLiteral"
    value: boolean
}

export interface NumberLiteral extends BaseNode {
    type: "NumberLiteral"
    value: number
    raw: string
}

export interface StringLiteral extends BaseNode {
    type: "StringLiteral"
    value: string
    raw: string
}

export type InterpolatedStringPart =
    | { kind: "string"; value: string; raw: string }
    | { kind: "expression"; expression: Expression }

export interface InterpolatedStringExpression extends BaseNode {
    type: "InterpolatedStringExpression"
    parts: InterpolatedStringPart[]
}

export interface VarargExpression extends BaseNode {
    type: "VarargExpression"
}

export interface FunctionParameter extends BaseNode {
    type: "FunctionParameter"
    /** `...rest: T[]` — every argument from this position on, as an array,
     *  the way JavaScript's rest parameter collects them. It is always last,
     *  and the function is a vararg function: `...` still means Lua's pack
     *  (`const a, b = ...`), and this is the array of it. */
    rest?: boolean
    /** `name?: T` — the argument may be omitted, and its type admits `nil`. */
    optional?: boolean
    /** the parameter name, or `""` when `pattern` is set */
    name: string
    /** JS-style destructured parameter (`function f({a}, [b]) end`) */
    pattern?: ObjectPattern | ArrayPattern
    typeAnnotation?: TypeNode
    /** default value (`function f(a = 1) end`) */
    default?: Expression
}

export interface FunctionBody extends BaseNode {
    type: "FunctionBody"
    generics: GenericTypeParameter[]
    params: FunctionParameter[]
    hasVarargs: boolean
    varargTypeAnnotation?: TypeNode
    returnType?: TypeNode
    /** `: v is T` / `: asserts v` instead of a plain return type. */
    predicate?: TypePredicateNode
    /** Declared as `function T:m(...)`, so `params[0]` is the injected `self`. */
    isMethod?: boolean
    body: Block
}

export interface FunctionExpression extends BaseNode {
    type: "FunctionExpression"
    func: FunctionBody
}

// tilua splits Luau's single `{}` table syntax the way JS does: `{}` is an
// object/dictionary literal ONLY (key → value), and `[]` is an array literal
// ONLY (see `ArrayExpression`). This removes the ambiguity that made
// destructuring (`local {a} = t` vs `local [a] = t`) undecidable in Luau.
export type TableField =
    /** `a: v` or `"a": v` — JS colon syntax (NOT Luau `a = v`). */
    | { type: "TableFieldNamed"; key: Identifier | StringLiteral; value: Expression }
    /** `[expr]: v` — computed key. */
    | { type: "TableFieldComputed"; key: Expression; value: Expression }
    /** `{ a }` shorthand — sugar for `{ a: a }`. */
    | { type: "TableFieldShorthand"; name: Identifier }
    /** `{ ...expr }` — JS object spread. */
    | { type: "TableFieldSpread"; argument: Expression }

/** `{ a: 1, [k]: v }` — object literal (Luau `{}` narrowed to objects only). */
export interface TableExpression extends BaseNode {
    type: "TableExpression"
    fields: TableField[]
}

/** `[1, 2, ...rest]` — array literal. Lowers to a Luau `{1, 2}` sequence table. */
export interface ArrayExpression extends BaseNode {
    type: "ArrayExpression"
    elements: (Expression | SpreadElement)[]
}

/** `...expr` — the values of an array, one after another, where a list of
 *  values is written: inside an array literal (`[...xs, 1]`) and in a call's
 *  arguments (`f(a, ...rest)`). It is not a value of its own, and the parser
 *  only produces one in those two places.
 *
 *  Lua spreads with `table.unpack`, which only yields every value when it is
 *  written last; anywhere else the compiler builds the whole list first. Bare
 *  `...` is unaffected — that is the vararg pack, and `f(...)` passes it on
 *  as it always did. */
export interface SpreadElement extends BaseNode {
    type: "SpreadElement"
    argument: Expression
}

export const BinaryOperators = [
    "+", "-", "*", "/", "//", "%", "^", "..",
    "==", "~=", "<", ">", "<=", ">=",
    "and", "or",
] as const

export interface BinaryExpression extends BaseNode {
    type: "BinaryExpression"
    operator: typeof BinaryOperators[number]
    left: Expression
    right: Expression
}

export const UnaryOperators = ["-", "not", "#"] as const

export interface UnaryExpression extends BaseNode {
    type: "UnaryExpression"
    operator: typeof UnaryOperators[number]
    argument: Expression
}

export interface MemberExpression extends BaseNode {
    type: "MemberExpression"
    object: Expression
    property: Identifier
    /** `object?.property` — when `object` is nil, the whole chain this link
     *  belongs to is nil and nothing after it is evaluated. */
    optional?: boolean
}

export interface IndexExpression extends BaseNode {
    type: "IndexExpression"
    object: Expression
    index: Expression
}

export interface CallExpression extends BaseNode {
    type: "CallExpression"
    callee: Expression
    arguments: Expression[]
    /** `f<T>(x)` — type arguments written out rather than inferred. */
    typeArguments?: (TypeNode | TypePackNode)[]
    /** `f?.(...)` — see `MemberExpression.optional`. The call does not happen,
     *  and the arguments are not evaluated, when `callee` is nil. */
    optional?: boolean
    /** The `(` opened on a line after the callee ended:
     *
     *      const value = map[key]
     *      ("text"):upper()
     *
     *  is one statement — a call of `map[key]` — because a line break does
     *  not end a statement, in Lua or in JavaScript. Flagged here so the
     *  analyzer can say so; Lua 5.1 calls it "ambiguous syntax". */
    argumentsOnNewLine?: boolean
}

export interface MethodCallExpression extends BaseNode {
    type: "MethodCallExpression"
    object: Expression
    method: Identifier
    arguments: Expression[]
    /** `obj:m<T>(x)` — see `CallExpression.typeArguments`. */
    typeArguments?: (TypeNode | TypePackNode)[]
    /** `object?:method(...)` — see `MemberExpression.optional`. The
     *  arguments are not evaluated when `object` is nil. */
    optional?: boolean
}

export interface ParenthesizedExpression extends BaseNode {
    type: "ParenthesizedExpression"
    expression: Expression
}

/** `expr satisfies T` — checks that `expr` is assignable to `T` without
 *  changing its inferred type, so a literal keeps its narrow type while still
 *  being validated against a wider contract. Unlike `as`, it never widens or
 *  reinterprets. */
export interface SatisfiesExpression extends BaseNode {
    type: "SatisfiesExpression"
    expression: Expression
    typeAnnotation: TypeNode
}

export interface TypeAssertionExpression extends BaseNode {
    type: "TypeAssertionExpression"
    expression: Expression
    typeAnnotation: TypeNode
}

/** `expr as const` — freezes the expression's inferred type to its narrowest
 *  (literal) form, the way TypeScript's `as const` does. Kept as a distinct
 *  node from TypeAssertionExpression because there's no TypeNode on the
 *  right-hand side: the type checker computes the literal type itself. */
export interface AsConstExpression extends BaseNode {
    type: "AsConstExpression"
    expression: Expression
}

export interface IfElseExpression extends BaseNode {
    type: "IfElseExpression"
    clauses: { condition: Expression; body: Expression }[]
    alternate: Expression
}

export type TypeNode =
    | TypeReference
    | TypeLiteralString
    | TypeLiteralBoolean
    | TypeLiteralNumber
    | TableTypeNode
    | ArrayTypeNode
    | TupleTypeNode
    | FunctionTypeNode
    | UnionTypeNode
    | IntersectionTypeNode
    | ParenthesizedTypeNode
    | TypeofTypeNode
    | VariadicTypeNode
    | TypePackNode
    | KeyofTypeNode
    | IndexedAccessTypeNode
    | ConditionalTypeNode
    | InferTypeNode
    | MappedTypeNode
    | TemplateLiteralTypeNode
    | DifferenceTypeNode

/** `A - B` — every value of `A` that is not a `B`. Binds tighter than `|`
 *  and looser than `&`, so `A | B - C` is `A | (B - C)`.
 *
 *  Mostly it simplifies away (a union drops members; `string - "a"` is just
 *  `string`), but over an opaque type it is retained — which is what lets the
 *  `else` of `if a == 1` on an `unknown` say `unknown - 1` instead of
 *  forgetting the test. `Exclude<T, U>` is defined as `T - U`. */
export interface DifferenceTypeNode extends BaseNode {
    type: "DifferenceTypeNode"
    base: TypeNode
    excluded: TypeNode
}

/** A template literal type: `` `on${string}` ``, `` `get${K}` ``.
 *  `quasis` are the literal chunks and `types` the interpolated types;
 *  `quasis.length === types.length + 1`, exactly as in an ECMAScript template.
 *  When every interpolation is a union of string literals the type reduces to
 *  the union of all concatenations; otherwise it stays a pattern that literal
 *  strings are matched against. */
export interface TemplateLiteralTypeNode extends BaseNode {
    type: "TemplateLiteralTypeNode"
    quasis: string[]
    types: TypeNode[]
}

/** `keyof T` — the union of `T`'s property names as string-literal types,
 *  plus its indexer key type when it has one. */
export interface KeyofTypeNode extends BaseNode {
    type: "KeyofTypeNode"
    target: TypeNode
}

/** `T[K]` — indexed access. Distinguished from the `T[]` array suffix by
 *  whether the brackets are empty. */
export interface IndexedAccessTypeNode extends BaseNode {
    type: "IndexedAccessTypeNode"
    objectType: TypeNode
    indexType: TypeNode
}

/** `C extends E ? A : B`. Distributes over a naked type parameter, as in
 *  TypeScript, which is what makes `Exclude<T, U>` filter a union. */
export interface ConditionalTypeNode extends BaseNode {
    type: "ConditionalTypeNode"
    checkType: TypeNode
    extendsType: TypeNode
    trueType: TypeNode
    falseType: TypeNode
}

/** `infer U`, only meaningful inside a conditional's `extends` clause: it
 *  binds `U` to whatever matched at that position. */
export interface InferTypeNode extends BaseNode {
    type: "InferTypeNode"
    name: string
    /** The bound name as a node. */
    id?: Identifier
}

/** `{ [K in C]: V }` — a mapped type. `optional` / `readonly` carry the
 *  modifier as written: `true` adds it (`?`), `false` removes it (`-?`),
 *  `undefined` leaves the source property's modifier alone. */
export interface MappedTypeNode extends BaseNode {
    type: "MappedTypeNode"
    /** The name bound to each key in turn (`K`). */
    parameter: string
    /** `parameter` as a node. */
    parameterId?: Identifier
    /** The union of keys to map over (`C`). */
    constraint: TypeNode
    /** `[K in C as R]` — remaps each key through `R`. */
    nameType?: TypeNode
    /** The property type, which may mention `parameter`. */
    template: TypeNode
    optional?: boolean
    readonly?: boolean
}

/** The return position of a TypeScript-style type guard:
 *  `function isStr(v: unknown): v is string`, `function check(v): asserts v`,
 *  or `function assertStr(v): asserts v is string`.
 *
 *  Deliberately *not* a member of `TypeNode` — it may only appear as a
 *  function's return annotation, and keeping it out of the union means every
 *  existing `TypeNode` consumer stays exhaustive without change. A function
 *  carrying one returns `boolean` (`is`) or nothing (`asserts`). */
export interface TypePredicateNode extends BaseNode {
    type: "TypePredicateNode"
    /** Name of the parameter this guard talks about. */
    parameterName: string
    /** `asserts x` — narrows the rest of the enclosing block, not a branch. */
    asserts: boolean
    /** Absent for a bare `asserts x` (a truthiness assertion). */
    typeAnnotation?: TypeNode
}

export interface TypePackNode extends BaseNode {
    type: "TypePackNode"
    types: TypeNode[]
    hasVarargs: boolean
    varargType?: TypeNode
}

export interface TypeReference extends BaseNode {
    type: "TypeReference"
    base: string
    namespace?: string
    typeArguments: (TypeNode | TypePackNode)[]
}

export interface TypeLiteralString extends BaseNode {
    type: "TypeLiteralString"
    value: string
}

export interface TypeLiteralBoolean extends BaseNode {
    type: "TypeLiteralBoolean"
    value: boolean
}

/** `1`, `3.5` — a single-valued number type. The checker already produces
 *  these when narrowing (`if n == 1`), so they have to be writable too. */
export interface TypeLiteralNumber extends BaseNode {
    type: "TypeLiteralNumber"
    value: number
}

export type TableTypeProperty =
    | ({ type: "TableTypeIndexer"; keyType: TypeNode; valueType: TypeNode } & BaseNode)
    /** `name: T` (required) or `name?: T` (optional — TS style, the property
     *  may be absent). `optional` reflects the `?` after the name only;
     *  `name: T | nil` is a required property whose value may be nil. */
    | ({ type: "TableTypeProperty"; name: string; key: Identifier; valueType: TypeNode; optional: boolean; readonly?: boolean } & BaseNode)

export interface TableTypeNode extends BaseNode {
    type: "TableTypeNode"
    properties: TableTypeProperty[]
}

/** `T[]` — array type. Replaces Luau's `{T}` array-table notation. */
export interface ArrayTypeNode extends BaseNode {
    type: "ArrayTypeNode"
    element: TypeNode
}

/** `[number, string]` — fixed-length tuple type. */
export interface TupleTypeNode extends BaseNode {
    type: "TupleTypeNode"
    elements: TypeNode[]
}

export interface FunctionTypeParameter extends BaseNode {
    type: "FunctionTypeParameter"
    /** `(...rest: T[]) -> R` — see `FunctionParameter.rest`. */
    rest?: boolean
    /** `name?: T` — the argument may be omitted, and its type admits `nil`. */
    optional?: boolean
    name?: string
    /** The name as a node (absent for an unnamed parameter). */
    id?: Identifier
    typeAnnotation: TypeNode
}

export interface FunctionTypeNode extends BaseNode {
    type: "FunctionTypeNode"
    generics: GenericTypeParameter[]
    params: FunctionTypeParameter[]
    hasVarargs: boolean
    varargType?: TypeNode
    returnType: TypeNode
    /** `(v: unknown) -> v is string` — a guard written as a function *type*. */
    predicate?: TypePredicateNode
}

export interface UnionTypeNode extends BaseNode {
    type: "UnionTypeNode"
    types: TypeNode[]
}

export interface IntersectionTypeNode extends BaseNode {
    type: "IntersectionTypeNode"
    types: TypeNode[]
}

export interface ParenthesizedTypeNode extends BaseNode {
    type: "ParenthesizedTypeNode"
    typeAnnotation: TypeNode
}

/** `typeof x` / `typeof x.y` (TypeScript's type query) or `typeof(expr)`
 *  (Luau's spelling): the type of a value. */
export interface TypeofTypeNode extends BaseNode {
    type: "TypeofTypeNode"
    expression: Expression
}

export interface VariadicTypeNode extends BaseNode {
    type: "VariadicTypeNode"
    typeAnnotation: TypeNode
}

export type Node =
    | Program
    | Block
    | Statement
    | Expression
    | TypeNode
    | FunctionBody
    | FunctionParameter
    | FunctionName
    | IfClause
    | TypedIdentifier
    | GenericTypeParameter
    | FunctionSignature
    | TypePredicateNode
    | TableField
    | SpreadElement
    | FunctionTypeParameter
    | TableTypeProperty
    | BindingTarget
    | ObjectPatternProperty
    | ArrayPatternElement