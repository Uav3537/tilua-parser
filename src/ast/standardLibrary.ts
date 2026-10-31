import { parse } from "./builders"
import type { DeclareStatement, Program } from "./nodes"

/**
 * The Lua 5.1 standard library, always there — as TypeScript always has
 * JavaScript's. `print`, `pairs`, `string`, `math`, `table`, `pcall`,
 * `console`: every file can name them with no type library listed in
 * `tilua.config.json`. A project that wants none of it says `"noLib": true`.
 *
 * It is a type library like any other, loaded before the ones a project
 * lists — so `@tilua-types/roblox` adds Luau's and Roblox's on top of it —
 * and what it declares runs as Lua's own, except where Lua answers several
 * values: the compiler lowers those (`pcall`, `string.find`, ...) and the
 * console, in its `standard` lowering.
 *
 * `@tilua-types/lua`, where this used to live, is not loaded when a project
 * still names it: it would declare everything twice.
 */
export const STANDARD_LIBRARY_SOURCE = `
-- The Lua 5.1 standard library, written in tilua.
--
-- This is the floor every tilua project stands on, the way TypeScript stands
-- on JavaScript's: the functions and libraries Lua itself defines, there in
-- every file without being asked for. Nothing here is Luau's or Roblox's —
-- \`buffer\`, \`table.create\` and the rest live one layer up in
-- \`@tilua-types/roblox\`, which adds to it.
--
-- Lua's \`type()\` is not here: what a value is, is asked with the language's
-- own \`typeof v\`, which also tells an array from an object.
--
-- Adding to it is literal: a name declared again in a later file keeps what
-- earlier files gave it. \`declare table: { find: ... }\` in \`@tilua-types/roblox\` does
-- not replace this \`table\`, it extends it, and overloads of a function
-- accumulate the same way. So the layers really are layers.

-- ============================================================
-- Base library
-- ============================================================

declare _G: { [string]: unknown }
declare _VERSION: string

declare function require(module: unknown): unknown
declare function tostring(value: unknown): string
declare function tonumber(value: unknown, base?: number): number | nil
declare function print(...args: unknown[]): void
-- \`error\` never returns, which is what lets
-- \`if v == nil then error("...") end\` narrow the rest of the block.
declare function error(message: unknown, level?: number): never

-- \`asserts value\` — narrows the *rest of the enclosing block*, the way
-- TypeScript's assertion signatures do:
--
--     const part = workspace:FindFirstChild("Part")  -- Instance | nil
--     assert(part)
--     part.Name                                      -- Instance, no \`?\`

declare function assert<T>(value: T, message?: string): asserts value

-- \`pcall\` and \`xpcall\` answer the way a JavaScript result object does:
--
--     const { success, data, error } = pcall(load, "config")
--     if (success) { use(data) } else { warn(error) }
--
-- \`data\` is what the function returned. These are not Luau's own \`pcall\`:
-- where Luau answers several values, tilua has one, and the compiler puts its
-- own functions in place of those globals (runtime/result.luau) — for calls,
-- and for the global read as a value alike. The same goes for \`string.find\`,
-- \`string.match\`, \`string.gsub\`, \`string.byte\`, \`math.modf\`, \`math.frexp\`,
-- \`next\`, \`select\`, \`unpack\`, \`loadstring\`, \`pairs\`, \`ipairs\` and
-- \`string.gmatch\` below.
type PcallResult<T> = { success: true, data: T, error: nil } | { success: false, data: nil, error: unknown }

declare function pcall<A extends unknown[], T>(fn: (...args: A) => T, ...args: A): PcallResult<T>
declare function xpcall<A extends unknown[], T>(fn: (...args: A) => T, handler: (err: unknown) => unknown, ...args: A): PcallResult<T>
-- \`select("#", ...args)\` counts; \`select(n, ...args)\` is what follows the
-- n-th, as an array.
declare function select(n: "#", ...args: unknown[]): number
declare function select<T>(n: number, ...args: T[]): T[]
-- A copy of the list, or of part of it.
declare function unpack<V>(list: readonly V[], i?: number, j?: number): V[]
declare function rawget(t: unknown, key: unknown): unknown
declare function rawset<T>(t: T, key: unknown, value: unknown): T
declare function rawequal(a: unknown, b: unknown): boolean
-- What a metatable may hold, for a table of type T.
type Metatable<T> = {
    __index?: object | ((self: T, key: any) => unknown),
    __newindex?: object | ((self: T, key: any, value: any) => void),
    __call?: (self: T, ...args: any[]) => unknown,
    __add?: (a: any, b: any) => unknown,
    __sub?: (a: any, b: any) => unknown,
    __mul?: (a: any, b: any) => unknown,
    __div?: (a: any, b: any) => unknown,
    __idiv?: (a: any, b: any) => unknown,
    __mod?: (a: any, b: any) => unknown,
    __pow?: (a: any, b: any) => unknown,
    __concat?: (a: any, b: any) => unknown,
    __unm?: (self: T) => unknown,
    __len?: (self: T) => number,
    __eq?: (a: T, b: T) => boolean,
    __lt?: (a: any, b: any) => boolean,
    __le?: (a: any, b: any) => boolean,
    __tostring?: (self: T) => string,
    __iter?: (self: T) => unknown,
    __mode?: "k" | "v" | "kv",
    __metatable?: unknown,
}
-- A table with its metatable: what it holds, what __index gives it, what
-- __newindex takes, and the metamethods operators and calls read.
type WithMetatable<T, M> = T
    & (M extends { __index: infer I } ? (I extends (...args: any[]) => infer R ? { [string]: R } : I) : {})
    & (M extends { __newindex: (self: any, key: any, value: infer V) => unknown } ? { [string]: V } : {})
    & Omit<M, "__index" | "__newindex" | "__mode" | "__metatable">
-- nil takes the metatable away.
declare function setmetatable<T>(t: T, mt: nil): T
declare function setmetatable<T, M extends Metatable<T>>(t: T, mt: M): WithMetatable<T, M>
declare function getmetatable(t: unknown): unknown
declare function newproxy(addMeta?: boolean): unknown
-- The entry after \`key\` — or nil, past the last one.
declare function next<K, V>(t: { [K]: V }, key?: K): [K, V] | nil

-- What \`for (const item of source)\` walks: \`step\` is called with the state
-- and the item before it — \`first\` the first time — until it answers nil.
-- An array, a table and an iterator function are walked too, so this is only
-- what a source such as \`pairs(t)\` hands over.
type Iteration<S, T> = [(state: S, previous: T | nil) => T | nil, S, T | nil]

-- \`for (const [k, v] of pairs(t))\` / \`ipairs(t)\`: each item is one \`[key,
-- value]\` — a table, as every array is. The analyzer types it from \`t\` itself
-- (a record's keys as literals, an array's elements); these declare the
-- names, and their shape for any other use. Walking a list only reads it, so
-- a read-only one (\`as const\`, \`readonly T[]\`) is walked as well.
declare function pairs<V>(t: readonly V[]): Iteration<readonly V[], [number, V]>
declare function pairs<K, V>(t: { [K]: V }): Iteration<{ [K]: V }, [K, V]>
declare function ipairs<V>(t: readonly V[]): Iteration<readonly V[], [number, V]>

declare function collectgarbage(option: "count"): number
declare function gcinfo(): number
declare function getfenv(target?: unknown): { [string]: unknown }
declare function setfenv<T>(target: T, env: { [string]: unknown }): T
declare function loadstring(source: string, chunkname?: string): [((...args: unknown[]) => unknown) | nil, string | nil]

declare debug: {
    traceback: (message?: string, level?: number) => string,
}

declare string: {
    format: (fmt: string, ...args: unknown[]) => string,
    sub: (s: string, i: number, j?: number) => string,
    len: (s: string) => number,
    upper: (s: string) => string,
    lower: (s: string) => string,
    rep: (s: string, n: number, sep?: string) => string,
    reverse: (s: string) => string,
    -- Where the pattern is, then what it captured — or nil.
    find: (s: string, pattern: string, init?: number, plain?: boolean) => [number, number, ...string[]] | nil,
    -- What it captured (the whole match when there are no captures), as
    -- JavaScript's \`match\` answers — or nil.
    match: (s: string, pattern: string, init?: number) => [...string[]] | nil,
    -- Each match's captures (the whole match when there are none), one
    -- array at a time: \`for (const [word] of s:gmatch("%a+"))\`.
    gmatch: (s: string, pattern: string) => () => [string, ...string[]] | nil,
    -- The new string, as JavaScript's \`replace\` answers; Luau's count of
    -- replacements is left behind.
    gsub: (s: string, pattern: string, repl: unknown, n?: number) => string,
    -- One code for one position; an array of them for a range.
    byte: ((s: string, i?: number) => number) & ((s: string, i: number, j: number) => number[]),
    char: (...args: number[]) => string,
}

declare math: {
    abs: (x: number) => number,
    floor: (x: number) => number,
    ceil: (x: number) => number,
    fmod: (x: number, y: number) => number,
    modf: (x: number) => [number, number],
    sqrt: (x: number) => number,
    pow: (x: number, y: number) => number,
    exp: (x: number) => number,
    log: (x: number, base?: number) => number,
    log10: (x: number) => number,
    frexp: (x: number) => [number, number],
    ldexp: (m: number, e: number) => number,
    min: (...args: number[]) => number,
    max: (...args: number[]) => number, 
    sin: (x: number) => number,
    cos: (x: number) => number,
    tan: (x: number) => number,
    asin: (x: number) => number,
    acos: (x: number) => number,
    atan: (x: number) => number,
    atan2: (y: number, x: number) => number,
    sinh: (x: number) => number,
    cosh: (x: number) => number,
    tanh: (x: number) => number,
    rad: (deg: number) => number,
    deg: (rad: number) => number,
    random: (m?: number, n?: number) => number,
    randomseed: (x: number) => void,
    huge: number,
    pi: number,
}


declare table: {
    -- \`insert(t, v)\` appends; \`insert(t, pos, v)\` puts it there.
    insert: (<T>(t: T[], value: T) => void) & (<T>(t: T[], pos: number, value: T) => void),
    remove: <T>(t: T[], pos?: number) => T | nil,
    concat: (t: readonly (string | number)[], sep?: string, i?: number, j?: number) => string,
    sort: <T>(t: T[], compare?: (a: T, b: T) => boolean) => void,
    -- Lua 5.1's originals. Deprecated there and gone from 5.2 on, but Luau
    -- still answers to them, so code being ported still type-checks.
    getn: <T>(t: readonly T[]) => number,
    maxn: <T>(t: readonly T[]) => number,
    foreach: <K, V, R>(t: { [K]: V }, f: (key: K, value: V) => R) => R | nil,
    foreachi: <V, R>(t: readonly V[], f: (index: number, value: V) => R) => R | nil,
}

declare os: {
    time: (t?: unknown) => number,
    clock: () => number,
    date: (format?: string, time?: number) => unknown,
    difftime: (a: number, b: number) => number,
}

declare coroutine: {
    create: (fn: (...args: unknown[]) => unknown) => thread,
    -- Answers like \`pcall\`: \`{ success, data, error }\`, \`data\` what the
    -- coroutine yielded or returned.
    resume: (co: thread, ...args: unknown[]) => PcallResult<unknown>,
    yield: (...args: unknown[]) => unknown,
    wrap: (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => unknown,
    status: (co: thread) => string,
    running: () => thread,
}

-- A string's, an array's and a table's methods — \`text:trim()\`,
-- \`names:filter(f)\`, \`point:keys()\` — are the language's: their metatables
-- are declared in @tilua/parser's prelude, and the compiler runs them. A
-- library adds to one with \`declare metatable\` of the same target, as
-- \`@tilua-types/roblox\` gives a string Luau's \`split\`.

-- The console. Written with \`:\` — \`console:log(value)\` — and lowered by the
-- compiler (standard.ts) into runtime/console.luau, not into \`print\`.
--
-- Every line starts with the place that called it: \`[src/main:12]: ...\`.
-- \`print\` and \`warn\` are left as written; \`error\` puts \`src/main.tilua:12:\` in
-- its message, as Lua does.
--
-- \`log\` expands what it is given the way a browser console does: a table is
-- printed as its contents, not as an address. A function prints as the type it
-- was inferred to have *and* the code it was written as, both of which the
-- compiler passes along, since neither exists once the code is running.
--
-- \`error\` reports in the project's own files: a bundle is one Luau file, so
-- Luau's own line numbers name a file nobody wrote. It does not raise on the
-- calling thread — the error goes to \`task.spawn\`, so reporting a problem
-- never becomes one.
type Console = {
    log: (self: Console, ...args: unknown[]) => void,
    warn: (self: Console, ...args: unknown[]) => void,
    error: (self: Console, ...args: unknown[]) => void,
}

declare console: Console
`

let standard: Program | undefined

/** The standard library, parsed once. */
export function standardLibrary(): Program {
    return (standard ??= parse(STANDARD_LIBRARY_SOURCE))
}

let names: readonly string[] | undefined

/** The globals the standard library declares: `print`, `string`, ... */
export function standardGlobals(): readonly string[] {
    return (names ??= [...new Set(standardLibrary().body.statements
        .filter((s): s is DeclareStatement => s.type === "DeclareStatement")
        .map(s => s.name))])
}
