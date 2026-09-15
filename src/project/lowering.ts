/**
 * The contract between a type library and the compiler.
 *
 * A library's definitions file says what a value *is*; when what it gives is
 * not something the value already answers to, the library must also say how
 * it runs. `names:filter(f)` is a call to a function because `@tilua-types/lua`
 * declares the method and ships the Luau behind it — the compiler lowers the
 * language (`import`, `export`, `?.`, `a ? b : c`, destructuring, spreads)
 * and asks a library about everything else.
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
 *         methodCall({ method, receiver, use }) {
 *             if (receiver?.kind === "array" && method === "filter") {
 *                 return { callee: `${use("array")}.filter` }
 *             }
 *             return undefined
 *         },
 *     }
 *     export default plugin
 */
import type { Type } from "../ast/typeModel"

export interface LoweringPlugin {
    /** Luau the plugin needs in the output, by a key it chooses. Each is a
     *  file's worth of source with `__NAME__` standing for the local the
     *  compiler gives it, and each is emitted once, at the top of the output,
     *  only if `use` asked for it:
     *
     *      local __NAME__ = {}
     *      function __NAME__.filter(t, test) ... end
     */
    readonly runtime?: Readonly<Record<string, string>>

    /** What `receiver:method(...)` becomes. `undefined` leaves a plain Luau
     *  method call, which is what a value that answers to the method itself
     *  wants — `text:upper()` reaches Lua's own. */
    methodCall?(call: MethodCall): MethodLowering | undefined
}

export interface MethodCall {
    /** The name written after `:`. */
    readonly method: string
    /** The receiver's type, as the analyzer worked it out. `undefined` when
     *  nothing typed it, where a plugin should decline rather than guess. */
    readonly receiver: Type | undefined
    /** How many arguments were written. */
    readonly argumentCount: number
    /** The local name the output gives one of `runtime`'s entries, emitting
     *  it if this is the first call that needed it. */
    use(runtime: string): string
}

export interface MethodLowering {
    /** What to call instead: a name, or a `table.member` path — usually built
     *  from `use(...)`. */
    readonly callee: string
    /** Pass the receiver as the first argument. Default: yes. */
    readonly passReceiver?: boolean
}
