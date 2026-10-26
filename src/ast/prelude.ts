import { parse } from "./builders"
import type { Program } from "./nodes"

/**
 * The types that belong to the language itself, available in every file with
 * or without a type library — as TypeScript's `Partial` and `ReturnType` are.
 *
 * They are written in tilua on top of `keyof`, `T[K]`, conditional types with
 * `infer`, mapped types and `Exclude`; the analyzer knows none of these
 * names but `Exclude`. A type library or the file itself may declare one of them again, and
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
type Truthy<T> = Exclude<T, Falsy>

-- \`Exclude<T, U>\` is the analyzer's own: what of \`T\` is not a \`U\`. Over a
-- union it drops the members it takes whole; over \`unknown\`, \`any\`, a
-- primitive or an unresolved parameter it is kept — \`Exclude<string, "a">\` is
-- a string that is not \`"a"\` — unlike TypeScript's.
type Extract<T, U> = T extends U ? T : never
type NonNullable<T> = Exclude<T, nil>

type ReturnType<T> = T extends (...args: unknown[]) => infer R ? R : never
type Parameters<T> = T extends (...args: infer P) => unknown ? P : never

type Partial<T> = { [K in keyof T]?: T[K] }
type Required<T> = { [K in keyof T]-?: T[K] }
type Readonly<T> = { readonly [K in keyof T]: T[K] }
type Mutable<T> = { -readonly [K in keyof T]: T[K] }

-- A class table builds with \`new\`: \`InstanceType<typeof Dog>\` is a \`Dog\`.
type InstanceType<T> = T extends { new: (...args: any[]) => infer R } ? R : never
type ConstructorParameters<T> = T extends { new: (...args: infer P) => any } ? P : never

-- A list's positions, values and \`[position, value]\` pairs, each a new list:
-- a tuple's place by place, an array's as arrays.
type ListKeys<L> = { -readonly [K in keyof L]: K }
type MappedList<L, U> = { -readonly [K in keyof L]: U }
type ListValues<L> = { -readonly [K in keyof L]: L[K] }
type ListEntries<L> = { -readonly [K in keyof L]: [K, L[K]] }

-- The object a list of \`[key, value]\` pairs makes: each pair's key holding
-- that pair's value. The pairs of a list of any length may each be missing.
type EntriesObject<L> = {
    [E in L[number] as E extends readonly [infer K, unknown] ? K : never]: E extends readonly [unknown, infer V] ? V : never
}
type FromEntries<L> = L extends readonly unknown[]
    ? number extends L["length"] ? Partial<EntriesObject<L>> : EntriesObject<L>
    : never

-- \`Pick\` takes only keys \`T\` has: \`Pick<User, "typo">\` is an error. \`Omit\`
-- takes any, as TypeScript's does.
type Pick<T, K extends keyof T> = { [P in K]: T[P] }
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
-- The ones that only read take a \`readonly T[]\` too — \`as const\` lists, and
-- what a function promised not to change — as TypeScript's \`ReadonlyArray\`.
-- A \`filter\` whose test is a guard — \`v is S\`, or \`v => v ~= nil\` —
-- answers an array of what it let through.
declare metatable<T> T[]: {
    __index: {
        find: (self: readonly T[], test: (value: T, index: number) => boolean) => T | nil,
        findIndex: (self: readonly T[], test: (value: T, index: number) => boolean) => number | nil,
        filter: (<S extends T>(self: readonly T[], test: (value: T, index: number) => implies value is S) => S[])
            & ((self: readonly T[], test: (value: T, index: number) => boolean) => T[]),
        -- A tuple maps to a tuple as long: \`[1, 2]:map(f)\` is \`[U, U]\`.
        map: <U, L extends readonly T[]>(self: L, transform: (value: T, index: number) => U) => MappedList<L, U>,
        -- What \`visit\` answers is thrown away, so it may answer anything:
        -- \`xs:forEach(x => out:push(x))\`, as TypeScript's \`void\` allows.
        forEach: (self: readonly T[], visit: (value: T, index: number) => unknown) => void,
        some: (self: readonly T[], test: (value: T, index: number) => boolean) => boolean,
        every: (self: readonly T[], test: (value: T, index: number) => boolean) => boolean,
        reduce: <U>(self: readonly T[], step: (total: U, value: T, index: number) => U, initial: U) => U,
        -- Asking is not adding: any value may be looked for, and finding it
        -- says it is one of the array's — \`if (names:includes(s))\` narrows \`s\`.
        -- Not finding it says nothing: \`s\` may still be a string not listed.
        includes: (self: readonly T[], value: unknown) => implies value is T,
        indexOf: (self: readonly T[], value: unknown, start?: number) => number | nil,
        join: (self: readonly T[], separator?: string) => string,
        concat: <U>(self: readonly T[], ...others: (readonly U[])[]) => (T | U)[],
        slice: (self: readonly T[], start?: number, stop?: number) => T[],
        flat: (self: readonly T[]) => T[],
        -- JavaScript's, as arrays rather than iterators: \`for (const [i, v] in
        -- xs:entries())\` walks positions and values, counting from 1. Unlike
        -- JavaScript's they say all that is known: of a tuple, its positions
        -- and what each holds — \`["a", 1] as const\` has keys \`[1, 2]\` and
        -- entries \`[[1, "a"], [2, 1]]\`; of an array, \`number[]\`, \`T[]\`
        -- and \`[number, T][]\`.
        keys: <L extends readonly T[]>(self: L) => ListKeys<L>,
        values: <L extends readonly T[]>(self: L) => ListValues<L>,
        entries: <L extends readonly T[]>(self: L) => ListEntries<L>,
        -- JavaScript's \`Object.fromEntries\`, as a method of the list it takes:
        -- \`[["a", 1], ["b", 2]]:fromEntries()\` is \`{ a: 1, b: 2 }\`. A tuple's
        -- entries are each there; an array's may be or not, so its keys are
        -- optional — and a key that is a plain \`string\` makes an indexer.
        fromEntries: <L extends readonly (readonly [unknown, unknown])[]>(self: L) => FromEntries<L>,
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
--
-- The rest are JavaScript's \`Object\` functions, written as methods of the
-- table they take first:
--
--     point:hasOwn("x")           -- Object.hasOwn(point, "x")
--     point:assign({ z: 3 })      -- Object.assign(point, { z: 3 })
--     point:freeze()              -- Object.freeze(point)
--
-- \`hasOwn\` asks the table itself, not what its metatable's \`__index\`
-- lends it. \`assign\` copies each source's members onto the table, later ones
-- over earlier ones, skipping a \`nil\` source, and answers the table. \`freeze\`
-- is Luau's \`table.freeze\`; under Lua 5.1, which cannot freeze a table, the
-- table is answered as it is and \`isFrozen\` is false.
declare metatable<T extends {}> T: {
    __index: {
        keys: (self: T) => ObjectKeys<T>,
        values: (self: T) => ObjectValues<T>,
        entries: (self: T) => ObjectEntries<T>,

        hasOwn: (self: T, key: unknown) => boolean,
        hasOwnProperty: (self: T, key: unknown) => boolean,
        assign: (<U>(self: T, source: U) => T & U)
            & (<U, V>(self: T, a: U, b: V) => T & U & V)
            & (<U, V, W>(self: T, a: U, b: V, c: W) => T & U & V & W)
            -- Generic like the rest: a plain signature would be tried first.
            & (<S extends {}>(self: T, ...sources: (S | nil)[]) => T),
        freeze: (self: T) => Readonly<T>,
        isFrozen: (self: T) => boolean,
    },
}
`

let prelude: Program | undefined

/** The prelude, parsed once. */
export function preludeProgram(): Program {
    return (prelude ??= parse(PRELUDE_SOURCE))
}
