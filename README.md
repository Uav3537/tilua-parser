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
| [`@tilua-types/roblox`][roblox], [`@tilua-types/lua`][lua], [`@tilua-types/sunc`][sunc] | the globals a project may use |
| `@tilua/parser` | this: tokens, AST, scopes, types |

[compiler]: https://www.npmjs.com/package/@tilua/compiler
[server]: https://www.npmjs.com/package/@tilua/language-server
[roblox]: https://www.npmjs.com/package/@tilua-types/roblox
[lua]: https://www.npmjs.com/package/@tilua-types/lua
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

**No globals are built in** — not `print`, not `string`, not `game`. Only the
language's own utility types are (`Partial`, `Pick`, `Omit`, `Record`,
`ReturnType`, `Truthy`, ...; see `PRELUDE_SOURCE`). A project lists the type
libraries it uses in `tilua.config.json`, the way TypeScript uses `@types/*`:

```bash
npm i -D @tilua-types/roblox        # Luau + Roblox; or @tilua-types/lua on its own
```

```jsonc
// tilua.config.json
{
  "types": ["roblox"],                          // and what it depends on: @tilua-types/lua
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
  one that is not installed is an error.
- **`paths`** — tsconfig rules: an exact pattern wins, then the `*` pattern
  with the longest prefix; targets resolve from `baseUrl` (default: the
  config's folder).
- **`sourceMap`** — the instance tree becomes types: `game` and `workspace`
  follow it, and a file the tree maps gets its own `script`, so
  `script.Parent.Remotes` is typed. A `.tilua` file matches the Luau file of
  the same path.

| function | does |
|---|---|
| `findConfig(file, host?)` | the config that applies, problems with it, and every path searched |
| `loadConfig(path, host?)` | read and check one config |
| `resolveTypeLibraries(config, host?)` | the `.d.tilua` files to load, in order |
| `moduleCandidates(from, specifier, config?)` / `resolveModulePath(...)` | what an `import` means |
| `sourceMapTypes(text, path, { classes })` | the tree's types, and `scriptFor(file)` |

Every problem comes back as `{ file, message, line, column }`, pointing into
the config (or sourcemap) it is about. `host` reads files — pass your own to
read unsaved editor buffers or to record what was read.

`type` / `typeof` are **not** special-cased in the analyzer either: they are
overload sets in `@tilua-types/lua` and `@tilua-types/roblox`, and narrowing is derived
from them. Without a library that declares them, they narrow nothing.

Libraries stack: a name declared again *adds* to what an earlier library gave
it — overloads of a function accumulate, and the members of a declared table
merge. That is how `@tilua-types/roblox` extends Lua's `table` and `type` without
restating them.

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
for (const [name, value] in pairs(t)) { print(name, value) }
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

for (const item in items) if (item) print(item)
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

**Array and string methods** — an array and a string answer to methods
written with `:`, the way JavaScript writes them:

```luau
const long = names:filter(n => #n > 3):map(string.upper)
const first = names:find(n => n:startsWith("A"))
print(names:join(", "), text:trim(), text:replaceAll(",", ";"))
```

Which methods those are is not the language's business. The analyzer looks for
two types by name — `ArrayMethods<T>` and `StringMethods` — and reads an
array's or a string's members out of whichever type library declared them;
without such a library an array has no methods at all.

Running them is that library's business too. A library points at a JavaScript
module in its package.json, and the compiler asks it what a call becomes:

```json
"tilua": { "types": "index.d.tilua", "lowering": "lowering.mjs" }
```

```js
// @ts-check
/** @type {import("@tilua/parser").LoweringPlugin} */   // the contract, declared here
const plugin = {
    runtime: { array: "local __NAME__ = {}\nfunction __NAME__.filter(t, test) ... end" },
    methodCall({ method, receiver, use }) {
        if (receiver?.kind === "array" && method === "filter") {
            return { callee: `${use("array")}.filter` }
        }
        return undefined
    },
}
export default plugin
```

`receiver` is the tilua type the analyzer worked out, `use(key)` gives the
local name that table got — emitted once, at the top of the output, only if a
call needed it — and the receiver is passed as the call's first argument. An
answer of `undefined` leaves an ordinary Luau method call, which is what
`text:upper()` wants, since a string already answers to it.

A call can also carry more than was written. Every hook is told `at`, where
the call was written (`{ file, line, column }`), and `arguments`: each one's
type, that type as text, the code it was written as, and, for a name, the
code of what it names. An answer's `prepend` lists Luau expressions to pass
ahead of the written arguments. `globalCall` answers for a call to a global,
such as `print(x)`, and `globalValue` for a global read as a value, such as
`local p = print`. A local with the same name belongs to the author, and no
hook is asked about it. A runtime can read `__LINES__`, the bundle's line map
(`nil` outside a bundle), to turn a line Luau reports back into a place in the
project. `console:log`, `print` and `error` in `@tilua-types/lua` are built on
these hooks.

The compiler lowers the language and nothing else: `filter` appears nowhere in
it.

`@tilua-types/lua` ships the JavaScript-shaped set; there, indices are Luau's (the
first element is 1, `indexOf` answers `nil` rather than -1) and `push`, `pop`,
`shift`, `unshift`, `sort` and `reverse` change the array they are called on.

**A `(` that starts a line** continues the statement above it, as in Lua and
in JavaScript — `const v = map[key]` followed by `("A"):upper()` is one
statement, a call of `map[key]`. tilua says so rather than letting it pass:
write `;` before the `(` when a new statement was meant.

**Object types** — `{ name: T, name?: T, [K]: V }`, and a name that is not an
identifier is quoted, as in the literal: `{ "Respawn After Kill": boolean }`.

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

**Classes** — types are structural, except for classes. A definitions file
declares one with `declare class`, and it is nominal, as Roblox's classes are:

```luau
declare class BasePart extends PVInstance { Size: Vector3 }
declare class Part extends BasePart { Shape: EnumItem }
```

A `Part` is a `BasePart` and an `Instance` because it extends them. A
`ReplicatedStorage` is not a `Part`, and no table literal is an `Instance`,
however alike their members. A class still fits a shape that names members it
has (`{ Name: string }`). It is not a table, though, so `typeof(part)` picks
the `"Instance"` overload, not `"table"`. Members are inherited, and a subclass
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
`__pow`, `__unm`, `__concat`, `__len` (`#v`), `__eq`, `__lt` and `__le` (`<`,
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

Both live on the class table, so an instance carries neither.

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
`[string, ...number[]]`: that many, then any number more. `const a, b = 1, 2`
still pairs names with values one each; `const a, b = f()` is a name short,
and says to write `const [a, b] = f()`.

**A loop takes one value too** — `for (const item in source)`, and several are
an array the pattern takes apart:

```luau
for (const name in names) { print(name) }
for (const [i, name] in ipairs(names)) { print(i, name) }
for (const [key, score] in pairs(scores)) { print(key, score) }
```

The name is `const`, or `let` where the body assigns to it, as anywhere else.
A source is an array or a table, walked for its values; an iterator function,
called until it answers `nil`; or an iteration — `[step, state, first]`, what
`pairs(t)` answers — whose `step` is called with the state and the item before
it. An object says how it is walked with `__iter`, which answers one of those
two. `for (k, v in ...)` and `for (x in f, s, v)` are Luau's packs, and are
syntax errors.

A function that returns nothing returns `nil`: `() => nil`, not `() => ()`.
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
string[]) => nil`. Without an annotation a rest parameter is `unknown[]`. A rest
parameter may also be a tuple, or a type parameter standing for one — then the
arguments are exactly its elements, which is how a function says it forwards
another's:

```luau
declare function spawn<A extends unknown[]>(f: (...args: A) => nil, ...args: A): thread

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
add3(...nums)                    -- however many `nums` turns out to hold
const both = [...names, "z"]
```

What the array holds is checked against what it fills. How many it holds is
not known, so nothing is said about the count — unless it is a tuple, which
holds a known value at each position and is checked one by one. Spreading
something that is not a list is reported.

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

#id                             -- still a string: 5
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
(self, cb: (...args: T) => nil) => Connection }`, given as a tuple —
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

**Trailing commas** are allowed wherever TypeScript allows them: parameter
lists, call arguments, generic parameters and type arguments, tables, arrays,
tuples, imports and exports.

A value read by a key narrows the key: after `const path = paths[stat]`, the
`else` of `if path then` leaves `stat` as exactly the keys `paths` does not
have — the same correlation `pairs` over a record and a destructured union
already get.

**Narrowing** follows TypeScript's model: references (`x`, `x.a.b`, `x["k"]`)
rather than just variables, discriminated unions at any depth, `and`/`or`,
early return, `break`/`continue`, `error()` (declared `=> never`), user type
guards (`v is T`), and assertion signatures (`asserts v`).

Reading a member of, indexing or calling a value that may be nil is an error
until a check narrows the nil away, as with TypeScript's `strictNullChecks`:
`FindFirstChild("A"):FindFirstChild("B")` reports that the first call is
possibly nil. Use `?.` / `?:`, or check first. The read is still typed from the
non-nil part.

Only `nil` and `false` are falsy — `0` and `""` are truthy, unlike JavaScript.

**What Luau raises on is said first.** An operator no metamethod answers takes
numbers — `..` a string or a number, `#` a string or a table — so `n * 2` with
`n` a `number | nil` is an error where it is written rather than where it runs.
A comparison two types can never settle (`s == "c"` with `s` a `"a" | "b"`) is
one too; a test against `nil` never is, since a map's value and an array's
element are read as what they hold. A name holds nothing until its line has
run, a list is indexed by position (`xs["a"]` is not a read), `readonly T[]`
rules out writing to the list as well as passing it where a `number[]` is
wanted, a key written twice in one table is reported, and a parameter with no
type says so — it is `any`, and `any` turns off every check made of it.

**Types** — unions, intersections, tuples `[A, B]` (with a rest, `[A,
...B[]]`), `keyof`, `T[K]`, conditional types with
`infer`, mapped types with `as` remapping, template literal types
(`` `on${Event}` ``), and set difference `A - B`. The utility types
(`Partial`, `Pick`, `Omit`, `ReturnType`, `Parameters`, `Exclude`, …) are
built in, and written in tilua on top of those rather than special-cased in
the analyzer. A type library or a file may declare one again; the later
declaration wins.

A call may write its type arguments out — `find<Folder>("Remotes")`,
`inst:WaitForChild<Folder>("Remotes")` — and a type parameter may have a
default (`<T = Instance>`) for the calls that do not. `a < b > (c)` is still
three operators: only a call after the `>` makes it type arguments.

`<const T>` infers an argument at its narrowest, as in TypeScript 5.

`typeof x` in a type is TypeScript's type query — the type of a value
(`typeof config`, `typeof config.volume`, `ReturnType<typeof f>`). Luau's
`typeof(expr)` spelling works too. It is compile-time only, unrelated to the
`typeof(v)` function that returns a string at runtime.

**Modules** — `import` / `export`, export lists, re-exports and `export *`.

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
`// @ts-...` do. They silence scope and type errors, never syntax errors:

```luau
--@tilua-nocheck          -- before the first line of code: the whole file
--@tilua-ignore           -- the next line of code
--@tilua-expect-error     -- the next line of code, which must have an error
```

`parseWithRecovery` returns them as `directives`; `directivesOf(source)` reads
them for a caller that parsed some other way, and
`applyDirectives(directives, diagnostics, lineOf)` filters a list and names
each `expect-error` that had nothing to suppress.

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

- `export * as ns from` and namespace imports (`import * as ns`) are not
  supported.
- `setmetatable` and metatables are not modelled.
- Accessing a property a type does not have yields `unknown` rather than an
  error; assigning to a `readonly` property is not reported.
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
