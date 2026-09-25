/**
 * Questions a lowering plugin asks of a type, answered once here.
 *
 * A plugin decides how to lower a call from the receiver's or an argument's
 * type (see `LoweringPlugin`). The same few questions come up in every one —
 * is it a function, is it an instance of this class, what does this method
 * return — and a plugin imports these rather than walking the type model
 * itself:
 *
 *     import { isInstanceOf } from "@tilua/parser"
 *
 * Each looks through a union with `nil` (`Part | nil`): whether the value may
 * be missing is a check the analyzer asked for elsewhere, not a reason to
 * lower differently.
 */
import type { ObjectType, Type } from "./ast/typeModel"

/** The members of `type` that are not `nil`: `[A, B]` for `A | B | nil`,
 *  `[T]` for any other `T`, and `[]` for `undefined` or `nil` alone. */
export function withoutNil(type: Type | undefined): Type[] {
    if (!type) return []
    const members = type.kind === "union" ? type.types : [type]
    return members.filter(m => !(m.kind === "primitive" && m.name === "nil"))
}

/** A function, or an overloaded one (an intersection of functions). */
export function isFunctionType(type: Type | undefined): boolean {
    const members = withoutNil(type)
    return members.length > 0 && members.every(m =>
        m.kind === "function" || (m.kind === "intersection" && m.types.every(isFunctionType)))
}

/** Every member an object — a table or a class instance — for `test` to judge. */
function everyObject(type: Type | undefined, test: (object: ObjectType) => boolean): boolean {
    const members = withoutNil(type)
    return members.length > 0 && members.every(m => m.kind === "object" && test(m))
}

/** An instance of `className` or of a class extending it: a `Part` is an
 *  instance of `BasePart` and of `Instance`. */
export function isInstanceOf(type: Type | undefined, className: string): boolean {
    return everyObject(type, m => m.class !== undefined && m.class.ancestors.includes(className))
}

/** Has every one of `names` as a member — a structural check, for a type
 *  known by its shape rather than its class. */
export function hasMembers(type: Type | undefined, names: readonly string[]): boolean {
    return everyObject(type, m => names.every(name => m.properties.has(name)))
}

/** Does every signature of `receiver`'s `method` return a tuple — several
 *  values, as tilua has them in one array? False when the method is missing. */
export function returnsTuple(receiver: Type | undefined, method: string): boolean {
    return everyObject(receiver, m => {
        const found = m.properties.get(method)?.type
        const signatures = !found ? [] : found.kind === "intersection" ? found.types : [found]
        return signatures.length > 0 && signatures.every(f => f.kind === "function" && f.returns.kind === "tuple")
    })
}
