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
 * Strings, arrays and tables are the language's own, so the metatables they
 * answer to are declared here too — `declare metatable`, in tilua, the way a
 * library declares one. A string's is Lua's (`upper`, `sub`) with tilua's
 * answers where Lua's are several values (`find` is an array); the rest —
 * `names:filter(f)`, `text:trim()`, `point:keys()` — no Lua value really
 * has, and the compiler lowers each call to a function of its own runtime.
 * A library adds to any of them by declaring the same target again.
 *
 * The analyzer supplies only what no type can compute: `ObjectKeys<T>`,
 * `ObjectValues<T>` and `ObjectEntries<T>`, an object's members as tuples in
 * the order they were written.
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

type ReturnType<T> = T extends (...args: unknown[]) => infer R ? R : never
type Parameters<T> = T extends (...args: infer P) => unknown ? P : never

type Partial<T> = { [K in keyof T]?: T[K] }
type Required<T> = { [K in keyof T]-?: T[K] }
type Readonly<T> = { readonly [K in keyof T]: T[K] }
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

type Pick<T, K> = { [P in K]: T[P] }
type Omit<T, K> = Pick<T, Exclude<keyof T, K>>
type Record<K, V> = { [P in K]: V }

-- ============================================================
-- The metatables of the language's own values
-- ============================================================

-- A string's methods. The first group is Lua's string library, which a
-- string really answers to; where Lua answers several values, tilua answers
-- one, as the global functions do (\`find\` is an array, \`gsub\` the new
-- string). The second group is written the way JavaScript writes it.
--
-- Positions are Lua's: \`sub\` and \`slice\` count from 1, and \`indexOf\` is
-- \`nil\` when the text is not there.
declare metatable string: {
    __index: {
        upper: (self: string) => string,
        lower: (self: string) => string,
        len: (self: string) => number,
        sub: (self: string, i: number, j?: number) => string,
        rep: (self: string, n: number, separator?: string) => string,
        reverse: (self: string) => string,
        format: (self: string, ...args: unknown[]) => string,
        byte: ((self: string, i?: number) => number) & ((self: string, i: number, j: number) => number[]),
        find: (self: string, pattern: string, init?: number, plain?: boolean) => [number, number, ...string[]] | nil,
        match: (self: string, pattern: string, init?: number) => [...string[]] | nil,
        gmatch: (self: string, pattern: string) => () => [string, ...string[]] | nil,
        gsub: (self: string, pattern: string, replacement: unknown, n?: number) => string,

        trim: (self: string) => string,
        trimStart: (self: string) => string,
        trimEnd: (self: string) => string,
        startsWith: (self: string, text: string) => boolean,
        endsWith: (self: string, text: string) => boolean,
        includes: (self: string, text: string) => boolean,
        indexOf: (self: string, text: string, start?: number) => number | nil,
        slice: (self: string, start?: number, stop?: number) => string,
        replace: (self: string, text: string, replacement: string) => string,
        replaceAll: (self: string, text: string, replacement: string) => string,
        padStart: (self: string, length: number, padding?: string) => string,
        padEnd: (self: string, length: number, padding?: string) => string,
    },
}

-- An array's methods. Lua gives an array no metatable: the compiler lowers
-- each call to a plain function, so they work on any array, one a Lua
-- library made included.
--
-- Indices are Lua's: the first element is 1, and \`indexOf\` / \`findIndex\`
-- answer \`nil\` rather than JavaScript's -1. \`sort\` takes Lua's comparator
-- (true when \`a\` comes first). \`push\`, \`pop\`, \`shift\`, \`unshift\`,
-- \`sort\` and \`reverse\` change the array; everything else returns a new one.
declare metatable<T> T[]: {
    __index: {
        find: (self: T[], test: (value: T, index: number) => boolean) => T | nil,
        findIndex: (self: T[], test: (value: T, index: number) => boolean) => number | nil,
        filter: (self: T[], test: (value: T, index: number) => boolean) => T[],
        map: <U>(self: T[], transform: (value: T, index: number) => U) => U[],
        forEach: (self: T[], visit: (value: T, index: number) => nil) => nil,
        some: (self: T[], test: (value: T, index: number) => boolean) => boolean,
        every: (self: T[], test: (value: T, index: number) => boolean) => boolean,
        reduce: <U>(self: T[], step: (total: U, value: T, index: number) => U, initial: U) => U,
        includes: (self: T[], value: T) => boolean,
        indexOf: (self: T[], value: T, start?: number) => number | nil,
        join: (self: T[], separator?: string) => string,
        concat: (self: T[], ...others: T[][]) => T[],
        slice: (self: T[], start?: number, stop?: number) => T[],
        flat: (self: T[]) => T[],
        reverse: (self: T[]) => T[],
        sort: (self: T[], compare?: (a: T, b: T) => boolean) => T[],
        push: (self: T[], ...args: T[]) => number,
        pop: (self: T[]) => T | nil,
        shift: (self: T[]) => T | nil,
        unshift: (self: T[], ...args: T[]) => number,
    },
}

-- A table's methods. Unlike JavaScript's \`Object.keys\`, they answer a
-- tuple, in the order the table's type wrote its members:
--
--     const point = { x: 1, y: "up" }
--     point:keys()     -- ["x", "y"]
--     point:values()   -- [number, string]
--     point:entries()  -- [["x", number], ["y", string]]
--
-- A Lua table has no order of its own, so the compiler hands its runtime the
-- keys as the type lists them. An optional member keeps its place, holding
-- \`nil\` when it is missing; an indexer's keys follow the named ones. A
-- member of the table's own with one of these names is what a call reaches,
-- and a class instance, which has a metatable of its own, has none of them.
declare metatable<T extends {}> T: {
    __index: {
        keys: (self: T) => ObjectKeys<T>,
        values: (self: T) => ObjectValues<T>,
        entries: (self: T) => ObjectEntries<T>,
    },
}
`

let prelude: Program | undefined

/** The prelude, parsed once. */
export function preludeProgram(): Program {
    return (prelude ??= parse(PRELUDE_SOURCE))
}
