import type {
    Program, Block, Statement, Expression, TypeNode,
    Identifier, FunctionBody, FunctionSignature, BindingTarget, GenericTypeParameter, VariableDeclaration,
    ObjectPattern, ArrayPattern, ObjectPatternProperty, ReturnStatement,
    TableExpression, ArrayExpression, IfStatement, TypePredicateNode, DeclareClassStatement, DeclareStatement,
    ClassDeclaration, TypeAliasStatement, ExportTypeAliasStatement, ClassExpression, ClassLike, ClassMember,
    GenericForStatement,
} from "./nodes"
import { LANGUAGE_GLOBALS, type ScopeAnalysis, type BindingId } from "./analyzeScopes"
import { preludeProgram } from "./prelude"
import {
    type Type, type ObjectProperty, type ObjectType, type FunctionType, type TypePredicate, type ClassInfo,
    type GenericRefType, type TypeOrigin,
    anyType, unknownType, declaredUnknownType, neverType, nilType, booleanType, numberType, stringType,
    primitive, literal, arrayOf, tuple, tupleMembers, objectType, fn, union, intersection, optional,
    typeParam, substitute, unify, containsTypeParam, matchInfer, setAliasExpander, setDeferredBound, difference,
    widen, isAssignable, overlaps, narrowTo, narrowExclude, narrowTruthy, narrowFalsy,
    isClassType,
    isPossiblyFalsy,
    formatType, withAliasName,
} from "./typeModel"

// ============================================================
// Public API
// ============================================================

export interface TypeDiagnostic {
    /** Usually an expression or statement; a type where the type is wrong
     *  (`declare class A extends NotAClass`), or a block where nothing in it
     *  is to blame (a function that never returns). Only its span is read. */
    node: Expression | Statement | TypeNode | Block | ClassMember
    message: string
}

/** Members a class carries to model itself, which no one writes and so no one
 *  should be told about. */
const INTERNAL_MEMBERS = new Set(["ClassObject", "ParentClass"])

/** How much of a mismatch to spell out. The point is to save the reader
 *  comparing two shapes by eye — past a certain length it stops saving them
 *  anything and starts being the thing they have to read. */
const MAX_MISSING = 3
const MAX_EXPLANATION = 90
const MAX_TYPE = 120

/** How a `for (const item in source)` walks its source — what lowering needs,
 *  decided with the item's type so the two cannot drift apart.
 *  - `values`: an array or a table, walked directly; the item is each value.
 *  - `function`: an iterator function, called until it answers nil; the item
 *    is each answer.
 *  - `iteration`: `[step, state, first]`, as `pairs(t)` answers: `step` is
 *    called with the state and the item before (`first` the first time) until
 *    it answers nil.
 *  `viaIter`: the source is an object whose `__iter` method gives the function
 *  or the iteration. */
export interface LoopForm {
    readonly walks: "values" | "function" | "iteration"
    readonly viaIter: boolean
}

export interface TypeAnalysis {
    /** Inferred type of every expression node. */
    readonly typeOf: Map<Expression, Type>
    /** Declared (or first-inferred) type of every value binding. */
    readonly bindingType: Map<BindingId, Type>
    /** Type of a specific variable *reference*, after flow narrowing at that
     *  point. For an un-narrowed reference this equals `bindingType`. */
    readonly narrowedTypeOf: Map<Identifier, Type>
    /** What every type annotation node resolves to — `number`, `Shape`,
     *  `typeof x`, a property's type inside `{ ... }`. Inside a generic alias or
     *  function its parameters stay unresolved (`T`). */
    readonly typeOfTypeNode: Map<TypeNode, Type>
    /** What each call argument is expected to be: the parameter it lands on,
     *  with the signature's type parameters replaced by their constraints — a
     *  union when an overload set disagrees. Recorded even for a call that does
     *  not type-check, since that is exactly when an editor wants to offer the
     *  values that would. */
    readonly expectedTypeOf: Map<Expression, Type>
    /** Top-level type aliases, resolved — and the type names this module
     *  imports, so tooling treats both alike. */
    readonly aliases: Map<string, Type>
    /** How each `for (const item in source)` walks its source; see
     *  `LoopForm`. A loop missing here walks values. */
    readonly loops: ReadonlyMap<GenericForStatement, LoopForm>
    readonly diagnostics: TypeDiagnostic[]
}

/** A type a module exports: the resolved type, plus the parameter names of a
 *  generic alias so an importer can instantiate it (`Box<number>`). */
export interface ExportedType {
    readonly type: Type
    readonly params: readonly string[]
}

/** What a module makes available to `import`. See `moduleExports`. */
export interface ModuleExports {
    /** `export const` / `export let` / `export function` names. */
    readonly values: ReadonlyMap<string, Type>
    /** `export type` names. */
    readonly types: ReadonlyMap<string, ExportedType>
    /** `export default <expr>`. */
    readonly default?: Type
    /** The module is still being analyzed further up an import cycle. Its
     *  names read as `any`, and nothing about them is reported. */
    readonly partial?: boolean
}

export interface AnalyzeTypesOptions {
    /** Types for pre-registered globals (`analyzeScopes`'s `builtinGlobals`).
     *  Anything not listed is treated as `any`. Overrides `libs`. */
    globalTypes?: Record<string, Type>
    /** Extra named types available to annotations (e.g. Roblox classes). */
    libTypes?: Record<string, Type>
    /** Parsed definitions files (`.d.tilua`): their `type` aliases become
     *  available to annotations and their `declare` statements seed global
     *  types. A project lists them under `types` in `tilua.config.json`; see
     *  `resolveTypeLibraries`. */
    libs?: readonly Program[]
    /** Resolve an `import`'s module path to what that module exports. Called
     *  once per distinct path. Return `undefined` when there is no such module:
     *  the import is reported and its names are `any`. Without this option
     *  every import is `any` — a single file cannot know better. */
    resolveModule?: (specifier: string) => ModuleExports | undefined
    /** Emit assignability diagnostics (default: true). */
    diagnostics?: boolean
    /** Report each type name nothing declares: "Cannot find name 'Nope'".
     *  Only meaningful when `libs` holds everything the file can name, so it
     *  is off unless asked for — exactly like `analyzeScopes`'s
     *  `reportUndeclared`. */
    reportUnknownTypes?: boolean
}

export function analyzeTypes(
    program: Program,
    scopes: ScopeAnalysis,
    options: AnalyzeTypesOptions = {},
): TypeAnalysis {
    return new TypeAnalyzer(program, scopes, options).run()
}

/** The exports of an analyzed module, in the shape another module's
 *  `resolveModule` returns. */
export function moduleExports(
    program: Program,
    scopes: ScopeAnalysis,
    types: TypeAnalysis,
    /** For `export ... from`: the same resolver the module was analyzed with. */
    resolveModule?: (specifier: string) => ModuleExports | undefined,
): ModuleExports {
    const byDeclaration = new Map<object, BindingId>()
    for (const binding of scopes.bindings.values()) {
        if (binding.declarationNode) byDeclaration.set(binding.declarationNode, binding.id)
    }
    const values = new Map<string, Type>()
    const exportedTypes = new Map<string, ExportedType>()
    let defaultType: Type | undefined
    const stars: string[] = []

    // `export { x as default }` makes `x` the default export.
    const setValue = (name: string, type: Type): void => {
        if (name === "default") defaultType = type
        else values.set(name, type)
    }
    const reexport = (from: ModuleExports | undefined, name: string, as: string): void => {
        // A module up an import cycle, or missing: nothing reliable to copy.
        if (!from || from.partial) {
            setValue(as, anyType)
            return
        }
        if (name === "default") {
            if (from.default) setValue(as, from.default)
            return
        }
        const value = from.values.get(name)
        if (value) setValue(as, value)
        const type = from.types.get(name)
        if (type) exportedTypes.set(as, type)
    }
    const aliasParams = (name: string): string[] => {
        for (const s of program.body.statements) {
            const alias = s.type === "TypeAliasStatement" ? s : s.type === "ExportTypeAliasStatement" ? s.alias : undefined
            if (alias?.name.name === name) return alias.generics.map(g => g.name)
        }
        return []
    }

    const exportName = (declaration: object, name: string): void => {
        const id = byDeclaration.get(declaration)
        values.set(name, (id !== undefined ? types.bindingType.get(id) : undefined) ?? anyType)
    }
    const exportPattern = (target: BindingTarget): void => {
        switch (target.type) {
            case "IdentifierPattern":
                exportName(target, target.name)
                return
            case "ObjectPattern":
                for (const p of target.properties) exportPattern(p.value)
                if (target.rest) exportPattern(target.rest)
                return
            case "ArrayPattern":
                for (const el of target.elements) if (el) exportPattern(el.value)
                if (target.rest) exportPattern(target.rest)
                return
        }
    }

    for (const stmt of program.body.statements) {
        if (stmt.type === "ExportStatement") {
            const declaration = stmt.declaration
            if (declaration.type === "FunctionDeclaration") exportName(declaration.name, declaration.name.name)
            else if (declaration.type === "ClassDeclaration") {
                // The class table is the value; the class name is the type of
                // its instances. A module importing it gets both.
                exportName(declaration.name, declaration.name.name)
                const instance = types.aliases.get(declaration.name.name)
                if (instance) {
                    exportedTypes.set(declaration.name.name, {
                        type: instance,
                        params: declaration.typeParams.map(g => g.name),
                    })
                }
            }
            else exportPattern(declaration.name)
        } else if (stmt.type === "ExportTypeAliasStatement") {
            const name = stmt.alias.name.name
            const type = types.aliases.get(name)
            if (type) exportedTypes.set(name, { type, params: stmt.alias.generics.map(g => g.name) })
        } else if (stmt.type === "ExportDefaultStatement") {
            if (stmt.declaration.type === "ClassDeclaration") {
                const id = byDeclaration.get(stmt.declaration.name)
                defaultType = (id !== undefined ? types.bindingType.get(id) : undefined) ?? anyType
                const instance = types.aliases.get(stmt.declaration.name.name)
                if (instance) {
                    const exported = { type: instance, params: stmt.declaration.typeParams.map(g => g.name) }
                    exportedTypes.set(stmt.declaration.name.name, exported)
                    // `import Box from "./box"` brings the type in as well as
                    // the class table, under whatever the importer calls it.
                    exportedTypes.set("default", exported)
                }
            } else {
                defaultType = types.typeOf.get(stmt.declaration) ?? anyType
            }
        } else if (stmt.type === "ExportNamedStatement") {
            if (stmt.source) {
                const from = resolveModule?.(stmt.source.value)
                for (const s of stmt.specifiers) reexport(from, s.local.name, s.exported.name)
            } else {
                for (const s of stmt.specifiers) {
                    const id = scopes.bindingOf.get(s.local)
                    if (id !== undefined) setValue(s.exported.name, types.bindingType.get(id) ?? anyType)
                    const alias = types.aliases.get(s.local.name)
                    if (alias) exportedTypes.set(s.exported.name, { type: alias, params: aliasParams(s.local.name) })
                }
            }
        } else if (stmt.type === "ExportAllStatement") {
            stars.push(stmt.source.value)
        }
    }

    // `export *` last: a name this module exports itself wins, and the
    // default is never part of it.
    for (const specifier of stars) {
        const from = resolveModule?.(specifier)
        if (!from || from.partial) continue
        for (const [name, type] of from.values) if (!values.has(name)) values.set(name, type)
        for (const [name, type] of from.types) if (!exportedTypes.has(name)) exportedTypes.set(name, type)
    }
    return { values, types: exportedTypes, default: defaultType }
}

// ============================================================
// Flow environment
// ============================================================

/** A narrowable *reference* — what TypeScript calls a "reference" in its flow
 *  analysis. Not just a variable: `x`, `x.a.b`, `x["k"]` and `t[2]` are each
 *  their own key, so a guard on a nested path narrows that path alone.
 *
 *  Shape: `$<bindingId>` for the root, then `.name` per property and `#n` per
 *  numeric index. `x.k` and `x["k"]` deliberately produce the *same* key —
 *  they denote the same reference, exactly as in TypeScript. */
type RefKey = string

/** The flow state at a program point: every reference currently known to be
 *  narrower than its declared type. Absent = "no narrowing here". */
type FlowEnv = Map<RefKey, Type>

/** Is `k` a path under `key`: `key.a`, `key#1`, `key[$k]`? */
function isBelow(k: RefKey, key: RefKey): boolean {
    if (!k.startsWith(key) || k.length === key.length) return false
    const next = k[key.length]
    return next === "." || next === "#" || next === "["
}

/** Flow key for a whole binding — the root of every reference path. */
function bindKey(id: BindingId): RefKey {
    return `$${id}`
}

/** How a binding's inferred type is derived from its initializer:
 *  `widen` (`let`), `const` (keep a top-level literal, TS-style),
 *  `asconst` (keep everything narrow + freeze). */
type BindMode = "widen" | "const" | "asconst" | "keep"

function forkEnv(env: FlowEnv): FlowEnv {
    return new Map(env)
}

/** Join two branch environments. A binding narrowed in only one branch must
 *  be unioned with what it was *outside* the branch (`base`) — taking the one
 *  present entry would wrongly propagate that branch's narrowing to the path
 *  that never ran it. */
function mergeEnv(a: FlowEnv, b: FlowEnv, base: (key: RefKey) => Type): FlowEnv {
    const out: FlowEnv = new Map()
    const keys = new Set([...a.keys(), ...b.keys()])
    for (const k of keys) {
        out.set(k, union([a.get(k) ?? base(k), b.get(k) ?? base(k)]))
    }
    return out
}

type Indexer = { key: Type; value: Type }

/** Combine two `{ [K]: V }` catch-alls (several computed keys, or a spread of a
 *  table that had one) — both key and value widen to the union. */
function mergeIndexer(a: Indexer | undefined, b: Indexer): Indexer {
    return a ? { key: union([a.key, b.key]), value: union([a.value, b.value]) } : b
}

/** Is this initialiser a *fresh* literal — one whose literal type should widen
 *  when it lands in a mutable binding? TypeScript widens `let n = 1` to
 *  `number` because `1` is a fresh literal expression, but leaves
 *  `let x = other` alone however narrow `other` is. Anything that is not a
 *  literal expression (or a container of them) keeps its type verbatim. */
function isFreshLiteralExpr(e: Expression | undefined): boolean {
    if (!e) return false
    switch (e.type) {
        case "NumberLiteral":
        case "StringLiteral":
        case "BooleanLiteral":
        case "InterpolatedStringExpression":
        case "TableExpression":
        case "ArrayExpression":
            return true
        case "ParenthesizedExpression":
            return isFreshLiteralExpr(e.expression)
        case "UnaryExpression":
            return isFreshLiteralExpr(e.argument)
        // `let n = 5 satisfies number` widens like `let n = 5`. An object or
        // array has already taken its literals from the contract, and keeps them.
        case "SatisfiesExpression": {
            const inner = unwrapParens(e.expression)
            return inner.type !== "TableExpression" && inner.type !== "ArrayExpression" && isFreshLiteralExpr(inner)
        }
        default:
            return false
    }
}

/** Every `infer U` name written inside a conditional's `extends` clause.
 *  They behave like type parameters scoped to that conditional. */
function collectInferNames(node: TypeNode): string[] {
    const out: string[] = []
    const walk = (n: TypeNode | undefined): void => {
        if (!n) return
        switch (n.type) {
            case "InferTypeNode": out.push(n.name); return
            case "ArrayTypeNode": walk(n.element); return
            case "ParenthesizedTypeNode": walk(n.typeAnnotation); return
            case "TupleTypeNode": n.elements.forEach(walk); walk(n.rest); return
            case "UnionTypeNode":
            case "IntersectionTypeNode": n.types.forEach(walk); return
            case "TypeReference": n.typeArguments.forEach(walk); return
            case "KeyofTypeNode": walk(n.target); return
            case "IndexedAccessTypeNode": walk(n.objectType); walk(n.indexType); return
            case "FunctionTypeNode":
                n.params.forEach(pp => walk(pp.typeAnnotation))
                walk(n.returnType)
                return
            case "TableTypeNode":
                for (const prop of n.properties) {
                    if (prop.type === "TableTypeIndexer") { walk(prop.keyType); walk(prop.valueType) }
                    else walk(prop.valueType)
                }
                return
            default: return
        }
    }
    walk(node)
    return out
}

/** Should an argument matched against this parameter keep its literal type?
 *  True for a bare type parameter whose constraint admits literals, mirroring
 *  TypeScript's rule for literal-type inference. */
function keepsLiterals(paramType: Type): boolean {
    if (paramType.kind !== "typeParam") return false
    // `<const T>` says so outright.
    if (paramType.isConst) return true
    if (!paramType.constraint) return false
    const members = paramType.constraint.kind === "union"
        ? paramType.constraint.types
        : [paramType.constraint]
    return members.some(m => m.kind === "literal")
}

/** The links the class table carries: an instance reaches its class through
 *  `ClassObject`, and a class reaches the one it extends through
 *  `ParentClass`. They are each class's own, never inherited. */
const CLASS_LINKS = new Set(["new", "ClassObject", "ParentClass"])

/** Where a call stops having one argument per parameter. See `spreadOf`. */
interface SpreadInfo {
    /** The parameter position the spread starts filling. */
    index: number
    /** One of the array's values, when how many there are is unknown. */
    element: Type
    /** A tuple's values, in order: then how many there are *is* known. */
    elements?: readonly Type[]
}

/** A class declaration's members, as types. Built once, filled in place:
 *  the fields land first so a method body can already read `this.x`. */
interface ClassShape {
    instance: Map<string, ObjectProperty>
    statics: Map<string, ObjectProperty>
    ctor?: FunctionType
    /** True while the two passes are still running. */
    filling: boolean
    /** What to do once they are done — for whoever read the shape early. */
    filled?: (() => void)[]
}

/** The names a lowered class already uses: `new` builds an instance,
 *  `__init` runs the constructor, and the rest are the metatable's. */
const CLASS_RESERVED = new Set([
    "new", "ClassObject", "ParentClass",
    "__init", "__index", "__newindex", "__getters", "__setters", "__dynamic",
])

/** Does this constructor body call `super(...)`? A call anywhere in it
 *  counts — inside an `if`, at the end, wherever the class needs it. */
function callsSuper(block: Block): boolean {
    let found = false
    walkNodes(block, node => {
        const record = node as { type?: string; callee?: { type?: string } }
        if (record.type === "CallExpression" && record.callee?.type === "SuperExpression") found = true
    })
    return found
}

/** Stands for "every field": a constructor that cannot finish normally
 *  leaves nothing unassigned. */
const ALL_FIELDS: Set<string> = new Set()

/** The `this.name`s a block assigns on every way through it that reaches
 *  its end, or `undefined` when none does — it always returns or throws.
 *  Both arms of an `if` have to assign a field for it to count; a loop may
 *  not run at all, and a function written inside runs whenever it is
 *  called, so neither counts. */
function definitelyAssigned(block: Block): Set<string> | undefined {
    const names = new Set<string>()
    for (const statement of block.statements) {
        switch (statement.type) {
            case "AssignmentStatement":
            case "CompoundAssignmentStatement":
                for (const name of assignedFields({ ...block, statements: [statement] })) names.add(name)
                break
            case "DoStatement": {
                const inner = definitelyAssigned(statement.body)
                if (!inner) return undefined
                for (const name of inner) names.add(name)
                break
            }
            case "IfStatement": {
                if (!statement.alternate) break
                const arms = [...statement.clauses.map(c => c.body), statement.alternate].map(definitelyAssigned)
                const finishing = arms.filter((arm): arm is Set<string> => arm !== undefined)
                if (!finishing.length) return undefined
                for (const name of finishing[0]) {
                    if (finishing.every(arm => arm.has(name))) names.add(name)
                }
                break
            }
            case "ReturnStatement":
                return undefined
            case "CallStatement": {
                const call = statement.expression
                if (call.type === "CallExpression" && call.callee.type === "Identifier" && call.callee.name === "error") {
                    return undefined
                }
                break
            }
        }
    }
    return names
}

/** A method's type with its receiver left out: what it takes after `this`
 *  (or a definitions file's `self`), which is what two classes' methods of
 *  one name have to agree on. Anything else is returned as it is. */
function withoutReceiver(t: Type): Type {
    if (t.kind === "intersection") return intersection(t.types.map(withoutReceiver))
    if (t.kind !== "function") return t
    const first = t.params[0]?.name
    if (first !== "this" && first !== "self") return t
    return { ...t, params: t.params.slice(1) }
}

/** The metamethods a class method can be, and how many operands each takes
 *  besides the instance; `undefined` for any number. */
const METAMETHOD_OPERANDS: Record<string, number | undefined> = {
    __add: 1, __sub: 1, __mul: 1, __div: 1, __idiv: 1, __mod: 1, __pow: 1, __concat: 1,
    __eq: 1, __lt: 1, __le: 1,
    __unm: 0, __len: 0, __tostring: 0, __iter: 0,
    __call: undefined,
}

/** What Luau does with a metamethod's answer, where it does anything. */
const METAMETHOD_RETURNS: Record<string, Type> = {
    __tostring: stringType, __eq: booleanType, __lt: booleanType, __le: booleanType,
}

/** Every `this.name` a block assigns, anywhere in it. */
function assignedFields(block: Block): Set<string> {
    const names = new Set<string>()
    walkNodes(block, node => {
        const record = node as { type?: string; target?: unknown }
        if (record.type !== "AssignmentStatement" && record.type !== "CompoundAssignmentStatement") return
        const member = record.target as { type?: string; object?: { type?: string; name?: string }; property?: { name?: string } }
        if (member.type === "MemberExpression" && member.object?.type === "Identifier" &&
            member.object.name === "this" && member.property?.name) {
            names.add(member.property.name)
        }
    })
    return names
}

/** Every node under `root`, spans excepted. */
function walkNodes(root: unknown, visit: (node: object) => void): void {
    if (!root || typeof root !== "object") return
    if (Array.isArray(root)) {
        for (const item of root) walkNodes(item, visit)
        return
    }
    visit(root)
    for (const [key, value] of Object.entries(root)) {
        if (key !== "line" && key !== "column" && value && typeof value === "object") walkNodes(value, visit)
    }
}

/** A named type: a `type` alias, or a `declare class` (whose `node` is its
 *  body). */
interface AliasDef {
    params: GenericTypeParameter[]
    node: TypeNode
    class?: DeclareClassStatement
    /** A `class ... end` written in the file: the name is its *instance*
     *  type, nominal in the same way a `declare class` is. */
    runtimeClass?: ClassDeclaration
}

/** A map of types where an entry can be registered before its type exists:
 *  `get` resolves it on first use. Everything else a `Map` does works as
 *  usual, so a caller cannot tell — except in what it costs. The public alias
 *  map is one, and so is `bindingType`, for the globals a library declares. */
class LazyMap<K> extends Map<K, Type> {
    private readonly pending = new Map<K, () => Type>()

    defer(name: K, resolve: () => Type): void {
        super.delete(name)
        this.pending.set(name, resolve)
    }

    override get(name: K): Type | undefined {
        const resolved = super.get(name)
        if (resolved !== undefined) return resolved
        const resolve = this.pending.get(name)
        if (!resolve) return undefined
        this.pending.delete(name)
        const type = resolve()
        super.set(name, type)
        return type
    }

    override has(name: K): boolean {
        return super.has(name) || (this.pending?.has(name) ?? false)
    }

    override set(name: K, type: Type): this {
        this.pending?.delete(name)
        return super.set(name, type)
    }

    override delete(name: K): boolean {
        const deferred = this.pending?.delete(name) ?? false
        return super.delete(name) || deferred
    }

    override get size(): number {
        return super.size + (this.pending?.size ?? 0)
    }

    override keys(): ReturnType<Map<K, Type>["keys"]> {
        return new Map([...super.keys(), ...(this.pending?.keys() ?? [])].map(k => [k, undefined as unknown as Type] as const)).keys()
    }

    private resolvedEntries(): [K, Type][] {
        return [...this.keys()].map((name): [K, Type] => [name, this.get(name)!])
    }

    override entries(): ReturnType<Map<K, Type>["entries"]> {
        return new Map(this.resolvedEntries()).entries()
    }

    override values(): ReturnType<Map<K, Type>["values"]> {
        return new Map(this.resolvedEntries()).values()
    }

    override forEach(callback: (value: Type, key: K, map: Map<K, Type>) => void, thisArg?: unknown): void {
        for (const [name, type] of this.entries()) callback.call(thisArg, type, name, this)
    }

    override [Symbol.iterator](): ReturnType<Map<K, Type>[typeof Symbol.iterator]> {
        return this.entries()
    }
}

function unwrapParens(e: Expression): Expression {
    while (e.type === "ParenthesizedExpression") e = e.expression
    return e
}

/** How a diagnostic names an expression: `a.b:c("x")`. `undefined` for
 *  anything too complex to name briefly. */
function expressionLabel(e: Expression, depth = 0): string | undefined {
    if (depth > 6) return undefined
    const args = (list: Expression[]): string => {
        const parts = list.map(a =>
            a.type === "StringLiteral" ? JSON.stringify(a.value)
            : a.type === "NumberLiteral" ? a.raw
            : a.type === "Identifier" ? a.name
            : undefined)
        return parts.every(p => p !== undefined) && parts.join(", ").length <= 40 ? `(${parts.join(", ")})` : "(...)"
    }
    switch (e.type) {
        case "Identifier": return e.name
        case "MemberExpression": {
            const o = expressionLabel(e.object, depth + 1)
            return o === undefined ? undefined : `${o}${e.optional ? "?." : "."}${e.property.name}`
        }
        case "MethodCallExpression": {
            const o = expressionLabel(e.object, depth + 1)
            return o === undefined ? undefined : `${o}${e.optional ? "?:" : ":"}${e.method.name}${args(e.arguments)}`
        }
        case "CallExpression": {
            const o = expressionLabel(e.callee, depth + 1)
            return o === undefined ? undefined : `${o}${e.optional ? "?." : ""}${args(e.arguments)}`
        }
        case "IndexExpression": {
            const o = expressionLabel(e.object, depth + 1)
            const i = e.index.type === "StringLiteral" ? JSON.stringify(e.index.value)
                : e.index.type === "NumberLiteral" ? e.index.raw
                : e.index.type === "Identifier" ? e.index.name
                : "..."
            return o === undefined ? undefined : `${o}${e.optional ? "?." : ""}[${i}]`
        }
        case "ParenthesizedExpression": {
            const inner = expressionLabel(e.expression, depth + 1)
            return inner === undefined ? undefined : `(${inner})`
        }
        default: return undefined
    }
}

/** `t` with `nil` removed: what an optional link reads from. */
function withoutNil(t: Type): Type {
    if (t.kind !== "union") return t.kind === "primitive" && t.name === "nil" ? neverType : t
    return union(t.types.filter(m => !(m.kind === "primitive" && m.name === "nil")))
}

/** The metamethod each binary operator calls. */
const METAMETHODS: Record<string, string> = {
    "+": "__add", "-": "__sub", "*": "__mul", "/": "__div", "//": "__idiv",
    "%": "__mod", "^": "__pow", "..": "__concat",
}

function posKey(name: string, line: number, column: number): string {
    return `${name}@${line}:${column}`
}

// ============================================================
// Analyzer
// ============================================================

class TypeAnalyzer {
    private readonly typeOf = new Map<Expression, Type>()
    private readonly bindingType = new LazyMap<BindingId>()
    private readonly narrowedTypeOf = new Map<Identifier, Type>()
    private readonly typeOfTypeNode = new Map<TypeNode, Type>()
    private readonly expectedTypeOf = new Map<Expression, Type>()
    private readonly loops = new Map<GenericForStatement, LoopForm>()
    /** Public: each alias resolved once (generic aliases keep their params as
     *  `typeParam` nodes in the body). */
    private readonly aliases = new LazyMap<string>()
    /** Uninstantiated alias definitions, for `Name<Args>` instantiation. */
    private readonly aliasDefs = new Map<string, AliasDef>()
    /** Put on every ref to one of `aliasDefs`, so a module that imports the
     *  type expands the ref here rather than by its name there. */
    private readonly origin: TypeOrigin = { expand: t => this.expand(t) }
    /** See `resolveClass`. Shared with other analyses over the same libraries
     *  when none of their names is redefined here; see `shareableClasses`. */
    private classTypes = new WeakMap<DeclareClassStatement, ObjectType>()
    /** See `instanceType` — one instance type per `class ... end`. */
    private readonly instanceTypes = new WeakMap<ClassLike, ObjectType>()
    private classMembers = new WeakMap<ObjectType, () => { properties: Map<string, ObjectProperty>; indexer: ObjectType["indexer"] } | undefined>()
    /** Generic parameters currently in lexical scope (alias body / generic fn),
     *  with their `extends` constraints resolved. */
    private readonly typeParamScope: { name: string; constraint?: Type; isConst?: boolean }[] = []
    /** Global types contributed by `declare` statements (libs, then this program).
     *  A library's are resolved when the name is first used: an engine's
     *  definitions declare hundreds of globals, and a script uses a few. */
    private readonly libGlobalTypes = new LazyMap<string>()
    /** Each library `declare` of a name, in order, until it is resolved. */
    private readonly libDeclares = new Map<string, DeclareStatement[]>()
    /** Declaration node -> binding, built once so `bindingIdByName` is O(1)
     *  instead of a scan of every binding per declaration site. */
    private readonly bindingByDecl = new Map<object, BindingId>()
    /** Fallback index for the same lookup, keyed by `name@line:column` — used
     *  when the caller holds a different node object at the same source span. */
    private readonly bindingByPos = new Map<string, BindingId>()
    /** Bindings whose type came from an explicit annotation (vs. inferred from
     *  the initializer) — reassignment narrows within these, but replaces the
     *  inferred type of an un-annotated binding. */
    private readonly annotated = new Set<BindingId>()
    /** Guard against runaway recursive alias instantiation. */
    private instantiationDepth = 0
    /** Guard against a self-referential type-level operator. */
    private reduceDepth = 0
    /** One entry per enclosing loop: the flow states its `break`s jump from. */
    private readonly breakStates: FlowEnv[][] = []
    /** Memoised `reduceType`, keyed by type identity. */
    private readonly reduceCache = new WeakMap<object, Type>()
    /** Resolved alias bodies, keyed by reference. See `expand`. */
    private readonly expandCache = new Map<string, Type>()
    /** Alias names currently being resolved — a re-entry means a recursive type
     *  (`type Tree = { children: Tree[] }`); it resolves to a nominal ref. */
    private readonly resolvingAliases = new Set<string>()
    private readonly diagnostics: TypeDiagnostic[] = []
    /** `import`ed type names, from `resolveModule`. */
    private readonly importedTypes = new Map<string, ExportedType>()
    /** `resolveModule` results, one lookup per module path. */
    private readonly resolvedModules = new Map<string, ModuleExports | undefined>()
    private emitDiagnostics: boolean
    /** Recursion guard for `preVisitBody`. */
    private preVisitDepth = 0

    constructor(
        private readonly program: Program,
        private readonly scopes: ScopeAnalysis,
        private readonly options: AnalyzeTypesOptions,
    ) {
        this.emitDiagnostics = options.diagnostics ?? true
    }

    run(): TypeAnalysis {
        // A definitions file's classes resolve to the same types for every
        // file checked against it, so long as this one does not give any of
        // its names a meaning of its own. When it does not, they are resolved
        // once and shared: a project of forty files then reads the Roblox
        // class it names once rather than forty times.
        const shared = shareableClasses(this.options.libs ?? [], this.program)
        if (shared) {
            this.classTypes = shared.classTypes
            this.classMembers = shared.classMembers
        }
        // The language's own types, then definitions files, then this program
        // — so aliases resolve against the full set, and a later declaration
        // of a name wins over an earlier one.
        this.registerAliasDefs(preludeProgram().body, true)
        for (const lib of this.options.libs ?? []) this.registerAliasDefs(lib.body, true)
        this.registerAliasDefs(this.program.body)
        this.registerNestedClasses()
        this.registerNestedAliases()
        for (const lib of this.options.libs ?? []) this.harvestDeclares(lib.body)
        // Imported type names must be known before any annotation resolves.
        this.registerImportedTypes()
        this.resolveAllAliases()
        // A `declare` in the program itself seeds a global type too, and wins
        // over a lib's declaration of the same name. Its type may name the
        // file's imports and aliases, so it is read after them — and one that
        // needs a value's type (`declare r: typeof x`) when first used.
        this.harvestDeclares(this.program.body, true)
        this.indexDeclarations()

        // Seed global binding types.
        for (const [name, id] of this.scopes.globalsByName) {
            if (this.deferredDeclares.has(name) && !this.options.globalTypes?.[name]) continue
            const given = this.options.globalTypes?.[name]
            if (given) this.bindingType.set(id, given)
            else if (this.libGlobalTypes.has(name)) this.bindingType.defer(id, () => this.libGlobalTypes.get(name) ?? anyType)
            // What the script was started with, whatever it was.
            else if (LANGUAGE_GLOBALS.includes(name)) this.bindingType.set(id, arrayOf(unknownType))
            else this.bindingType.set(id, anyType)
        }
        // Let structural comparison see through nominal alias references —
        // unavoidable for recursive types such as a class hierarchy.
        setAliasExpander(t => this.expand(t))
        setDeferredBound(t => this.deferredBound(t))
        try {
            const env: FlowEnv = new Map()
            this.visitBlock(this.program.body, env)
            this.resolveDeferredDeclares()
            if (this.options.reportUnknownTypes) this.reportUnknownTypes()
        } finally {
            setAliasExpander(undefined)
            setDeferredBound(undefined)
        }
        return {
            typeOf: this.typeOf,
            bindingType: this.bindingType,
            narrowedTypeOf: this.narrowedTypeOf,
            typeOfTypeNode: this.typeOfTypeNode,
            expectedTypeOf: this.expectedTypeOf,
            aliases: this.resolveDeferredAliases(),
            loops: this.loops,
            diagnostics: this.diagnostics,
        }
    }

    // --------------------------------------------------------
    // Aliases
    // --------------------------------------------------------

    private moduleFor(specifier: string): ModuleExports | undefined {
        if (!this.resolvedModules.has(specifier)) {
            this.resolvedModules.set(specifier, this.options.resolveModule?.(specifier))
        }
        return this.resolvedModules.get(specifier)
    }

    /** `export ... from "./x"`: the module must exist, and so must each name. */
    private checkReexport(source: Expression & { value: string }, names: readonly Identifier[]): void {
        if (!this.options.resolveModule || !this.emitDiagnostics) return
        const exports = this.moduleFor(source.value)
        if (!exports) {
            this.diagnostics.push({ node: source, message: `Cannot find module '${source.value}'` })
            return
        }
        if (exports.partial) return
        for (const name of names) {
            const found = name.name === "default"
                ? exports.default !== undefined
                : exports.values.has(name.name) || exports.types.has(name.name)
            if (!found) {
                this.diagnostics.push({ node: name, message: `Module '${source.value}' has no exported member '${name.name}'` })
            }
        }
    }

    private registerImportedTypes(): void {
        if (!this.options.resolveModule) return
        for (const stmt of this.program.body.statements) {
            if (stmt.type !== "ImportStatement") continue
            const exports = this.moduleFor(stmt.source.value)
            if (!exports) continue
            // `import * as Shapes`: every exported type, as `Shapes.Circle`.
            if (stmt.namespaceImport) {
                for (const [name, exported] of exports.types) {
                    const qualified = `${stmt.namespaceImport.name}.${name}`
                    this.importedTypes.set(qualified, exported)
                    this.aliases.set(qualified, exported.type)
                }
            }
            // `import Box from "./box"` where the default export is a class:
            // the name stands for the instance type too, as in TypeScript.
            const asDefault = stmt.defaultImport && exports.types.get("default")
            if (stmt.defaultImport && asDefault) {
                this.importedTypes.set(stmt.defaultImport.name, asDefault)
                this.aliases.set(stmt.defaultImport.name, asDefault.type)
            }
            for (const s of stmt.specifiers) {
                const exported = exports.types.get(s.imported.name)
                if (exported) {
                    this.importedTypes.set(s.local.name, exported)
                    // Listed with the aliases: to hover, completion and
                    // highlighting an imported type is a type like any other.
                    // A local alias of the same name replaces it when the
                    // aliases resolve.
                    this.aliases.set(s.local.name, exported.type)
                }
            }
        }
    }

    /** `layering` is on for the prelude and for definitions files: a second
     *  library that declares an alias already declared *adds* to it, the way a
     *  second `declare` of a table's name does, so `@tilua-types/roblox` can give
     *  `StringMethods` Luau's `split` without restating Lua's. The file being
     *  analysed is not a layer: its own alias replaces what the libraries
     *  gave, which is how a project opts out of a set. */
    private registerAliasDefs(block: Block, layering = false): void {
        for (const stmt of block.statements) {
            const alias = stmt.type === "TypeAliasStatement" ? stmt
                : stmt.type === "ExportTypeAliasStatement" ? stmt.alias
                : undefined
            if (alias) {
                const previous = layering ? this.aliasDefs.get(alias.name.name) : undefined
                const node = previous && !previous.class
                    ? ({
                        type: "IntersectionTypeNode",
                        types: [previous.node, alias.definition],
                        line: alias.definition.line,
                        column: alias.definition.column,
                    } as TypeNode)
                    : alias.definition
                this.aliasDefs.set(alias.name.name, {
                    params: previous && !previous.class && previous.params.length ? previous.params : alias.generics,
                    node,
                })
            }
            if (stmt.type === "DeclareClassStatement") {
                this.aliasDefs.set(stmt.name.name, { params: [], node: stmt.body, class: stmt })
            }
            // A class declares a type as well as a value: the name of the
            // class is the type of its instances.
            const declaration = stmt.type === "ExportStatement" || stmt.type === "ExportDefaultStatement"
                ? stmt.declaration
                : stmt
            if (declaration.type === "ClassDeclaration") this.registerClass(declaration)
        }
    }

    /** A class written inside a function or a block names a type too — its
     *  own instances', which its methods' `this` is annotated with. Type names
     *  are one namespace here, so it is registered with the rest; only a
     *  second class of the same name would notice. */
    private registerNestedClasses(): void {
        walkNodes(this.program.body, node => {
            const record = node as { type?: string }
            if (record.type !== "ClassDeclaration") return
            const declaration = node as unknown as ClassDeclaration
            if (this.aliasDefs.has(declaration.name.name)) return
            this.registerClass(declaration)
        })
    }

    /** A `type` alias written inside a function or block. The alias table is
     *  keyed by bare name, so — as for a nested class — the alias is hoisted
     *  into it and an outer name of the same spelling wins, rather than the
     *  inner one being invisible and read as `Cannot find name`. */
    private registerNestedAliases(): void {
        walkNodes(this.program.body, node => {
            const record = node as { type?: string }
            const alias = record.type === "TypeAliasStatement"
                ? node as unknown as TypeAliasStatement
                : record.type === "ExportTypeAliasStatement"
                    ? (node as unknown as ExportTypeAliasStatement).alias
                    : undefined
            if (!alias || this.aliasDefs.has(alias.name.name)) return
            this.aliasDefs.set(alias.name.name, { params: alias.generics, node: alias.definition })
        })
    }

    /** A class's name as a type. `node` is a placeholder: `resolveDef` and
     *  `instantiateAlias` both go to the declaration itself. */
    private registerClass(declaration: ClassDeclaration): void {
        this.aliasDefs.set(declaration.name.name, {
            params: declaration.typeParams,
            node: {
                type: "TableTypeNode", properties: [],
                line: declaration.line, column: declaration.column,
            } as unknown as TypeNode,
            runtimeClass: declaration,
        })
    }

    /** A non-generic definition's type. */
    private resolveDef(def: AliasDef): Type {
        if (def.runtimeClass) return this.instanceType(def.runtimeClass)
        return def.class ? this.classType(def.class) : this.resolveType(def.node)
    }

    /** One type per class declaration, so every mention of a class is the same
     *  object — its own members included, which refer back to it. */
    private classType(stmt: DeclareClassStatement): ObjectType {
        return this.classTypes.get(stmt) ?? this.resolveClass(stmt)
    }

    /** A class's members are resolved the first time anyone asks for
     *  `properties` — its own from its body, the inherited ones from its
     *  superclass.
     *
     *  Both have to wait. A definitions file for a whole engine declares
     *  thousands of classes that all refer to one another; resolving each body
     *  as soon as the class is named would resolve every class on every
     *  analysis, when a script touches a handful. And classes refer to one
     *  another constantly — `Object.IsA` mentions a map of every class, each
     *  of which extends `Object` — so while one class resolves, one it extends
     *  may itself be half-resolved; copying its members then would miss some
     *  for good. */
    private resolveClass(stmt: DeclareClassStatement): ObjectType {
        const name = stmt.name.name
        const { ancestors, cyclic } = this.classChain(stmt)
        // A class that (indirectly) extends itself inherits nothing; the
        // declaration is reported where it is written.
        const superclass = !cyclic && ancestors.length > 1
            ? this.aliasDefs.get(ancestors[1])?.class
            : undefined

        type Members = { properties: Map<string, ObjectProperty>; indexer: ObjectType["indexer"] }
        let own: ObjectType | undefined
        let resolvingOwn = false
        const ownMembers = (): ObjectType | undefined => {
            if (own || resolvingOwn) return own
            resolvingOwn = true
            try {
                own = this.resolveType(stmt.body) as ObjectType
            } finally {
                resolvingOwn = false
            }
            return own
        }
        let complete: Members | undefined
        // Every member, or `undefined` while this class or one it extends is
        // still being resolved — asked again on the next access, not cached.
        const members = (): Members | undefined => {
            if (complete) return complete
            const mine = ownMembers()
            if (!mine) return undefined
            const base: Members | undefined = superclass ? this.classMembers.get(this.classType(superclass))?.() : undefined
            if (superclass && !base) return undefined
            return (complete = {
                properties: new Map([...(base?.properties ?? []), ...mine.properties]),
                indexer: mine.indexer ?? base?.indexer,
            })
        }

        const type = { kind: "object", name, class: { name, superclass: superclass?.name.name, ancestors } } as unknown as ObjectType
        Object.defineProperties(type, {
            properties: { enumerable: true, get: () => members()?.properties ?? own?.properties ?? new Map() },
            indexer: { enumerable: true, get: () => members()?.indexer ?? own?.indexer },
        })
        this.classTypes.set(stmt, type)
        this.classMembers.set(type, members)
        // A class declared in the file being analysed is resolved now, so its
        // members' annotations are recorded for hover like any other type.
        if (this.program.body.statements.includes(stmt)) ownMembers()
        return type
    }

    // ============================================================
    // `class ... end` — the runtime kind
    // ------------------------------------------------------------
    // A declaration says two things at once. Its *name as a type* is
    // the type of its instances, nominal the way `declare class` is:
    // only the class and the classes extending it produce one. Its
    // *name as a value* is the class table — the statics, the class
    // it extends (`ParentClass`), and the `new` that builds an
    // instance, which is an ordinary function and can be called as
    // one. An instance reaches its own class back through
    // `ClassObject`.
    //
    // Members are resolved into one shape, filled in two passes: the
    // fields first, then the functions. That order is what lets a
    // method body read `this.x` while the class it belongs to is
    // still being worked out.
    // ============================================================

    private readonly classShapes = new WeakMap<ClassLike, ClassShape>()
    private readonly classValues = new WeakMap<ClassLike, ObjectType>()
    /** Identity for a class written as a value, which has no name to be known
     *  by: two of them are different types however alike they look. */
    private readonly classIdentities = new WeakMap<ClassLike, string>()
    private classIdentityCount = 0
    /** The class whose members are being read, so `super` knows its base. */
    private currentClass?: ClassLike

    /** Every class whose body the checker is inside, innermost last — what
     *  decides whether a `private` member may be reached. */
    private readonly enclosingClasses: ClassLike[] = []

    private withClass<T>(stmt: ClassLike, fn: () => T): T {
        const previous = this.currentClass
        this.currentClass = stmt
        this.enclosingClasses.push(stmt)
        try {
            return fn()
        } finally {
            this.currentClass = previous
            this.enclosingClasses.pop()
        }
    }

    /** What the class is known by. A declaration is known by its name, the way
     *  a `declare class` is — that is what makes it the same class across
     *  modules. A class written as a value is known by where it is written. */
    private classIdentity(stmt: ClassLike): string {
        if (stmt.type === "ClassDeclaration") return stmt.name.name
        let identity = this.classIdentities.get(stmt)
        if (!identity) {
            identity = `${stmt.name?.name ?? "class"}@${++this.classIdentityCount}`
            this.classIdentities.set(stmt, identity)
        }
        return identity
    }

    /** What it is *shown* as. A class written as a value has no name of its
     *  own, so it borrows the one it is being bound to — `const Counter =
     *  class ... end` reads as `Counter` everywhere. */
    private className(stmt: ClassLike): string {
        return stmt.name?.name ?? this.classDisplayNames.get(stmt) ?? "(class)"
    }

    private readonly classDisplayNames = new WeakMap<ClassLike, string>()

    /** `const Name = class ... end` — the name the class will be known by. */
    private nameClassExpressions(stmt: VariableDeclaration): void {
        const value = stmt.init
        if (stmt.name.type === "IdentifierPattern" && value?.type === "ClassExpression" && !value.name) {
            this.classDisplayNames.set(value, stmt.name.name)
        }
    }

    private classTypeParams(stmt: ClassLike): readonly GenericTypeParameter[] {
        return stmt.type === "ClassDeclaration" ? stmt.typeParams : []
    }

    /** The class a declaration extends, when it is one written in this file.
     *  An imported class is reached through its type and its value instead. */
    private superDecl(stmt: ClassLike): ClassLike | undefined {
        if (!stmt.superclass) return undefined
        const base = this.aliasDefs.get(stmt.superclass.name)?.runtimeClass
        return base && base !== stmt && !this.extendsThrough(base, stmt) ? base : undefined
    }

    /** Does `from` reach `target` by `extends`? Guards against a cycle turning
     *  resolution into a loop. */
    private extendsThrough(from: ClassLike, target: ClassLike): boolean {
        const seen = new Set<ClassLike>()
        for (let cls: ClassLike | undefined = from; cls && !seen.has(cls);) {
            if (cls === target) return true
            seen.add(cls)
            cls = cls.superclass ? this.aliasDefs.get(cls.superclass.name)?.runtimeClass : undefined
        }
        return false
    }

    /** The instance type of what `stmt` extends, with the arguments it was
     *  extended with filled in — a class in this file, or any class type a
     *  name in scope stands for (an imported one). */
    private baseInstance(stmt: ClassLike): ObjectType | undefined {
        if (!stmt.superclass) return undefined
        const written = (stmt.superArguments ?? []).map(argument => this.resolveType(argument))
        // A class written here: what it extends is settled by the declarations,
        // and a chain that closes on itself inherits nothing. Asking the alias
        // map instead would walk that same circle forever.
        if (this.aliasDefs.get(stmt.superclass.name)?.runtimeClass) {
            const local = this.superDecl(stmt)
            if (!local) return undefined
            const base = this.instanceType(local)
            const params = this.classTypeParams(local)
            if (!params.length) return base
            const applied = substitute(base, this.bindTypeArguments(params, written))
            return applied.kind === "object" ? applied : undefined
        }
        const imported = this.importedTypes.get(stmt.superclass.name)
        const named = imported
            ? this.importedType(imported, stmt.superArguments ?? [])
            : this.aliases.get(stmt.superclass.name)
        // Only a class: extending a plain shape would give instances a type no
        // table literal could be mistaken for, which a structural alias is not.
        return named && isClassType(named) ? named : undefined
    }

    /** One instance type per declaration, so every mention of the class is the
     *  same object — the `this` of its own methods included. Members are read
     *  lazily for the reason `declare class` reads them lazily: a class can
     *  name itself, and two classes can name each other. */
    private instanceType(stmt: ClassLike): ObjectType {
        const cached = this.instanceTypes.get(stmt)
        if (cached) return cached
        const name = this.className(stmt)
        const identity = this.classIdentity(stmt)
        const params = this.classTypeParams(stmt)
        const type = { kind: "object", name } as unknown as ObjectType
        this.instanceTypes.set(stmt, type)

        // Its own parameters stand for themselves until something instantiates
        // them — `Box<T>` is what `Box`'s own methods see.
        const own: readonly Type[] = params.map(p =>
            typeParam(p.name, p.constraint ? this.resolveType(p.constraint) : undefined))
        const info = (): ClassInfo => {
            const base = this.baseInstance(stmt)?.class
            const typeArguments = new Map<string, readonly Type[]>(base?.typeArguments ?? [])
            if (own.length) typeArguments.set(identity, own)
            return {
                name: identity,
                superclass: base?.name,
                ancestors: [identity, ...(base?.ancestors ?? [])],
                typeArguments: typeArguments.size ? typeArguments : undefined,
            }
        }
        Object.defineProperties(type, {
            properties: {
                enumerable: true,
                get: () => {
                    const shape = this.shapeOf(stmt)
                    const base = this.baseInstance(stmt)?.properties
                    const members = base?.size ? new Map([...base, ...shape.instance]) : new Map(shape.instance)
                    // An instance reaches its own class. The class table lives
                    // on the other side of the metatable, so this costs the
                    // instance nothing.
                    members.set("ClassObject", { type: this.classValueType(stmt), optional: false, readonly: true })
                    return members
                },
            },
            class: { enumerable: true, get: info },
        })
        return type
    }

    /** `Box<T>` as its own methods see it — a reference, not the object, so
     *  substituting the arguments in does not have to walk the class. */
    private selfTypeOf(stmt: ClassLike): Type {
        const params = this.classTypeParams(stmt)
        if (!params.length || stmt.type !== "ClassDeclaration") return this.instanceType(stmt)
        return {
            kind: "genericRef",
            name: stmt.name.name,
            typeArguments: params.map(p => typeParam(p.name, p.constraint ? this.resolveType(p.constraint) : undefined)),
            origin: this.origin,
        }
    }

    /** The class table: the statics, what it inherits from the class it
     *  extends, `ParentClass`, `ClassObject`, and `new`. */
    private classValueType(stmt: ClassLike): ObjectType {
        const cached = this.classValues.get(stmt)
        if (cached) return cached
        const type = objectType([])
        // The class table names itself (`ClassObject`), so it is published
        // before its members are filled in.
        this.classValues.set(stmt, type)
        type.name = `typeof ${this.className(stmt)}`

        const shape = this.shapeOf(stmt)
        const local = this.superDecl(stmt)
        const parent = local ? this.classValueType(local)
            : stmt.superclass ? this.classStaticsOf(stmt.superclass)
            : undefined
        // The statics are inherited; `new` and the links are each class's own.
        if (parent?.kind === "object") {
            for (const [key, property] of parent.properties) {
                if (!CLASS_LINKS.has(key)) type.properties.set(key, property)
            }
        }
        for (const [key, property] of shape.statics) type.properties.set(key, property)
        // Asked for while the members are still being read — a static whose
        // body names the class — the statics so far are all there is yet;
        // the rest are added when the reading is done.
        if (shape.filling) {
            (shape.filled ??= []).push(() => {
                for (const [key, property] of shape.statics) type.properties.set(key, property)
            })
        }

        // `new` is the class's own generic function: `Box.new(1)` reads `T`
        // off the argument the way any other call would, and
        // `Box.new<string>` says it outright. It hands back a *reference* to
        // the instance type, never the object — which is what keeps
        // instantiating one from having to walk the class it belongs to.
        //
        // What it takes is the constructor's, which is only known once the
        // class's members are: the class table can be asked for while they
        // are still being read (a constructor body touching `this`), so the
        // signature is worked out when first read, and kept once it can be.
        const params = this.classTypeParams(stmt)
        let settled: Type | undefined
        const construct = {
            optional: false,
            readonly: true,
            // Kept, so a class extending it can read what it takes; reaching
            // it from outside is the error.
            ...(stmt.isAbstract ? { abstract: true } : {}),
        } as ObjectProperty
        Object.defineProperty(construct, "type", {
            enumerable: true,
            get: (): Type => {
                if (settled) return settled
                const constructor = this.constructorType(stmt)
                const made = fn(
                    constructor?.params.filter(p => p.name !== "this") ?? [],
                    this.selfTypeOf(stmt),
                    constructor?.varargs,
                    params.map(p => p.name),
                )
                if (!this.shapeOf(stmt).filling) settled = made
                return made
            },
        })
        type.properties.set("new", construct)
        type.properties.set("ParentClass", { type: parent ?? nilType, optional: false, readonly: true })
        return type
    }

    /** The value side of the class `superclass` names when it is not
     *  declared in this file: what the name it refers to holds — an import
     *  brings the class table with it — or else a class of that name. */
    private classStaticsOf(superclass: Identifier): Type | undefined {
        const id = this.bindingIdOf(superclass)
        const bound = id !== undefined ? this.expand(this.bindingType.get(id) ?? unknownType) : undefined
        if (bound?.kind === "object") return bound
        return this.classStaticsByNameType(superclass.name)
    }

    /** The value side of a class named by a binding rather than by a
     *  declaration in this file — an imported one. */
    private classStaticsByNameType(name: string): Type | undefined {
        const id = this.classBindingByName(name)
        const declared = id !== undefined ? this.bindingType.get(id) : undefined
        return declared?.kind === "object" ? declared : undefined
    }

    /** The binding a class name stands for, wherever it was declared. */
    private classBindingByName(name: string): BindingId | undefined {
        for (const [id, binding] of this.scopes.bindings) {
            if (binding.name === name && binding.declaredBy === "class") return id
        }
        return this.scopes.globalsByName.get(name)
    }

    /** What `super(...)` takes: the constructor of the class `stmt` extends,
     *  its own skipped. */
    private baseConstructorType(stmt: ClassLike): FunctionType | undefined {
        return this.constructorType(stmt, new Set([stmt]))
    }

    /** A class's constructor signature — its own, or the one it inherits. */
    private constructorType(stmt: ClassLike, seen = new Set<ClassLike>()): FunctionType | undefined {
        if (seen.has(stmt)) return undefined
        seen.add(stmt)
        const own = this.shapeOf(stmt).ctor
        if (own) return own
        const local = this.superDecl(stmt)
        if (local) return this.constructorType(local, seen)
        // An imported base: its `new` says what it takes.
        const parent = stmt.superclass ? this.classStaticsByNameType(stmt.superclass.name) : undefined
        const inherited = parent && this.overloadsOf(this.propertyType(parent, "new"))[0]
        return inherited
    }

    /** `super` as a value: the base class's instance members with the `this`
     *  slot already filled, because `super.m(a)` passes this instance. */
    private superType(stmt: ClassLike): Type {
        const base = this.baseInstance(stmt)
        if (!base) return anyType
        const entries: [string, ObjectProperty][] = []
        for (const [name, property] of base.properties) {
            const bound = this.overloadsOf(property.type)
            entries.push([name, bound.length
                ? {
                    ...property,
                    type: intersection(bound.map(f =>
                        (this.takesSelf(f) ? fn(f.params.slice(1), f.returns, f.varargs, f.typeParams) : f))),
                }
                : property])
        }
        return objectType(entries)
    }

    private shapeOf(stmt: ClassLike): ClassShape {
        const cached = this.classShapes.get(stmt)
        if (cached) return cached
        const shape: ClassShape = { instance: new Map(), statics: new Map(), filling: true }
        // Published before it is filled: a method reading `this.x` asks for
        // this same map, and the fields are already in it by then.
        this.classShapes.set(stmt, shape)
        const wasEmitting = this.emitDiagnostics
        this.emitDiagnostics = false
        try {
            this.withClass(stmt, () => this.withTypeParams(this.classTypeParams(stmt), () => {
                this.withSelfType(this.selfTypeOf(stmt), () => this.fillShape(stmt, shape))
            }))
        } finally {
            this.emitDiagnostics = wasEmitting
            shape.filling = false
            for (const then of shape.filled ?? []) then()
            shape.filled = undefined
        }
        return shape
    }

    private fillShape(stmt: ClassLike, shape: ClassShape): void {
        const className = this.className(stmt)
        const put = (isStatic: boolean, name: string, property: ObjectProperty): void => {
            const member = stmt.members.find((m): m is Exclude<ClassMember, { type: "ClassConstructor" }> =>
                m.type !== "ClassConstructor" && m.isStatic === isStatic
                && m.name.name === name && (m.accessibility === "private" || m.accessibility === "protected"))
            const marked = member
                ? { ...property, private: { owner: stmt, className, ...(member.accessibility === "protected" ? { protected: true } : {}) } }
                : property
            ;(isStatic ? shape.statics : shape.instance).set(name, marked)
        }
        // Fields first: a method's body can then read them.
        for (const member of stmt.members) {
            if (member.type !== "ClassField") continue
            const type = member.typeAnnotation
                ? this.resolveType(member.typeAnnotation)
                : member.init
                    ? widen(this.infer(member.init, new Map()))
                    : anyType
            put(member.isStatic, member.name.name, {
                type, optional: false, ...(member.isReadonly ? { readonly: true } : {}),
            })
        }
        for (const member of stmt.members) {
            switch (member.type) {
                case "ClassField":
                    break
                case "ClassMethod": {
                    this.paramsFromSignatures(member.func, member.signatures)
                    const type = member.signatures?.length
                        ? intersection(member.signatures.map(sig => this.signatureToFnType(sig)))
                        : this.inferFunctionBody(member.func, new Map())
                    put(member.isStatic, member.name.name, {
                        type, optional: false, ...(member.isAbstract ? { abstract: true } : {}),
                    })
                    break
                }
                case "ClassAccessor": {
                    const signature = this.inferFunctionBody(member.func, new Map())
                    if (signature.kind !== "function") break
                    const target = member.isStatic ? shape.statics : shape.instance
                    const existing = target.get(member.name.name)
                    if (member.kind === "get") {
                        // Readable; writable only if a setter is written too.
                        put(member.isStatic, member.name.name, {
                            type: signature.returns,
                            optional: false,
                            readonly: existing === undefined || existing.readonly !== false,
                        })
                    } else {
                        put(member.isStatic, member.name.name, {
                            type: existing?.type ?? signature.params[signature.params.length - 1]?.type ?? anyType,
                            optional: false,
                            readonly: false,
                        })
                    }
                    break
                }
                case "ClassConstructor": {
                    const signature = this.inferFunctionBody(member.func, new Map())
                    if (signature.kind === "function") shape.ctor = signature
                    break
                }
            }
        }
    }

    /** Bind the class's value, and check what its members say. Shared by the
     *  declaration and the expression forms. */
    private visitClass(stmt: ClassLike, env: FlowEnv): ObjectType {
        this.checkClassDeclaration(stmt)
        const value = this.classValueType(stmt)
        this.withClass(stmt, () => this.withTypeParams(this.classTypeParams(stmt), () => {
            this.withSelfType(this.selfTypeOf(stmt), () => {
                for (const member of stmt.members) {
                    if (member.type === "ClassField") {
                        if (!member.init) continue
                        const declared = member.typeAnnotation ? this.resolveType(member.typeAnnotation) : undefined
                        if (declared) this.applyContext(member.init, declared)
                        const actual = this.infer(member.init, env)
                        if (declared && this.emitDiagnostics && !isAssignable(actual, declared)) {
                            this.diagnostics.push({
                                node: member.init,
                                message: `Type '${briefType(actual)}' is not assignable to type '${briefType(declared)}'`
                                    + this.explainMismatch(actual, declared),
                            })
                        }
                        continue
                    }
                    this.checkParamOrder(member.func.params, member)
                    for (const signature of (member as { signatures?: FunctionSignature[] }).signatures ?? []) {
                        this.checkParamOrder(signature.params, member)
                    }
                    // An abstract method is a head: there is no body to check.
                    if (member.type === "ClassMethod" && member.isAbstract) continue
                    const constructing = this.constructing
                    if (member.type === "ClassConstructor") this.constructing = stmt
                    try {
                        this.visitFunctionBody(member.func, env)
                    } finally {
                        this.constructing = constructing
                    }
                }
            })
        }))
        return value
    }

    /** What a class gets wrong, reported where it is written. */
    private checkClassDeclaration(stmt: ClassLike): void {
        if (!this.emitDiagnostics) return
        const report = (node: TypeDiagnostic["node"], message: string): void => {
            this.diagnostics.push({ node, message })
        }
        const name = this.className(stmt)

        if (stmt.superclass) {
            const local = this.aliasDefs.get(stmt.superclass.name)?.runtimeClass
            if (local && this.extendsThrough(local, stmt)) {
                report(stmt.superclass, `'${name}' cannot extend itself`)
            } else if (!this.baseInstance(stmt)) {
                const known = this.aliases.has(stmt.superclass.name) || this.importedTypes.has(stmt.superclass.name)
                report(stmt.superclass, known
                    ? `'${stmt.superclass.name}' is not a class; a class can only extend another class`
                    : `Cannot find class '${stmt.superclass.name}'`)
            }
        }

        // The compiler builds the class table out of these, so a member cannot
        // be called one of them.
        for (const member of stmt.members) {
            if (member.type === "ClassConstructor") continue
            if (CLASS_RESERVED.has(member.name.name)) {
                report(member.name, `'${member.name.name}' is what the compiler calls part of a class; `
                    + "a member cannot be named that")
            }
        }

        // A member written twice, `get`/`set` of one property excepted.
        const seen = new Map<string, ClassMember["type"]>()
        for (const member of stmt.members) {
            if (member.type === "ClassConstructor") {
                if (seen.has("constructor")) report(member, "A class has one constructor")
                seen.set("constructor", member.type)
                continue
            }
            const key = `${member.isStatic ? "static " : ""}${member.name.name}`
            const before = seen.get(key)
            const pair = member.type === "ClassAccessor" && before === "ClassAccessor"
            if (before !== undefined && !pair) {
                report(member.name, `'${member.name.name}' is declared twice in class '${name}'`)
            }
            seen.set(key, member.type)
        }

        const constructor = stmt.members.find((m): m is Extract<ClassMember, { type: "ClassConstructor" }> =>
            m.type === "ClassConstructor")
        if (stmt.superclass && this.baseInstance(stmt) && constructor && !callsSuper(constructor.func.body)) {
            report(constructor, `'${name}' extends '${stmt.superclass.name}', so its constructor must call 'super(...)'`)
        }

        this.checkAbstractMembers(stmt)
        this.checkOverrides(stmt)
        this.checkImplements(stmt)
        this.checkMetamethods(stmt)

        // A field that is only declared, and that the constructor does not
        // assign on every way through it, is nil at run time however it is
        // annotated.
        const assigned = constructor ? definitelyAssigned(constructor.func.body) ?? ALL_FIELDS : new Set<string>()
        for (const member of stmt.members) {
            if (member.type !== "ClassField" || member.isStatic || member.init) continue
            if (assigned === ALL_FIELDS || assigned.has(member.name.name)) continue
            const type = member.typeAnnotation
                ? this.withTypeParams(this.classTypeParams(stmt), () => this.resolveType(member.typeAnnotation!))
                : anyType
            if (isAssignable(nilType, type)) continue
            report(member.name, `'${member.name.name}' has no value: give it one, assign it in the constructor `
                + `on every path, or let its type admit nil`)
        }
    }

    /** The class whose constructor is being checked: it, and only it, may
     *  assign the `readonly` fields it declares. */
    private constructing?: ClassLike

    /** A class that is not abstract has a `new`, so everything its instances
     *  promise has to be there: no abstract member of its own, and every one
     *  it inherits written. */
    private checkAbstractMembers(stmt: ClassLike): void {
        if (stmt.isAbstract) return
        const name = this.className(stmt)
        for (const member of stmt.members) {
            if (member.type === "ClassMethod" && member.isAbstract) {
                this.diagnostics.push({
                    node: member.name,
                    message: `'${member.name.name}' is abstract, so '${name}' has to be an 'abstract class'`,
                })
            }
        }
        const own = this.shapeOf(stmt).instance
        const missing = [...this.instanceType(stmt).properties]
            .filter(([key, property]) => property.abstract && !own.has(key))
            .map(([key]) => `'${key}'`)
        if (missing.length) {
            this.diagnostics.push({
                node: stmt.name ?? stmt,
                message: `'${name}' does not write the abstract ${missing.length === 1 ? "member" : "members"} `
                    + `${missing.join(", ")} of the class it extends; write ${missing.length === 1 ? "it" : "them"}, `
                    + `or make '${name}' abstract too`,
            })
        }
    }

    /** A member written again in a class that extends another has to fit
     *  where the base's stood — anything reading an instance as the base
     *  would otherwise be told wrong. `override` says a member is such a one,
     *  and is wrong on a member that is not. */
    private checkOverrides(stmt: ClassLike): void {
        const base = this.baseInstance(stmt)
        const name = this.className(stmt)
        const own = this.shapeOf(stmt).instance
        for (const member of stmt.members) {
            if (member.type === "ClassConstructor" || member.isStatic) continue
            const key = member.name.name
            const inherited = CLASS_LINKS.has(key) ? undefined : base?.properties.get(key)
            if (member.isOverride && !inherited) {
                this.diagnostics.push({
                    node: member.name,
                    message: base
                        ? `'${key}' is marked 'override', but '${stmt.superclass!.name}' has no member of that name`
                        : `'${key}' is marked 'override', but '${name}' does not extend another class`,
                })
                continue
            }
            const mine = own.get(key)
            if (!inherited || !mine || inherited.private && !inherited.private.protected) continue
            // Their `this` differ by definition; what they take after it is
            // what has to line up.
            const written = withoutReceiver(mine.type)
            const expected = withoutReceiver(inherited.type)
            if (isAssignable(written, expected)) continue
            this.diagnostics.push({
                node: member.name,
                message: `'${key}' in '${name}' does not fit the '${key}' of '${stmt.superclass!.name}' it replaces: `
                    + `'${briefType(written)}' is not assignable to '${briefType(expected)}'`,
            })
        }
    }

    /** `implements Shape`: every member the shape names, of a type that fits.
     *  A method's own `this` is left out of the comparison on both sides. */
    private checkImplements(stmt: ClassLike): void {
        if (!stmt.implements?.length) return
        const name = this.className(stmt)
        const instance = this.instanceType(stmt).properties
        for (const node of stmt.implements) {
            const shown = node.type === "TypeReference"
                ? (node.namespace ? `${node.namespace}.${node.base}` : node.base)
                : undefined
            const target = this.expand(this.withTypeParams(this.classTypeParams(stmt), () => this.resolveType(node)))
            if (target.kind === "any") continue
            if (target.kind !== "object") {
                this.diagnostics.push({
                    node,
                    message: `A class can only implement an object type or a class, not '${briefType(target)}'`,
                })
                continue
            }
            const label = shown ?? briefType(target)
            const missing: string[] = []
            for (const [key, wanted] of target.properties) {
                const have = instance.get(key)
                if (!have) {
                    if (!wanted.optional) missing.push(`'${key}'`)
                    continue
                }
                const written = withoutReceiver(have.type)
                const expected = withoutReceiver(wanted.optional ? optional(wanted.type) : wanted.type)
                if (isAssignable(written, expected)) continue
                this.diagnostics.push({
                    node,
                    message: `'${name}' does not implement '${label}': its '${key}' is `
                        + `'${briefType(written)}', not '${briefType(expected)}'`,
                })
            }
            if (missing.length) {
                this.diagnostics.push({
                    node,
                    message: `'${name}' does not implement '${label}': `
                        + `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} missing`,
                })
            }
        }
    }

    /** A method named for a metamethod *is* one — the class table is its
     *  instances' metatable — so it has to take what Luau hands it and give
     *  back what Luau expects. */
    private checkMetamethods(stmt: ClassLike): void {
        const instance = this.shapeOf(stmt).instance
        for (const member of stmt.members) {
            if (member.type !== "ClassMethod" || !(member.name.name in METAMETHOD_OPERANDS)) continue
            const key = member.name.name
            if (member.isStatic) {
                this.diagnostics.push({
                    node: member.name,
                    message: `'${key}' is a metamethod of the instances; it cannot be static`,
                })
                continue
            }
            const operands = METAMETHOD_OPERANDS[key]
            const written = member.func.params.filter(p => p.name !== "this").length
            if (operands !== undefined && (written !== operands || member.func.hasVarargs)) {
                this.diagnostics.push({
                    node: member.name,
                    message: operands === 0
                        ? `'${key}' takes nothing besides 'this'`
                        : `'${key}' takes one operand besides 'this'`,
                })
                continue
            }
            const required = METAMETHOD_RETURNS[key]
            const returns = this.overloadsOf(instance.get(key)?.type ?? anyType)[0]?.returns
            if (required && returns && !isAssignable(returns, required)) {
                this.diagnostics.push({
                    node: member.name,
                    message: `'${key}' has to return ${briefType(required)}, not '${briefType(returns)}'`,
                })
            }
        }
    }


    /** `extends` must name a class, and the chain must end. */
    private checkClass(stmt: DeclareClassStatement): void {
        if (!stmt.superclass || !this.emitDiagnostics) return
        const base = stmt.superclass.base
        if (!this.aliasDefs.get(base)?.class) {
            const known = this.aliasDefs.has(base) || this.importedTypes.has(base)
            this.diagnostics.push({
                node: stmt.superclass,
                message: known
                    ? `'${base}' is not a class; a class can only extend another class`
                    : `Cannot find class '${base}'`,
            })
        } else if (this.classChain(stmt).cyclic) {
            this.diagnostics.push({ node: stmt.superclass, message: `'${stmt.name.name}' cannot extend itself` })
        }
    }

    /** The class and the classes it extends, nearest first, read from the
     *  declarations — no type has to be resolved to know them. The walk stops
     *  at a superclass that is not a class. */
    private classChain(stmt: DeclareClassStatement): { ancestors: string[]; cyclic: boolean } {
        const ancestors = [stmt.name.name]
        for (let cls: DeclareClassStatement | undefined = stmt; cls?.superclass;) {
            const base: string = cls.superclass.base
            if (ancestors.includes(base)) return { ancestors, cyclic: true }
            cls = this.aliasDefs.get(base)?.class
            if (!cls) break
            ancestors.push(base)
        }
        return { ancestors, cyclic: false }
    }

    /** Seed global types from `declare` statements. Repeating a function name
     *  builds an *overload set* (an intersection, in declaration order) rather
     *  than replacing — which is how `typeof` gets one signature per result
     *  string. Any other value is simply redeclared: a sourcemap's
     *  `declare script: <this file's instance>` replaces the library's
     *  `declare script: LuaSourceContainer`. */
    /** Program `declare`s whose type depends on a value's, by name. */
    private readonly deferredDeclares = new Map<string, DeclareStatement>()

    /** A library that declares a name a second time adds to it rather than
     *  replacing it: `declare table: { find: ... }` on top of Lua's `table`
     *  leaves both members there, the way overloads of a function accumulate.
     *  This is what lets one definitions file build on another's — Luau's on
     *  Lua's, Roblox's on Luau's. A property declared twice takes its later
     *  type. Classes stay as they are: they come from one generated file and
     *  merging them would only blur it. */
    private mergeDeclared(prev: Type | undefined, next: Type): Type {
        if (!prev || prev.kind !== "object" || next.kind !== "object") return next
        if (prev.class || next.class) return next
        return objectType(
            [...prev.properties, ...next.properties],
            next.indexer ?? prev.indexer,
            next.frozen ?? prev.frozen,
        )
    }

    private harvestDeclares(block: Block, own = false): void {
        for (const stmt of block.statements) {
            if (stmt.type !== "DeclareStatement") continue
            if (!own) {
                const declares = this.libDeclares.get(stmt.name)
                if (declares) declares.push(stmt)
                else {
                    this.libDeclares.set(stmt.name, [stmt])
                    this.libGlobalTypes.defer(stmt.name, () => this.resolveLibDeclares(stmt.name))
                }
                continue
            }
            if (containsTypeQuery(stmt.valueType) ||
                referencedTypeNames(stmt.valueType).some(name => this.dependsOnTypeQuery(name))) {
                this.deferredDeclares.set(stmt.name, stmt)
                continue
            }
            this.libGlobalTypes.set(stmt.name, this.declaredOver(this.libGlobalTypes.get(stmt.name), stmt))
        }
    }

    /** Every library `declare` of `name`, in order. They are written at the
     *  top level of their files, so they are read as if there — outside any
     *  generic the use that asked for them happens to sit in. */
    private resolveLibDeclares(name: string): Type {
        const scope = this.typeParamScope.splice(0)
        try {
            let type: Type | undefined
            for (const stmt of this.libDeclares.get(name) ?? []) type = this.declaredOver(type, stmt)
            return type ?? anyType
        } finally {
            this.typeParamScope.push(...scope)
        }
    }

    /** A `declare` on top of what earlier ones said about the same name: a
     *  function adds an overload, a table adds members. */
    private declaredOver(prev: Type | undefined, stmt: DeclareStatement): Type {
        const t = this.resolveType(stmt.valueType)
        const overload = prev && stmt.valueType.type === "FunctionTypeNode" &&
            (prev.kind === "function" || prev.kind === "intersection")
        return overload ? intersection([prev, t]) : this.mergeDeclared(prev, t)
    }

    private resolveAllAliases(): void {
        // Public `aliases` map — each resolved once, generic params kept as
        // `typeParam` nodes in the body.
        for (const [name, def] of this.aliasDefs) {
            // A library class becomes a type only once something names it: an
            // engine's definitions declare thousands, a script uses a few.
            if (def.class && !this.program.body.statements.includes(def.class)) {
                const cls = def.class
                this.aliases.defer(name, () => this.classType(cls))
                continue
            }
            // `type Config = typeof defaults` needs `defaults` to have a type,
            // which only happens once the statements are walked. Such an alias
            // resolves on first use (through `expand`) or at the end instead —
            // and so does one that names it: `type Part = Config["part"]`
            // resolved now would read `Config` before it can be known.
            if (this.dependsOnTypeQuery(name)) continue
            this.withTypeParams(def.params, () => {
                this.aliases.set(name, this.resolveDef(def))
            })
        }
    }

    private readonly typeQueryDependents = new Map<string, boolean>()

    /** Does alias `name` contain a `typeof`, itself or through an alias it
     *  names? */
    private dependsOnTypeQuery(name: string, visiting = new Set<string>()): boolean {
        const known = this.typeQueryDependents.get(name)
        if (known !== undefined) return known
        const def = this.aliasDefs.get(name)
        if (!def || def.class || visiting.has(name)) return false
        visiting.add(name)
        const result = containsTypeQuery(def.node) ||
            referencedTypeNames(def.node).some(other => other !== name && this.dependsOnTypeQuery(other, visiting))
        visiting.delete(name)
        this.typeQueryDependents.set(name, result)
        return result
    }

    /** The aliases `resolveAllAliases` left for later, now that every binding
     *  has its type. */
    /** Names this file imports. A module that could not be found is reported
     *  as the missing module it is; the names it was to bring are not also
     *  typos. */
    private importedNames(): Set<string> {
        if (this.imported) return this.imported
        this.imported = new Set<string>()
        for (const statement of this.program.body.statements) {
            if (statement.type !== "ImportStatement") continue
            if (statement.defaultImport) this.imported.add(statement.defaultImport.name)
            if (statement.namespaceImport) this.imported.add(statement.namespaceImport.name)
            for (const specifier of statement.specifiers) this.imported.add(specifier.local.name)
        }
        return this.imported
    }
    private imported?: Set<string>

    /** What a `return` gives, against what the function declared. */
    private checkReturn(stmt: ReturnStatement, declared: Type | undefined, actual: Type, env: FlowEnv): void {
        if (!declared || !this.emitDiagnostics) return
        if (declared.kind === "any" || declared.kind === "unknown" || this.namesNothing(declared)) return
        const source = stmt.argument
        const fits = source
            ? this.fitsAnnotation(source, declared, actual, env)
            : isAssignable(actual, declared) || isAssignable(widen(actual), declared)
        if (fits) return
        this.diagnostics.push({
            node: stmt,
            message: `Type '${briefType(actual)}' is not assignable to '${briefType(declared)}'`
                + this.explainMismatch(actual, declared),
        })
    }

    /** A function that declared what it returns but never does. Only a body
     *  with no `return` at all is reported: anything subtler needs to know
     *  which paths can run off the end, and a wrong guess there is worse than
     *  a missing complaint. */
    private checkReturnsAtAll(func: FunctionBody, declared: Type | undefined): void {
        if (!declared || !this.emitDiagnostics) return
        // A guard or assertion narrows by being called; `assert(v)` and
        // `function f(): v is T` need no value of their own.
        if (func.predicate) return
        if (declared.kind === "any" || declared.kind === "unknown" || declared.kind === "never") return
        if (isAssignable(nilType, declared) || this.namesNothing(declared)) return
        let found = false
        const walk = (statements: readonly Statement[]): void => {
            for (const statement of statements) {
                if (found) return
                if (statement.type === "ReturnStatement") { found = true; return }
                for (const value of Object.values(statement)) {
                    if (value && typeof value === "object" && "statements" in (value as object)) {
                        walk((value as Block).statements)
                    } else if (Array.isArray(value)) {
                        for (const item of value) {
                            const block = item as { body?: Block }
                            if (block?.body?.statements) walk(block.body.statements)
                        }
                    }
                }
            }
        }
        walk(func.body.statements)
        if (found) return
        this.diagnostics.push({
            node: func.body,
            message: `A function that returns '${briefType(declared)}' must return a value`,
        })
    }

    /** Does this type rest on a name nothing declares? Such a type says
     *  nothing about what fits it, so checking against it only piles a second
     *  complaint on top of "Cannot find name". */
    private namesNothing(t: Type, seen = new Set<Type>()): boolean {
        if (seen.has(t)) return false
        seen.add(t)
        if (t.kind === "genericRef") {
            return !this.aliasDefs.has(t.name) && !this.importedTypes.has(t.name) &&
                this.options.libTypes?.[t.name] === undefined
        }
        switch (t.kind) {
            case "union":
            case "intersection": return t.types.some(m => this.namesNothing(m, seen))
            case "array": return this.namesNothing(t.element, seen)
            case "tuple": return t.elements.some(e => this.namesNothing(e, seen))
            case "object":
                if (t.class) return false
                return [...t.properties.values()].some(v => this.namesNothing(v.type, seen))
            default: return false
        }
    }

    /** Every type name in the program that resolved to nothing — a typo, or a
     *  library the config does not load. A name that resolves to a type
     *  parameter, an alias (even one still being resolved), an imported type or
     *  a primitive is fine; what is left is a reference that stayed itself. */
    private reportUnknownTypes(): void {
        if (!this.emitDiagnostics) return
        const reported = new Set<string>()
        const visit = (node: unknown): void => {
            if (!node || typeof node !== "object") return
            if (Array.isArray(node)) {
                for (const item of node) visit(item)
                return
            }
            const record = node as { type?: unknown; base?: unknown; namespace?: unknown }
            if (record.type === "TypeReference" && typeof record.base === "string") {
                const name = typeof record.namespace === "string" ? `${record.namespace}.${record.base}` : record.base
                const resolved = this.typeOfTypeNode.get(node as TypeNode)
                const unresolved = resolved?.kind === "genericRef" && resolved.name === name &&
                    !this.aliasDefs.has(name) && !this.importedTypes.has(name) &&
                    this.options.libTypes?.[name] === undefined &&
                    !STRING_INTRINSICS.has(name) && !this.importedNames().has(name.split(".")[0])
                const at = node as unknown as { line: { start: number }; column: { start: number } }
                const key = `${at.line.start}:${at.column.start}`
                if (unresolved && !reported.has(key)) {
                    reported.add(key)
                    this.diagnostics.push({ node: node as TypeNode, message: `Cannot find name '${name}'` })
                }
            }
            for (const [key, value] of Object.entries(node)) {
                if (key !== "line" && key !== "column" && value && typeof value === "object") visit(value)
            }
        }
        visit(this.program.body)
    }

    /** Deferred `declare`s nothing used, typed now for tools that ask. */
    private resolveDeferredDeclares(): void {
        for (const name of this.deferredDeclares.keys()) {
            const id = this.scopes.globalsByName.get(name)
            if (id !== undefined && !this.bindingType.has(id)) this.bindingType.set(id, this.declaredAhead(id) ?? anyType)
        }
    }

    private resolveDeferredAliases(): Map<string, Type> {
        for (const [name, def] of this.aliasDefs) {
            if (this.aliases.has(name)) continue
            this.withTypeParams(def.params, () => {
                this.aliases.set(name, this.resolveDef(def))
            })
        }
        return this.aliases
    }

    private withTypeParams<T>(params: readonly GenericTypeParameter[], fn: () => T): T {
        const start = this.typeParamScope.length
        for (const p of params) this.typeParamScope.push({ name: p.name, isConst: p.isConst })
        // Constraints may reference sibling params, so resolve after all names
        // are in scope.
        for (let i = 0; i < params.length; i++) {
            if (params[i].constraint) {
                this.typeParamScope[start + i].constraint = this.resolveType(params[i].constraint!)
            }
        }
        try {
            return fn()
        } finally {
            this.typeParamScope.length = start
        }
    }

    private lookupTypeParam(name: string): { name: string; constraint?: Type; isConst?: boolean } | undefined {
        for (let i = this.typeParamScope.length - 1; i >= 0; i--) {
            if (this.typeParamScope[i].name === name) return this.typeParamScope[i]
        }
        return undefined
    }

    /** Instantiate a generic alias: `Box<number>` -> `{ value: number }`. */
    private instantiateAlias(def: { params: GenericTypeParameter[]; node: TypeNode; runtimeClass?: ClassDeclaration }, args: Type[]): Type {
        if (this.instantiationDepth > 20) return unknownType
        const subst = this.bindTypeArguments(def.params, args)
        // `Box<number>` is the class with its parameters filled in — still the
        // same class, which is what `substitute` keeps.
        if (def.runtimeClass) return substitute(this.instanceType(def.runtimeClass), subst)
        this.instantiationDepth++
        try {
            const body = this.withTypeParams(def.params, () => this.resolveType(def.node))
            // Substituting the arguments in is what makes a deferred
            // `conditional` / `mapped` ready to evaluate.
            return this.reduceType(substitute(body, subst))
        } finally {
            this.instantiationDepth--
        }
    }

    /** Pair written type arguments with the parameters they instantiate.
     *  Left out, a parameter takes its default, or `unknown`. */
    private bindTypeArguments(params: readonly GenericTypeParameter[], args: readonly Type[]): Map<string, Type> {
        const subst = new Map<string, Type>()
        params.forEach((p, i) => {
            subst.set(p.name, args[i] ?? (p.default ? this.resolveType(p.default) : unknownType))
        })
        return subst
    }

    /** An imported type, with its type arguments applied. */
    private importedType(imported: ExportedType, typeArguments: readonly (TypeNode)[]): Type {
        if (!imported.params.length) return imported.type
        const subst = new Map<string, Type>()
        imported.params.forEach((name, i) => {
            const arg = typeArguments[i]
            subst.set(name, arg ? this.resolveType(arg) : unknownType)
        })
        return this.reduceType(substitute(imported.type, subst))
    }

    // --------------------------------------------------------
    // TypeNode -> Type
    // --------------------------------------------------------

    private resolveType(node: TypeNode): Type {
        const type = this.resolveTypeNode(node)
        // Record what each annotation means, for tooling — but not while
        // instantiating a generic alias: those nodes resolve again per use
        // site, and the last instantiation would overwrite the definition.
        if (this.instantiationDepth === 0) this.typeOfTypeNode.set(node, type)
        return type
    }

    private resolveTypeNode(node: TypeNode): Type {
        switch (node.type) {
            case "TypeReference": {
                const name = node.namespace ? `${node.namespace}.${node.base}` : node.base
                switch (node.base) {
                    case "any": return anyType
                    case "unknown": return declaredUnknownType
                    case "never": return neverType
                    case "nil": return nilType
                    case "boolean": return booleanType
                    case "number": return numberType
                    case "string": return stringType
                    case "thread": return primitive("thread")
                    case "buffer": return primitive("buffer")
                }
                if (!node.namespace) {
                    const tp = this.lookupTypeParam(node.base)
                    if (tp) return typeParam(tp.name, tp.constraint, tp.isConst)
                    if (node.typeArguments.length === 1 && !this.aliasDefs.has(node.base)) {
                        const intrinsic = this.applyStringIntrinsic(
                            node.base, this.resolveType(node.typeArguments[0]))
                        if (intrinsic) return intrinsic
                    }
                    if (this.aliasDefs.has(node.base)) {
                        // Route every alias reference through `expand`, which
                        // both memoises the result and returns a nominal ref
                        // for an alias that is still being resolved (a
                        // recursive type). Resolving the body inline here
                        // instead re-resolves it at every mention, which for a
                        // set of mutually referring classes blows up.
                        return this.expand({
                            kind: "genericRef",
                            name: node.base,
                            typeArguments: node.typeArguments.map(a => this.resolveType(a)),
                            origin: this.origin,
                        })
                    }
                    const imported = this.importedTypes.get(node.base)
                    if (imported) return this.importedType(imported, node.typeArguments)
                    const lib = this.options.libTypes?.[node.base]
                    if (lib) return lib
                } else if (this.importedTypes.has(name)) {
                    // `Shapes.Circle` through `import * as Shapes`.
                    return this.importedType(this.importedTypes.get(name)!, node.typeArguments)
                } else if (this.aliasDefs.has(name)) {
                    // A qualified name a definitions file declared: `Enum.Material`.
                    return this.expand({
                        kind: "genericRef",
                        name,
                        typeArguments: node.typeArguments.map(a => this.resolveType(a)),
                        origin: this.origin,
                    })
                }
                return {
                    kind: "genericRef",
                    name,
                    typeArguments: node.typeArguments.map(a => this.resolveType(a)),
                }
            }
            case "TypeLiteralString": return literal(node.value)
            case "TypeLiteralBoolean": return literal(node.value)
            case "TypeLiteralNumber": return literal(node.value)
            case "ArrayTypeNode": {
                const made = arrayOf(this.resolveType(node.element))
                return node.isReadonly ? { ...made, readonly: true } : made
            }
            case "TupleTypeNode": {
                const rest = node.rest && this.expand(this.resolveType(node.rest))
                const made = tuple(node.elements.map(e => this.resolveType(e)),
                    rest ? (rest.kind === "array" ? rest.element : rest.kind === "any" ? anyType : unknownType) : undefined)
                return node.isReadonly && made.kind === "tuple" ? { ...made, readonly: true } : made
            }
            case "UnionTypeNode": return union(node.types.map(t => this.resolveType(t)))
            case "IntersectionTypeNode": return intersection(node.types.map(t => this.resolveType(t)))
            case "ParenthesizedTypeNode": return this.resolveType(node.typeAnnotation)
            case "TableTypeNode": {
                const entries: [string, ObjectProperty][] = []
                const seen = new Map<string, number>()
                let indexer: { key: Type; value: Type } | undefined = undefined
                for (const p of node.properties) {
                    if (p.type === "TableTypeIndexer") {
                        indexer = { key: this.resolveType(p.keyType), value: this.resolveType(p.valueType) }
                        continue
                    }
                    const vt = this.resolveType(p.valueType)
                    const at = seen.get(p.name)
                    if (at !== undefined) {
                        // Writing a member name more than once declares an
                        // overload set, the way repeating a method in a
                        // TypeScript interface does. Declaration order is the
                        // resolution order.
                        const prev = entries[at][1]
                        entries[at] = [p.name, { ...prev, type: intersection([prev.type, vt]) }]
                        continue
                    }
                    seen.set(p.name, entries.length)
                    entries.push([p.name, { type: vt, optional: p.optional, readonly: p.readonly }])
                }
                return objectType(entries, indexer)
            }
            case "FunctionTypeNode": {
                const names = node.generics.map(g => g.name)
                return this.withTypeParams(node.generics, () => {
                    const params = node.params.filter(p => !p.rest).map(p => ({
                        name: p.name,
                        type: p.optional
                            ? optional(this.resolveType(p.typeAnnotation))
                            : this.resolveType(p.typeAnnotation),
                        optional: p.optional,
                    }))
                    return this.withTypeParamDefaults(this.withRest(fn(
                        params,
                        this.resolveType(node.returnType),
                        undefined,
                        names,
                        this.resolvePredicate(node.predicate, params),
                    ), node.params), node.generics)
                })
            }
            case "TypeofTypeNode": {
                return this.infer(node.expression, new Map())
            }
            case "TemplateLiteralTypeNode":
                return this.reduceType({
                    kind: "templateLiteral",
                    quasis: node.quasis,
                    types: node.types.map(x => this.resolveType(x)),
                })

            case "DifferenceTypeNode":
                return this.reduceType({
                    kind: "difference",
                    base: this.resolveType(node.base),
                    excluded: this.resolveType(node.excluded),
                })

            case "KeyofTypeNode":
                return this.reduceType({ kind: "keyof", target: this.resolveType(node.target) })

            case "IndexedAccessTypeNode":
                return this.reduceType({
                    kind: "indexedAccess",
                    objectType: this.resolveType(node.objectType),
                    indexType: this.resolveType(node.indexType),
                })

            case "InferTypeNode":
                return { kind: "infer", name: node.name }

            case "ConditionalTypeNode": {
                // `infer` names are scoped to the conditional, so collect them
                // from the `extends` clause and bind them while resolving the
                // true branch — otherwise `R` there resolves to nothing.
                const inferVars = collectInferNames(node.extendsType)
                const checkType = this.resolveType(node.checkType)
                const extendsType = this.resolveType(node.extendsType)
                const build = (): Type => this.reduceType({
                    kind: "conditional",
                    checkType, extendsType,
                    trueType: this.resolveType(node.trueType),
                    falseType: this.resolveType(node.falseType),
                    inferVars,
                    // Distribution applies only to a *naked* type parameter.
                    distributeParam: node.checkType.type === "TypeReference" &&
                        !node.checkType.namespace &&
                        this.lookupTypeParam(node.checkType.base) !== undefined
                        ? node.checkType.base
                        : undefined,
                })
                return inferVars.length
                    ? this.withTypeParams(
                        inferVars.map(name => ({ type: "GenericTypeParameter", name } as GenericTypeParameter)),
                        build)
                    : build()
            }

            case "MappedTypeNode": {
                const constraint = this.resolveType(node.constraint)
                // `[K in keyof T]` is *homomorphic*: remember `T` so each
                // property can inherit its own `?` / `readonly`.
                const source = node.constraint.type === "KeyofTypeNode"
                    ? this.resolveType(node.constraint.target)
                    : undefined
                return this.withTypeParams(
                    [{ type: "GenericTypeParameter", name: node.parameter } as GenericTypeParameter],
                    () => this.reduceType({
                        kind: "mapped",
                        parameter: node.parameter,
                        constraint,
                        nameType: node.nameType && this.resolveType(node.nameType),
                        template: this.resolveType(node.template),
                        optional: node.optional,
                        readonly: node.readonly,
                        source,
                    }),
                )
            }

        }
    }

    // --------------------------------------------------------
    // Type-level operators
    // --------------------------------------------------------
    //
    // `keyof`, `T[K]`, `C extends E ? A : B` and `{ [K in C]: V }` are built by
    // `resolveType` as deferred nodes and collapsed here as soon as their
    // inputs stop mentioning an unresolved type parameter. Every utility type
    // (`Partial`, `ReturnType`, `Exclude`, ...) is written in `luau.d.tilua` on
    // top of these — none of them is known to the analyzer by name.

    /** Evaluate every type-level operator in `t` that is ready to be evaluated.
     *  Anything still waiting on a type parameter is returned untouched, to be
     *  reduced again after the next substitution. */
    private reduceType(t: Type): Type {
        if (this.reduceDepth > 24) return unknownType
        // Reduction is a pure function of the type, and types are immutable,
        // so the answer is cacheable by identity. This is load-bearing: a
        // mapped type reduces its template once per key, and each reduction
        // otherwise walks the whole source type again.
        const cached = this.reduceCache.get(t)
        if (cached !== undefined) return cached
        this.reduceDepth++
        try {
            const result = this.reduceTypeInner(t)
            // A `keyof` still deferred here may only be waiting for its target
            // to finish resolving; caching it would keep it deferred for good.
            if (result.kind !== "keyof") this.reduceCache.set(t, result)
            return result
        } finally {
            this.reduceDepth--
        }
    }

    private reduceTypeInner(t: Type): Type {
        {
            switch (t.kind) {
                case "keyof": {
                    const target = this.reduceType(t.target)
                    if (containsTypeParam(target)) return { kind: "keyof", target }
                    // `keyof ClassMap` met while `ClassMap` itself is being
                    // resolved — as a class's own members are — has no keys
                    // to give yet. Ask again when it is used.
                    if (target.kind === "genericRef" && this.resolvingAliases.has(target.name)) return t
                    return this.keysOf(target)
                }
                case "indexedAccess": {
                    const objectType = this.reduceType(t.objectType)
                    const indexType = this.reduceType(t.indexType)
                    if (containsTypeParam(objectType) || containsTypeParam(indexType)) {
                        return { kind: "indexedAccess", objectType, indexType }
                    }
                    return this.accessType(objectType, indexType)
                }
                case "templateLiteral": return this.reduceTemplateLiteral(t)
                case "difference":
                    return difference(this.reduceType(t.base), this.reduceType(t.excluded))
                case "genericRef": {
                    // `Capitalize<K>` resolves to a ref while `K` is generic;
                    // once `K` is a real string it becomes computable.
                    if (t.typeArguments.length !== 1 || this.aliasDefs.has(t.name)) return t
                    return this.applyStringIntrinsic(t.name, t.typeArguments[0]) ?? t
                }
                case "conditional": return this.reduceConditional(t)
                case "mapped": return this.reduceMapped(t)
                case "union": return union(t.types.map(m => this.reduceType(m)))
                case "intersection": {
                    // Rebuilding must not drop the alias name — an unnamed
                    // class intersection prints as its whole expansion.
                    const r = intersection(t.types.map(m => this.reduceType(m)))
                    return t.name && r.kind === "intersection" && !r.name
                        ? { ...r, name: t.name }
                        : r
                }
                case "array": return arrayOf(this.reduceType(t.element))
                case "tuple": return tuple(t.elements.map(e => this.reduceType(e)), t.rest && this.reduceType(t.rest))
                case "function":
                    return {
                        ...fn(
                            t.params.map(p => ({ ...p, type: this.reduceType(p.type) })),
                            this.reduceType(t.returns),
                            t.varargs && this.reduceType(t.varargs),
                            t.typeParams,
                            t.predicate,
                        ),
                        ...(t.restIsWhole ? { restIsWhole: true } : {}),
                    }
                case "object": {
                    // A class is concrete, and rebuilding it would drop what
                    // makes it one.
                    if (t.class) return t
                    const entries: [string, ObjectProperty][] = []
                    for (const [k, v] of t.properties) entries.push([k, { ...v, type: this.reduceType(v.type) }])
                    const reduced = objectType(entries, t.indexer && {
                        key: this.reduceType(t.indexer.key),
                        value: this.reduceType(t.indexer.value),
                    }, t.frozen)
                    if (t.name) reduced.name = t.name
                    return reduced
                }
                default: return t
            }
        }
    }

    /** `keyof T`. A union's keys are the ones every member has (an
     *  intersection), which is what TypeScript does and what keeps
     *  `keyof (A | B)` safe to index with. */
    private keysOf(raw: Type): Type {
        const t = this.expand(raw)
        switch (t.kind) {
            case "object": {
                const keys: Type[] = [...t.properties.keys()].map(k => literal(k))
                if (t.indexer) keys.push(t.indexer.key)
                return union(keys)
            }
            case "array":
            case "tuple":
                return numberType
            case "union": {
                // `keyof (A | B)` is the keys they share: a value that is one
                // or the other certainly has only those. Work the set out here
                // rather than leaving an intersection of literal unions for
                // something later to reduce — nothing does, and a mapped type
                // over it then finds no keys at all.
                const sets = t.types.map(m => {
                    const keys = this.keysOf(m)
                    return keys.kind === "union" ? keys.types : [keys]
                })
                // An indexer's `string` / `number` key stands for every literal
                // of that type, so a member declaring one shares them all.
                const has = (set: readonly Type[], key: Type): boolean => set.some(k =>
                    (k.kind === "literal" && key.kind === "literal" && k.value === key.value) ||
                    (k.kind === "primitive" && key.kind === "primitive" && k.name === key.name) ||
                    (k.kind === "primitive" && key.kind === "literal" && k.name === typeof key.value))
                return union(sets[0].filter(key => sets.every(set => has(set, key))))
            }
            case "intersection":
                return union(t.types.map(m => this.keysOf(m)))
            case "any":
                return union([stringType, numberType])
            case "difference":
                return this.keysOf(t.base)
            default:
                return neverType
        }
    }

    /** `T[K]`, distributing over a union index (`T["a" | "b"]`). */
    private accessType(obj: Type, index: Type): Type {
        if (index.kind === "union") return union(index.types.map(m => this.accessType(obj, m)))
        if (index.kind === "literal" && typeof index.value === "string") {
            const member = this.propertyType(obj, index.value)
            if (member.kind !== "unknown") return member
            // A key a table does not have reads as nil, as it does on the
            // value side — so `T[K]` over a union of keys gives what the keys
            // it has hold, plus nil, rather than collapsing to `unknown`
            // because one of them was not there.
            const t = this.expand(obj)
            return t.kind === "object" && !t.class && !t.indexer ? nilType : member
        }
        return this.indexedType(obj, index)
    }

    /** A template literal whose every interpolation is a union of string
     *  literals expands to the union of all concatenations (the cross
     *  product). Anything wider — `string`, `number` — leaves it a pattern
     *  that `isAssignable` matches literal strings against. */
    private reduceTemplateLiteral(t: Extract<Type, { kind: "templateLiteral" }>): Type {
        const types = t.types.map(x => this.reduceType(x))
        if (types.some(x => containsTypeParam(x))) return { ...t, types }

        const literalsOf = (x: Type): string[] | undefined => {
            const members = x.kind === "union" ? x.types : [x]
            const out: string[] = []
            for (const m of members) {
                if (m.kind !== "literal") return undefined
                out.push(String(m.value))
            }
            return out
        }

        let combos = [t.quasis[0]]
        for (let i = 0; i < types.length; i++) {
            const parts = literalsOf(types[i])
            if (!parts) return { ...t, types }
            const next: string[] = []
            for (const head of combos) for (const part of parts) next.push(head + part + t.quasis[i + 1])
            // Guard against a combinatorial blow-up from wide unions.
            if (next.length > 512) return { ...t, types }
            combos = next
        }
        return union(combos.map(c => literal(c)))
    }

    /** TypeScript's four string intrinsics. They cannot be written in tilua —
     *  there is no character-level type arithmetic — so the analyzer supplies
     *  them, and only them, as named type functions. */
    private applyStringIntrinsic(name: string, arg: Type): Type | undefined {
        const apply = (v: string): string => {
            switch (name) {
                case "Uppercase": return v.toUpperCase()
                case "Lowercase": return v.toLowerCase()
                case "Capitalize": return v.charAt(0).toUpperCase() + v.slice(1)
                default: return v.charAt(0).toLowerCase() + v.slice(1)
            }
        }
        if (!["Uppercase", "Lowercase", "Capitalize", "Uncapitalize"].includes(name)) return undefined
        const t = this.reduceType(arg)
        if (t.kind === "union") return union(t.types.map(m => this.applyStringIntrinsic(name, m) ?? m))
        if (t.kind === "literal" && t.base === "string") return literal(apply(String(t.value)))
        // Not a known literal: the result is still some string.
        return containsTypeParam(t) ? undefined : stringType
    }

    private reduceConditional(t: Extract<Type, { kind: "conditional" }>): Type {
        const checkType = this.reduceType(t.checkType)
        const extendsType = this.reduceType(t.extendsType)
        // Still generic — keep the whole conditional for a later instantiation.
        // Either side can hold the unknown: `Extract<Rows, { Page: P }>` knows
        // what it is testing, not what against.
        // `infer R` in the `extends` clause is bound by the clause itself, not
        // something still to be filled in.
        const free = new Set(t.inferVars)
        if (containsTypeParam(checkType) || containsTypeParam(extendsType, new Set(), free)) {
            return { ...t, checkType, extendsType }
        }

        // A conditional over a bare type parameter distributes across a union,
        // so `Exclude<"a" | "b", "a">` filters member by member instead of
        // asking whether the whole union extends `"a"`.
        if (t.distributeParam && checkType.kind === "union") {
            return union(checkType.types.map(m => this.branchOf(t, m)))
        }
        return this.branchOf(t, checkType)
    }

    /** Pick one branch of a conditional for a single (non-distributed) check
     *  type, binding any `infer` names from the `extends` clause first. */
    private branchOf(t: Extract<Type, { kind: "conditional" }>, check: Type): Type {
        const bindings = new Map<string, Type>()
        // Inside the branches the distributed parameter means *this* member.
        if (t.distributeParam) bindings.set(t.distributeParam, check)
        const extendsType = this.reduceType(t.extendsType)
        const matched = matchInfer(check, extendsType, bindings) &&
            isAssignable(check, this.stripInfer(extendsType, bindings))
        // Both branches need the bindings: the distributed parameter is bound
        // in either case, so `T extends U ? never : T` must resolve `T` in the
        // false branch too.
        if (!matched) return this.reduceType(substitute(t.falseType, bindings))
        for (const name of t.inferVars) if (!bindings.has(name)) bindings.set(name, unknownType)
        return this.reduceType(substitute(t.trueType, bindings))
    }

    /** Replace the `infer` placeholders in an `extends` clause with what they
     *  bound to, so the clause can be used as an ordinary assignability target.
     *  An unbound one becomes `unknown` — it constrains nothing. */
    private stripInfer(t: Type, bindings: Map<string, Type>): Type {
        switch (t.kind) {
            case "infer": return bindings.get(t.name) ?? unknownType
            case "array": return arrayOf(this.stripInfer(t.element, bindings))
            case "tuple": return tuple(t.elements.map(e => this.stripInfer(e, bindings)))
            case "union": return union(t.types.map(m => this.stripInfer(m, bindings)))
            case "intersection": return intersection(t.types.map(m => this.stripInfer(m, bindings)))
            case "function":
                return fn(
                    t.params.map(p => ({ ...p, type: this.stripInfer(p.type, bindings) })),
                    this.stripInfer(t.returns, bindings),
                    t.varargs && this.stripInfer(t.varargs, bindings),
                    t.typeParams,
                )
            case "object": {
                if (t.class) return t
                const entries: [string, ObjectProperty][] = []
                for (const [k, v] of t.properties) entries.push([k, { ...v, type: this.stripInfer(v.type, bindings) }])
                return objectType(entries, t.indexer && {
                    key: this.stripInfer(t.indexer.key, bindings),
                    value: this.stripInfer(t.indexer.value, bindings),
                })
            }
            default: return t
        }
    }

    /** `{ [K in C]: V }` — build one property per key in `C`. A key that is a
     *  bare `string` / `number` becomes an indexer instead (`Record<string, V>`
     *  is `{ [string]: V }`, not a property literally named "string"). */
    private reduceMapped(t: Extract<Type, { kind: "mapped" }>): Type {
        const constraint = this.reduceType(t.constraint)
        if (containsTypeParam(constraint)) return { ...t, constraint }

        const source = t.source ? this.expand(this.reduceType(t.source)) : undefined
        const members = constraint.kind === "union" ? constraint.types : [constraint]
        const entries: [string, ObjectProperty][] = []
        let indexer: Indexer | undefined

        for (const key of members) {
            const bound = new Map<string, Type>([[t.parameter, key]])
            const value = this.reduceType(substitute(t.template, bound))

            if (key.kind === "primitive" && (key.name === "string" || key.name === "number")) {
                indexer = mergeIndexer(indexer, { key, value })
                continue
            }
            if (key.kind !== "literal") continue

            // `[K in C as R]` renames; a remap to something that is not a
            // string literal drops the key, which is how TypeScript filters.
            let name = String(key.value)
            if (t.nameType) {
                const remapped = this.reduceType(substitute(t.nameType, bound))
                if (remapped.kind !== "literal") continue
                name = String(remapped.value)
            }

            // Homomorphic mapping inherits the source property's modifiers
            // unless this mapped type states one explicitly.
            const from = source?.kind === "object" ? source.properties.get(String(key.value)) : undefined
            entries.push([name, {
                type: value,
                optional: t.optional ?? from?.optional ?? false,
                readonly: t.readonly ?? from?.readonly,
            }])
        }
        return objectType(entries, indexer)
    }

    // --------------------------------------------------------
    // Statements
    // --------------------------------------------------------

    private visitBlock(block: Block, env: FlowEnv): void {
        for (const stmt of block.statements) this.visitStatement(stmt, env)
    }

    private visitStatement(stmt: Statement, env: FlowEnv): void {
        switch (stmt.type) {
            case "VariableDeclaration": {
                this.nameClassExpressions(stmt)
                const target = stmt.name
                const source = stmt.init
                if (target.type === "IdentifierPattern" && target.typeAnnotation && source) {
                    this.applyContext(source, this.resolveType(target.typeAnnotation))
                }
                const inferred = source ? this.infer(source, env) : nilType
                if (this.emitDiagnostics && target.type === "IdentifierPattern" &&
                    target.typeAnnotation && source) {
                    const declared = this.resolveType(target.typeAnnotation)
                    if (declared.kind !== "any" && !this.namesNothing(declared) &&
                        !this.fitsAnnotation(source, declared, inferred, env)) {
                        this.diagnostics.push({
                            node: stmt,
                            message: `Type '${briefType(inferred)}' is not assignable to '${briefType(declared)}'`
                                + this.explainMismatch(inferred, declared),
                        })
                    } else if (declared.kind !== "any") {
                        this.reportExcessProperties(source, declared)
                    }
                }
                // `let`   -> widen (`let n = 1` : number)
                // `const` -> keep top-level literal (`const n = 1` : 1), TS-style
                // `... as const` init -> keep everything narrow + freeze
                // Widening applies to *fresh* literal types only, as in
                // TypeScript: `let n = 1` is `number`, but `let s = shape`
                // keeps whatever `shape` was narrowed to rather than
                // widening its literal members back out.
                const mode: BindMode = this.initIsAsConst(source) ? "asconst"
                    : !isFreshLiteralExpr(source) ? "keep"
                    : stmt.kind === "const" ? "const" : "widen"
                this.bindPattern(target, inferred, env, mode)
                if (stmt.kind === "const") {
                    this.correlateDestructuring(target, inferred, env)
                    this.correlateIndexed(target, source, env)
                    this.aliasReference(target, source)
                }
                return
            }

            case "ClassDeclaration": {
                const id = this.bindingIdByName(stmt.name.name, stmt.name)
                const value = this.visitClass(stmt, env)
                if (id !== undefined) {
                    this.bindingType.set(id, value)
                    this.setBinding(env, id, value)
                }
                return
            }

            case "FunctionDeclaration": {
                this.checkParamOrder(stmt.func.params, stmt)
                for (const sig of stmt.signatures ?? []) this.checkParamOrder(sig.params, stmt)
                const id = this.bindingIdByName(stmt.name.name, stmt.name)
                this.paramsFromSignatures(stmt.func, stmt.signatures)
                const fnType = stmt.signatures?.length
                    ? intersection(stmt.signatures.map(s => this.signatureToFnType(s)))
                    : this.inferFunctionBody(stmt.func, env)
                if (id !== undefined) {
                    this.bindingType.set(id, fnType)
                    this.setBinding(env, id, fnType)
                }
                this.visitFunctionBody(stmt.func, env)
                return
            }

            case "FunctionDeclarationStatement": {
                this.checkParamOrder(stmt.func.params, stmt)
                for (const sig of stmt.signatures ?? []) this.checkParamOrder(sig.params, stmt)
                const targetId = this.bindingIdOf(stmt.target.base)
                const memberName = stmt.target.method?.name ??
                    (stmt.target.path.length === 1 ? stmt.target.path[0].name : undefined)

                if (memberName === undefined && stmt.target.path.length === 0) {
                    // Plain `function f(...)` — rebinds the name itself.
                    if (targetId !== undefined) {
                        this.paramsFromSignatures(stmt.func, stmt.signatures)
                        const fnType = stmt.signatures?.length
                            ? intersection(stmt.signatures.map(s => this.signatureToFnType(s)))
                            : this.inferFunctionBody(stmt.func, env)
                        this.bindingType.set(targetId, fnType)
                        this.setBinding(env, targetId, fnType)
                    }
                    this.visitFunctionBody(stmt.func, env)
                    return
                }

                // `function recv:m(...)` / `function recv.m(...)` — attaches a
                // member to the receiver. For the `:` form the parser already
                // injected `self` as the first parameter; typing it as the
                // receiver is what makes `self.x` work inside the body.
                const recv = targetId === undefined ? anyType : this.currentType(targetId, env)
                this.withSelfType(stmt.isMethod ? recv : undefined, () => {
                    this.paramsFromSignatures(stmt.func, stmt.signatures)
                    const fnType = stmt.signatures?.length
                        ? intersection(stmt.signatures.map(s => this.signatureToFnType(s)))
                        : this.inferFunctionBody(stmt.func, env)
                    if (memberName !== undefined && targetId !== undefined) {
                        // Types are immutable, so the member is recorded by
                        // intersecting rather than by mutating the receiver.
                        const grown = intersection([
                            recv,
                            objectType([[memberName, { type: fnType, optional: false }]]),
                        ])
                        this.bindingType.set(targetId, grown)
                        this.setBinding(env, targetId, grown)
                    }
                    this.visitFunctionBody(stmt.func, env)
                })
                return
            }

            case "AssignmentStatement": {
                const target = stmt.target
                const source = stmt.value
                if (target.type === "MemberExpression" || target.type === "IndexExpression") {
                    this.applyContext(source, this.infer(target, env))
                } else if (target.type === "Identifier") {
                    const id = this.bindingIdOf(target)
                    if (id !== undefined && this.annotated.has(id)) this.applyContext(source, this.bindingType.get(id))
                }
                const vt = this.infer(source, env)
                if (target.type === "Identifier") {
                    const id = this.bindingIdOf(target)
                    if (id !== undefined) {
                        this.uncorrelate(id)
                        const next = isFreshLiteralExpr(source) ? widen(vt) : vt
                        if (this.annotated.has(id)) {
                            const declared = this.bindingType.get(id)!
                            if (this.emitDiagnostics && !isAssignable(next, declared) && declared.kind !== "any") {
                                this.diagnostics.push({
                                    node: stmt,
                                    message: `Type '${briefType(next)}' is not assignable to '${briefType(declared)}'`
                                        + this.explainMismatch(next, declared),
                                })
                            }
                            this.setBinding(env, id, narrowTo(declared, next))
                        } else {
                            this.setBinding(env, id, next)
                            this.bindingType.set(id, union([this.bindingType.get(id) ?? next, next]))
                        }
                    }
                } else if (target.type === "MemberExpression" || target.type === "IndexExpression") {
                    this.infer(target, env)
                    this.checkReadonlyAssign(target, env)
                    // The old narrowing of this path (and anything under it)
                    // described the previous value.
                    this.assignToRef(target, isFreshLiteralExpr(source) ? widen(vt) : vt, env)
                } else if (target.type === "ObjectPattern" || target.type === "ArrayPattern") {
                    // Destructuring assignment: narrow the existing bindings
                    // to the destructured slices of the assigned value.
                    this.reassignPattern(target, vt, env)
                }
                return
            }

            case "CompoundAssignmentStatement":
                this.infer(stmt.target, env)
                this.infer(stmt.value, env)
                this.checkReadonlyAssign(stmt.target, env)
                return

            case "CallStatement":
                this.infer(stmt.expression, env)
                // `assert(x)` and friends narrow the rest of this block.
                this.applyAssertion(stmt.expression, env)
                return

            // Typed so the editor can answer about it — hover and completion
            // are why it is allowed to stand at all. It narrows nothing and
            // the compiler drops it.
            case "ExpressionStatement":
                this.infer(stmt.expression, env)
                return

            case "DoStatement":
                this.visitBlock(stmt.body, forkEnv(env))
                return

            case "WhileStatement": {
                const condType = this.infer(stmt.condition, env)
                const { whenTrue, whenFalse } = this.narrowFromCondition(stmt.condition, env)
                const breaks = this.withBreakScope(() => this.visitBlock(stmt.body, whenTrue))
                // The loop is left either because the condition failed or by a
                // `break`; `while true` has only the second way out.
                const exits = isPossiblyFalsy(condType) ? [whenFalse, ...breaks] : breaks
                this.applyLoopExits(exits, env)
                return
            }

            case "RepeatStatement": {
                // `repeat` runs its body at least once and its condition sees
                // the body's bindings, so the state after the loop is the
                // body's end state with the `until` condition holding.
                const bodyEnv = forkEnv(env)
                const breaks = this.withBreakScope(() => {
                    this.visitBlock(stmt.body, bodyEnv)
                    this.infer(stmt.condition, bodyEnv)
                })
                const { whenTrue } = this.narrowFromCondition(stmt.condition, bodyEnv)
                this.applyLoopExits([whenTrue, ...breaks], env)
                return
            }

            case "IfStatement":
                this.visitIfStatement(stmt, env)
                return

            case "NumericForStatement": {
                this.infer(stmt.start, env)
                this.infer(stmt.end, env)
                if (stmt.step) this.infer(stmt.step, env)
                const bodyEnv = forkEnv(env)
                const id = this.bindingIdByName(stmt.variable.name, stmt.variable)
                if (id !== undefined) {
                    const t = stmt.variable.typeAnnotation ? this.resolveType(stmt.variable.typeAnnotation) : numberType
                    this.bindingType.set(id, t)
                    this.setBinding(bodyEnv, id, t)
                }
                this.visitBlock(stmt.body, bodyEnv)
                return
            }

            case "GenericForStatement": {
                const sourceType = this.infer(stmt.iterator, env)
                const bodyEnv = forkEnv(env)
                const rows = this.iterationRows(stmt.iterator, sourceType)
                if (rows) {
                    // `for (const [name, value] in pairs(record))`: each item is
                    // one property's `[name, value]`, and the two names stay
                    // correlated — testing `name == "a"` narrows `value` to
                    // `a`'s type, and back.
                    this.bindPattern(stmt.variable, union(rows.map(row => tuple(row))), bodyEnv,
                        stmt.kind === "const" ? "keep" : "widen")
                    const parts = stmt.variable.type === "ArrayPattern" && !stmt.variable.rest
                        ? stmt.variable.elements.slice(0, 2).map(el => el?.value)
                        : []
                    const ids = parts.map(p => p?.type === "IdentifierPattern" ? this.bindingIdByName(p.name, p) : undefined)
                    if (ids.length === 2 && ids.every(id => id !== undefined)) {
                        this.correlateBindings(bodyEnv, ids as BindingId[], rows)
                    }
                    this.loops.set(stmt, { walks: "iteration", viaIter: false })
                } else {
                    const [item, form] = this.iterationOf(stmt.iterator, sourceType)
                    this.bindPattern(stmt.variable, item, bodyEnv, "widen")
                    this.loops.set(stmt, form)
                }
                this.visitBlock(stmt.body, bodyEnv)
                return
            }

            case "ReturnStatement": {
                const declared = this.declaredReturns[this.declaredReturns.length - 1]
                // The declared type says what belongs here: a callback takes
                // its parameters from it, a literal keeps what it admits, and
                // an editor can offer the values it names. With nothing
                // declared, the position the function was written in says it
                // instead — but only this far: `checkReturn` below still
                // answers to the annotation alone, so a hint adds no errors.
                const wanted = declared ?? this.contextualReturns[this.contextualReturns.length - 1]
                if (wanted && stmt.argument) this.applyContext(stmt.argument, wanted)
                const actual = stmt.argument ? this.infer(stmt.argument, env) : nilType
                this.checkReturn(stmt, declared, actual, env)
                if (this.returnTypes) this.returnTypes.push(actual)
                return
            }

            case "ExportStatement":
                this.visitStatement(stmt.declaration, env)
                return

            case "ExportDefaultStatement":
                if (stmt.declaration.type === "ClassDeclaration") this.visitStatement(stmt.declaration, env)
                else this.infer(stmt.declaration, env)
                return

            case "ExportNamedStatement": {
                if (stmt.source) {
                    this.checkReexport(stmt.source, stmt.specifiers.map(s => s.local))
                    return
                }
                for (const s of stmt.specifiers) {
                    if (this.bindingIdOf(s.local) !== undefined) {
                        // Records the reference's type, for tooling.
                        this.infer(s.local, env)
                    } else if (!this.aliasDefs.has(s.local.name) && !this.importedTypes.has(s.local.name)) {
                        if (this.emitDiagnostics) {
                            this.diagnostics.push({ node: s.local, message: `Cannot find name '${s.local.name}' to export` })
                        }
                    }
                }
                return
            }

            case "ExportAllStatement":
                this.checkReexport(stmt.source, [])
                return

            case "ImportStatement": {
                // Without a resolver a file cannot see other modules: `any`.
                const resolving = this.options.resolveModule !== undefined
                const exports = resolving ? this.moduleFor(stmt.source.value) : undefined
                const specifier = stmt.source.value
                const report = (node: Expression, message: string): void => {
                    if (this.emitDiagnostics) this.diagnostics.push({ node, message })
                }
                if (resolving && !exports) report(stmt.source, `Cannot find module '${specifier}'`)
                // A module still being analyzed up an import cycle has nothing
                // reliable to offer yet; read it as `any` and report nothing.
                const usable = exports && !exports.partial ? exports : undefined

                if (stmt.namespaceImport) {
                    // The module's exports as one read-only object.
                    const id = this.bindingIdByName(stmt.namespaceImport.name, stmt.namespaceImport)
                    if (id !== undefined) {
                        const members: [string, ObjectProperty][] = [...(usable?.values ?? [])]
                            .map(([name, type]) => [name, { type, optional: false, readonly: true }])
                        if (usable?.default) members.push(["default", { type: usable.default, optional: false, readonly: true }])
                        this.bindingType.set(id, usable ? objectType(members) : anyType)
                    }
                }
                if (stmt.defaultImport) {
                    if (usable && usable.default === undefined) {
                        report(stmt.defaultImport, `Module '${specifier}' has no default export`)
                    }
                    const id = this.bindingIdByName(stmt.defaultImport.name, stmt.defaultImport)
                    if (id !== undefined) this.bindingType.set(id, usable?.default ?? anyType)
                }
                for (const s of stmt.specifiers) {
                    const value = usable?.values.get(s.imported.name)
                    // A name exported only as a type imports fine: it is used in
                    // annotations, not as a value.
                    if (usable && !value && !usable.types.has(s.imported.name)) {
                        report(s.imported, `Module '${specifier}' has no exported member '${s.imported.name}'`)
                    }
                    const id = this.bindingIdByName(s.local.name, s.local)
                    if (id !== undefined) this.bindingType.set(id, value ?? anyType)
                }
                return
            }

            case "BreakStatement":
                // Record the state at the jump: it is one of the ways the
                // enclosing loop can be left, and it merges with the others.
                this.breakStates[this.breakStates.length - 1]?.push(forkEnv(env))
                return

            case "DeclareClassStatement":
                this.checkClass(stmt)
                return

            case "ContinueStatement":
            case "TypeAliasStatement":
            case "ExportTypeAliasStatement":
            case "ErrorStatement":
            case "DeclareStatement":
                return
        }
    }

    /** Run `visit` with a fresh place to collect `break` states, and return
     *  what it collected. */
    private withBreakScope(visit: () => void): FlowEnv[] {
        this.breakStates.push([])
        try {
            visit()
            return this.breakStates[this.breakStates.length - 1]
        } finally {
            this.breakStates.pop()
        }
    }

    /** Join the states a loop can be left in and write them back to `env`.
     *  No exits at all means the loop never terminates normally, so nothing
     *  after it is reachable and `env` is left alone. */
    private applyLoopExits(exits: FlowEnv[], env: FlowEnv): void {
        if (!exits.length) return
        const base = (key: RefKey): Type => env.get(key) ?? this.declaredAtRef(key)
        const merged = exits.reduce((a, b) => mergeEnv(a, b, base))
        for (const [k, v] of merged) env.set(k, v)
    }

    /** True when control can never fall off the end of `block` — it returns,
     *  breaks, continues, calls something that never returns (`error`), or is
     *  an if/else where every branch does. Used for early-return narrowing, so
     *  it has to run *after* the block was visited: whether a call exits
     *  depends on its inferred return type. */
    private blockAlwaysExits(block: Block): boolean {
        const last = block.statements[block.statements.length - 1]
        if (!last) return false
        switch (last.type) {
            case "ReturnStatement":
            case "BreakStatement":
            case "ContinueStatement":
                return true
            case "DoStatement":
                return this.blockAlwaysExits(last.body)
            case "CallStatement":
                // `error(...)` is declared `-> never`, so the statement after
                // it is unreachable.
                return this.typeOf.get(last.expression)?.kind === "never"
            case "IfStatement":
                return !!last.alternate &&
                    last.clauses.every(c => this.blockAlwaysExits(c.body)) &&
                    this.blockAlwaysExits(last.alternate)
            default:
                return false
        }
    }

    private visitIfStatement(stmt: IfStatement, env: FlowEnv): void {
        let elseEnv = forkEnv(env)
        // Only branches that can fall through contribute to the post-if state.
        // A branch ending in `return` / `break` / `continue` narrows the code
        // that follows the `if` (early-return pattern).
        const fallThrough: FlowEnv[] = []

        for (const clause of stmt.clauses) {
            this.infer(clause.condition, elseEnv)
            const { whenTrue, whenFalse } = this.narrowFromCondition(clause.condition, elseEnv)
            const branchEnv = forkEnv(whenTrue)
            this.visitBlock(clause.body, branchEnv)
            if (!this.blockAlwaysExits(clause.body)) fallThrough.push(branchEnv)
            elseEnv = whenFalse
        }

        if (stmt.alternate) {
            const altEnv = forkEnv(elseEnv)
            this.visitBlock(stmt.alternate, altEnv)
            if (!this.blockAlwaysExits(stmt.alternate)) fallThrough.push(altEnv)
        } else {
            fallThrough.push(elseEnv)
        }

        if (fallThrough.length) {
            const base = (key: RefKey): Type => env.get(key) ?? this.declaredAtRef(key)
            const merged = fallThrough.reduce((a, b) => mergeEnv(a, b, base))
            for (const [k, v] of merged) env.set(k, v)
        }
    }

    // --------------------------------------------------------
    // Functions
    // --------------------------------------------------------

    /** `returns`, when given, collects the type of each `return` the walk
     *  reads — see `inferFunctionBody`. */
    private visitFunctionBody(func: FunctionBody, outerEnv: FlowEnv, returns?: Type[]): void {
        this.withTypeParams(func.generics, () => this.visitFunctionBodyInner(func, outerEnv, returns))
    }

    /** A parameter's type: annotation, else a shape synthesized from a
     *  destructuring pattern, else inferred from its default, else `any`. */
    private paramType(
        p: {
            name?: string
            typeAnnotation?: TypeNode
            default?: Expression
            optional?: boolean
            rest?: boolean
            pattern?: ObjectPattern | ArrayPattern
        },
        env: FlowEnv,
    ): Type {
        // The receiver the parser injects carries no annotation: `self` for
        // `function T:m()`, `this` for a class method. Its type is what it is
        // called on — for a class, the instance type, which is the only thing
        // that works for a generic one (`Box<T>`) and for one written as a
        // value.
        const receiver = p.name === "self" || p.name === "this"
        if (!p.typeAnnotation && !p.pattern && !p.default && receiver && this.selfType) {
            return this.selfType
        }
        // `name?: T` means the argument may be missing, and a missing argument
        // is `nil` in Luau — so the parameter's type is `T | nil`.
        if (p.typeAnnotation) {
            const t = this.resolveType(p.typeAnnotation)
            // `function f(mode: Mode = "fast")` — the default is written where
            // the annotation says what fits.
            if (p.default) this.applyContext(p.default, t)
            return p.optional ? optional(t) : t
        }
        if (p.rest) return arrayOf(unknownType)
        if (p.pattern) return this.patternToType(p.pattern, env)
        if (p.default) return widen(this.infer(p.default, env))
        const contextual = this.contextualParams.get(p)
        if (contextual) return contextual
        // Nothing says what it holds, and nothing will: a parameter with no
        // type is `any`, which turns off every check made of what is done
        // with it. Where it is written says so.
        if (this.emitDiagnostics && !receiver && p.name && (p as { line?: unknown }).line
            && !this.untypedParamReported.has(p)) {
            this.untypedParamReported.add(p)
            this.diagnostics.push({
                node: p as unknown as Expression,
                message: `Parameter '${p.name}' has no type, so it is 'any': give it one, or a default to read it from`,
            })
        }
        return anyType
    }

    /** Parameters already spoken about: a body is visited more than once. */
    private readonly untypedParamReported = new WeakSet<object>()

    /** What a function expression's unannotated parameters are, from where
     *  it is written — see `applyContext`. */
    private readonly contextualParams = new WeakMap<object, Type>()

    /** What a function expression written in a typed position returns, from
     *  that position — see `applyContext`. A body with no `return` annotation
     *  would otherwise infer its `return` expressions with nothing wanted of
     *  them, and widen the literals in them: `() => S = function() { return
     *  { Status: true } }` inferred `Status: boolean` and then failed against
     *  `S`. It is a hint, not a contract: only `applyContext` reads it, so a
     *  body that does not match still reports at the assignment, not here. */
    private readonly contextualReturnOf = new WeakMap<object, Type>()

    /** `contextualReturnOf` for each function body being walked, alongside
     *  `declaredReturns`. */
    private readonly contextualReturns: (Type | undefined)[] = []

    /** `expected` is the type the surroundings want for `expr`. A function
     *  expression written there takes its unannotated parameters' types from
     *  it, as in TypeScript: `signal:Connect(function(player) ... end)` knows
     *  `player` from `Connect`'s callback type. Anything else is inferred as
     *  usual. */
    /** The arguments of a call, in two passes where one is needed.
     *
     *  A function written at the call site with a parameter nothing annotates
     *  reads that parameter from the signature — and where the signature says
     *  `(v: T) => U`, `T` is only known once the other arguments have been
     *  read. So such an argument is read once quietly, to get a shape to pick
     *  a signature with, and then again with `T` in hand: `map(xs, v => v + 1)`
     *  has its `v` a number by then, and `U` follows from what the body
     *  answers. Everything else is read once, as it always was. */
    private inferArguments(
        written: readonly Expression[],
        fns: readonly FunctionType[],
        selfOf: (f: FunctionType) => number,
        extra: (f: FunctionType, args: Type[]) => Type[],
        env: FlowEnv,
    ): Type[] {
        const expected = this.expectedArguments(written, fns as FunctionType[], selfOf)
        written.forEach((a, i) => this.applyContext(a, expected[i]))
        const waits = written.map((a, i) => this.waitsOnInference(a, expected[i]))
        if (!waits.some(Boolean)) return written.map(a => this.infer(a, env))

        const argTypes = written.map((a, i) => (waits[i] ? this.quietly(() => this.infer(a, env)) : this.infer(a, env)))
        const picked = this.pickOverload(fns as FunctionType[], argTypes, f => extra(f, argTypes), this.spreadOf(written, selfOf(fns[0])))
        const subst = picked?.typeParams?.length
            ? this.inferTypeArgs(picked, extra(picked, argTypes))
            : undefined
        written.forEach((a, i) => {
            if (!waits[i]) return
            if (picked && subst) {
                const self = selfOf(picked)
                const declared = i + self < picked.params.length ? picked.params[i + self].type : picked.varargs
                if (declared) this.applyContext(a, this.reduceType(substitute(declared, subst)))
            }
            argTypes[i] = this.infer(a, env)
        })
        return argTypes
    }

    /** Is this argument a function whose own type waits on the call's? */
    private waitsOnInference(arg: Expression, expected: Type | undefined): boolean {
        if (!expected || !containsTypeParam(expected)) return false
        let e = arg
        while (e.type === "ParenthesizedExpression") e = e.expression
        if (e.type !== "FunctionExpression") return false
        return e.func.params.some(p =>
            !p.typeAnnotation && !p.default && !p.pattern && p.name !== "self" && p.name !== "this")
    }

    /** Read something without saying anything about it: a first pass whose
     *  only purpose is a shape to go on. */
    private quietly<T>(read: () => T): T {
        const was = this.emitDiagnostics
        this.emitDiagnostics = false
        try {
            return read()
        } finally {
            this.emitDiagnostics = was
        }
    }

    private applyContext(expr: Expression, expected: Type | undefined): void {
        let e = expr
        while (e.type === "ParenthesizedExpression") e = e.expression
        if (!expected) return
        // What belongs here, for whoever asks — an editor completing a string
        // inside `const mode: Mode = "|"` reads this.
        this.expectedTypeOf.set(expr, expected)
        this.expectedTypeOf.set(e, expected)
        if (e.type === "ArrayExpression") return this.applyArrayContext(e, expected)
        if (e.type === "TableExpression") return this.applyTableContext(e, expected)
        // `Config.Paths or []` is the Lua way to write a default: what the
        // surroundings want of the whole is wanted of either side.
        if (e.type === "BinaryExpression" && (e.operator === "or" || e.operator === "and")) {
            if (e.operator === "or") this.applyContext(e.left, expected)
            this.applyContext(e.right, expected)
            return
        }
        if (e.type !== "FunctionExpression") return
        const members = expected.kind === "union" ? expected.types : [expected]
        const signatures = members.flatMap(m => this.overloadsOf(this.expand(m)))
        if (!signatures.length) return
        // What the position wants back, for a body that does not say. A
        // generic still waiting on the call's own inference says nothing.
        if (!e.func.returnType && !e.func.predicate) {
            const returns = signatures.map(s => s.returns).filter(t => !containsTypeParam(t))
            if (returns.length) this.contextualReturnOf.set(e.func, union(returns))
        }
        e.func.params.forEach((p, k) => {
            if (p.typeAnnotation || p.pattern || p.default) return
            const candidates: Type[] = []
            for (const signature of signatures) {
                const t = signature.params[k]?.type ?? signature.varargs
                if (t) candidates.push(t)
            }
            if (!candidates.length) return
            const t = union(candidates)
            // A callback still generic in the call's own type parameters would
            // need those inferred first; say nothing rather than guess.
            this.contextualParams.set(p, containsTypeParam(t) ? anyType : t)
        })
    }

    /** What an array literal is expected to be: an empty one takes that type
     *  outright — `let queue: thread[] = []` is a `thread[]`, as in TypeScript
     *  — and the elements of any other get the element type as their own
     *  context. */
    private readonly contextualArrays = new WeakMap<ArrayExpression, Type>()

    private applyArrayContext(e: ArrayExpression, expected: Type): void {
        // Of several tuples, the one this literal can be: its length, or a
        // shorter one with a rest to take the others.
        const members = this.expectedMembers(expected)
        const tuples = members.filter((m): m is Extract<Type, { kind: "tuple" }> => m.kind === "tuple")
        const spread = e.elements.some(el => el.type === "SpreadElement")
        const length = e.elements.length
        const fitting = tuples.find(t => !spread && !t.rest && t.elements.length === length)
            ?? tuples.find(t => t.rest !== undefined && (spread || length >= t.elements.length))
        const target = fitting ?? members.find(m => m.kind === "array") ?? tuples[0]
        if (!target) return
        if (target.kind === "tuple" && e.elements.length) this.tupleArrays.set(e, target)
        if (!e.elements.length) {
            // `const missing: T[] = []` inside a generic function: the
            // annotation is what it is, type parameter and all.
            this.contextualArrays.set(e, target)
            return
        }
        e.elements.forEach((element, i) => {
            if (element.type === "SpreadElement") return
            const tupleTarget = target as Extract<Type, { kind: "tuple" }>
            const elementType = target.kind === "array" ? target.element : tupleTarget.elements[i] ?? tupleTarget.rest
            this.applyContext(element, elementType)
        })
    }

    /** Array literals written where a tuple is wanted — a `return` of a
     *  function that returns one, an argument, an annotated `const` — and
     *  the tuple each is to be. */
    private readonly tupleArrays = new WeakMap<ArrayExpression, Extract<Type, { kind: "tuple" }>>()

    /** `{ list: [] }` where `{ list: thread[] }` is expected: each field's
     *  value gets its property's type as context. */
    private applyTableContext(e: TableExpression, expected: Type): void {
        const objects = this.expectedMembers(expected).filter((m): m is ObjectType => m.kind === "object")
        if (!objects.length) return
        for (const field of e.fields) {
            if (field.type !== "TableFieldNamed" && field.type !== "TableFieldShorthand") continue
            const key = field.type === "TableFieldShorthand" ? field.name.name
                : field.key.type === "Identifier" ? field.key.name : field.key.value
            const types = objects.flatMap(o => {
                const property = o.properties.get(key)
                return property ? [property.type] : o.indexer ? [o.indexer.value] : []
            })
            if (types.length) {
                const target = field.type === "TableFieldShorthand" ? field.name : field.value
                this.contextArms.set(target, types)
                this.applyContext(target, union(types))
            }
        }
    }

    /** The members of an expected type worth matching a literal against:
     *  aliases seen through, `nil` left out. */
    private expectedMembers(expected: Type): Type[] {
        const t = this.expand(expected)
        const members = t.kind === "union" ? t.types : [t]
        const flattened = members.map(m => this.expand(m)).flatMap(m =>
            m.kind === "intersection" ? m.types.map(x => this.expand(x)) : [m])
        return flattened.filter(m => !(m.kind === "primitive" && m.name === "nil"))
    }

    /** The parameter type each written argument lands on, across `fns`. */
    private expectedArguments(
        written: readonly Expression[],
        fns: FunctionType[],
        selfOf: (f: FunctionType) => number,
    ): (Type | undefined)[] {
        return written.map((_, j) => {
            const candidates: Type[] = []
            for (const f of fns) {
                const i = j + selfOf(f)
                const declared = i < f.params.length ? f.params[i].type : f.varargs
                // Before inference, `boundParams` substitutes unconstrained T
                // with any. Keep a structural parameter's real generic shape
                // as literal context, otherwise `{ nested: T }` loses the
                // nested literal before T has a chance to be inferred.
                const param = declared && containsTypeParam(declared)
                    ? declared
                    : i < f.params.length ? this.boundParams(f)[i] : f.varargs
                if (param) candidates.push(param)
            }
            return candidates.length ? union(candidates) : undefined
        })
    }

    /** Synthesize a type from a destructuring pattern used without an
     *  annotation (`function f({ a, b = 1 })`). */
    private patternToType(target: ObjectPattern | ArrayPattern, env: FlowEnv): Type {
        const leaf = (v: BindingTarget, def: Expression | undefined): Type =>
            v.type !== "IdentifierPattern" ? this.patternToType(v, env)
                : v.typeAnnotation ? this.resolveType(v.typeAnnotation)
                : def ? widen(this.infer(def, env))
                : anyType
        if (target.type === "ObjectPattern") {
            const entries: [string, ObjectProperty][] = []
            for (const p of target.properties) {
                const key = !p.computed && p.key.type === "Identifier" ? p.key.name
                    : !p.computed && p.key.type === "StringLiteral" ? p.key.value : undefined
                if (key === undefined) continue
                entries.push([key, { type: leaf(p.value, p.default), optional: p.default !== undefined }])
            }
            return objectType(entries)
        }
        return tuple(target.elements.map(el => el ? leaf(el.value, el.default) : anyType))
    }

    /** A function type with the rest parameter among `params` written in:
     *  `...args: T[]` collects `T`s, and `...args: A` — `A` a tuple, or a
     *  type parameter standing for one — is exactly `A`'s elements. */
    private withRest(f: FunctionType, params: readonly { rest?: boolean; typeAnnotation?: TypeNode }[]): FunctionType {
        const rest = params.find(p => p.rest)
        if (!rest) return f
        if (!rest.typeAnnotation) return { ...f, varargs: unknownType }
        const declared = this.resolveType(rest.typeAnnotation)
        const t = this.expand(declared)
        if (t.kind === "array") return { ...f, varargs: t.element }
        if (t.kind === "any") return { ...f, varargs: anyType }
        // `...args: infer P` in a pattern stands for the whole list too.
        if (declared.kind === "infer") return { ...f, varargs: declared, restIsWhole: true }
        // A tuple is the parameters it lists, and its rest what is left to
        // collect; a type parameter is that once it is known.
        if (t.kind === "tuple") {
            return { ...f, params: [...f.params, ...t.elements.map(type => ({ type }))], varargs: t.rest }
        }
        if (declared.kind === "typeParam") return { ...f, varargs: declared, restIsWhole: true }
        return { ...f, varargs: unknownType }
    }

    /** What each function body being walked declared it returns. */
    private readonly declaredReturns: (Type | undefined)[] = []

    /** Run `body` with `return` as `func` declares it. */
    private withVarargs<T>(func: FunctionBody, body: () => T): T {
        this.declaredReturns.push(func.predicate
            ? booleanType
            : func.returnType ? this.resolveType(func.returnType) : undefined)
        this.contextualReturns.push(this.contextualReturnOf.get(func))
        try {
            return body()
        } finally {
            this.declaredReturns.pop()
            this.contextualReturns.pop()
        }
    }

    private visitFunctionBodyInner(func: FunctionBody, outerEnv: FlowEnv, returns?: Type[]): void {
        const env = forkEnv(outerEnv)
        for (const p of func.params) {
            if (p.pattern) {
                const type = this.paramType(p, env)
                this.bindPattern(p.pattern, type, env, "widen")
                this.correlateDestructuring(p.pattern, type, env)
                continue
            }
            const id = this.bindingIdByName(p.name, p)
            const t = this.paramType(p, env)
            if (id !== undefined) {
                this.bindingType.set(id, t)
                this.setBinding(env, id, t)
                if (p.typeAnnotation) this.annotated.add(id)
            }
        }
        this.withVarargs(func, () => this.collectReturns(returns, () => {
            this.visitBlock(func.body, env)
            this.checkReturnsAtAll(func, this.declaredReturns[this.declaredReturns.length - 1])
        }))
    }

    /** Return type of calling `f` with `argTypes`. For a generic function,
     *  infers the type parameters from the arguments and substitutes. */
    private callReturn(f: Extract<Type, { kind: "function" }>, argTypes: Type[], explicit?: readonly Type[]): Type {
        if (!f.typeParams?.length) return f.returns
        // Reduce after substituting: a return type such as `Services[K]` is a
        // deferred indexed access until `K` is known, which is exactly now.
        return this.reduceType(substitute(f.returns, this.inferTypeArgs(f, argTypes, explicit)))
    }

    /** Infer a generic call's type arguments from the argument types.
     *
     *  An argument is widened before matching — `id(1)` gives `number`, not
     *  `1` — *except* against a parameter whose constraint is made of literal
     *  types, where the literal is the whole point. That is what lets
     *  `<K extends keyof T>(name: K) -> T[K]` pick out one property. */
    /** The type arguments a call writes out, checked for count. */
    private explicitTypeArguments(
        expr: { typeArguments?: (TypeNode)[] },
        fns: readonly FunctionType[],
    ): Type[] | undefined {
        const written = expr.typeArguments
        if (!written?.length) return undefined
        const resolved = written.map(node => this.resolveType(node as TypeNode))
        const most = Math.max(0, ...fns.map(f => f.typeParams?.length ?? 0))
        if (this.emitDiagnostics && resolved.length > most) {
            this.diagnostics.push({
                node: written[most] as TypeNode,
                message: most === 0
                    ? "This call takes no type arguments"
                    : `Expected ${most} type argument${most === 1 ? "" : "s"}, got ${resolved.length}`,
            })
        }
        return resolved
    }

    /** `<T = Instance>`: what a call falls back to for a parameter it neither
     *  is given nor can infer. */
    private withTypeParamDefaults(type: Type, generics: readonly GenericTypeParameter[]): Type {
        if (type.kind !== "function") return type
        const defaults: Record<string, Type> = {}
        for (const generic of generics) {
            if (generic.default) defaults[generic.name] = this.resolveType(generic.default)
        }
        return Object.keys(defaults).length ? { ...type, typeParamDefaults: defaults } : type
    }

    private inferTypeArgs(f: FunctionType, argTypes: (Type | undefined)[], explicit?: readonly Type[]): Map<string, Type> {
        const subst = new Map<string, Type>()
        // `f<Folder>(x)`: what the call says takes precedence over what its
        // arguments would suggest.
        if (explicit?.length) {
            (f.typeParams ?? []).forEach((name, i) => {
                if (explicit[i]) subst.set(name, explicit[i])
            })
        }
        const vars = new Set((f.typeParams ?? []).filter(name => !subst.has(name)))
        f.params.forEach((p, i) => {
            const arg = argTypes[i]
            if (arg === undefined) return
            // The constraint may still be an unevaluated `keyof` (see
            // `reduceTypeInner`); whether it is made of literals is only known
            // once it is evaluated.
            const param = p.type.kind === "typeParam" && p.type.constraint
                ? { ...p.type, constraint: this.reduceType(p.type.constraint) }
                : p.type
            // A generic inside a structural parameter is inferred from the
            // literal written at that slot. `wrap({ value: { kind: "ok" } })`,
            // for `{ value: T }`, must retain that nested literal shape for T.
            // A bare T retains its existing widening behaviour unless `<const T>`.
            const preserve = keepsLiterals(param)
                || (param.kind !== "typeParam" && containsTypeParam(param))
            // Each parameter is its own inference site: the first one to
            // pin a name down keeps it, and a later argument that does not
            // fit is reported against it rather than widening it away.
            unify(p.type, preserve ? arg : widen(arg), vars, subst, "first")
        })
        // The arguments `...` takes say what it holds, the way a parameter's
        // does: `firstOf(1, 2)` of a `(...items: T[])` reads `T` as `number`.
        if (f.varargs && f.restIsWhole) {
            const rest = argTypes.slice(f.params.length).map(a => a === undefined ? unknownType : widen(a))
            unify(f.varargs, tuple(rest), vars, subst)
        } else if (f.varargs) {
            const keeps = keepsLiterals(f.varargs)
            for (let i = f.params.length; i < argTypes.length; i++) {
                const arg = argTypes[i]
                if (arg !== undefined) unify(f.varargs, keeps ? arg : widen(arg), vars, subst)
            }
        }
        for (const name of f.typeParams ?? []) {
            if (!subst.has(name)) subst.set(name, f.typeParamDefaults?.[name] ?? unknownType)
        }
        return subst
    }

    /** Re-infer the arguments that land on a `<const T>` parameter, keeping
     *  them as narrow as they were written: literals stay literal and an array
     *  literal becomes a tuple. Only the const positions are redone, and only
     *  once the overload is known — which parameter is `const` depends on it. */
    private constArgs(
        f: FunctionType,
        written: readonly Expression[],
        argTypes: Type[],
        env: FlowEnv,
        selfOffset = 0,
    ): Type[] {
        if (!f.typeParams?.length) return argTypes
        const out = [...argTypes]
        f.params.forEach((p, i) => {
            if (p.type.kind !== "typeParam" || !p.type.isConst) return
            const arg = written[i - selfOffset]
            if (arg) out[i - selfOffset] = this.inferAsConst(arg, env)
        })
        return out
    }

    /** Choose the signature a call resolves to, TypeScript-style: the first
     *  one that accepts the arguments, with generic catch-alls considered only
     *  after every concrete signature has been tried. That ordering is what
     *  lets `typeof` declare `(v: number) -> "number"` alongside a trailing
     *  `<T>(v: T) -> string` and still pick the precise one. */
    private pickOverload(
        fns: FunctionType[],
        argTypes: Type[],
        argsFor?: (f: FunctionType) => Type[],
        spread?: SpreadInfo,
    ): FunctionType | undefined {
        for (const generic of [false, true]) {
            for (const f of fns) {
                if (((f.typeParams?.length ?? 0) > 0) !== generic) continue
                if (this.overloadAccepts(f, argsFor ? argsFor(f) : argTypes, spread)) return f
            }
        }
        return undefined
    }

    /** An overload set called with a union argument, one member at a time.
     *
     *  One signature for the whole union is often only the catch-all:
     *  `typeof(v)` with `v: Part | nil` accepts nothing more specific than
     *  `typeof<T>(value: T): string`. Each member on its own picks `"Instance"`
     *  and `"nil"`, and that union is what the call returns — whenever every
     *  member picks a signature listed ahead of the whole union's. Otherwise
     *  (a signature taking the union as it is, or a member nothing accepts)
     *  this returns `undefined` and the ordinary pick stands. */
    private distributedReturn(
        fns: FunctionType[],
        argTypes: Type[],
        picked: FunctionType | undefined,
        argsFor: (f: FunctionType, args: Type[]) => Type[],
    ): Type | undefined {
        if (fns.length < 2) return undefined
        // An `any` argument fits every signature, so the first one is not the
        // answer — every one of them is. `type(v)` on an `any` is a `string`,
        // not the `"nil"` its first overload happens to promise.
        if (argTypes.some(t => this.expand(t).kind === "any")) {
            const taken = fns.filter(f => this.overloadAccepts(f, argsFor(f, argTypes)))
            if (taken.length < 2) return undefined
            return union(taken.map(f => this.callReturn(f, argsFor(f, argTypes))))
        }
        const position = argTypes.findIndex(t => this.expand(t).kind === "union")
        if (position < 0) return undefined
        const members = (this.expand(argTypes[position]) as Extract<Type, { kind: "union" }>).types
        if (members.length > 32) return undefined
        // The order `pickOverload` tries signatures in.
        const rank = (f: FunctionType): number =>
            ((f.typeParams?.length ?? 0) > 0 ? fns.length : 0) + fns.indexOf(f)
        const limit = picked ? rank(picked) : Infinity
        const results: Type[] = []
        for (const member of members) {
            const args = argTypes.map((t, i) => (i === position ? member : t))
            const chosen = this.pickOverload(fns, args, f => argsFor(f, args))
            if (!chosen || rank(chosen) >= limit) return undefined
            results.push(this.callReturn(chosen, argsFor(chosen, args)))
        }
        return union(results)
    }

    /** Can this signature be called with these argument types? The signature's
     *  own type parameters stand for what the call would infer, so each is
     *  checked only against its constraint — `<K extends keyof Services>`
     *  accepts `"Players"` but not `""`. */
    private overloadAccepts(f: FunctionType, argTypes: Type[], spread?: SpreadInfo): boolean {
        // From a spread on, every argument is one of the array's values.
        const at = (i: number): Type | undefined => {
            if (!spread || i < spread.index) return argTypes[i]
            if (!spread.elements) return argTypes[spread.index]
            const held = spread.elements[i - spread.index]
            return held ?? argTypes[i - spread.index + 1 + spread.elements.length - 1]
        }
        const written = spread?.elements
            ? argTypes.length + spread.elements.length - 1
            : argTypes.length
        if (!f.varargs && (!spread || spread.elements) && written > f.params.length) return false
        // What `...` holds is checked too — that is what `...: string` and
        // `...rest: string[]` say. A generic signature is left to inference,
        // which checks the arguments once it knows what its parameters are.
        if (f.varargs && !f.typeParams?.length) {
            const last = spread && !spread.elements ? Math.max(f.params.length + 1, written) : written
            for (let i = f.params.length; i < last; i++) {
                const arg = at(i)
                if (arg !== undefined && !isAssignable(arg, f.varargs)) return false
            }
        }
        const params = this.boundParams(f)
        return f.params.every((p, i) => {
            // Only `?` (or a default) makes an argument omissible. A parameter
            // typed `T | nil` still has to be passed something — `nil`, if
            // that is what you mean — exactly as in TypeScript.
            const arg = at(i)
            if (arg === undefined) return p.optional === true
            return isAssignable(arg, params[i])
        })
    }

    /** A signature's parameter types as a call site sees them before inference:
     *  each type parameter replaced by its constraint, or by `any` when it has
     *  none — or when the constraint mentions another type parameter, which a
     *  lone argument cannot be checked against without false errors. */
    private boundParams(f: FunctionType): Type[] {
        if (!f.typeParams?.length) return f.params.map(p => p.type)
        // A signature is asked this once per call site written against it, and
        // an overloaded library function is asked it for every candidate. The
        // answer is the signature's alone.
        const known = this.boundParamsCache.get(f)
        if (known) return known
        const bounds = new Map<string, Type>(f.typeParams.map(name => [name, anyType]))
        const seen = new WeakSet<object>()
        const walk = (value: unknown): void => {
            if (!value || typeof value !== "object" || seen.has(value)) return
            seen.add(value)
            if (value instanceof Map) {
                value.forEach(walk)
                return
            }
            const t = value as { kind?: unknown; name?: unknown; constraint?: Type; class?: unknown }
            // A class is never generic, and walking into one walks every
            // class it can reach.
            if (t.kind === "object" && t.class) return
            if (t.kind === "typeParam" && typeof t.name === "string" && bounds.has(t.name)
                && t.constraint && !containsTypeParam(t.constraint)) {
                bounds.set(t.name, this.reduceType(t.constraint))
            }
            for (const child of Object.values(value)) walk(child)
        }
        for (const p of f.params) if (containsTypeParam(p.type)) walk(p.type)
        const bound = f.params.map(p => this.reduceType(substitute(p.type, bounds)))
        this.boundParamsCache.set(f, bound)
        return bound
    }

    private readonly boundParamsCache = new WeakMap<FunctionType, Type[]>()

    /** Record what each written argument is expected to be — see
     *  `TypeAnalysis.expectedTypeOf`. */
    private recordExpected(
        written: readonly Expression[],
        fns: FunctionType[],
        selfOf: (f: FunctionType) => number,
        argsOf: (f: FunctionType) => readonly Type[] = () => [],
    ): void {
        const paramsOf = new Map<FunctionType, Type[]>()
        for (const f of fns) paramsOf.set(f, this.paramsAsCalled(f, argsOf(f)))
        written.forEach((arg, j) => {
            const candidates: Type[] = []
            for (const f of fns) {
                const i = j + selfOf(f)
                const params = paramsOf.get(f)!
                const param = i < params.length ? params[i] : f.varargs
                if (param) candidates.push(param)
            }
            if (candidates.length) this.expectedTypeOf.set(arg, union(candidates))
        })
    }

    /** The parameters as *this* call makes them read: a type argument the
     *  arguments already written pin down is substituted in, and one nothing
     *  has pinned down yet falls back to its constraint.
     *
     *  It is what makes the second argument of
     *  `get(page, skill: Extract<Rows, { Page: Page }>["Skills"][number])`
     *  worth completing — with `page` written, `skill` is the skills of that
     *  page, not of every page. */
    private paramsAsCalled(f: FunctionType, argTypes: readonly Type[]): Type[] {
        const fallback = this.boundParams(f)
        if (!f.typeParams?.length || !argTypes.length) return fallback
        return f.params.map((p, i) => {
            if (!containsTypeParam(p.type)) return p.type
            // What the *other* arguments say. An argument does not get to
            // decide what it is itself: reading `get("")` as `Page = ""`
            // would make the very argument being written the only thing that
            // fits it.
            const subst = this.inferTypeArgs(f, argTypes.map((t, k) => (k === i ? undefined : t)))
            // A type parameter nothing pinned down stays open; leaving it in
            // the substitution would resolve the type against `unknown`.
            for (const [name, bound] of [...subst]) if (bound.kind === "unknown") subst.delete(name)
            if (!subst.size) return fallback[i]
            const applied = this.reduceType(substitute(p.type, subst))
            return containsTypeParam(applied) ? fallback[i] : applied
        })
    }

    /** No signature accepts the call, and the argument count is not the
     *  problem: say which argument is wrong, the way TypeScript does. */
    /** Check what was written against the parameters as this call's own type
     *  arguments make them read: `pick("Bones", "C")` is wrong only once `P`
     *  is known to be `"Bones"`. Picking the overload goes by each parameter's
     *  constraint, which is deliberately looser than that. */
    private checkInferredArguments(
        call: Expression,
        written: readonly Expression[],
        f: FunctionType,
        argTypes: readonly Type[],
        self: number,
    ): void {
        if (!this.emitDiagnostics || !f.typeParams?.length) return
        const subst = this.inferTypeArgs(f, [...argTypes])
        // A parameter nothing pinned down stands for anything, and checking
        // against what it fell back to would invent errors.
        for (const bound of subst.values()) if (bound.kind === "unknown") return
        const declaredAt = (i: number): Type | undefined =>
            i < f.params.length ? f.params[i].type : f.varargs
        for (let i = 0; i < Math.max(f.params.length, argTypes.length); i++) {
            const arg = argTypes[i]
            const declared = declaredAt(i)
            if (arg === undefined || declared === undefined || !containsTypeParam(declared)) continue
            let expected: Type | undefined = this.reduceType(substitute(declared, subst))
            // `...args: A`, with `A` now a tuple: this argument is one place of it.
            if (f.restIsWhole && i >= f.params.length) {
                const whole = this.expand(expected)
                expected = whole.kind === "tuple" ? whole.elements[i - f.params.length] ?? whole.rest
                    : whole.kind === "array" ? whole.element
                    : undefined
                if (!expected) continue
            }
            if (containsTypeParam(expected) || expected.kind === "any" || expected.kind === "unknown") continue
            if (isAssignable(arg, expected) || isAssignable(widen(arg), expected)) continue
            this.diagnostics.push({
                node: written[i - self] ?? call,
                message: `Argument of type '${formatType(arg)}' is not assignable to parameter of type '${briefType(expected)}'`
                    + this.explainMismatch(arg, expected),
            })
            return
        }
    }

    private reportArguments(
        call: Expression,
        written: readonly Expression[],
        fns: FunctionType[],
        argsFor: (f: FunctionType) => Type[],
        selfOf: (f: FunctionType) => number,
    ): void {
        if (!this.emitDiagnostics) return
        if (fns.length > 1) {
            this.diagnostics.push({ node: call, message: "No overload matches this call" })
            return
        }
        const f = fns[0]
        const args = argsFor(f)
        const params = this.boundParams(f)
        const self = selfOf(f)
        const spread = this.spreadOf(written, self)
        for (let i = 0; i < f.params.length; i++) {
            // From the spread on, its values fill the remaining parameters,
            // and the first one that refuses is what is reported.
            const arg = spread && i >= spread.index ? this.spreadValue(spread, i) : args[i]
            if (spread && i > spread.index && !spread.elements) break
            if (arg === undefined || arg.kind === "never" || isAssignable(arg, params[i])) continue
            this.diagnostics.push({
                node: (spread && i >= spread.index ? written[spread.index - self] : written[i - self]) ?? call,
                message: `Argument of type '${formatType(arg)}' is not assignable to parameter of type '${briefType(params[i])}'`
                    + this.explainMismatch(arg, params[i]),
            })
            return
        }
        if (!f.varargs || f.typeParams?.length) return
        for (let i = f.params.length; i < args.length; i++) {
            if (isAssignable(args[i], f.varargs)) continue
            this.diagnostics.push({
                node: written[i - self] ?? call,
                message: `Argument of type '${formatType(args[i])}' is not assignable to parameter of type '${briefType(f.varargs)}'`
                    + this.explainMismatch(args[i], f.varargs),
            })
            return
        }
    }

    /** A required parameter may not follow an optional one — otherwise the
     *  optional one could never actually be omitted. Same rule as TypeScript,
     *  and it applies to a default (`a = 1`) as much as to a `?`. */
    private checkParamOrder(
        params: readonly { name?: string; optional?: boolean; rest?: boolean; default?: unknown }[],
        node: Expression | Statement | ClassMember,
    ): void {
        if (!this.emitDiagnostics) return
        let seenOptional: string | undefined
        for (const p of params) {
            // A rest parameter takes whatever is left, so nothing about the
            // order before it is wrong.
            if (p.rest === true) {
                this.checkRestType(p, node)
                continue
            }
            const isOptional = p.optional === true || p.default !== undefined
            if (isOptional) {
                if (seenOptional === undefined) seenOptional = p.name ?? "parameter"
                continue
            }
            if (seenOptional !== undefined) {
                this.diagnostics.push({
                    node,
                    message: `Required parameter '${p.name ?? "?"}' cannot follow optional parameter '${seenOptional}'`,
                })
                return
            }
        }
    }

    /** How many arguments a signature requires, and the most it accepts
     *  (`undefined` when it is variadic). */
    private arityOf(f: FunctionType): { min: number; max: number | undefined } {
        let min = 0
        for (let i = 0; i < f.params.length; i++) if (!f.params[i].optional) min = i + 1
        return { min, max: f.varargs ? undefined : f.params.length }
    }

    /** Report a call that passes too few or too many arguments. Only fires
     *  when *no* overload accepts the count, so an overload set still reports
     *  once, against its first signature. Returns whether the count fits, so
     *  an argument's type is only complained about when its count is right. */
    private checkArity(
        node: Expression, fns: FunctionType[], argCount: number, selfArgs: number,
        spread?: SpreadInfo,
    ): boolean {
        if (!fns.length) return true
        // A spread array may hold any number of values, this call included. A
        // tuple holds a known number, so the count is known after all.
        if (spread && !spread.elements) return true
        if (spread?.elements) argCount += spread.elements.length - 1
        const fits = fns.some(f => {
            const { min, max } = this.arityOf(f)
            const n = argCount + selfArgs
            return n >= min && (max === undefined || n <= max)
        })
        if (fits) return true
        if (!this.emitDiagnostics) return false
        const { min, max } = this.arityOf(fns[0])
        const need = max === undefined ? `at least ${min - selfArgs}`
            : min === max ? `${min - selfArgs}`
            : `${min - selfArgs}-${max - selfArgs}`
        this.diagnostics.push({
            node,
            message: `Expected ${need} argument${need === "1" ? "" : "s"}, got ${argCount}`,
        })
        return false
    }

    /** An overload set's implementation handles every signature, so a bare
     *  parameter of it holds whatever those signatures allow there:
     *  `function f(Stat, ...)` under 36 `Stat: "..."` signatures is the union
     *  of all 36. TypeScript leaves such a parameter `any`; this says what it
     *  can actually be. An annotation, a pattern or a default still wins. */
    private paramsFromSignatures(func: FunctionBody, signatures: readonly FunctionSignature[] | undefined): void {
        if (!signatures?.length) return
        const resolved = signatures.map(sig => this.signatureToFnType(sig))
        func.params.forEach((param, i) => {
            if (param.typeAnnotation || param.pattern || param.default) return
            const candidates: Type[] = []
            for (const signature of resolved) {
                if (signature.kind !== "function") continue
                const own = signature.params[i]
                if (own) candidates.push(own.optional ? optional(own.type) : own.type)
                else if (signature.varargs) candidates.push(signature.varargs)
            }
            if (candidates.length) this.contextualParams.set(param, union(candidates))
        })
    }

    private signatureToFnType(sig: FunctionSignature): Type {
        const names = sig.generics.map(g => g.name)
        // Recorded against the signature itself: one line of an overload set
        // reads as what that line declares, not as the whole set.
        const record = (type: Type): Type => {
            this.typeOfTypeNode.set(sig as unknown as TypeNode, type)
            return type
        }
        return record(this.withTypeParams(sig.generics, () => {
            const params = sig.params.filter(p => !p.rest).map(p => ({
                name: p.pattern ? undefined : p.name,
                type: this.paramType(p, new Map()),
                optional: p.optional || p.default !== undefined,
            }))
            return this.withRest(fn(
                params,
                sig.returnType ? this.resolveType(sig.returnType) : sig.predicate ? booleanType : anyType,
                undefined,
                names,
                this.resolvePredicate(sig.predicate, params),
            ), sig.params)
        }))
    }

    /** `...rest: T[]` holds every argument from its position on, so its type
     *  is an array of what each one is. */
    private checkRestType(
        p: { name?: string; typeAnnotation?: unknown },
        node: TypeDiagnostic["node"],
    ): void {
        if (!this.emitDiagnostics || !p.typeAnnotation) return
        const declared = this.resolveType(p.typeAnnotation as TypeNode)
        if (declared.kind === "array" || declared.kind === "tuple" || declared.kind === "any" || declared.kind === "typeParam") return
        this.diagnostics.push({
            node,
            message: `A rest parameter holds every argument from its position on, so '${p.name ?? "..."}' `
                + `is an array: '${formatType(declared)}[]', not '${formatType(declared)}'`,
        })
    }

    /** Turn a parsed `v is T` / `asserts v` annotation into a `TypePredicate`,
     *  resolving the named parameter to its index. A guard naming a parameter
     *  the function does not have is dropped rather than mis-narrowing an
     *  unrelated argument. */
    private resolvePredicate(
        node: TypePredicateNode | undefined,
        params: { name?: string }[],
    ): TypePredicate | undefined {
        if (!node) return undefined
        const param = params.findIndex(p => p.name === node.parameterName)
        if (param < 0) return undefined
        return {
            param,
            type: node.typeAnnotation ? this.resolveType(node.typeAnnotation) : undefined,
            asserts: node.asserts,
        }
    }

    /** `visited`, when given, is what the real walk of the body just
     *  collected from its `return`s: a function expression is walked before
     *  its type is asked for, so there is nothing left to guess, and walking
     *  the body a second time only to read them made every callback nested in
     *  another cost twice its parent's. */
    private inferFunctionBody(func: FunctionBody, env: FlowEnv, visited?: readonly Type[]): Type {
        const names = func.generics.map(g => g.name)
        return this.withTypeParams(func.generics, () => {
            const params = func.params.flatMap(p => {
                const type = this.paramType(p, env)
                // Record each parameter's type before the next one's annotation
                // is read, so `(limit: number, value: typeof limit)` sees
                // `limit`. The body pass records the same type again later.
                if (!p.pattern) {
                    const id = this.bindingIdByName(p.name, p)
                    if (id !== undefined && !this.bindingType.has(id)) this.bindingType.set(id, type)
                }
                // A rest parameter is the varargs, not a parameter of its own.
                if (p.rest) return []
                return [{
                    name: p.pattern ? undefined : p.name,
                    type,
                    optional: p.optional || p.default !== undefined,
                }]
            })
            // Infer the return type with the parameters bound, so `return { x: p }`
            // sees `p`'s type rather than `any`.
            const bodyEnv = forkEnv(env)
            for (const p of func.params) {
                if (p.pattern) this.bindPattern(p.pattern, this.paramType(p, bodyEnv), bodyEnv, "widen")
                else {
                    const id = this.bindingIdByName(p.name, p)
                    if (id !== undefined) this.setBinding(bodyEnv, id, this.paramType(p, bodyEnv))
                }
            }
            let returns: Type
            if (func.returnType) {
                returns = this.resolveType(func.returnType)
            } else if (func.predicate) {
                returns = booleanType
            } else if (visited) {
                // A body with no `return` the walk reached still has its
                // `return`s read where they stand, as below.
                returns = visited.length
                    ? union([...visited])
                    : this.withVarargs(func, () => this.silently(() => this.inferReturnType(func.body, bodyEnv)))
            } else {
                // Walk the body once, silently, so locals have types before the
                // `return` expressions are read — otherwise `local r = f()
                // return r` infers `any`. The real visit runs afterwards and
                // overwrites everything this pass recorded.
                // Both passes are guesswork the real visit redoes: they read
                // `return` expressions outside the branch they are written in,
                // where a narrowed name still looks like what it was declared.
                // Both passes are guesswork the real visit redoes; neither
                // reports anything.
                const collected: Type[] = []
                returns = this.withVarargs(func, () => this.silently(() => {
                    this.collectReturns(collected, () => this.preVisitBody(func.body, bodyEnv))
                    // A body too deep for the pre-visit collected nothing:
                    // read its `return`s where they stand instead.
                    return collected.length ? union(collected) : this.inferReturnType(func.body, bodyEnv)
                }))
            }
            return this.withRest(fn(
                params, returns,
                undefined,
                names,
                this.resolvePredicate(func.predicate, params),
            ), func.params)
        })
    }

    /** Where the return types of the function being walked are collected, so
     *  each is read where it is written — inside the branch that narrowed it —
     *  rather than in whatever state the body ends in. */
    private returnTypes: Type[] | undefined

    private collectReturns<T>(into: Type[] | undefined, body: () => T): T {
        const previous = this.returnTypes
        this.returnTypes = into
        try {
            return body()
        } finally {
            this.returnTypes = previous
        }
    }

    /** Run something without reporting what it finds. */
    private silently<T>(body: () => T): T {
        const wasEmitting = this.emitDiagnostics
        this.emitDiagnostics = false
        try {
            return body()
        } finally {
            this.emitDiagnostics = wasEmitting
        }
    }

    /** Populate binding types for a function body without reporting anything,
     *  purely so an un-annotated return type can see its own locals. Bounded:
     *  nested functions stop pre-visiting after a couple of levels, since the
     *  cost compounds and the payoff drops off fast. */
    private preVisitBody(body: Block, env: FlowEnv): void {
        if (this.preVisitDepth >= 2) return
        this.preVisitDepth++
        const wasEmitting = this.emitDiagnostics
        this.emitDiagnostics = false
        try {
            this.visitBlock(body, env)
        } finally {
            this.emitDiagnostics = wasEmitting
            this.preVisitDepth--
        }
    }

    /** The `[key, value]` items `pairs(record)` hands out, one per property.
     *  `undefined` for anything else (an array, a dictionary, an iterator
     *  function), whose keys have no names to list. */
    private iterationRows(iterNode: Expression | undefined, iterType: Type): Type[][] | undefined {
        let source: Type | undefined
        if (iterNode?.type === "CallExpression" && iterNode.callee.type === "Identifier" && iterNode.arguments[0]) {
            if (iterNode.callee.name !== "pairs") return undefined
            source = this.typeOf.get(iterNode.arguments[0])
        } else {
            return undefined
        }
        const t = source && this.expand(source)
        if (!t || t.kind !== "object" || t.class || t.indexer || !t.properties.size) return undefined
        return [...t.properties].map(([name, property]) => [
            literal(name),
            property.optional ? optional(property.type) : property.type,
        ])
    }

    /** Bindings that hold parts of one value: the key and value of a `pairs`
     *  row, or the names destructured from one union member. By flow key.
     *  Which rows are still possible is itself flow state, kept in `env` under
     *  `group` as a union of tuples, so it narrows and merges like any type. */
    private readonly correlations = new Map<RefKey, { group: RefKey; index: number; keys: RefKey[]; rows: Type[][] }>()

    private correlateBindings(env: FlowEnv, ids: BindingId[], rows: Type[][]): void {
        const keys = ids.map(bindKey)
        const group = `rows(${keys.join(",")})`
        keys.forEach((key, index) => this.correlations.set(key, { group, index, keys, rows }))
        env.set(group, union(rows.map(row => tuple(row))))
    }

    /** `key` was just narrowed to `narrowed` in `env`: narrow that column of
     *  every row, drop the rows it rules out, and give the other bindings what
     *  the remaining rows hold. */
    private correlate(env: FlowEnv, key: RefKey, narrowed: Type): void {
        const entry = this.correlations.get(key)
        if (!entry) return
        const state = env.get(entry.group)
        const current = state && (state.kind === "union" ? state.types : [state]).every(t => t.kind === "tuple")
            ? (state.kind === "union" ? state.types : [state]).map(t => (t as Extract<Type, { kind: "tuple" }>).elements)
            : entry.rows
        const kept: Type[][] = []
        for (const row of current) {
            const column = narrowTo(row[entry.index], narrowed)
            if (column.kind !== "never") kept.push(row.map((t, i) => (i === entry.index ? column : t)))
        }
        env.set(entry.group, kept.length ? union(kept.map(row => tuple(row))) : neverType)
        entry.keys.forEach((other, j) => {
            if (j !== entry.index) env.set(other, kept.length ? union(kept.map(row => row[j])) : neverType)
        })
    }

    /** Stop correlating a binding once it is assigned: its value no longer
     *  comes from the row. */
    private uncorrelate(id: BindingId): void {
        const entry = this.correlations.get(bindKey(id))
        if (entry) for (const key of entry.keys) this.correlations.delete(key)
    }

    /** `const { kind, payload } = action` over a union of objects: one row per
     *  member, so testing `kind` narrows `payload` (TypeScript's destructured
     *  discriminated unions). Only plain `name` / `key: name` properties take
     *  part. */
    /** Names that denote one and the same value: `const c = player.Character`
     *  makes `c` and `player.Character` two spellings of one reference. Kept
     *  as an undirected graph of flow keys. */
    private readonly refAliases = new Map<RefKey, Set<RefKey>>()

    /** `const c = a.b` — `c` cannot be re-bound and the path was read once, so
     *  a test of either name is a test of the same value. Only property paths
     *  take part: `const c = other` would tie `c` to a name that may itself be
     *  assigned a different value later. */
    private aliasReference(target: BindingTarget, init: Expression | undefined): void {
        if (target.type !== "IdentifierPattern" || !init) return
        const source = unwrapParens(init)
        if (source.type !== "MemberExpression" && source.type !== "IndexExpression") return
        const path = this.refKeyOf(source)
        const id = this.bindingIdByName(target.name, target)
        if (path === undefined || id === undefined) return
        const name = bindKey(id)
        for (const [a, b] of [[name, path], [path, name]]) {
            const set = this.refAliases.get(a) ?? new Set<RefKey>()
            set.add(b)
            this.refAliases.set(a, set)
        }
    }

    /** A reference was narrowed: give every other spelling of the same value
     *  the same news. Walks the alias graph, so a path with two names told by
     *  one of them reaches the other. Each alias keeps whatever it already
     *  knew — the narrowing only ever cuts the type further down. */
    private propagateAliases(env: FlowEnv, into: FlowEnv, key: RefKey, narrowed: Type): void {
        if (!this.refAliases.size) return
        const seen = new Set<RefKey>([key])
        const queue: [RefKey, Type][] = [[key, narrowed]]
        const learn = (at: RefKey, t: Type): void => {
            seen.add(at)
            this.setRef(into, at, t)
            this.correlate(into, at, t)
            queue.push([at, t])
        }
        for (let at = 0; at < queue.length; at++) {
            const [from, t] = queue[at]
            for (const other of this.refAliases.get(from) ?? []) {
                if (seen.has(other)) continue
                const current = into.get(other) ?? env.get(other) ?? this.declaredAtRef(other)
                const next = narrowTo(current, t)
                learn(other, next.kind === "never" ? t : next)
                // The alias may itself be a property of something — the same
                // walk up the path `narrowRef` does for the tested reference,
                // so a copied discriminant still picks its union member.
                for (let child = other, value = into.get(other)!; ;) {
                    const cut = child.lastIndexOf(".")
                    if (cut <= 0) break
                    const parent = child.slice(0, cut)
                    if (seen.has(parent)) break
                    const had = into.get(parent) ?? env.get(parent) ?? this.declaredAtRef(parent)
                    value = this.filterByProperty(had, child.slice(cut + 1), value)
                    learn(parent, value)
                    child = parent
                }
            }
        }
    }

    /** `const path = paths[stat]` where `stat` is one of several keys: which
     *  value came back says which key was asked for. Testing the value then
     *  narrows the key — the `else` of `if path then` leaves exactly the keys
     *  the table does not have. */
    private correlateIndexed(target: BindingTarget, init: Expression | undefined, env: FlowEnv): void {
        if (target.type !== "IdentifierPattern" || !init) return
        const source = unwrapParens(init)
        if (source.type !== "IndexExpression" || source.index.type !== "Identifier") return
        const valueId = this.bindingIdByName(target.name, target)
        const keyId = this.bindingIdOf(source.index)
        if (valueId === undefined || keyId === undefined) return
        const key = this.expand(this.currentType(keyId, env))
        if (key.kind !== "union" || key.types.length < 2 || key.types.length > 64) return
        if (!key.types.every(m => m.kind === "literal")) return
        const object = this.expand(this.typeOf.get(source.object) ?? unknownType)
        if (object.kind !== "object") return
        this.correlateBindings(env, [keyId, valueId], key.types.map(m => [m, this.indexedType(object, m)]))
    }

    private correlateDestructuring(pattern: BindingTarget, source: Type, env: FlowEnv): void {
        if (pattern.type !== "ObjectPattern") return
        const members = this.expand(source)
        if (members.kind !== "union") return
        const objects = members.types.map(m => this.expand(m))
        if (objects.length < 2 || objects.some(m => m.kind !== "object")) return
        const ids: BindingId[] = []
        const names: string[] = []
        for (const property of pattern.properties) {
            if (property.computed || property.default || property.value.type !== "IdentifierPattern") return
            const name = property.key.type === "Identifier" ? property.key.name
                : property.key.type === "StringLiteral" ? property.key.value : undefined
            const id = this.bindingIdByName(property.value.name, property.value)
            if (name === undefined || id === undefined) return
            ids.push(id)
            names.push(name)
        }
        if (ids.length < 2) return
        this.correlateBindings(env, ids, objects.map(member => names.map(name => this.propertyType(member, name))))
    }

    /** `[step, state, first]` — what a call such as `pairs(t)` answers — as
     *  the `step` function, or `undefined` for an array that is just an
     *  array. Three places exactly, the first a function. */
    private iterationTriple(t: Type): FunctionType | undefined {
        if (t.kind !== "tuple" || t.rest || t.elements.length !== 3) return undefined
        const step = this.expand(t.elements[0])
        return step.kind === "function" ? step : undefined
    }

    /** What one `for (const item in source)` hands over each time, and how it
     *  walks the source. `pairs`/`ipairs` are read from the table they are
     *  given, so a record's keys stay the literals they are. */
    private iterationOf(source: Expression, sourceType: Type, report = true): [Type, LoopForm] {
        // `pairs(t)` / `ipairs(t)`: each item is the table's `[key, value]`.
        if (source.type === "CallExpression" && source.callee.type === "Identifier" && source.arguments[0]) {
            const name = source.callee.name
            const src = this.expand(this.typeOf.get(source.arguments[0]) ?? unknownType)
            const iteration = { walks: "iteration", viaIter: false } as const
            if (name === "ipairs") return [tuple([numberType, this.elementType(src, 0)]), iteration]
            if (name === "pairs") {
                if (src.kind === "object") {
                    return [tuple([src.indexer?.key ?? stringType,
                        src.indexer?.value ?? union([...src.properties.values()].map(p => p.type))]), iteration]
                }
                if (src.kind === "array") return [tuple([numberType, src.element]), iteration]
            }
        }
        // An iterator function, called until it answers nil — or the
        // `[step, state, first]` an iteration is.
        const handsOut = (t: Type, viaIter: boolean): [Type, LoopForm] | undefined => {
            const x = this.expand(t)
            if (x.kind === "function") return [withoutNil(this.expand(x.returns)), { walks: "function", viaIter }]
            const step = this.iterationTriple(x)
            if (step) return [withoutNil(this.expand(step.returns)), { walks: "iteration", viaIter }]
            return undefined
        }
        const direct = handsOut(sourceType, false)
        if (direct) return direct

        const values = { walks: "values", viaIter: false } as const
        const t = this.expand(sourceType)
        if (t.kind === "any") return [anyType, values]
        // `__iter` answers the iterator, or the iteration, to walk with.
        const iter = t.kind === "object" ? t.properties.get("__iter") : undefined
        if (iter) {
            const made = this.overloadsOf(iter.type)[0]?.returns ?? unknownType
            return handsOut(made, true) ?? [unknownType, { walks: "values", viaIter: true }]
        }
        // A table walked as it is: each item is one of its values.
        if (t.kind === "array") return [t.element, values]
        if (t.kind === "tuple") return [union([...t.elements, ...(t.rest ? [t.rest] : [])]), values]
        if (t.kind === "object") {
            return [t.indexer?.value ?? union([...t.properties.values()].map(p => p.type)), values]
        }
        // Whichever member it holds is walked the same way, so the item is
        // one of theirs — as long as they agree on how they are walked.
        if (t.kind === "union") {
            const each = t.types.map(member => this.iterationOf(source, member, false))
            const [first] = each
            if (first && each.every(([, form]) =>
                form.walks === first[1].walks && form.viaIter === first[1].viaIter)) {
                return [union(each.map(([item]) => item)), first[1]]
            }
        }
        if (t.kind !== "never" && report && this.emitDiagnostics) {
            this.diagnostics.push({
                node: source,
                message: `Cannot loop over '${formatType(sourceType)}': a loop walks an array, a table, an iterator function or an iteration such as 'pairs(t)'`,
            })
        }
        return [unknownType, values]
    }

    private inferReturnType(body: Block, env: FlowEnv): Type {
        const returns: Type[] = []
        const walk = (block: Block): void => {
            for (const s of block.statements) {
                if (s.type === "ReturnStatement") {
                    returns.push(s.argument ? this.infer(s.argument, env) : nilType)
                } else if (s.type === "IfStatement") {
                    for (const c of s.clauses) walk(c.body)
                    if (s.alternate) walk(s.alternate)
                } else if (s.type === "DoStatement" || s.type === "WhileStatement" ||
                    s.type === "NumericForStatement" || s.type === "GenericForStatement") {
                    walk(s.body)
                } else if (s.type === "RepeatStatement") {
                    walk(s.body)
                }
            }
        }
        walk(body)
        return returns.length ? union(returns) : nilType
    }

    // --------------------------------------------------------
    // Patterns
    // --------------------------------------------------------

    /** Assignability check with a bit of contextual typing: an array literal
     *  checked against a tuple annotation is matched element-wise (a plain
     *  `infer` would have widened it to an array type). */
    private fitsAnnotation(init: Expression, declared: Type, inferred: Type, env: FlowEnv): boolean {
        if (declared.kind === "tuple" && init.type === "ArrayExpression" &&
            !init.elements.some(e => e.type === "SpreadElement")) {
            // As many as it names — or, with a rest, at least that many, the
            // others each one of the rest.
            const fits = declared.rest
                ? init.elements.length >= declared.elements.length
                : init.elements.length === declared.elements.length
            if (!fits) return false
            return init.elements.every((el, i) =>
                isAssignable(widen(this.infer(el as Expression, env)), declared.elements[i] ?? declared.rest!))
        }
        // Check the type as inferred *first*: widening can only ever make a
        // value less assignable, so a narrowed `"yes"` must still satisfy a
        // `"yes"` annotation. The widened retry covers a fresh literal handed
        // to a primitive annotation.
        if (isAssignable(inferred, declared) || isAssignable(widen(inferred), declared)) return true
        // Contextual retry: an object/array literal against an annotation keeps
        // its literal property types (needed for discriminated-union targets
        // like `{ ok: true }`).
        if (init.type === "TableExpression") return isAssignable(this.inferObject(init, env, true), declared)
        if (init.type === "ArrayExpression") return isAssignable(this.inferArray(init, env, true), declared)
        return false
    }

    /** `{ a, ...rest }`: what `rest` holds — the value without the properties
     *  the pattern already took. */
    private withoutKeys(raw: Type, properties: readonly ObjectPatternProperty[]): Type {
        const taken = new Set(properties.flatMap(p => (!p.computed && p.key.type === "Identifier" ? [p.key.name]
            : !p.computed && p.key.type === "StringLiteral" ? [p.key.value] : [])))
        if (!taken.size) return raw
        const t = this.expand(raw)
        if (t.kind === "union") return union(t.types.map(m => this.withoutKeys(m, properties)))
        if (t.kind !== "object") return raw
        const kept: [string, ObjectProperty][] = [...t.properties].filter(([name]) => !taken.has(name))
        if (kept.length === t.properties.size) return raw
        return objectType(kept, t.indexer, t.frozen)
    }

    /** Fold a destructuring default (`{ a = 1 }`) into the property's type:
     *  the default applies when the source value is missing/`nil`. */
    private withDefault(base: Type, def: Expression | undefined, env: FlowEnv): Type {
        if (!def) return base
        const d = widen(this.infer(def, env))
        if (base.kind === "any" || base.kind === "unknown") return d
        return union([narrowExclude(base, nilType), d])
    }

    /** Like `bindPattern`, but the leaves are *existing* bindings (a `{a} = t`
     *  assignment). Updates their flow type; keeps a declared annotation. */
    private reassignPattern(target: BindingTarget, valueType: Type, env: FlowEnv): void {
        switch (target.type) {
            case "IdentifierPattern": {
                const id = this.scopes.bindingOf.get(target)
                if (id === undefined) return
                const next = widen(valueType)
                if (this.annotated.has(id)) {
                    const declared = this.bindingType.get(id)!
                    this.setBinding(env, id, narrowTo(declared, next))
                } else {
                    this.setBinding(env, id, next)
                    this.bindingType.set(id, union([this.bindingType.get(id) ?? next, next]))
                }
                return
            }
            case "ObjectPattern": {
                for (const p of target.properties) {
                    const key = !p.computed && p.key.type === "Identifier" ? p.key.name
                        : !p.computed && p.key.type === "StringLiteral" ? p.key.value : undefined
                    const pt = key !== undefined ? this.propertyType(valueType, key) : unknownType
                    this.reassignPattern(p.value, this.withDefault(pt, p.default, env), env)
                }
                if (target.rest) this.reassignPattern(target.rest, this.withoutKeys(valueType, target.properties), env)
                return
            }
            case "ArrayPattern": {
                target.elements.forEach((el, i) => {
                    if (el) this.reassignPattern(el.value, this.withDefault(this.elementType(valueType, i), el.default, env), env)
                })
                if (target.rest) this.reassignPattern(target.rest, this.restAfter(valueType, target.elements.length), env)
                return
            }
        }
    }

    private bindPattern(target: BindingTarget, valueType: Type, env: FlowEnv, mode: BindMode): void {
        switch (target.type) {
            case "IdentifierPattern": {
                const id = this.bindingIdByName(target.name, target)
                let t: Type
                if (target.typeAnnotation) {
                    t = this.resolveType(target.typeAnnotation)
                    if (id !== undefined) this.annotated.add(id)
                } else {
                    t = mode === "asconst" || mode === "keep" ? valueType
                        : mode === "const" ? (valueType.kind === "literal" ? valueType : widen(valueType))
                        : widen(valueType)
                }
                if (id !== undefined) {
                    this.bindingType.set(id, t)
                    this.setBinding(env, id, t)
                }
                return
            }
            case "ObjectPattern": {
                for (const p of target.properties) {
                    const key = !p.computed && p.key.type === "Identifier" ? p.key.name
                        : !p.computed && p.key.type === "StringLiteral" ? p.key.value
                        : undefined
                    const propType = key !== undefined ? this.propertyType(valueType, key) : unknownType
                    this.bindPattern(p.value, this.withDefault(propType, p.default, env), env, mode)
                }
                if (target.rest) this.bindPattern(target.rest, this.withoutKeys(valueType, target.properties), env, mode)
                return
            }
            case "ArrayPattern": {
                target.elements.forEach((el, i) => {
                    if (!el) return
                    this.bindPattern(el.value, this.withDefault(this.elementType(valueType, i), el.default, env), env, mode)
                })
                if (target.rest) this.bindPattern(target.rest, this.restAfter(valueType, target.elements.length), env, mode)
                return
            }
        }
    }

    /** Expand a nominal `genericRef` back to its alias's structure.
     *  Recursive aliases were left as refs during their own resolution; this
     *  resolves them on demand for member access and for structural
     *  comparison.
     *
     *  Memoised, and that is load-bearing rather than an optimisation: a class
     *  hierarchy expands to a very large type, `isAssignable` asks for the
     *  same expansions constantly, and the recursion guard in `isAssignable`
     *  works by object identity — so the same ref must yield the *same*
     *  object every time. The cache entry is seeded with the ref itself before
     *  resolving, which is what breaks re-entry on a recursive alias. */
    private expand(t: Type): Type {
        if (t.kind !== "genericRef") return t
        // A ref another module made: its name means what it meant there.
        if (t.origin && t.origin !== this.origin) return t.origin.expand(t)
        const def = this.aliasDefs.get(t.name)
        // A generic type this file imported is not in `aliasDefs` — the module
        // it came from said what it is. A generic class arrives this way
        // constantly: its own methods name it (`this: Box<T>`), and that
        // reference travels with the type.
        if (!def) {
            const imported = this.importedTypes.get(t.name)
            if (!imported) return t
            if (!imported.params.length) return imported.type
            const subst = new Map<string, Type>()
            imported.params.forEach((name, i) => subst.set(name, t.typeArguments[i] ?? unknownType))
            const key = `import ${formatType(t)}`
            const cached = this.expandCache.get(key)
            if (cached) return cached
            this.expandCache.set(key, t)
            const applied = substitute(imported.type, subst)
            this.expandCache.set(key, applied)
            return applied
        }
        if (this.resolvingAliases.has(t.name)) return t

        const key = t.typeArguments.length ? formatType(t) : t.name
        const cached = this.expandCache.get(key)
        if (cached) return cached
        this.expandCache.set(key, t)

        this.resolvingAliases.add(t.name)
        try {
            const r = def.params.length
                ? this.instantiateAlias(def, t.typeArguments)
                : this.resolveDef(def)
            // Display the alias name only for a plain alias. A *generic*
            // instantiation must keep its structure: `Pair` alone would not
            // say which `Pair`, and the point of `Partial<User>` is the
            // object it reduces to.
            const named = def.params.length === 0 ? withAliasName(r, t.name) : r
            this.expandCache.set(key, named)
            return named
        } finally {
            this.resolvingAliases.delete(t.name)
        }
    }

    /** `names:filter(f)`, `text:trim()` — the methods arrays and strings have.
     *  They are written in the prelude as `ArrayMethods<T>` and
     *  `StringMethods`, so a file (or a type library) that declares one of
     *  those names again replaces the whole set, and nothing here is a special
     *  case in the analyzer. The build lowers each call to a plain function. */
    private builtInMethod(t: Type, name: string): Type | undefined {
        // A union of arrays is still an array to its methods — what one holds
        // is any of their elements. Same for a union of strings.
        const parts = (t.kind === "union" ? t.types : [t]).map(m => this.expand(m))
        const elements = parts.map(m => (m.kind === "array" ? m.element
            : m.kind === "tuple" ? union(m.elements)
            : undefined))
        const element = elements.every(e => e !== undefined) ? union(elements as Type[]) : undefined
        const isString = (m: Type): boolean =>
            (m.kind === "primitive" && m.name === "string") ||
            (m.kind === "literal" && m.base === "string") ||
            m.kind === "templateLiteral"
        const methodTable = element !== undefined ? "ArrayMethods"
            : parts.every(isString) ? "StringMethods"
            : undefined
        const def = methodTable === undefined ? undefined : this.aliasDefs.get(methodTable)
        if (!def || def.class) return undefined
        const table = this.expand(this.instantiateAlias(def as { params: GenericTypeParameter[]; node: TypeNode }, element !== undefined ? [element] : []))
        // Libraries layer, so the set may be an intersection of what each gave
        // it; the last to declare a name wins.
        const layers = table.kind === "intersection" ? table.types.map(m => this.expand(m)) : [table]
        for (let i = layers.length - 1; i >= 0; i--) {
            const part = layers[i]
            const property = part.kind === "object" ? part.properties.get(name) : undefined
            if (property) return property.type
        }
        return undefined
    }

    /** The most a deferred type could turn out to be. A conditional is one of
     *  its branches, and the true branch stands for a member of what was
     *  tested (`T` in `T extends U ? T : never`); an indexed access reads
     *  through the bound of what it indexes. Anything else has no bound worth
     *  giving — `undefined` leaves the comparison as it was. */
    private deferredBound(t: Type, depth = 0): Type | undefined {
        if (depth > 8) return undefined
        switch (t.kind) {
            case "conditional": {
                const check = this.reduceType(t.checkType)
                if (containsTypeParam(check)) return undefined
                const subst = new Map<string, Type>()
                if (t.distributeParam) subst.set(t.distributeParam, check)
                for (const name of t.inferVars ?? []) subst.set(name, unknownType)
                const branches = [substitute(t.trueType, subst), t.falseType]
                    .map(branch => this.reduceType(branch))
                if (branches.some(branch => containsTypeParam(branch))) return undefined
                return union(branches)
            }
            case "indexedAccess": {
                const object = this.deferredBound(t.objectType, depth + 1)
                    ?? this.atConstraints(t.objectType)
                const index = this.atConstraints(this.reduceType(t.indexType))
                if (!object || !index) return undefined
                return this.indexedType(object, index)
            }
            default:
                return undefined
        }
    }

    /** `t` with every type parameter standing at its constraint: `Map[K]`
     *  where `K extends "a" | "b"` is at most what those two keys hold. A
     *  parameter with no constraint bounds nothing, and says so. */
    private atConstraints(t: Type): Type | undefined {
        if (!containsTypeParam(t)) return t
        const bounds = new Map<string, Type>()
        const seen = new WeakSet<object>()
        let open = false
        const walk = (value: unknown): void => {
            if (!value || typeof value !== "object" || seen.has(value)) return
            seen.add(value)
            if (value instanceof Map) {
                value.forEach(walk)
                return
            }
            const part = value as { kind?: unknown; name?: unknown; constraint?: Type; class?: unknown }
            if (part.kind === "object" && part.class) return
            if (part.kind === "typeParam" && typeof part.name === "string") {
                if (part.constraint && !containsTypeParam(part.constraint)) {
                    bounds.set(part.name, this.reduceType(part.constraint))
                } else {
                    open = true
                }
            }
            for (const child of Object.values(value)) walk(child)
        }
        walk(t)
        if (open) return undefined
        const applied = this.reduceType(substitute(t, bounds))
        return containsTypeParam(applied) ? undefined : applied
    }

    /** What `text["upper"]` reads: a string answers only to its methods, the
     *  way Lua's string metatable does. */
    private stringMember(object: Type, index: Type): Type | undefined {
        if (index.kind !== "literal" || typeof index.value !== "string") return undefined
        const parts = this.stringParts(object)
        if (!parts) return undefined
        const found = parts.map(part => this.builtInMethod(part, index.value as string))
        return found.every(t => t !== undefined) ? union(found as Type[]) : undefined
    }

    /** The members of `t` when every one of them is a string — `"a" | "b"` is
     *  as much a string as `string` is. */
    private stringParts(t: Type): Type[] | undefined {
        let expanded = this.expand(t)
        // A type still waiting on a type parameter counts when everything it
        // could become is a string.
        if (expanded.kind === "conditional" || expanded.kind === "indexedAccess") {
            const bound = this.deferredBound(expanded)
            if (!bound) return undefined
            expanded = this.expand(bound)
        }
        const parts = (expanded.kind === "union" ? expanded.types : [expanded]).map(m => this.expand(m))
        const isString = (m: Type): boolean =>
            (m.kind === "primitive" && m.name === "string") ||
            (m.kind === "literal" && m.base === "string") ||
            m.kind === "templateLiteral"
        return parts.length && parts.every(isString) ? parts : undefined
    }

    /** `text.Sans` or `text["Sans"]`: a string is not a table, and the only
     *  members it has are the ones a type library gave it — so a name that is
     *  not one of them is a mistake worth reporting, rather than the nil Lua
     *  would hand back. */
    private checkStringMember(node: Expression, object: Type, key: Type): void {
        if (!this.emitDiagnostics || !this.aliasDefs.has("StringMethods")) return
        const parts = this.stringParts(object)
        if (!parts) return
        // The key may be one name or a choice of them; anything less definite
        // says nothing worth reporting.
        const keys = (key.kind === "union" ? key.types : [key]).map(m => this.expand(m))
        if (!keys.length || !keys.every(m => m.kind === "literal" && typeof m.value === "string")) return
        const names = keys.map(m => String((m as Extract<Type, { kind: "literal" }>).value))
        if (names.some(name => parts.some(part => this.builtInMethod(part, name)))) return
        this.diagnostics.push({
            node,
            message: names.length === 1
                ? `'${names[0]}' does not exist on a string`
                : `'${briefType(key)}' does not name a member of a string`,
        })
    }

    /** `game.Anything` on a `{ GetService: ... }`, or `a.a` on a number: a
     *  value whose members are all known, and none of them is this one. Only
     *  a type that is known through and through is reported — an indexer, an
     *  `any`, or a part still waiting on a type parameter could each supply
     *  the name. An empty `{}` is a table still being filled in, so it is left
     *  alone; an array's and a string's members come from a library, so
     *  without one they say nothing. A string on its own is `checkStringMember`'s. */
    private checkMissingMember(node: Identifier, object: Type, name: string): void {
        if (!this.emitDiagnostics || this.missingMemberReported.has(node)) return
        if (!this.memberMissing(object, name)) return
        this.missingMemberReported.add(node)
        this.diagnostics.push({
            node,
            message: `Property '${name}' does not exist on type '${briefType(withoutNil(this.expand(object)))}'`,
        })
    }

    /** Is `name` certainly not a member of `object`? See `checkMissingMember`. */
    private memberMissing(object: Type, name: string): boolean {
        if (this.stringParts(object)) return false
        const raw = this.expand(object)
        const parts = (raw.kind === "union" ? raw.types : [raw]).map(m => this.deferredAccess(this.expand(m)))
        let missing = false
        for (const part of parts) {
            switch (part.kind) {
                case "primitive":
                    if (part.name === "nil") continue
                    if (part.name === "string" && !this.aliasDefs.has("StringMethods")) return false
                    if (part.name === "string" && this.builtInMethod(part, name)) continue
                    break
                case "literal":
                case "templateLiteral":
                    if (part.kind === "templateLiteral" || part.base === "string") {
                        if (!this.aliasDefs.has("StringMethods")) return false
                    }
                    if (this.builtInMethod(part, name)) continue
                    break
                case "array":
                case "tuple":
                    if (!this.aliasDefs.has("ArrayMethods")) return false
                    if (this.builtInMethod(part, name)) continue
                    break
                case "object":
                    if (part.properties.has(name)) continue
                    if (part.indexer || (part.properties.size === 0 && !part.class) || this.builtInMethod(part, name)) return false
                    break
                default:
                    return false
            }
            missing = true
        }
        return missing
    }

    /** `t[k]` read with a `k` that cannot be a key of `t`: an `unknown`, a
     *  type none of `t`'s keys has (a number into a record, a string into an
     *  array or a class), or a name `t` does not have — which is `t.name`'s
     *  error. An `any` on either side says nothing, and neither does a type
     *  parameter still to be decided. A plain `string` into a record is
     *  allowed: it reads as one of the values or nil, and the nil has to be
     *  dealt with. An empty `{}` is a table still being filled in, and is
     *  left alone. Reports, and answers whether it did. */
    private checkIndexKey(node: Expression, object: Type, key: Type): boolean {
        if (!this.emitDiagnostics || this.badIndexReported.has(node)) return false
        const index = this.expand(key)
        if (index.kind === "any" || index.kind === "never" || containsTypeParam(index)) return false
        const keys = index.kind === "union" ? index.types.map(k => this.expand(k)) : [index]
        const nameOf = (k: Type): string | undefined =>
            k.kind === "literal" && typeof k.value === "string" ? k.value : undefined
        const shown = briefType(withoutNil(this.expand(object)))
        const names = keys.map(nameOf)
        const others = keys.filter((_, i) => names[i] === undefined)
        let message: string | undefined
        // A list is indexed by position. A name is not one, whatever it says —
        // `xs["1"]` is not `xs[1]`, and Luau reads nothing there.
        const listOnly = (t: Type): boolean => {
            const x = this.expand(t)
            if (x.kind === "union") return x.types.every(listOnly)
            return x.kind === "array" || x.kind === "tuple"
        }
        if (names.some(name => name !== undefined) && listOnly(withoutNil(this.expand(object)))) {
            message = `Type '${briefType(index)}' cannot be used to index type '${shown}'`
        } else if (others.length && this.cannotIndex(object, others)) {
            message = `Type '${briefType(index)}' cannot be used to index type '${shown}'`
        } else if (!others.length && names.every(name => this.memberMissing(object, name!))) {
            // Names only, and not one of them is there. One that is makes the
            // read a lookup that may miss — `Paths[stat]` over some stats
            // with a path and some without — which reads as nil, not a mistake.
            message = keys.length === 1
                ? `Property '${names[0]}' does not exist on type '${shown}'`
                : `None of ${briefType(index)} is a property of type '${shown}'`
        }
        if (!message) return false
        this.badIndexReported.add(node)
        this.diagnostics.push({ node, message })
        return true
    }

    /** Can one of `keys` (string literals aside) not index some part of
     *  `object`? `false` as soon as a part cannot be judged. */
    private cannotIndex(object: Type, keys: readonly Type[]): boolean {
        const raw = this.expand(object)
        const parts = (raw.kind === "union" ? raw.types : [raw]).map(m => this.deferredAccess(this.expand(m)))
        const isNumber = (k: Type): boolean =>
            (k.kind === "primitive" && k.name === "number") || (k.kind === "literal" && typeof k.value === "number")
        const isString = (k: Type): boolean =>
            (k.kind === "primitive" && k.name === "string") || k.kind === "templateLiteral"
        let bad = false
        for (const part of parts) {
            switch (part.kind) {
                case "primitive":
                    if (part.name === "nil") continue
                    return false
                case "array":
                case "tuple":
                    if (!keys.every(isNumber)) bad = true
                    continue
                case "object": {
                    if (!part.indexer && part.properties.size === 0 && !part.class) return false
                    const fits = (k: Type): boolean =>
                        (part.indexer !== undefined && isAssignable(k, part.indexer.key))
                        || (!part.indexer && !part.class && isString(k))
                        || (k.kind === "literal" && part.properties.has(String(k.value)))
                    if (!keys.every(fits)) bad = true
                    continue
                }
                default:
                    return false
            }
        }
        return bad
    }

    /** Indexes already reported: a loop body is visited more than once. */
    private readonly badIndexReported = new WeakSet<Expression>()

    /** Members already reported as missing: a loop body, or an assignment
     *  target, is visited more than once. */
    private readonly missingMemberReported = new WeakSet<Identifier>()

    /** A `private` member read from outside the class that declared it —
     *  a subclass counts as outside, as in TypeScript. */
    private checkPrivateMember(node: Expression | Identifier, object: Type, name: string): void {
        if (!this.emitDiagnostics) return
        const raw = this.expand(object)
        for (const part of raw.kind === "union" ? raw.types : [raw]) {
            const t = this.deferredAccess(this.expand(part))
            if (t.kind !== "object") continue
            const access = t.properties.get(name)?.private
            if (!access || this.insideClass(access.owner)) continue
            if (access.protected && this.insideSubclassOf(access.owner)) continue
            this.diagnostics.push({
                node,
                message: access.protected
                    ? `Property '${name}' is protected and only accessible within class '${access.className}' and the classes extending it`
                    : `Property '${name}' is private and only accessible within class '${access.className}'`,
            })
            return
        }
    }

    /** `Shape.new` on an abstract class, and `super.area` on an abstract
     *  method: each reaches something with nothing behind it. */
    private checkAbstractAccess(expr: Extract<Expression, { type: "MemberExpression" }>, object: Type): void {
        if (!this.emitDiagnostics) return
        const t = this.expand(object)
        if (t.kind !== "object") return
        const name = expr.property.name
        const property = t.properties.get(name)
        if (!property?.abstract) return
        if (name === "new" && expr.object.type !== "SuperExpression") {
            const label = expressionLabel(expr.object) ?? formatType(t)
            this.diagnostics.push({
                node: expr,
                message: `'${label}' is an abstract class: build one of the classes extending it instead`,
            })
        } else if (expr.object.type === "SuperExpression") {
            this.diagnostics.push({
                node: expr.property,
                message: `'${name}' is abstract in the class this one extends: there is nothing to call`,
            })
        }
    }

    /** Is the code being checked written inside `owner`'s body — its own
     *  methods, or a class or function nested in them? */
    private insideClass(owner: object): boolean {
        return this.enclosingClasses.includes(owner as ClassLike)
    }

    /** Is the code being checked inside a class that extends `owner`? */
    private insideSubclassOf(owner: object): boolean {
        const identity = this.classIdentity(owner as ClassLike)
        return this.enclosingClasses.some(cls => this.instanceType(cls).class?.ancestors.includes(identity))
    }

    private propertyType(raw: Type, name: string): Type {
        const t = this.deferredAccess(this.expand(raw))
        if (t.kind === "object") {
            const p = t.properties.get(name)
            if (p) return p.optional ? optional(p.type) : p.type
            if (t.indexer) return t.indexer.value
        }
        const built = this.builtInMethod(t, name)
        if (built) return built
        if (t.kind === "union") {
            // The methods of a union of arrays (or of strings) come from the
            // union, not from each member on its own: one `some` over all the
            // elements, rather than several that cannot be called.
            const built = this.builtInMethod(t, name)
            if (built) return built
            return union(t.types.map(m => this.propertyType(m, name)))
        }
        if (t.kind === "intersection") {
            const parts = t.types.map(m => this.propertyType(m, name)).filter(p => p.kind !== "unknown")
            if (parts.length) return intersection(parts)
        }
        if (t.kind === "typeParam" && t.constraint) return this.propertyType(t.constraint, name)
        // A subtraction only removes values; the members are the base's.
        if (t.kind === "difference") return this.propertyType(t.base, name)
        if (t.kind === "any") return anyType
        // Still waiting on a type parameter: read the member from the most it
        // could become, so `skills:some(f)` knows what `f` takes even while
        // `Extract<Rows, { Page: P }>["Skills"]` is unevaluated.
        if (t.kind === "conditional" || t.kind === "indexedAccess") {
            const bound = this.deferredBound(t)
            if (bound) return this.propertyType(bound, name)
        }
        return unknownType
    }

    /** `t[k]`. A statically known string key resolves against the declared
     *  properties first — the indexer is only the fallback, so
     *  `{ [string]: number, tag: string }["tag"]` is `string`, not `number`. */
    private indexedType(raw: Type, idx: Type): Type {
        const t = this.expand(raw)
        if (t.kind === "any") return anyType
        if (t.kind === "union") return union(t.types.map(m => this.indexedType(m, idx)))
        // A key that is one of several: read each, and the answer is any of
        // them — `map[stat]` over `"Health" | "Attack"` gives both values.
        const index = this.expand(idx)
        if (index.kind === "union") return union(index.types.map(m => this.indexedType(t, m)))
        if (t.kind === "difference") return this.indexedType(t.base, index)
        if (t.kind === "typeParam" && t.constraint) return this.indexedType(t.constraint, index)
        if (t.kind === "array") return t.element
        if (t.kind === "tuple") {
            if (index.kind === "literal" && typeof index.value === "number") {
                return t.elements[index.value - 1] ?? nilType
            }
            return union(t.elements)
        }
        if (t.kind === "object") {
            if (index.kind === "literal" && typeof index.value === "string") {
                const property = t.properties.get(index.value)
                if (property) return property.optional ? optional(property.type) : property.type
                if (t.indexer && isAssignable(index, t.indexer.key)) return t.indexer.value
                // A key the table does not have reads as nil, as in Lua.
                return nilType
            }
            // `map[name]` where `name: K`: which property this reads depends on
            // the call, so the type waits — `RemoteMapType[K]` — and is worked
            // out when `K` is (see `callReturn`).
            if (containsTypeParam(index)) return this.reduceType({ kind: "indexedAccess", objectType: t, indexType: index })
            if (t.indexer) return t.indexer.value
            // A record read with any string: one of its values, or nil for a
            // key it does not have — so `if (not Codes[flag]) return` leaves
            // `Codes[flag]` as the values themselves. A class is not a table
            // to look names up in, and an empty `{}` is still being filled.
            const anyString = (index.kind === "primitive" && index.name === "string") || index.kind === "templateLiteral"
            if (anyString && !t.class && t.properties.size > 0) {
                return union([...[...t.properties.values()].map(p => p.type), nilType])
            }
        }
        // An `any` key could have been any of them.
        return index.kind === "any" ? anyType : unknownType
    }

    /** What a deferred `T[K]` can be: every property its index could name.
     *  Reading a member of one, or calling it, sees that. */
    private deferredAccess(t: Type): Type {
        if (t.kind !== "indexedAccess") return t
        const index = t.indexType.kind === "typeParam" && t.indexType.constraint
            ? t.indexType.constraint
            : t.indexType
        if (containsTypeParam(index)) return unknownType
        return this.accessType(t.objectType, index)
    }

    /** `[a, ...rest]`: what `rest` holds — an array of whatever comes after
     *  the first `from` places. */
    private restAfter(raw: Type, from: number): Type {
        const t = this.expand(raw)
        if (t.kind === "tuple") {
            const left = [...t.elements.slice(from), ...(t.rest ? [t.rest] : [])]
            return arrayOf(left.length ? union(left) : neverType)
        }
        if (t.kind === "union") return union(t.types.map(m => this.restAfter(m, from)))
        return arrayOf(this.elementType(t, from))
    }

    private elementType(raw: Type, index: number): Type {
        const t = this.expand(raw)
        if (t.kind === "array") return t.element
        if (t.kind === "tuple") return t.elements[index] ?? t.rest ?? unknownType
        if (t.kind === "union") return union(t.types.map(m => this.elementType(m, index)))
        if (t.kind === "difference") return this.elementType(t.base, index)
        if (t.kind === "typeParam" && t.constraint) return this.elementType(t.constraint, index)
        if (t.kind === "any") return anyType
        return unknownType
    }

    // --------------------------------------------------------
    // Expression inference
    // --------------------------------------------------------

    private infer(expr: Expression, env: FlowEnv): Type {
        const t = this.inferInner(expr, env)
        this.typeOf.set(expr, t)
        return t
    }

    private inferInner(expr: Expression, env: FlowEnv): Type {
        switch (expr.type) {
            case "NilLiteral": return nilType
            case "BooleanLiteral": return literal(expr.value)
            case "NumberLiteral": return literal(expr.value)
            case "StringLiteral": return literal(expr.value)
            case "InterpolatedStringExpression": {
                for (const part of expr.parts) if (part.kind === "expression") this.infer(part.expression, env)
                return stringType
            }
            // `...` holds what the function declared it takes.

            // `f(a, ...rest)` — every value the array holds, one after
            // another. Each of them is an element, so that is what the
            // parameters it fills are checked against.
            case "SpreadElement": {
                const spread = this.infer(expr.argument, env)
                const element = this.spreadElement(spread)
                if (element === undefined && this.emitDiagnostics) {
                    this.diagnostics.push({
                        node: expr,
                        message: `Only an array can be spread, and '${formatType(spread)}' is not one`,
                    })
                }
                // Already reported: `any` so the parameters it was meant to
                // fill are not each reported as well.
                return element ?? anyType
            }
            // Broken syntax is reported by the parser; nothing more to say.
            case "ErrorExpression": return anyType

            case "Identifier": {
                const id = this.bindingIdOf(expr)
                if (id === undefined) return anyType
                const t = this.currentType(id, env)
                this.narrowedTypeOf.set(expr, t)
                return t
            }

            case "ArrayExpression": return this.inferArray(expr, env, false)
            case "TableExpression": return this.inferObject(expr, env, false)

            case "FunctionExpression": {
                this.checkParamOrder(expr.func.params, expr)
                const returned: Type[] = []
                this.visitFunctionBody(expr.func, env, returned)
                return this.inferFunctionBody(expr.func, env, returned)
            }

            case "ParenthesizedExpression":
                return this.infer(expr.expression, env)

            case "TypeAssertionExpression": {
                this.infer(expr.expression, env)
                return this.resolveType(expr.typeAnnotation)
            }

            case "SatisfiesExpression": {
                // Validate against the contract but keep the value's own type —
                // that is the whole point of `satisfies` over `as` or an
                // annotation. As in TypeScript, the contract still shapes that
                // type: callbacks take their parameters from it, and a literal
                // stays a literal where the contract asks for literals
                // (`{ kind: "circle" } satisfies Shape` keeps `kind: "circle"`).
                const declared = this.resolveType(expr.typeAnnotation)
                this.applyContext(expr.expression, declared)
                if (declared.kind === "any") return this.infer(expr.expression, env)
                // Only a literal written right here takes its literals from the
                // contract. Anything with a type of its own — `x as const`, a
                // variable, a call — keeps exactly that type: `as const
                // satisfies T` stays readonly and literal.
                const written = unwrapParens(expr.expression)
                const fresh = written.type === "TableExpression" || written.type === "ArrayExpression"
                const narrow = fresh ? this.inferAsConst(expr.expression, env) : this.infer(expr.expression, env)
                // A bare literal is left for the declaration to widen or not
                // (`const n = 5 satisfies number` is `5`, a `let` is `number`).
                const actual = fresh ? this.keepContextualLiterals(narrow, declared) : narrow
                this.typeOf.set(expr.expression, actual)
                if (!this.emitDiagnostics) return actual
                if (!isAssignable(narrow, declared) && !isAssignable(actual, declared)) {
                    this.diagnostics.push({
                        node: expr,
                        message: `Type '${briefType(actual)}' does not satisfy the expected type '${briefType(declared)}'`
                            + this.explainMismatch(actual, declared),
                    })
                } else {
                    this.reportExcessProperties(expr.expression, declared)
                }
                return actual
            }

            case "AsConstExpression":
                return this.inferAsConst(expr.expression, env)

            case "UnaryExpression": {
                const arg = this.infer(expr.argument, env)
                switch (expr.operator) {
                    case "not": return booleanType
                    case "-": {
                        const answered = this.operatorResult(expr, "-", arg, undefined)
                        if (answered) return answered
                        this.checkOperands(expr, "-", arg)
                        return this.arithmeticOn([arg])
                    }
                    case "#": {
                        const answered = this.operatorResult(expr, "#", arg, undefined)
                        if (answered) return answered
                        this.checkOperands(expr, "#", arg)
                        return numberType
                    }
                }
                return arg
            }

            case "BinaryExpression": {
                const op = expr.operator
                if (op === "and") {
                    this.infer(expr.left, env)
                    const { whenTrue } = this.narrowFromCondition(expr.left, env)
                    const right = this.infer(expr.right, whenTrue)
                    return union([narrowFalsy(this.typeOf.get(expr.left) ?? anyType), right])
                }
                if (op === "or") {
                    const left = this.infer(expr.left, env)
                    const { whenFalse } = this.narrowFromCondition(expr.left, env)
                    const right = this.infer(expr.right, whenFalse)
                    // `headers or {}`: an empty table that already is what the
                    // left side holds — a map, a list — adds nothing to it.
                    // Kept as `{}`, it would say "keys unknown" to every loop.
                    const fallback = unwrapParens(expr.right)
                    const empty = (fallback.type === "TableExpression" && fallback.fields.length === 0)
                        || (fallback.type === "ArrayExpression" && fallback.elements.length === 0)
                    const truthy = narrowTruthy(left)
                    if (empty && truthy.kind !== "never" && truthy.kind !== "any" && isAssignable(right, truthy)) return truthy
                    return union([truthy, right])
                }
                const l = this.infer(expr.left, env)
                const r = this.infer(expr.right, env)
                if (op === "==" || op === "~=") {
                    // `name == "..."`: the string is expected to be one of the
                    // values `name` can hold — what an editor offers there.
                    if (unwrapParens(expr.right).type === "StringLiteral") this.expectedTypeOf.set(unwrapParens(expr.right), l)
                    if (unwrapParens(expr.left).type === "StringLiteral") this.expectedTypeOf.set(unwrapParens(expr.left), r)
                }
                switch (op) {
                    case "..": {
                        const answered = this.operatorResult(expr, op, l, r)
                        if (answered) return answered
                        this.checkOperands(expr, op, l, r)
                        return stringType
                    }
                    case "<": case ">": case "<=": case ">=":
                        if (!this.checkComparison(expr, op, l, r)) this.checkOperands(expr, op, l, r)
                        return booleanType
                    case "==": case "~=":
                        this.checkOverlap(expr, op, l, r)
                        return booleanType
                    case "+": case "-": case "*": case "/": case "//": case "%": case "^": {
                        const answered = this.operatorResult(expr, op, l, r)
                        if (answered) return answered
                        this.checkOperands(expr, op, l, r)
                        return this.arithmeticOn([l, r])
                    }
                }
                return union([l, r])
            }

            case "MemberExpression": {
                const { type: obj, shortCircuits } = this.chainObject(expr, expr.object, env)
                this.checkPrivateMember(expr.property, obj, expr.property.name)
                this.checkAbstractAccess(expr, obj)
                const key = this.refKeyOf(expr)
                const narrowed = key === undefined ? undefined : env.get(key)
                this.checkStringMember(expr, obj, literal(expr.property.name))
                if (narrowed === undefined) this.checkMissingMember(expr.property, obj, expr.property.name)
                return this.chainResult(expr, narrowed ?? this.propertyType(obj, expr.property.name), shortCircuits)
            }

            case "IndexExpression": {
                const { type: obj, shortCircuits } = this.chainObject(expr, expr.object, env)
                const idx = this.infer(expr.index, env)
                const key = this.refKeyOf(expr)
                const narrowed = key === undefined ? undefined : env.get(key)
                this.checkStringMember(expr, obj, this.expand(idx))
                // An index that may not be a key is an error, and then reads
                // as `any`: the mistake is reported once, where it is made.
                if (this.checkIndexKey(expr, obj, idx)) return this.chainResult(expr, anyType, shortCircuits)
                const member = this.stringMember(obj, this.expand(idx))
                if (member) return this.chainResult(expr, member, shortCircuits)
                return this.chainResult(expr, narrowed ?? this.indexedType(obj, idx), shortCircuits)
            }

            case "CallExpression": {
                // `super(...)` runs the base class's constructor on this
                // instance: it takes the base's parameters and returns nothing.
                if (expr.callee.type === "SuperExpression") return this.inferSuperCall(expr, env)
                const { type: callee, shortCircuits } = this.chainObject(expr, expr.callee, env)
                return this.chainResult(expr, this.inferCall(expr, callee, env), shortCircuits)
            }

            case "ClassExpression":
                return this.visitClass(expr, env)

            case "SuperExpression": {
                const stmt = this.currentClass
                if (!stmt?.superclass) {
                    if (this.emitDiagnostics) {
                        this.diagnostics.push({
                            node: expr,
                            message: "'super' is only available inside a class that extends another",
                        })
                    }
                    return anyType
                }
                return this.superType(stmt)
            }

            case "MethodCallExpression": {
                const { type: objType, shortCircuits } = this.chainObject(expr, expr.object, env)
                return this.chainResult(expr, this.inferMethodCall(expr, objType, env), shortCircuits)
            }

            case "IfElseExpression": {
                const branches: Type[] = []
                let elseEnv = env
                for (const c of expr.clauses) {
                    this.infer(c.condition, elseEnv)
                    const { whenTrue, whenFalse } = this.narrowFromCondition(c.condition, elseEnv)
                    branches.push(this.infer(c.body, whenTrue))
                    elseEnv = whenFalse
                }
                branches.push(this.infer(expr.alternate, elseEnv))
                return union(branches)
            }
        }
    }

    /** `new Name(args)` is `Name.new(args)` — the same function, and the
     *  same check. Saying so here rather than rewriting the tree keeps the
     *  error messages pointing at what was written. */
    /** `__call` of a value with one, as what calling the value calls. */
    private callMetamethod(raw: Type): Type | undefined {
        const t = this.expand(raw)
        if (t.kind !== "object" || this.overloadsOf(t).length) return undefined
        const method = t.properties.get("__call")
        if (!method) return undefined
        const bound = this.overloadsOf(method.type).map(f =>
            this.takesSelf(f) ? fn(f.params.slice(1), f.returns, f.varargs, f.typeParams) : f)
        return bound.length ? intersection(bound) : undefined
    }

    /** `super(...)` — the base constructor, run on the instance being built. */
    private inferSuperCall(expr: Extract<Expression, { type: "CallExpression" }>, env: FlowEnv): Type {
        const stmt = this.currentClass
        const constructor = stmt ? this.baseConstructorType(stmt) : undefined
        if (!stmt?.superclass) {
            if (this.emitDiagnostics) {
                this.diagnostics.push({
                    node: expr,
                    message: "'super(...)' is only available inside the constructor of a class that extends another",
                })
            }
            for (const argument of expr.arguments) this.infer(argument, env)
            return nilType
        }
        if (!constructor) {
            for (const argument of expr.arguments) this.infer(argument, env)
            return nilType
        }
        const callable = fn(constructor.params.filter(p => p.name !== "this"), nilType, constructor.varargs)
        this.inferCall(expr, callable, env)
        return nilType
    }

    private inferCall(expr: Extract<Expression, { type: "CallExpression" }>, called: Type, env: FlowEnv): Type {
        this.checkAmbiguousCall(expr)
        // An instance whose class writes `__call` is called through it, with
        // itself in the `this` slot.
        const callee = this.callMetamethod(called) ?? called
        const united = this.unionSignatures(callee)
        const fns = united ?? this.overloadsOf(callee)
        const explicit = this.explicitTypeArguments(expr, fns)
        const argTypes = this.inferArguments(expr.arguments, fns, () => 0, (_, args) => args, env)
        if (fns.length) {
            this.recordExpected(expr.arguments, fns, () => 0, () => argTypes)
            const spread = this.spreadOf(expr.arguments)
            const arityFits = this.checkArity(expr, fns, argTypes.length, 0, spread)
            const picked = this.pickOverload(fns, argTypes, undefined, spread)
            if (!united) {
                const distributed = this.distributedReturn(fns, argTypes, picked, (_, args) => args)
                if (distributed) return distributed
                if (picked) {
                    this.checkInferredArguments(expr, expr.arguments, picked, argTypes, 0)
                    return this.callReturn(picked, this.constArgs(picked, expr.arguments, argTypes, env), explicit)
                }
            }
            if (arityFits && !picked) this.reportArguments(expr, expr.arguments, fns, () => argTypes, () => 0)
            // Nothing accepts these arguments — the union of what any
            // signature could return is the most we can honestly say.
            return union(fns.map(f => this.callReturn(f, argTypes, explicit)))
        }
        this.checkCallable(expr.callee, callee)
        return callee.kind === "any" ? anyType : unknownType
    }

    /** `a()` where `a` is `1`: a value whose type is known and has no call
     *  signature. A union is reported when any member cannot be called, but
     *  only when every member is decided — `unknown`, `any` and anything still
     *  generic say too little. */
    private checkCallable(node: Expression | Identifier, callee: Type): void {
        if (!this.emitDiagnostics || this.notCallableReported.has(node)) return
        const raw = this.expand(callee)
        const parts = (raw.kind === "union" ? raw.types : [raw]).map(m => this.expand(m))
        const notCallable = (m: Type): boolean =>
            (m.kind === "primitive" && m.name !== "nil") ||
            m.kind === "literal" || m.kind === "templateLiteral" ||
            m.kind === "array" || m.kind === "tuple" || m.kind === "object"
        const callable = (m: Type): boolean => this.overloadsOf(m).length > 0
        const concrete = parts.filter(m => !(m.kind === "primitive" && m.name === "nil"))
        if (!concrete.some(notCallable) || !concrete.every(m => notCallable(m) || callable(m))) return
        this.notCallableReported.add(node)
        const label = node.type === "Identifier" ? node.name : expressionLabel(node)
        this.diagnostics.push({
            node,
            message: `This expression is not callable: ${label === undefined ? "" : `'${label}' `}`
                + `is of type '${briefType(withoutNil(raw))}'`,
        })
    }

    /** Callees already reported as not callable: a loop body is visited more
     *  than once. */
    private readonly notCallableReported = new WeakSet<Expression | Identifier>()

    /** A `(` on a line of its own continues the statement above it:
     *
     *      const value = map[key]
     *      ("text"):upper()
     *
     *  calls `map[key]`, in tilua as in Lua and in JavaScript. It is almost
     *  never what was meant, and what it does instead is invisible — so say
     *  so, and name the fix. */
    private checkAmbiguousCall(expr: Extract<Expression, { type: "CallExpression" }>): void {
        if (!this.emitDiagnostics || !expr.argumentsOnNewLine) return
        this.diagnostics.push({
            node: expr,
            message: "This calls the value the line above ends with — a line break does not end a statement. "
                + "Write ';' before '(' if a new statement was meant.",
        })
    }

    private inferMethodCall(expr: Extract<Expression, { type: "MethodCallExpression" }>, objType: Type, env: FlowEnv): Type {
        this.checkPrivateMember(expr.method, objType, expr.method.name)
        this.checkStringMember(expr.method, objType, literal(expr.method.name))
        this.checkMissingMember(expr.method, objType, expr.method.name)
        const method = this.propertyType(objType, expr.method.name)
        const united = this.unionSignatures(method)
        const fns = united ?? this.overloadsOf(method)
        const explicit = this.explicitTypeArguments(expr, fns)
        const argTypes = this.inferArguments(expr.arguments, fns, f => (this.takesSelf(f) ? 1 : 0),
            (f, args) => (this.takesSelf(f) ? [objType, ...args] : args), env)
        if (fns.length) {
            // `obj:m(a)` passes `obj` as the implicit first argument, but
            // only to a signature that actually declares a `self` slot —
            // a plain `{ f: (n: number) -> ... }` stored in a table and
            // called with `:` must not have its arguments shifted.
            const withSelf = (f: FunctionType): Type[] =>
                this.takesSelf(f) ? [objType, ...argTypes] : argTypes
            const selfOf = (f: FunctionType): number => (this.takesSelf(f) ? 1 : 0)
            this.recordExpected(expr.arguments, fns, selfOf, withSelf)
            // The receiver fills the `self` slot, so it does not count
            // against what the caller wrote.
            const self0 = this.takesSelf(fns[0]) ? 1 : 0
            const spread = this.spreadOf(expr.arguments, self0)
            const arityFits = this.checkArity(expr, fns, argTypes.length, self0, spread)
            const picked = this.pickOverload(fns, argTypes, withSelf, spread)
            if (!united) {
                const distributed = this.distributedReturn(fns, argTypes, picked,
                    (f, args) => (this.takesSelf(f) ? [objType, ...args] : args))
                if (distributed) return distributed
                if (picked) {
                    const self = this.takesSelf(picked) ? 1 : 0
                    this.checkInferredArguments(expr, expr.arguments, picked, withSelf(picked), self)
                    const written = this.constArgs(picked, expr.arguments, argTypes, env, self)
                    return this.callReturn(picked, this.takesSelf(picked) ? [objType, ...written] : written, explicit)
                }
            }
            if (arityFits && !picked) this.reportArguments(expr, expr.arguments, fns, withSelf, selfOf)
            return union(fns.map(f => this.callReturn(f, withSelf(f), explicit)))
        }
        this.checkCallable(expr.method, method)
        return objType.kind === "any" ? anyType : unknownType
    }

    // --------------------------------------------------------
    // Optional chains
    // --------------------------------------------------------
    //
    // `a?.b.c`: when `a` is nil the whole chain is nil and `.c` never runs.
    // So a link reads its object without the `nil` a `?.` earlier in the chain
    // added — that nil has already left the chain — and the chain's outermost
    // link carries it again. Parentheses end a chain: `(a?.b).c` reads `.c`
    // from `B | nil`.

    /** The type of a link's non-nil object, for each link that is past a `?.`:
     *  what the chain holds when it has not short-circuited. */
    private readonly chainValue = new WeakMap<Expression, Type>()

    /** The object a link reads from, and whether the chain can short-circuit
     *  by this link. */
    private chainObject(
        link: Expression & { optional?: boolean },
        object: Expression,
        env: FlowEnv,
    ): { type: Type; shortCircuits: boolean } {
        const full = this.infer(object, env)
        const inChain = this.chainValue.get(object)
        let type = inChain ?? full
        if (link.optional) {
            type = withoutNil(type)
        } else if (this.includesNil(type)) {
            // `a.b` on an `A | nil`: the read fails when `a` is nil. Say so, and
            // read on from `A` — the error is the nil, not the rest.
            this.reportNilAccess(object, type)
            type = withoutNil(this.expand(type))
        }
        const read = this.expand(type)
        if (read.kind === "unknown" && read.declared) this.reportUnknownAccess(object)
        // A `?.` on an object that cannot be nil never short-circuits: on a
        // `BoolValue`, `v?.Value` is `boolean`, not `boolean | nil`.
        const optionalNil = link.optional === true && this.mayBeNil(inChain ?? full)
        return { type, shortCircuits: inChain !== undefined || optionalNil }
    }

    /** Whether a value of `raw` can be nil — `includesNil`, and also the types
     *  that do not say: `any`, `unknown`, an unconstrained type parameter. */
    private mayBeNil(raw: Type): boolean {
        const t = this.expand(raw)
        switch (t.kind) {
            case "primitive": return t.name === "nil"
            case "any": case "unknown": return true
            case "typeParam": return t.constraint === undefined || this.mayBeNil(t.constraint)
            case "union": return t.types.some(m => this.mayBeNil(m))
            case "never": case "literal": case "array": case "tuple": case "object":
            case "function": case "intersection": case "templateLiteral":
                return false
            default: return true
        }
    }

    /** Objects already reported as possibly nil: a loop body is visited more
     *  than once. */
    private readonly nilAccessReported = new WeakSet<Expression>()

    private includesNil(raw: Type): boolean {
        const t = this.expand(raw)
        if (t.kind === "primitive") return t.name === "nil"
        return t.kind === "union" && t.types.some(m => m.kind === "primitive" && m.name === "nil")
    }

    /** `readonly` is a promise about the property rather than the value it
     *  holds: assigning *through* it is the one thing it rules out. */
    private checkReadonlyAssign(target: Expression, env: FlowEnv): void {
        if (!this.emitDiagnostics) return
        let name: string
        let object: Expression
        if (target.type === "MemberExpression") {
            name = target.property.name
            object = target.object
        } else if (target.type === "IndexExpression") {
            const list = this.expand(this.infer(target.object, env))
            // `readonly T[]` is a promise about the list itself: no place in
            // it is written to, whichever one is named.
            if ((list.kind === "array" || list.kind === "tuple") && list.readonly) {
                this.diagnostics.push({
                    node: target,
                    message: `Cannot assign to an element of '${formatType(list)}': it is read-only`,
                })
                return
            }
            const index = this.expand(this.infer(target.index, env))
            // A computed key names no one property unless it is a known string.
            if (index.kind !== "literal" || typeof index.value !== "string") return
            name = index.value
            object = target.object
        } else {
            return
        }
        // A write through `import * as M` is already reported, in the words of
        // the module it really is about.
        if (object.type === "Identifier") {
            const id = this.bindingIdOf(object)
            if (id !== undefined && this.scopes.bindings.get(id)?.declaredBy === "namespace") return
        }
        if (!this.isReadonlyProperty(this.expand(this.infer(object, env)), name)) return
        // `this.id = id` in the constructor of the class that declares `id`.
        const constructing = this.constructing
        if (constructing && object.type === "Identifier" && object.name === "this" && constructing.members.some(m =>
            m.type === "ClassField" && !m.isStatic && m.isReadonly && m.name.name === name)) return
        this.diagnostics.push({
            node: target,
            message: `Cannot assign to '${name}' because it is a read-only property`,
        })
    }

    private isReadonlyProperty(t: Type, name: string): boolean {
        if (t.kind === "object") return t.properties.get(name)?.readonly === true
        // Read-only in any member is read-only through the whole: an
        // intersection has to keep every part's promise, and a union is only
        // safely written through when each member allows it.
        if (t.kind === "intersection" || t.kind === "union") {
            return t.types.some(m => this.isReadonlyProperty(this.expand(m), name))
        }
        return false
    }

    private readonly unknownAccessReported = new WeakSet<Expression>()

    /** `unknown` is the type that promises nothing: unlike `any`, a member of
     *  it has to be narrowed out first. */
    private reportUnknownAccess(object: Expression): void {
        if (!this.emitDiagnostics || this.unknownAccessReported.has(object)) return
        this.unknownAccessReported.add(object)
        const label = expressionLabel(object)
        this.diagnostics.push({
            node: object,
            message: `${label === undefined ? "Object" : `'${label}'`} is of type 'unknown'`,
        })
    }

    private reportNilAccess(object: Expression, type: Type): void {
        if (!this.emitDiagnostics || this.nilAccessReported.has(object)) return
        this.nilAccessReported.add(object)
        const label = expressionLabel(object)
        const t = this.expand(type)
        const nilOnly = t.kind === "primitive" && t.name === "nil"
        const subject = label === undefined ? "Object" : `'${label}'`
        this.diagnostics.push({
            node: object,
            message: nilOnly
                ? `${subject} is nil`
                : `${subject} is possibly nil. Check it first, or use '?.' / '?:'`,
        })
    }

    private chainResult(link: Expression, value: Type, shortCircuits: boolean): Type {
        if (!shortCircuits) return value
        this.chainValue.set(link, value)
        return union([value, nilType])
    }

    /** The chain around `cond` did not short-circuit — it produced a truthy
     *  value, or any value but nil — so every object a `?.` in it tested is not
     *  nil in `env`. */
    private narrowOptionalLinks(cond: Expression, env: FlowEnv, into: FlowEnv): void {
        for (let e: Expression = cond; ;) {
            const link = e as Expression & { optional?: boolean; object?: Expression; callee?: Expression }
            const object = e.type === "CallExpression" ? e.callee
                : e.type === "MemberExpression" || e.type === "IndexExpression" || e.type === "MethodCallExpression" ? e.object
                : undefined
            if (!object) return
            if (link.optional) {
                const key = this.refKeyOf(object)
                if (key !== undefined) this.setRef(into, key, withoutNil(this.typeAtRef(object, into)))
            }
            e = object
        }
    }

    private inferArray(expr: ArrayExpression, env: FlowEnv, asConst: boolean): Type {
        const contextual = this.contextualArrays.get(expr)
        if (contextual && !asConst) return contextual
        const wantedTuple = this.tupleArrays.get(expr)
        if (wantedTuple && !asConst) return this.inferTupleLiteral(expr, env, wantedTuple)
        const elems: Type[] = []
        let hadSpread = false
        for (const el of expr.elements) {
            if (el.type === "SpreadElement") {
                hadSpread = true
                const s = this.infer(el.argument, env)
                if (s.kind === "array") elems.push(s.element)
                else if (s.kind === "tuple") elems.push(...s.elements)
                else elems.push(unknownType)
            } else {
                elems.push(asConst ? this.inferAsConst(el, env) : this.infer(el, env))
            }
        }
        if (asConst && !hadSpread) return tuple(elems)
        return arrayOf(elems.length
            ? union(elems.map((t, i) => {
                const element = expr.elements[i]
                return asConst || !element || element.type === "SpreadElement"
                    ? t
                    : this.widenUnlessAsked(t, element)
            }))
            : unknownType)
    }

    /** `[a, b, ...more]` where a tuple is wanted: the places it names are the
     *  tuple's, and what comes after them — more elements, or a spread — is
     *  its rest. */
    private inferTupleLiteral(expr: ArrayExpression, env: FlowEnv, wanted: Extract<Type, { kind: "tuple" }>): Type {
        const fixed: Type[] = []
        const tail: Type[] = []
        let spread = false
        expr.elements.forEach((element, i) => {
            if (element.type === "SpreadElement") {
                spread = true
                const held = this.expand(this.infer(element.argument, env))
                if (held.kind === "array") tail.push(held.element)
                else if (held.kind === "tuple") tail.push(...tupleMembers(held))
                else tail.push(unknownType)
                return
            }
            const t = this.widenUnlessAsked(this.infer(element, env), element)
            if (!spread && i < wanted.elements.length) fixed.push(t)
            else tail.push(t)
        })
        return tuple(fixed, tail.length ? union(tail) : undefined)
    }

    /** A literal written inside a fresh table or array widens — `{ n = 1 }` is
     *  `{ n: number }` — unless the surroundings said a literal belongs there.
     *  `request({ Method: "GET" })` keeps `"GET"` when `Method` is a union of
     *  string literals, exactly as TypeScript's contextual typing does, and
     *  goes on widening to `string` when the parameter only says `string`.
     *  The context was recorded by `applyContext` before the value was
     *  inferred, so this is a lookup rather than a second pass. */
    private widenUnlessAsked(value: Type, at: Expression): Type {
        const wanted = this.expectedTypeOf.get(at)
        // Each arm of the contract is asked on its own, before any of them are
        // merged. `{ Status?: true } | { Status?: false }` wants a literal of
        // `Status` in either arm, but the two merge to `boolean` — the one
        // type that cannot say it wanted a literal. Asking first is what
        // TypeScript does, and what keeps a discriminant a discriminant.
        if (value.kind === "literal") {
            const arms = this.contextArms.get(at)
            if (arms?.some(arm => this.admitsLiteral(arm, value.base))) return value
        }
        return wanted === undefined ? widen(value) : this.keepContextualLiterals(value, wanted)
    }

    /** What each arm of the contract wanted of an expression, unmerged — see
     *  `widenUnlessAsked`. Recorded by `applyTableContext` beside the merged
     *  type it hands to `applyContext`. */
    private readonly contextArms = new WeakMap<object, Type[]>()

    private inferObject(expr: TableExpression, env: FlowEnv, asConst: boolean): Type {
        const entries: [string, ObjectProperty][] = []
        let indexer: { key: Type; value: Type } | undefined
        // A contextual shape that contains T is a generic inference site.
        // Infer it narrowly first; `keepContextualLiterals` strips readonly
        // where this ordinary object literal would not have had it.
        const context = this.expectedTypeOf.get(expr)
        const genericContext = !asConst && context !== undefined && containsTypeParam(context)
        for (const field of expr.fields) {
            if (field.type === "TableFieldNamed") {
                const key = field.key.type === "Identifier" ? field.key.name : field.key.value
                const inferred = (asConst || genericContext)
                    ? this.inferAsConst(field.value, env)
                    : this.infer(field.value, env)
                const v = asConst ? inferred
                    : genericContext ? this.keepContextualLiterals(inferred, context)
                    : this.widenUnlessAsked(inferred, field.value)
                entries.push([key, { type: v, optional: false, readonly: asConst }])
            } else if (field.type === "TableFieldShorthand") {
                const inferred = (asConst || genericContext)
                    ? this.inferAsConst(field.name, env)
                    : this.infer(field.name, env)
                entries.push([field.name.name, {
                    type: asConst ? inferred
                        : genericContext ? this.keepContextualLiterals(inferred, context)
                        : this.widenUnlessAsked(inferred, field.name),
                    optional: false, readonly: asConst,
                }])
            } else if (field.type === "TableFieldComputed") {
                const k = this.infer(field.key, env)
                const v = (asConst || genericContext)
                    ? this.inferAsConst(field.value, env)
                    : this.infer(field.value, env)
                if (k.kind === "literal" && typeof k.value === "string") {
                    entries.push([k.value, {
                        type: asConst ? v
                            : genericContext ? this.keepContextualLiterals(v, context)
                            : this.widenUnlessAsked(v, field.value),
                        optional: false, readonly: asConst,
                    }])
                } else {
                    indexer = mergeIndexer(indexer, { key: widen(k), value: asConst ? v : widen(v) })
                }
            } else {
                // spread
                const s = this.infer(field.argument, env)
                if (s.kind === "object") {
                    for (const [k, p] of s.properties) entries.push([k, p])
                    if (s.indexer) indexer = mergeIndexer(indexer, s.indexer)
                }
            }
            this.checkDuplicateKey(expr, field, entries)
        }
        return objectType(entries, indexer, asConst || undefined)
    }

    /** `{ a: 1, a: 2 }` — the second wins and the first was written for
     *  nothing, which is a typo far more often than a decision. A spread is
     *  not one: overriding what it brought is exactly what it is for. */
    private checkDuplicateKey(
        expr: TableExpression,
        field: TableExpression["fields"][number],
        entries: readonly [string, ObjectProperty][],
    ): void {
        if (!this.emitDiagnostics || this.duplicateKeyReported.has(field)) return
        const written = field.type === "TableFieldNamed"
            ? (field.key.type === "Identifier" ? field.key.name : field.key.value)
            : field.type === "TableFieldShorthand" ? field.name.name
            : undefined
        if (written === undefined) return
        // Anything a spread brought in is fair game to write over.
        const spreadBefore = expr.fields.slice(0, expr.fields.indexOf(field)).some(f => f.type === "TableFieldSpread")
        if (spreadBefore) return
        if (entries.filter(([k]) => k === written).length < 2) return
        this.duplicateKeyReported.add(field)
        this.diagnostics.push({
            node: field.type === "TableFieldNamed" ? field.key : (field as { name: Identifier }).name,
            message: `'${written}' is given twice in this table; only the last one is kept`,
        })
    }

    private readonly duplicateKeyReported = new WeakSet<object>()

    /** A value inferred `as const`, widened back wherever `context` does not
     *  ask for a literal: `satisfies`' result type. A property keeps `"circle"`
     *  when the contract's property admits string literals, and becomes
     *  `string` when it is only `string`; a tuple becomes an array unless the
     *  contract is a tuple; nothing stays readonly. */
    private keepContextualLiterals(value: Type, context: Type | undefined): Type {
        const ctx = context === undefined ? undefined : this.expand(context)
        switch (value.kind) {
            case "literal":
                return ctx && (containsTypeParam(ctx) || this.admitsLiteral(ctx, value.base)) ? value : widen(value)
            case "object": {
                if (value.class) return value
                const generic = ctx !== undefined && containsTypeParam(ctx)
                const entries: [string, ObjectProperty][] = [...value.properties].map(([name, property]) => [
                    name,
                    { ...property, readonly: false, type: this.keepContextualLiterals(property.type, generic ? ctx : ctx && this.contextProperty(ctx, name)) },
                ])
                const indexer = value.indexer && {
                    key: widen(value.indexer.key),
                    value: this.keepContextualLiterals(value.indexer.value, ctx && this.contextIndexValue(ctx)),
                }
                return objectType(entries, indexer)
            }
            case "tuple": {
                const tupleContext = ctx && this.membersOf(ctx).find(m => m.kind === "tuple")
                if (tupleContext?.kind === "tuple") {
                    return tuple(value.elements.map((e, i) => this.keepContextualLiterals(e, tupleContext.elements[i])), value.rest)
                }
                const arrayContext = ctx && this.membersOf(ctx).find(m => m.kind === "array")
                const element = arrayContext?.kind === "array" ? arrayContext.element : undefined
                if (!value.elements.length) return arrayContext ?? arrayOf(unknownType)
                return arrayOf(union(value.elements.map(e => this.keepContextualLiterals(e, element))))
            }
            case "array": {
                const arrayContext = ctx && this.membersOf(ctx).find(m => m.kind === "array")
                return arrayOf(this.keepContextualLiterals(value.element, arrayContext?.kind === "array" ? arrayContext.element : undefined))
            }
            case "union":
                return union(value.types.map(t => this.keepContextualLiterals(t, context)))
            default:
                return value
        }
    }

    private membersOf(t: Type): Type[] {
        const x = this.expand(t)
        return x.kind === "union" ? x.types.map(m => this.expand(m)) : [x]
    }

    /** Does a contract accept literals of `base` as such? */
    private admitsLiteral(ctx: Type, base: string): boolean {
        return this.membersOf(ctx).some(m =>
            (m.kind === "literal" && m.base === base) || (m.kind === "templateLiteral" && base === "string"))
    }

    /** What a contract expects of property `name`, over every object it allows. */
    private contextProperty(ctx: Type, name: string): Type | undefined {
        const found: Type[] = []
        for (const m of this.membersOf(ctx)) {
            if (m.kind !== "object") continue
            const property = m.properties.get(name)
            if (property) found.push(property.type)
            else if (m.indexer) found.push(m.indexer.value)
        }
        return found.length ? union(found) : undefined
    }

    private contextIndexValue(ctx: Type): Type | undefined {
        const found = this.membersOf(ctx).flatMap(m => (m.kind === "object" && m.indexer ? [m.indexer.value] : []))
        return found.length ? union(found) : undefined
    }

    /** Fields reported by `reportExcessProperties`, once each: a loop body is
     *  visited more than once. */
    private readonly excessReported = new WeakSet<object>()

    /** TypeScript's excess property check. An object literal written straight
     *  into a typed place — an annotation, `satisfies` — may only name
     *  properties that place knows: anything else is almost always a typo.
     *  A nested literal is checked against the property it is written for.
     *  A target with an indexer, a class, or a member whose shape is not known
     *  accepts anything. */
    /** The keys an index signature covers, when it covers a countable set of
     *  them: `[("a" | "b")]` yes, `[string]` no. */
    private finiteKeys(key: Type): Set<string> | undefined {
        const t = this.expand(key)
        const parts = t.kind === "union" ? t.types : [t]
        const out = new Set<string>()
        for (const part of parts.map(m => this.expand(m))) {
            if (part.kind !== "literal" || typeof part.value === "boolean") return undefined
            out.add(String(part.value))
        }
        return out.size ? out : undefined
    }

    private reportExcessProperties(expression: Expression, target: Type): void {
        let literal = unwrapParens(expression)
        while (literal.type === "AsConstExpression") literal = unwrapParens(literal.expression)
        if (literal.type !== "TableExpression" || !this.emitDiagnostics) return
        const members = this.membersOf(target)
        const shapes = members.filter((m): m is ObjectType => m.kind === "object")
        if (!shapes.length || shapes.some(o => o.class)) return
        // `{ [Names]: V }` over a finite set of literal keys names exactly
        // those keys, so a key outside it is as excess as an unknown property.
        // `{ [string]: V }` accepts anything — nothing can be excess there.
        const keySets = shapes.map(o => o.indexer && this.finiteKeys(o.indexer.key))
        if (shapes.some((o, i) => o.indexer && !keySets[i])) return
        if (members.some(m => m.kind === "any" || m.kind === "unknown" || m.kind === "typeParam" || m.kind === "intersection")) return
        for (const field of literal.fields) {
            if (field.type !== "TableFieldNamed" && field.type !== "TableFieldShorthand") continue
            const key = field.type === "TableFieldNamed" ? field.key : field.name
            const name = key.type === "Identifier" ? key.name : key.value
            const expected = shapes.flatMap((o, i) => {
                const property = o.properties.get(name)
                if (property) return [property.type]
                return o.indexer && keySets[i]!.has(name) ? [o.indexer.value] : []
            })
            if (!expected.length) {
                if (this.excessReported.has(key)) continue
                this.excessReported.add(key)
                this.diagnostics.push({
                    node: key,
                    message: `Object literal may only specify known properties, and '${name}' does not exist in type '${formatType(target)}'`,
                })
                continue
            }
            if (field.type === "TableFieldNamed") this.reportExcessProperties(field.value, union(expected))
        }
    }

    private inferAsConst(expr: Expression, env: FlowEnv): Type {
        switch (expr.type) {
            case "ArrayExpression": return this.inferArray(expr, env, true)
            case "TableExpression": return this.inferObject(expr, env, true)
            case "ParenthesizedExpression": return this.inferAsConst(expr.expression, env)
            case "AsConstExpression": return this.inferAsConst(expr.expression, env)
            default: {
                const t = this.inferInner(expr, env)
                this.typeOf.set(expr, t)
                return t // literals stay narrow; nothing to freeze
            }
        }
    }

    // --------------------------------------------------------
    // Narrowing
    // --------------------------------------------------------

    private narrowFromCondition(cond: Expression, env: FlowEnv): { whenTrue: FlowEnv; whenFalse: FlowEnv } {
        const whenTrue = forkEnv(env)
        const whenFalse = forkEnv(env)
        this.applyNarrowing(cond, env, whenTrue, whenFalse)
        return { whenTrue, whenFalse }
    }

    /** Record what `cond` being true (`t`) or false (`f`) tells us. `env` is the
     *  state the condition is evaluated in; `t` and `f` are the two successor
     *  states to write into. */
    private applyNarrowing(cond: Expression, env: FlowEnv, t: FlowEnv, f: FlowEnv): void {
        if (cond.type === "ParenthesizedExpression") {
            this.applyNarrowing(cond.expression, env, t, f)
            return
        }

        // `not X` — the branches simply swap.
        if (cond.type === "UnaryExpression" && cond.operator === "not") {
            this.applyNarrowing(cond.argument, env, f, t)
            return
        }

        if (cond.type === "BinaryExpression") {
            const { operator: op, left, right } = cond
            if (op === "and") {
                // true branch: both operands held, so `right` is narrowed on top
                // of `left`'s result. false branch: either could have failed —
                // not refinable, so its narrowings go to a scratch env.
                this.applyNarrowing(left, env, t, forkEnv(env))
                this.applyNarrowing(right, t, t, forkEnv(t))
                return
            }
            if (op === "or") {
                // Mirror image: only the false branch (both operands falsy) refines.
                this.applyNarrowing(left, env, forkEnv(env), f)
                this.applyNarrowing(right, f, forkEnv(f), f)
                return
            }
            if (op === "==" || op === "~=") {
                this.narrowByComparison(left, right, op === "==", env, t, f)
            }
            return
        }

        // A call used directly as a condition: `if isString(v) then`, and the
        // Luau built-ins declared the same way.
        if (cond.type === "CallExpression" || cond.type === "MethodCallExpression") {
            this.narrowByPredicateCall(cond, env, t, f)
        } else {
            // Bare truthiness — `if x then`, `if x.y then`, `if cfg["debug"] then`.
            this.narrowRef(cond, env, t, f, cur => ({
                yes: narrowTruthy(cur),
                no: narrowFalsy(cur),
            }))
        }
        // A truthy optional chain did not short-circuit: `if a?.b then` means
        // `a` is not nil in the true branch.
        this.narrowOptionalLinks(cond, env, t)
    }

    /** `a == b` / `a ~= b`. Handles, in order: a declaration-driven
     *  `typeof(x) == "..."` test, a literal/`nil` comparison against a
     *  reference, and a reference-to-reference comparison. */
    private narrowByComparison(
        left: Expression, right: Expression, eq: boolean,
        env: FlowEnv, t: FlowEnv, f: FlowEnv,
    ): void {
        const yes = eq ? t : f
        const no = eq ? f : t

        // `typeof(x) == "number"` and friends.
        if (this.narrowByCallResult(left, right, yes, no, env)) return
        if (this.narrowByCallResult(right, left, yes, no, env)) return

        const litOf = (e: Expression): Type | undefined => {
            const v = this.asLiteral(e)
            if (v !== undefined) return literal(v)
            return e.type === "NilLiteral" ? nilType : undefined
        }

        // `x == <literal>` / `x == nil`, including a discriminant `x.tag == "..."`.
        for (const [ref, other] of [[left, right], [right, left]] as const) {
            const value = litOf(other)
            if (value === undefined) continue
            if (this.refKeyOf(ref) !== undefined) {
                this.narrowRef(ref, env, yes, no, cur => ({
                    yes: narrowTo(cur, value),
                    no: narrowExclude(cur, value),
                }))
            }
            // `a?.b == "x"` holds only if the chain got as far as `b`, and
            // `a?.b ~= nil` too: either way `a` is not nil there.
            this.narrowOptionalLinks(ref, env, value.kind === "primitive" && value.name === "nil" ? no : yes)
            return
        }

        // `x == y` between two references: in the equal branch each side is
        // narrowed by the other, which is how TypeScript handles it.
        if (this.refKeyOf(left) !== undefined && this.refKeyOf(right) !== undefined) {
            const lt = this.typeAtRef(left, env)
            const rt = this.typeAtRef(right, env)
            this.narrowRef(left, env, yes, no, cur => ({ yes: narrowTo(cur, rt), no: cur }))
            this.narrowRef(right, env, yes, no, cur => ({ yes: narrowTo(cur, lt), no: cur }))
        }
    }

    /** Declaration-driven `typeof(x) == "number"`.
     *
     *  `typeof` is not special-cased: it is declared in the definitions as an
     *  overload set whose members return *string-literal* types
     *  (`(value: number) -> "number"`, ...). So for `f(x) == "lit"` we keep the
     *  parameter types of the overloads that can return `"lit"`, and that union
     *  is what `x` narrows to. Any user function declared the same way gets the
     *  same treatment for free.
     *
     *  The analyzer knows nothing about the names `type` and `typeof`: with no
     *  definitions loaded there are no literal-returning overloads and this
     *  narrows nothing. Returns true if it handled the comparison. */
    private narrowByCallResult(
        callSide: Expression, litSide: Expression,
        yes: FlowEnv, no: FlowEnv, env: FlowEnv,
    ): boolean {
        if (callSide.type !== "CallExpression" || callSide.arguments.length !== 1) return false
        const name = this.asLiteral(litSide)
        if (typeof name !== "string") return false
        const arg = callSide.arguments[0]
        if (this.refKeyOf(arg) === undefined) return false

        const result = literal(name)
        const callee = this.typeOf.get(callSide.callee) ?? this.typeAtRef(callSide.callee, env)

        // Only literal-returning overloads discriminate; a catch-all returning
        // plain `string` matches everything and would narrow to nothing useful.
        const discriminating = this.overloadsOf(callee)
            .filter(o => o.params.length >= 1 && o.returns.kind === "literal")
        if (!discriminating.length) return false

        const matching = discriminating.filter(o => isAssignable(result, o.returns))
        if (!matching.length) return false
        const filter = union(matching.map(o => o.params[0].type))
        this.narrowRef(arg, env, yes, no, cur => ({
            yes: narrowTo(cur, filter),
            no: narrowExclude(cur, filter),
        }))
        return true
    }

    /** A call used as a condition, where the callee was declared with a type
     *  guard (`v is string`). Narrows the corresponding argument. */
    private narrowByPredicateCall(cond: Expression, env: FlowEnv, t: FlowEnv, f: FlowEnv): void {
        const found = this.predicateCallTarget(cond, env)
        if (!found) return
        const filter = found.predicate.type
        this.narrowRef(found.arg, env, t, f, cur => filter
            ? { yes: narrowTo(cur, filter), no: narrowExclude(cur, filter) }
            : { yes: narrowTruthy(cur), no: narrowFalsy(cur) })
    }

    /** Resolve a call expression to (guarded argument, predicate), if the
     *  callee was declared with one and that argument is a narrowable
     *  reference. Shared by branch guards and `asserts` statements. */
    private predicateCallTarget(
        cond: Expression, env: FlowEnv,
    ): { arg: Expression; predicate: TypePredicate } | undefined {
        let callee: Type
        let args: Expression[]
        let selfType: Type | undefined
        if (cond.type === "CallExpression") {
            // Past a `?.` the call only runs on what is not nil: `a?.check(x)`.
            callee = this.chainValue.get(cond.callee) ?? this.typeOf.get(cond.callee) ?? this.typeAtRef(cond.callee, env)
            args = cond.arguments
        } else if (cond.type === "MethodCallExpression") {
            // `obj?:IsA("Folder")` calls `IsA` only on an `obj` that is not nil,
            // so the method, and the `self` it is checked against, are the
            // non-nil object's.
            let objType = this.chainValue.get(cond.object) ?? this.typeOf.get(cond.object) ?? this.typeAtRef(cond.object, env)
            if (cond.optional) {
                objType = withoutNil(objType)
                selfType = objType
            }
            callee = this.propertyType(objType, cond.method.name)
            // `obj:m(a)` — `obj` occupies the `self` slot only for a signature
            // that declares one, so the written arguments shift accordingly.
            const first = this.overloadsOf(callee)[0]
            args = first && this.takesSelf(first) ? [cond.object, ...cond.arguments] : cond.arguments
        } else {
            return undefined
        }

        // Which overload runs decides which guard applies. `IsA` declares one
        // signature per class name, so `part:IsA("Model")` must resolve to the
        // `"Model"` signature — taking the first signature that merely *has* a
        // predicate would narrow to whatever class happened to be declared
        // first.
        const overloads = this.overloadsOf(callee)
        const argTypes = args.map(a =>
            (selfType && cond.type === "MethodCallExpression" && a === cond.object ? selfType : undefined) ??
            this.typeOf.get(a) ?? this.typeAtRef(a, env))
        const picked = this.pickOverload(overloads, argTypes)
        const candidates = picked ? [picked, ...overloads.filter(f => f !== picked)] : overloads

        for (const f of candidates) {
            if (!f.predicate) continue
            const arg = args[f.predicate.param]
            // `assert(i ~= nil)`: a plain `asserts value` on a condition
            // rather than a reference — `applyAssertion` narrows by it.
            const onCondition = f.predicate.asserts && !f.predicate.type
            if (!arg || (this.refKeyOf(arg) === undefined && !onCondition)) continue
            // A generic guard (`<K>(v, name: K) -> v is Map[K]`) says nothing
            // until its type arguments are known, so resolve them from this
            // call and substitute them into the narrowed type.
            if (f.typeParams?.length && f.predicate.type) {
                const subst = this.inferTypeArgs(f, argTypes)
                return {
                    arg,
                    predicate: {
                        ...f.predicate,
                        type: this.reduceType(substitute(f.predicate.type, subst)),
                    },
                }
            }
            return { arg, predicate: f.predicate }
        }
        return undefined
    }

    /** `assert(x)` / any `asserts`-declared call in statement position: narrows
     *  the *rest of the enclosing block* rather than a branch. */
    private applyAssertion(call: Expression, env: FlowEnv): void {
        const found = this.predicateCallTarget(call, env)
        if (!found || !found.predicate.asserts) return
        const filter = found.predicate.type
        // The call returned, so the condition held: the rest of the block is
        // its true branch, as after `if (not (i ~= nil)) { error() }`.
        if (this.refKeyOf(found.arg) === undefined) {
            if (!filter) this.applyNarrowing(found.arg, env, env, forkEnv(env))
            return
        }
        this.narrowRef(found.arg, env, env, forkEnv(env), cur => filter
            ? { yes: narrowTo(cur, filter), no: narrowExclude(cur, filter) }
            : { yes: narrowTruthy(cur), no: narrowFalsy(cur) })
    }

    // --------------------------------------------------------
    // Reference paths
    // --------------------------------------------------------

    /** The flow key for a narrowable reference, or undefined if `expr` is not
     *  one (a call, an arithmetic result, a computed index, ...). */
    private refKeyOf(expr: Expression): RefKey | undefined {
        switch (expr.type) {
            case "Identifier": {
                const id = this.bindingIdOf(expr)
                return id === undefined ? undefined : bindKey(id)
            }
            case "ParenthesizedExpression":
                return this.refKeyOf(expr.expression)
            case "MemberExpression": {
                const base = this.refKeyOf(expr.object)
                return base === undefined ? undefined : `${base}.${expr.property.name}`
            }
            case "IndexExpression": {
                const base = this.refKeyOf(expr.object)
                if (base === undefined) return undefined
                // A statically known key names a stable reference, and so
                // does a variable: `t[k]` is the same slot until `t` or `k`
                // is assigned again (see `invalidateBelow`).
                if (expr.index.type === "StringLiteral") return `${base}.${expr.index.value}`
                if (expr.index.type === "NumberLiteral") return `${base}#${expr.index.value}`
                if (expr.index.type === "Identifier") {
                    const id = this.bindingIdOf(expr.index)
                    return id === undefined ? undefined : `${base}[${bindKey(id)}]`
                }
                return undefined
            }
            default:
                return undefined
        }
    }

    /** The type of a reference right now: its flow narrowing if it has one,
     *  else its declared type reached through the (possibly narrowed) parent.
     *  Never records anything in `typeOf` — narrowing must not perturb
     *  inference results. */
    private typeAtRef(expr: Expression, env: FlowEnv): Type {
        const key = this.refKeyOf(expr)
        if (key !== undefined) {
            const narrowed = env.get(key)
            if (narrowed) return narrowed
        }
        switch (expr.type) {
            case "Identifier": {
                const id = this.bindingIdOf(expr)
                return id === undefined ? anyType : this.currentType(id, env)
            }
            case "ParenthesizedExpression":
                return this.typeAtRef(expr.expression, env)
            case "MemberExpression":
                return this.propertyType(this.typeAtRef(expr.object, env), expr.property.name)
            case "IndexExpression":
                return this.indexedType(
                    this.typeAtRef(expr.object, env),
                    this.typeOf.get(expr.index) ?? unknownType,
                )
            default:
                return this.typeOf.get(expr) ?? anyType
        }
    }

    /** The declared (un-narrowed) type behind a flow key — what a reference
     *  falls back to when one branch narrowed it and another did not. */
    private declaredAtRef(key: RefKey): Type {
        const root = /^\$(\d+)/.exec(key)
        if (!root) return anyType
        let t = this.bindingType.get(Number(root[1])) ?? anyType
        for (const step of key.slice(root[0].length).matchAll(/\.([^.#]+)|#(\d+)/g)) {
            t = step[1] !== undefined
                ? this.propertyType(t, step[1])
                : this.indexedType(t, literal(Number(step[2])))
        }
        return t
    }

    /** Narrow a reference in both successor states, then propagate the
     *  consequences *up* the path: if `s.kind` is now `"circle"`, the union
     *  members of `s` whose `kind` cannot be `"circle"` are gone too. That
     *  upward step is what makes discriminated unions work at any depth. */
    private narrowRef(
        expr: Expression, env: FlowEnv, t: FlowEnv, f: FlowEnv,
        refine: (cur: Type) => { yes: Type; no: Type },
    ): void {
        const key = this.refKeyOf(expr)
        if (key === undefined) return
        const cur = this.typeAtRef(expr, env)
        const { yes, no } = refine(cur)
        this.setRef(t, key, yes)
        this.setRef(f, key, no)
        this.correlate(t, key, yes)
        this.correlate(f, key, no)
        this.propagateAliases(env, t, key, yes)
        this.propagateAliases(env, f, key, no)

        const inner = expr.type === "ParenthesizedExpression" ? expr.expression : expr
        if (inner.type !== "MemberExpression" && inner.type !== "IndexExpression") return
        const parentKey = this.refKeyOf(inner.object)
        if (parentKey === undefined) return
        const step = key.slice(parentKey.length)
        if (!step.startsWith(".")) return // only property steps discriminate
        const prop = step.slice(1)
        const optional = inner.type === "MemberExpression" && inner.optional === true
        this.narrowRef(inner.object, env, t, f, parentType => ({
            yes: this.filterByProperty(parentType, prop, yes, optional),
            no: this.filterByProperty(parentType, prop, no, optional),
        }))
    }

    /** Keep the union members of `parent` whose `prop` can still hold `want`.
     *  Leaves a non-union (or a union nothing matches) alone: over-narrowing a
     *  plain object to `never` because of a property test would be worse than
     *  learning nothing. */
    private filterByProperty(parent: Type, prop: string, want: Type, optional = false): Type {
        if (parent.kind !== "union" || want.kind === "never") return parent
        // A nil member has no properties. Read through `?.` it gives nil; read
        // through `.` it cannot have been the value at all.
        const kept = parent.types.filter(m => m.kind === "primitive" && m.name === "nil"
            ? optional && overlaps(nilType, want)
            : overlaps(this.propertyType(m, prop), want))
        return kept.length ? union(kept) : parent
    }

    /** Record a narrowing. Deliberately does *not* discard what is known about
     *  paths beneath `key`: narrowing only ever shrinks a type, and the child
     *  facts were derived from the same test — `narrowRef` sets the leaf first
     *  and then walks up, so wiping descendants here would erase the very
     *  narrowing that triggered the walk. Assignment is the operation that
     *  invalidates (`assignToRef`). */
    private setRef(env: FlowEnv, key: RefKey, t: Type): void {
        env.set(key, t)
    }

    /** An assignment to a path (or to anything it hangs off) means the name
     *  that copied it no longer holds that value: forget the alias. */
    private unalias(key: RefKey): void {
        for (const k of [...this.refAliases.keys()]) {
            if (k !== key && !isBelow(k, key) && !k.includes(`[${key}]`)) continue
            for (const other of this.refAliases.get(k) ?? []) this.refAliases.get(other)?.delete(k)
            this.refAliases.delete(k)
        }
    }

    /** Drop every narrowing recorded for a path strictly under `key` — and,
     *  when `key` is a whole variable, for every `t[key]` indexed by it: that
     *  now names a different slot. */
    private invalidateBelow(env: FlowEnv, key: RefKey): void {
        const asIndex = `[${key}]`
        for (const k of [...env.keys()]) {
            if (isBelow(k, key) || k.includes(asIndex)) env.delete(k)
        }
    }

    /** An assignment through a reference invalidates it and everything under
     *  it, then records the assigned type. */
    private assignToRef(expr: Expression, value: Type, env: FlowEnv): void {
        this.invalidateSiblings(expr, env)
        const key = this.refKeyOf(expr)
        if (key === undefined) return
        this.invalidateBelow(env, key)
        this.unalias(key)
        env.set(key, value)
    }

    /** A write to one slot of a table can be a write to a slot narrowed under
     *  another name: `t.x = nil` is `t[k] = nil` when `k` is `"x"`. So a
     *  write by name forgets what is known through variable keys, and a write
     *  through any computed key forgets everything known about the table's
     *  slots. */
    private invalidateSiblings(expr: Expression, env: FlowEnv): void {
        const inner = expr.type === "ParenthesizedExpression" ? expr.expression : expr
        if (inner.type !== "MemberExpression" && inner.type !== "IndexExpression") return
        const parent = this.refKeyOf(inner.object)
        if (parent === undefined) return
        const computed = inner.type === "IndexExpression"
            && inner.index.type !== "StringLiteral" && inner.index.type !== "NumberLiteral"
        for (const k of [...env.keys()]) {
            if (computed ? isBelow(k, parent) : k.startsWith(`${parent}[`)) env.delete(k)
        }
    }

    // --------------------------------------------------------
    // Small helpers
    // --------------------------------------------------------

    /** Type of the `self` parameter for the method currently being analysed. */
    private selfType: Type | undefined

    private withSelfType(t: Type | undefined, fn: () => void): void {
        const saved = this.selfType
        this.selfType = t
        try {
            fn()
        } finally {
            this.selfType = saved
        }
    }

    /** Arithmetic no declared metamethod answers: a number — unless an
     *  operand is `any`, which may be a value with metamethods of its own.
     *  `(a.Position - b.Position).Magnitude` on an `a` nothing typed is a
     *  `Vector3` as far as anyone knows, not a number with no `Magnitude`. */
    private arithmeticOn(operands: readonly Type[]): Type {
        return operands.some(t => this.expand(t).kind === "any") ? anyType : numberType
    }

    /** `a == b` where nothing `a` can hold is anything `b` can: the answer is
     *  always the same, so the comparison was not the one meant. Only types
     *  that say what they hold take part — `any`, `unknown` and a type
     *  parameter say nothing, and a table compares by identity, so two of them
     *  may well be the same table. */
    private checkOverlap(node: Expression, op: string, l: Type, r: Type): void {
        if (!this.emitDiagnostics) return
        const left = this.expand(l)
        const right = this.expand(r)
        const judged = (t: Type): boolean => {
            const parts = t.kind === "union" ? t.types.map(m => this.expand(m)) : [t]
            return parts.every(p => p.kind === "literal" || p.kind === "primitive")
        }
        // A test against nil is never idle: a map's value and an array's
        // element are read as what they hold, so nil is exactly what a type
        // saying otherwise may still turn out to be.
        const isNil = (t: Type): boolean => t.kind === "primitive" && t.name === "nil"
        if (isNil(left) || isNil(right)) return
        if (!judged(left) || !judged(right)) return
        if (isAssignable(left, right) || isAssignable(right, left)) return
        // A literal against its own primitive overlaps even where neither is
        // assignable to the other, which `isAssignable` already answers; what
        // is left is two sets with nothing in common.
        this.diagnostics.push({
            node,
            message: `This comparison is always ${op === "==" ? "false" : "true"}: '${formatType(l)}' and '${formatType(r)}' have no value in common`,
        })
    }

    /** What an operator takes, where no metamethod answered for it. Luau
     *  raises on the rest — `n * 2` with `n` nil is an error at the line it
     *  runs, and a nil `n` is exactly what `number | nil` says may happen — so
     *  it is said here instead. `any` passes: nothing is known about it. */
    private checkOperands(node: Expression, op: string, left: Type, right?: Type): void {
        if (!this.emitDiagnostics) return
        const fits = (t: Type): boolean => {
            const x = this.expand(t)
            if (x.kind === "any" || x.kind === "never") return true
            switch (op) {
                // `..` joins strings, and Luau writes a number into one.
                case "..": return isAssignable(x, stringType) || isAssignable(x, numberType)
                // `#` counts a string's bytes or a table's entries.
                case "#": return x.kind === "array" || x.kind === "tuple" || x.kind === "object"
                    || isAssignable(x, stringType)
                default: return isAssignable(x, numberType)
            }
        }
        // `<` and its kin compare two numbers or two strings, never one of each.
        if (op === "<" || op === ">" || op === "<=" || op === ">=") {
            const both = (t: Type): Type => this.expand(t)
            const [l, r] = [both(left), both(right!)]
            const loose = (t: Type): boolean => t.kind === "any" || t.kind === "never"
            const alike = (as: Type): boolean => isAssignable(l, as) && isAssignable(r, as)
            if (loose(l) || loose(r) || alike(numberType) || alike(stringType)) return
        } else if (fits(left) && (right === undefined || fits(right))) {
            return
        }
        this.diagnostics.push({
            node,
            message: right === undefined
                ? `Operator '${op}' cannot be applied to type '${formatType(left)}'`
                : `Operator '${op}' cannot be applied to types '${formatType(left)}' and '${formatType(right)}'`,
        })
    }

    /** `a < b` between class instances: Luau asks `__lt` (`__le` for `<=`),
     *  with the operands swapped for `>` and `>=`, and an instance without
     *  one cannot be compared at all. */
    private checkComparison(node: Expression, op: string, l: Type, r: Type): boolean {
        if (!this.emitDiagnostics) return false
        const left = this.expand(l)
        const right = this.expand(r)
        const instance = (t: Type): boolean => t.kind === "object" && t.class !== undefined
        if (!instance(left) && !instance(right)) return false
        const name = op === "<" || op === ">" ? "__lt" : "__le"
        const operands = op === ">" || op === ">=" ? [right, left] : [left, right]
        for (const receiver of operands) {
            const method = receiver.kind === "object" ? receiver.properties.get(name) : undefined
            if (!method) continue
            if (this.pickOverload(this.overloadsOf(method.type), operands)) return true
            break
        }
        this.diagnostics.push({
            node,
            message: `Operator '${op}' cannot be applied to types '${formatType(l)}' and '${formatType(r)}'`,
        })
        return true
    }

    /** What an operator on a value with metamethods gives: `a + b` calls
     *  `__add` on `a`, or failing that on `b` with the operands swapped — the
     *  order Luau tries them in. That is how `Vector3 + Vector3`, `CFrame *
     *  Vector3` and `2 * vector` get their types from the declarations.
     *  `undefined` when neither operand declares the metamethod; an operand
     *  that declares it but accepts neither argument is reported. */
    private operatorResult(node: Expression, op: string, left: Type, right: Type | undefined): Type | undefined {
        const name = right === undefined
            ? (op === "-" ? "__unm" : "__len")
            : METAMETHODS[op]
        if (!name) return undefined
        const candidates: [Type, Type | undefined][] = right === undefined ? [[left, undefined]] : [[left, right], [right, left]]
        let declared: Type | undefined
        for (const [receiver, other] of candidates) {
            const t = this.expand(receiver)
            const method = t.kind === "object" ? t.properties.get(name) : undefined
            if (!method) continue
            declared ??= receiver
            const args = other === undefined ? [receiver] : [receiver, other]
            const picked = this.pickOverload(this.overloadsOf(method.type), args)
            if (picked) return this.callReturn(picked, args)
        }
        if (declared && this.emitDiagnostics) {
            this.diagnostics.push({
                node,
                message: right === undefined
                    ? `Operator '${op}' cannot be applied to type '${formatType(left)}'`
                    : `Operator '${op}' cannot be applied to types '${formatType(left)}' and '${formatType(right)}'`,
            })
            return anyType
        }
        return undefined
    }

    /** Does this signature take the receiver as its first parameter?
     *
     *  Luau's `:` is sugar both ways: `function T:m(a)` declares
     *  `(self: T, a)`, and `o:m(x)` calls it as `m(o, x)`. The convention that
     *  marks it is the first parameter being named `self` — which is what the
     *  parser injects for `function T:m` and what the definitions files spell
     *  out. Every place that has to line arguments up with parameters goes
     *  through here so the two sides cannot drift apart. */
    private takesSelf(f: FunctionType): boolean {
        const first = f.params[0]?.name
        return first === "self" || first === "this"
    }

    /** What one value of a spread array is, or `undefined` when the thing
     *  spread is not a list of values at all. */
    private spreadElement(t: Type): Type | undefined {
        const spread = this.expand(t)
        if (spread.kind === "array") return spread.element
        if (spread.kind === "tuple") return union(spread.elements)
        if (spread.kind === "any") return anyType
        return undefined
    }

    /** Where a call's arguments stop being one each, and what fills the rest.
     *  From a spread on, every remaining parameter is filled by one of the
     *  array's values — however many that turns out to be, so neither the
     *  count nor the positions after it are known. A *tuple* is the exception:
     *  it holds a known value at each position, and `elements` says which. */
    private spreadOf(args: readonly Expression[], self = 0): SpreadInfo | undefined {
        const index = args.findIndex(a => a.type === "SpreadElement")
        if (index < 0) return undefined
        const spread = args[index] as Extract<Expression, { type: "SpreadElement" }>
        const held = this.typeOf.get(spread.argument)
        const expanded = held && this.expand(held)
        return {
            index: index + self,
            element: this.typeOf.get(spread) ?? unknownType,
            elements: expanded?.kind === "tuple" ? expanded.elements : undefined,
        }
    }

    /** One of `spread`'s values, at the position `i` of a call's arguments. */
    private spreadValue(spread: SpreadInfo, i: number): Type {
        if (!spread.elements) return spread.element
        return spread.elements[i - spread.index] ?? neverType
    }

    /** A function type as a list of call signatures: a lone function is a
     *  one-element list, an intersection is the overload set in source order. */
    private overloadsOf(t: Type): FunctionType[] {
        if (t.kind === "function") return [t]
        if (t.kind === "intersection") {
            return t.types.filter((m): m is FunctionType => m.kind === "function")
        }
        return []
    }

    /** A union of function types, as its members' call signatures. A value
     *  that is one function or another is callable only when every member is,
     *  and any of them may be the one called — so the call has to suit them
     *  all and its result is their returns united, rather than one signature's
     *  the way an overload set picks. An overloaded member contributes all of
     *  its own signatures. */
    private unionSignatures(t: Type): FunctionType[] | undefined {
        const u = this.expand(t)
        if (u.kind !== "union") return undefined
        const signatures: FunctionType[] = []
        for (const member of u.types) {
            const fns = this.overloadsOf(this.expand(member))
            if (!fns.length) return undefined
            signatures.push(...fns)
        }
        return signatures.length ? signatures : undefined
    }


    private asLiteral(e: Expression): string | number | boolean | undefined {
        if (e.type === "StringLiteral") return e.value
        if (e.type === "NumberLiteral") return e.value
        if (e.type === "BooleanLiteral") return e.value
        return undefined
    }

    private asNarrowable(e: Expression): boolean {
        return e.type === "Identifier" ||
            (e.type === "MemberExpression" && e.object.type === "Identifier")
    }

    private initIsAsConst(e: Expression | undefined): boolean {
        return e?.type === "AsConstExpression"
    }

    /** The type a binding has *here*: its flow-narrowed type if the current
     *  environment has one, else its declared/inferred type. */
    private currentType(id: BindingId, env: FlowEnv): Type {
        return env.get(bindKey(id)) ?? this.bindingType.get(id) ?? this.declaredAhead(id) ?? anyType
    }

    // --------------------------------------------------------
    // Hoisting
    // --------------------------------------------------------
    //
    // Scope analysis lets code see a function declared later in its block,
    // and a module's top-level names from function bodies and `typeof` written
    // above them. The walk has not reached those declarations yet when such a
    // reference is met, so their type is worked out from the declaration on
    // the spot — its annotation, or its body or initializer — as TypeScript
    // does. The walk reaching the declaration later types it for real.

    /** Declarations a reference may meet before the walk does. */
    private aheadDeclarations?: Map<BindingId, Statement>
    private readonly computingAhead = new Set<BindingId>()

    private declaredAhead(id: BindingId): Type | undefined {
        this.aheadDeclarations ??= this.indexAheadDeclarations()
        const statement = this.aheadDeclarations.get(id)
        if (!statement || this.computingAhead.has(id)) return undefined
        this.computingAhead.add(id)
        const wasEmitting = this.emitDiagnostics
        this.emitDiagnostics = false
        try {
            let type: Type | undefined
            if (statement.type === "DeclareStatement") {
                type = this.resolveType(statement.valueType)
            } else if (statement.type === "FunctionDeclaration") {
                type = statement.signatures?.length
                    ? intersection(statement.signatures.map(sig => this.signatureToFnType(sig)))
                    : this.inferFunctionBody(statement.func, new Map())
            } else if (statement.type === "ClassDeclaration") {
                type = this.classValueType(statement)
            } else if (statement.type === "VariableDeclaration") {
                const target = statement.name
                if (target.type === "IdentifierPattern" && target.typeAnnotation) {
                    type = this.resolveType(target.typeAnnotation)
                } else if (statement.init) {
                    const value = this.infer(statement.init, new Map())
                    type = statement.kind === "const" ? value : widen(value)
                }
            }
            if (type) this.bindingType.set(id, type)
            return type
        } finally {
            this.emitDiagnostics = wasEmitting
            this.computingAhead.delete(id)
        }
    }

    /** Every function declaration, and every plain name the module declares
     *  at its top level. */
    private indexAheadDeclarations(): Map<BindingId, Statement> {
        const out = new Map<BindingId, Statement>()
        for (const statement of this.program.body.statements) {
            const declaration = statement.type === "ExportStatement" ? statement.declaration : statement
            if (declaration.type !== "VariableDeclaration") continue
            const target = declaration.name
            if (target.type !== "IdentifierPattern") continue
            const id = this.bindingIdByName(target.name, target)
            if (id !== undefined) out.set(id, declaration)
        }
        const visit = (node: unknown): void => {
            if (!node || typeof node !== "object") return
            if (Array.isArray(node)) {
                for (const item of node) visit(item)
                return
            }
            const record = node as { type?: string; name?: Identifier }
            if (record.type === "ClassDeclaration" && record.name) {
                const id = this.bindingIdByName(record.name.name, record.name)
                if (id !== undefined) out.set(id, node as Statement)
            }
            if (record.type === "FunctionDeclaration" && record.name) {
                const id = this.bindingIdByName(record.name.name, record.name)
                if (id !== undefined) out.set(id, node as Statement)
            }
            for (const [key, value] of Object.entries(node)) {
                if (key !== "line" && key !== "column" && value && typeof value === "object") visit(value)
            }
        }
        visit(this.program.body)
        for (const [name, statement] of this.deferredDeclares) {
            const id = this.scopes.globalsByName.get(name)
            if (id !== undefined) out.set(id, statement)
        }
        return out
    }

    /** Bind or rebind a whole variable: any narrowing recorded for a path
     *  *under* it (`x.a`, `x[1]`) described the old value and must go. */
    private setBinding(env: FlowEnv, id: BindingId, t: Type): void {
        this.invalidateBelow(env, bindKey(id))
        env.set(bindKey(id), t)
    }

    /** Why `actual` does not fit `expected`, when something shorter than the
     *  two whole shapes can be said: the properties it is missing, or the
     *  first one whose type is wrong. Empty when it cannot — the types
     *  themselves are then the whole story. */
    private explainMismatch(actual: Type, expected: Type): string {
        const from = this.expand(actual)
        if (from.kind !== "object") return ""
        // A union target is the common case worth explaining, not the one to
        // give up on: `Stat` is `StatSuccess | StatError`, and a value that
        // says `Status: true` was reaching for the first. Name what that arm
        // still wanted rather than printing both arms and leaving the reader
        // to diff them.
        const to = this.likeliestArm(from, this.expand(expected))
        if (to === undefined) return ""
        const missing: { name: string; type: string }[] = []
        for (const [name, property] of to.properties) {
            if (property.optional || from.properties.has(name) || INTERNAL_MEMBERS.has(name)) continue
            missing.push({ name, type: formatType(property.type) })
        }
        if (missing.length) {
            const rest = missing.length - MAX_MISSING
            const tail = rest > 0 ? ` and ${rest} more` : ""
            const shown = missing.slice(0, MAX_MISSING)
            // A key is worth naming with its type; a class's fifty members are
            // worth naming only by name, and a signature spelled out in full
            // would bury the sentence it is meant to finish.
            const withTypes = shown.map(m => `${m.name}: ${m.type}`).join(", ")
            if (withTypes.length <= MAX_EXPLANATION) return `, missing ${withTypes}${tail}`
            return `, missing ${shown.map(m => m.name).join(", ")}${tail}`
        }
        // Every key is there, so the reason is one of their types.
        for (const [name, property] of to.properties) {
            if (INTERNAL_MEMBERS.has(name)) continue
            const own = from.properties.get(name)
            if (!own || isAssignable(own.type, property.type)) continue
            const is = formatType(own.type)
            const wanted = formatType(property.type)
            if (is.length + wanted.length > MAX_EXPLANATION) return `, '${name}' does not match`
            return `, '${name}' is ${is}, not ${wanted}`
        }
        return ""
    }

    /** Which object of a contract the value was reaching for. One object is
     *  itself; among several, a discriminant decides — the arm whose literal
     *  properties the value already agrees with (`Status: true` picks
     *  `StatSuccess` over `StatError`). Failing that, the arm it is closest to
     *  fitting, so the explanation is about the shortest gap rather than an
     *  arbitrary one. `undefined` when there is no object to explain against. */
    private likeliestArm(from: ObjectType, expected: Type): ObjectType | undefined {
        const arms = this.membersOf(expected).filter((m): m is ObjectType => m.kind === "object")
        if (arms.length <= 1) return arms[0]
        const gapOf = (arm: ObjectType): number => {
            let gap = 0
            for (const [name, property] of arm.properties) {
                if (INTERNAL_MEMBERS.has(name)) continue
                const own = from.properties.get(name)
                if (!own) { if (!property.optional) gap += 1; continue }
                if (isAssignable(own.type, property.type)) continue
                // Contradicting a literal the arm insists on is contradicting
                // which arm this is — `Status: true` is not `StatError` with a
                // typo in it, it is `StatSuccess`.
                gap += this.expand(property.type).kind === "literal" ? 100 : 1
            }
            // A property the arm has never heard of counts too: without it,
            // the arm that declares almost nothing wins every time by being
            // the one with least to miss.
            for (const name of from.properties.keys()) {
                if (!INTERNAL_MEMBERS.has(name) && !arm.properties.has(name) && !arm.indexer) gap += 1
            }
            return gap
        }
        return arms.reduce((best, arm) => (gapOf(arm) < gapOf(best) ? arm : best))
    }

    private bindingIdOf(id: Identifier): BindingId | undefined {
        return this.scopes.bindingOf.get(id)
    }

    /** Declaration nodes aren't in `bindingOf` (that map is usages only), so
     *  index every binding's declaration site up front. */
    private indexDeclarations(): void {
        for (const b of this.scopes.bindings.values()) {
            const d = b.declarationNode as
                { line?: { start: number }; column?: { start: number }; name?: string } | undefined
            if (!d) continue
            this.bindingByDecl.set(d, b.id)
            if (d.line && d.column) {
                this.bindingByPos.set(posKey(d.name ?? b.name, d.line.start, d.column.start), b.id)
            }
        }
    }

    private bindingIdByName(name: string, node: { line: { start: number }; column: { start: number } }): BindingId | undefined {
        return this.bindingByDecl.get(node as object) ??
            this.bindingByPos.get(posKey(name, node.line.start, node.column.start))
    }
}

/** Every type name a definitions file declares — a class, an alias or a
 *  `declare`. Worked out once per file: they are long, and every analysis
 *  against them asks the same question. */
const libraryNames = new WeakMap<Program, Set<string>>()

function namesDeclaredIn(program: Program): Set<string> {
    const known = libraryNames.get(program)
    if (known) return known
    const names = new Set<string>()
    for (const stmt of program.body.statements) {
        const declaration = stmt.type === "ExportStatement" || stmt.type === "ExportDefaultStatement"
            ? stmt.declaration
            : stmt
        if (declaration.type === "TypeAliasStatement") names.add(declaration.name.name)
        else if (declaration.type === "ExportTypeAliasStatement") names.add(declaration.alias.name.name)
        else if (declaration.type === "DeclareClassStatement") names.add(declaration.name.name)
        else if (declaration.type === "ClassDeclaration" && declaration.name) names.add(declaration.name.name)
        else if (stmt.type === "ImportStatement") {
            for (const s of stmt.specifiers) names.add(s.local.name)
            if (stmt.defaultImport) names.add(stmt.defaultImport.name)
            if (stmt.namespaceImport) names.add(stmt.namespaceImport.name)
        }
    }
    libraryNames.set(program, names)
    return names
}

interface SharedClasses {
    readonly libs: readonly Program[]
    readonly classTypes: WeakMap<DeclareClassStatement, ObjectType>
    readonly classMembers: WeakMap<ObjectType, () => { properties: Map<string, ObjectProperty>; indexer: ObjectType["indexer"] } | undefined>
}

const sharedClassesByLib = new WeakMap<Program, SharedClasses>()

/** The store of resolved library classes this analysis may use — or
 *  `undefined` when it must resolve its own. A file that declares a name one
 *  of the libraries also declares changes what that library's classes mean,
 *  so it gets no share of theirs. */
function shareableClasses(libs: readonly Program[], program: Program): SharedClasses | undefined {
    if (!libs.length) return undefined
    const mine = namesDeclaredIn(program)
    if (mine.size) {
        for (const lib of libs) {
            for (const name of namesDeclaredIn(lib)) if (mine.has(name)) return undefined
        }
    }
    const existing = sharedClassesByLib.get(libs[0])
    if (existing) {
        const same = existing.libs.length === libs.length && existing.libs.every((lib, i) => lib === libs[i])
        if (same) return existing
        return undefined
    }
    const store: SharedClasses = { libs: [...libs], classTypes: new WeakMap(), classMembers: new WeakMap() }
    sharedClassesByLib.set(libs[0], store)
    return store
}

/** Both walks below answer the same for a node every time they are asked —
 *  the tree does not change — and the same library nodes are asked about once
 *  per module analyzed. Remembering the answer is what keeps a project's
 *  thousandth file as quick as its first. */
const referencedNamesOf = new WeakMap<object, string[]>()
const typeQueryIn = new WeakMap<object, boolean>()

/** Every type name a type node mentions: `Config`, `Enum.Material`. */
function referencedTypeNames(node: unknown, out?: string[]): string[] {
    if (out === undefined && node && typeof node === "object") {
        const known = referencedNamesOf.get(node)
        if (known) return known
        const found = referencedTypeNames(node, [])
        referencedNamesOf.set(node, found)
        return found
    }
    out = out ?? []
    if (!node || typeof node !== "object") return out
    if (Array.isArray(node)) {
        for (const item of node) referencedTypeNames(item, out)
        return out
    }
    const record = node as { type?: unknown; base?: unknown; namespace?: unknown }
    if (record.type === "TypeReference" && typeof record.base === "string") {
        out.push(typeof record.namespace === "string" ? `${record.namespace}.${record.base}` : record.base)
    }
    for (const [key, value] of Object.entries(node)) {
        if (key !== "line" && key !== "column" && value && typeof value === "object") referencedTypeNames(value, out)
    }
    return out
}

/** Does a type contain a `typeof x`? Such a type depends on a value's type,
 *  so it cannot be resolved before the statements are walked. */
function containsTypeQuery(node: unknown): boolean {
    if (!node || typeof node !== "object") return false
    const known = typeQueryIn.get(node)
    if (known !== undefined) return known
    const found = Array.isArray(node)
        ? node.some(containsTypeQuery)
        : (node as { type?: unknown }).type === "TypeofTypeNode" || Object.values(node).some(containsTypeQuery)
    typeQueryIn.set(node, found)
    return found
}

/** `Uppercase<T>` and friends are built in, and resolve only once their
 *  argument is a known string. */
const STRING_INTRINSICS = new Set(["Uppercase", "Lowercase", "Capitalize", "Uncapitalize"])

/** A type for a message. A long union of literals — every service name — is
 *  cut short the way TypeScript does, so the message stays readable. */
function briefType(t: Type): string {
    if (t.kind === "union" && t.types.length > 8) {
        const shown = t.types.slice(0, 6).map(formatType).join(" | ")
        return `${shown} | ... ${t.types.length - 6} more`
    }
    const full = formatType(t)
    if (full.length <= MAX_TYPE) return full
    // Past this, the whole type is no longer the message — it buries it. An
    // object keeps its first few keys, since those are what a reader matches
    // against the value they wrote; anything else is cut where it stands. The
    // explanation that follows is what actually says what went wrong.
    if (t.kind === "object" && t.properties.size) {
        const names = [...t.properties.keys()].filter(n => !INTERNAL_MEMBERS.has(n))
        const shown = names.slice(0, MAX_MISSING)
        const rest = names.length - shown.length
        return `{ ${shown.join(", ")}${rest > 0 ? `, ... ${rest} more` : ""} }`
    }
    return `${full.slice(0, MAX_TYPE)}...`
}
