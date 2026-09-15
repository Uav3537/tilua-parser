import { parse } from "./builders"
import type { Program } from "./nodes"

/**
 * The types that belong to the language itself, available in every file with
 * or without a type library — as TypeScript's `Partial` and `ReturnType` are.
 *
 * They are written in tilua on top of `keyof`, `T[K]`, conditional types with
 * `infer`, mapped types and set difference; the analyzer knows none of these
 * names. A type library or the file itself may declare one of them again, and
 * that declaration wins.
 *
 * What a runtime provides — `print`, `string`, `game` — is not here: that is a
 * type library's job (`@tilua-types/lua`, `@tilua-types/roblox`).
 *
 * The methods an array and a string answer to — `names:filter(f)`,
 * `text:trim()` — are a library's too. `propertyType` reads them from types
 * named `ArrayMethods<T>` and `StringMethods`, whichever library declares
 * those; the library also says which of them the compiler must emit code for
 * (`tilua.methods` in its package.json). Nothing about `filter` is written
 * into the analyzer.
 */
export const PRELUDE_SOURCE = `
-- In Luau only \`nil\` and \`false\` are falsy: \`0\` and \`""\` are truthy.
-- These are what truthiness narrowing computes, made available to write down.
type Falsy = nil | false
type Truthy<T> = T - Falsy

-- \`-\` is set difference. Over a union it drops members; over a concrete type
-- it simplifies away; over an opaque type (\`unknown\`, an unresolved parameter)
-- it is kept, so \`Exclude<unknown, 1>\` stays \`unknown - 1\`.
type Exclude<T, U> = T - U
type Extract<T, U> = T extends U ? T : never
type NonNullable<T> = T - nil

type ReturnType<T> = T extends (...unknown) => infer R ? R : never
type Parameters<T> = T extends (...infer P) => unknown ? P : never

type Partial<T> = { [K in keyof T]?: T[K] }
type Required<T> = { [K in keyof T]-?: T[K] }
type Readonly<T> = { readonly [K in keyof T]: T[K] }
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

type Pick<T, K> = { [P in K]: T[P] }
type Omit<T, K> = Pick<T, Exclude<keyof T, K>>
type Record<K, V> = { [P in K]: V }
`

let prelude: Program | undefined

/** The prelude, parsed once. */
export function preludeProgram(): Program {
    return (prelude ??= parse(PRELUDE_SOURCE))
}
