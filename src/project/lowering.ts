/**
 * The contract between a type library and the compiler.
 *
 * A library's definitions file says what a value *is*; when what it gives is
 * not something the value already answers to, the library must also say how
 * it runs. `names:first()` is a call to a function when a library declares
 * `first` in an array's metatable and ships the Luau behind it — the compiler
 * lowers the language (`import`, `export`, `?.`, `a ? b : c`, destructuring,
 * spreads, and the methods of the language's own metatables, such as
 * `names:filter(f)`) and asks a library about what the library declared.
 *
 * These types are declarations only: nothing here runs, and the parser never
 * loads a lowering module. They live here so a library can be checked against
 * the same contract the compiler implements, without depending on the
 * compiler — in TypeScript, or by JSDoc in the JavaScript it ships:
 *
 *     // lowering.mjs, in a type library
 *     // @ts-check
 *     /** @type {import("@tilua/parser").LoweringPlugin} *\/
 *     const plugin = {
 *         runtime: { array: "local __NAME__ = {}\n..." },
 *         methodCall({ method, use }) {
 *             if (method === "first") return { callee: `${use("array")}.first` }
 *             return undefined
 *         },
 *     }
 *     export default plugin
 */
import type { Type } from "../ast/typeModel"

export interface LoweringPlugin {
    /** Luau the plugin needs in the output, by a key it chooses. Each is a
     *  file's worth of source, emitted once, at the top of the output, only if
     *  `use` asked for it. Two names in it are filled in by the compiler:
     *
     *   - `__NAME__`, the local the compiler gives this runtime;
     *   - `__LINES__`, an expression holding the bundle's line map —
     *     `{ [bundleLine] = { "src/a.tilua", sourceLine } }` — or `nil` when
     *     the output is not a bundle. It is what turns a line Luau reports at
     *     runtime back into a place in the project;
     *   - `__FAIL__`, the bundle's error reporter, or `nil` outside a bundle:
     *     a function that takes an error and returns it with the bundle's
     *     positions replaced by the project's, followed by a traceback of
     *     those. It is an `xpcall` handler — the one the entry runs under —
     *     so a runtime that runs a callback on a thread of its own can report
     *     that callback's errors the same way.
     *
     *      local __NAME__ = {}
     *      function __NAME__.first(t) return t[1] end
     */
    readonly runtime?: Readonly<Record<string, string>>

    /** What `receiver:method(...)` becomes. Asked about a method a metatable
     *  gave the receiver only when this library declared that metatable, and
     *  about a method of the receiver's own always. `undefined` leaves a plain Luau
     *  method call, which is what a value that answers to the method itself
     *  wants — `text:upper()` reaches Lua's own. */
    methodCall?(call: MethodCall): MethodLowering | undefined

    /** What a call to a global — `print(...)`, `error(...)` — becomes. Asked
     *  only when the name really is the global: a local the author called
     *  `print` is theirs. `undefined` leaves the call as it was written. */
    globalCall?(call: GlobalCall): CallLowering | undefined

    /** What a global read as a value — `task.spawn(print, x)`, `local p =
     *  print` — becomes: a Luau expression, usually built from `use(...)`.
     *  There is no call site to describe here, so this is where a plugin
     *  that rewrites calls keeps the rest of the program consistent with it. */
    globalValue?(value: GlobalValue): string | undefined
}

/** Where a call was written. */
export interface CallSite {
    /** The file, relative to the project root with `/` separators, or
     *  `undefined` when a single source was compiled with no name. */
    readonly file: string | undefined
    /** 1-based. */
    readonly line: number
    /** 1-based. */
    readonly column: number
}

/** What the compiler knows about one argument that the runtime will not. */
export interface ArgumentInfo {
    /** Its type, as the analyzer worked it out. */
    readonly type: Type | undefined
    /** That type as the editor would show it — `(x: number) => number` —
     *  so a library can print it without depending on this package. */
    readonly typeText: string | undefined
    /** The code it was written as, at the call. */
    readonly source: string
    /** For a name, the code of what it names — the value of `const f = ...`,
     *  or the whole `function f() { ... }` — when this file declares it. */
    readonly declaration?: string
    /** Written `...xs`. */
    readonly spread: boolean
}

interface CallContext {
    /** Where the call was written. */
    readonly at: CallSite
    /** Each written argument, in order. */
    readonly arguments: readonly ArgumentInfo[]
    /** The local name the output gives one of `runtime`'s entries, emitting
     *  it if this is the first call that needed it. */
    use(runtime: string): string
}

export interface MethodCall extends CallContext {
    /** The name written after `:`. */
    readonly method: string
    /** The receiver's type, as the analyzer worked it out. `undefined` when
     *  nothing typed it, where a plugin should decline rather than guess. */
    readonly receiver: Type | undefined
    /** The receiver's name when it is a global — `console` in
     *  `console:log(x)` — and `undefined` for anything else, a local of the
     *  same name included. */
    readonly receiverGlobal: string | undefined
    /** How many arguments were written. */
    readonly argumentCount: number
}

export interface GlobalCall extends CallContext {
    /** The global called. */
    readonly name: string
}

export interface GlobalValue {
    /** The global read. */
    readonly name: string
    readonly at: CallSite
    use(runtime: string): string
}

export interface CallLowering {
    /** What to call instead: a name, or a `table.member` path — usually built
     *  from `use(...)`. */
    readonly callee: string
    /** Luau expressions passed ahead of the written arguments — the call
     *  site, say, or a table of what the compiler knew about them. */
    readonly prepend?: readonly string[]
}

export interface MethodLowering extends CallLowering {
    /** Pass the receiver as the first argument, after `prepend`. Default:
     *  yes. */
    readonly passReceiver?: boolean
}
