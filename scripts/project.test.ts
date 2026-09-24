/**
 * Project tests: configs, type libraries, import paths and sourcemaps.
 *
 * Each case runs against an in-memory file system, so it states exactly the
 * files it needs. No real type library is involved.
 */
import { join, resolve, sep } from "node:path"
import {
    findConfig, loadConfig, resolveTypeLibraries, resolveModulePath, sourceMapTypes,
    parse, parseWithRecovery, analyzeScopes, analyzeTypes, moduleExports, formatType, applyDirectives,
    type ProjectHost, type ModuleExports, type GenericForStatement,
} from "../src/index.js"

const ROOT = resolve("/tilua-project")

let passed = 0
const failures: string[] = []

function check(name: string, actual: unknown, expected: unknown): void {
    const a = JSON.stringify(actual)
    const b = JSON.stringify(expected)
    if (a === b) { passed++; return }
    failures.push(`${name}\n    expected ${b}\n    actual   ${a}`)
}

/** A file system of `files`, paths relative to ROOT. */
function host(files: Record<string, string>): ProjectHost {
    const key = (path: string): string => resolve(ROOT, path).toLowerCase()
    const map = new Map(Object.entries(files).map(([path, text]) => [key(path), text]))
    return {
        readFile: path => map.get(key(path)),
        // The folders directly inside `path`, from the files under it.
        readDirectory: path => {
            const prefix = `${key(path)}${sep}`
            const names = new Set<string>()
            for (const file of map.keys()) {
                if (!file.startsWith(prefix)) continue
                const rest = file.slice(prefix.length).split(sep)
                if (rest.length > 1) names.add(rest[0])
            }
            return names.size ? [...names] : undefined
        },
    }
}

/** A path under ROOT, as the tests write them. */
const rel = (path: string | undefined): string | undefined =>
    path === undefined ? undefined : path.slice(ROOT.length + 1).replace(/\\/g, "/")

// --- the nearest config applies -----------------------------------------
{
    const h = host({
        "tilua.config.json": `{ "types": ["luau"] }`,
        "a.tilua": "",
        "b/tilua.config.json": `{ "types": ["roblox"] }`,
        "b/c.tilua": "",
        "b/deep/d.tilua": "",
    })
    check("config: a file takes the config in its folder",
        rel(findConfig(join(ROOT, "a.tilua"), h).config?.path), "tilua.config.json")
    check("config: a nested folder's config wins",
        rel(findConfig(join(ROOT, "b/c.tilua"), h).config?.path), "b/tilua.config.json")
    check("config: and applies to folders below it",
        findConfig(join(ROOT, "b/deep/d.tilua"), h).config?.types, ["roblox"])
    check("config: a file with no config above it has none",
        findConfig(resolve("/somewhere-else/x.tilua"), h).config, undefined)
}

// --- two configs in one folder -------------------------------------------
{
    const h = host({ "dup/tilua.config.json": "{}", "dup/tilua.config.jsonc": "{}", "dup/x.tilua": "" })
    const lookup = findConfig(join(ROOT, "dup/x.tilua"), h)
    check("config: two in one folder is an error, reported on both",
        [lookup.config, lookup.problems.map(p => rel(p.file))],
        [undefined, ["dup/tilua.config.json", "dup/tilua.config.jsonc"]])
}

// --- reading a config ----------------------------------------------------
{
    const h = host({
        "ok/tilua.config.jsonc": `{\n  // types to load\n  "types": ["luau",],\n  /* the tree */ "sourceMap": "sourcemap.json",\n}\n`,
        "typo/tilua.config.json": `{\n  "types": ["luau"],\n  "typo": true\n}\n`,
        "broken/tilua.config.json": `{\n  "types": [\n}\n`,
        "none/tilua.config.json": `{ "types": [], "paths": {}, "sourceMap": null }`,
        "wrong/tilua.config.json": `{ "types": "luau" }`,
    })
    const ok = loadConfig(join(ROOT, "ok/tilua.config.jsonc"), h)
    check("config: comments and trailing commas are allowed", ok.problems, [])
    check("config: sourceMap resolves from the config's folder", rel(ok.config?.sourceMap ?? undefined), "ok/sourcemap.json")

    const typo = loadConfig(join(ROOT, "typo/tilua.config.json"), h)
    check("config: an unknown option is reported on its line",
        typo.problems.map(p => [p.line, p.message.split(".")[0]]), [[3, "Unknown option 'typo'"]])
    check("config: and the rest of the config still applies", typo.config?.types, ["luau"])

    const broken = loadConfig(join(ROOT, "broken/tilua.config.json"), h)
    check("config: invalid JSON is reported with a position",
        [broken.config, broken.problems.length, typeof broken.problems[0]?.line], [undefined, 1, "number"])
    check("config: a null sourceMap means none", loadConfig(join(ROOT, "none/tilua.config.json"), h).config?.sourceMap, null)
    check("config: an option of the wrong type is reported",
        loadConfig(join(ROOT, "wrong/tilua.config.json"), h).problems.map(p => p.message.split(",")[0]),
        ["'types' must be an array of strings"])
}

// --- type libraries -------------------------------------------------------
{
    const files: Record<string, string> = {
        "node_modules/@tilua-types/luau/package.json": JSON.stringify({ name: "@tilua-types/luau", tilua: { types: "index.d.tilua" } }),
        "node_modules/@tilua-types/luau/index.d.tilua": "declare function print(...: unknown): nil",
        "node_modules/@tilua-types/roblox/package.json": JSON.stringify({ name: "@tilua-types/roblox", dependencies: { "@tilua-types/luau": "^1.0.0" } }),
        "node_modules/@tilua-types/roblox/index.d.tilua": "declare game: unknown",
        "node_modules/plain/index.d.tilua": "declare plain: number",
        "node_modules/@me/extra/package.json": JSON.stringify({ name: "@me/extra", dependencies: { "@tilua-types/luau": "^1.0.0" } }),
        "node_modules/@me/extra/index.d.tilua": "declare extra: number",
        "node_modules/@me/tool/package.json": JSON.stringify({ name: "@me/tool" }),
        "local/types/index.d.tilua": "declare fromFolder: number",
        "local/defs.d.tilua": "declare fromFile: number",
    }
    const libraries = (types: string[], folder = ""): { files: (string | undefined)[]; problems: string[] } => {
        const h = host({ ...files, [`${folder}tilua.config.json`]: JSON.stringify({ types }) })
        const config = loadConfig(join(ROOT, `${folder}tilua.config.json`), h).config!
        const result = resolveTypeLibraries(config, h)
        return { files: result.files.map(rel), problems: result.problems.map(p => p.message) }
    }
    const LUAU = "node_modules/@tilua-types/luau/index.d.tilua"
    const ROBLOX = "node_modules/@tilua-types/roblox/index.d.tilua"

    check("types: nothing is loaded by default", libraries([]).files, [])
    check("types: a library brings its dependencies first", libraries(["roblox"]).files, [LUAU, ROBLOX])
    check("types: a library listed twice loads once", libraries(["luau", "roblox"]).files, [LUAU, ROBLOX])
    check("types: a full package name", libraries(["@tilua-types/roblox"]).files, [LUAU, ROBLOX])
    check("types: a name that is not one of @tilua-types is the package of that name", libraries(["plain"]).files,
        ["node_modules/plain/index.d.tilua"])
    check("types: a scoped name of anyone's, dependencies first", libraries(["@me/extra"]).files,
        [LUAU, "node_modules/@me/extra/index.d.tilua"])
    check("types: `@tilua-types/*` is every one installed, each after what it needs", libraries(["@tilua-types/*"]).files,
        [LUAU, ROBLOX])
    check("types: a pattern passes over packages that are not type libraries", libraries(["@me/*", "plain"]).files,
        [LUAU, "node_modules/@me/extra/index.d.tilua", "node_modules/plain/index.d.tilua"])
    check("types: a pattern nothing matches says so", libraries(["@nobody/*"]).problems,
        ["No installed type library matches '@nobody/*'"])
    check("types: a folder and a file by relative path",
        libraries(["./local/types", "./local/defs.d.tilua"]).files, ["local/types/index.d.tilua", "local/defs.d.tilua"])
    check("types: node_modules is searched upward from a nested config", libraries(["luau"], "nested/").files, [LUAU])
    check("types: a missing library says how to install it", libraries(["nope"]),
        { files: [], problems: ["Cannot find type library '@tilua-types/nope' or 'nope'. Install it with: npm i -D @tilua-types/nope"] })
    check("types: a missing scoped one, by its own name", libraries(["@me/gone"]).problems,
        ["Cannot find type library '@me/gone'. Install it with: npm i -D @me/gone"])
}

// --- import paths -----------------------------------------------------------
{
    const h = host({
        "tilua.config.json": JSON.stringify({
            baseUrl: "src",
            paths: {
                "@shared/*": ["shared/*"],
                "@shared/special/*": ["special/*"],
                "@config": ["config/index.tilua"],
            },
        }),
        "src/main.tilua": "",
        "src/sibling.tilua": "",
        "src/shared/util.tilua": "",
        "src/special/thing.tilua": "",
        "src/config/index.tilua": "",
    })
    const config = loadConfig(join(ROOT, "tilua.config.json"), h).config!
    const from = join(ROOT, "src/main.tilua")
    const resolved = (specifier: string): string | undefined => rel(resolveModulePath(from, specifier, config, h))

    check("paths: a relative import", resolved("./sibling"), "src/sibling.tilua")
    check("paths: a `*` alias, from baseUrl", resolved("@shared/util"), "src/shared/util.tilua")
    check("paths: an exact alias", resolved("@config"), "src/config/index.tilua")
    check("paths: the longest matching prefix wins", resolved("@shared/special/thing"), "src/special/thing.tilua")
    check("paths: neither relative nor aliased resolves to nothing", resolved("somewhere"), undefined)
}

// --- sourcemap ------------------------------------------------------------
// Only the conversion itself. What the resulting types mean depends on the
// class definitions a project loads, which the parser does not ship.
{
    const classes = new Set(["Instance", "DataModel", "ReplicatedStorage", "Folder", "ModuleScript", "Workspace", "Part"])
    const tree = {
        name: "Game", className: "DataModel", children: [
            { name: "ReplicatedStorage", className: "ReplicatedStorage", children: [
                { name: "Shared", className: "Folder", children: [
                    { name: "Util", className: "ModuleScript", filePaths: ["src/shared/Util.luau"] },
                    { name: "Remotes", className: "Folder" },
                ] },
            ] },
            { name: "Workspace", className: "Workspace", children: [
                { name: "Spawn", className: "Part" },
            ] },
        ],
    }
    const { types, problem } = sourceMapTypes(JSON.stringify(tree), join(ROOT, "sourcemap.json"), { classes })
    check("sourcemap: turns into types", problem, undefined)
    check("sourcemap: a mapped file gets its own `script`",
        types!.scriptFor(join(ROOT, "src/shared/Util.tilua")) !== undefined, true)
    check("sourcemap: an unmapped file has no `script` of its own",
        types!.scriptFor(join(ROOT, "src/other.tilua")), undefined)
    // A library may type a service as a member of `DataModel`; the service in
    // the tree still takes that member over, so `game.ReplicatedStorage.Shared`
    // is typed. Any other child a member already names is left out.
    const roblox = parse([
        "declare class Instance { Name: string }",
        "declare class Folder extends Instance { }",
        "declare class ModuleScript extends Instance { }",
        "declare class Part extends Instance { }",
        "declare class ReplicatedStorage extends Instance { }",
        "declare class Workspace extends Instance { }",
        "declare class DataModel extends Instance { ReplicatedStorage: ReplicatedStorage, Workspace: Workspace }",
    ].join("\n"))
    const withServices = sourceMapTypes(JSON.stringify(tree), join(ROOT, "sourcemap.json"), {
        classes,
        membersOf: className => new Set(className === "DataModel" ? ["Name", "ReplicatedStorage", "Workspace"] : ["Name"]),
    }).types!
    const reads = parse("const remotes: Folder = game.ReplicatedStorage.Shared.Remotes")
    check("sourcemap: a service child takes over the member of the same name",
        analyzeTypes(reads, analyzeScopes(reads), { libs: [roblox, withServices.program] }).diagnostics.map(d => d.message), [])
    check("sourcemap: invalid JSON is reported",
        sourceMapTypes("{ nope", join(ROOT, "sourcemap.json"), { classes }).problem?.startsWith("Invalid sourcemap"), true)
}

// --- the language -----------------------------------------------------------
{
    /** Scope and type errors of `code`, importing from the modules in `modules`. */
    const analyze = (code: string, modules: Record<string, string> = {}) => {
        const program = parse(code)
        const scopes = analyzeScopes(program)
        const resolveModule = (specifier: string): ModuleExports | undefined => {
            const source = modules[specifier]
            if (source === undefined) return undefined
            const p = parse(source)
            const s = analyzeScopes(p)
            return moduleExports(p, s, analyzeTypes(p, s))
        }
        const types = analyzeTypes(program, scopes, { resolveModule })
        const bindings: Record<string, string> = {}
        for (const [id, type] of types.bindingType) bindings[scopes.bindings.get(id)!.name] = formatType(type)
        return {
            errors: [...scopes.diagnostics, ...types.diagnostics].map(d => d.message),
            bindings,
        }
    }
    const parseError = (code: string): string | undefined => {
        try {
            parse(code)
            return undefined
        } catch (error) {
            return (error as Error).message.replace(/ \(\d+:\d+\).*$/, "").replace(/, got .*$/, "")
        }
    }

    // Functions have no `const` / `let`: `function f()` declares `f`.
    check("functions: `function name()` declares a function", analyze("function twice(n: number): number { return n * 2 }\nconst four = twice(2)").bindings.four, "number")
    check("functions: its name cannot be reassigned", analyze("function f() { }\nf = nil").errors, ["Cannot assign to 'f' — it is a function"])
    // Each overload must be one the implementation can serve.
    check("overloads: a signature the implementation serves", analyze([
        "function f(a: \"x\", b?: number): number",
        "function f(a: \"y\"): number",
        "function f(a, b: number = 1) { return b }",
        "class A {",
        "    function m(a: number): number",
        "    function m(a: number, b: number): number",
        "    function m(a: number, b?: number) { return a }",
        "}",
    ].join("\n")).errors, [])
    check("overloads: a signature the implementation cannot serve", [
        "function f(a: string, b?: number): number\nfunction f(a) { return 1 }",
        "function f(a: string): number\nfunction f(a: string, b: number) { return b }",
        "function f(...xs: number[]): number\nfunction f(a: number) { return a }",
        "function f(a: string): number\nfunction f(a: number) { return a }",
        "function f(a: string): string\nfunction f(a: string): number { return 1 }",
        "class A {\n    function m(a: number, b: number): number\n    function m(a: number) { return a }\n}",
    ].map(code => analyze(code).errors), [
        ["This overload takes parameter 'b', which the implementation does not have: it takes 1 parameter"],
        ["The implementation requires 2 arguments, and this overload passes at most 1"],
        ["This overload takes a rest parameter, which the implementation does not have"],
        ["Parameter 'a' of this overload is 'string', which the implementation's 'number' does not accept"],
        ["This overload returns 'string', which the implementation's 'number' cannot be"],
        ["This overload takes parameter 'b', which the implementation does not have: it takes 1 parameter"],
    ])
    check("functions: `const function` is not tilua", parseError("const function f() {}"),
        "A function is declared as 'function name()'; 'const' does not apply to functions")
    check("functions: exported with `export function`", analyze(`import { twice } from "./m"\nconst n = twice(1)`,
        { "./m": "export function twice(n: number): number { return n * 2 }" }).bindings.n, "number")

    // `import * as`
    const namespace = analyze(
        `import * as Shapes from "./shapes"\nconst area = Shapes.area(2)\nconst c: Shapes.Circle = { r: 1 }\nconst d = Shapes.default`,
        { "./shapes": "export type Circle = { r: number }\nexport function area(r: number): number { return r * r }\nexport default 3" })
    check("imports: `import * as` holds the module's exports", [namespace.bindings.area, namespace.bindings.c, namespace.bindings.d], ["number", "{ r: number }", "3"])
    check("imports: and its types, by qualified name", namespace.errors, [])

    // Imports are read-only.
    check("imports: an imported name cannot be assigned",
        analyze(`import { value } from "./m"\nvalue = 2`, { "./m": "export const value = 1" }).errors, ["Cannot assign to 'value' — it is an import"])
    check("imports: nor can a module's exports through its namespace",
        analyze(`import * as M from "./m"\nM.value = 2\nfunction M.extra() { }`, { "./m": "export const value = 1" }).errors,
        ["Cannot assign to a member of 'M' — a module's exports are read-only", "Cannot assign to a member of 'M' — a module's exports are read-only"])

    // `import type`: types only.
    const shapes = { "./shapes": "export type Circle = { r: number }\nexport function area(r: number): number { return r * r }\nexport default 3" }
    check("import type: its names work as types, typeof included", analyze([
        `import type { Circle, area } from "./shapes"`,
        `import type * as S from "./shapes"`,
        `import type D from "./shapes"`,
        `const c: Circle = { r: 1 }`,
        `const d: S.Circle = c`,
        `const f: typeof area = function(r: number): number { return r }`,
        `const n: typeof D = 3`,
    ].join("\n"), shapes).errors, [])
    check("import type: a name used as a value is an error", analyze([
        `import type { area } from "./shapes"`,
        `import type * as S from "./shapes"`,
        `area(2)`,
        `area = nil`,
        `print(S.area)`,
    ].join("\n"), shapes).errors, [
        "'area' is imported with 'import type' and can only be used as a type",
        "'area' is imported with 'import type' and can only be used as a type",
        "'S' is imported with 'import type' and can only be used as a type",
    ])
    check("import type: `import type from` is a default import named type",
        analyze(`import type from "./shapes"\nprint(type)`, shapes).errors, [])

    // A recursive alias keeps a ref to itself inside its structure. That ref
    // means the alias of the module that wrote it, whatever the importer names.
    const buttons = { "./buttons": [
        "export type Btn = { SetLocked: (self: Btn, v: boolean) => nil, Group?: { Current?: Btn } }",
        "export type Card = { Button?: Btn }",
    ].join("\n") }
    const lockCard = (arg: string) => `function f(card: Card) { if (card.Button) { card.Button:SetLocked(${arg}) } }`
    check("import type: a recursive alias works without importing its name",
        analyze(`import type { Card } from "./buttons"\n${lockCard("true")}`, buttons).errors, [])
    check("import type: and a local type of the same name does not replace it",
        analyze(`import type { Card } from "./buttons"\ntype Btn = { Other: string }\n${lockCard("true")}`, buttons).errors, [])
    check("import type: while a real mismatch is still reported",
        analyze(`import type { Card } from "./buttons"\n${lockCard(`"x"`)}`, buttons).errors,
        [`Argument of type '"x"' is not assignable to parameter of type 'boolean'`])

    // Widening is for literals a program wrote, not for a type an alias names.
    const iterate = (loop: string) => analyze([
        "declare function pairs<K, V>(t: { [K]: V }): [(t: { [K]: V }, previous: [K, V] | nil) => [K, V] | nil, { [K]: V }, nil]",
        `type Btn = { Mode: "A" | "B" }`,
        "type Card = { Button?: Btn }",
        "declare cards: { [string]: Card }",
        "function apply(c: Card) { }",
        loop,
    ].join("\n"))
    check("widening: a value read from a declared table keeps its alias's literals",
        iterate("for (const [_, card] in pairs(cards)) { apply(card) }").errors, [])
    check("widening: a fresh literal still widens",
        iterate(`let fresh = { Mode: "A" }`).bindings.fresh, "{ Mode: string }")

    // An indexer is a promise about every key it covers.
    check("indexers: every property must hold the indexer's type", analyze([
        "declare find: () => string | nil",
        "const bad: { [string]: number } = { a: find(), b: 1 }",
        "const good: { [string]: number } = { a: 1, b: 2 }",
    ].join("\n")).errors, ["Type '{ a: string | nil, b: number }' is not assignable to '{ [string]: number }'"])

    // `pairs` over a record: literal keys, correlated with their values.
    const record = analyze([
        "type Event = { kind: \"event\" }",
        "type Func = { kind: \"function\" }",
        "declare remotes: { Char: Event, Settings: Func, Maybe: Event | nil }",
        "function scan() {",
        "    for (const [name, remote] in pairs(remotes)) {",
        "        const anyName = name",
        "        if (remote == nil) { return }",
        "        if (name == \"Settings\") {",
        "            const settings = remote",
        "        } elseif (name == \"Char\") {",
        "            const char = remote",
        "        } else {",
        "            const rest = remote",
        "            const restName = name",
        "        }",
        "        if (remote.kind == \"function\") {",
        "            const fromValue = name",
        "        }",
        "    }",
        "}",
        "",
        "",
    ].join("\n"))
    check("pairs: a record's keys are its property names",
        record.bindings.anyName, `"Char" | "Settings" | "Maybe"`)
    check("pairs: testing the key narrows the value, and the other way round",
        [record.bindings.settings, record.bindings.char, record.bindings.rest, record.bindings.restName, record.bindings.fromValue],
        ["Func", "Event", "Event", `"Maybe"`, `"Settings"`])

    const destructured = analyze([
        "type Shape = { kind: \"circle\", radius: number } | { kind: \"rect\", w: number }",
        "function f(shape: Shape) {",
        "    const { kind, radius } = shape",
        "    if (kind == \"circle\") { const r = radius }",
        "}",
        "function g({ kind, w }: Shape) {",
        "    if (kind == \"rect\") { const width = w }",
        "}",
        "",
        "",
    ].join("\n"))
    check("destructuring: names taken from one union member narrow together",
        [destructured.bindings.r, destructured.bindings.width], ["number", "number"])

    // An empty array takes its type from where it is written.
    check("arrays: an empty array fits an annotation", analyze([
        "let waiting: thread[] = []",
        "const config: { list: number[], nested: { names: string[] } } = { list: [], nested: { names: [] } }",
        "function take(xs: string[]) { }",
        "take([])",
        "let later: number[] = [1]",
        "later = []",
        "const grid: number[][] = [[], [1]]",
        "",
        "",
    ].join("\n")).errors, [])
    check("arrays: and still checks what it holds", analyze(`const wrong: number[] = ["a"]`).errors, ["Type 'string[]' is not assignable to 'number[]'"])

    // Recovery: a syntax error costs as little of the tree as it can.
    const recovered = (code: string) => {
        const { program, errors } = parseWithRecovery(code)
        const scopes = analyzeScopes(program)
        const types = analyzeTypes(program, scopes)
        const bindings: Record<string, string> = {}
        for (const [id, type] of types.bindingType) bindings[scopes.bindings.get(id)!.name] = formatType(type)
        return {
            errors: errors.map(e => e.message.replace(/, got .*$/, "").replace(/ \(\d+:\d+\)$/, "")),
            statements: program.body.statements.map(st => st.type),
            bindings,
        }
    }
    {
        const r = recovered([
            "const Config = {",
            "    a: 1,",
            "    b: ,",
            "    c: \"x\"",
            "    d: 4,",
            "    run: function() { return 1 },",
            "}",
            "const after = Config.d",
        ].join("\n"))
        check("recovery: a broken field value and a missing comma keep the rest of the object",
            [r.errors, r.bindings.Config, r.bindings.after],
            [["Unexpected token in expression", "Expected ','"], "{ a: number, b: any, c: string, d: number, run: () => 1 }", "number"])
    }
    {
        const r = recovered([
            "const Obj = {",
            "    a: foo bar,",
            "    f: function(x: number) {",
            "        if (x) { return 1 }",
            "        return 2",
            "    },",
            "    g: 5,",
            "}",
            "const after = Obj.g",
        ].join("\n"))
        check("recovery: skipping stops at the next field, not at a `}` inside the object",
            [r.statements, r.bindings.after], [["VariableDeclaration", "VariableDeclaration"], "number"])
    }
    {
        const r = recovered([
            "function f(x: number) {",
            "    if (x ==) {",
            "        print(x)",
            "    }",
            "    return x",
            "}",
            "const after = f(1)",
        ].join("\n"))
        check("recovery: a broken condition keeps its `if`, so its `}` closes the right block",
            [r.errors, r.statements, r.bindings.after], [["Unexpected token in expression"], ["FunctionDeclaration", "VariableDeclaration"], "number"])
    }
    {
        const r = recovered([
            "function a() {",
            "    if (true) {",
            "        print(1)",
            "}",
            "function b(): number {",
            "    return 2",
            "}",
            "const after = b()",
        ].join("\n"))
        check("recovery: a missing `}` is placed by indentation",
            [r.errors.length > 0, r.statements, r.bindings.after],
            [true, ["FunctionDeclaration", "FunctionDeclaration", "VariableDeclaration"], "number"])
    }
    {
        const r = recovered([
            "const a = \"unclosed",
            "local b = 2",
            "const part = { Name: \"x\" }",
            "const n = part.",
            "}",
            "const c: { x: number, y: } = { x: 1, y: 2 }",
            "const s = `${1 +}`",
            "print(1, +, 3",
            "const d =",
        ].join("\n"))
        check("recovery: strings, `local`, `obj.`, a stray `}`, types, interpolation, calls and initializers", [r.errors, Object.keys(r.bindings)], [[
            "Unterminated string",
            "tilua has no 'local'; declare with 'const' or 'let'",
            // `part.` is followed by the stray `end`: one problem, reported once.
            "Expected identifier",
            "Unexpected token in type annotation",
            "In '${1 +}': Unexpected token in expression",
            "Unexpected token in expression",
            "Expected ')'",
            "Unexpected token in expression",
        ], ["scriptArgs", "print", "a", "b", "part", "n", "c", "s", "d"]])
    }

    // `satisfies`: checked against the contract, typed as the value.
    const satisfied = analyze([
        "type Shape = { kind: \"circle\" | \"rect\", size: number }",
        "const circle = { kind: \"circle\", size: 2 } satisfies Shape",
        "const config = { debug: false, level: 3, tags: [\"a\"] } satisfies { debug: boolean, level: 1 | 2 | 3, tags: string[] }",
        "const handlers = { Click: function(x) { return x + 1 } } satisfies { [string]: (x: number) => number }",
        "const empty = [] satisfies number[]",
        "const five = 5 satisfies number",
        "let widened = 5 satisfies number",
        "const tri = { kind: \"tri\", size: 1 } satisfies Shape",
        "const extra = { kind: \"rect\", size: 1, colour: \"red\" } satisfies Shape",
        "const nested = { inner: { a: 1, b: 2 } } satisfies { inner: { a: number } }",
        "const annotated: Shape = { kind: \"rect\", size: 1, typo: 1 }",
        "const loose: { [string]: number } = { anything: 1 }",
        "",
        "",
    ].join("\n"))
    check("satisfies: the value keeps its own type, with the contract's literals",
        [satisfied.bindings.circle, satisfied.bindings.config, satisfied.bindings.handlers, satisfied.bindings.empty, satisfied.bindings.five, satisfied.bindings.widened],
        [`{ kind: "circle", size: number }`, "{ debug: boolean, level: 3, tags: string[] }", "{ Click: (x: number) => number }", "number[]", "5", "number"])
    check("satisfies: a value that does not fit, and properties the contract does not know", satisfied.errors, [
        `Type '{ kind: "tri", size: number }' does not satisfy the expected type 'Shape', 'kind' is "tri", not "circle" | "rect"`,
        "Object literal may only specify known properties, and 'colour' does not exist in type 'Shape'",
        "Object literal may only specify known properties, and 'b' does not exist in type '{ a: number }'",
        "Object literal may only specify known properties, and 'typo' does not exist in type 'Shape'",
    ])

    const constSatisfied = analyze([
        "const Names = [\"Sans\", \"Asgore\"] as const",
        "const Map = {",
        "    Sans: { Thumbnail: \"id://1\" },",
        "    Asgore: { Thumbnail: \"id://2\" },",
        "} as const satisfies { [K in typeof Names[number]]: { Thumbnail: string } }",
        "const Short = { Sans: { Thumbnail: 1 } } as const satisfies { [K in typeof Names[number]]: { Thumbnail: string } }",
        "const Extra = { a: 1, b: 2 } as const satisfies { a: number }",
    ].join("\n"))
    check("satisfies: `as const satisfies` keeps the value readonly and literal",
        [constSatisfied.bindings.Map, constSatisfied.errors], [
            `{ readonly Asgore: { readonly Thumbnail: "id://2" }, readonly Sans: { readonly Thumbnail: "id://1" } }`,
            [
                `Type '{ readonly Sans: { readonly Thumbnail: 1 } }' does not satisfy the expected type '{ Asgore: { Thumbnail: string }, Sans: { Thumbnail: string } }', missing Asgore: { Thumbnail: string }`,
                "Object literal may only specify known properties, and 'b' does not exist in type '{ a: number }'",
            ],
        ])

    // Names nothing declares, when asked for.
    {
        const program = parse("counter = 1\nprint(counter, typo)\ndeclare later: number\nprint(later, Missing.x)\nconst local = 1\nprint(local)")
        const scopes = analyzeScopes(program, { builtinGlobals: ["print"], reportUndeclared: true })
        check("undeclared: reads of names nothing declares, assigns or `declare`s",
            scopes.diagnostics.map(d => `${d.node.line.start}: ${d.message}`), ["2: Cannot find name 'typo'", "4: Cannot find name 'Missing'"])
        check("undeclared: off unless asked for", analyzeScopes(program).diagnostics, [])
    }

    // `map[name]` with a generic index waits for the call to say which key.
    const generics = analyze([
        "type RemoteMap = { Char: number, Telek: string }",
        "declare map: RemoteMap",
        "function get<K extends keyof RemoteMap>(name: K) {",
        "    return map[name]",
        "}",
        "const char = get(\"Char\")",
        "const telek = get(\"Telek\")",
        "const signature = get",
        "",
        "",
    ].join("\n"))
    check("generics: an index the call decides is read when it does",
        [generics.errors, generics.bindings.char, generics.bindings.telek, generics.bindings.signature],
        [[], "number", "string", `<K extends "Char" | "Telek">(name: K) => RemoteMap[K]`])

    // Packs are gone: nothing is `nil`, several values are a tuple, and a
    // function returns one value.
    check("packs: `()`, `(A, B)`, `T...` and `return a, b` say what to write instead", [
        "type F = () => ()",
        "type G = () => (number, string)",
        "type S<T...> = T",
        "function f(): [number, number] {\n    return 1, 2\n}",
    ].map(code => parseWithRecovery(code).errors.map(e => e.message)), [
        ["'()' is not a type: a function that returns nothing returns 'nil' (1:16)"],
        ["Several types in parentheses are a pack, which tilua does not have: write a tuple, '[A, B]' (1:16)"],
        ["tilua has no pack parameters: write '<T extends unknown[]>', and take it as '...args: T' (1:9)"],
        ["A function returns one value: return several as an array, 'return [a, b]' (2:5)"],
    ])

    // Bare `...` is gone: a function takes a rest parameter, and what a script
    // was started with is `scriptArgs`.
    check("varargs: bare `...` is a syntax error that says what to write", [
        parseWithRecovery("function f(...) {}").errors.map(e => e.message),
        parseWithRecovery("function f(...: number) {}\nconst x = ...").errors.map(e => e.message),
        analyze("const first = scriptArgs[1]").bindings.scriptArgs,
    ], [
        ["tilua has no bare '...': take a rest parameter, '...args: T[]', or 'scriptArgs' for the script's own (1:12)"],
        ["tilua has no bare '...': take a rest parameter, '...args: T[]', or 'scriptArgs' for the script's own (1:12)", "tilua has no bare '...': take a rest parameter, '...args: T[]', or 'scriptArgs' for the script's own (2:11)"],
        "unknown[]",
    ])

    // What Luau raises on, said before it runs. An operator no metamethod
    // answers takes numbers (`..` a string or a number, `#` a string or a
    // table), and `any` passes because nothing is known about it.
    check("operators: the operands are checked where no metamethod answers", [
        analyze("function f(n: number | nil) { return n * 2 }").errors,
        analyze("function f(s: string) { return s * 2 }").errors,
        analyze("function f(a: any) { return a * 2 }").errors,
        analyze("function f(s: string | nil) { return s .. \"x\" }").errors,
        analyze("function f(n: number) { return n .. \"x\" }").errors,
        analyze("function f(n: number) { return #n }").errors,
        analyze("function f(a: number, b: string) { return a < b }").errors,
        analyze("function f(a: string, b: string) { return a < b }").errors,
    ], [
        ["Operator '*' cannot be applied to types 'number | nil' and '2'"],
        ["Operator '*' cannot be applied to types 'string' and '2'"],
        [],
        ["Operator '..' cannot be applied to types 'string | nil' and '\"x\"'"],
        [],
        ["Operator '#' cannot be applied to type 'number'"],
        ["Operator '<' cannot be applied to types 'number' and 'string'"],
        [],
    ])

    // A comparison whose answer is settled by the types was not the one meant.
    // A test against nil is never that: a map's value is read as what it
    // holds, so nil is exactly what it may still turn out to be.
    check("comparison: two types with no value in common", [
        analyze("function f(s: \"a\" | \"b\") { return s == \"c\" }").errors,
        analyze("function f(s: \"a\" | \"b\") { return s == \"a\" }").errors,
        analyze("function f(a: number, b: string) { return a == b }").errors,
        analyze("function f(n: number) { return n == nil }").errors,
        analyze("function f(a: any, b: number) { return a == b }").errors,
    ], [
        ["This comparison is always false: '\"a\" | \"b\"' and '\"c\"' have no value in common"],
        [],
        ["This comparison is always false: 'number' and 'string' have no value in common"],
        [],
        [],
    ])

    // A type parameter written in two places is pinned down by the first
    // argument, and an argument that disagrees is reported rather than
    // widening it away — while one `...rest: T[]` gathers all of its own.
    // A callback written at the call site is read last, with `T` in hand.
    {
        const lib = [
            "declare function find<T>(t: T[], value: T): number | nil",
            "declare function pair<T>(a: T, b: T): T",
            "declare function firstOf<T>(...items: T[]): T",
            "declare function map<T, U>(xs: T[], f: (v: T) => U): U[]",
            "declare xs: { Name: string }[]",
            "declare ns: number[]",
        ].join("\n") + "\n"
        const call = (line: string) => analyze(lib + line)
        check("inference: the first argument pins a type parameter down, and a callback is read last", [
            call("const i = find(xs, function(v) { return true })").errors,
            call("const i = find(xs, 1)").errors,
            call("const p = pair(1, \"a\")").errors,
            call("const p = pair(1, 2)").bindings.p,
            call("const v = firstOf(1, \"a\")").bindings.v,
            call("const ys = map(ns, function(v) { return v + 1 })").bindings.ys,
            call("const ys = map(ns, (v) => v > 1)").bindings.ys,
        ], [
            ["Parameter 'v' has no type, so it is 'any': give it one, or a default to read it from", "Argument of type '(v: any) => true' is not assignable to parameter of type '{ Name: string }'"],
            ["Argument of type '1' is not assignable to parameter of type '{ Name: string }'"],
            ["Argument of type '\"a\"' is not assignable to parameter of type 'number'"],
            "number",
            "number | string",
            "number[]",
            "boolean[]",
        ])
    }

    // A name holds nothing until its line has run, a list is indexed by
    // position, `readonly` is a promise about the list itself, a key written
    // twice is a typo, and a parameter with no type turns off every check
    // made of it.
    check("strictness: what TypeScript reports, and tilua now does too", [
        analyze("function f() {\n    print(later)\n    const later = 1\n}").errors,
        analyze("function f(xs: number[]) { return xs[\"a\"] }").errors,
        analyze("const ro: readonly number[] = [1]\nro[1] = 2").errors,
        analyze("declare ro: readonly number[]\nconst xs: number[] = ro").errors,
        analyze("declare xs: number[]\nconst ro: readonly number[] = xs").errors,
        analyze("const o = { a: 1, a: 2 }").errors,
        analyze("declare base: { a: number }\nconst o = { ...base, a: 2 }").errors,
        analyze("function f(a) { return a }").errors,
        analyze("function take(f: (a: number) => nil): nil { return nil }\ntake(function(a) { print(a) })").errors,
    ], [
        ["'later' is used before its declaration, and holds nothing until that line has run"],
        ["Type '\"a\"' cannot be used to index type 'number[]'"],
        ["Cannot assign to an element of 'readonly number[]': it is read-only"],
        ["Type 'readonly number[]' is not assignable to 'number[]'"],
        [],
        ["'a' is given twice in this table; only the last one is kept"],
        [],
        ["Parameter 'a' has no type, so it is 'any': give it one, or a default to read it from"],
        [],
    ])

    // A loop takes one value each time: Luau's `for k, v in ...` and its
    // triplet `in f, s, v` are both packs, and say what to write instead.
    check("loops: a loop names one value, and has one source", [
        parseWithRecovery("for (k, v in pairs(t)) { }").errors.map(e => e.message),
        parseWithRecovery("for (item in items) { }").errors.map(e => e.message),
        parseWithRecovery("for (const i = 1, 10) { }").errors.map(e => e.message),
        analyze("declare names: string[]\nfor (let name in names) { name = name .. \"!\" }\nfor (const other in names) { other = \"x\" }").errors,
        parseWithRecovery("for (const x in f, s, v) { }").errors.map(e => e.message),
        analyze("declare n: number\nfor (const x in n) { }").errors,
    ], [
        ["A loop takes one value each time: take its parts with a destructuring, 'for (const [k, v] in pairs(t))' (1:7)"],
        ["A loop over a source names its value with 'const' or 'let': 'for (const item in source)' (1:1)"],
        ["A counting loop names its variable without 'const': 'for (i = 1, 10)' (1:1)"],
        ["Cannot assign to 'other' — it is a const"],
        ["A loop has one source: an array, a table, an iterator function or an iteration '[step, state, first]' (1:18)"],
        ["Cannot loop over 'number': a loop walks an array, a table, an iterator function or an iteration such as 'pairs(t)'"],
    ])

    // A closure written inside a value can read the name that value is bound
    // to — it runs later, as in JavaScript.
    {
        const program = parse([
            "function Setup() {",
            "    let EventManager = {",
            "        Connections: [],",
            "        Disconnect: function() {",
            "            return EventManager.Connections",
            "        }",
            "    }",
            "    return EventManager",
            "}",
            "function Sibling() {",
            "    const read = function() { return later }",
            "    const later = 7",
            "    return read()",
            "}",
            "const shadow = 1",
            "do {",
            "    const shadow = shadow + 1",
            "    print(shadow)",
            "}",
            "",
            "",
        ].join("\n"))
        const scopes = analyzeScopes(program, { builtinGlobals: ["print"], reportUndeclared: true })
        const types = analyzeTypes(program, scopes)
        const bindings: Record<string, string> = {}
        for (const [id, type] of types.bindingType) bindings[scopes.bindings.get(id)!.name] = formatType(type)
        check("forward references: a closure reads the name being declared, and a later sibling",
            [scopes.diagnostics.map(d => d.message), bindings.read], [[], "() => 7"])
        // The initializer itself still reads what was there before it.
        const shadows = [...scopes.bindings.values()].filter(b => b.name === "shadow")
        check("forward references: but an initializer still shadows rather than reads itself",
            shadows.length, 2)
    }

    // An inferred return type reads each `return` where it stands.
    const inferredReturns = analyze([
        "declare class NumberValue { Value: number }",
        "declare function plain(): NumberValue | nil",
        "function narrowed() {",
        "    const v = plain()",
        "    if (v) { return v.Value }",
        "    return 0",
        "}",
        "function branches() {",
        "    const n = 5",
        "    if (n) { return n }",
        "    return 0",
        "}",
        "function nested() {",
        "    const inner = function() {",
        "        return \"inner\"",
        "    }",
        "    return inner",
        "}",
        "const a = narrowed()",
        "",
        "",
    ].join("\n"))
    check("returns: inferred from inside the branch that narrowed the value",
        [inferredReturns.errors, inferredReturns.bindings.narrowed, inferredReturns.bindings.branches, inferredReturns.bindings.nested],
        [[], "() => number", "() => 5 | 0", `() => () => "inner"`])

    // What a function returns is checked against what it declared.
    const returns = analyze([
        "declare function print(v: unknown): nil",
        "declare function error(message: string): never",
        "function wrong(): boolean {",
        "    return \"\"",
        "}",
        "function bare(): boolean {",
        "    return",
        "}",
        "function never(): boolean {",
        "    print(1)",
        "}",
        "function pack(): [boolean, string] {",
        "    return [true, 2]",
        "}",
        "function fine(): boolean {",
        "    if (true) { return true } else { return false }",
        "}",
        "function optional(): boolean | nil {",
        "}",
        "function guard(v: unknown): v is string {",
        "    return type(v) == \"string\"",
        "}",
        "function asserted(v: boolean): asserts v {",
        "    if (not v) { error(\"no\") }",
        "}",
        "function inferred() {",
        "    return \"anything\"",
        "}",
        "",
        "",
    ].join("\n"))
    check("returns: a value that does not fit, and a body that never returns one", returns.errors, [
        `Type '""' is not assignable to 'boolean'`,
        "Type 'nil' is not assignable to 'boolean'",
        "A function that returns 'boolean' must return a value",
        "Type '[boolean, number]' is not assignable to '[boolean, string]'",
    ])

    // A type name nothing declares, when asked for.
    {
        const program = parse([
            "type Mine = { a: number }",
            "declare class Part {}",
            "const ok: Mine | Part | number = 1",
            "function generic<T>(v: T): T {",
            "    return v",
            "}",
            "const bad: Nope = 1",
            "const alsoBad: Partial<Missing> = {}",
            "function f(a: NoParam): NoReturn {",
            "    return a",
            "}",
            "",
            "",
        ].join("\n"))
        const scopes = analyzeScopes(program)
        const types = analyzeTypes(program, scopes, { reportUnknownTypes: true })
        check("types: a name nothing declares is reported, once, and nothing else is",
            types.diagnostics.map(d => `${d.node.line.start}: ${d.message}`), [
                "7: Cannot find name 'Nope'",
                "8: Cannot find name 'Missing'",
                "9: Cannot find name 'NoParam'",
                "9: Cannot find name 'NoReturn'",
            ])
        check("types: and it is off unless asked for",
            analyzeTypes(program, analyzeScopes(program)).diagnostics.length, 0)
    }

    // Reading a table with a key that is one of several.
    const indexed = analyze([
        "const Paths = {",
        `    Blocking: ["Blocking"],`,
        `    BlockingTick: ["Blocking", "Tick"],`,
        `    Health: ["Health"],`,
        `} as const satisfies { [string]: string[] }`,
        `declare known: "Blocking" | "Health"`,
        `declare partly: "Blocking" | "Missing"`,
        "const both = Paths[known]",
        "const some = Paths[partly]",
        `const one = Paths["Health"]`,
        `const none = Paths["Nope"]`,
        "declare xs: number[]",
        "declare i: 1 | 2",
        "const element = xs[i]",
    ].join("\n"))
    check("indexing: a key that is one of several reads each, and one that may miss reads nil", [
        indexed.bindings.both, indexed.bindings.some, indexed.bindings.one, indexed.bindings.element,
    ], [
        `["Blocking"] | ["Health"]`,
        `["Blocking"] | nil`,
        `["Health"]`,
        "number",
    ])
    check("indexing: a key that certainly is not there is an error, as `.Nope` would be",
        [indexed.errors, indexed.bindings.none], [["Property 'Nope' does not exist on type '{ readonly Blocking: [\"Blocking\"], readonly BlockingTick: [\"Blocking\", \"Tick\"], readonly Health: [\"Health\"] }'"], "any"])

    // A key that cannot be a key of the table is an error, not an `unknown`.
    const badKeys = analyze([
        "declare record: { a: number, b: string }",
        "declare map: { [string]: number }",
        "declare xs: number[]",
        "declare u: unknown",
        "declare n: number",
        "declare s: string",
        "declare anything: any",
        "declare missing: \"x\" | \"y\"",
        "const r1 = record[u]",
        "const r2 = record[n]",
        "const r3 = record[missing]",
        "const m1 = map[u]",
        "const m2 = map[n]",
        "const x1 = xs[s]",
        "const x2 = xs[u]",
        "const ok1 = record[s]",
        "const ok2 = map[s]",
        "const ok3 = xs[n]",
        "const ok4 = record[anything]",
        "const ok5 = anything[u]",
        "const t = {}",
        "const ok6 = t[u]",
    ].join("\n"))
    check("indexing: `unknown`, the wrong kind of key, or only names that are not there", badKeys.errors, [
        "Type 'unknown' cannot be used to index type '{ a: number, b: string }'",
        "Type 'number' cannot be used to index type '{ a: number, b: string }'",
        "None of \"x\" | \"y\" is a property of type '{ a: number, b: string }'",
        "Type 'unknown' cannot be used to index type '{ [string]: number }'",
        "Type 'number' cannot be used to index type '{ [string]: number }'",
        "Type 'string' cannot be used to index type 'number[]'",
        "Type 'unknown' cannot be used to index type 'number[]'",
    ])
    check("indexing: and the read is `any` after the error, a string into a record is a value or nil",
        [badKeys.bindings.r1, badKeys.bindings.ok1, badKeys.bindings.ok2, badKeys.bindings.ok3, badKeys.bindings.ok4, badKeys.bindings.ok5],
        ["any", "number | string | nil", "number", "number", "any", "any"])

    // What keeps those errors to real ones.
    const settled = analyze([
        "declare xs: number[]",
        "declare find: () => number | nil",
        "declare function assert<T>(value: T, message?: string): asserts value",
        "function asserted(): number {",
        "    const i = find()",
        "    assert(i ~= nil, \"missing\")",
        "    const kept = i",
        "    return xs[i]",
        "}",
        "declare options: { headers?: { [string]: string } }",
        "const headers = options.headers or {}",
        "const copy: { [string]: string } = {}",
        "for (const [key, value] in pairs(headers)) {",
        "    copy[key] = value",
        "}",
    ].join("\n"))
    check("indexing: `assert` on a condition narrows by it, and `or {}` keeps the map's keys",
        [settled.errors, settled.bindings.kept, settled.bindings.headers], [[], "number", "{ [string]: string }"])

    // `a?.[k]` — read the key only when there is something to read it from,
    // and `t[k]?.m` when the key may hold nothing.
    const optionalIndex = analyze([
        "declare maps: { [string]: { label: string } } | nil",
        "declare key: string",
        "const label = maps?.[key]",
        "const named = maps?.[key]?.label",
    ].join("\n"))
    check("optional index: the read takes nil, and the chain carries it",
        [optionalIndex.errors, optionalIndex.bindings.label, optionalIndex.bindings.named],
        [[], "{ label: string } | nil", "string | nil"])

    // `f?.()` — call it only when it is there.
    const optionalCall = analyze([
        "declare f: ((n: number) => string) | nil",
        `declare t: { m: (() => number) | nil }`,
        "const said = f?.(1)",
        "const got = t.m?.()",
        "f?.(2)",
    ].join("\n"))
    check("optional call: the result takes nil, and the call is a statement of its own",
        [optionalCall.bindings.said, optionalCall.bindings.got, optionalCall.errors],
        ["string | nil", "number | nil", []])

    // `for x in it`: an iterator function says what the loop holds.
    {
        const lib = parse([
            "declare function gmatch(s: string, pattern: string): () => [string, ...string[]] | nil",
            "declare function rows(): () => [string, number] | nil",
        ].join("\n"))
        const program = parse([
            "for (const [part] in gmatch(\"a/b\", \"[^/]+\")) {",
            "    const word = part",
            "}",
            "for (const [name, count] in rows()) {",
            "    const who = name",
            "    const many = count",
            "}",
            "",
            "",
        ].join("\n"))
        const scopes = analyzeScopes(program)
        const types = analyzeTypes(program, scopes, { libs: [lib] })
        const bindings: Record<string, string> = {}
        for (const [id, type] of types.bindingType) bindings[scopes.bindings.get(id)!.name] = formatType(type)
        check("generic for: the item comes from the iterator function",
            [bindings.word, bindings.who, bindings.many], ["string", "string", "number"])
    }

    // How each loop walks its source. Lowering reads this, so the code a
    // loop becomes and the type inferred for its item come from one decision
    // rather than two.
    {
        const program = parse([
            "declare function gmatch(s: string, pattern: string): () => [string, ...string[]] | nil",
            "declare list: number[]",
            "declare map: { [string]: number }",
            "declare walk: [(s: number[], previous: [number, number] | nil) => [number, number] | nil, number[], nil]",
            "for (const v in list) { print(v) }",
            "for (const v in map) { print(v) }",
            "for (const [k, v] in pairs(map)) { print(k, v) }",
            "for (const [i, n] in ipairs(list)) { print(i, n) }",
            "for (const c in gmatch(\"ab\", \"%a\")) { print(c) }",
            "for (const [i, n] in walk) { print(i, n) }",
            "",
            "",
        ].join("\n"))
        const types = analyzeTypes(program, analyzeScopes(program))
        const loops = program.body.statements
            .filter((s): s is GenericForStatement => s.type === "GenericForStatement")
        check("loops: values walked directly, an iterator function, an iteration",
            loops.map(loop => types.loops.get(loop)?.walks),
            ["values", "values", "iteration", "iteration", "function", "iteration"])
    }

    // `unknown - nil` is itself, whichever way round the union is written.
    check("subtraction: one fits another that removes no more", [
        analyze([
            `declare value: unknown`,
            "declare function take(v: string | (unknown - (nil | false))): nil",
            "if (value) { take(value) }",
        ].join("\n")).errors,
        analyze([
            "declare function takeString(v: string): nil",
            `declare value: unknown`,
            "if (value) { takeString(value) }",
        ].join("\n")).errors.length,
    ], [[], 1])

    // `x or []` is how Lua writes a default: the context reaches both sides.
    check("contextual typing: through `or`, and into a generic annotation", [
        analyze([
            `declare paths: string[] | nil`,
            `const used: string[] = paths or []`,
        ].join("\n")).errors,
        analyze([
            "function collect<T>(items: T[]): T[] {",
            "    const kept: T[] = []",
            "    return kept",
            "}",
            "",
            "",
        ].join("\n")).errors,
    ], [[], []])

    // An optional property takes nil: in Lua a field that is nil is a field
    // that is not there.
    check("optional properties: nil is as good as absent", [
        analyze(`type A = { p?: string }
declare v: string | nil
const a: A = { p: v }`).errors,
        analyze(`type A = { p?: string }
const a: A = { p: nil }`).errors,
        analyze(`type A = { p?: string }
const a: A = {}`).errors,
        analyze(`type A = { p?: string }
const a: A = { p: 1 }`).errors.length,
    ], [[], [], [], 1])

    // A property whose name is not an identifier, written as the object
    // literal writes it.
    {
        const quoted = analyze([
            `type Settings = {`,
            `    ShowHitboxes: "True" | "False",`,
            `    "Respawn After Kill": "True" | "False",`,
            `    "Skip Intros"?: "True" | "False",`,
            `}`,
            `declare s: Settings`,
            `const read = s["Respawn After Kill"]`,
            `const whole: Settings = { ShowHitboxes: "True", "Respawn After Kill": "False" }`,
        ].join("\n"))
        check("object types: a quoted property name", [
            quoted.bindings.read,
            quoted.errors,
        ], [`"True" | "False"`, []])

        // The value must still be one it names.
        check("object types: and it is checked like any other",
            analyze([
                `type Settings = { "Respawn After Kill": "True" | "False" }`,
                `const whole: Settings = { "Respawn After Kill": "Maybe" }`,
            ].join("\n")).errors.length, 1)
    }

    // A string is not a table: the only members it has are its methods.
    {
        const program = parse([
            `declare skill: "a" | "b"`,
            `declare name: "Sans" | "Asgore"`,
            "declare anyKey: string",
            "const method = skill[\"upper\"]",
            "const wrong = skill[name]",
            "const alsoWrong = skill.Sans",
            "const dynamic = skill[anyKey]",
            "declare rows: { Sans: number }",
            "const table = rows[name]",
        ].join("\n"))
        const scopes = analyzeScopes(program)
        const types = analyzeTypes(program, scopes, {})
        const bindings: Record<string, string> = {}
        for (const [id, type] of types.bindingType) bindings[scopes.bindings.get(id)!.name] = formatType(type)
        check("string members: a method by name, and a report for anything else", [
            bindings.method,
            types.diagnostics.map(d => d.message),
        ], [
            "(self: string) => string",
            [
                `'"Sans" | "Asgore"' does not name a member of a string`,
                "'Sans' does not exist on a string",
            ],
        ])
    }

    // `"a":upper()` needs no parentheses, the way `("a"):upper()` does in Luau.
    {
        const shape = (code: string): unknown => {
            const statement = (parse(code).body.statements.at(-1) ?? {}) as unknown as Record<string, unknown>
            const node = statement.type === "VariableDeclaration" ? statement.init
                : statement.type === "CallStatement" ? statement.expression
                : statement
            const describe = (e: any): string =>
                e.type === "MethodCallExpression" ? `${describe(e.object)}:${e.method.name}()`
                : e.type === "IfElseExpression" ? `${describe(e.clauses[0].condition)} ? ${describe(e.clauses[0].body)} : ${describe(e.alternate)}`
                : e.type === "CallExpression" ? `${describe(e.callee)}()`
                : e.type === "StringLiteral" ? e.raw
                : e.type === "InterpolatedStringExpression" ? "`...`"
                : e.type === "Identifier" ? e.name
                : e.type
            return describe(node)
        }
        const program = parse(`const shout = "a":upper()\nconst wrong = "a":nope()`)
        const types = analyzeTypes(program, analyzeScopes(program), {})
        check("string method calls: a bare string, a statement, a template, and a ternary's `:`", [
            shape(`const a = "a":upper():lower()`),
            shape(`"a":upper()`),
            shape("const b = `x${1}`:upper()"),
            shape(`const c = cond ? "a" : f()`),
            shape(`const d = cond ? "a":upper() : "b":lower()`),
            types.diagnostics.map(d => d.message),
        ], [
            `"a":upper():lower()`,
            `"a":upper()`,
            "`...`:upper()",
            `cond ? "a" : f()`,
            `cond ? "a":upper() : "b":lower()`,
            ["'nope' does not exist on a string"],
        ])
    }

    // A member a fully known table does not have is an error, not `unknown`.
    {
        const program = parse([
            "declare game: { GetService: (name: string) => number }",
            "const ok = game.GetService",
            "const wrong = game.any",
            "declare either: { a: number } | { b: number }",
            "const partly = either.a",
            "declare map: { [string]: number }",
            "const indexed = map.foo",
            "const t = {}",
            "t.x = 1",
            "const filled = t.x",
        ].join("\n"))
        const types = analyzeTypes(program, analyzeScopes(program))
        check("missing members: reported on a known table, not on an indexer or an empty one",
            types.diagnostics.map(d => d.message), [
                "Property 'any' does not exist on type '{ GetService: (name: string) => number }'",
                "Property 'a' does not exist on type '{ a: number } | { b: number }'",
            ])

        // A number has no members; an array's are its metatable's — the
        // language's, and whatever a library adds to it.
        const arrays = parse("declare metatable<T> T[]: { __index: { size: (self: T[]) => number } }")
        const scalar = (code: string, libs = [arrays]) => {
            const p = parse(code)
            return analyzeTypes(p, analyzeScopes(p), { libs }).diagnostics.map(d => d.message)
        }
        check("missing members: on a number, and on an array, whose metatable a library adds to", [
            scalar("const a = 1\nconst b = a.a"),
            scalar("declare arr: number[]\nconst ok = arr.size\nconst fromLanguage = arr.filter\nconst wrong = arr.nope"),
            scalar("declare arr: number[]\nconst notAdded = arr.size", []),
        ], [
            ["Property 'a' does not exist on type '1'"],
            ["Property 'nope' does not exist on type 'number[]'"],
            ["Property 'size' does not exist on type 'number[]'"],
        ])
        // Arithmetic on an `any` may have gone through a metamethod: the
        // difference of two untyped positions is a vector as far as anyone
        // knows, not a number with no `Magnitude`.
        check("missing members: not on arithmetic over `any`",
            scalar("declare function get(): any\nconst a = get()\nconst d = (a - a).Magnitude\nconst e = (-a).X", []), [])
    }

    // Calling a value that is certainly not a function is an error.
    {
        check("not callable: a number, a table or a method that is a field", [
            analyze("const a = 1\na()").errors,
            analyze("declare o: { x: number }\no:x()").errors,
            analyze("declare u: number | (() => number)\nu()").errors,
            analyze("declare f: () => number\nf()\ndeclare q: any\nq()").errors,
        ], [
            ["This expression is not callable: 'a' is of type '1'"],
            ["This expression is not callable: 'x' is of type 'number'"],
            ["This expression is not callable: 'u' is of type 'number | (() => number)'"],
            [],
        ])
    }

    // `(` on a line of its own continues the statement above it.
    {
        const trap = [
            "declare map: { [string]: string }",
            "declare key: string",
            "const value = map[key]",
            `("A"):upper()`,
        ].join("\n")
        check("ambiguous call: a `(` that starts a line is a call of the line above", [
            // Two reports: the line break, and the string it ends up calling.
            analyze(trap).errors.length,
            analyze(trap).errors[0]?.startsWith("This calls the value the line above ends with"),
            // The fix, and the shapes that are not it.
            analyze(trap.replace(`("A")`, `;("A")`)).errors,
            analyze("declare f: (a: number, b: number) => nil\nf(\n    1,\n    2,\n)").errors,
            analyze("declare f: () => nil\nf()\nf()").errors,
        ], [2, true, [], [], []])
    }

    // A type still waiting on a type parameter goes where anything it could
    // become goes: `Extract<Rows, { Page: P }>["Skills"][number]` is one of
    // the rows' skills, whatever `P` turns out to be.
    {
        const rows = [
            `const Rows = {`,
            `    a: [`,
            `        { Page: "Bones", Skills: ["Bonespam", "Bonewall"] },`,
            `        { Page: "Fire", Skills: ["Geyser"] },`,
            `    ],`,
            `} as const`,
            `type Row = (typeof Rows)["a"][number]`,
        ].join("\n")
        const deferred = analyze([
            rows,
            `declare function take(skill: Row["Skills"][number]): nil`,
            `function pass<P extends Row["Page"]>(skill: Extract<Row, { Page: P }>["Skills"][number]) {`,
            "    take(skill)",
            "}",
        ].join("\n"))
        check("deferred types: what is still waiting fits what it could become",
            deferred.errors, [])

        // And it still cannot go somewhere none of them fit.
        const wrong = analyze([
            rows,
            `declare function takeNumber(n: number): nil`,
            `function pass<P extends Row["Page"]>(skill: Extract<Row, { Page: P }>["Skills"][number]) {`,
            "    takeNumber(skill)",
            "}",
        ].join("\n"))
        check("deferred types: and not where none of them fit",
            wrong.errors.length, 1)

        // The printed form parenthesises the conditional, so the index does
        // not read as part of the branch.
        check("deferred types: printed with the conditional parenthesised",
            (wrong.errors[0] ?? "").includes(`)["Skills"][number]'`), true)
    }

    // A type parameter stands for one value, and its constraint says which:
    // passing `P extends "a" | "b"` where that union is wanted is fine.
    check("type parameters: a constrained parameter fits its own constraint", [
        analyze([
            "type Page = \"Bones\" | \"Fire\"",
            "declare function take(page: Page): nil",
            "function pass<P extends Page>(page: P) {",
            "    take(page)",
            "}",
            "",
            "",
        ].join("\n")).errors,
        analyze([
            "const Rows = { a: [{ Page: \"Bones\" }, { Page: \"Fire\" }] } as const",
            "type Row = (typeof Rows)[\"a\"][number]",
            "declare function take(page: Row[\"Page\"]): nil",
            "function pass<P extends Row[\"Page\"]>(page: P) {",
            "    take(page)",
            "}",
            "",
            "",
        ].join("\n")).errors,
        // And a parameter that cannot be what is wanted is still an error.
        analyze([
            "declare function take(n: number): nil",
            "function pass<P extends string>(value: P) {",
            "    take(value)",
            "}",
            "",
            "",
        ].join("\n")).errors,
    ], [
        [],
        [],
        ["Argument of type 'P' is not assignable to parameter of type 'number'"],
    ])

    // What one argument is expected to be, once another has pinned the type
    // parameter down: `get("Bones", ...)` wants that page's skills.
    {
        const program = parse([
            `const Rows = {`,
            `    a: [`,
            `        { Page: "Bones", Skills: ["Bonespam", "Bonewall"] },`,
            `        { Page: "Fire", Skills: ["Geyser"] },`,
            `    ],`,
            `} as const`,
            `type Row = (typeof Rows)["a"][number]`,
            `declare function get<P extends Row["Page"]>(`,
            `    page: P,`,
            `    skill: Extract<Row, { Page: P }>["Skills"][number],`,
            `): boolean`,
            `get("Bones", "Bonespam")`,
            `get("Fire", "Geyser")`,
        ].join("\n"))
        const scopes = analyzeScopes(program)
        const types = analyzeTypes(program, scopes)
        const calls: string[][] = []
        for (const statement of program.body.statements) {
            const call = (statement as { expression?: { arguments?: object[] } }).expression
            if (!call?.arguments) continue
            calls.push(call.arguments.map(argument => {
                const expected = types.expectedTypeOf.get(argument as never)
                return expected ? formatType(expected) : "(none)"
            }))
        }
        check("expected argument types: what the other arguments pinned down", calls, [
            [`"Bones" | "Fire"`, `"Bonespam" | "Bonewall"`],
            [`"Bones" | "Fire"`, `"Geyser"`],
        ])
        check("expected argument types: and no error for either call", types.diagnostics.map(d => d.message), [])
    }

    // `T[K]` over a union of keys: the ones the table has, and nil for the
    // rest — the same answer the value side gives, rather than `unknown`
    // swallowing the union because one key was missing.
    {
        const program = parse([
            `const S = { a: [1], b: ["x"] } as const`,
            `type Keys = "a" | "b"`,
            `type Extra = "a" | "b" | "c"`,
            `type Present = (typeof S)[Keys]`,
            `type WithMissing = (typeof S)[Extra]`,
            `type Gone = (typeof S)["c"]`,
            `type Mapped = { [K in "x" | "y"]: number }`,
            `type Partly = Mapped["x" | "zz"]`,
        ].join("\n"))
        const scopes = analyzeScopes(program)
        const types = analyzeTypes(program, scopes)
        const named = (name: string) => formatType(types.aliases.get(name)!)
        check("indexed access: a key the table does not have reads as nil",
            [named("Present"), named("WithMissing"), named("Gone"), named("Partly")],
            [`[1] | ["x"]`, `[1] | ["x"] | nil`, "nil", "number | nil"])

        // A class is nominal: a member it does not declare is not nil, it is
        // nothing at all.
        const withClass = parse([
            "declare t: Thing",
            `type Has = (typeof t)["Name"]`,
            `type Missing = (typeof t)["Nope"]`,
        ].join("\n"))
        const classScopes = analyzeScopes(withClass)
        const classTypes = analyzeTypes(withClass, classScopes, {
            libs: [parse("declare class Thing { Name: string }")],
        })
        check("indexed access: a class member it does not have is not nil",
            [formatType(classTypes.aliases.get("Has")!), formatType(classTypes.aliases.get("Missing")!)],
            ["string", "unknown"])
    }

    // The methods an array and a string answer to are their metatables': the
    // language declares them (in the prelude), and a library adds to them
    // with `declare metatable` of the same target.
    {
        const library = parse([
            "declare metatable<T> T[]: { __index: { size: (self: T[]) => number } }",
            "declare metatable string: { __index: { split: (self: string, separator: string) => string[] } }",
        ].join("\n"))
        const program = parse([
            `const names = ["a", "bb"]`,
            "const long = names:filter(function(v) { return #v > 1 })",
            "const sizes = names:map(function(v) { return #v })",
            "const last = ([1, 2]):pop()",
            "declare text: string",
            "const up = text:upper()",
            "const trimmed = text:trim()",
            `const literal = ("x"):trim()`,
            "const missing = names:nope()",
            "const size = names:size()",
            "const parts = text:split(\",\")",
        ].join("\n"))
        const scopes = analyzeScopes(program)
        const types = analyzeTypes(program, scopes, { libs: [library] })
        const bindings: Record<string, string> = {}
        for (const [id, type] of types.bindingType) bindings[scopes.bindings.get(id)!.name] = formatType(type)
        check("array and string methods: the language's, and a library's added to them", [
            bindings.long, bindings.sizes, bindings.last,
            bindings.up, bindings.trimmed, bindings.literal, bindings.missing,
            bindings.size, bindings.parts,
        ], ["string[]", "number[]", "number | nil", "string", "string", "string", "unknown", "number", "string[]"])
        // Where each method came from is what the compiler asks: its own
        // runtime for the language's, the declaring library for a library's.
        const origins = [...types.methodSources.values()].map(source =>
            source.origin === "library" ? `library ${source.library}` : source.origin)
        check("array and string methods: each call says whose metatable it read",
            origins, ["language", "language", "language", "language", "language", "language", "library 0", "library 0"])

        // With no library at all, an array still has the language's methods.
        const bare = analyze("const names = [1]\nconst kept = names:filter(function(v) { return true })")
        check("array methods: the language gives them", bare.bindings.kept, "number[]")
    }

    // Libraries layer over one another; the file itself replaces.
    {
        const first = parse("type Set = { one: (self: string) => string }")
        const second = parse("type Set = { two: (self: string) => string }")
        const layered = parse("declare value: Set\nconst a = value.one\nconst b = value.two")
        const layeredScopes = analyzeScopes(layered)
        const layeredTypes = analyzeTypes(layered, layeredScopes, { libs: [first, second] })
        const names: Record<string, string> = {}
        for (const [id, type] of layeredTypes.bindingType) names[layeredScopes.bindings.get(id)!.name] = formatType(type)
        check("layered aliases: a library adds to what an earlier one declared",
            [names.a, names.b], ["(self: string) => string", "(self: string) => string"])

        const own = parse("type Set = { three: (self: string) => string }\ndeclare value: Set\nconst c = value.one")
        const ownScopes = analyzeScopes(own)
        const ownTypes = analyzeTypes(own, ownScopes, { libs: [first, second] })
        const mine: Record<string, string> = {}
        for (const [id, type] of ownTypes.bindingType) mine[ownScopes.bindings.get(id)!.name] = formatType(type)
        check("layered aliases: the file's own replaces them", mine.c, "unknown")
    }

    // A literal written in an argument keeps its literal type when the
    // parameter asks for one — TypeScript's contextual typing.
    const request = [
        `type Request = { Url: string, Method?: "GET" | "POST", Modes?: ("a" | "b")[] }`,
        "declare function send(r: Request): number",
        "declare function keep<T>(v: T): T",
    ].join("\n")
    check("contextual literals: an argument's object literal keeps what the parameter asks for", [
        analyze(`${request}\nconst ok = send({ Url: "u", Method: "GET", Modes: ["a"] })`).errors,
        analyze(`${request}\nsend({ Url: "u", Method: "FETCH" })`).errors,
        analyze(`${request}\nconst free = keep({ Method: "GET" })`).bindings.free,
        analyze([
            `type Outer = { inner: { mode: "a" | "b" } }`,
            "declare function f(o: Outer): nil",
            `f({ inner: { mode: "a" } })`,
        ].join("\n")).errors,
    ], [
        [],
        [`Argument of type '{ Method: "FETCH", Url: string }' is not assignable to parameter of type 'Request', 'Method' is "FETCH", not "GET" | "POST"`],
        "{ Method: string }",
        [],
    ])

    // A shorthand field is the same field.
    check("contextual literals: a shorthand field too",
        analyze([
            `type Request = { Method: "GET" | "POST" }`,
            "declare function send(r: Request): nil",
            `const Method = "GET"`,
            "send({ Method })",
        ].join("\n")).errors, [])

    // Definitions files are layers: `@tilua-types/roblox` adds to `@tilua-types/lua`
    // rather than replacing it.
    {
        const lua = parse([
            "declare table: { insert: (t: unknown[], v: unknown) => nil }",
            `declare function type(value: number): "number"`,
            "declare function type<T>(value: T): string",
        ].join("\n"))
        const luau = parse([
            "declare table: { create: (n: number) => unknown[] }",
            `declare function type(value: buffer): "buffer"`,
        ].join("\n"))
        const program = parse([
            "declare value: number | buffer",
            "const theTable = table",
            "if (type(value) == \"buffer\") {",
            "    const narrowed = value",
            "}",
            "",
            "",
        ].join("\n"))
        const scopes = analyzeScopes(program)
        const types = analyzeTypes(program, scopes, { libs: [lua, luau] })
        const bindings: Record<string, string> = {}
        for (const [id, type] of types.bindingType) bindings[scopes.bindings.get(id)!.name] = formatType(type)
        check("layered definitions: a table declared twice keeps both files' members",
            bindings.theTable,
            "{ create: (n: number) => unknown[], insert: (t: unknown[], v: unknown) => nil }")
        check("layered definitions: and the later file's overload narrows",
            [bindings.narrowed, types.diagnostics.map(d => d.message)], ["buffer", []])
    }

    // An index signature over a finite set of keys names exactly those keys.
    const names = `type Names = "GTFrisk" | "XTFrisk"\n`
    check("finite indexer: a key outside the set is excess",
        analyze(`${names}const PerClass = {
    GTFrisk: function() {},
    XTFriskk: function() {},
} as const satisfies { [Names]: () => nil }`).errors,
        ["Object literal may only specify known properties, and 'XTFriskk' does not exist in type '{ [Names]: () => nil }'"])
    check("finite indexer: the keys in the set are fine, and `[string]` takes anything", [
        analyze(`${names}const PerClass = {
    GTFrisk: function() {},
    XTFrisk: function() {},
} as const satisfies { [Names]: () => nil }`).errors,
        analyze(`const m = { whatever: 1 } satisfies { [string]: number }`).errors,
    ], [[], []])

    // `const c = player.Character`: the two names hold one value.
    const player = `type Char = { Name: string }\ndeclare player: { Character: Char | nil }\n`
    const alias = analyze(`${player}function f() {
    const character = player.Character
    if (not player.Character) { return nil }
    const kept = character
}
function g() {
    const character = player.Character
    if (character) {
        const reverse = player.Character
    } else {
        const gone = character
    }
}`)
    check("alias: a guard on the path narrows the name that copied it, and back",
        [alias.bindings.kept, alias.bindings.reverse, alias.bindings.gone],
        ["Char", "Char", "nil"])

    const discriminant = analyze([
        "type Shape = { kind: \"circle\", r: number } | { kind: \"square\", s: number }",
        "declare shape: Shape",
        "function f() {",
        "    const kind = shape.kind",
        "    if (kind == \"circle\") {",
        "        const picked = shape",
        "    }",
        "}",
        "",
        "",
    ].join("\n"))
    check("alias: a copied discriminant still picks the union member",
        discriminant.bindings.picked, `{ kind: "circle", r: number }`)

    const reassigned = analyze(`${player}function f() {
    const character = player.Character
    player.Character = nil
    if (player.Character) {
        const stale = character
    }
}`)
    check("alias: an assignment through the path ends the alias",
        reassigned.bindings.stale, "Char | nil")

    // `t[k]` with a variable `k` is one slot until `t` or `k` changes.
    const byVariable = analyze([
        "declare map: { [string]: number | nil }",
        "declare key: string",
        "declare other: string",
        "const Codes = { us: \"US\", kr: \"KR\" } as const",
        "declare flag: string",
        "function guarded() {",
        "    if (not map[key]) { return }",
        "    const kept = map[key]",
        "    const elsewhere = map[other]",
        "}",
        "function record() {",
        "    if (not Codes[flag]) { return }",
        "    const code = Codes[flag]",
        "}",
        "function rekeyed() {",
        "    let k = key",
        "    if (map[k]) {",
        "        k = other",
        "        const moved = map[k]",
        "    }",
        "}",
        "function writtenByName() {",
        "    if (map[key]) {",
        "        map.x = nil",
        "        const overwritten = map[key]",
        "    }",
        "}",
        "function writtenThroughKey() {",
        "    if (map.x and map[key]) {",
        "        map[other] = nil",
        "        const byName = map.x",
        "        const byKey = map[key]",
        "    }",
        "}",
    ].join("\n"))
    check("index narrowing: a guard on `t[k]` narrows `t[k]`, not `t[j]`",
        [byVariable.bindings.kept, byVariable.bindings.elsewhere], ["number", "number | nil"])
    check("index narrowing: a record indexed by a string", byVariable.bindings.code, `"US" | "KR"`)
    check("index narrowing: ends when the key is assigned", byVariable.bindings.moved, "number | nil")
    check("index narrowing: ends when the table is written by name, or through another key", [
        byVariable.bindings.overwritten, byVariable.bindings.byName, byVariable.bindings.byKey,
    ], ["number | nil", "number | nil", "number | nil"])

    // `const path = paths[stat]`: testing one narrows the other.
    const correlated = analyze([
        "const Paths = {",
        "    Blocking: [\"Blocking\"],",
        "    Health: [\"Health\"],",
        "} as const satisfies { [string]: string[] }",
        "declare stat: \"Blocking\" | \"Health\" | \"KB\" | \"Knocked\"",
        "function read() {",
        "    const path = Paths[stat]",
        "    if (path) {",
        "        const inMap = stat",
        "        const thePath = path",
        "    } else {",
        "        const missing = stat",
        "    }",
        "}",
        "",
        "",
    ].join("\n"))
    check("correlation: a value read by key says which key it was",
        [correlated.bindings.inMap, correlated.bindings.thePath, correlated.bindings.missing],
        [`"Blocking" | "Health"`, `["Blocking"] | ["Health"]`, `"KB" | "Knocked"`])

    // Each line of an overload set is a node of its own.
    {
        const program = parse([
            "export function f(x: \"a\"): number",
            "export function f(x: \"b\"): string",
            "export function f(x) {",
            "    return nil",
            "}",
            "",
            "",
        ].join("\n"))
        const declaration = (program.body.statements[0] as { declaration: {
            signatures?: { name?: { name: string } }[]
            implementationName?: { line: { start: number } }
        } }).declaration
        check("overloads: every line keeps its name",
            [declaration.signatures?.map(sig => sig.name?.name), declaration.implementationName?.line.start],
            [["f", "f"], 3])
        const scopes = analyzeScopes(program)
        const binding = [...scopes.bindings.values()].find(b => b.name === "f")
        check("overloads: and each name is a use of the one binding",
            binding?.references.length, 2)
    }

    // Type arguments written at the call, and `<T = ...>` when they are not.
    const typeArguments = analyze([
        "declare class Instance {}",
        "declare class Folder extends Instance {}",
        "declare function find<T = Instance>(name: string): T | nil",
        "declare inst: {",
        "    Find: <T = Instance>(self: unknown, name: string) => T | nil,",
        "    Wait: (<T = Instance>(self: unknown, name: string) => T) & (<T = Instance>(self: unknown, name: string, timeout: number) => T | nil),",
        "}",
        `const typed = find<Folder>("x")`,
        `const bare = find("x")`,
        `const method = inst:Find<Folder>("x")`,
        `const waited = inst:Wait<Folder>("x")`,
        `const timed = inst:Wait<Folder>("x", 5)`,
        `const tooMany = find<Folder, Folder>("x")`,
        "declare a: number",
        "declare b: number",
        "const compared = a < b",
    ].join("\n"))
    check("type arguments: written at the call, defaulted when not, and counted", [
        typeArguments.bindings.typed, typeArguments.bindings.bare, typeArguments.bindings.method,
        typeArguments.bindings.waited, typeArguments.bindings.timed, typeArguments.bindings.compared,
        typeArguments.errors,
    ], [
        "Folder | nil", "Instance | nil", "Folder | nil",
        "Folder", "Folder | nil", "boolean",
        ["Expected 1 type argument, got 2"],
    ])
    check("type arguments: `a < b > (c)` is still three operators",
        parseError("declare a: number\ndeclare b: number\ndeclare c: number\nconst x = (a < b) == (b < c)"), undefined)

    // The implementation of an overload set sees what its signatures allow.
    const implementation = analyze([
        "declare class Player {}",
        "declare player: Player",
        "export function get(stat: \"hp\", who?: Player): number",
        "export function get(stat: \"name\", who?: Player): string",
        "export function get(stat, who, extra) {",
        "    const s = stat",
        "    const w = who",
        "    const e = extra",
        "    return nil",
        "}",
        "function annotated(stat: \"hp\"): number",
        "function annotated(stat: \"name\"): string",
        "function annotated(stat: string) {",
        "    const inner = stat",
        "    return nil",
        "}",
        "",
        "",
    ].join("\n"))
    check("overloads: an implementation's bare parameter is what the signatures allow",
        [implementation.bindings.s, implementation.bindings.w, implementation.bindings.e, implementation.bindings.inner],
        [`"hp" | "name"`, "Player | nil", "any", "string"])

    // `export function` overloads: one declaration, exported once.
    const overloadModule = [
        "export function Tags(a: number, b: number): boolean",
        "export function Tags(a?: number, b?: number): string",
        "export function Tags(a: number = 1, b?: number): string {",
        "    return \"x\"",
        "}",
        "",
        "",
    ].join("\n")
    const exportedOverloads = analyze([
        `import { Tags } from "./tags"`,
        "const two = Tags(1, 2)",
        "const none = Tags()",
    ].join("\n"), { "./tags": overloadModule })
    check("overloads: `export function` signatures make one exported overload set",
        [exportedOverloads.errors, exportedOverloads.bindings.two, exportedOverloads.bindings.none],
        [[], "boolean", "string"])
    check("overloads: mixing `export` and plain signatures is an error",
        parseError("function f(a: number): boolean\nexport function f(a?: number): string {\n    return \"x\"\n}"),
        "Overload signatures must all be exported or non-exported")

    // A constraint is a type like any other: `typeof` in one reads a value.
    const constraints = analyze([
        "const Skills = {",
        "    Sans: [{ Page: \"Bones\", Skills: [\"Bonespam\", \"Bonewall\"] }, { Page: \"Blasters\", Skills: [\"Blast1\"] }],",
        "} as const",
        "type Rows = (typeof Skills)[\"Sans\"][number]",
        "type Extract<T, U> = T extends U ? T : never",
        "function pick<P extends (typeof Skills)[\"Sans\"][number][\"Page\"]>(",
        "    page: P,",
        "    skill: Extract<Rows, { Page: P }>[\"Skills\"][number],",
        ") {",
        "    return skill",
        "}",
        "const good = pick(\"Bones\", \"Bonespam\")",
        "const wrongSkill = pick(\"Bones\", \"Blast1\")",
        "const wrongPage = pick(\"Nope\", \"Bonespam\")",
        "",
        "",
    ].join("\n"))
    check("generics: a constraint written inline, and arguments checked once the call fixes them", [
        constraints.bindings.good,
        constraints.errors,
    ], [
        `"Bonespam" | "Bonewall"`,
        [
            `Argument of type '"Blast1"' is not assignable to parameter of type '"Bonespam" | "Bonewall"'`,
            `Argument of type '"Nope"' is not assignable to parameter of type '"Bones" | "Blasters"'`,
        ],
    ])

    // Trailing commas, as in TypeScript.
    check("trailing commas: parameters, arguments, generics and type arguments", [
        parseError("function f(\n    a: number,\n    b: string,\n) {\n}"),
        parseError("print(\n    1,\n    2,\n)"),
        parseError("function f<\n    A,\n    B,\n>(a: A) { }"),
        parseError("type F = (\n    a: number,\n) => nil"),
        parseError("type P = Partial<number,>"),
    ], [undefined, undefined, undefined, undefined, undefined])

    // `...rest` holds what the pattern did not take.
    const rest = analyze([
        "declare t: { a: number, b: number, c: string }",
        "const { a, ...others } = t",
        "const { a: first, ...tail } = t",
    ].join("\n"))
    check("destructuring: rest drops the properties already named",
        [rest.bindings.others, rest.bindings.tail], ["{ b: number, c: string }", "{ b: number, c: string }"])

    // Hoisting: functions, and a module's names seen from code that runs later.
    {
        const program = parse([
            "let Resource: ResourceType | nil",
            "let Direct: ReturnType<typeof Load> | nil",
            "const early = parity(4)",
            "function Load() {",
            "    return { level: Config.level }",
            "}",
            "export type ResourceType = ReturnType<typeof Load>",
            "function parity(n: number): string {",
            "    const direct = later()",
            "    function isEven(k: number): boolean {",
            "        if (k == 0) { return true }",
            "        return isOdd(k - 1)",
            "    }",
            "    function isOdd(k: number): boolean {",
            "        if (k == 0) { return false }",
            "        return isEven(k - 1)",
            "    }",
            "    function later() { return 1 }",
            "    return if isEven(n) then \"even\" else \"odd\"",
            "}",
            "function bump() { counter = counter + 1 }",
            "const Config = { level: 3 }",
            "let counter = 0",
            "",
            "",
        ].join("\n"))
        const scopes = analyzeScopes(program, { reportUndeclared: true })
        const types = analyzeTypes(program, scopes)
        const bindings: Record<string, string> = {}
        for (const [id, type] of types.bindingType) bindings[scopes.bindings.get(id)!.name] = formatType(type)
        check("hoisting: types written above a function see it",
            [bindings.Resource, bindings.Direct, bindings.early],
            ["ResourceType | nil", "{ level: number } | nil", "string"])
        check("hoisting: only a direct call above a nested function is an error",
            [...scopes.diagnostics, ...types.diagnostics].map(d => `${d.node.line.start}: ${d.message.split(":")[0]}`),
            ["9: 'later' is used before its definition"])
    }

    // An alias that names a `typeof` alias waits for it, as that one waits for the value.
    {
        const dependent = analyze([
            "export type ResourceType = ReturnType<typeof Load>",
            "export type RemoteMapType = ResourceType[\"RemoteMap\"]",
            "export type ClassMapType = ResourceType[\"ClassMap\"]",
            "let Resource: ResourceType | nil",
            "declare peek: ClassMapType",
            "function Load() {",
            "    const RemoteMap = { Char: 1 } as const",
            "    const ClassMap = { Sans: { Thumbnail: \"id\" } } as const",
            "    return { RemoteMap, ClassMap }",
            "}",
            "const seen = peek",
            "",
            "",
        ].join("\n"))
        check("type queries: aliases built on a `typeof` alias, a declare, and a binding above the function",
            [dependent.errors, dependent.bindings.seen, dependent.bindings.Resource],
            [[], "ClassMapType", "ResourceType | nil"])
    }

    // `export type X = typeof value` reads the value, as a plain alias does.
    const classes = [
        "export const DefaultClass = [\"Sans\", \"Asgore\"] as const",
        "export type DefaultClassType = typeof DefaultClass",
        "export type DefaultClassName = (typeof DefaultClass)[number]",
    ].join("\n")
    const exportedQuery = analyze([
        "import type { DefaultClassType, DefaultClassName } from \"./classes\"",
        "declare tuple: DefaultClassType",
        "declare name: DefaultClassName",
        "const t = tuple",
        "const n = name",
        "const bad: DefaultClassName = \"Nope\"",
    ].join("\n"), { "./classes": classes })
    check("type queries: an exported alias of `typeof` a value, imported elsewhere",
        [exportedQuery.bindings.t, exportedQuery.bindings.n, exportedQuery.errors],
        [`["Sans", "Asgore"]`, `"Sans" | "Asgore"`, [`Type '"Nope"' is not assignable to '"Sans" | "Asgore"'`]])

    // `--@tilua-...` comments switch checking off.
    const directed = (code: string) => {
        const { program, directives } = parseWithRecovery(code)
        const scopes = analyzeScopes(program)
        const types = analyzeTypes(program, scopes)
        const all = [...scopes.diagnostics, ...types.diagnostics]
        const { kept, unusedExpectErrors } = applyDirectives(directives, all, d => d.node.line.start)
        return [...kept.map(d => `${d.node.line.start}: ${d.message}`), ...unusedExpectErrors.map(d => `${d.line}: unused`)]
    }
    check("directives: ignore and expect-error cover the next line of code", directed([
        "const a: number = \"x\"",
        "--@tilua-ignore",
        "const b: number = \"x\"",
        "-- @tilua-expect-error: the reason",
        "",
        "-- another comment",
        "const c: number = \"x\"",
        "--@tilua-expect-error",
        "const d: number = 1",
        "const e: number = \"x\" --@tilua-ignore",
        "const f: number = \"x\"",
    ].join("\n")), [
        "1: Type '\"x\"' is not assignable to 'number'",
        "10: Type '\"x\"' is not assignable to 'number'",
        "8: unused",
    ])
    check("directives: nocheck before the code turns the file off", [
        directed("-- header\n--@tilua-nocheck\nconst a: number = \"x\"\nnope = 1"),
        directed("const a: number = \"x\"\n--@tilua-nocheck"),
    ], [[], ["1: Type '\"x\"' is not assignable to 'number'"]])

    // An overload set with a union argument picks per member.
    const perMember = analyze([
        "declare class Instance {}",
        "declare function kind(value: nil): \"nil\"",
        "declare function kind(value: number): \"number\"",
        "declare function kind(value: Instance): \"Instance\"",
        "declare function kind<T>(value: T): string",
        "declare function whole(value: number | nil): \"both\"",
        "declare function whole(value: number): \"number\"",
        "function f(v: Instance | nil, n: number | nil, x: unknown, b: boolean | Instance) {",
        "    const k1 = kind(v)",
        "    const k2 = kind(n)",
        "    const k3 = kind(x)",
        "    const k4 = kind(b)",
        "    const w = whole(n)",
        "}",
        "",
        "",
    ].join("\n"))
    check("overloads: a union argument returns what each member's signature returns",
        [perMember.bindings.k1, perMember.bindings.k2, perMember.bindings.k3, perMember.bindings.k4, perMember.bindings.w],
        [`"Instance" | "nil"`, `"number" | "nil"`, "string", "string", `"both"`])

    // The language's utility types need no type library.
    const utilities = analyze([
        "type User = { id: number, name: string, email: string | nil }",
        "declare function load(): User",
        "declare user: Partial<User>",
        "declare picked: Pick<User, \"id\" | \"name\">",
        "declare omitted: Omit<User, \"email\">",
        "declare byName: Record<\"a\" | \"b\", number>",
        "declare returned: ReturnType<typeof load>",
        "declare present: NonNullable<string | nil>",
        "declare kept: Truthy<number | false | nil>",
        "const u = user",
        "const p = picked",
        "const o = omitted",
        "const r = byName",
        "const ret = returned",
        "const n = present",
        "const t = kept",
    ].join("\n"))
    check("prelude: utility types are built in", [utilities.errors, utilities.bindings.p, utilities.bindings.o, utilities.bindings.r, utilities.bindings.n, utilities.bindings.t], [
        [], "{ id: number, name: string }", "{ id: number, name: string }", "{ a: number, b: number }", "string", "number",
    ])
    check("prelude: a file may declare one of them again", analyze([
        "type Partial<T> = string",
        "const s: Partial<number> = \"x\"",
    ].join("\n")).errors, [])

    // Reading through a value that may be nil is an error, as in TypeScript.
    const nilAccess = analyze([
        "type Node = { Name: string, find: (self: Node, name: string) => Node | nil, Parent: Node | nil, box?: { n: number } }",
        "declare root: Node",
        "declare call: (() => number) | nil",
        "declare function error(message: string): never",
        "const bad = root:find(\"a\"):find(\"b\")",
        "const parentName = root.Parent.Name",
        "const n = root.box.n",
        "const called = call()",
        "const safe = root:find(\"a\")?:find(\"b\")",
        "function checked(x: Node | nil, y: Node | nil, z: Node | nil) {",
        "    if (x) { const a = x.Name }",
        "    const b = x and x.Name",
        "    if (not y) { return }",
        "    const c = y.Name",
        "    if (z == nil) { error(\"no\") }",
        "    const d = z.Name",
        "}",
        "function looped(list: (Node | nil)[]) {",
        "    for (i = 1, #list) {",
        "        const item = list[i]",
        "        const e = item.Name",
        "    }",
        "}",
        "",
        "",
    ].join("\n"))
    check("nil access: reading through a possibly-nil value is an error", nilAccess.errors, [
        `'root:find("a")' is possibly nil. Check it first, or use '?.' / '?:'`,
        "'root.Parent' is possibly nil. Check it first, or use '?.' / '?:'",
        "'root.box' is possibly nil. Check it first, or use '?.' / '?:'",
        "'call' is possibly nil. Check it first, or use '?.' / '?:'",
        "'item' is possibly nil. Check it first, or use '?.' / '?:'",
    ])
    check("nil access: the read still has the member's type", [nilAccess.bindings.bad, nilAccess.bindings.parentName, nilAccess.bindings.n, nilAccess.bindings.called],
        ["Node | nil", "string", "number", "number"])

    // Optional chaining: `a?.b` and `a?:m()` are nil when `a` is.
    const chains = parse("const x = a?.b.c\nconst y = a?:m(1)?.n\nconst z = c ?a:b")
    const [cx, cy, cz] = chains.body.statements.map(s => (s as { init: any }).init)
    check("optional chains: `?.` and `?:` mark their link",
        [cx.object.optional, cx.optional, cy.optional, cy.object.optional, cz.type],
        [true, undefined, true, true, "IfElseExpression"])
    check("optional chains: cannot be assigned to", [
        parseError("a?.b = 1"),
        parseError("a?.b.c += 1"),
        parseError("a.b?.c, d = 1, 2"),
    ], [
        "An optional chain cannot be assigned to",
        "An optional chain cannot be assigned to",
        "An optional chain cannot be assigned to",
    ])

    // A destructuring assignment's leaves are places, not only names.
    const places = analyze([
        "const t: number[] = [1, 2]",
        "const o = { a: 0, b: \"\" }",
        "let i = 1",
        "[t[i], t[i + 1]] = [t[i + 1], t[i]]",
        "{ a: o.a, b: o.b } = { a: 1, b: \"x\" }",
    ].join("\n"))
    check("destructuring assignment: indexes and members are targets", places.errors, [])
    check("destructuring assignment: only a place can be assigned to", [
        parseError("[f()] = t"),
        parseError("[a?.b] = t"),
    ], [
        "Only a name, a member or an index can be assigned to",
        "An optional chain cannot be assigned to",
    ])

    // A table's methods are the language's, and answer tuples in the order
    // the type wrote its members.
    const objectMethods = analyze([
        "const keys = { a: 1, b: \"x\" }:keys()",
        "const values = { a: 1, b: \"x\" }:values()",
        "const entries = { a: 1, b: \"x\" }:entries()",
        "declare point: { x: number, y?: string }",
        "const optionalValues = point:values()",
        "declare scores: { [string]: number }",
        "const recordKeys = scores:keys()",
        "const recordEntries = scores:entries()",
        "declare either: { a: number } | { b: string }",
        "const eitherKeys = either:keys()",
        "const own = { keys: () => 1 }",
        "const ownKeys = own:keys()",
        // A line starting with `[` or `{` would continue a call on the line
        // before, as in Lua; after a plain value it starts a statement.
        "let a = 0",
        "[1, 2]:forEach(print)",
        "a = 1",
        "{ a: 1 }:keys()",
        "a = 2",
        "{ a } = { a: 1 }",
    ].join("\n"))
    check("object methods: tuples in written order",
        [objectMethods.bindings.keys, objectMethods.bindings.values, objectMethods.bindings.entries,
            objectMethods.bindings.optionalValues, objectMethods.bindings.recordKeys, objectMethods.bindings.recordEntries,
            objectMethods.bindings.eitherKeys, objectMethods.bindings.ownKeys],
        ["[\"a\", \"b\"]", "[number, string]", "[[\"a\", number], [\"b\", string]]",
            "[number, string | nil]", "string[]", "[string, number][]",
            "[\"a\"] | [\"b\"]", "1"])
    check("object methods: a literal is called on, even starting a statement", objectMethods.errors, [])

    // `cond ? list : []` is a list: the empty literal adds nothing to it, as
    // in `list or []`, so spreading it keeps the element type.
    const emptyBranch = analyze([
        "declare Mod: { Default: string[], Private: string[] }",
        "declare host: boolean",
        "const active = [...Mod.Default, ...(host ? Mod.Private : [])]",
        "const picked = host ? Mod.Private : []",
        "const shape = host ? { x: 1 } : {}",
        "const mixed = host ? 1 : []",
        // Beside a tuple, `[]` is the empty tuple, and spreading a union of
        // tuples adds each one's members.
        "const Named = [\"Sans\", \"Asgore\"] as const",
        "const Extra = [\"KJ\"] as const",
        "const maybe = host ? Extra : []",
        "const names = [...Named, ...(host ? Extra : [])]",
        "const keyed = names:map(name => name)",
        // Spreading tuples of known length makes a tuple, their names kept;
        // what is written beside them widens, and an array's spread makes an array.
        "const copy = [...Named]",
        "const around = [1, ...Named, \"x\"]",
        "const loose = [...Mod.Default, ...Named]",
    ].join("\n"))
    check("ternary: an empty literal takes the other branch's type",
        [emptyBranch.bindings.active, emptyBranch.bindings.picked, emptyBranch.bindings.shape, emptyBranch.bindings.mixed,
            emptyBranch.bindings.maybe, emptyBranch.bindings.names, emptyBranch.bindings.keyed],
        ["string[]", "string[]", "{ x: number } | {}", "1 | unknown[]",
            "[\"KJ\"] | []", "[\"Sans\", \"Asgore\", \"KJ\"] | [\"Sans\", \"Asgore\"]", "(\"Sans\" | \"Asgore\" | \"KJ\")[]"])
    // A literal written into a table or array widens; a value read into one
    // keeps its type, as in TypeScript.
    const kept = analyze([
        "const Named = [\"Sans\", \"Asgore\"] as const",
        "const first = Named[1]",
        "const row = { key: first, n: 1, s: \"lit\", nested: { k: first }, list: [\"a\"] }",
        "const pair = [first, first]",
        "const rows = Named:map(name => ({ Key: name, Img: \"x\" }))",
    ].join("\n"))
    check("literals: a value read into a table keeps its type, a written one widens",
        [kept.bindings.row, kept.bindings.pair, kept.bindings.rows],
        ["{ key: \"Sans\", list: string[], n: number, nested: { k: \"Sans\" }, s: string }",
            "\"Sans\"[]", "{ Img: string, Key: \"Sans\" | \"Asgore\" }[]"])
    check("spread: tuples make a tuple, one per way a union goes",
        [emptyBranch.bindings.copy, emptyBranch.bindings.around, emptyBranch.bindings.loose],
        ["[\"Sans\", \"Asgore\"]", "[number, \"Sans\", \"Asgore\", string]", "string[]"])

    // An annotated parameter's default is still code: typed, where the
    // parameters before it are known, and checked against the annotation.
    const defaults = analyze([
        "declare Base: { ping: () => number }",
        "function f(wait: number = Base.ping() * 2, twice: number = wait * 2) { return twice }",
        "function g(wait: number = \"soon\") { return wait }",
    ].join("\n"))
    check("parameter defaults: typed and checked under an annotation", defaults.errors,
        [`Type '"soon"' is not assignable to 'number'`])

    // A test that is a guard — written `v is S`, or read off `v => v ~= nil`
    // as TypeScript does — makes `filter` answer what it let through.
    const guards = analyze([
        "declare items: { Name: string, Id: string }[]",
        "declare maybe: (string | nil)[]",
        "function isText(v: string | nil): v is string { return v ~= nil }",
        "const named = maybe:filter(isText)",
        "const kept = maybe:filter(v => v ~= nil)",
        "const ids = items:map(item => { if (item.Name == \"\") { return nil }\n return item.Id }):filter(id => id ~= nil)",
        // False must mean exactly what the guard excludes, or it is no guard.
        "const some = maybe:filter(v => v ~= nil and v ~= \"x\")",
        "const long = maybe:filter((v, i) => i > 2)",
        "const guard = (v: string | nil) => v ~= nil",
    ].join("\n"))
    check("filter: a guard narrows what it keeps",
        [guards.bindings.named, guards.bindings.kept, guards.bindings.ids, guards.bindings.some, guards.bindings.long, guards.bindings.guard],
        ["string[]", "string[]", "string[]", "(string | nil)[]", "(string | nil)[]", "(v: string | nil) => v is string"])
    check("filter: guards raise no errors", guards.errors, [])
    // A generic function of one's own: the callback reads `T` from the list
    // before it is asked whether it guards.
    const ownGuards = analyze([
        "declare maybe: (string | nil)[]",
        "declare keep: (<T, S extends T>(list: T[], test: (value: T) => value is S) => S[]) & (<T>(list: T[], test: (value: T) => boolean) => T[])",
        "declare only: <T, S extends T>(list: T[], test: (value: T) => value is S) => S[]",
        "const kept = keep(maybe, v => v ~= nil)",
        "const onlyKept = only(maybe, w => w ~= nil)",
        "const all = keep(maybe, (u: string | nil) => true)",
    ].join("\n"))
    check("generic calls: an inline callback is a guard once T is known",
        [ownGuards.bindings.kept, ownGuards.bindings.onlyKept, ownGuards.bindings.all, ownGuards.errors],
        ["string[]", "string[]", "(string | nil)[]", []])

    // `break` and `continue` belong to a loop of the function they are in:
    // a callback is a function of its own.
    const jumps = analyze([
        "declare xs: number[]",
        "for (const x in xs) { const doubled = xs:map(y => { if (y > 1) { continue }\n return y * 2 }) }",
        "while (true) { if (xs[1] == 1) { break }\n repeat { continue } until (true) }",
        "break",
    ].join("\n"))
    check("loops: break and continue outside a loop", jumps.errors, [
        "'continue' is not inside a loop of this function; to skip a value in a callback, 'return' from it",
        "'break' is not inside a loop",
    ])
    const optional = analyze([
        "type Node = { Parent: Node | nil, Name: string, find: (self: Node, name: string) => Node | nil }",
        "declare node: Node | nil",
        "declare run: { go: () => number } | nil",
        "const name = node?.Name",
        "const deep = node?.Parent?.Name",
        "const found = node?:find(\"a\")",
        "const called = run?.go()",
        "const paren = (node?.Parent)",
        "function f(n: Node | nil) {",
        "    if (n?.Parent) { const truthy = n } else { const falsy = n }",
        "    if (n?.Name ~= nil) { const present = n }",
        "    if (n?:find(\"a\")?.Name == \"a\") { const matched = n }",
        "}",
        "",
        "",
    ].join("\n"))
    check("optional chains: a chain is nil when a tested link is", [
        optional.bindings.name, optional.bindings.deep, optional.bindings.found, optional.bindings.called, optional.bindings.paren,
    ], ["string | nil", "string | nil", "Node | nil", "number | nil", "Node | nil"])
    const guarded = analyze([
        "declare class Instance { IsA: <K extends keyof ClassMap>(self: Instance, className: K) => self is ClassMap[K] }",
        "declare class Folder extends Instance {}",
        "type ClassMap = { Folder: Folder, Instance: Instance }",
        "declare function error(message: string): never",
        "declare function find(): Instance | nil",
        "function f() {",
        "    const a = find()",
        "    if (not a?:IsA(\"Folder\")) { error(\"no\") }",
        "    const afterGuard = a",
        "    const b = find()",
        "    if (b?:IsA(\"Folder\")) { const inside = b } else { const outside = b }",
        "}",
        "",
        "",
    ].join("\n"))
    check("optional chains: a type guard called through `?:` still narrows",
        [guarded.errors, guarded.bindings.afterGuard, guarded.bindings.inside, guarded.bindings.outside],
        [[], "Folder", "Folder", "Instance | nil"])
    check("optional chains: a chain that got through narrows what it tested", [
        optional.bindings.truthy, optional.bindings.falsy, optional.bindings.present, optional.bindings.matched,
    ], ["Node", "Node | nil", "Node", "Node"])
}

// `[...xs]` spreads an array into another.
{
    const program = parse([
        "function join(...parts: string[]) {",
        "    const both = [...parts, \"b\"]",
        "    const withOne = [1, ...parts]",
        "    return [both, withOne]",
        "}",
        "",
        "",
    ].join("\n"))
    const scopes = analyzeScopes(program)
    const types = analyzeTypes(program, scopes, {})
    const bindings: Record<string, string> = {}
    for (const [id, type] of types.bindingType) bindings[scopes.bindings.get(id)!.name] = formatType(type)
    check("arrays: `[...xs]` spreads",
        [types.diagnostics.map(d => d.message), bindings.both, bindings.withOne],
        [[], "string[]", "(number | string)[]"])
}

// --- rest parameters ---------------------------------------------------
{
    const analyze = (code: string) => {
        const program = parse(code)
        const scopes = analyzeScopes(program)
        const types = analyzeTypes(program, scopes, {})
        const bindings: Record<string, string> = {}
        for (const [id, type] of types.bindingType) bindings[scopes.bindings.get(id)!.name] = formatType(type)
        return { errors: [...scopes.diagnostics, ...types.diagnostics].map(d => d.message), bindings }
    }

    // `...rest: T[]` is an array in the body and `...` in the signature.
    const rest = analyze([
        "function join(sep: string, ...parts: string[]): string {",
        "    const held = parts",
        "    return table.concat(parts, sep)",
        "}",
        "declare table: { concat: (t: string[], sep: string) => string }",
        "const signature = join",
        "join(\"-\", \"a\", \"b\")",
        "join(\"-\", 1)",
        "join()",
        "",
        "",
    ].join("\n"))
    check("rest: an array inside, the varargs outside",
        [rest.errors, rest.bindings.held, rest.bindings.signature],
        [[
            "Argument of type '1' is not assignable to parameter of type 'string'",
            "Expected at least 1 arguments, got 0",
        ], "string[]", "(sep: string, ...args: string[]) => string"])

    // A rest parameter can be a tuple, or a type parameter standing for one:
    // then the arguments are exactly its elements.
    const whole = analyze([
        "declare function pair(...args: [string, number]): nil",
        "declare function forward<A extends unknown[]>(f: (...args: A) => nil, ...args: A): nil",
        "pair(\"a\", 1)",
        "pair(1, \"a\")",
        "forward(function(s: string, n: number) {}, \"a\", 1)",
        "const signature = pair",
    ].join("\n"))
    check("rest: a tuple, or a type parameter for one, is exactly those arguments",
        [whole.errors, whole.bindings.signature], [[
            "Argument of type '1' is not assignable to parameter of type 'string'",
        ], "(string, number) => nil"])

    // And in a type.
    const written = analyze([
        "declare log: (level: string, ...lines: string[]) => nil",
        `log("info", "a", "b")`,
        `log("info", 1)`,
    ].join("\n"))
    check("rest: a type can be written with one too",
        written.errors, ["Argument of type '1' is not assignable to parameter of type 'string'"])

    // What `...` holds says what a type parameter is.
    const generic = analyze([
        "function firstOf<T>(...items: T[]): T | nil {",
        "    return items[1]",
        "}",
        "const ofNumbers = firstOf(1, 2, 3)",
        "const ofStrings = firstOf(\"a\")",
        "",
        "",
    ].join("\n"))
    check("rest: the arguments say what a generic rest parameter holds",
        [generic.errors, generic.bindings.ofNumbers, generic.bindings.ofStrings],
        [[], "number | nil", "string | nil"])

    check("rest: no annotation is an array of anything",
        analyze("function f(...rest) {\n    const held = rest\n}").bindings.held, "unknown[]")

    check("rest: its type is an array",
        analyze("function f(...a: string) {\n}").errors,
        ["A rest parameter holds every argument from its position on, so 'a' is an array: 'string[]', not 'string'"])

    check("rest: nothing follows it", (() => {
        try {
            parse("function f(...a: string[], b: number) {}")
            return undefined
        } catch (error) {
            return (error as Error).message
        }
    })(), "A rest parameter is the last one: nothing can follow '...' (1:26)")
}

// --- braces -------------------------------------------------------------
// tilua writes a block in braces. `scripts/to-braces.ts` rewrote every file
// and every snippet here out of the `end` spellings Lua uses.
{
    const analyze = (code: string) => {
        const program = parse(code)
        const scopes = analyzeScopes(program)
        const types = analyzeTypes(program, scopes, {})
        const bindings: Record<string, string> = {}
        for (const [id, type] of types.bindingType) bindings[scopes.bindings.get(id)!.name] = formatType(type)
        return { errors: [...scopes.diagnostics, ...types.diagnostics].map(d => d.message), bindings }
    }

    const braced = analyze([
        "declare function pairs(t: { [string]: number }): () => [string, number]",
        "function classify(n: number): string {",
        "    if (n < 0) {",
        `        return "negative"`,
        "    } elseif (n == 0) {",
        `        return "zero"`,
        "    } else {",
        `        return "positive"`,
        "    }",
        "}",
        "function counted(): number {",
        "    let total = 0",
        "    for (i = 1, 3) {",
        "        total += i",
        "    }",
        "    for (const [name, n] in pairs({ a: 1 })) {",
        "        total += n",
        "    }",
        "    while (total > 0) {",
        "        total -= 1",
        "    }",
        "    repeat {",
        "        total += 1",
        "    } until (total == 2)",
        "    do { total += 1 }",
        "    return total",
        "}",
        "const said = classify(1)",
        "const count = counted()",
    ].join("\n"))
    check("braces: every block form reads",
        [braced.errors, braced.bindings.said, braced.bindings.count], [[], "string", "number"])

    const classes = analyze([
        "class Animal {",
        "    name: string",
        "    static count = 0",
        "    constructor(name: string) {",
        "        this.name = name",
        "    }",
        "    function speak(): string {",
        "        return this.name",
        "    }",
        "    get label(): string {",
        `        return "<" .. this.name .. ">"`,
        "    }",
        "}",
        "class Box<T> {",
        "    value: T",
        "    constructor(value: T) {",
        "        this.value = value",
        "    }",
        "    function get(): T {",
        "        return this.value",
        "    }",
        "}",
        "class Ints extends Box<number> {",
        "    constructor(n: number) {",
        "        super(n)",
        "    }",
        "}",
        `const dog = Animal.new("Rex")`,
        "const said = dog:speak()",
        "const held = Ints.new(1):get()",
    ].join("\n"))
    check("braces: a class, a generic one, and one extending it",
        [classes.errors, classes.bindings.dog, classes.bindings.said, classes.bindings.held],
        [[], "Animal", "string", "number"])

    // The parentheses are what tell a condition from a call: `f {}` is a call.
    const sugar = analyze([
        "declare function use(t: { a: number }): number",
        "const used = use { a: 1 }",
        "declare ready: boolean",
        "let seen = 0",
        "if (ready) { seen += 1 }",
    ].join("\n"))
    check("braces: a call with a table argument still reads as one",
        [sugar.errors, sugar.bindings.used], [[], "number"])

    // Both spellings, in one file.
    const mixed = analyze([
        "function old(n: number): string {",
        "    if (n > 0) {",
        "        return \"yes\"",
        "    }",
        "    return \"no\"",
        "}",
        "function new_(n: number): string {",
        "    return old(n)",
        "}",
        "const answer = new_(1)",
        "",
        "",
    ].join("\n"))
    check("braces: the older spelling still reads, beside the newer one",
        [mixed.errors, mixed.bindings.answer], [[], "string"])
}

// --- arrows ---------------------------------------------------------------
// One arrow for both, as TypeScript writes them: `(a: number) => string` is a
// function type, and `(a: number) => a` is a function. Which one a `=>` makes
// is decided by where it stands, since a type and a value never share a place.
{
    const analyze = (code: string) => {
        const program = parse(code)
        const scopes = analyzeScopes(program)
        const types = analyzeTypes(program, scopes, {})
        const bindings: Record<string, string> = {}
        for (const [id, type] of types.bindingType) bindings[scopes.bindings.get(id)!.name] = formatType(type)
        return { errors: [...scopes.diagnostics, ...types.diagnostics].map(d => d.message), bindings }
    }

    const written = analyze([
        "declare applied: (f: (n: number) => string, n: number) => string",
        "type Handler = (event: string) => nil",
        "declare handled: Handler",
        "declare older: (n: number) => string",
        "const apply = applied",
        "const handle = handled",
        "const old = older",
        "",
        "",
    ].join("\n"))
    check("arrows: a function type is written `=>`",
        [written.errors, written.bindings.apply, written.bindings.handle, written.bindings.old],
        [[], "(f: (n: number) => string, n: number) => string",
            // `handled` was declared as `Handler`, and that is what it reads as.
            "Handler", "(n: number) => string"])

    const refusal = (code: string): string | undefined => {
        try {
            parse(code)
            return undefined
        } catch (error) {
            return (error as Error).message.replace(/ \(\d+:\d+\)$/, "")
        }
    }

    // Luau's arrow is refused rather than quietly accepted: reading both only
    // raised the question of whether they meant different things.
    check("arrows: `->` is refused, and the message says what to write", [
        refusal("declare f: (n: number) -> string"),
        refusal("type T = (n: number) -> string"),
        refusal("declare g: () -> ()"),
        // In recovery it is read as the arrow it was meant to be, so the rest
        // of the file still analyses.
        (() => {
            const { program, errors } = parseWithRecovery("declare f: (n: number) -> string\nconst x = 1")
            return [errors.map(e => e.message.replace(/ \(\d+:\d+\)$/, "")), program.body.statements.map(s => s.type)]
        })(),
    ], [
        "tilua writes a function type with '=>', not '->'",
        "tilua writes a function type with '=>', not '->'",
        "tilua writes a function type with '=>', not '->'",
        [["tilua writes a function type with '=>', not '->'"], ["DeclareStatement", "VariableDeclaration"]],
    ])

    const values = analyze([
        "declare function tostring(v: unknown): string",
        "const double = (x: number) => x * 2",
        "const add = (a: number, b: number) => a + b",
        "const none = () => 0",
        "const said = (a: number): string => tostring(a)",
        "const curried = (a: number) => (b: number) => a + b",
        "const applied = curried(1)(2)",
        "const doubled = double(21)",
    ].join("\n"))
    check("arrows: a function, written short",
        [values.errors, values.bindings.double, values.bindings.said,
            values.bindings.curried, values.bindings.applied, values.bindings.doubled],
        [[], "(x: number) => number", "(a: number) => string",
            "(a: number) => (b: number) => number", "number", "number"])

    // A block body is a block, as in TypeScript — so an object has to be
    // parenthesized to be returned.
    const bodies = analyze([
        "declare function print(v: unknown): nil",
        "const logged = (n: number) => {",
        "    const doubled = n * 2",
        "    print(doubled)",
        "    return doubled",
        "}",
        "const wrapped = (n: number) => ({ value: n })",
        "const ran = logged(1)",
        "const held = wrapped(1)",
    ].join("\n"))
    check("arrows: a block body is a block, and an object is parenthesized",
        [bodies.errors, bodies.bindings.ran, bodies.bindings.held],
        [[], "number", "{ value: number }"])

    // One parameter needs no parentheses, and a generic one is written as it
    // is on a function.
    const short = analyze([
        "declare function each(f: (n: number) => nil): nil",
        "each(n => print(n))",
        "declare function print(v: unknown): nil",
        "const identity = <T>(v: T) => v",
        "const one = identity(1)",
    ].join("\n"))
    check("arrows: one parameter bare, and a generic one",
        [short.errors, short.bindings.identity, short.bindings.one],
        [[], "<T>(v: T) => T", "number"])

    // What starts the same way still reads the way it did.
    const unchanged = analyze([
        "declare function f(n: number): number",
        "const sum = (1 + 2) * 3",
        "const called = (f)(1)",
        "declare t: { m: (self: unknown) => number }",
        "const method = (t):m()",
    ].join("\n"))
    check("arrows: a parenthesized expression is still one",
        [unchanged.errors, unchanged.bindings.sum, unchanged.bindings.called, unchanged.bindings.method],
        [[], "number", "number", "number"])
}

// --- branded types -----------------------------------------------------
// `string & { __brand }` is a string nothing else is: the intersection is
// assignable to `string`, and `string` is not assignable to it. Nothing in
// the type model is about branding — this is what intersections already mean
// — so these cases are here to keep it that way.
{
    const analyze = (code: string) => {
        const program = parse(code)
        const scopes = analyzeScopes(program)
        const types = analyzeTypes(program, scopes, {})
        const bindings: Record<string, string> = {}
        for (const [id, type] of types.bindingType) bindings[scopes.bindings.get(id)!.name] = formatType(type)
        return { errors: [...scopes.diagnostics, ...types.diagnostics].map(d => d.message), bindings }
    }

    const BRANDS = [
        `type UserId = string & { readonly __brand: "UserId" }`,
        `type PostId = string & { readonly __brand: "PostId" }`,
        "declare function findUser(id: UserId): string",
        "declare function take(s: string): nil",
    ].join("\n")

    check("branded: a raw value is not one, and neither is another brand", analyze([
        BRANDS,
        "declare post: PostId",
        `findUser("raw")`,
        "findUser(post)",
    ].join("\n")).errors, [
        `Argument of type '"raw"' is not assignable to parameter of type 'UserId'`,
        "Argument of type 'PostId' is not assignable to parameter of type 'UserId'",
    ])

    const made = analyze([
        BRANDS,
        `const id = "raw" as UserId`,
        "findUser(id)",
        "take(id)",
        "const length = #id",
    ].join("\n"))
    check("branded: `as` makes one, and it is still what it was branded from",
        [made.errors, made.bindings.id, made.bindings.length],
        [[], "UserId", "number"])

    // Anything that builds a new value builds an unbranded one, which is the
    // point: the brand says where the value came from.
    check("branded: an operation on one gives back the plain type", analyze([
        BRANDS,
        "declare id: UserId",
        `findUser(id .. "x")`,
        `take(id .. "x")`,
    ].join("\n")).errors,
        ["Argument of type 'string' is not assignable to parameter of type 'UserId'"])

    const carried = analyze([
        BRANDS,
        "declare id: UserId",
        "declare ids: UserId[]",
        "declare maybe: UserId | nil",
        "const held = { id: id }",
        "findUser(held.id)",
        "findUser(ids[1])",
        "if (maybe) { findUser(maybe) }",
        `type Ticks = number & { readonly __brand: "Ticks" }`,
        "declare ticks: Ticks",
        "const counted: number = ticks + 1",
    ].join("\n"))
    check("branded: it survives being stored, indexed and narrowed, on any type",
        [carried.errors, carried.bindings.counted], [[], "number"])
}

// --- spread arguments --------------------------------------------------
{
    const analyze = (code: string) => {
        const program = parse(code)
        const scopes = analyzeScopes(program)
        const types = analyzeTypes(program, scopes, {})
        const bindings: Record<string, string> = {}
        for (const [id, type] of types.bindingType) bindings[scopes.bindings.get(id)!.name] = formatType(type)
        return { errors: [...scopes.diagnostics, ...types.diagnostics].map(d => d.message), bindings }
    }

    const DECLARED = [
        "declare function add3(a: number, b: number, c: number): number",
        "declare function join(sep: string, ...parts: string[]): string",
        "declare nums: number[]",
        "declare words: string[]",
    ].join("\n")

    const fills = analyze([
        DECLARED,
        "const summed = add3(...nums)",
        "const withOne = add3(1, ...nums)",
        `const joined = join("-", ...words)`,
    ].join("\n"))
    check("spread: an array fills the parameters from there on",
        [fills.errors, fills.bindings.summed, fills.bindings.withOne, fills.bindings.joined],
        [[], "number", "number", "string"])

    check("spread: and what it holds still has to fit", analyze([
        DECLARED,
        "add3(...words)",
        `join("-", ...nums)`,
    ].join("\n")).errors, [
        "Argument of type 'string' is not assignable to parameter of type 'number'",
        "Argument of type 'number' is not assignable to parameter of type 'string'",
    ])

    // How many an array holds is not known, so the count says nothing — but a
    // tuple's is, and it does.
    check("spread: an array says nothing about how many, a tuple says exactly", analyze([
        DECLARED,
        "declare pair: [number, string]",
        "declare trio: [number, number, number]",
        "declare function takes(a: number, b: string): nil",
        "add3(...nums)",
        "add3()",
        "takes(...pair)",
        "add3(...trio)",
        "takes(...trio)",
    ].join("\n")).errors, [
        "Expected 3 arguments, got 0",
        "Expected 2 arguments, got 3",
    ])

    check("spread: only a list can be spread", analyze([
        DECLARED,
        "declare n: number",
        "add3(...n)",
    ].join("\n")).errors, ["Only an array can be spread, and 'number' is not one"])

    const generic = analyze([
        "declare function firstOf<T>(...items: T[]): T | nil",
        "declare nums: number[]",
        "const picked = firstOf(...nums)",
    ].join("\n"))
    check("spread: a generic reads what it holds through one",
        [generic.errors, generic.bindings.picked], [[], "number | nil"])

    // A spread goes in a call's arguments or an array, not where one value is.
    check("spread: not where one value goes",
        parseWithRecovery("declare pair: string[]\nconst a = ...pair").errors.map(e => e.message),
        ["A spread goes in a call's arguments or an array: take values out of an array with a destructuring, 'const [a, b] = xs' (2:11)"])

    // One name, one value: several are an array, taken apart with a
    // destructuring. Written the Luau way, it is read as that destructuring.
    {
        const recovered = parseWithRecovery("let a, b = 1, 2\nconst c, d = f()\nlet e = 0\ne, a = 1, 2")
        const [ab, cd] = recovered.program.body.statements as any[]
        check("declarations and assignments: one value each", [
            recovered.errors.map(e => e.message),
            [ab.name.type, ab.init.type, cd.name.type, cd.init.type],
        ], [[
            "A declaration takes one value: take several from an array, 'let [a, b] = [x, y]' (1:1)",
            "A declaration takes one value: take several from an array, 'const [a, b] = [x, y]' (2:1)",
            "An assignment takes one value: take several from an array, '[a, b] = [x, y]' (4:1)",
        ], ["ArrayPattern", "ArrayExpression", "ArrayPattern", "CallExpression"]])
    }

    // Several results are an array, and a destructuring takes them apart.
    const tupled = analyze([
        "declare nums: number[]",
        "function mixed(): [string, ...number[]] {",
        "    return [\"a\", ...nums]",
        "}",
        "function wrong(): [string, string] {",
        "    return nums",
        "}",
        "const [label, ...rest] = mixed()",
    ].join("\n"))
    check("tuples: returned, and taken apart",
        [tupled.errors, tupled.bindings.label, tupled.bindings.rest], [[
            "Type 'number[]' is not assignable to '[string, string]'",
        ], "string", "number[]"])
}

// --- classes -----------------------------------------------------------
{
    const analyze = (code: string, modules: Record<string, string> = {}) => {
        const program = parse(code)
        const scopes = analyzeScopes(program)
        const resolveModule = (specifier: string): ModuleExports | undefined => {
            const source = modules[specifier]
            if (source === undefined) return undefined
            const p = parse(source)
            const s = analyzeScopes(p)
            return moduleExports(p, s, analyzeTypes(p, s))
        }
        const types = analyzeTypes(program, scopes, { resolveModule })
        const bindings: Record<string, string> = {}
        for (const [id, type] of types.bindingType) bindings[scopes.bindings.get(id)!.name] = formatType(type)
        return { errors: [...scopes.diagnostics, ...types.diagnostics].map(d => d.message), bindings }
    }

    const ANIMALS = [
        "class Animal {",
        "    name: string",
        "    kind = \"animal\"",
        "    static count = 0",
        "    constructor(name: string) {",
        "        this.name = name",
        "    }",
        "    function speak(): string {",
        "        return this.name",
        "    }",
        "    get label(): string {",
        "        return this.name",
        "    }",
        "}",
        "class Dog extends Animal {",
        "    breed: string",
        "    constructor(name: string, breed: string) {",
        "        super(name)",
        "        this.breed = breed",
        "    }",
        "    function speak(): string {",
        "        return super.speak() .. this.breed",
        "    }",
        "}",
        "",
        "",
    ].join("\n")

    // A class names a type and a value at once: the instances and the table.
    const basic = analyze([
        ANIMALS,
        "const d = Dog.new(\"Rex\", \"corgi\")",
        "const said = d:speak()",
        "const shown = d.label",
        "const inherited = d.kind",
        "const asBase: Animal = d",
        "const total = Animal.count",
        "const byHand = Dog.new(\"a\", \"b\")",
    ].join("\n"))
    check("class: an instance carries its own members and the ones it inherits",
        [basic.errors, basic.bindings.d, basic.bindings.said, basic.bindings.shown,
            basic.bindings.inherited, basic.bindings.asBase, basic.bindings.total, basic.bindings.byHand],
        [[], "Dog", "string", "string", "string", "Animal", "number", "Dog"])

    // Nominal, like `declare class`: the shape is not enough.
    check("class: a table is not an instance, whatever its shape", analyze([
        "class Point {",
        "    x: number",
        "    constructor(x: number) {",
        "        this.x = x",
        "    }",
        "}",
        "declare function take(p: Point): nil",
        "take({ x: 1 })",
        "",
        "",
    ].join("\n")).errors, ["Argument of type '{ x: number }' is not assignable to parameter of type 'Point'"])

    check("class: the constructor says what `new` takes", analyze([
        "class Vec {",
        "    x: number",
        "    constructor(x: number) {",
        "        this.x = x",
        "    }",
        "}",
        "const bad = Vec.new(\"a\")",
        "const missing = Vec.new()",
        "",
        "",
    ].join("\n")).errors, [
        "Argument of type '\"a\"' is not assignable to parameter of type 'number'",
        "Expected 1 argument, got 0",
    ])

    check("class: a field nothing gives a value is nil however it is annotated", analyze([
        "class Broken {",
        "    name: string",
        "    count: number",
        "    maybe: string | nil",
        "    constructor() {",
        "        this.count = 0",
        "    }",
        "}",
        "",
        "",
    ].join("\n")).errors,
        ["'name' has no value: give it one, assign it in the constructor on every path, or let its type admit nil"])

    check("class: a derived constructor has to call super", analyze([
        "class A {",
        "    constructor() { }",
        "}",
        "class B extends A {",
        "    constructor() {",
        "    }",
        "}",
        "",
        "",
    ].join("\n")).errors, ["'B' extends 'A', so its constructor must call 'super(...)'"])

    check("class: super needs a base, and extends needs a class", analyze([
        "type Thing = { a: number }",
        "class Loose {",
        "    function f() {",
        "        return super.g()",
        "    }",
        "}",
        "class Wrong extends Thing {",
        "}",
        "class Gone extends Missing {",
        "}",
        "",
        "",
    ].join("\n")).errors, [
        "'super' is only available inside a class that extends another",
        "'Thing' is not a class; a class can only extend another class",
        "Cannot find class 'Missing'",
    ])

    check("class: a chain that closes inherits nothing", analyze([
        "class A extends B {",
        "}",
        "class B extends A {",
        "}",
        "",
        "",
    ].join("\n")).errors, ["'A' cannot extend itself", "'B' cannot extend itself"])

    check("class: a member is written once, and not under the compiler's own names", analyze([
        "class A {",
        "    x = 1",
        "    x = 2",
        "    new = 3",
        "    __init = 4",
        "    get p(): number {",
        "        return 1",
        "    }",
        "    set p(v: number) {",
        "    }",
        "}",
        "",
        "",
    ].join("\n")).errors, [
        "'new' is what the compiler calls part of a class; a member cannot be named that",
        "'__init' is what the compiler calls part of a class; a member cannot be named that",
        "'x' is declared twice in class 'A'",
    ])

    // A getter alone is read-only; a setter alongside it makes it writable.
    const accessors = analyze([
        "class A {",
        "    get readOnly(): number {",
        "        return 1",
        "    }",
        "    get both(): string {",
        "        return \"a\"",
        "    }",
        "    set both(value: string) {",
        "    }",
        "}",
        "declare function want(v: { readonly readOnly: number, both: string }): nil",
        "want(A.new())",
        "",
        "",
    ].join("\n"))
    check("class: a getter without a setter is read-only", accessors.errors, [])

    // `new` above the declaration: the name is there from the top of the block.
    const hoisted = analyze([
        "const early = Later.new(1)",
        "class Later {",
        "    n: number",
        "    constructor(n: number) {",
        "        this.n = n",
        "    }",
        "}",
        "",
        "",
    ].join("\n"))
    check("class: a class can be named above where it is written",
        [hoisted.errors, hoisted.bindings.early], [[], "Later"])

    // Across modules the class is both an export and a type.
    const imported = analyze([
        "import { Shape } from \"./shape\"",
        "class Circle extends Shape {",
        "    radius: number",
        "    constructor(radius: number) {",
        "        super(\"circle\")",
        "        this.radius = radius",
        "    }",
        "    function area(): number {",
        "        return this.radius",
        "    }",
        "}",
        "const c = Circle.new(2)",
        "const named = c.name",
        "const measured = c:area()",
        "const asShape: Shape = c",
        "",
        "",
    ].join("\n"), {
        "./shape": [
            "export class Shape {",
            "    name: string",
            "    constructor(name: string) {",
            "        this.name = name",
            "    }",
            "    function area(): number {",
            "        return 0",
            "    }",
            "}",
            "",
            "",
        ].join("\n"),
    })
    check("class: an imported class can be extended, and is still a type",
        [imported.errors, imported.bindings.c, imported.bindings.named,
            imported.bindings.measured, imported.bindings.asShape],
        [[], "Circle", "string", "number", "Shape"])

    // Overloads inside a class read as they do outside one.
    const overloaded = analyze([
        "class Box {",
        "    function get(key: string): number",
        "    function get(key: number): string",
        "    function get(key: string | number): number | string {",
        "        return 1",
        "    }",
        "    static function of(n: number): Box",
        "    static function of(n: string): Box",
        "    static function of(n: number | string): Box {",
        "        return Box.new()",
        "    }",
        "}",
        "const b = Box.new()",
        "const byName = b:get(\"k\")",
        "const byIndex = b:get(1)",
        "const made = Box.of(1)",
        "b:get(true)",
        "",
        "",
    ].join("\n"))
    check("class: a method can be overloaded, and the receiver is still implied",
        [overloaded.errors, overloaded.bindings.byName, overloaded.bindings.byIndex, overloaded.bindings.made],
        [["No overload matches this call"], "number", "string", "Box"])

    // `protected`: the class and the classes extending it; `readonly`: set
    // where declared or in the constructor of its own class.
    const guarded = analyze([
        "class Unit {",
        "    readonly id: number",
        "    protected hp = 100",
        "    constructor(id: number) {",
        "        this.id = id",
        "    }",
        "    function rename() {",
        "        this.id = 2",
        "    }",
        "}",
        "class Boss extends Unit {",
        "    function hit() {",
        "        this.hp -= 1",
        "    }",
        "}",
        "const boss = Boss.new(1)",
        "boss.id = 3",
        "const hp = boss.hp",
        "const id: number = boss.id",
    ].join("\n"))
    check("class: `readonly` outside the constructor, and `protected` outside the family", guarded.errors, [
        "Cannot assign to 'id' because it is a read-only property",
        "Cannot assign to 'id' because it is a read-only property",
        "Property 'hp' is protected and only accessible within class 'Unit' and the classes extending it",
    ])

    // `abstract`: no `new`, and a class extending it writes what it left out.
    const abstracts = analyze([
        "abstract class Shape {",
        "    abstract function area(): number",
        "    function describe(): string {",
        "        return `area ${this:area()}`",
        "    }",
        "}",
        "class Circle extends Shape {",
        "    r = 1",
        "    override function area(): number {",
        "        return 3 * this.r * this.r",
        "    }",
        "}",
        "class Square extends Shape {",
        "    override function perimeter(): number {",
        "        return 4",
        "    }",
        "}",
        "class Loose {",
        "    abstract function nothing(): number",
        "}",
        "class Wrong extends Circle {",
        "    override function area(): string {",
        "        return super.describe()",
        "    }",
        "}",
        "const circle = Circle.new()",
        "const said: string = circle:describe()",
        "const shape = Shape.new()",
    ].join("\n"))
    check("class: abstract classes and members, and `override`", abstracts.errors, [
        "'Square' does not write the abstract member 'area' of the class it extends; write it, or make 'Square' abstract too",
        "'perimeter' is marked 'override', but 'Shape' has no member of that name",
        "'nothing' is abstract, so 'Loose' has to be an 'abstract class'",
        "'area' in 'Wrong' does not fit the 'area' of 'Circle' it replaces: '() => string' is not assignable to '() => number'",
        "'Shape' is an abstract class: build one of the classes extending it instead",
    ])

    // `implements`: every member the shape names, of a type that fits.
    const implemented = analyze([
        "type Named = { name: string, greet: (self: Named) => string, nickname?: string }",
        "class Person implements Named {",
        "    name = \"ana\"",
        "    function greet(): string {",
        "        return this.name",
        "    }",
        "}",
        "class Robot implements Named {",
        "    name = 1",
        "}",
        "class Odd implements number {",
        "}",
    ].join("\n"))
    check("class: `implements` checks the members", implemented.errors, [
        "'Robot' does not implement 'Named': its 'name' is 'number', not 'string'",
        "'Robot' does not implement 'Named': 'greet' is missing",
        "A class can only implement an object type or a class, not 'number'",
    ])

    // A field is assigned on every way through the constructor, or it is nil.
    const fields = analyze([
        "declare flag: boolean",
        "class Split {",
        "    both: number",
        "    one: number",
        "    later: number",
        "    constructor() {",
        "        if (flag) {",
        "            this.both = 1",
        "            this.one = 1",
        "        } else {",
        "            this.both = 2",
        "        }",
        "        const set = function() {",
        "            this.later = 1",
        "        }",
        "    }",
        "}",
    ].join("\n"))
    check("class: a field has to be assigned on every path through the constructor", fields.errors, [
        "'one' has no value: give it one, assign it in the constructor on every path, or let its type admit nil",
        "'later' has no value: give it one, assign it in the constructor on every path, or let its type admit nil",
    ])

    // A method named for a metamethod is one: its instances answer to it.
    const meta = analyze([
        "class Vec {",
        "    x: number",
        "    constructor(x: number) {",
        "        this.x = x",
        "    }",
        "    function __add(other: Vec): Vec {",
        "        return Vec.new(this.x + other.x)",
        "    }",
        "    function __lt(other: Vec): boolean {",
        "        return this.x < other.x",
        "    }",
        "    function __len(): number {",
        "        return this.x",
        "    }",
        "    function __call(scale: number): Vec {",
        "        return Vec.new(this.x * scale)",
        "    }",
        "    function __iter(): [(s: nil, previous: [number, string] | nil) => [number, string] | nil, nil, nil] {",
        "        return [function(): [number, string] { return [this.x, \"x\"] }, nil, nil]",
        "    }",
        "    function __tostring(): string {",
        "        return `${this.x}`",
        "    }",
        "}",
        "class Plain {",
        "    function __eq(): boolean {",
        "        return true",
        "    }",
        "    static function __sub(a: Plain): Plain {",
        "        return a",
        "    }",
        "    function __tostring(): number {",
        "        return 1",
        "    }",
        "}",
        "const a = Vec.new(1)",
        "const b = Vec.new(2)",
        "const sum = a + b",
        "const less = a < b",
        "const size = #a",
        "const scaled = a(3)",
        "for (const [index, label] in a) {",
        "    const i: number = index",
        "    const l: string = label",
        "}",
        "const p = Plain.new()",
        "const compared = p < p",
    ].join("\n"))
    check("class: metamethods type the operators, and are checked themselves", [
        meta.errors, meta.bindings.sum, meta.bindings.less, meta.bindings.size, meta.bindings.scaled,
    ], [[
        "'__eq' takes one operand besides 'this'",
        "'__sub' is a metamethod of the instances; it cannot be static",
        "'__tostring' has to return string, not 'number'",
        "Operator '<' cannot be applied to types 'Plain' and 'Plain'",
    ], "Vec", "boolean", "number", "Vec"])

    // The modifiers are soft keywords, and say when they are misplaced.
    check("class: modifiers in any order, as names where no member follows, and misplaced", [
        analyze("class A {\n    readonly = 1\n    static private readonly count = 0\n    protected static function f(): number {\n        return 1\n    }\n}").errors,
        parseWithRecovery("class A {\n    readonly function f() {}\n    static static x = 1\n}").errors.map(e => e.message),
        parseWithRecovery("abstract class A {\n    abstract function f(): number {\n        return 1\n    }\n}").errors.length > 0,
    ], [
        [],
        ["Only a field can be 'readonly' (2:5)", "'static' is written twice (3:12)"],
        true,
    ])

    // A class written inside a function names a type there too.
    const nested = analyze([
        "function make(n: number): number {",
        "    class Local {",
        "        n: number",
        "        constructor(n: number) {",
        "            this.n = n",
        "        }",
        "        function twice(): number {",
        "            return this.n * 2",
        "        }",
        "    }",
        "    const it = Local.new(n)",
        "    return it:twice()",
        "}",
        "",
        "",
    ].join("\n"))
    check("class: a class inside a function is a type there too",
        [nested.errors, nested.bindings.it], [[], "Local"])

    // A generic class: `new` reads the argument off what it is handed.
    const BOX = [
        "class Box<T> {",
        "    value: T",
        "    constructor(value: T) {",
        "        this.value = value",
        "    }",
        "    function get(): T {",
        "        return this.value",
        "    }",
        "    function set(v: T) {",
        "        this.value = v",
        "    }",
        "}",
        "",
        "",
    ].join("\n")

    const generic = analyze([
        BOX,
        "const ofNumber = Box.new(1)",
        "const ofString = Box.new<string>(\"a\")",
        "const gotNumber = ofNumber:get()",
        "const gotString = ofString:get()",
        "ofNumber:set(\"wrong\")",
    ].join("\n"))
    check("class: a generic class takes its argument from the constructor, or from what is written",
        [generic.errors, generic.bindings.ofNumber, generic.bindings.ofString,
            generic.bindings.gotNumber, generic.bindings.gotString],
        [["Argument of type '\"wrong\"' is not assignable to parameter of type 'number'"],
            "Box<number>", "Box<string>", "number", "string"])

    const instantiations = analyze([
        BOX,
        "declare function wantNumbers(b: Box<number>): nil",
        "wantNumbers(Box.new(1))",
        "wantNumbers(Box.new(\"a\"))",
        "function unwrap<T>(b: Box<T>): T {",
        "    return b:get()",
        "}",
        "const unwrapped = unwrap(Box.new(true))",
    ].join("\n"))
    check("class: one instantiation is not another, and a parameter reads the argument off it",
        [instantiations.errors, instantiations.bindings.unwrapped],
        [["Argument of type 'Box<string>' is not assignable to parameter of type 'Box<number>', 'value' is string, not number"], "boolean"])

    const fixed = analyze([
        BOX,
        "class Ints extends Box<number> {",
        "    constructor(n: number) {",
        "        super(n)",
        "    }",
        "    function double(): number {",
        "        return this:get() * 2",
        "    }",
        "}",
        "declare function wantNumbers(b: Box<number>): nil",
        "declare function wantStrings(b: Box<string>): nil",
        "wantNumbers(Ints.new(1))",
        "wantStrings(Ints.new(1))",
        "const doubled = Ints.new(21):double()",
    ].join("\n"))
    check("class: extending a generic class fixes its argument",
        [fixed.errors, fixed.bindings.doubled],
        [["Argument of type 'Ints' is not assignable to parameter of type 'Box<string>', 'value' is number, not string"], "number"])

    // A class written as a value.
    const asValue = analyze([
        "const Counter = class {",
        "    n = 0",
        "    function bump(): number {",
        "        this.n += 1",
        "        return this.n",
        "    }",
        "}",
        "const counter = Counter.new()",
        "const bumped = counter:bump()",
        "",
        "",
    ].join("\n"))
    check("class: a class written as a value is a class, named after what holds it",
        [asValue.errors, asValue.bindings.counter, asValue.bindings.bumped],
        [[], "Counter", "number"])

    const twoValues = analyze([
        "const A = class {",
        "    x = 1",
        "}",
        "const B = class {",
        "    x = 1",
        "}",
        "const anA = A.new()",
        "declare function wantA(v: typeof anA): nil",
        "wantA(A.new())",
        "wantA(B.new())",
        "",
        "",
    ].join("\n"))
    check("class: two classes written as values are different types however alike",
        twoValues.errors, ["Argument of type 'B' is not assignable to parameter of type 'A'"])

    check("class: a class written as a value has no name to instantiate", (() => {
        try {
            parse("const C = class<T> { x: T }")
            return undefined
        } catch (error) {
            return (error as Error).message
        }
    })(), "A class written as a value takes no type parameters: nothing could write the arguments, got '<' (1:16)")

    // `export default class` declares the name here as well as exporting it.
    const defaulted = analyze([
        "import Service from \"./service\"",
        "const running = Service.new()",
        "const named = running.name",
    ].join("\n"), {
        "./service": [
            "export default class Service {",
            "    name = \"svc\"",
            "    function run(): string {",
            "        return this.name",
            "    }",
            "}",
            "",
            "",
        ].join("\n"),
    })
    check("class: `export default class` exports the class and keeps its name",
        [defaulted.errors, defaulted.bindings.running, defaulted.bindings.named],
        [[], "Service", "string"])

    // The links the memory model promises.
    const links = analyze([
        "class Base {",
        "    n = 1",
        "}",
        "class Derived extends Base {",
        "}",
        "const instance = Derived.new()",
        "const itsClass = instance.ClassObject",
        "const itsParent = Derived.ParentClass",
        "const rootParent = Base.ParentClass",
        "",
        "",
    ].join("\n"))
    check("class: an instance names its class, and a class names the one it extends",
        [links.errors, links.bindings.itsClass, links.bindings.itsParent, links.bindings.rootParent],
        [[], "typeof Derived", "typeof Base", "nil"])

    // Luau builds an instance with the class's own function, and so does
    // tilua: `Name.new(...)` is not a way to write it.
    check("class: 'Name.new(...)' is not tilua, and says what is",
        parseWithRecovery("class A {}\nconst a = n" + "ew A()").errors.map(e => e.message),
        ["tilua has no 'new' operator: construct with 'Name.new(...)' (2:11)"])
    // A generic inferred through an object literal owns the literal information
    // at its slot, even when that slot is several objects deep.
    const nestedGeneric = analyze([
        "function hold<T>(value: { nested: T }): T { return value.nested }",
        "function box<T>(value: { nested: { tag: T } }): T { return value.nested.tag }",
        "const object = hold({ nested: { kind: \"ready\" } })",
        "const literal = box({ nested: { tag: \"ready\" } })",
        "",
        "",
    ].join("\n"))
    check("generic object arguments: nested literals infer without widening",
        [nestedGeneric.errors, nestedGeneric.bindings.object, nestedGeneric.bindings.literal],
        [[], "{ kind: \"ready\" }", "\"ready\""])
}

// Regressions: the bugs fixed after 5.2.0.
{
    const analyze = (code: string) => {
        const program = parse(code)
        const scopes = analyzeScopes(program)
        const types = analyzeTypes(program, scopes, {})
        const bindings: Record<string, string> = {}
        for (const [id, type] of types.bindingType) bindings[scopes.bindings.get(id)!.name] = formatType(type)
        return { errors: [...scopes.diagnostics, ...types.diagnostics].map(d => d.message), bindings }
    }
    const aliasOf = (code: string): string => {
        const program = parse(code)
        return formatType(analyzeTypes(program, analyzeScopes(program), {}).aliases.get("A")!)
    }

    // A ternary's `:` and Lua's method-call `:` are the same character. The
    // consequent keeps as many method calls as it can, and the ternary still
    // gets its own.
    {
        const shape = (code: string): string => {
            const statement = parse(code).body.statements[0] as unknown as { init: unknown[] }
            const describe = (n: any): string =>
                n.type === "IfElseExpression" ? `ternary(${describe(n.clauses[0].body)} : ${describe(n.alternate)})`
                    : n.type === "MethodCallExpression" ? `method(${describe(n.object)}:${n.method.name})`
                        : n.type === "CallExpression" ? `call(${describe(n.callee)})`
                            : n.type === "Identifier" ? n.name : n.type
            return describe(statement.init)
        }
        check("ternary: a call in the alternate is not a method call on the consequent", [
            shape("const x = c ? a : b()"),
            shape("const x = c ? obj:m() : b"),
            shape("const x = c ? obj:m() : b()"),
            shape("const x = c ? a:b():d() : e()"),
            shape("const x = c ? f(a:b()) : g()"),
            shape("const x = c ? a : d ? e() : f()"),
        ], [
            "ternary(a : call(b))",
            "ternary(method(obj:m) : b)",
            "ternary(method(obj:m) : call(b))",
            "ternary(method(method(a:b):d) : call(e))",
            "ternary(call(f) : call(g))",
            "ternary(a : ternary(call(e) : call(f)))",
        ])
    }

    // A `type` written inside a function is still a type.
    check("type aliases: one declared in a nested scope resolves", analyze([
        "function outer() {",
        "    type A = number",
        "    function inner(a: A) { return a }",
        "    return inner(1)",
        "}",
    ].join("\n")).errors, [])

    // `unknown` promises nothing, so a member of it has to be narrowed out
    // first — unlike `any`. The analyzer's own "not worked out yet" is a
    // different thing that happens to share the name, and says nothing.
    check("unknown: reading a member of a written one is an error", [
        analyze("declare u: unknown\nconst p = u.prop").errors,
        analyze("declare a: any\nconst p = a.prop.deep").errors,
        analyze("type S = { prop: number }\ndeclare u: unknown\nconst p = (u as S).prop").errors,
        analyze("declare map: { [string]: string }\ndeclare key: string\nconst value = map[key]\n;(\"A\"):upper()").errors,
    ], [["'u' is of type 'unknown'"], [], [], []])

    // A value that is one function or another is callable, and returns either.
    const united = analyze([
        "type Stat = { Status: boolean }",
        "declare pick: ((a: number, b: string) => Stat) | ((a: number) => Stat)",
        "const stat = pick(1, \"x\")",
    ].join("\n"))
    check("union of function types: callable, returning their returns united",
        [united.errors, united.bindings.stat], [[], "Stat"])

    // A homomorphic mapped type distributes over a union argument, as in
    // TypeScript, and `keyof` a union is the keys its members share.
    {
        const STAT = [
            "type Success = { Attack: number, Status: true }",
            "type Err = { Status: false, Message: string }",
            "type Stat = Success | Err",
        ].join("\n")
        check("mapped types: homomorphic ones distribute over a union", [
            aliasOf(`${STAT}\ntype A = Partial<Stat>`),
            aliasOf(`${STAT}\ntype A = keyof Stat`),
            aliasOf(`${STAT}\ntype A = { [K in keyof Stat]?: Stat[K] }`),
        ], [
            "{ Attack?: number, Status?: true } | { Message?: string, Status?: false }",
            `"Status"`,
            "{ Status?: boolean }",
        ])
    }

    // `readonly` is a promise about the property rather than the value it
    // holds: writing *through* it is the one thing it rules out.
    check("readonly: assigning through it is reported", [
        analyze("type T = { readonly a: number }\ndeclare t: T\nt.a = 2").errors,
        analyze("type T = { readonly a: number }\ndeclare t: T\nt[\"a\"] = 2").errors,
        analyze("type T = { readonly a: number }\ndeclare t: T\nt.a += 1").errors,
        analyze("type T = { a: number }\ndeclare t: T\nt.a = 2").errors,
        analyze("type T = { readonly a: { b: number } }\ndeclare t: T\nt.a.b = 2").errors,
    ], [
        ["Cannot assign to 'a' because it is a read-only property"],
        ["Cannot assign to 'a' because it is a read-only property"],
        ["Cannot assign to 'a' because it is a read-only property"],
        [], [],
    ])

    // `private` is checked where the member is reached: inside the class that
    // declared it, including functions nested in its methods, and nowhere
    // else — a subclass is outside.
    {
        const klass = "class A {\n    private n = 1\n    private static s = 2\n    private function f(): number { return this.n }\n"
            + "    function g(): number { const h = (): number => this.n; return h() + this:f() + A.s }\n}\n"
        check("private: reachable inside the class, reported outside it", [
            analyze(klass + "const a = A.new()\nconst x = a:g()").errors,
            analyze(klass + "const a = A.new()\nconst x = a.n").errors,
            analyze(klass + "const a = A.new()\nconst x = a:f()").errors,
            analyze(klass + "const x = A.s").errors,
            analyze(klass + "class B extends A {\n    function m(): number { return this.n }\n}").errors,
            analyze("class C {\n    public n = 1\n    private: boolean = false\n}\nconst c = C.new()\nconst x = c.n\nconst y = c.private").errors,
        ], [
            [],
            ["Property 'n' is private and only accessible within class 'A'"],
            ["Property 'f' is private and only accessible within class 'A'"],
            ["Property 's' is private and only accessible within class 'A'"],
            ["Property 'n' is private and only accessible within class 'A'"],
            [],
        ])
    }

    // A name on a line of its own is how code gets written — you type it to
    // ask the editor about it. It parses, it is typed so hover can answer, and
    // the compiler drops it.
    {
        const statements = (code: string): string[] =>
            parse(code).body.statements.map(s => s.type)
        const bare = parse("const value = 1\nvalue")
        const scopes = analyzeScopes(bare)
        const types = analyzeTypes(bare, scopes, {})
        const statement = bare.body.statements[1] as { expression: never }
        check("expression statements: a bare name parses, types, and reports nothing", [
            statements("const value = 1\nvalue"),
            statements("const o = { a: 1 }\no.a"),
            statements("const value = 1\nvalue + 1"),
            statements("declare f: () => nil\nf()"),
            formatType(types.typeOf.get(statement.expression)!),
            [...scopes.diagnostics, ...types.diagnostics].map(d => d.message),
        ], [
            ["VariableDeclaration", "ExpressionStatement"],
            ["VariableDeclaration", "ExpressionStatement"],
            ["VariableDeclaration", "ExpressionStatement"],
            ["DeclareStatement", "CallStatement"],
            "1",
            [],
        ])
    }

    // Two shapes printed side by side leave the reader to spot the difference.
    check("assignability: the message names what is missing or wrong", [
        analyze("type Big = { a: number, b: string }\ndeclare f: (x: Big) => nil\nf({ a: 1 })").errors,
        analyze("type Big = { a: number, b: string }\ndeclare f: (x: Big) => nil\nf({ a: 1, b: 2 })").errors,
    ], [
        ["Argument of type '{ a: number }' is not assignable to parameter of type 'Big', missing b: string"],
        ["Argument of type '{ a: number, b: number }' is not assignable to parameter of type 'Big', 'b' is number, not string"],
    ])

    // Assignment is a statement: an arrow whose body is one assigns, and
    // returns nothing.
    {
        const code = ["let a = 0", "const f = () => a = 1", "const g = () => a += 2"].join("\n")
        check("arrow: an assignment body", [
            analyze(code).errors,
            (parse(code).body.statements[1] as any).init.func.body.statements[0].type,
            (parse(code).body.statements[2] as any).init.func.body.statements[0].type,
        ], [[], "AssignmentStatement", "CompoundAssignmentStatement"])
    }

    // `?.` adds nil only when the object can be nil.
    {
        const { a, b, c, d } = analyze([
            "type BoolValue = { Value: boolean }",
            "declare sure: BoolValue",
            "declare maybe: BoolValue | nil",
            "declare deep: { inner: BoolValue | nil }",
            "const a = sure.Value",
            "const b = sure?.Value",
            "const c = maybe?.Value",
            "const d = deep?.inner?.Value",
        ].join("\n")).bindings
        check("optional chain: nil only from an object that can be nil",
            { a, b, c, d }, { a: "boolean", b: "boolean", c: "boolean | nil", d: "boolean | nil" })
    }
}

for (const failure of failures) console.log(`FAIL ${failure}`)
console.log(`\nproject: ${passed} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
