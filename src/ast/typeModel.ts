// ============================================================
// tilua type model
// ------------------------------------------------------------
// The internal representation `analyzeTypes` produces and both
// downstream consumers (the LSP, the compiler's `as const` /
// narrowing-aware lowering) read. Kept structural and immutable:
// every constructor returns a fresh value, nothing is mutated
// in place, so a `Type` can be shared freely across the maps in
// `TypeAnalysis`.
// ============================================================

export type Type =
    | AnyType
    | UnknownType
    | NeverType
    | PrimitiveType
    | LiteralType
    | ArrayType
    | TupleType
    | ObjectType
    | FunctionType
    | UnionType
    | IntersectionType
    | TypeParamType
    | GenericRefType
    | KeyofType
    | IndexedAccessType
    | ConditionalType
    | InferType
    | MappedType
    | TemplateLiteralType
    | DifferenceType
    | SpreadType

/** `any` — opts out of checking. Assignable to and from everything. */
export interface AnyType { kind: "any"; alias?: string }
/** `unknown` — top type. Everything is assignable to it; it is assignable to nothing but itself. */
export interface UnknownType {
    kind: "unknown"
    alias?: string
    /** The `unknown` a program wrote, as opposed to the one the analyzer falls
     *  back to when it cannot work a type out. Only a written one makes reading
     *  a member of it an error — the fallback means "not known here", and
     *  reporting that would be noise. */
    declared?: boolean
}
/** `never` — bottom type. Assignable to everything; nothing (but never) is assignable to it. */
export interface NeverType { kind: "never"; alias?: string }

/** `object` is TypeScript's: any value that is not one of the others — a
 *  table, a list, a function, a class instance. */
export type PrimitiveName = "nil" | "void" | "boolean" | "number" | "string" | "thread" | "buffer" | "object"
export interface PrimitiveType { kind: "primitive"; name: PrimitiveName; alias?: string }

/** `"foo"`, `42`, `true` — a single-valued type. `base` is the primitive it widens to. */
export interface LiteralType {
    kind: "literal"
    base: "boolean" | "number" | "string"
    value: string | number | boolean
    alias?: string
}

/** `T[]` */
export interface ArrayType { kind: "array"; element: Type; alias?: string; readonly?: boolean }

/** `[A, B, C]` — fixed length; `[A, ...B[]]` — at least that, then any
 *  number of `B`. `rest` is the element type of that tail. A tuple is an
 *  array, a table like any other: several results are one of these. */
export interface TupleType {
    kind: "tuple"; elements: Type[]; rest?: Type; alias?: string; readonly?: boolean
    /** `[number, string?]`: how many of the elements have to be there — the
     *  ones from here on may be left out, and hold `nil` when they are. All
     *  of them when absent. */
    minLength?: number
    /** `[x: number, y?: number]`: the name each element was written with,
     *  where it was. Display only. */
    names?: readonly (string | undefined)[]
}

/** `made`, rebuilt from `from`, keeping what `tuple` does not carry: that
 *  it is read-only, which of its places may be left out, and their names —
 *  so long as it has as many places as `from` had. */
export function tupleMeta(made: TupleType, from: TupleType): TupleType {
    const same = made.elements.length === from.elements.length
    return {
        ...made,
        ...(from.readonly ? { readonly: true } : {}),
        ...(same && from.minLength !== undefined ? { minLength: from.minLength } : {}),
        ...(same && from.names ? { names: from.names } : {}),
    }
}

/** How many places a tuple has to have. */
export function minLengthOf(t: TupleType): number {
    return t.minLength ?? t.elements.length
}

/** What a tuple's `length` is: one number, or each it may be. */
export function tupleLength(t: TupleType): Type {
    if (t.rest || hasSpread(t)) return numberType
    const lengths: Type[] = []
    for (let n = minLengthOf(t); n <= t.elements.length; n++) lengths.push(literal(n))
    return union(lengths)
}

/** `...T` among a tuple's elements, where `T` is not known yet — a type
 *  parameter, an `infer`, a type-level operator still waiting on one. It only
 *  ever stands inside a `TupleType`'s `elements`: `tuple` lays out a spread of
 *  anything known (a tuple's elements in its place, an array's as the rest),
 *  so once its type parameters are filled in none is left. */
export interface SpreadType { kind: "spread"; type: Type }

export function spread(type: Type): SpreadType {
    return { kind: "spread", type }
}

export interface ObjectProperty {
    type: Type
    optional: boolean
    readonly?: boolean
    /** A class member written `private`: reachable only from inside the class
     *  that declared it. `owner` is that class's node, compared by identity;
     *  `className` is how a diagnostic names it. Checked, never lowered.
     *  `protected` widens that to the classes extending it. */
    private?: { owner: object; className: string; protected?: boolean }
    /** An `abstract` class member: declared, with nothing behind it until a
     *  class extending this one writes it. */
    abstract?: boolean
}
export interface ObjectType {
    kind: "object"
    properties: Map<string, ObjectProperty>
    /** `{ [K]: V }` catch-all, if present. */
    indexer?: { key: Type; value: Type }
    /** `object` was produced by `as const` — literal members are kept narrow
     *  and every property is `readonly`. */
    frozen?: boolean
    /** The alias this object was resolved from — display only, ignored by
     *  `isAssignable` (the type is structural). Dropped on `widen`/`substitute`. */
    name?: string
    /** For a generic alias's name, the reference it names: `Box<T>` is
     *  `Box` with `[T]`, so filling `T` in names it `Box<number>`. */
    nameRef?: GenericRefType
    /** Set on a `declare class` — the type is then *nominal*. See `ClassInfo`. */
    class?: ClassInfo
}

/** What makes an object a class instance. `properties` then holds every
 *  member, inherited ones included. Only the class itself and the classes
 *  extending it are assignable to it — no table literal, no structurally
 *  identical class. Going the other way, a class satisfies a shape naming
 *  members it has (`{ Name: string }`) but is not a table: never a
 *  `{ [K]: V }` or `{}`, which is what keeps `typeof(part)` from matching the
 *  `{ [unknown]: unknown }` overload. */
export interface ClassInfo {
    name: string
    /** The class it directly extends, if any. */
    superclass?: string
    /** The class itself, then each class it extends, nearest first. */
    ancestors: readonly string[]
    /** For a generic class, the arguments each level of the chain was made
     *  with, by class name — its own and every class it extends. `Box<number>`
     *  holds `{ Box: [number] }`, and a `class Ints extends Box<number>` holds
     *  the same entry under `Box`, which is what tells it apart from a
     *  `Box<string>`. A class with no type parameters anywhere carries
     *  nothing, and costs nothing. */
    typeArguments?: ReadonlyMap<string, readonly Type[]>
    /** A `class` the program writes, whose instances are Lua tables — as
     *  opposed to a `declare class`, a value the host made (a Roblox
     *  `Instance`, a `Vector3`), which knows how to print itself. */
    runtime?: boolean
}

export function isClassType(t: Type): t is ObjectType & { class: ClassInfo } {
    return t.kind === "object" && t.class !== undefined
}

/** Is a class instance one of `want`? It has to *be* that class or extend it,
 *  and where `want` was made with type arguments they have to fit: a
 *  `Box<string>` is not a `Box<number>`, and neither is a class extending
 *  `Box<string>`. A class the caller left uninstantiated says nothing, and is
 *  let through. */
function isClassAssignable(got: ClassInfo | undefined, want: ClassInfo): boolean {
    if (!got || !got.ancestors.includes(want.name)) return false
    const wanted = want.typeArguments?.get(want.name)
    if (!wanted?.length) return true
    const given = got.typeArguments?.get(want.name)
    if (!given) return true
    return wanted.every((w, i) => given[i] !== undefined && isAssignable(given[i], w))
}

export interface FunctionParam { name?: string; type: Type; optional?: boolean }

/** A TS-style type guard: `function f(v: unknown): v is string` narrows `v` at
 *  every call site used as a condition. `asserts` variants narrow the *rest of
 *  the enclosing block* instead of a branch (`assert(x)`), and a missing `type`
 *  means a bare truthiness assertion (`asserts v`). */
export interface TypePredicate {
    /** Index into `params` of the parameter this guard talks about. */
    param: number
    /** The type the parameter is narrowed to; absent = narrow to truthy. */
    type?: Type
    asserts: boolean
    /** `implies v is T`: only a true answer narrows. `includes` is one —
     *  a value not in the list may still be of the list's type. */
    implies?: boolean
}

export interface FunctionType {
    kind: "function"
    params: FunctionParam[]
    /** The type of each argument a rest parameter (`...args: T[]`) collects —
     *  or, with `restIsWhole`, the rest parameter's own type. */
    varargs?: Type
    /** `...args: A` where `A` is a tuple, or a type parameter standing for
     *  one (`<A extends unknown[]>`): `varargs` is `A` itself, and once `A`
     *  is known its elements are the parameters. */
    restIsWhole?: boolean
    /** What the function returns: one value — several are an array. */
    returns: Type
    /** Names of the function's own generic parameters (`function f<T>(...)`).
     *  `params` / `returns` may contain `typeParam` nodes for these. */
    typeParams?: string[]
    /** `<T = Instance>` — what a call uses for a parameter it is not given and
     *  cannot infer. */
    typeParamDefaults?: Record<string, Type>
    /** Set when the function was declared with an `x is T` / `asserts x` return. */
    predicate?: TypePredicate
    alias?: string
}

/** A bound generic parameter (`T` inside `function f<T>(...)` or
 *  `type Box<T> = ...`). Resolved away by `substitute` at instantiation.
 *  `constraint` is the `<T extends C>` upper bound, used for member access on a
 *  bare `T` and as the fallback when `T` can't be inferred. */
export interface TypeParamType {
    kind: "typeParam"
    name: string
    constraint?: Type
    /** Declared `<const T>`: the call site infers the argument at its
     *  narrowest rather than widening it. */
    isConst?: boolean
    /** Written inside `NoInfer<...>`: an argument there is checked against
     *  the parameter, never read to work out what it is. */
    noInfer?: boolean
}
export function typeParam(name: string, constraint?: Type, isConst?: boolean): TypeParamType {
    return { kind: "typeParam", name, constraint, isConst }
}

export interface UnionType { kind: "union"; types: Type[]; alias?: string }
export interface IntersectionType {
    kind: "intersection"
    types: Type[]
    /** The alias this was resolved from — display only, exactly like
     *  `ObjectType.name`. A class hierarchy written as `type Part = BasePart &
     *  { ... }` is unreadable without it. */
    name?: string
    /** As `ObjectType.nameRef`. */
    nameRef?: GenericRefType
}

/** An unresolved reference: an in-scope generic parameter, or a named type
 *  that couldn't be resolved to an alias in this pass. */
export interface GenericRefType {
    kind: "genericRef"
    name: string
    typeArguments: Type[]
    /** The module whose alias this names. A recursive alias is left as a ref
     *  inside its own structure, and that ref travels with the type into every
     *  module that imports it — where `name` may mean nothing, or a different
     *  type. Expanding through `origin` reads the name where it was written. */
    origin?: TypeOrigin
}

/** A module's own alias resolution, handed out on the refs it creates. */
export interface TypeOrigin {
    expand(t: GenericRefType): Type
    /** How the alias `name` compares by each of its parameters, where it
     *  says (`<out T>`, `<in T>`, `<in out T>`). */
    variances?(name: string): readonly (string | undefined)[] | undefined
}

// ------------------------------------------------------------
// Type-level operators
// ------------------------------------------------------------
// These five stay in the tree only while something they depend on is still an
// unresolved `typeParam`. `analyzeTypes.reduceType` collapses each one as soon
// as its inputs are concrete, so a fully applied `Partial<{ a: number }>` is an
// ordinary object type by the time anyone reads it.

/** `keyof T`. */
export interface KeyofType { kind: "keyof"; target: Type }

/** `T[K]`. */
export interface IndexedAccessType { kind: "indexedAccess"; objectType: Type; indexType: Type; alias?: string }

/** `C extends E ? A : B`. */
export interface ConditionalType {
    kind: "conditional"
    checkType: Type
    extendsType: Type
    trueType: Type
    falseType: Type
    /** Names bound by `infer` inside `extendsType`. */
    inferVars: string[]
    /** Set when `checkType` is a *naked* type parameter, to that parameter's
     *  name. Such a conditional distributes over a union, and inside each
     *  branch the parameter denotes the single member being tested — the
     *  property `Exclude<T, U>` relies on. */
    distributeParam?: string
    alias?: string
}

/** `infer U`, valid only inside a conditional's `extends` clause. */
export interface InferType {
    kind: "infer"
    name: string
    /** `infer N extends number` — see `InferTypeNode.constraint`. */
    constraint?: Type
}

/** `Exclude<A, B>` — every value of `A` that is not a `B`.
 *
 *  Only kept when `A` is *opaque*: `unknown`, `any`, or a type parameter or
 *  nominal reference not yet resolved. For a union the subtraction is
 *  performed by dropping members, and for a concrete type such as `string` it
 *  is discarded (`Exclude<string, "a">` supports exactly the same operations
 *  as `string`). For `unknown`, though, the subtraction is the *only* thing
 *  known about the value, so throwing it away — as TypeScript's `Exclude`
 *  does — loses the whole result of the test:
 *
 *      let a: unknown
 *      if (a == 1) {   -- a: 1
 *      } else {        -- a: Exclude<unknown, 1>
 *      }
 */
export interface DifferenceType { kind: "difference"; base: Type; excluded: Type }

/** `` `on${string}` `` — literal chunks interleaved with interpolated types
 *  (`quasis.length === types.length + 1`). Reduced to a union of string
 *  literals when every interpolation is one; otherwise it stays a *pattern*
 *  and `isAssignable` matches literal strings against it. */
export interface TemplateLiteralType {
    kind: "templateLiteral"
    quasis: string[]
    types: Type[]
    alias?: string
}

// ------------------------------------------------------------
// The alias a type was written as
// ------------------------------------------------------------
// `type Id = number` resolves to `number`, and what is lost is the only thing
// the reader was told: that this number is an `Id`. So the name travels with
// the type — display only, the way `ObjectType.name` already did for
// `type Row = { ... }`. Nothing about assignability changes: an `Id` *is* a
// number, structurally and in both directions.
//
// Objects and intersections keep using their own `name` field, which predates
// this and carries class information alongside; everything else uses `alias`.
// `aliasNameOf` is the one place that knows which is which.

/** Kinds that can carry an alias name. Of the type-level operators, only
 *  the ones a generic alias is written as: still waiting on a type parameter
 *  they are read in signatures, where `Reverse<T>` says what the expansion
 *  does not. Filling the parameter in (`substitute`) drops the name, which
 *  then no longer says what the type is. */
const ALIASABLE: ReadonlySet<Type["kind"]> = new Set<Type["kind"]>([
    "any", "unknown", "never", "primitive", "literal",
    "array", "tuple", "function", "union", "templateLiteral",
    "conditional", "mapped", "indexedAccess",
])

/** The alias `type` is printed as instead of its structure, if it has one. */
export function aliasNameOf(type: Type): string | undefined {
    if (isClassType(type)) return undefined
    if (type.kind === "object" || type.kind === "intersection") return type.name
    return ALIASABLE.has(type.kind) ? (type as { alias?: string }).alias : undefined
}

/** The same type, printed as what it is made of. */
export function withoutAliasName(type: Type): Type {
    if (aliasNameOf(type) === undefined) return type
    if (type.kind === "object") {
        const out = objectType(type.properties, type.indexer, type.frozen)
        return type.class ? Object.assign(out, { class: type.class, name: type.name }) : out
    }
    if (type.kind === "intersection") return { ...type, name: undefined, nameRef: undefined }
    // `ALIASABLE` has already said this kind carries the field; the cast is
    // only because a `Set` membership test narrows nothing for TypeScript.
    return { ...(type as Type & { alias?: string }), alias: undefined } as Type
}

/** `type` remembered as the alias it was written as. A type that already
 *  carries one keeps it: the name nearest what the reader wrote wins. */
export function withAliasName(type: Type, alias: string, ref?: GenericRefType): Type {
    if (isClassType(type)) return type
    if (type.kind === "object" || type.kind === "intersection") {
        if (type.name !== undefined) return type
        return ref ? { ...type, name: alias, nameRef: ref } : { ...type, name: alias }
    }
    if (!ALIASABLE.has(type.kind)) return type
    return (type as { alias?: string }).alias === undefined
        ? { ...(type as Type & { alias?: string }), alias } as Type
        : type
}

/** `{ [K in C]: V }`. `optional` / `readonly`: `true` adds the modifier,
 *  `false` strips it, `undefined` inherits it from the source property. */
export interface MappedType {
    kind: "mapped"
    parameter: string
    constraint: Type
    nameType?: Type
    template: Type
    optional?: boolean
    readonly?: boolean
    /** The `T` of `[K in keyof T]`, kept so a homomorphic mapped type can carry
     *  each source property's own `?` / `readonly` across. */
    source?: Type
    alias?: string
}

// ============================================================
// Constructors / well-known singletons
// ============================================================

export const anyType: AnyType = { kind: "any" }
export const unknownType: UnknownType = { kind: "unknown" }
export const declaredUnknownType: UnknownType = { kind: "unknown", declared: true }
export const neverType: NeverType = { kind: "never" }
export const nilType: PrimitiveType = { kind: "primitive", name: "nil" }
/** What a function gives back when it gives nothing worth reading —
 *  TypeScript's `void`. As a value it is `nil`; as what a function type
 *  returns it takes a function that returns anything, whose answer nobody
 *  reads: `() => task.defer(f)` goes where `() => void` is wanted. */
export const voidType: PrimitiveType = { kind: "primitive", name: "void" }

export function isVoid(t: Type): boolean {
    return t.kind === "primitive" && t.name === "void"
}
export const booleanType: PrimitiveType = { kind: "primitive", name: "boolean" }
export const numberType: PrimitiveType = { kind: "primitive", name: "number" }
export const stringType: PrimitiveType = { kind: "primitive", name: "string" }
export const threadType: PrimitiveType = { kind: "primitive", name: "thread" }
export const bufferType: PrimitiveType = { kind: "primitive", name: "buffer" }
export const objectKeywordType: PrimitiveType = { kind: "primitive", name: "object" }

export function primitive(name: PrimitiveName): PrimitiveType {
    return { kind: "primitive", name }
}

export function literal(value: string | number | boolean): LiteralType {
    const base = typeof value === "string" ? "string" : typeof value === "number" ? "number" : "boolean"
    return { kind: "literal", base, value }
}

export function arrayOf(element: Type): ArrayType {
    return { kind: "array", element }
}

export function tuple(elements: Type[], rest?: Type): TupleType {
    if (elements.some(e => e.kind === "spread")) return layOutTuple(elements, rest)
    return rest ? { kind: "tuple", elements, rest } : { kind: "tuple", elements }
}

/** `[A, ...S, B]` with each spread laid out as far as it is known: a tuple's
 *  elements take its place, and an array — or a tuple's own rest — makes
 *  everything from there on the rest, since how many come before what was
 *  written after it is no longer fixed. A spread of something not known yet
 *  stays where it is. */
function layOutTuple(written: readonly Type[], writtenRest: Type | undefined): TupleType {
    const elements: Type[] = []
    let rest: Type[] | undefined
    const place = (t: Type): void => {
        if (rest) rest.push(t)
        else elements.push(t)
    }
    /** Does a fixed element follow position `i`? Then a list of any length
     *  spread at `i` stays where it is — `[...number[], string]` ends in a
     *  string — rather than making the rest of the tuple its own. */
    const fixedAfter = (i: number): boolean => written.slice(i + 1).some(x =>
        x.kind !== "spread" || (x.type.kind === "tuple" && x.type.elements.length > 0))
    for (const [i, e] of written.entries()) {
        if (e.kind !== "spread") { place(e); continue }
        const inner = e.type
        if (inner.kind === "array" && !rest && fixedAfter(i)) {
            elements.push(e)
            continue
        }
        if (inner.kind === "tuple") {
            for (const x of inner.elements) place(x)
            if (inner.rest) (rest ??= []).push(inner.rest)
        } else if (inner.kind === "array") {
            (rest ??= []).push(inner.element)
        } else if (inner.kind === "never") {
            // `...never` spreads nothing.
        } else if (inner.kind === "any" || inner.kind === "unknown") {
            (rest ??= []).push(inner)
        } else if (inner.kind === "union" && inner.types.every(m => m.kind === "tuple" || m.kind === "array")) {
            // A spread of one of several lists: what it holds, as a rest.
            (rest ??= []).push(union(inner.types.flatMap(m => m.kind === "tuple" ? tupleMembers(m) : [(m as ArrayType).element])))
        } else if (rest) {
            rest.push(e)
        } else {
            elements.push(e)
        }
    }
    if (writtenRest) (rest ??= []).push(writtenRest)
    // A spread still waiting inside the rest is only ever read as what it
    // holds: its elements' union is the most that can be said.
    const restType = rest && union(rest.map(r => r.kind === "spread" ? spreadMembers(r.type) : r))
    return restType ? { kind: "tuple", elements, rest: restType } : { kind: "tuple", elements }
}

/** What a spread of `t` puts in a list, as one type. */
function spreadMembers(t: Type): Type {
    if (t.kind === "tuple") return union(tupleMembers(t))
    if (t.kind === "array") return t.element
    if (t.kind === "typeParam" && t.constraint) return spreadMembers(t.constraint)
    return unknownType
}

/** Does this tuple still have a spread to lay out? */
export function hasSpread(t: TupleType): boolean {
    return t.elements.some(e => e.kind === "spread")
}

/** Every element type a tuple can hold, the rest's included. */
export function tupleMembers(t: TupleType): Type[] {
    return t.rest ? [...t.elements, t.rest] : t.elements
}

export function objectType(
    entries: Iterable<[string, ObjectProperty]>,
    indexer?: ObjectType["indexer"],
    frozen?: boolean,
): ObjectType {
    return { kind: "object", properties: new Map(entries), indexer, frozen }
}

export function fn(
    params: FunctionParam[],
    returns: Type,
    varargs?: Type,
    typeParams?: string[],
    predicate?: TypePredicate,
): FunctionType {
    return {
        kind: "function", params, varargs, returns,
        typeParams: typeParams?.length ? typeParams : undefined,
        predicate,
    }
}

// ============================================================
// substitution — resolve typeParam nodes against a bindings map
// ============================================================

export function substitute(t: Type, subst: Map<string, Type>): Type {
    if (subst.size === 0) return t
    // Nothing to replace: return the type as it stands rather than deep-copying
    // it. Without this, instantiating a generic over a large type (a class map,
    // say) rebuilds that whole type at every mention.
    if (!containsTypeParam(t) && !(subst.has(THIS_TYPE) && mentionsThis(t))) return t
    switch (t.kind) {
        case "typeParam": {
            const bound = subst.get(t.name)
            if (bound) return bound
            // `<S extends T>` inside a signature whose `T` is now known: the
            // parameter stays, bounded by what `T` became. A mention of itself
            // in its own bound (`S extends Box<S>`) is left as it was.
            if (t.constraint && containsTypeParam(t.constraint)) {
                return { ...t, constraint: substitute(t.constraint, new Map([...subst, [t.name, t]])) }
            }
            return t
        }
        case "array":
            return { ...arrayOf(substitute(t.element, subst)), readonly: t.readonly }
        case "spread":
            return spread(substitute(t.type, subst))
        case "tuple":
            return tupleMeta(tuple(t.elements.map(e => substitute(e, subst)), t.rest && substitute(t.rest, subst)), t)
        case "object": {
            const entries: [string, ObjectProperty][] = []
            for (const [k, v] of t.properties) entries.push([k, { ...v, type: substitute(v.type, subst) }])
            const out = objectType(
                entries,
                t.indexer && { key: substitute(t.indexer.key, subst), value: substitute(t.indexer.value, subst) },
                t.frozen,
            )
            // An instantiated class is still that class: `Box<number>` and
            // `Box<string>` are both `Box`, and only their arguments differ.
            // A generic alias's name says its arguments, filled in with them.
            if (t.nameRef) {
                out.nameRef = substitute(t.nameRef, subst) as GenericRefType
                out.name = formatType(out.nameRef)
            } else if (t.name) out.name = t.name
            if (t.class) {
                out.class = {
                    ...t.class,
                    typeArguments: t.class.typeArguments && new Map(
                        [...t.class.typeArguments].map(([name, args]) =>
                            [name, args.map(a => substitute(a, subst))])),
                }
            }
            return out
        }
        case "function": {
            // Don't substitute a function's own generic params (they shadow).
            const inner = t.typeParams
                ? new Map([...subst].filter(([k]) => !t.typeParams!.includes(k)))
                : subst
            let params = t.params.map(p => ({ ...p, type: substitute(p.type, inner) }))
            let varargs = t.varargs && substitute(t.varargs, inner)
            let restIsWhole = t.restIsWhole
            // `(...args: A) => R` with `A` now known: a tuple's elements are
            // the parameters, and its rest (or an array's element) is what
            // the rest parameter still collects.
            if (restIsWhole && varargs?.kind === "tuple") {
                params = [...params, ...tupleParams(varargs)]
                varargs = varargs.rest
                restIsWhole = undefined
            } else if (restIsWhole && varargs?.kind === "array") {
                varargs = varargs.element
                restIsWhole = undefined
            }
            return {
                kind: "function",
                params,
                varargs,
                ...(restIsWhole ? { restIsWhole } : {}),
                returns: substitute(t.returns, inner),
                typeParams: t.typeParams,
                typeParamDefaults: t.typeParamDefaults,
                predicate: t.predicate && {
                    ...t.predicate,
                    type: t.predicate.type && substitute(t.predicate.type, inner),
                },
            }
        }
        case "union":
            return union(t.types.map(x => substitute(x, subst)))
        case "intersection": {
            const r = intersection(t.types.map(x => substitute(x, subst)))
            if (!t.name || r.kind !== "intersection" || r.name) return r
            if (!t.nameRef) return { ...r, name: t.name }
            const nameRef = substitute(t.nameRef, subst) as GenericRefType
            return { ...r, name: formatType(nameRef), nameRef }
        }
        case "genericRef":
            return {
                kind: "genericRef",
                name: t.name,
                typeArguments: t.typeArguments.map(a => substitute(a, subst)),
                ...(t.origin ? { origin: t.origin } : {}),
            }
        case "keyof":
            return { kind: "keyof", target: substitute(t.target, subst) }
        case "templateLiteral":
            return { kind: "templateLiteral", quasis: t.quasis, types: t.types.map(x => substitute(x, subst)) }
        case "difference":
            return difference(substitute(t.base, subst), substitute(t.excluded, subst))
        case "indexedAccess":
            return {
                kind: "indexedAccess",
                objectType: substitute(t.objectType, subst),
                indexType: substitute(t.indexType, subst),
            }
        case "conditional": {
            // In a distributive conditional the check parameter is rebound per
            // union member at reduction time, so it must survive substitution
            // inside the branches — otherwise `T extends U ? never : T` would
            // yield the whole union instead of the member under test.
            const branch = t.distributeParam
                ? new Map([...subst].filter(([k]) => k !== t.distributeParam))
                : subst
            return {
                ...t,
                alias: undefined,
                checkType: substitute(t.checkType, subst),
                extendsType: substitute(t.extendsType, subst),
                trueType: substitute(t.trueType, branch),
                falseType: substitute(t.falseType, branch),
            }
        }
        case "mapped": {
            // The mapped parameter shadows an outer binding of the same name.
            const inner = new Map([...subst].filter(([k]) => k !== t.parameter))
            // A homomorphic mapped type over a *naked* type parameter
            // distributes over a union argument, as in TypeScript:
            // `Partial<A | B>` is `Partial<A> | Partial<B>`. Written over a
            // concrete union (`{ [K in keyof (A | B)]: ... }`) it maps the keys
            // the members share instead, so only this case distributes.
            const bound = t.source?.kind === "typeParam" ? subst.get(t.source.name) : undefined
            if (bound?.kind === "union") {
                const name = (t.source as TypeParamType).name
                return union(bound.types.map(member =>
                    substitute(t, new Map([...subst, [name, member]]))))
            }
            return {
                ...t,
                alias: undefined,
                constraint: substitute(t.constraint, subst),
                nameType: t.nameType && substitute(t.nameType, inner),
                template: substitute(t.template, inner),
                source: t.source && substitute(t.source, subst),
            }
        }
        default:
            return t
    }
}

/** Infer generic bindings by structurally matching a (possibly generic)
 *  `param` type against a concrete `arg` type. Accumulates into `out`. */
/** The arguments `t` was made with for the class `name` — read off the
 *  reference it was written as, or off the class it stands for. `Box<number>`
 *  answers `[number]` either way, and so does a class extending it. */
function classArguments(t: Type, name: string): readonly Type[] | undefined {
    if (t.kind === "genericRef") return t.name === name ? t.typeArguments : undefined
    if (t.kind === "object") return t.class?.typeArguments?.get(name)
    return undefined
}

/** How a type parameter takes a second candidate, at the top of a
 *  parameter. Below it — a list's elements, a tuple's places — every
 *  candidate is the same site and they gather, whichever mode was asked for. Arguments collected by
 *  one `...rest: T[]` are all of them equally, so `firstOf(1, "a")` reads
 *  `T` as their union. Two parameters written separately are not: the one
 *  written first says what `T` is, and an argument that disagrees with it is
 *  a mistake to report rather than a reason to widen. */
export type Unification = "union" | "first"

export function unify(param: Type, arg: Type, vars: Set<string>, out: Map<string, Type>, how: Unification = "union"): void {
    if (param.kind === "typeParam" && param.noInfer) return
    if (param.kind === "typeParam" && param.constraint && !vars.has(param.name)) {
        unify(param.constraint, arg, vars, out, how)
        return
    }
    if (param.kind === "typeParam" && vars.has(param.name)) {
        const prev = out.get(param.name)
        if (!prev) out.set(param.name, arg)
        else if (isAssignable(arg, prev)) { /* what it already is covers this one */ }
        else if (isAssignable(prev, arg)) out.set(param.name, arg)
        else if (how === "union" || sameLiteralBase(prev, arg)) out.set(param.name, union([prev, arg]))
        return
    }
    if (arg.kind === "any" || arg.kind === "never") return
    switch (param.kind) {
        case "array":
            if (arg.kind === "array") unify(param.element, arg.element, vars, out)
            else if (arg.kind === "tuple") for (const e of tupleMembers(arg)) unify(param.element, e, vars, out)
            return
        case "tuple":
            if (hasSpread(param)) {
                unifyVariadic(param, arg, vars, out, how)
                return
            }
            if (arg.kind === "tuple") {
                param.elements.forEach((p, i) => {
                    const a = arg.elements[i] ?? arg.rest
                    if (a) unify(p, a, vars, out)
                })
                if (param.rest) for (const a of arg.elements.slice(param.elements.length)) unify(param.rest, a, vars, out)
                if (param.rest && arg.rest) unify(param.rest, arg.rest, vars, out)
            } else if (arg.kind === "array") {
                for (const p of tupleMembers(param)) unify(p, arg.element, vars, out)
            }
            return
        case "function":
            if (arg.kind === "function") {
                param.params.forEach((p, i) => arg.params[i] && unify(p.type, arg.params[i].type, vars, out))
                // `(...args: [...A, ...B]) => R` given `(a: number, b: string)
                // => R`: the parameters from there on are the list.
                if (param.restIsWhole && param.varargs) {
                    const rest = arg.restIsWhole && arg.varargs && !arg.params.length
                        ? arg.varargs
                        : paramsAsTuple(arg.params.slice(param.params.length),
                            arg.varargs && !arg.restIsWhole ? arg.varargs : undefined)
                    unify(param.varargs, rest, vars, out)
                }
                unify(param.returns, arg.returns, vars, out)
                // `(v: T) => v is S` given `v => v ~= nil`: what the guard
                // narrows to is `S`.
                const wanted = param.predicate, given = arg.predicate
                if (wanted?.type && given?.type && wanted.param === given.param && !wanted.asserts && !given.asserts) {
                    unify(wanted.type, given.type, vars, out)
                }
            }
            return
        case "object":
            // A class binds only through its type arguments — `f(box)` against
            // `Box<T>` reads `T` off the argument's own `Box` entry. Its
            // members refer back to the class itself, so walking those would
            // never end, and a class argument does not match a table shape.
            if (param.class) {
                const wanted = param.class.typeArguments?.get(param.class.name)
                const given = classArguments(arg, param.class.name)
                if (wanted && given) wanted.forEach((w, i) => given[i] && unify(w, given[i], vars, out))
                return
            }
            if (arg.kind === "object" && !arg.class) {
                for (const [k, pv] of param.properties) {
                    const av = arg.properties.get(k)
                    if (av) unify(pv.type, av.type, vars, out)
                }
                if (param.indexer && arg.indexer) unify(param.indexer.value, arg.indexer.value, vars, out)
            }
            return
        case "genericRef": {
            // `f(b: Box<T>)` given a `Box<number>`: the argument says what `T`
            // is, whether it arrives as the reference it was written as or as
            // the class it stands for.
            const given = classArguments(arg, param.name)
            if (given) param.typeArguments.forEach((p, i) => given[i] && unify(p, given[i], vars, out))
            return
        }
        case "union": {
            // \`T | nil\` given \`number | nil\`: what the written members already
            // take is theirs, and \`T\` is the rest — \`number\`, as TypeScript
            // reads it.
            const bare = param.types.filter(m => m.kind === "typeParam" && vars.has(m.name))
            const fixed = param.types.filter(m => !containsTypeParam(m))
            if (bare.length === 1 && fixed.length + 1 === param.types.length) {
                const given = arg.kind === "union" ? arg.types : [arg]
                const left = given.filter(m => !fixed.some(f => isAssignable(m, f)))
                if (left.length) unify(bare[0], union(left), vars, out, how)
                return
            }
            // Best effort: match against each member that carries a var.
            for (const m of param.types) unify(m, arg, vars, out)
            return
        }
    }
}

/** A parameter written as a tuple with a spread — `[...T]`, `[A, ...T, Z]`,
 *  `[...A, ...B]` — against the list it is given. The places written around
 *  the spreads take the elements at the same places, from the front and from
 *  the back; what is left between them goes to the spreads in order. A spread
 *  whose parameter is already known to be a tuple takes that many; the first
 *  one not known takes whatever the known ones leave, and any later one
 *  nothing — `[...A, ...B]` given a list it cannot otherwise split. */
function unifyVariadic(param: TupleType, arg: Type, vars: Set<string>, out: Map<string, Type>, how: Unification): void {
    const first = param.elements.findIndex(e => e.kind === "spread")
    let last = first
    param.elements.forEach((e, i) => { if (e.kind === "spread") last = i })
    const head = param.elements.slice(0, first)
    const tail = param.elements.slice(last + 1)
    const between = param.elements.slice(first, last + 1)
    if (arg.kind === "array") {
        for (const p of [...head, ...tail]) unify(p, arg.element, vars, out)
        for (const s of between) unify(s.kind === "spread" ? s.type : s, s.kind === "spread" ? arg : arg.element, vars, out, how)
        return
    }
    if (arg.kind !== "tuple") return
    head.forEach((p, i) => {
        const a = arg.elements[i] ?? arg.rest
        if (a) unify(p, a, vars, out)
    })
    const end = Math.max(head.length, arg.elements.length - (arg.rest ? 0 : tail.length))
    tail.forEach((p, i) => {
        const a = arg.rest ? arg.rest : arg.elements[end + i]
        if (a) unify(p, a, vars, out)
    })
    const middle = arg.elements.slice(head.length, end)
    // How many each spread is already known to take.
    const known = between.map(s => {
        if (s.kind !== "spread") return 1
        const bound = s.type.kind === "typeParam" && vars.has(s.type.name) ? out.get(s.type.name) : undefined
        return bound?.kind === "tuple" && !bound.rest && !hasSpread(bound) ? bound.elements.length : undefined
    })
    let free = Math.max(0, middle.length - known.reduce<number>((n, k) => n + (k ?? 0), 0))
    let at = 0
    between.forEach((s, i) => {
        const count = known[i] ?? free
        if (known[i] === undefined) free = 0
        const from = head.length + at
        const taken = middle.slice(at, at + count)
        at += count
        if (s.kind !== "spread") {
            if (taken[0]) unify(s, taken[0], vars, out)
            return
        }
        // The places keep their names, and whether they may be left out.
        const made = tuple(taken, at >= middle.length ? arg.rest : undefined)
        const names = arg.names?.slice(from, from + taken.length)
        const required = Math.max(0, minLengthOf(arg) - from)
        unify(s.type, {
            ...made,
            ...(names?.some(n => n) ? { names } : {}),
            ...(required < taken.length ? { minLength: required } : {}),
        }, vars, out, how)
    })
}

// ============================================================
// union / intersection (flattening + light simplification)
// ============================================================

/** What two members must share to be one member. A literal or a primitive
 *  says it in a few characters; anything larger is told apart by how it
 *  prints, which is the same answer `equalTypes` gives. Printing a class out
 *  of a Roblox library is not cheap, and forming a union is one of the things
 *  the analyzer does most, so the short answers are worth taking first. */
function memberKey(t: Type): string {
    switch (t.kind) {
        case "literal": return `l${t.base}:${String(t.value)}`
        case "primitive": return `p${t.name}`
        case "any": case "unknown": case "never": return t.kind
        default: return formatType(t)
    }
}

export function union(types: Type[]): Type {
    const deduped = (list: Type[]): Type[] => {
        const flat: Type[] = []
        for (const t of list) {
            if (t.kind === "union") flat.push(...t.types)
            else flat.push(t)
        }
        // drop `never`, dedupe by structural key
        const seen = new Map<string, Type>()
        for (const t of flat) {
            if (t.kind === "never") continue
            const key = memberKey(t)
            if (!seen.has(key)) seen.set(key, t)
        }
        return [...seen.values()]
    }
    const parts = deduped(mergeDifferences(deduped(types)))
    // `any` and `unknown` are both absorbing: everything is assignable to
    // them, so a union with either is just that type. `any` wins over
    // `unknown`, matching TypeScript.
    if (parts.some(t => t.kind === "any")) return anyType
    if (parts.some(t => t.kind === "unknown")) return unknownType
    let members = reduceSubtypes(parts)
    if (members.length === 0) return neverType
    if (members.length === 1) return members[0]
    return { kind: "union", types: members }
}

/** What was taken out of a difference, put back: `Exclude<X, 1 | 2> | 2` is
 *  `Exclude<X, 1>`, and `Exclude<unknown, number> | Exclude<number, 1>` is
 *  `Exclude<unknown, 1>`. Narrowing a value and merging the branches back
 *  together makes exactly these: without this, `if (a == 2) { }` inside
 *  `if (a ~= 1)` left `a` as `Exclude<unknown, 1 | 2> | 2` after it, where
 *  `Exclude<unknown, 1>` is meant — and once every part is back, the base
 *  itself. */
function mergeDifferences(members: Type[]): Type[] {
    for (let i = 0; i < members.length; i++) {
        const taken = members[i]
        if (taken.kind !== "difference") continue
        const excluded = taken.excluded.kind === "union" ? taken.excluded.types : [taken.excluded]
        for (let j = 0; j < members.length; j++) {
            const back = members[j]
            if (i === j) continue
            // What it puts back: a member of what was taken out, whole — or
            // all of one but what it takes out in turn.
            const whole = back.kind === "difference" ? back.base : back
            const at = excluded.findIndex(e => memberKey(e) === memberKey(whole))
            if (at < 0) continue
            const still = [
                ...excluded.filter((_, k) => k !== at),
                ...(back.kind === "difference" ? [back.excluded] : []),
            ]
            const merged = still.length ? difference(taken.base, union(still)) : taken.base
            const rest = members.filter((_, k) => k !== i && k !== j)
            return mergeDifferences([merged, ...rest])
        }
    }
    return members
}

/** Subtype reduction, as TypeScript performs when forming a union: a literal
 *  member is redundant next to its own primitive (`"a" | string` is `string`),
 *  and `true | false` is exactly `boolean`. Without this, narrowing a value and
 *  merging the branches back together leaves noise like `true | false` where
 *  the original `boolean` is meant. */
function reduceSubtypes(members: Type[]): Type[] {
    const primitives = new Set(
        members.filter((t): t is PrimitiveType => t.kind === "primitive").map(t => t.name),
    )
    // `true` and `false` together re-form `boolean`.
    const bools = members.filter(t => t.kind === "literal" && t.base === "boolean")
    if (!primitives.has("boolean") && bools.length === 2) {
        members = [booleanType, ...members.filter(t => !bools.includes(t))]
        primitives.add("boolean")
    }
    if (!primitives.size) return members
    return members.filter(t => !(t.kind === "literal" && primitives.has(t.base)))
}

export function intersection(types: Type[]): Type {
    const flat: Type[] = []
    for (const t of types) {
        // A *named* intersection stays one member: it is an alias the reader
        // knows by name (`type Part = BasePart & { ... }`), and flattening it
        // would discard that name and print the whole expansion instead.
        // Nesting costs nothing — `isAssignable` and `propertyType` both
        // recurse through intersection members.
        if (t.kind === "intersection" && !t.name) flat.push(...t.types)
        else flat.push(t)
    }
    // `any` takes everything in, as in a union — but nothing is still nothing.
    if (flat.some(t => t.kind === "never")) return neverType
    if (flat.some(t => t.kind === "any")) return anyType
    // `("a" | "b" | 1) & string` is `"a" | "b"`: a union of plain values meets
    // the rest one member at a time. Only plain values — distributing a union
    // of objects would multiply it out for nothing.
    const scalar = (m: Type): boolean => m.kind === "literal" || (m.kind === "primitive" && m.name !== "object")
    const at = flat.findIndex(m => m.kind === "union" && m.types.every(scalar))
    if (at >= 0 && flat.some((m, i) => i !== at && scalar(m))) {
        const others = flat.filter((_, i) => i !== at)
        return union((flat[at] as UnionType).types.map(m => intersection([m, ...others])))
    }
    // `{}` beside another table shape adds nothing to it: `{ a: 1 } & {}` is
    // `{ a: 1 }`. Beside a string it is a brand, and stays.
    const empty = (t: Type): boolean => t.kind === "object" && !t.properties.size && !t.indexer && !t.class && !t.name
    const dropEmpty = flat.some(t => t.kind === "object" && !empty(t))
    const seen = new Map<string, Type>()
    for (const t of flat) {
        if (t.kind === "unknown" || (dropEmpty && empty(t))) continue
        seen.set(memberKey(t), t)
    }
    const members = simplifyIntersection([...seen.values()])
    if (members.length === 0) return unknownType
    if (members.length === 1) return members[0]
    return { kind: "intersection", types: members }
}

/** What an intersection of plain values comes to: `"a" & string` is `"a"`,
 *  and `"a" & "b"` or `string & number` is nothing at all — the step that
 *  makes `K & string` usable as a key. Objects and everything else are left
 *  to intersect as they are. */
function simplifyIntersection(members: Type[]): Type[] {
    const scalars = members.filter((m): m is PrimitiveType | LiteralType =>
        (m.kind === "primitive" && m.name !== "object") || m.kind === "literal")
    if (scalars.length < 2 && !members.some(m => m.kind === "never")) return members
    if (members.some(m => m.kind === "never")) return [neverType]
    // A literal says the most; every other scalar must agree with it.
    const lit = scalars.find((m): m is LiteralType => m.kind === "literal")
    const baseOf = (m: PrimitiveType | LiteralType): string => m.kind === "literal" ? m.base : m.name
    if (lit) {
        const agrees = scalars.every(m => m.kind === "literal" ? m.value === lit.value : m.name === lit.base)
        if (!agrees) return [neverType]
    } else if (new Set(scalars.map(baseOf)).size > 1) {
        return [neverType]
    }
    const keep = lit ?? scalars[0]
    return members.filter(m => !scalars.includes(m as PrimitiveType) || m === keep)
}

/** `Exclude<base, excluded>`, simplified as far as the base allows. */
export function difference(base: Type, excluded: Type): Type {
    if (excluded.kind === "never" || base.kind === "never") return base
    // A union subtracts exactly, member by member — and a member the
    // subtraction only takes some of keeps it: `Exclude<string | number, "a">`
    // is `Exclude<string, "a"> | number`.
    if (base.kind === "union") {
        return union(base.types.filter(m => !isAssignable(m, excluded)).map(m => difference(m, excluded)))
    }
    // `boolean` is `true | false`, and subtracts as that union does.
    if (base.kind === "primitive" && base.name === "boolean" && overlaps(base, excluded)) {
        return difference({ kind: "union", types: [literal(true), literal(false)] }, excluded)
    }
    if (base.kind === "difference") {
        return difference(base.base, union([base.excluded, excluded]))
    }
    // `any` fits anything, and is anything: what was taken out of it is all
    // that is known, and stays.
    if (base.kind === "any") return { kind: "difference", base, excluded }
    if (isAssignable(base, excluded)) return neverType
    // Only an opaque base carries the subtraction; anything concrete would
    // gain nothing from remembering it. "Opaque" includes a type-level
    // operator that has not been evaluated yet — `keyof T` becomes a union
    // once `T` is known, and the subtraction has to survive until then, which
    // is what `Omit<T, K>` depends on.
    const deferred = base.kind === "keyof" || base.kind === "indexedAccess" ||
        base.kind === "conditional" || base.kind === "mapped" || base.kind === "templateLiteral"
    const opaque = base.kind === "unknown" || base.kind === "typeParam" ||
        base.kind === "genericRef" || deferred || containsTypeParam(base)
    // `Exclude<string, "a">` is a string that is not `"a"`: what lets
    // `if (s == "a")` be reported as a test that can never pass. Only the
    // literals it does take out are remembered.
    const literals = (excluded.kind === "union" ? excluded.types : [excluded])
        .filter(m => m.kind === "literal" && isAssignable(m, base))
    if (!opaque && base.kind === "primitive" && literals.length) {
        return { kind: "difference", base, excluded: union(literals) }
    }
    return opaque ? { kind: "difference", base, excluded } : base
}

/** A method's type with its receiver left out: what it takes after `this`
 *  (or a definitions file's `self`) — what `text.upper` is, the receiver
 *  being `text`. A guard on a later parameter moves with it. Anything else is
 *  returned as it is. */
export function withoutReceiver(t: Type): Type {
    if (t.kind === "intersection") return intersection(t.types.map(withoutReceiver))
    if (t.kind !== "function") return t
    const first = t.params[0]?.name
    if (first !== "this" && first !== "self") return t
    const predicate = t.predicate && t.predicate.param > 0 ? { ...t.predicate, param: t.predicate.param - 1 } : undefined
    return { ...t, params: t.params.slice(1), predicate }
}

/** `T | nil` — the type of an optional property or parameter. */
export function optional(t: Type): Type {
    return union([t, nilType])
}

// ============================================================
// widening — `as const` inverse: literal -> primitive
// ============================================================

/** Widens literal types to their primitive base (the default for a plain
 *  `local x = "foo"` binding, unless `as const` says otherwise). Recurses
 *  into arrays/tuples/objects/unions. */
/** `keep` names a value that is not to be widened, however far in: one read
 *  from somewhere rather than written as a literal (see `analyzeTypes`). */
export function widen(t: Type, keep?: (t: Type) => boolean): Type {
    if (keep?.(t)) return t
    // A type an alias names was written down, not inferred from a literal, so
    // there is nothing to widen — and widening into it would turn a declared
    // `Mode: "A" | "B"` into `string` and break the alias it came from.
    if (isAliasNamed(t)) return t
    switch (t.kind) {
        case "literal":
            return primitive(t.base)
        // A read-only list was frozen on purpose (`as const`), as a frozen
        // object was: what it holds stays as narrow as it was written.
        case "array":
            if (t.readonly) return t
            return arrayOf(widen(t.element, keep))
        case "tuple":
            if (t.readonly) return t
            return tupleMeta(tuple(t.elements.map(e => widen(e, keep)), t.rest && widen(t.rest, keep)), t)
        case "object": {
            if (t.frozen || t.class) return t
            const entries: [string, ObjectProperty][] = []
            for (const [k, v] of t.properties) entries.push([k, { ...v, type: widen(v.type, keep) }])
            const w = objectType(entries, t.indexer && { key: t.indexer.key, value: widen(t.indexer.value, keep) })
            if (t.name) w.name = t.name
            if (t.nameRef) w.nameRef = t.nameRef
            return w
        }
        case "union":
            return union(t.types.map(m => widen(m, keep)))
        case "difference":
            return difference(widen(t.base, keep), t.excluded)
        default:
            return t
    }
}

// ============================================================
// subtype check — `a` assignable to `b`?
// ------------------------------------------------------------
// Deliberately conservative: unknowns that can't be decided return `true`
// only where soundness clearly allows (any), `false` otherwise.
// ============================================================

/** Resolves a `genericRef` to the alias it names.
 *
 *  Structural comparison has to see through a nominal reference, and a
 *  recursive alias (`type Instance = { Parent: Instance | nil }` — or any
 *  class hierarchy) is *always* left as one somewhere. `analyzeTypes` installs
 *  its own resolver for the duration of a run; without one, refs compare
 *  nominally as before. */
let expandAlias: ((t: GenericRefType) => Type) | undefined

export function setAliasExpander(fn: ((t: GenericRefType) => Type) | undefined): ((t: GenericRefType) => Type) | undefined {
    const previous = expandAlias
    expandAlias = fn
    return previous
}

/** The most a type still waiting on a type parameter could turn out to be —
 *  `Extract<Rows, { Page: P }>["Skills"][number]` is at most every row's
 *  skills, whatever `P` is. Only the analyzer can work one out (it takes
 *  evaluating the parts), so it installs this for the duration of a run; as
 *  with `expandAlias`, without one nothing changes. */
let deferredBound: ((t: Type) => Type | undefined) | undefined

export function setDeferredBound(fn: ((t: Type) => Type | undefined) | undefined): ((t: Type) => Type | undefined) | undefined {
    const previous = deferredBound
    deferredBound = fn
    return previous
}

/** What a string or a list has under a name — its `length`, and the methods
 *  its metatable gives it — which only the analyzer knows; installed for
 *  the duration of a run, as `expandAlias` is. */
let builtinMember: ((t: Type, name: string) => Type | undefined) | undefined

export function setBuiltinMember(fn: ((t: Type, name: string) => Type | undefined) | undefined): ((t: Type, name: string) => Type | undefined) | undefined {
    const previous = builtinMember
    builtinMember = fn
    return previous
}

/** Is a string or a list one of a shape — `"abc"` a `{ length: number }`, as
 *  TypeScript has it? Each member the shape names has to be one the value
 *  answers to, of a type that fits. */
function builtinFitsShape(a: Type, b: ObjectType): boolean {
    if (!builtinMember || b.indexer || b.class) return false
    for (const [name, bp] of b.properties) {
        const held = builtinMember(a, name)
        if (!held) {
            if (bp.optional) continue
            return false
        }
        if (!isAssignable(held, withThis(bp.type, a))) return false
    }
    return true
}

/** Pairs currently being compared. Recursive types make `isAssignable` re-enter
 *  with the same pair; assuming success on re-entry is the standard
 *  coinductive reading ("assignable unless we can show otherwise") and is what
 *  lets two recursive class types compare at all. */
const comparing: Type[] = []

/** What `{ [K in keyof T]: U }` is while `T` is a type parameter that stands
 *  for a list: a list of `U`, as TypeScript reads it — what `xs:map(f)` of an
 *  `xs: T` with `T extends unknown[]` can be assigned to, looped over and
 *  asked the length of. The mapped type itself is kept, so that once `T` is
 *  known — a tuple, say — it maps that. `undefined` for any other. */
export function mappedList(t: MappedType): Type | undefined {
    if (t.nameType || t.source?.kind !== "typeParam") return undefined
    const constraint = t.source.constraint
    if (constraint?.kind !== "array" && constraint?.kind !== "tuple") return undefined
    const element = substitute(t.template, new Map([[t.parameter, numberType]]))
    const readonly = t.readonly ?? constraint.readonly
    const made = arrayOf(element)
    return readonly ? { ...made, readonly: true } : made
}

export function isAssignable(rawA: Type, rawB: Type): boolean {
    // `()` (the empty type pack, "returns nothing") and `nil` describe the
    // same observable value in Lua: reading the result of a call that returns
    // nothing yields nil. A function inferred `-> nil` therefore satisfies a
    // `-> ()` annotation, and the reverse.
    // `void` is `nil` as a value; only a function type's return reads it
    // otherwise (`isFunctionAssignable`).
    let a: Type = isNoValue(rawA) || isVoid(rawA) ? nilType : rawA
    let b: Type = isNoValue(rawB) || isVoid(rawB) ? nilType : rawB
    if (a === b) return true

    // See through nominal references before comparing structurally, but only
    // when the other side is not itself a ref of the same name (handled below).
    if (expandAlias) {
        if (a.kind === "genericRef" && b.kind !== "genericRef") a = expandAlias(a)
        else if (b.kind === "genericRef" && a.kind !== "genericRef") b = expandAlias(b)
        else if (a.kind === "genericRef" && b.kind === "genericRef" && !sameRefTarget(a, b)) {
            // Two different names can still be related — `Part` is an
            // `Instance` — so compare what they stand for. So can one name
            // from two modules, which may or may not be the same type.
            a = expandAlias(a)
            b = expandAlias(b)
        }
        if (a === b) return true
    }

    for (let i = 0; i < comparing.length; i += 2) {
        if (comparing[i] === a && comparing[i + 1] === b) return true
    }
    comparing.push(a, b)
    try {
        return isAssignableInner(a, b)
    } finally {
        comparing.length -= 2
    }
}

function isAssignableInner(a: Type, b: Type): boolean {
    if (a.kind === "any" || b.kind === "any") return true
    if (a.kind === "never") return true
    if (b.kind === "unknown") return true
    if (b.kind === "never") return false
    if (a.kind === "unknown") return false

    // Two mapped types over one source, keyed alike: the one fits the other
    // where what it maps each key to does.
    if (a.kind === "mapped" && b.kind === "mapped" && !a.nameType && !b.nameType &&
        a.source && b.source && formatType(a.source) === formatType(b.source) &&
        (a.readonly ?? false) === (b.readonly ?? false)) {
        const key: Type = { kind: "typeParam", name: a.parameter }
        return isAssignable(a.template, substitute(b.template, new Map([[b.parameter, key]])))
    }
    const listed = a.kind === "mapped" ? mappedList(a) : undefined
    if (listed) return isAssignable(listed, b)

    // One subtraction fits another when its base does and it already excludes
    // everything the target excludes — `Exclude<unknown, nil>` is itself, which the
    // rules below would deny (`unknown` overlaps `nil`).
    if (a.kind === "difference" && b.kind === "difference") {
        return isAssignable(a.base, b.base) && isAssignable(b.excluded, a.excluded)
    }
    // `x` fits `Exclude<B, E>` when it fits `B` and cannot be an `E` at all.
    if (b.kind === "difference") {
        return isAssignable(a, b.base) && !overlaps(a, b.excluded)
    }
    // `B - E` fits anything `B` fits; the subtraction only removes values —
    // but first see whether one member of a union target takes it as it is,
    // since `B` alone rarely fits anything the subtraction does.
    if (a.kind === "difference") {
        // Nothing left of it is a `B` when `B` is all it took out —
        // `Exclude<any, nil>` is never `nil`.
        if (isAssignable(b, a.excluded)) return false
        if (b.kind === "union" && b.types.some(m => isAssignable(a, m))) return true
        return isAssignable(a.base, b)
    }

    // A value of a type that is still waiting on a type parameter is at most
    // what that type could become: `Extract<Rows, { Page: P }>["Skills"]
    // [number]` is one of the rows' skills, so it goes where any of them do.
    // Without this, every use of such a value is an error until `P` is known.
    if (a.kind === "conditional" || a.kind === "indexedAccess") {
        // The same unevaluated type on both sides is the same values, even
        // though neither can be worked out yet.
        if ((b.kind === "conditional" || b.kind === "indexedAccess" || b.kind === "union") && equalTypes(a, b)) {
            return true
        }
        if (b.kind === "union" && b.types.some(m => equalTypes(a, m))) return true
        const bound = deferredBound?.(a)
        if (bound && bound !== a) return isAssignable(bound, b)
    }

    // Before the union rules: a type parameter stands for one value, and what
    // it may be is its constraint — `P extends "a" | "b"` fits `"a" | "b"`,
    // which splitting the target first would deny, since `P` fits neither
    // `"a"` nor `"b"` on its own.
    if (a.kind === "typeParam") {
        if (b.kind === "typeParam" && a.name === b.name) return true
        // `T` fits `T | nil`: the target names the same parameter, whatever it
        // turns out to be. Asked before the constraint, which an unconstrained
        // parameter has none of.
        if (b.kind === "union" && b.types.some(m => m.kind === "typeParam" && m.name === a.name)) return true
        return a.constraint ? isAssignable(a.constraint, b) : false
    }

    if (a.kind === "union") return a.types.every(t => isAssignable(t, b))
    if (b.kind === "union") return b.types.some(t => isAssignable(a, t))
    if (b.kind === "intersection") return b.types.every(t => isAssignable(a, t))
    if (a.kind === "intersection") {
        if (a.types.some(t => isAssignable(t, b))) return true
        // No member is enough on its own, but together they may be: `{ x } &
        // { y }` has both properties. Compare the members merged into one
        // object — which is what lets `Omit<Folder, "Parent"> & { Parent: P }`
        // count as a `Folder`.
        const merged = mergeObjectMembers(a.types)
        return merged !== undefined && isAssignable(merged, b)
    }

    if (b.kind === "primitive" && b.name === "object") {
        return a.kind === "array" || a.kind === "tuple" || a.kind === "object" || a.kind === "function" ||
            (a.kind === "primitive" && a.name === "object")
    }
    if (b.kind === "object" && !b.class && b.properties.size > 0 &&
        (a.kind === "literal" || a.kind === "templateLiteral" || a.kind === "array" || a.kind === "tuple" ||
            (a.kind === "primitive" && a.name === "string"))) {
        if (builtinFitsShape(a, b)) return true
    }
    if (a.kind === "literal") {
        if (b.kind === "literal") return a.value === b.value
        if (b.kind === "primitive") return b.name === a.base
        if (b.kind === "templateLiteral") {
            return a.base === "string" && templateMatches(String(a.value), b)
        }
        return false
    }
    if (a.kind === "templateLiteral") {
        // An unreduced pattern is a set of strings, so it is a `string`.
        return b.kind === "primitive" && b.name === "string"
    }
    if (a.kind === "primitive") return b.kind === "primitive" && b.name === a.name

    // A list that may be written to is one that may be read; the other way
    // round would hand out a write nobody promised.
    if ((a.kind === "array" || a.kind === "tuple") && a.readonly
        && (b.kind === "array" || b.kind === "tuple") && !b.readonly) return false

    if (a.kind === "array") {
        if (b.kind === "array") return isAssignable(a.element, b.element)
        if (b.kind === "tuple") return b.elements.length === 0 && !!b.rest && isAssignable(a.element, b.rest)
        return false
    }
    if (a.kind === "tuple") {
        // `[1, 2, "a"]` is a `[...number[], string]`: the places written
        // around the one list of any length, and every place between them one
        // of what that list holds.
        if (b.kind === "tuple" && !hasSpread(a) && !b.rest) {
            const at = b.elements.findIndex(e => e.kind === "spread")
            const inner = at >= 0 ? (b.elements[at] as SpreadType).type : undefined
            if (inner?.kind === "array" && b.elements.filter(e => e.kind === "spread").length === 1) {
                const head = b.elements.slice(0, at), tail = b.elements.slice(at + 1)
                if (a.elements.length < head.length + tail.length || (a.rest && tail.length)) return false
                if (!head.every((t, i) => isAssignable(a.elements[i], t))) return false
                const from = a.elements.length - tail.length
                if (!tail.every((t, i) => isAssignable(a.elements[from + i], t))) return false
                const middle = [...a.elements.slice(head.length, from), ...(a.rest ? [a.rest] : [])]
                return middle.every(t => isAssignable(t, inner.element))
            }
        }
        // A list still waiting on what it spreads fits one written the same
        // way, place by place: `[...xs, v]` is a `[...T, V]`.
        if (b.kind === "tuple" && (hasSpread(a) || hasSpread(b))) {
            if (a.elements.length !== b.elements.length || !!a.rest !== !!b.rest) return false
            if (a.rest && !isAssignable(a.rest, b.rest!)) return false
            return a.elements.every((x, i) => {
                const y = b.elements[i]
                if ((x.kind === "spread") !== (y.kind === "spread")) return false
                return x.kind === "spread" ? isAssignable(x.type, (y as SpreadType).type) : isAssignable(x, y)
            })
        }
        if (b.kind === "array" && hasSpread(a)) {
            return tupleMembers(a).every(t => isAssignable(t.kind === "spread" ? spreadMembers(t.type) : t, b.element))
        }
        if (b.kind === "tuple") {
            // Each of `b`'s places that has to be there has to be filled by
            // one of `a`'s that is; a place `b` may leave out takes one `a`
            // has or not. What `a` has beyond them goes in `b`'s rest.
            if (minLengthOf(a) < minLengthOf(b)) return false
            if (a.rest && !b.rest) return false
            if (!b.elements.every((t, i) => i >= a.elements.length ? i >= minLengthOf(b) : isAssignable(a.elements[i], t))) return false
            const extra = [...a.elements.slice(b.elements.length), ...(a.rest ? [a.rest] : [])]
            if (!b.rest) return extra.length === 0
            return extra.every(t => isAssignable(t, b.rest!))
        }
        if (b.kind === "array") return tupleMembers(a).every(t => isAssignable(t, b.element))
        return false
    }
    if (a.kind === "object") {
        if (b.kind !== "object") return false
        if (b.class) return isClassAssignable(a.class, b.class)
        // A class does satisfy a *shape* — `{ Name: string }` names members it
        // has, as Luau allows — but it is not a table: never a `{ [K]: V }`,
        // and not the empty `{}` either.
        if (a.class && (b.indexer || b.properties.size === 0)) return false
        for (const [name, bp] of b.properties) {
            const ap = a.properties.get(name)
            if (!ap) {
                if (bp.optional) continue
                if (a.indexer && isAssignable(a.indexer.value, bp.type)) continue
                return false
            }
            // An optional property may be written as nil: in Lua a field that
            // is nil is a field that is not there. A member that names
            // `this` names the value being compared.
            const want = withThis(bp.type, a), have = withThis(ap.type, a)
            if (!isAssignable(have, bp.optional ? optional(want) : want)) return false
        }
        if (b.indexer) {
            // `{ [string]: V }` promises that every key it covers holds a `V`:
            // each such property of `a` must be one, and so must whatever `a`'s
            // own indexer holds.
            for (const [name, ap] of a.properties) {
                if (b.properties.has(name) || !isAssignable(literal(name), b.indexer.key)) continue
                if (!isAssignable(ap.type, b.indexer.value)) return false
            }
            if (a.indexer && isAssignable(a.indexer.key, b.indexer.key) && !isAssignable(a.indexer.value, b.indexer.value)) {
                return false
            }
        }
        return true
    }
    if (a.kind === "function") {
        if (b.kind !== "function") return false
        // A generic function where a plain one is wanted is read as it would
        // be called there: its type parameters read off what `b`'s callers
        // pass, as TypeScript instantiates it — `<T>(x: T) => T` is a
        // `(x: number) => number`.
        const given = a.typeParams?.length && !b.typeParams?.length ? instantiatedFor(a, b) : a
        return isFunctionAssignable(laidOut(given), laidOut(b))
    }
    if (b.kind === "typeParam") return false
    if (a.kind === "genericRef" || b.kind === "genericRef") {
        if (!(a.kind === "genericRef" && b.kind === "genericRef" && sameRefTarget(a, b) &&
            a.typeArguments.length === b.typeArguments.length)) return false
        // Where the alias says how it compares by a parameter, the arguments
        // compare that way; otherwise only the same argument is the same type.
        const variances = (a.origin ?? b.origin)?.variances?.(a.name)
        return a.typeArguments.every((x, i) => {
            const y = b.typeArguments[i]
            switch (variances?.[i]) {
                case "out": return isAssignable(x, y)
                case "in": return isAssignable(y, x)
                default: return equalTypes(x, y)
            }
        })
    }
    return false
}

/** Are `a` and `b` literals of one primitive — `1` and `2`? Then a type
 *  parameter both are read for is either, `1 | 2`, as TypeScript reads it;
 *  `1` and `"a"` leave the first one standing. */
function sameLiteralBase(a: Type, b: Type): boolean {
    const bases = (t: Type): Set<string> | undefined => {
        const members = t.kind === "union" ? t.types : [t]
        if (!members.every(m => m.kind === "literal")) return undefined
        return new Set(members.map(m => (m as LiteralType).base))
    }
    const x = bases(a), y = bases(b)
    return !!x && !!y && x.size === 1 && y.size === 1 && [...x][0] === [...y][0]
}

/** `(...args: [number, string]) => R` is `(a: number, b: string) => R`: a rest
 *  parameter that is a tuple of known places is those parameters. */
function laidOut(f: FunctionType): FunctionType {
    if (!f.restIsWhole || !f.varargs) return f
    const rest = f.varargs
    if (rest.kind !== "tuple" || hasSpread(rest)) return f
    return {
        ...f,
        params: [...f.params, ...tupleParams(rest)],
        varargs: rest.rest,
        restIsWhole: undefined,
    }
}

/** A tuple's places as the parameters they are, with their names, and the
 *  ones that may be left out optional: `[a: number, b?: string]` is
 *  `(a: number, b?: string)`. */
export function tupleParams(t: TupleType): FunctionParam[] {
    const required = minLengthOf(t)
    return t.elements.map((type, i): FunctionParam => ({
        type,
        ...(t.names?.[i] ? { name: t.names[i] } : {}),
        ...(i >= required ? { optional: true } : {}),
    }))
}

/** Parameters as the tuple they are: `(a: number, b?: string)` is
 *  `[a: number, b?: string]`. */
export function paramsAsTuple(params: readonly FunctionParam[], rest?: Type): TupleType {
    const made = tuple(params.map(p => p.type), rest)
    let required = 0
    params.forEach((p, i) => { if (!p.optional) required = i + 1 })
    return {
        ...made,
        ...(required < params.length ? { minLength: required } : {}),
        ...(params.some(p => p.name) ? { names: params.map(p => p.name) } : {}),
    }
}

function isFunctionAssignable(a: FunctionType, b: FunctionType): boolean {
    // A function that needs more arguments than a caller of `b` hands it
    // would run with some of them missing.
    if (!b.varargs && requiredParams(a) > b.params.length) return false
    // Parameters are contravariant, as under TypeScript's
    // `strictFunctionTypes`: whatever a caller of `b` passes has to be
    // something `a` accepts. A method — a function taking its receiver
    // first, `self` or `this` — is compared both ways, as TypeScript
    // compares methods: an override narrows what its class is.
    const method = isMethodLike(a) || isMethodLike(b)
    const n = Math.min(a.params.length, b.params.length)
    for (let i = 0; i < n; i++) {
        const given = b.params[i].type, taken = a.params[i].type
        if (isAssignable(given, taken)) continue
        if (method && isAssignable(taken, given)) continue
        return false
    }
    // And the other way: what `b`'s callers pass through its rest fills
    // `a`'s parameters past `b`'s named ones — `(a: number, b: number) =>`
    // is no `(...xs: string[]) =>`.
    const restOfB = !b.varargs ? undefined
        : !b.restIsWhole ? b.varargs
        : b.varargs.kind === "array" ? b.varargs.element : undefined
    // A rest of `unknown` is what a list still to be worked out is at most
    // (`A extends unknown[]`): it says what may come, not what will, and is
    // read as TypeScript reads `any[]` there.
    if (restOfB && restOfB.kind !== "unknown") {
        for (let i = b.params.length; i < a.params.length; i++) {
            const taken = a.params[i].type
            if (isAssignable(restOfB, taken)) continue
            if (method && isAssignable(taken, restOfB)) continue
            return false
        }
    }
    // What `b`'s callers pass beyond `a`'s named parameters lands in its
    // rest.
    if (a.varargs && !a.restIsWhole) {
        for (let i = a.params.length; i < b.params.length; i++) {
            const given = b.params[i].type
            if (isAssignable(given, a.varargs)) continue
            if (method && isAssignable(a.varargs, given)) continue
            return false
        }
    }
    // Where a guard is wanted, a plain `boolean` says nothing about the
    // value: only a guard on the same parameter, narrowing no wider, is one.
    // One that says nothing when false is no guard where false is read.
    const wanted = b.predicate
    if (wanted?.type && !wanted.asserts) {
        const given = a.predicate
        if (!given?.type || given.asserts || given.param !== wanted.param || !isAssignable(given.type, wanted.type)) return false
        if (given.implies && !wanted.implies) return false
    }
    // A function wanted for what it does, not for what it gives back — `=>
    // void` — takes one that gives something back: `() => task.defer(f)` is
    // a callback whose answer nobody reads. `=> nil` promises a `nil`.
    if (isVoid(b.returns)) return true
    return isAssignable(a.returns, b.returns)
}

/** How many arguments a call of `f` has to pass. */
function requiredParams(f: FunctionType): number {
    let n = 0
    f.params.forEach((p, i) => { if (!p.optional) n = i + 1 })
    return n
}

/** Does `f` take its receiver first — `(self: T, ...)`, `(this: T, ...)`? */
function isMethodLike(f: FunctionType): boolean {
    const first = f.params[0]?.name
    return first === "self" || first === "this"
}

function isAliasNamed(t: Type): boolean {
    if (t.kind === "object" || t.kind === "intersection") return t.name !== undefined
    return (t as { alias?: string }).alias !== undefined
}

/** Do two refs name the same alias? The same name from two different modules
 *  does not. A ref with no origin (a generic parameter, a name nothing
 *  declares) is taken at its name, as before. */
function sameRefTarget(a: GenericRefType, b: GenericRefType): boolean {
    return a.name === b.name && (!a.origin || !b.origin || a.origin === b.origin)
}

/** `[]` — no values at all. A function that returns nothing returns `nil`. */
function isNoValue(t: Type): boolean {
    return t.kind === "tuple" && t.elements.length === 0 && !t.rest
}

export function equalTypes(a: Type, b: Type): boolean {
    return formatType(a) === formatType(b)
}

// ============================================================
// narrowing helpers
// ============================================================

/** Keep the parts of `t` compatible with `filter` — TypeScript's
 *  `getNarrowedType`. Per union member: a member already assignable to the
 *  filter survives as-is; a member the filter is assignable to is *replaced*
 *  by the filter (so `string` narrowed by `"a"` becomes `"a"`, not `string`);
 *  anything else is dropped. `any` / `unknown` narrow straight to the filter. */
export function narrowTo(t: Type, filter: Type): Type {
    if (filter.kind === "any") return t
    // Narrowing a subtraction narrows its base, then re-applies what was
    // already ruled out: `Exclude<unknown, 1>` narrowed by `number` is
    // `Exclude<number, 1>`.
    if (t.kind === "difference") return difference(narrowTo(t.base, filter), t.excluded)
    if (t.kind === "any" || t.kind === "unknown") return filter
    const members = t.kind === "union" ? t.types : [t]
    const kept: Type[] = []
    for (const m of members) {
        if (m.kind === "any") { kept.push(filter); continue }
        if (isAssignable(m, filter)) kept.push(m)
        else if (isAssignable(filter, m)) kept.push(filter)
        // A parameter is one value not known yet: `typeof v == "array"` on a
        // `T` says it is a `T` that is a list, `T & unknown[]`, as in
        // TypeScript — unless its constraint rules that out.
        else if (m.kind === "typeParam") {
            const within = m.constraint ? narrowTo(m.constraint, filter) : filter
            if (within.kind !== "never") kept.push(intersection([m, within]))
        }
    }
    return union(kept)
}

/** Remove the parts of `t` assignable to `exclude` (the `else` branch).
 *  `boolean` minus a `true`/`false` literal leaves the other literal — the
 *  only primitive here with a finite, enumerable domain. */
export function narrowExclude(t: Type, exclude: Type): Type {
    if (exclude.kind === "never" || t.kind === "any") return t
    // An opaque type keeps what was ruled out, since that is all the test told
    // us. `difference` decides whether the subtraction is worth keeping.
    if (t.kind === "unknown" || t.kind === "typeParam" || t.kind === "genericRef" ||
        t.kind === "difference") {
        return difference(t, exclude)
    }
    const members = t.kind === "union" ? t.types : [t]
    const kept: Type[] = []
    for (const m of members) {
        if (isAssignable(m, exclude)) continue
        if (m.kind === "primitive" && m.name === "boolean" &&
            exclude.kind === "literal" && exclude.base === "boolean") {
            kept.push(literal(!(exclude.value as boolean)))
            continue
        }
        // `if (s == "x") return` leaves a string that is not `"x"`, and says
        // so: a second `s == "x"` is then a test that cannot pass.
        kept.push(m.kind === "primitive" ? difference(m, exclude) : m)
    }
    return union(kept)
}

// The whole falsy story in Luau: **only `nil` and `false`**. Unlike JS/TS,
// `0`, `0/0` and `""` are truthy, so `if n then` tells you nothing about a
// `number` and `if s then` nothing about a `string`. Every truthiness-driven
// narrowing in the analyzer goes through these two functions, so that rule
// lives in exactly one place.

/** `nil | false` — every falsy value in Luau. Built literally rather than via
 *  `union()`, which would format its members for deduping and so touch caches
 *  declared further down this module. */
export const falsyType: Type = { kind: "union", types: [nilType, { kind: "literal", base: "boolean", value: false }] }

/** Can a value of this type ever be truthy? */
export function isPossiblyTruthy(t: Type): boolean {
    if (t.kind === "never") return false
    if (t.kind === "difference") return isPossiblyTruthy(t.base) && !isAssignable(t.base, t.excluded)
    if (t.kind === "union") return t.types.some(isPossiblyTruthy)
    // `T & nil` is a `nil`: a value of every member at once.
    if (t.kind === "intersection") return t.types.every(isPossiblyTruthy)
    if (t.kind === "primitive" && (t.name === "nil" || t.name === "void")) return false
    if (t.kind === "literal" && t.value === false) return false
    return true
}

/** Can a value of this type ever be falsy? */
export function isPossiblyFalsy(t: Type): boolean {
    if (t.kind === "never") return false
    if (t.kind === "difference") return isPossiblyFalsy(t.base) && !isAssignable(falsyType, t.excluded)
    if (t.kind === "union") return t.types.some(isPossiblyFalsy)
    if (t.kind === "intersection") return t.types.every(isPossiblyFalsy)
    if (t.kind === "any" || t.kind === "unknown") return true
    if (t.kind === "primitive") return t.name === "nil" || t.name === "void" || t.name === "boolean"
    if (t.kind === "literal") return t.value === false
    // typeParam / genericRef: unresolved, so assume it could be either.
    return t.kind === "typeParam" || t.kind === "genericRef"
}

/** Keep only what can be truthy — drops `nil` and the `false` literal, and
 *  narrows a bare `boolean` to `true`. */
export function narrowTruthy(t: Type): Type {
    if (t.kind === "any") return t
    // `unknown` minus the falsy values — the truthy branch's whole content.
    if (t.kind === "unknown" || t.kind === "typeParam" || t.kind === "genericRef") {
        return difference(t, falsyType)
    }
    if (t.kind === "difference") return difference(narrowTruthy(t.base), t.excluded)
    const members = t.kind === "union" ? t.types : [t]
    const out: Type[] = []
    for (const m of members) {
        if (!isPossiblyTruthy(m)) continue
        if (m.kind === "primitive" && m.name === "boolean") out.push(literal(true))
        else out.push(m)
    }
    return union(out)
}

/** Keep only what can be falsy — `nil` and `false`. */
export function narrowFalsy(t: Type): Type {
    const members = t.kind === "union" ? t.types : [t]
    const out: Type[] = []
    for (const m of members) {
        // What of `Exclude<T, nil>` is falsy is what of `T` is, less `nil`;
        // `T & nil` already is falsy, all of it.
        if (m.kind === "difference") {
            if (isPossiblyFalsy(m)) out.push(difference(narrowFalsy(m.base), m.excluded))
        }
        else if (m.kind === "intersection") {
            if (isPossiblyFalsy(m)) out.push(m)
        }
        else if (m.kind === "primitive" && m.name === "nil") out.push(nilType)
        else if (m.kind === "primitive" && m.name === "boolean") out.push(literal(false))
        else if (m.kind === "literal" && m.value === false) out.push(literal(false))
        // A parameter stays itself, a falsy one: `T & (nil | false)` still
        // goes where a `T` does.
        else if (m.kind === "typeParam") out.push(intersection([m, falsyType]))
        else if (m.kind === "any" || m.kind === "unknown" || m.kind === "genericRef") {
            out.push(nilType)
            out.push(literal(false))
        }
    }
    return union(out)
}

/** Does `t` still mention a *free* type parameter — one that is not bound by
 *  something inside `t` itself? A type-level operator can only be evaluated
 *  once this is false.
 *
 *  The distinction matters: an object whose members include a generic method
 *  (`IsA: <K>(...) -> ...`) is perfectly concrete, because `K` is bound by
 *  that signature. Counting such a `K` as free would leave every `keyof` of
 *  that object deferred forever. */
const freeParamCache = new WeakMap<object, boolean>()

export function containsTypeParam(
    t: Type,
    seen = new Set<Type>(),
    bound = new Set<string>(),
): boolean {
    // Outermost call on a closed question: cacheable, and worth caching —
    // the reducer asks this of the same large types over and over.
    const cacheable = seen.size === 0 && bound.size === 0 && !seekingThis
    if (cacheable) {
        const hit = freeParamCache.get(t)
        if (hit !== undefined) return hit
    }
    const result = containsFreeTypeParam(t, seen, bound)
    if (cacheable) freeParamCache.set(t, result)
    return result
}

/** The name of TypeScript's polymorphic `this` type: the value a member is
 *  read from. It is a type parameter filled in where a member is read (see
 *  `withThis`), so it never keeps a type waiting the way a generic's own
 *  parameters do — `keyof` an interface whose methods take `self: this` is
 *  as known as any other. */
export const THIS_TYPE = "this"

/** Set while `mentionsThis` walks a type: then `this` is the one parameter
 *  that counts. */
let seekingThis = false
const thisCache = new WeakMap<object, boolean>()

/** Does `t` mention the polymorphic `this` — outside a class, whose members
 *  are read one at a time? */
export function mentionsThis(t: Type): boolean {
    const hit = thisCache.get(t)
    if (hit !== undefined) return hit
    const was = seekingThis
    seekingThis = true
    try {
        const result = containsFreeTypeParam(t, new Set(), new Set())
        thisCache.set(t, result)
        return result
    } finally {
        seekingThis = was
    }
}

/** `t` with `this` standing for `receiver`. */
export function withThis(t: Type, receiver: Type): Type {
    return mentionsThis(t) ? substitute(t, new Map([[THIS_TYPE, receiver]])) : t
}

function containsFreeTypeParam(t: Type, seen: Set<Type>, bound: Set<string>): boolean {
    if (seen.has(t)) return false
    seen.add(t)
    switch (t.kind) {
        case "typeParam": return seekingThis ? t.name === THIS_TYPE : !bound.has(t.name) && t.name !== THIS_TYPE
        case "infer": return !bound.has(t.name) || (!!t.constraint && containsTypeParam(t.constraint, seen, bound))
        case "array": return containsTypeParam(t.element, seen, bound)
        case "spread": return containsTypeParam(t.type, seen, bound)
        case "tuple": return tupleMembers(t).some(e => containsTypeParam(e, seen, bound))
        case "union":
        case "intersection": return t.types.some(m => containsTypeParam(m, seen, bound))
        case "object":
            // A class's members refer back to the class, so walking them would
            // never end. Its type arguments say everything about whether it is
            // waiting on a parameter: every `T` in a member came from one.
            if (t.class) {
                return [...(t.class.typeArguments?.values() ?? [])]
                    .some(args => args.some(a => containsTypeParam(a, seen, bound)))
            }
            return [...t.properties.values()].some(v => containsTypeParam(v.type, seen, bound)) ||
                (!!t.indexer && (containsTypeParam(t.indexer.key, seen, bound) ||
                    containsTypeParam(t.indexer.value, seen, bound)))
        case "function": {
            // A signature's own generic parameters are bound within it.
            const inner = t.typeParams?.length
                ? new Set([...bound, ...t.typeParams])
                : bound
            return t.params.some(p => containsTypeParam(p.type, seen, inner)) ||
                (!!t.varargs && containsTypeParam(t.varargs, seen, inner)) ||
                containsTypeParam(t.returns, seen, inner) ||
                (!!t.predicate?.type && containsTypeParam(t.predicate.type, seen, inner))
        }
        case "genericRef": return t.typeArguments.some(a => containsTypeParam(a, seen, bound))
        case "keyof": return containsTypeParam(t.target, seen, bound)
        case "templateLiteral": return t.types.some(x => containsTypeParam(x, seen, bound))
        case "difference":
            return containsTypeParam(t.base, seen, bound) || containsTypeParam(t.excluded, seen, bound)
        case "indexedAccess":
            return containsTypeParam(t.objectType, seen, bound) ||
                containsTypeParam(t.indexType, seen, bound)
        case "conditional": {
            // Every part can hold one: `Extract<Rows, { Page: P }>` waits on
            // its `extends` side, and the branches carry the alias's own
            // parameters. `infer` names are bound by the clause that
            // introduces them.
            const inner = t.inferVars.length ? new Set([...bound, ...t.inferVars]) : bound
            return containsTypeParam(t.checkType, seen, bound) ||
                containsTypeParam(t.extendsType, seen, inner) ||
                containsTypeParam(t.trueType, seen, inner) ||
                containsTypeParam(t.falseType, seen, bound)
        }
        case "mapped": {
            // The key it maps over, and what it maps each key to — under the
            // mapped parameter, which is bound here.
            const inner = new Set([...bound, t.parameter])
            return containsTypeParam(t.constraint, seen, bound) ||
                (!!t.nameType && containsTypeParam(t.nameType, seen, inner)) ||
                containsTypeParam(t.template, seen, inner) ||
                (!!t.source && containsTypeParam(t.source, seen, bound))
        }
        default: return false
    }
}

/** Structurally match `arg` against `pattern`, binding every `infer` name it
 *  contains into `out`. This is what turns `T extends (...unknown) -> infer R`
 *  into `R = <the return type>`. Returns false when the shapes cannot match at
 *  all; a `true` result still needs the usual assignability check.
 *
 *  `contra` is set below a function's parameter: a name inferred from several
 *  places there is what all of them take — their intersection, which is how
 *  `UnionToIntersection` works — where anywhere else it is their union. */
export function matchInfer(arg: Type, pattern: Type, out: Map<string, Type>, contra = false): boolean {
    if (pattern.kind === "infer") {
        if (pattern.constraint && !isAssignable(arg, pattern.constraint)) return false
        const prev = out.get(pattern.name)
        out.set(pattern.name, !prev ? arg : contra ? intersection([prev, arg]) : union([prev, arg]))
        return true
    }
    if (!containsTypeParam(pattern)) return true // nothing to bind; assignability decides
    if (arg.kind === "genericRef" && pattern.kind !== "genericRef" && expandAlias) {
        const expanded = expandAlias(arg)
        if (expanded !== arg) return matchInfer(expanded, pattern, out, contra)
    }
    // Several possibilities matched against one shape: each of them has to
    // fit it, and each says something about the names.
    if (arg.kind === "union" && pattern.kind !== "union") {
        return arg.types.every(m => matchInfer(m, pattern, out, contra))
    }
    // A generic function read by a pattern is read with each of its own type
    // parameters at its constraint, as TypeScript reads it: `ReturnType<typeof
    // find>` for a `find<T extends Instance>(): T | nil` is `Instance | nil`,
    // not a `T` that nothing outside the function can name.
    if (pattern.kind === "function" && arg.kind === "function" && arg.typeParams?.length) {
        return matchInfer(eraseTypeParams(arg), pattern, out, contra)
    }
    // An overload set is matched by its last signature, as TypeScript reads
    // `ReturnType<typeof overloaded>`.
    if (pattern.kind === "function" && arg.kind === "intersection") {
        const signatures = arg.types.filter((m): m is FunctionType => m.kind === "function")
        if (signatures.length) return matchInfer(signatures[signatures.length - 1], pattern, out, contra)
    }
    switch (pattern.kind) {
        case "array":
            if (arg.kind === "array") return matchInfer(arg.element, pattern.element, out, contra)
            if (arg.kind === "tuple") return matchInfer(union(tupleMembers(arg)), pattern.element, out, contra)
            return false
        case "tuple":
            return matchTuple(arg, pattern, out, contra)
        case "function": {
            if (arg.kind !== "function") return false
            // `(...args: infer P) => R` collects the whole parameter list as a
            // tuple — this is how `Parameters<T>` is expressed. So does a rest
            // that is a tuple pattern of its own: `(...args: [infer A, ...infer R])`.
            const whole = pattern.varargs && (pattern.restIsWhole || pattern.varargs.kind === "infer")
            for (let i = 0; i < pattern.params.length; i++) {
                const given = arg.params[i]?.type ?? (arg.varargs && !arg.restIsWhole ? arg.varargs : undefined)
                // A function taking fewer parameters still fits: what the
                // missing one would have been is not known.
                if (!given) continue
                if (!matchInfer(given, pattern.params[i].type, out, !contra)) return false
            }
            if (whole) {
                const wholeArg = arg.restIsWhole && arg.varargs && !arg.params.length
                    ? arg.varargs
                    : paramsAsTuple(arg.params.slice(pattern.params.length),
                        arg.varargs && !arg.restIsWhole ? arg.varargs : undefined)
                if (!matchInfer(wholeArg, pattern.varargs!, out, !contra)) return false
            } else if (pattern.varargs && arg.varargs && !arg.restIsWhole) {
                if (!matchInfer(arg.varargs, pattern.varargs, out, !contra)) return false
            }
            return matchInfer(arg.returns, pattern.returns, out, contra)
        }
        case "object": {
            let given: Type = arg
            if (given.kind === "intersection") given = mergeObjectMembers(given.types) ?? given
            if (given.kind !== "object") return false
            for (const [k, pv] of pattern.properties) {
                const av = given.properties.get(k)
                if (!av) {
                    if (pv.optional) continue
                    if (given.indexer && matchInfer(given.indexer.value, pv.type, out, contra)) continue
                    return false
                }
                if (!matchInfer(pv.optional ? withoutNilMember(av.type) : av.type, pv.type, out, contra)) return false
            }
            if (pattern.indexer) {
                if (given.indexer) return matchInfer(given.indexer.value, pattern.indexer.value, out, contra)
                // `{ [string]: infer V }` against a record: every member's value.
                const values = [...given.properties.values()].map(p => p.type)
                if (values.length) return matchInfer(union(values), pattern.indexer.value, out, contra)
            }
            return true
        }
        case "templateLiteral":
            if (arg.kind === "literal" && arg.base === "string") return matchTemplate(String(arg.value), pattern, out)
            return arg.kind === "templateLiteral"
        case "union":
            return pattern.types.some(m => matchInfer(arg, m, out, contra))
        case "intersection":
            return pattern.types.every(m => matchInfer(arg, m, out, contra))
        case "genericRef":
            if (arg.kind !== "genericRef" || arg.name !== pattern.name) return false
            return pattern.typeArguments.every((a, i) =>
                arg.typeArguments[i] !== undefined && matchInfer(arg.typeArguments[i], a, out, contra))
        default:
            return true
    }
}

/** `f`, generic, as it is when called where `target` is wanted: each of its
 *  type parameters read off the parameters `target` is called with, and one
 *  they say nothing about at its constraint. */
function instantiatedFor(f: FunctionType, target: FunctionType): FunctionType {
    const vars = new Set(f.typeParams ?? [])
    const found = new Map<string, Type>()
    const wanted = laidOut(target)
    f.params.forEach((p, i) => {
        const given = wanted.params[i]?.type ?? (wanted.varargs && !wanted.restIsWhole ? wanted.varargs : undefined)
        if (given) unify(p.type, given, vars, found, "first")
    })
    const constraints = new Map<string, Type>()
    for (const part of [...f.params.map(p => p.type), f.varargs, f.returns]) collectTypeParams(part, constraints)
    for (const name of vars) {
        const bound = constraints.get(name)
        // What was read has to be one it allows; past it, the most it allows.
        const read = found.get(name)
        if (!read || (bound && !isAssignable(read, bound))) found.set(name, bound ?? unknownType)
    }
    return substitute({ ...f, typeParams: undefined, typeParamDefaults: undefined }, found) as FunctionType
}

/** `f` with its own type parameters replaced by their constraints (`unknown`
 *  for one with none) — what it is to someone who cannot pick them. */
function eraseTypeParams(f: FunctionType): FunctionType {
    const constraints = new Map<string, Type>()
    for (const part of [...f.params.map(p => p.type), f.varargs, f.returns]) collectTypeParams(part, constraints)
    const erased = new Map<string, Type>((f.typeParams ?? []).map(name => [name, constraints.get(name) ?? unknownType]))
    const open: FunctionType = { ...f, typeParams: undefined, typeParamDefaults: undefined }
    return substitute(open, erased) as FunctionType
}

function withoutNilMember(t: Type): Type {
    return t.kind === "union" ? union(t.types.filter(m => !(m.kind === "primitive" && m.name === "nil"))) : t
}

/** A tuple pattern: `[A, B]`, `[A, ...B[]]`, or one with a spread anywhere —
 *  `[infer H, ...infer R]`, `[...infer Init, infer L]`. What a spread stands
 *  for is the elements between the ones written around it, as a tuple. */
function matchTuple(arg: Type, pattern: TupleType, out: Map<string, Type>, contra: boolean): boolean {
    const at = pattern.elements.findIndex(e => e.kind === "spread")
    if (arg.kind === "array") {
        // A list of any length fits only a pattern of any length.
        if (at < 0) return pattern.elements.length === 0 && !!pattern.rest && matchInfer(arg.element, pattern.rest, out, contra)
        if (pattern.elements.length !== 1 || pattern.rest) return false
        return matchInfer(arg, (pattern.elements[0] as SpreadType).type, out, contra)
    }
    if (arg.kind !== "tuple") return false
    if (at < 0) {
        if (arg.elements.length < pattern.elements.length) return false
        if (!pattern.rest && (arg.elements.length !== pattern.elements.length || arg.rest)) return false
        if (!pattern.elements.every((pt, i) => matchInfer(arg.elements[i], pt, out, contra))) return false
        if (!pattern.rest) return true
        const extra = [...arg.elements.slice(pattern.elements.length), ...(arg.rest ? [arg.rest] : [])]
        return matchInfer(extra.length ? union(extra) : neverType, pattern.rest, out, contra)
    }
    const head = pattern.elements.slice(0, at)
    const tail = pattern.elements.slice(at + 1)
    // Two spreads, or a spread and a rest, leave where one ends unknowable.
    if (pattern.rest || tail.some(e => e.kind === "spread")) return false
    if (arg.elements.length < head.length + tail.length) return false
    // A rest of any length puts the elements written after it out of reach.
    if (arg.rest && tail.length) return false
    if (!head.every((pt, i) => matchInfer(arg.elements[i], pt, out, contra))) return false
    const from = arg.elements.length - tail.length
    if (!tail.every((pt, i) => matchInfer(arg.elements[from + i], pt, out, contra))) return false
    const middle = tuple(arg.elements.slice(head.length, from), arg.rest)
    return matchInfer(middle, (pattern.elements[at] as SpreadType).type, out, contra)
}

/** A string literal against a template pattern with `infer` in it:
 *  `` `${infer A}.${infer B}` `` against `"a.b.c"` binds `A = "a"` and
 *  `B = "b.c"`. Read left to right as TypeScript does: each placeholder takes
 *  up to the first place the text after it appears, one directly followed by
 *  another takes a single character, and the last takes what is left. */
function matchTemplate(value: string, pattern: TemplateLiteralType, out: Map<string, Type>): boolean {
    // A placeholder that is one known string is text like any other.
    const quasis = [pattern.quasis[0]]
    const types: Type[] = []
    pattern.types.forEach((t, i) => {
        if (t.kind === "literal") quasis[quasis.length - 1] += String(t.value) + pattern.quasis[i + 1]
        else { types.push(t); quasis.push(pattern.quasis[i + 1]) }
    })
    if (!types.length) return value === quasis[0]
    const last = quasis[quasis.length - 1]
    if (!value.startsWith(quasis[0]) || !value.endsWith(last) || value.length - last.length < quasis[0].length) return false
    const end = value.length - last.length
    let pos = quasis[0].length
    const pieces: string[] = []
    for (let i = 0; i < types.length; i++) {
        if (i === types.length - 1) {
            pieces.push(value.slice(pos, end))
            break
        }
        const after = quasis[i + 1]
        if (!after) {
            if (pos >= end) return false
            pieces.push(value.charAt(pos))
            pos += 1
            continue
        }
        const found = value.indexOf(after, pos)
        if (found < 0 || found + after.length > end) return false
        pieces.push(value.slice(pos, found))
        pos = found + after.length
    }
    return types.every((t, i) => bindTemplatePiece(pieces[i], t, out))
}

/** One piece a template placeholder took, checked against what it was
 *  written as — and bound, if that was an `infer`. */
function bindTemplatePiece(piece: string, placeholder: Type, out: Map<string, Type>): boolean {
    if (placeholder.kind !== "infer") return pieceAs(piece, placeholder) !== undefined
    const read = placeholder.constraint ? pieceAs(piece, placeholder.constraint) : literal(piece)
    if (!read) return false
    const prev = out.get(placeholder.name)
    out.set(placeholder.name, prev ? union([prev, read]) : read)
    return true
}

/** The text a template placeholder took, read as a value of `t`: `"42"` is
 *  the number `42`, `"true"` the boolean. */
function pieceAs(piece: string, t: Type): Type | undefined {
    const candidates: Type[] = [literal(piece)]
    const n = Number(piece)
    if (piece.trim() !== "" && Number.isFinite(n) && String(n) === piece) candidates.push(literal(n))
    if (piece === "true" || piece === "false") candidates.push(literal(piece === "true"))
    return candidates.find(c => isAssignable(c, t))
}

/** Does a concrete string match a template literal *pattern*? Each
 *  interpolation is matched against the widest thing it could stand for:
 *  `string` swallows any run, `number` a numeric run, and a literal union only
 *  its own members. Anchored at both ends, like TypeScript. */
export function templateMatches(value: string, pattern: TemplateLiteralType): boolean {
    const partSource = (t: Type): string => {
        switch (t.kind) {
            case "literal": return escapeRegExp(String(t.value))
            case "primitive":
                if (t.name === "number") return "-?\\d+(?:\\.\\d+)?"
                if (t.name === "boolean") return "true|false"
                return "[\\s\\S]*"
            case "union": return t.types.map(m => `(?:${partSource(m)})`).join("|")
            default: return "[\\s\\S]*"
        }
    }
    let source = "^" + escapeRegExp(pattern.quasis[0])
    pattern.types.forEach((t, i) => {
        source += `(?:${partSource(t)})` + escapeRegExp(pattern.quasis[i + 1])
    })
    return new RegExp(source + "$").test(value)
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Do these two types share any value? The compatibility test behind
 *  discriminant filtering and `narrowTo`. */
export function overlaps(a: Type, b: Type): boolean {
    // Two unions share a value when any of their members do: `Node | nil` and
    // `nil | false` meet at `nil`, though neither is assignable to the other.
    if (a.kind === "union") return a.types.some(m => overlaps(m, b))
    if (b.kind === "union") return b.types.some(m => overlaps(a, m))
    return isAssignable(a, b) || isAssignable(b, a)
}

// ============================================================
// formatting (also the structural key for dedupe)
// ============================================================

/** `formatType` doubles as the structural key for union/intersection dedupe
 *  and `equalTypes`, so it runs constantly — and a class hierarchy formats to
 *  a very large string. Types are immutable by construction (every
 *  constructor returns a fresh value), so caching by identity is sound. */
const formatCache = new WeakMap<object, string>()

/** A constraint as a signature shows it. A long union — every service name —
 *  is cut short, the way a diagnostic's types are. */
function briefConstraint(t: Type): string {
    if (t.kind === "union" && t.types.length > 8) {
        return `${t.types.slice(0, 6).map(formatType).join(" | ")} | ... ${t.types.length - 6} more`
    }
    return formatType(t)
}

/** Every named type parameter a type mentions that carries a constraint. */
function collectTypeParams(t: Type | undefined, out: Map<string, Type>, seen = new Set<Type>()): void {
    if (!t || seen.has(t)) return
    seen.add(t)
    switch (t.kind) {
        case "typeParam":
            if (t.constraint && !out.has(t.name)) out.set(t.name, t.constraint)
            collectTypeParams(t.constraint, out, seen)
            return
        case "array": collectTypeParams(t.element, out, seen); return
        case "tuple": for (const e of tupleMembers(t)) collectTypeParams(e, out, seen); return
        case "union":
        case "intersection": for (const m of t.types) collectTypeParams(m, out, seen); return
        case "keyof": collectTypeParams(t.target, out, seen); return
        case "indexedAccess":
            collectTypeParams(t.objectType, out, seen)
            collectTypeParams(t.indexType, out, seen)
            return
        case "genericRef": for (const a of t.typeArguments) collectTypeParams(a, out, seen); return
        case "object":
            for (const [, p] of t.properties) collectTypeParams(p.type, out, seen)
            return
        default: return
    }
}

export function formatType(t: Type): string {
    const cached = formatCache.get(t)
    if (cached !== undefined) return cached
    const out = formatTypeUncached(t)
    formatCache.set(t, out)
    return out
}

function formatTypeUncached(t: Type): string {
    // An alias is printed as what the reader wrote, exactly as a named object
    // already was. `withoutAliasName` is how a caller asks for the structure —
    // which is what the hover opens a level at a time.
    const alias = aliasNameOf(t)
    if (alias !== undefined && t.kind !== "object" && t.kind !== "intersection") return alias
    switch (t.kind) {
        case "any": return "any"
        case "unknown": return "unknown"
        case "never": return "never"
        case "primitive": return t.name
        case "literal": return t.base === "string" ? JSON.stringify(t.value) : String(t.value)
        // `readonly (readonly [A, B])[]`: an element that is a read-only list in
        // parentheses, or its `readonly` would read as the whole array's.
        case "array": {
            const element = (t.element.kind === "array" || t.element.kind === "tuple") && t.element.readonly
                ? `(${formatType(t.element)})` : formatAtom(t.element)
            return `${t.readonly ? "readonly " : ""}${element}[]`
        }
        case "tuple": {
            // Nothing but a rest is a list of any length: `number[]`.
            if (!t.elements.length && t.rest) return `${t.readonly ? "readonly " : ""}${formatAtom(t.rest)}[]`
            const required = minLengthOf(t)
            const inner = [
                ...t.elements.map((e, i) => {
                    const optional = i >= required
                    const shown = formatType(optional ? withoutNilMember(e) : e)
                    const name = t.names?.[i]
                    return name ? `${name}${optional ? "?" : ""}: ${shown}` : `${shown}${optional ? "?" : ""}`
                }),
                ...(t.rest ? [`...${formatAtom(t.rest)}[]`] : []),
            ]
            return `${t.readonly ? "readonly " : ""}[${inner.join(", ")}]`
        }
        case "object": {
            if (t.name) {
                // An instantiated generic class says which one it is.
                const args = t.class?.typeArguments?.get(t.class.name)
                return args?.length ? `${t.name}<${args.map(formatType).join(", ")}>` : t.name
            }
            const props = [...t.properties.entries()]
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([k, v]) => `${v.readonly ? "readonly " : ""}${formatKey(k)}${v.optional ? "?" : ""}: ${formatType(v.type)}`)
            if (t.indexer) props.push(`[${formatType(t.indexer.key)}]: ${formatType(t.indexer.value)}`)
            return props.length ? `{ ${props.join(", ")} }` : "{}"
        }
        case "function": {
            const consts = new Set(
                t.params.filter(p => p.type.kind === "typeParam" && p.type.isConst)
                    .map(p => (p.type as TypeParamType).name),
            )
            // The constraints live on the `typeParam` nodes the signature
            // uses, not on the name list: `<K extends keyof Services>` reads
            // far better than `<K>`.
            const constraints = new Map<string, Type>()
            for (const part of [...t.params.map(p => p.type), t.varargs, t.returns]) {
                collectTypeParams(part, constraints)
            }
            const gen = t.typeParams?.length
                ? `<${t.typeParams.map(n => {
                    const constraint = constraints.get(n)
                    return `${consts.has(n) ? "const " : ""}${n}${constraint ? ` extends ${briefConstraint(constraint)}` : ""}`
                }).join(", ")}>`
                : ""
            // `separator?: string`, as it was written — not `separator: string
            // | nil`, which would have to be passed.
            const ps = t.params.map(p => p.name && p.optional
                ? `${p.name}?: ${formatType(withoutNilMember(p.type))}`
                : `${p.name ? p.name + ": " : ""}${formatType(p.type)}`)
            // Written the one way a rest parameter is: as the array it collects.
            if (t.varargs) ps.push(t.restIsWhole ? `...args: ${formatType(t.varargs)}` : `...args: ${formatAtom(t.varargs)}[]`)
            return `${gen}(${ps.join(", ")}) => ${formatPredicate(t) ?? formatType(t.returns)}`
        }
        case "typeParam": return t.name
        case "union": return t.types.map(formatAtom).join(" | ")
        case "intersection": return t.name ?? t.types.map(formatAtom).join(" & ")
        case "genericRef":
            return t.typeArguments.length
                ? `${t.name}<${t.typeArguments.map(formatType).join(", ")}>`
                : t.name
        case "keyof": return `keyof ${formatAtom(t.target)}`
        case "difference": return `Exclude<${formatType(t.base)}, ${formatType(t.excluded)}>`
        case "templateLiteral": {
            let out = "`" + t.quasis[0]
            t.types.forEach((x, i) => { out += "${" + formatType(x) + "}" + t.quasis[i + 1] })
            return out + "`"
        }
        case "indexedAccess": return `${formatAtom(t.objectType)}[${formatType(t.indexType)}]`
        case "infer": return t.constraint ? `infer ${t.name} extends ${formatType(t.constraint)}` : `infer ${t.name}`
        case "spread": return `...${formatAtom(t.type)}`
        case "conditional":
            return `${formatAtom(t.checkType)} extends ${formatAtom(t.extendsType)} ? ${formatType(t.trueType)} : ${formatType(t.falseType)}`
        case "mapped": {
            const ro = t.readonly === true ? "readonly " : t.readonly === false ? "-readonly " : ""
            const opt = t.optional === true ? "?" : t.optional === false ? "-?" : ""
            const as = t.nameType ? ` as ${formatType(t.nameType)}` : ""
            return `{ ${ro}[${t.parameter} in ${formatType(t.constraint)}${as}]${opt}: ${formatType(t.template)} }`
        }
    }
}

/** `v is string` / `asserts v` — the return position of a type guard. */
function formatPredicate(t: FunctionType): string | undefined {
    const p = t.predicate
    if (!p) return undefined
    const name = t.params[p.param]?.name ?? `arg${p.param}`
    const head = p.asserts ? "asserts " : p.implies ? "implies " : ""
    return p.type ? `${head}${name} is ${formatType(p.type)}` : `${head}${name}`
}

function formatAtom(t: Type): string {
    // A named intersection prints as a bare alias name, so it needs no parens.
    if (t.kind === "intersection" && t.name) return t.name
    if (t.kind === "union" || t.kind === "intersection" || t.kind === "function" ||
        t.kind === "conditional") {
        return `(${formatType(t)})`
    }
    return formatType(t)
}

const IDENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
function formatKey(k: string): string {
    return IDENT_KEY.test(k) ? k : JSON.stringify(k)
}

/** The object members of an intersection merged into one object: every
 *  property of every member, with a property several members declare getting
 *  the intersection of their types. Aliases are seen through. `undefined` when
 *  a member is not an object (a function, a primitive), since merging would
 *  then lose what that member means. */
function mergeObjectMembers(types: readonly Type[]): ObjectType | undefined {
    const objects: ObjectType[] = []
    const seen = new Set<Type>()
    const collect = (t: Type): boolean => {
        if (seen.has(t)) return true
        seen.add(t)
        if (t.kind === "genericRef") {
            const expanded = expandAlias?.(t)
            return expanded !== undefined && expanded !== t && collect(expanded)
        }
        if (t.kind === "intersection") return t.types.every(collect)
        // A class's members merged with anything else would be a plain
        // table, which the class is not.
        if (t.kind === "object" && !t.class) {
            objects.push(t)
            return true
        }
        return false
    }
    if (!types.every(collect) || objects.length < 2) return undefined

    const properties = new Map<string, ObjectProperty>()
    let indexer: ObjectType["indexer"]
    for (const object of objects) {
        indexer ??= object.indexer
        for (const [name, property] of object.properties) {
            const existing = properties.get(name)
            properties.set(name, existing
                ? {
                    type: intersection([existing.type, property.type]),
                    optional: existing.optional && property.optional,
                    readonly: existing.readonly || property.readonly,
                }
                : property)
        }
    }
    return objectType([...properties], indexer)
}
