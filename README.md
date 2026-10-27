# @tilua/parser

Front end for **tilua** — a TypeScript-flavoured language that compiles to Luau.
Source → tokens → AST → scope analysis → flow-sensitive type analysis.

This package is for people building tools: editors, linters, codemods, a
compiler of your own. It parses and analyses; it never emits. **If you want to
*write* tilua, you want [`@tilua/compiler`][compiler] and the
[VS Code extension][vscode] instead** — though the language reference below is
the same one either way.

| package | for |
|---|---|
| [`@tilua/compiler`][compiler] | building a project to one Luau file |
| [`@tilua/language-server`][server] | editor support over LSP |
| [`@tilua-types/roblox`][roblox], [`@tilua-types/sunc`][sunc] | the globals a project adds to Lua's |
| `@tilua/parser` | this: tokens, AST, scopes, types |

[compiler]: https://www.npmjs.com/package/@tilua/compiler
[server]: https://www.npmjs.com/package/@tilua/language-server
[roblox]: https://www.npmjs.com/package/@tilua-types/roblox
[sunc]: https://www.npmjs.com/package/@tilua-types/sunc
[vscode]: https://marketplace.visualstudio.com/search?term=tilua

```bash
npm install @tilua/parser
```

```ts
import { readFileSync } from "node:fs"
import {
  parse, analyzeScopes, analyzeTypes,
  findConfig, resolveTypeLibraries, resolveModulePath,
} from "@tilua/parser"

// The project the file belongs to, and the type libraries it names.
const { config } = findConfig(file)
const libs = config ? resolveTypeLibraries(config).files.map(f => parse(readFileSync(f, "utf8"))) : []
const globals = libs.flatMap(lib => lib.body.statements.flatMap(s => s.type === "DeclareStatement" ? [s.name] : []))

const program = parse(readFileSync(file, "utf8"))
const scopes  = analyzeScopes(program, { builtinGlobals: globals })
const types   = analyzeTypes(program, scopes, { libs })

for (const d of [...scopes.diagnostics, ...types.diagnostics]) console.log(d.message)
```

## The three passes

| | produces | use it for |
|---|---|---|
| `parse(source)` | `Program` — every node carries `line`/`column` spans | everything |
| `analyzeScopes(program, opts)` | `bindingOf`, `bindings`, `references`, `diagnostics` | go-to-definition, find-references, rename |
| `analyzeTypes(program, scopes, opts)` | `typeOf`, `narrowedTypeOf`, `bindingType`, `typeOfTypeNode`, `expectedTypeOf`, `aliases`, `diagnostics` | hover, completion, type errors |

Every name in the AST has a node with its own span, down to
`DeclareStatement.id`, `TableTypeProperty.key`, `FunctionTypeParameter.id`,
`GenericTypeParameter.id`, `InferTypeNode.id` and
`MappedTypeNode.parameterId`. `typeOfTypeNode` gives what each type
annotation resolves to, and `expectedTypeOf` what each call argument should
be, so a tool never has to re-derive a type from text.

`parseWithRecovery(source)` returns `{ program, errors }` instead of throwing —
use it for editors, where the text is usually mid-edit. An error costs as
little of the tree as it can: a broken value becomes an `ErrorExpression`
(typed `any`) in its place, a broken field or argument is skipped to the next
`,`, a missing comma between fields on separate lines, or a missing `)` or
`}`, is recorded and read past — a missing `}` is placed by indentation — and
an unclosed string ends at its line. Skipping never lets a `}` inside a
skipped function or object close the block around it. Valid code parses to
exactly the same tree as `parse`.

Neither analysis mutates the AST; both return side tables.

## Projects

**Lua's standard library is built in**, as JavaScript's is in TypeScript:
`print`, `pairs`, `pcall`, `string`, `math`, `table`, `os`, `coroutine` and
`console` are there in every file with nothing listed (see
`STANDARD_LIBRARY_SOURCE`), and so are the language's own utility types
(`Partial`, `Pick`, `Omit`, `Record`, `ReturnType`, `Truthy`, ...; see
`PRELUDE_SOURCE`). What a host adds — Luau's and Roblox's `game`, `task`,
`Instance` — a project lists in `tilua.config.json`, the way TypeScript uses
`@types/*`:

```bash
npm i -D @tilua-types/roblox        # Luau + Roblox
```

```jsonc
// tilua.config.json
{
  "types": ["roblox"],                          // on top of Lua's standard library
  "paths": { "@shared/*": ["src/shared/*"] },   // import aliases, as in tsconfig
  "sourceMap": "sourcemap.json"                 // a Rojo sourcemap, or null
}
```

- **Which config applies** — the nearest one in the file's folder or above.
  `tilua.config.json` and `tilua.config.jsonc` in the same folder is an error.
  Both forms accept comments and trailing commas.
- **`types`** — packages are looked for in `node_modules` from the config
  upward. A bare name is `@tilua-types/<name>` first, then the package of that
  name, so a library published under any name works: `"roblox"`,
  `"my-types"`. A scoped name is taken as written (`"@me/types"`), and a `*`
  matches every installed type library it fits (`"@tilua-types/*"`), in name
  order. A relative path (`"./types"`, `"./defs.d.tilua"`) loads the project's
  own definitions. A type library's own type-library dependencies load first;
  one that is not installed is an error. `"lua"` — `@tilua-types/lua`, where
  the standard library used to be — loads nothing: it is already there, and
  a library that still depends on it does not bring it in twice.
- **`treeShaking`** — the compiler's: `true` leaves out of a bundle what the
  entry never reaches. The parser only checks it.
- **`noLib`** — `true` leaves the standard library out, as TypeScript's
  `noLib` does: no `print`, no `string`, only what `types` declares. For a
  host with none of Lua's, or a library of one's own in its place. With it,
  `"lua"` in `types` loads that package as an ordinary library.
- **`paths`** — tsconfig rules: an exact pattern wins, then the `*` pattern
  with the longest prefix; targets resolve from `baseUrl` (default: the
  config's folder).
- **`sourceMap`** — the instance tree becomes types: `game` and `workspace`
  follow it, and a file the tree maps gets its own `script`, so
  `script.Parent.Remotes` is typed. A `.tilua` file matches the Luau file of
  the same path.
- **`output`** — the compiler's: how many files to write (`"single"`, the
  default; `"chunks"`, which also writes a file for what only an `import()`
  reaches; or `"modules"`, one file per module). The parser only checks it.
  Which Lua the output is written for is no option: it is Lua any Lua runs,
  and a type library says what more its Lua has (`"luau"`). A config that
  still sets `target` is told so.

| function | does |
|---|---|
| `findConfig(file, host?)` | the config that applies, problems with it, and every path searched |
| `loadConfig(path, host?)` | read and check one config |
| `resolveTypeLibraries(config, host?)` | the `.d.tilua` files to load, in order |
| `moduleCandidates(from, specifier, config?)` / `resolveModulePath(...)` | what an `import` means |
| `importExpressions(program)` | every `import("...")` written in a file |
| `sourceMapTypes(text, path, { classes })` | the tree's types, and `scriptFor(file)` |

Every problem comes back as `{ file, message, line, column }`, pointing into
the config (or sourcemap) it is about. `host` reads files — pass your own to
read unsaved editor buffers or to record what was read.

`typeof v` is the language's own, an operator like `not` and `#`: it needs no
library, and Lua's `type()` and Luau's `typeof()` functions are declared by
none. It answers Luau's names — `"nil"`, `"boolean"`, `"number"`, `"string"`,
`"function"`, `"thread"`, `"buffer"`, `"userdata"` — except for a table, which
is an `"array"` or an `"object"`. `typeof v == "array"` narrows `v`, and
`== "table"` is an error: it is never the answer. There is no `typeof(v)`
function: written that way it is an error, and a parenthesised operand stands
apart from the operator — `typeof (a or b)`.

What a runtime's own values answer is a library's to say, in one alias:

```ts
type TypeofNames = { Vector3: Vector3, Instance: Instance }
```

Each property is the name `typeof` gives a value of the property's type; a
value several fit (a `Part` is an `Instance`) is the first one's.
`TypeAnalysis.typeofTables` lists each `typeof v` whose `v` is, by its type,
an array or an object wherever it is a table — what a compiler need not find
out as the program runs.

Libraries stack: a name declared again *adds* to what an earlier library gave
it — overloads of a function accumulate, and the members of a declared table
merge. That is how `@tilua-types/roblox` extends Lua's `table` without
restating it.

## The language, in brief

TypeScript syntax and semantics wherever they fit, Lua semantics where they
must.

**Blocks** — braces, and a condition in parentheses:

```luau
if (n < 0) {
    return "negative"
} elseif (n == 0) {
    return "zero"
} else {
    return "positive"
}

while (going) { step() }
for (i = 1, 10) { total += i }
for (const [name, value] of pairs(t)) { print(name, value) }
repeat { step() } until (done)
do { ... }

function greet(name: string): string {
    return `hello ${name}`
}

class Dog extends Animal {
    function speak(): string { return "woof" }
}
```

The parentheses are not decoration: `f {}` is a call with a table argument, so
without them `if ready { ... }` would be a call of `ready` followed by a block.

There is no `end` in tilua, and `then` is not a word it knows.

**One statement instead of a block** — an `if`, an `elseif`, an `else`, a
`while` or a `for` may be written with the single statement it does, no braces,
as TypeScript writes it:

```luau
if (done) return
if (n < 0) return "negative"
elseif (n == 0) return "zero"
else return "positive"

for (const item of items) if (item) print(item)
while (queued > 0) queued -= 1
```

It is a block all the same — what it narrows, and what a `break` or `continue`
in it leaves, end with it — so the early-return form reads exactly as the
braced one does. A declaration may not be written there, as in TypeScript:
nothing could reach the name `if (x) const y = 1` binds, so it is an error
rather than a shorthand. A function body and `do` always take braces.

`and`, `or` and `not` stay words; `{}` is still an object literal everywhere a
value is expected, and `[]` an array.

**Arrows** — one for both, as TypeScript writes them. `(a: number) => string`
is a function type; `(a: number) => a` is a function. Which one a `=>` makes is
decided by where it stands, since a type and a value never share a place.

```luau
type Reducer = (total: number, value: number) => number

const double = (x: number) => x * 2
const add: Reducer = (a, b) => a + b        -- parameters typed by the contract
const shown = (n: number): string => tostring(n)
const identity = <T>(v: T) => v

each(n => print(n))                          -- one parameter needs no parens

const logged = (n: number) => {              -- a block body is a block,
    print(n)                                 -- as in TypeScript,
    return n
}
const wrap = (n: number) => ({ value: n })   -- so an object is parenthesized
```

An arrow is a function expression written short — there is no second kind of
function — so `this` inside one is the `this` of the method around it, which
is what a JavaScript arrow is for.

**Declarations** — `const` and `let` only; Lua's `local` is gone.

What a `let` is first given is its type from then on, as in TypeScript:
`let n = 1` holds numbers, and `n = "a"` is an error. Only a name that starts
out holding nothing — `let x`, `let x = nil` — takes the type of whatever is
put in it later. A `let` declared with a type and no value (`let x: number`)
cannot be read until every way to the read has assigned it — `Variable 'x' is
used before being assigned` — unless its type admits `nil`. A function
written in between may read it: it runs later, when it is called.

**`n++` and `n--`** are `n += 1` and `n -= 1`: statements, as Luau's compound
assignments are, so they give no value and cannot be written inside an
expression. They apply to anything `+=` does — `t.count++`, `xs[i]--` — and
are checked as it is: the operator has to apply, and what it gives has to fit.
`--` is also how a comment starts, so `n--` is the decrement only where the
dashes touch the name (or the `]`) before them and nothing but the end of the
line, a `;`, a `}` or a comment follows; `n-- note` is still `n` and a
comment. `++n` is reported, with the spelling tilua uses.

**Functions** — `function name() { ... }` declares `name` in the enclosing
scope; like a TypeScript function declaration it cannot be reassigned.
`const` and `let` do not apply to functions. `function T.name()` and
`function T:name()` define a member.

**Hoisting** — a function declaration is visible to its whole block, above
itself too, so `let r: ReturnType<typeof load>` may come before `function
load()`. A closure reads the name its own value is bound to, as in JavaScript
(`let m = { clear: function() { m.items = {} } }`), and a later name in the
same block; the compiler declares such a name before the statement that fills
it. A module's top-level names are visible to code that runs later —
function bodies and `typeof` — wherever that code is written, since a bundle
declares them all before the module runs. At the top level the whole function
is hoisted, and can be called above its declaration. Inside a function only
the name is: other functions can call it, but a call straight in the block
above the declaration is an error, because nothing is there yet.

**Returns** — a declared return type is checked: what a `return` gives must
fit it, and a function that declared one must return a value (a guard or an
`asserts` function needs none). The declared type also types what is written
there, so a returned callback takes its parameters from it.

**Overloads** — a `function name(...)` with no body is a signature for the
declaration that follows it, as in TypeScript: the signatures are what a call
sees, and the last one, with the body, is the implementation. `export` goes on
every line of the set or none of them. A parameter of the implementation that
carries no annotation holds what the signatures allow there — under
`get(stat: "hp")` and `get(stat: "name")`, the implementation's `stat` is
`"hp" | "name"` rather than `any`.

**Modules** — `import { a, b as c } from "./m"`, `import D from "./m"` and
`import * as M from "./m"`; `export const`, `export function`, `export default`,
`export { a as b }`, `export { a } from "./m"` and `export * from "./m"`.
Imports are read-only: assigning to an imported name, or to a member of a
namespace (`M.x = 1`), is an error.

`import type { A } from "./m"` (also `import type D` and `import type * as M`)
brings in names that are types and nothing else: unlike TypeScript, using one
as a value is an error, and only type positions — `typeof A` included — may
name it. Compiled code keeps no trace of it.

`import("./m")` is an expression: the module's exports as one value — what
`import * as M from "./m"` names `M` — read where the expression runs rather
than before the file does. The module is loaded the first time anything asks
for it, and the value comes back at once: there is no promise to wait on. The
path has to be a string literal, since which module it is must be known when
the project is built. On a line of its own, `import("./setup")` loads the
module for what it does. `importExpressions(program)` lists every one in a
file.

**Methods of strings, arrays and tables** — a value answers to the methods
its metatable's `__index` has. They are members, as a JavaScript object's
are: read with `.`, a method is a function whose first parameter is its
`self`, handed to it as any argument is. `:` hands it over for you, as Lua's
always has:

```luau
const long = names:filter(n => n.length > 3):map(n => n:upper())
print(names.join(names, ", "), text.trim(text), "abc":upper())
const point = { x: 1, y: "up" }
const [x, y] = point:values()   -- [number, string]
const join = names.join          -- (self: string[], separator?: string) => string
```

`modes.includes(s)` leaves the `self` out, and is reported as that: call it
with `:`. The other way round, `o:f(x)` on a function that takes no receiver
would hand it `o` as `x`, and is reported too. `Stack.push(s, 1)`, which
passes the receiver by hand, is an ordinary call.

**`length`** — `xs.length` is how many a list holds and `text.length` a
string's length: Luau's `#`, which tilua does not have (`#xs` is an error that
says to write `xs.length`). A tuple's is known: `[number, string]` has length
`2`. A table with a `length` of its own is that member, and a class that
declares `__len` answers what `__len` does.

Strings, arrays and tables are the language's own, so their metatables are
too: the prelude declares them, in tilua, and they are there with no type
library at all. A string's is Lua's (`upper`, `sub`, with one value where Lua
answers several: `find` is an array) plus the JavaScript-shaped ones (`trim`,
`startsWith`, ...); an array's is JavaScript's (`filter`, `map`, `join`, ...),
with Lua's indices — the first element is 1, `indexOf` answers `nil` rather
than -1 — and `push`, `pop`, `shift`, `unshift`, `sort` and `reverse` change
the array. Looking for a value is not adding one, so `includes` and `indexOf`
take any value, not only one the array's type already holds — and `includes`
is a guard: `if (modes:includes(s))` narrows `s` to a mode. `concat` may join
arrays of other types (`(T | U)[]`). `keys`, `values` and `entries` answer
arrays rather than JavaScript's iterators — `for (const [i, v] of
xs:entries())` — counting from 1, and say all that is known: a tuple's are
tuples, `["a", 1] as const` having keys `[1, 2]` and entries `[[1, "a"], [2,
1]]`, where an array's are `number[]`, `T[]` and `[number, T][]`. The ones
that only read take a read-only list too (`readonly T[]`, what `as const`
makes), as TypeScript's `ReadonlyArray` does; the ones that change it do not.
`fromEntries` goes the other way, as `Object.fromEntries` does, written as a
method of the list it takes: `[["a", 1], ["b", 2]]:fromEntries()` is `{ a: 1,
b: 2 }` — each pair of a tuple there, each pair of an array maybe, so an
array's keys are optional, and a plain `string` key makes an indexer. So
`stats:entries():map(([k, v]) => [k, v * 2]):fromEntries()` is the stats
doubled, as typed as they were: a destructured callback parameter takes its
type from the call, a list a callback returns where the call reads its result
from is the tuple it is, and `map` keeps a tuple's length. A table's are `keys`, `values` and `entries`, which answer a tuple
in the order the table's type wrote its members, not `string[]` as
JavaScript's `Object.keys` does; the analyzer supplies that order as
`ObjectKeys<T>`, `ObjectValues<T>` and `ObjectEntries<T>`. A member of a
value's own with the same name is what a call reaches, and a class instance,
which has a metatable of its own, has none of them.

No Lua array or table really has these methods, so the compiler lowers each
call into its own runtime (`names.filter(f)` becomes `array.filter(names, f)`);
a string's Lua methods stay plain method calls.

A library adds to a metatable by declaring the same target again, and a
metatable can be declared for any type:

```luau
declare metatable string: { __index: { split: (self: string, separator?: string) => string[] } }
declare metatable<T> T[]: { __index: { first: (self: T[]) => T | nil } }
declare metatable<T extends {}> T: { __index: { size: (self: T) => number } }
```

`<T> T[]` is every array, `T` what it holds; `<T extends C> T` every value
that is a `C`, `T` the value itself; a target with no parameters, every value
of that type. The most specific target a value matches is its metatable.

A method a library's metatable gives may be one the value really has, as
Luau's `split` is. When it is not, the library says how it runs. It points at
a JavaScript module in its package.json, and the compiler asks it — and only
it — what a call through a metatable it declared becomes:

```json
"tilua": { "types": "index.d.tilua", "lowering": "lowering.mjs" }
```

```js
// @ts-check
/** @type {import("@tilua/parser").LoweringPlugin} */   // the contract, declared here
const plugin = {
    runtime: { array: "local __NAME__ = {}\nfunction __NAME__.first(t) return t[1] end" },
    methodCall({ method, use }) {
        if (method === "first") return { callee: `${use("array")}.first` }
        return undefined
    },
}
export default plugin
```

`receiver` is the tilua type the analyzer worked out, `use(key)` gives the
local name that table got — emitted once, at the top of the output, only if a
call needed it — and the receiver is passed as the call's first argument. An
answer of `undefined` leaves an ordinary Luau method call, which is what
`text:split(",")` wants, since a Luau string already answers to it. A method
of a value's own (`console:log`, a member of a declared table) is asked of
every library, the last loaded first.

A call can also carry more than was written. Every hook is told `at`, where
the call was written (`{ file, line, column }`), and `arguments`: each one's
type, that type as text, the code it was written as, and, for a name, the
code of what it names. An answer's `prepend` lists Luau expressions to pass
ahead of the written arguments. `globalCall` answers for a call to a global,
such as `print(x)`, and `globalValue` for a global read as a value, such as
`local p = print`. A local with the same name belongs to the author, and no
hook is asked about it. A runtime can read `__LINES__`, the bundle's line map
(`nil` outside a bundle), to turn a line Luau reports back into a place in the
project. One that answers with a new array wraps it in `__ARRAY__(...)`, which
writes it down as an array for `typeof`. The compiler's own lowering of the
standard library — `console:log`, `error`, `pcall` — is built on these hooks.

A plugin may also list `syntax`: what its Lua can write beyond Lua 5.1's
(`LuaSyntax` — `"compoundAssignment"`, `"continue"`, `"ifExpression"`,
`"floorDivision"`, `"iteration"`, `"attributes"`, `"numberLiterals"`,
`"requireByPath"`). Without one the compiler writes Lua any Lua runs;
`@tilua-types/luau` lists Luau's, so a Luau project is written as Luau.

**A `(` that starts a line** continues the statement above it, as in Lua and
in JavaScript — `const v = map[key]` followed by `("A"):upper()` is one
statement, a call of `map[key]`. tilua says so rather than letting it pass:
write `;` before the `(` when a new statement was meant.

**Object types** — `{ name: T, name?: T, [K]: V }`, and a name that is not an
identifier is quoted, as in the literal: `{ "Respawn After Kill": boolean }`.
An index signature may name its key as TypeScript does, `[key: string]: V`, and
its key may be a template literal: `` { [`on${string}`]: Handler } `` takes every
`onX`, and an object literal with any other key is excess. A string or a list
fits a shape that names what it answers to: `"abc"` is a `{ length: number }`.
Members are separated by `,`, `;` or a line break, and may be written the
other ways TypeScript writes them:

```luau
type Counter = {
    readonly id: number
    step(by: number): this        -- a method: (self: this, by: number) => this
    reset?(): void                -- an optional one
    get total(): number           -- read-only, unless a `set` is written too
    set label(value: string)
    (n: number): string           -- calling the value; several are overloads
    new (seed: number): Counter   -- what its `new` makes: { new: (seed: number) => Counter }
}
```

A method is called with `:`, as a class's methods are: its first parameter is
the receiver, typed `this`, so `counter:step(1)` hands `counter` over and
`counter.step(1)` is the missing argument it is. A signature with no return
type returns `nil`. Calling the value and having members too is the functions
and the members together — Lua builds such a value with a `__call` metatable.

**Interfaces** — `interface Name<T> extends A, B<T> { ... }`, with the members
an object type takes. It is a type alias for the bases and the members
together, with what TypeScript adds: two interfaces of one name are one, their
members merged (a method written in each is an overload set), and a member
that does not fit the one it replaces in a base is reported. `export
interface` exports it, as `export type` does.

```luau
interface Named { name: string }
interface Greeter extends Named {
    greet(other: Named): string
}
class Person implements Greeter {
    name = "Ada"
    function greet(other: Named): string { return `hi ${other.name}` }
}
```

**`this` in a type** — TypeScript's polymorphic `this`: the value a member is
read from. A method that returns `this` returns whatever it was called on, so
`Builder.new():add(1):done()` keeps the subclass's members through the chain.
Inside the class it is the instance.

**Optionality** — there is no `T?` shorthand. `?` in type position always
belongs to a conditional type, and in expression position to a ternary or an
optional chain.

```luau
name?: T        -- may be absent; its type is `T | nil`
name: T | nil   -- must be written, but may be nil
```

Omitting an argument requires `?` (or a default), as in TypeScript — a
parameter typed `T | nil` still has to be passed something.

**Optional chaining** — `a?.b`, `a?.[k]`, `a?.(x)` and `a?:m(x)` are nil when
`a` is, and then nothing further along the chain runs, arguments and the key
included: `folder?:FindFirstChild("A")?.Name` is a `string | nil`, and
`maps?.[key]?.label` reads the key only when `maps` is there. The `?` must
touch the `.` or `:`; `c ? a : b` stays a
ternary. Parentheses end a chain. A chain cannot be assigned to (`a?.b = 1` is
an error). A chain that got through narrows what it tested: inside
`if (part?.Parent)`, and `if (part?.Name == "Door")`, `part` is not nil.

**`+` joins strings**, as in TypeScript — tilua has no `..`, which reads as
the `+` it meant, and is reported. A string on either side makes it a join,
and the other side is a string or a number, which Luau writes into one:
`"a" + "b" == "ab"`, `"x" + 1` is `"x1"`, `1 + 2 + "a"` is `"3a"`. A boolean,
a table or `nil` is not joined — write it in a template string, or call
`tostring`. Two numbers add, as does a value whose metatable has `__add`.
Where only the values can say — a side that is `any`, or `string | number` —
the compiler asks them as the program runs. `s += "x"` joins as `s + "x"`
does; `n++` is an increment, and only of a number.

**`??`** — `a ?? b` is `a`, or `b` where `a` is nil; `b` is read only then.
Unlike `a or b` a `false` stays, which is what a `boolean | nil` wants:
`settings.enabled ?? true`. As in TypeScript it does not mix with `and` or
`or` without parentheses.

**`??=`** — `t ??= v` assigns `v` only where `t` is nil, and reads `v` only
then: `cache[key] ??= {}`, where Lua writes `cache[key] = cache[key] or {}` —
which also replaces a `false`. After it, `t` is not nil.

**`in`** — `"key" in t` asks whether `t` holds something at `key`: in Lua a
key whose value is nil is a key that is not there, so it is `t.key ~= nil`.
The key is a string or a number and `t` a table. It narrows as TypeScript's
does: where it holds, `t` is one of the union members that can have `key`, and
`t.key` is not nil; where it does not, `t` is none of the members that must.

**`instanceof`** — `v instanceof Dog` is true when `v` was built by `Dog` or
by a class extending it. It walks the links every instance has: `v.ClassObject`,
then each `.ParentClass` up the chain. It narrows `v` to `Dog`, and only a
class written in tilua can stand on its right — a `declare class` is the
host's, and Roblox's answer `IsA` instead.

**Accessors in an object literal** — `{ get full() { ... }, set full(v) { ...
} }` reads and writes `full` through functions, with the object as `this`. Lua
has no such thing, so the object gets a metatable that runs them; a name with a
getter and no setter is read-only, and assigning it is an error at runtime as
well as in the types.

**Classes** — types are structural, except for classes. A definitions file
declares one with `declare class`, and it is nominal, as Roblox's classes are:

```luau
declare class BasePart extends PVInstance { Size: Vector3 }
declare class Part extends BasePart { Shape: EnumItem }
```

A `Part` is a `BasePart` and an `Instance` because it extends them. A
`ReplicatedStorage` is not a `Part`, and no table literal is an `Instance`,
however alike their members. A class still fits a shape that names members it
has (`{ Name: string }`). It is not a table, though, so `typeof part` is
`"Instance"`, as the library's `TypeofNames` says, not `"object"`. Members are inherited, and a subclass
may narrow one (`Parent: SomeFolder`).

**`class ... { }`** — a class written in code, rather than declared in a
definitions file. It is sugar over the Lua idiom, and the shape it stands for
is exactly that one: the class is a single table holding the methods and the
statics, and an instance is a table whose metatable points at it. An instance
therefore reaches *the class* — nothing is copied per instance, and there is
no prototype chain of an instance's own.

```luau
class Animal {
    name: string                -- set by the constructor
    legs = 4                    -- set on every instance, before the body runs
    static count = 0            -- on the class table, once

    constructor(name: string) {
        this.name = name
        Animal.count += 1
    }

    function speak(): string {
        return `${this.name} makes a sound`
    }

    get label(): string {       -- read as a property, run as a function
        return `<${this.name}>`
    }

    set label(value: string) {
        this.name = value
    }

    static function made(): number {
        return Animal.count
    }
}

class Dog extends Animal {
    breed: string

    constructor(name: string, breed: string) {
        super(name)             -- required: it is what fills in the base
        this.breed = breed
    }

    function speak(): string {
        return `${super.speak()} (woof)`
    }
}

const rex = Dog.new("Rex", "shiba")
rex:speak()                     -- the receiver is `this`
rex.label = "Max"               -- the setter
Dog.made()                      -- a static, inherited from Animal
```

The receiver is written `this`, and it is an ordinary first parameter: a
method's type is `(this: Dog, ...) => R`, so `rex:speak()` supplies it the way
`function T:m()` supplies `self`. An instance is built the way Luau builds
one, with the class's own function: `Dog.new(x)` — callable like any other,
and passable as a value. There is no `new Dog(x)`; writing it is a syntax
error that says so.

**`public`, `private` and `protected`** go before a member — `private
balance = 0`, `private static function check()`, `public get size()`. Leaving
it out means public. A private member can be reached only inside the body of
the class that declared it, including functions nested in its methods; a
subclass is outside, as in TypeScript. A protected one is reachable from the
classes extending it too. It is a type check and nothing more: the member is
an ordinary key at runtime.

**`readonly`** fields are assigned where they are declared or in the
constructor of their own class, and nowhere else: `readonly id: number`.

The modifiers can come in any order — `static private readonly count = 0` —
and each stays an ordinary name where no member follows it, so
`private: boolean` and `readonly = 1` are still fields.

**`abstract`** — an `abstract class` has no `new`: it is built only as part of
a class extending it. It may declare `abstract function area(): number`, a
head with no body, and a class extending it that is not abstract itself has to
write every such member. Calling an abstract method through `super` is an
error, as is `Shape.new`.

**`override`** says a member replaces one of the class it extends, and is an
error on a member that does not. Whether or not it is written, a member that
replaces one has to fit it: its type, `this` aside, is checked against the
base's.

**`implements`** — `class Person implements Named, Greeter` checks that the
instances have every member each shape names, of a type that fits. Nothing
happens at runtime.

```luau
abstract class Shape implements Named {
    readonly name: string
    protected sides = 0
    constructor(name: string) {
        this.name = name
    }
    abstract function area(): number
}

class Square extends Shape {
    side = 1
    constructor() {
        super("square")
        this.sides = 4                  -- protected: reachable from here
    }
    override function area(): number {
        return this.side * this.side
    }
}
```

**Metamethods** are methods with their Luau names. The class table *is* its
instances' metatable, so `function __add(other: Vec): Vec` in a class is the
`+` of its instances — and the type checker reads it the same way: `a + b`
between two `Vec`s is a `Vec`. `__sub`, `__mul`, `__div`, `__idiv`, `__mod`,
`__pow`, `__unm`, `__concat`, `__len` (`v.length`), `__eq`, `__lt` and `__le` (`<`,
`>`, `<=`, `>=`), `__call` (calling an instance), `__iter` (`for a, b in v`)
and `__tostring` all work this way, and a class extending another inherits
them. Each is checked: it takes the operands Luau hands it, returns what Luau
expects of it (`__tostring` a string, `__eq`/`__lt`/`__le` a boolean), and is
not `static`. Comparing two instances whose class has no `__lt` is an error,
as it is at runtime.

```luau
class Vec {
    x: number
    constructor(x: number) {
        this.x = x
    }
    function __add(other: Vec): Vec {
        return Vec.new(this.x + other.x)
    }
    function __tostring(): string {
        return `Vec(${this.x})`
    }
}

const v = Vec.new(1) + Vec.new(2)       -- Vec
print(tostring(v))                      -- Vec(3)
```

A declaration names two things. As a **type**, `Dog` is the type of its
instances, nominal the same way a `declare class` is: a table with the same
members is not one, and only `Dog` and what extends it are assignable to it.
As a **value**, `Dog` is the class table — its statics, and the `new` that
builds an instance (`Dog.new(...)`). `export class` exports both.

Two links are always there, and they are what the memory model promises:

```luau
rex.ClassObject == Dog          -- an instance names its class
Dog.ParentClass == Animal       -- a class names the one it extends
Animal.ParentClass == nil       -- and a root class extends nothing
```

Both live on the class table, so an instance carries neither. So does its
name, as a JavaScript class's `name`: `Dog.name` is `"Dog"`, and a class
written as a value takes the name of what holds it (`const Counter = class
{ ... }` is `"Counter"`). A static, a method or an accessor cannot be called
`name`; an instance field can, and lives on the instance.

**Generic classes** — `class Box<T> { ... }`. The name is then a generic type,
and `Box<number>` and `Box<string>` are both `Box` but neither is the other:

```luau
class Box<T> {
    value: T
    constructor(value: T) {
        this.value = value
    }
    function get(): T {
        return this.value
    }
    function map<R>(f: (value: T) => R): Box<R> {
        return Box.new(f(this.value))
    }
}

const n = Box.new(1)               -- Box<number>, read off the argument
const s = Box.new<string>("a")     -- or written out
const held: number = n:get()

class Ints extends Box<number> {   -- extending one fixes its argument
    constructor(n: number) { super(n) }
}
```

A function takes the argument off what it is handed: `function unwrap<T>(b:
Box<T>): T` given a `Box<boolean>` returns `boolean`.

**A class as a value** — `const Counter = class { ... }`, and `export default
class { ... }`. It may be named, and then the name is visible only inside its
own body, as in JavaScript; an anonymous one is known by whatever holds it.
Two of them are different types however alike they look. A class written as a
value takes no type parameters — nothing could write the arguments.

`export default class Name { ... }` declares `Name` here as well as exporting
it, as TypeScript's does, and importing it brings in the type too:

```luau
import Box from "./box"            -- `Box` is the class *and* the type
const held: Box<number> = Box.new(1)
```

Reported: a field with a type that nothing gives a value (`name: string` that
the constructor does not assign on every way through it — both arms of an
`if`, not in a loop or a function written inside), a derived constructor that does not call
`super(...)`, `extends` naming something that is not a class, a chain that
closes on itself, a member written twice, and a member named one of the words
the compiler builds the class table out of (`new`, `ClassObject`,
`ParentClass`, `__init`, `__index`, `__newindex`, `__getters`, `__setters`,
`__dynamic`).

**One value, and arrays** — tilua has no packs. A function returns one value;
several are an array, and a tuple type says how many and of what:

```luau
function divide(a: number, b: number): [number, number] {
    return [a // b, a % b]
}

const [quotient, remainder] = divide(7, 2)    -- taken apart
const both = divide(7, 2)                     -- or kept: [number, number]
```

An array is a table, at runtime as much as in the types: `return [a, b]` is
`return { a, b }`. Where Luau answers several values — `pcall`, `string.find`,
a Roblox method such as `FindPartOnRay` — the type library puts a function of
its own in place of that global or method, which answers one value, as its
type says. A tuple may end in a rest,
`[string, ...number[]]`: that many, then any number more.

A declaration and an assignment take one value, and a call is one value
wherever it is written — an argument, a `return`. Luau's `local a, b = 1, 2`
is an error that says to write `const [a, b] = [1, 2]`. Where a Luau function
answers several values and nothing gathers them, ask for all of them by making
the call an array's last element:

```luau
const [a, b] = [require(module)]    -- { require(module) }: every value
```

**A loop takes one value too** — `for (const item of source)`, and several are
an array the pattern takes apart:

```luau
for (const name of names) { print(name) }
for (const [i, name] of ipairs(names)) { print(i, name) }
for (const [key, score] of pairs(scores)) { print(key, score) }
```

The name is `const`, or `let` where the body assigns to it, as anywhere else.
A source is an array or a table, walked for its values; an iterator function,
called until it answers `nil`; or an iteration — `[step, state, first]`, what
`pairs(t)` answers — whose `step` is called with the state and the item before
it. An object says how it is walked with `__iter`, which answers one of those
two. `for (k, v of ...)` and `for (x of f, s, v)` are Luau's packs, and are
syntax errors.

`for (const key in table)` walks a table's keys, as TypeScript's does: a
list's positions, a record's property names, an indexer's key type. It is
`for key in pairs(table)`, values left behind.

```luau
const scores = { alice: 10, bob: 20 }
for (const name in scores) { print(name, scores[name]) }   -- name: "alice" | "bob"
for (const i in ["a", "b"]) { print(i) }                    -- i: number
```

A key is one value, so `for ... in` takes no pattern, and an iterator has no
keys to give — `for (const [k, v] in pairs(t))` or `for (const w in
s:gmatch("%a+"))` are errors that say to write `of`. `of` is a keyword only
there: anywhere else it is a name like any other.

A function that returns nothing returns `void`: `() => void`, not `() => ()`.
As a value `void` is `nil`. As what a function type returns it says nobody
reads the answer, as TypeScript's does, so a function that returns something
fits it: `() => task.defer(f)` goes where a `() => void` is wanted. `() =>
nil` promises a `nil`, and takes only a function that gives one back.
Bare `...` is gone — a
function takes a rest parameter, and what the script was started with is
`scriptArgs: unknown[]`. `()`, `(A, B)` as a type, `T...`, `...: T` and
`return a, b` are syntax errors that say what to write instead.

**Rest parameters** — `...name: T[]` is JavaScript's: every argument from that
position on, as an array. It is last, and it is the one way a function takes a
varying number of arguments.

```luau
function join(separator: string, ...parts: string[]): string {
    return table.concat(parts, separator)   -- `parts` is a string[] here
}

join("-", "a", "b")       -- and a vararg call out here
join("-", 1)              -- Argument of type '1' is not assignable to 'string'

function firstOf<T>(...items: T[]): T | nil {
    return items[1]
}

firstOf(1, 2)             -- number | nil: the arguments say what `T` is
```

A type is written the same way: `type Reporter = (level: string, ...lines:
string[]) => void`. Without an annotation a rest parameter is `unknown[]`. A rest
parameter may also be a tuple, or a type parameter standing for one — then the
arguments are exactly its elements, which is how a function says it forwards
another's:

```luau
declare function spawn<A extends unknown[]>(f: (...args: A) => void, ...args: A): thread

spawn(function(n: number) { print(n) }, 1)       -- ok
spawn(function(n: number) { print(n) }, "no")    -- '"no"' is not a number
```

**Spreads** — `...xs` puts what an array holds into a call's arguments or an
array literal, as JavaScript does. A list of values — a declaration's, an
assignment's — takes one value per name; take an array apart with a
destructuring instead.

```luau
join("-", ...names)              -- every name
join("-", ...names, "z")         -- and one more after them
add3(...trio)                    -- `trio: [number, number, number]`: exactly three
const both = [...names, "z"]
```

What the array holds is checked against what it fills. How many an array
holds is not known, so, as in TypeScript, it can only fill a rest parameter —
`add3(...nums)` with `nums: number[]` is an error, and so is `h(...nums)` for
an `h(a: number, ...more: number[])`, whose `a` it would have to fill. A
tuple holds a known value at each position: it fills exactly that many
parameters, checked one by one and counted, several tuples together too.
Spreading something that is not a list is reported, and so is spreading a
list that may be nil — write `...(xs ?? [])`.

In an object literal, `...source` copies what `source` has: over a union, one
object per member; over a value that may be nil, every member optional; over
a class instance, its fields — its methods live on the class table, which a
copy does not reach. A copy is a new table, so nothing in it is read-only.
`const [first, ...rest] = tuple` leaves `rest` a tuple of what is left.

**Branded types** — nothing in the type model is about branding; an
intersection already means it. `string & { __brand }` is assignable to
`string`, and `string` is not assignable to it, which is the whole of it:

```luau
type UserId = string & { readonly __brand: "UserId" }
type PostId = string & { readonly __brand: "PostId" }

declare function findUser(id: UserId): string

const id = "raw" as UserId      -- `as` is how one is made
findUser(id)                    -- ok
findUser("raw")                 -- '"raw"' is not assignable to 'UserId'
findUser(postId)                -- 'PostId' is not assignable to 'UserId'

id.length                       -- still a string: 5
id:upper()                      -- and its methods, giving a plain string
```

Anything that builds a new value builds an unbranded one — which is the point:
the brand says where the value came from. It works on any type (`number & {
__brand }`), and survives being stored, indexed and narrowed.

**Callbacks** — a function written where a function type is expected takes
its parameter types from it: in `signal:Connect(player => ... )`,
`player` is typed from `Connect`. The same applies to an annotated `const`
and to an assignment such as `remote.OnServerInvoke = function(player) { ... }`.

**Signals and other variadic generics** — a type parameter can stand for a
list of arguments: `type Signal<T extends unknown[] = any[]> = { Connect:
(self, cb: (...args: T) => void) => Connection }`, given as a tuple —
`Signal<[Player, string]>`, `Signal<[]>` for none.

**Operators** — on a type that declares metamethods (`__add`, `__mul`,
`__unm`, ...), an operator has the metamethod's result, tried on the left
operand and then the right one, as Luau does. So `Vector3 + Vector3` and
`2 * vector` are both `Vector3`.

**Qualified type names** — a definitions file may declare `Enum.Material`
(`declare class Enum.Material extends EnumItem {}`), and code writes it the
same way.

**Contextual typing** — an expression takes its type from where it is
written, as in TypeScript: `let queue: thread[] = []` is a `thread[]`, and so
is `[]` passed where one is expected, including inside an object literal.

**Calls** — every argument is checked against its parameter, and a generic
parameter against its constraint (`GetService<K extends keyof Services>`
rejects `""`). Arguments are checked again once the call's own type arguments
are known, so `pick("Bones", "Blast1")` is caught where `pick`'s second
parameter reads `Extract<Rows, { Page: P }>["Skills"][number]`. A type that
waits on a type parameter — a conditional, an index, `T[K]` — is worked out
where that parameter is.

**Functions compare as under `strictFunctionTypes`.** A function fits a
function type when it takes whatever that type's callers pass — its parameters
are contravariant — and needs no more arguments than they hand it: `(x: Part)
=> void` is not a `(x: Instance) => void`, which may be called with any
instance. A method — a function taking its receiver first, `self` or `this`
— is compared both ways, as TypeScript compares methods, so an override may
narrow what it takes.

**Every way through returns.** A function that declares a return type which
does not admit `nil` has to return on every way to its end: `Not every path
returns a value` otherwise. A call that is `never` (`error(...)`) ends a way,
and so does `while (true)` with no `break` of its own.

**An `if` chain can be exhaustive.** tilua has no `switch`; an `if` /
`elseif` chain whose tests leave no value for an `else` — every member of
`x: "a" | "b"` tested — has no way past it but its branches. A function whose
chain returns in every branch needs no `return` after it, and after it `x` is
`never`, which is how `const unreachable: never = x` checks that a new
member was not forgotten.

**Trailing commas** are allowed wherever TypeScript allows them: parameter
lists, call arguments, generic parameters and type arguments, tables, arrays,
tuples, imports and exports.

A value read by a key narrows the key: after `const path = paths[stat]`, the
`else` of `if path then` leaves `stat` as exactly the keys `paths` does not
have — the same correlation `pairs` over a record and a destructured union
already get.

**Narrowing** follows TypeScript's model: references (`x`, `x.a.b`, `x["k"]`)
rather than just variables, discriminated unions at any depth, `and`/`or`,
early return, `break`/`continue`, `throw`, `error()` (declared `=> never`), user type
guards (`v is T`), one-sided guards as in Flow (`implies v is T`: a true answer
narrows `v`, a false one says nothing — the array `includes` is one), and
assertion signatures (`asserts v`).

Reading a member of, indexing or calling a value that may be nil is an error
until a check narrows the nil away, as with TypeScript's `strictNullChecks`:
`FindFirstChild("A"):FindFirstChild("B")` reports that the first call is
possibly nil. Use `?.` / `?:`, or check first. The read is still typed from the
non-nil part.

Only `nil` and `false` are falsy — `0` and `""` are truthy, unlike JavaScript.

**What Luau raises on is said first.** An operator no metamethod answers takes
numbers — `+` a string and a string or a number, `#` a string or a table — so
`n * 2` with `n` a `number | nil` is an error where it is written rather than
where it runs. A comparison two types can never settle is a warning (see
below); a test against `nil` never is, since a map's value and an array's
element are read as what they hold. A name holds nothing until its line has
run, a list is indexed by position (`xs["a"]` is not a read), `readonly T[]`
rules out writing to the list as well as passing it where a `number[]` is
wanted, a key written twice in one table is reported, and a parameter with no
type says so — it is `any`, and `any` turns off every check made of it.

**Types** — unions, intersections, tuples `[A, B]` (with a rest, `[A,
...B[]]`), `keyof`, `T[K]`, conditional types with
`infer`, mapped types with `as` remapping, template literal types
(`` `on${Event}` ``), and `Exclude<A, B>`. The utility types
(`Partial`, `Pick`, `Omit`, `ReturnType`, `Parameters`, `Exclude`, …) are
built in, and written in tilua on top of those rather than special-cased in
the analyzer. A type library or a file may declare one again; the later
declaration wins.

Type-level programs work as they do in TypeScript. A tuple may spread anywhere
(`[...A, ...B]`, `[infer H, ...infer R]`) and name its elements
(`[x: number, y?: number]`) — an element marked `?` may be left out, so
`[number, string?]` takes `[1]` and its `length` is `1 | 2`, and
`Parameters<(a: number, b?: string) => void>` is `[a: number, b?: string]`; a
list of any length may stand before the elements written after it
(`[...unknown[], infer L]`); `T["length"]` counts a tuple, and `keyof` a list is
its positions and its `length`, `number | "length"` (`keyof string[]` is the
list's keys, `(keyof T)[]` a list of keys, as TypeScript reads them); an alias may
recurse (`type Reverse<T> = T extends [infer H, ...infer R] ? [...Reverse<R>,
H] : []`); a template literal pattern takes a string apart (`` S extends
`${infer A}.${infer B}` ``), and `infer N extends number` reads `"42"` as
`42`. `object` is anything that is not a primitive. One difference: a tuple's
positions count from 1, as Lua's do, so the first element of `T` is `T[1]`.
A recursion that never ends stops after 100 levels and gives `any`.

**What `${...}` may hold** — a template string writes each value with
`tostring`, so it takes what reads as text: a string, a number, a boolean,
`nil`, and a value that says how to print itself — a class with `__tostring`,
or one the host made (a Roblox `Instance`, a `Vector3`). A table, a list, a
function or a class instance without `__tostring` would print as its address
(`table: 0x...`), and is an error. A template literal *type* holds a string,
a number, a boolean or `nil` in each placeholder, as TypeScript's does:
`` `a${number[]}` `` is an error, and so is a `T extends object` there.

A generic function may take and give variadic tuples: `<T extends unknown[]>(xs:
[...T]): T` reads `[1, "a"]` as `[number, string]`, `(...args: [...T, string])`
takes the last argument apart from the others, and `(fn: (...args: [...A,
...B]) => R, ...a: A): (...b: B) => R` binds the first arguments of `fn`.

`Exclude<T, U>` — what of `T` is not a `U` — is the analyzer's own, and unlike
TypeScript's it is kept where TypeScript's would forget it: `Exclude<unknown,
nil>` and `Exclude<any, nil>` stay, as a value known not to be `nil`, and so
does `Exclude<string, "a">`, a string that is not `"a"` — of which `if (s ==
"a")` is reported as a test that can never pass. Over a union it drops the
members it takes whole (`Exclude<"a" | "b", "b">` is `"a"`), and `boolean` is
the union `true | false`. A narrowing keeps it: inside `if (a ~= 1)` an
`unknown` is `Exclude<unknown, 1>`, and after `if (s == "") return` a string
is `Exclude<string, "">`. Where the branches meet again what was taken out is
put back — `Exclude<unknown, 1 | 2> | 2` is `Exclude<unknown, 1>`, and once all
of it is back, `unknown`.

**A comparison that always comes out the same** is a warning, not an error:
the program means something, only not what was meant. It is judged by what
each side can be at run time — which of Luau's types, and which value — so it
covers every such pair: `n == "1"` of a number, `"a" | "b"` against `"c"`, a
table against a string, a function against a number, and `s == ""` again
after `if (s == "") return`. A side whose type says nothing — `any`, `unknown`
as a whole, a type parameter with no constraint — is never judged, and
neither are two tables, which compare by identity, nor a test against `nil`.
tilua has no `A - B` in types; `Exclude` is the one way to write it.

A call may write its type arguments out — `find<Folder>("Remotes")`,
`inst:WaitForChild<Folder>("Remotes")` — and a type parameter may have a
default (`<T = Instance>`) for the calls that do not. `a < b > (c)` is still
three operators: only a call after the `>` makes it type arguments.

`<const T>` infers an argument at its narrowest, as in TypeScript 5. Without it
a literal is still kept where the function gives `T` itself back —
`identity("x")` is `"x"`, and a `let` it is given to widens it to `string` —
and a `K extends keyof T`, or a `T extends string`, keeps the key or the text
written. Literals of one primitive read for one parameter are either:
`pair(1, 2)` is `1 | 2`. `as const` makes its lists read-only:
`[1, 2] as const` is a `readonly [1, 2]`. `ReturnType` of an overloaded
function is its last signature's, as in TypeScript.

`NoInfer<T>` is `T`, except that a call does not work `T` out from an
argument written there: `function pick<T>(a: T, fallback: NoInfer<T>): T`
takes `T` from `a` alone, and checks `fallback` against it.

A type alias or an interface may say how it compares by a parameter:
`type Getter<out T>` as `T` does, `type Setter<in T>` the other way round,
`<in out T>` only by the same `T`. It is checked against the body —
`type Getter<in T> = { get: () => T }` is an error — and a function's or a
class's parameters take none.

`new (name: string) => Dog` is the type of a class table that builds a `Dog`:
tilua builds with `Dog.new(name)`, so it is `{ new: (name: string) => Dog }`.
`InstanceType<typeof Dog>` and `ConstructorParameters<typeof Dog>` read it
back, as TypeScript's do.

`typeof x` in a type is TypeScript's type query — the type of a value
(`typeof config`, `typeof config.volume`, `ReturnType<typeof f>`). Luau's
`typeof(expr)` spelling is an error here as well. It is compile-time only, unrelated to the
`typeof v` operator in an expression, which answers a string as the program
runs.

**Methods in an object** — `{ m() { ... } }`, as a class writes one. A method
takes the object as `this` and is called with `:`, as `m(): R` in an object
type is: `Counter:increment(2)`. It fits an interface's method.

```luau
const Counter = {
    count: 0,
    increment(by: number): number {
        this.count += by
        return this:current()
    },
    current(): number { return this.count },
}
```

**Labels** — `outer: for (...)`, `while` or `repeat`, and `break outer` or
`continue outer` from a loop inside it, as in JavaScript. A label is the
loops around a `break`'s only: one inside a function written in the loop
cannot name it.

```luau
outer: for (const row of grid) {
    for (const cell of row) {
        if (cell == target) break outer
    }
}
```

**`throw` and `try`** — as JavaScript writes them. Anything may be thrown, a
string most often, which is what every error the engine raises is; what a
`catch` is handed is exactly what was thrown, so it is `unknown`:

```luau
function parse(text: string): number {
    const n = tonumber(text)
    if (n == nil) throw `not a number: ${text}`
    return n
}

try {
    print(parse(input))
} catch (e) {
    if (typeof e == "string") warn(e)
} finally {
    print("done")
}
```

`catch` and `finally` may each be left out, not both; `catch { }` takes
nothing. All four words are soft keywords, so a promise's `p:catch(f)` and
`p:finally(f)` are methods still. A `throw` is an exit like a `return`: it
narrows what follows it, and code after it is unreachable.

**Unreachable code** — what follows a `return`, `break`, `continue` or
`throw` in its block, or a call that never returns, is no error, as in
JavaScript: it is read and typed, `TypeAnalysis.unreachable` lists it, and an
editor shows it dimmed. A bare `return` returns nothing when a statement begins
the line below it; otherwise what is below is its value, as in Lua.

**Modules** — `import` / `export`, export lists, re-exports and `export *`.
`export type { A }` (and `export type { A } from "./m"`) exports types and
nothing else; naming a value there is an error.

**What TypeScript has and tilua does not** says what to write instead, rather
than reading as something else: `enum`, `namespace`,
`switch`, `declare module` and `declare global` are each reported with the
tilua spelling. (A name followed by `{` is otherwise a call with a table
argument, so `enum Color { ... }` would have meant `enum(Color { ... })`.)

**`satisfies`** — checks a value against a type without giving it that type,
as in TypeScript 4.9:

```luau
type Shape = { kind: "circle" | "rect", size: number }
const circle = { kind: "circle", size: 2 } satisfies Shape  -- { kind: "circle", size: number }
const handlers = {
    Click: x => x + 1,                                       -- x: number, from the contract
} satisfies { [string]: (x: number) => number }
```

The contract types callbacks and empty arrays, and a literal stays a literal
where the contract asks for literals (`kind: "circle"`, not `string`). A value
that does not fit is an error. So is a property the contract does not know —
TypeScript's excess property check, which applies to an object literal written
straight into an annotation (`const s: Shape = { ..., typo: 1 }`) too. A value
that already has a type of its own keeps it exactly: `{ ... } as const
satisfies T` stays readonly and literal. `as` reinterprets instead of
checking, and compiled code keeps neither.

**Undeclared names** — `analyzeScopes(program, { builtinGlobals, reportUndeclared: true })`
reports each read of a name nothing declares: "Cannot find name 'x'". A global
assigned in the file (`x = 1`) and a `declare` count as declarations.
`analyzeTypes(program, scopes, { reportUnknownTypes: true })` does the same for
type names. Both are off by default, since they are only right when the type
libraries the file names are loaded.

**Directives** — comments that switch checking off, as TypeScript's
`// @ts-...` do. They silence scope and type errors and lint warnings, never
syntax errors:

```luau
--@tilua-nocheck          -- before the first line of code: the whole file
--@tilua-ignore           -- the next line of code, errors and warnings
--@tilua-expect-error     -- the next line of code, which must have an error
--@tilua-expect-warning   -- the next line of code, which must have a warning
```

An `expect-` directive covers its own kind only: a warning neither answers an
`expect-error` nor is hidden by one, and the other way round. An unused
`expect-error` is an error; an unused `expect-warning` is a warning.

`parseWithRecovery` returns them as `directives`; `directivesOf(source)` reads
them for a caller that parsed some other way, and
`applyDirectives(directives, diagnostics, lineOf, isWarning)` filters a list
and names each `expect-error` and `expect-warning` that had nothing to
suppress.

## Options

```ts
analyzeScopes(program, {
  builtinGlobals: ["print", "game"],   // names that may be used undeclared
})

analyzeTypes(program, scopes, {
  libs,                       // parsed `.d.tilua` definitions
  globalTypes: { … },         // types for specific globals; wins over `libs`
  libTypes: { … },            // extra named types for annotations
  diagnostics: true,          // emit type errors (default)
  resolveModule: specifier => exportsOfThatFile,
                              // what an `import` sees; without it imports are `any`
})
```

## Known limitations

- `export * as ns from` is not supported.
- `setmetatable` is not modelled: a table given a metatable at runtime keeps
  the type it had.
- A sourcemap child whose name is not an identifier (`"My Part"`) is not typed.

## Development

```bash
npm install
npm test        # smoketests (types via smoketest/tilua.config.json), then project tests
npm run build
npm run typecheck
```

`smoketest/` is the test suite. Each file annotates its bindings with the type
they should infer to, so a wrong result surfaces as a diagnostic rather than
something to eyeball. `scripts/project.test.ts` covers configs, type
libraries, import paths and sourcemaps against an in-memory file system.
