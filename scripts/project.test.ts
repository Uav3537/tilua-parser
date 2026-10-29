/**
 * Project tests: configs, type libraries, import paths and sourcemaps.
 *
 * Each case runs against an in-memory file system, so it states exactly the
 * files it needs. No real type library is involved.
 */
import { join, resolve, sep } from "node:path"
import {
    findConfig, loadConfig, resolveTypeLibraries, resolveModulePath, importExpressions, sourceMapTypes,
    parse, parseWithRecovery, analyzeScopes, analyzeTypes, moduleExports, formatType, withoutAliasName, applyDirectives,
    type ProjectHost, type ModuleExports, type GenericForStatement,
    luauString, escapeLuauString, isLuauName, isIdentifier, withoutNil, isFunctionType, isInstanceOf, returnsTuple,
    union, difference, literal, unknownType, numberType, nilType,
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

    // A key that is not the config's own may be a library's: it is kept, and
    // `resolveTypeLibraries`, which knows the libraries, reports it if not.
    const typo = loadConfig(join(ROOT, "typo/tilua.config.json"), h)
    check("config: a key that is not the config's own is kept for the libraries",
        [typo.problems, typo.config?.libraryOptions], [[], { typo: true }])
    check("config: and the rest of the config still applies", typo.config?.types, ["luau"])
    check("config: an option no library declares is reported on its line",
        resolveTypeLibraries(typo.config!, h).problems.filter(p => p.message.startsWith("Unknown"))
            .map(p => [p.line, p.message.split(".")[0]]), [[3, "Unknown option 'typo'"]])

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

    check("types: no library is loaded by default", libraries([]).files, [])
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

    // A library adds options to the config: checked against its declaration,
    // with the default where the config sets none, and handed to its lowering.
    const optionFiles: Record<string, string> = {
        ...files,
        "node_modules/@tilua-types/opts/package.json": JSON.stringify({
            name: "@tilua-types/opts",
            dependencies: { "@tilua-types/luau": "^1.0.0" },
            tilua: {
                lowering: "lowering.mjs",
                options: {
                    typed: { type: "boolean", default: true, description: "Types" },
                    mode: { type: "string", values: ["fast", "safe"], default: "fast" },
                    level: { type: "number" },
                    lineMap: { type: "boolean" },
                    broken: { type: "date" },
                },
            },
        }),
        "node_modules/@tilua-types/opts/index.d.tilua": "",
        "node_modules/@tilua-types/opts/lowering.mjs": "export default {}",
    }
    const withOptions = (options: Record<string, unknown>) => {
        const h = host({ ...optionFiles, "tilua.config.json": JSON.stringify({ types: ["opts"], ...options }) })
        const config = loadConfig(join(ROOT, "tilua.config.json"), h).config!
        return resolveTypeLibraries(config, h)
    }
    const defaults = withOptions({})
    check("options: a library's are declared, with their defaults", [
        defaults.options.map(o => [o.name, o.type, o.value, o.from]),
        defaults.lowerings.map(l => l.options),
    ], [
        [["typed", "boolean", true, "@tilua-types/opts"], ["mode", "string", "fast", "@tilua-types/opts"], ["level", "number", undefined, "@tilua-types/opts"]],
        [{ typed: true, mode: "fast", level: undefined }],
    ])
    check("options: a bad declaration is reported, and skipped", defaults.problems.map(p => p.message), [
        "'@tilua-types/opts': the option 'lineMap' is the config's own, and cannot be declared again",
        "'@tilua-types/opts': the option 'broken' needs a 'type': \"boolean\", \"number\" or \"string\"",
    ])
    const set = withOptions({ typed: false, mode: "safe", level: 3 })
    check("options: the config sets them, and the lowering is handed them",
        set.lowerings.map(l => l.options), [{ typed: false, mode: "safe", level: 3 }])
    const wrong = withOptions({ typed: "no", mode: "slow", other: 1 })
    check("options: a wrong value is reported and the default kept; an undeclared key is unknown", [
        wrong.problems.map(p => p.message).slice(2),
        wrong.lowerings.map(l => l.options),
    ], [[
        "'typed' must be true or false (an option of '@tilua-types/opts')",
        "'mode' must be one of: \"fast\", \"safe\" (an option of '@tilua-types/opts')",
        "Unknown option 'other'. Options are: types, paths, baseUrl, sourceMap, output, rootDir, outDir, noLib, treeShaking, lineMap, indent, minify, typed, mode, level",
    ], [{ typed: true, mode: "fast", level: undefined }]])

    // Lua's standard library is built in: its old package loads nothing,
    // whether it is named, matched or depended on — unless `noLib`.
    const withLua = {
        ...files,
        "node_modules/@tilua-types/lua/package.json": JSON.stringify({ name: "@tilua-types/lua" }),
        "node_modules/@tilua-types/lua/index.d.tilua": "declare function print(...args: unknown[]): nil",
        "node_modules/@tilua-types/game/package.json": JSON.stringify({ name: "@tilua-types/game", dependencies: { "@tilua-types/lua": "^5.0.0" } }),
        "node_modules/@tilua-types/game/index.d.tilua": "declare game: unknown",
    }
    const LUA = "node_modules/@tilua-types/lua/index.d.tilua"
    const GAME = "node_modules/@tilua-types/game/index.d.tilua"
    const standard = (options: Record<string, unknown>): { files: (string | undefined)[]; problems: string[] } => {
        const h = host({ ...withLua, "tilua.config.json": JSON.stringify(options) })
        const config = loadConfig(join(ROOT, "tilua.config.json"), h).config!
        const result = resolveTypeLibraries(config, h)
        return { files: result.files.map(rel), problems: result.problems.map(p => p.message) }
    }
    check("types: `lua` is built in, so naming it loads nothing", standard({ types: ["lua"] }), { files: [], problems: [] })
    check("types: nor does depending on it, or matching it", [
        standard({ types: ["game"] }).files, standard({ types: ["@tilua-types/*"] }).files.includes(LUA),
    ], [[GAME], false])
    check("types: with `noLib` it is a library like any other", standard({ types: ["game"], noLib: true }).files, [LUA, GAME])
    check("config: `noLib` is a boolean", (() => {
        const h = host({ "tilua.config.json": JSON.stringify({ noLib: "yes" }) })
        return loadConfig(join(ROOT, "tilua.config.json"), h).problems.map(p => p.message)
    })(), ["'noLib' must be true or false"])

    // And it is there in every file, with no library at all.
    const bare = (code: string, noLib = false) => {
        const program = parse(code)
        const scopes = analyzeScopes(program, { reportUndeclared: true, noLib })
        const types = analyzeTypes(program, scopes, { noLib })
        return [...scopes.diagnostics, ...types.diagnostics].map(d => d.message)
    }
    check("standard library: `print`, `math`, `pcall` are there with nothing loaded", [
        bare("const n: number = math.floor(1.5)\nprint(n)\nconst r = pcall(() => 1)\nconst ok: boolean = r.success"),
        bare("print(1)", true),
    ], [[], ["Cannot find name 'print'"]])
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
    // `game:GetService` names the same service the tree does; a service the
    // tree leaves out is still what the library says.
    const provider = parse([
        "declare class ServiceProvider extends Instance { GetService: <K extends keyof Services>(self: ServiceProvider, className: K) => Services[K] }",
        "declare class Players extends Instance { }",
        "type Services = { ReplicatedStorage: ReplicatedStorage, Workspace: Workspace, Players: Players }",
    ].join("\n"))
    const services = sourceMapTypes(JSON.stringify(tree), join(ROOT, "sourcemap.json"), {
        classes: new Set([...classes, "Services"]),
        membersOf: className => new Set(className === "DataModel" ? ["Name", "ReplicatedStorage", "Workspace"] : ["Name"]),
    }).types!
    const viaService = parse([
        "const remotes: Folder = game:GetService(\"ReplicatedStorage\").Shared.Remotes",
        "const players: Players = game:GetService(\"Players\")",
    ].join("\n"))
    check("sourcemap: `GetService` returns the service as the tree has it",
        analyzeTypes(viaService, analyzeScopes(viaService), { libs: [roblox, provider, services.program] }).diagnostics.map(d => d.message), [])
    // Its `Parent` reads as the folder it is in, and still takes `nil` or any
    // other instance, as the class it extends says.
    const withParent = parse([
        "declare class Instance { Name: string, Parent: Instance | nil }",
        "declare class Folder extends Instance { }",
        "declare class ModuleScript extends Instance { }",
        "declare class Part extends Instance { }",
        "declare class ReplicatedStorage extends Instance { }",
        "declare class Workspace extends Instance { }",
        "declare class DataModel extends Instance { ReplicatedStorage: ReplicatedStorage, Workspace: Workspace }",
    ].join("\n"))
    const moves = parse([
        "const remotes = game.ReplicatedStorage.Shared.Remotes",
        "const shared: Folder = remotes.Parent",
        "remotes.Parent = nil",
        "remotes.Parent = game.Workspace",
        "remotes.Name = 5",
    ].join("\n"))
    check("sourcemap: `Parent` reads as the parent, and takes any instance or `nil`",
        analyzeTypes(moves, analyzeScopes(moves), { libs: [withParent, withServices.program] }).diagnostics.map(d => d.message),
        ["Type '5' is not assignable to 'string'"])
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

    // `import("./m")`: the same value, read where the expression runs.
    const dynamic = analyze(
        `const Shapes = import("./shapes")\nconst area = Shapes.area(2)\nconst d = import("./shapes").default\nfunction late() { return import("./shapes").area }\nimport("./shapes")`,
        { "./shapes": "export type Circle = { r: number }\nexport function area(r: number): number { return r * r }\nexport default 3" })
    check("import(): the module's exports as one value", [dynamic.bindings.area, dynamic.bindings.d, dynamic.errors], ["number", "3", []])
    check("import(): its members are read-only",
        analyze(`const M = import("./m")\nM.value = 2`, { "./m": "export let value = 1" }).errors,
        ["Cannot assign to 'value' because it is a read-only property"])
    check("import(): a module that is not there",
        analyze(`const M = import("./missing")`, {}).errors, ["Cannot find module './missing'"])
    check("import(): the module is named by a string literal",
        analyze(`const name = "./m"\nconst M = import(name)`, { "./m": "export const value = 1" }).errors,
        ["import() takes a string literal: which module it loads is decided when the project is built"])
    check("import(): `import` still starts a statement", analyze(`import { value } from "./m"\nconst v = value`, { "./m": "export const value = 1" }).bindings.v, "1")
    check("import(): every one in a file can be listed",
        importExpressions(parse(`const a = import("./a")\nfunction f() { return [import("./b"), import("./a").x] }`))
            .map(node => (node.source as { value?: string }).value), ["./a", "./b", "./a"])


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
        iterate("for (const [_, card] of pairs(cards)) { apply(card) }").errors, [])
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
        "    for (const [name, remote] of pairs(remotes)) {",
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

    // Code after a `return`, `break` or `continue` is no syntax error, as in
    // JavaScript: it is read, typed, and reported as unreachable.
    {
        const code = [
            "function f(x: number): number {",
            "    if (x > 1) {",
            "        return 1",
            "        print(\"dead\")",
            "    }",
            "    return x",
            "    const later = 2",
            "    print(later)",
            "}",
            "function g() {",
            "    error(\"no\")",
            "    print(\"dead too\")",
            "}",
            "for (i = 1, 3) {",
            "    break",
            "    print(i)",
            "}",
        ].join("\n")
        const program = parse(code)
        const scopes = analyzeScopes(program)
        const types = analyzeTypes(program, scopes)
        check("unreachable: code after an exit parses, and is said to be unreachable", [
            types.diagnostics.map(d => d.message),
            types.unreachable.map(u => [u.from.line.start, u.to.line.end]),
        ], [[], [[4, 4], [7, 8], [12, 12], [16, 16]]])
        const closure = analyzeTypes(...((p) => [p, analyzeScopes(p)] as const)(parse([
            "type Binding = { name: string }",
            "const Bindings: { [string]: Binding } = {}",
            "const obj: { a: Binding | nil } = { a: nil }",
            "function f(Key: string) {",
            "    if (not Bindings[Key]) {",
            "        const later = () => Bindings[Key]",
            "    }",
            "    if (obj.a == nil) {",
            "        const later2 = () => obj.a",
            "    }",
            "}",
        ].join("\n"))))
        check("narrowing: a callback does not keep what a table's entry or field was narrowed to where it is written",
            [...closure.typeOf].filter(([e]) => e.type === "FunctionExpression").map(([, t]) => formatType(t)),
            ["() => Binding", "() => Binding | nil"])
        {
            const typed = (code: string) => {
                const { program, errors } = parseWithRecovery(code)
                const scopes = analyzeScopes(program)
                const types = analyzeTypes(program, scopes)
                const bindings: Record<string, string> = {}
                for (const [id, type] of types.bindingType) { const b = scopes.bindings.get(id)!; if (!b.isBuiltin) bindings[b.name] = formatType(type) }
                return {
                    errors: [...errors, ...scopes.diagnostics, ...types.diagnostics].map(e => e.message.replace(/ \(\d+:\d+\)$/, "")),
                    statements: program.body.statements.map(st => st.type),
                    unreachable: types.unreachable.map(u => u.from.line.start),
                    bindings,
                }
            }
            const r = typed([
                "function parse(s: string): number {",
                "    const n = tonumber(s)",
                "    if (n == nil) { throw `not a number: ${s}` }",
                "    return n",
                "}",
                "try {",
                "    const a = parse(\"1\")",
                "} catch (e) {",
                "    const caught = e",
                "} finally {",
                "    print(\"done\")",
                "}",
                "function f(): number {",
                "    try { return 1 } catch { return 2 }",
                "}",
                "function g(): number {",
                "    try {",
                "        throw \"x\"",
                "        print(\"never\")",
                "    } finally { }",
                "}",
            ].join("\n"))
            check("try: a throw narrows what follows it, a catch is handed unknown, and every way out counts as returning", [
                r.errors, r.statements, r.unreachable, r.bindings.caught,
            ], [[], ["FunctionDeclaration", "TryStatement", "FunctionDeclaration", "FunctionDeclaration"], [19], "unknown"])
            check("try: catch, finally and throw stay names elsewhere", typed([
                "const p = { catch: 1, finally: 2 }",
                "const q = p.catch + p.finally",
                "const throw = 3",
                "const t = throw + 1",
            ].join("\n")).errors, [])
            check("try: what is wrong with one says so", [
                typed("try { print(1) }").errors,
                typed("try { } catch (e: string) { }").errors,
            ], [
                ["A 'try' needs a 'catch' or a 'finally'"],
                ["What a 'catch' is handed may be anything: its type can only be 'unknown' or 'any'"],
            ])
        }
        {
            const typed = (code: string) => {
                const { program, errors } = parseWithRecovery(code)
                const scopes = analyzeScopes(program)
                const types = analyzeTypes(program, scopes)
                const bindings: Record<string, string> = {}
                for (const [id, type] of types.bindingType) { const b = scopes.bindings.get(id)!; if (!b.isBuiltin) bindings[b.name] = formatType(type) }
                return {
                    errors: [...errors, ...scopes.diagnostics, ...types.diagnostics].map(e => e.message.replace(/ \(\d+:\d+\)$/, "")),
                    bindings,
                }
            }
            const nullish = typed("let n: number | nil = nil\nn ??= 5\nconst after = n\nlet s: string = \"x\"\ns ??= \"y\"")
            check("??=: what is assigned where the target is nil, and the target is no longer nil after it",
                [nullish.errors, nullish.bindings.after], [[], "number"])

            const methods = typed([
                "const Counter = {",
                "    count: 0,",
                "    increment(by: number): number {",
                "        this.count += by",
                "        return this:current()",
                "    },",
                "    current(): number { return this.count },",
                "    \"odd key\"() { return 1 },",
                "}",
                "const a = Counter:increment(2)",
                "const b = Counter.current()",
                "interface Greeter { greet(name: string): string }",
                "const g: Greeter = { greet(name) { return \"hi \" + name } }",
            ].join("\n"))
            check("object methods: `this` is the object, they are called with ':', and fit a method of an interface", [
                methods.errors, methods.bindings.a, methods.bindings.name,
            ], [["'current' is a method, and takes 'Counter' first: call it with ':', 'Counter:current(...)'"], "number", "string"])

            const labels = typed([
                "let found: number | nil = nil",
                "outer: while (true) {",
                "    for (i = 1, 3) {",
                "        if (i == 2) { found = i; break outer }",
                "    }",
                "}",
                "const after = found",
                "rows: for (i = 1, 2) {",
                "    for (j = 1, 2) { if (j == 2) continue rows }",
                "}",
            ].join("\n"))
            check("labels: break and continue name a loop around them, and `while (true)` is left by a `break` that names it",
                [labels.errors, labels.bindings.after], [[], "2"])
            check("labels: what is wrong with one says so", [
                typed("for (i = 1, 2) { break nowhere }").errors,
                typed("a: for (i = 1, 2) {\n    a: for (j = 1, 2) { }\n}").errors,
                typed("a: for (i = 1, 2) {\n    const f = () => { for (j = 1, 2) { break a } }\n}").errors,
                typed("const o = { a: 1 }\no:a()").errors.filter(e => e.includes("label")),
            ], [
                ["No loop this 'break' is in is labelled 'nowhere'"],
                ["A loop inside this one is already labelled 'a'"],
                ["No loop this 'break' is in is labelled 'a'"],
                [],
            ])
        }
        {
            // `Exclude<unknown, 1>`: kept where TypeScript's `unknown` forgets,
            // folded back as the branches meet, and a test it already
            // answers is a warning, not an error.
            const code = [
                "function f(a: unknown) {",
                "    if (a ~= 1) {",
                "        const inside = a",
                "        if (a == 2) { print(a) }",
                "        const afterTwo = a",
                "        if (typeof a == \"number\") { const num = a }",
                "        const afterNumber = a",
                "        if (a == 1) { print(a) }",
                "    }",
                "    const outside = a",
                "}",
                "function g(b: 1 | 2 | 3) {",
                "    if (b ~= 1) { if (b == 1) { print(b) } }",
                "}",
            ].join("\n")
            const program = parse(code)
            const scopes = analyzeScopes(program)
            const types = analyzeTypes(program, scopes)
            const typeOf = (name: string): string => {
                for (const [id, type] of types.bindingType) if (scopes.bindings.get(id)!.name === name) return formatType(type)
                return "?"
            }
            check("difference: what a test took out stays out, and comes back together where the branches meet", [
                typeOf("inside"), typeOf("afterTwo"), typeOf("num"), typeOf("afterNumber"), typeOf("outside"),
            ], ["Exclude<unknown, 1>", "Exclude<unknown, 1>", "Exclude<number, 1>", "Exclude<unknown, 1>", "unknown"])
            check("difference: a test the type already answers is a warning",
                types.diagnostics.map(d => [d.node.line.start, d.severity, d.message]), [
                    [8, "warning", "This comparison is always false: 'Exclude<unknown, 1>' and '1' have no value in common"],
                    [13, "warning", "This comparison is always false: '2 | 3' and '1' have no value in common"],
                ])
            {
                const matrix = [
                    "type P = { x: number }",
                    "type Q = { y: string }",
                    "function cases<T, N extends number>(n: number, s: string, b: boolean, u: unknown, a: any, t: T, k: N, p: P, q: Q, f: () => nil, lit: \"a\" | \"b\", opt: number | nil, mix: number | string) {",
                    "    if (n == \"1\") { }",
                    "    if (s == 1) { }",
                    "    if (lit == \"c\") { }",
                    "    if (p == \"x\") { }",
                    "    if (f == 1) { }",
                    "    if (k == \"x\") { }",
                    "    if (b == 1) { }",
                    "    if (mix == true) { }",
                    "    if (n ~= \"1\") { }",
                    "    if (s == \"\") return",
                    "    if (s == \"\") { }",
                    "    const notEmpty = s",
                    "    if (n == 1) { }",
                    "    if (lit == \"a\") { }",
                    "    if (u == 1) { }",
                    "    if (a == \"x\") { }",
                    "    if (t == 1) { }",
                    "    if (k == 1) { }",
                    "    if (p == q) { }",
                    "    if (opt == nil) { }",
                    "    if (n == nil) { }",
                    "    if (mix == 1 or mix == \"x\") { }",
                    "    if (b == true) { }",
                    "}",
                ].join("\n")
                const program = parse(matrix)
                const scopes = analyzeScopes(program)
                const types = analyzeTypes(program, scopes)
                check("comparisons: any two sides that share no value, whatever their types, are a warning",
                    types.diagnostics.map(d => `${d.severity} ${d.node.line.start}`),
                    [4, 5, 6, 7, 8, 9, 10, 11, 12, 14].map(line => `warning ${line}`))
                let notEmpty = ""
                for (const [id, type] of types.bindingType) if (scopes.bindings.get(id)!.name === "notEmpty") notEmpty = formatType(type)
                check("difference: a string tested against a literal stays one that is not it", notEmpty, "Exclude<string, \"\">")
            }
            check("difference: unions put back what was taken out", [
                formatType(union([difference(unknownType, union([literal(1), literal(2)])), literal(2)])),
                formatType(union([difference(unknownType, numberType), difference(numberType, literal(1))])),
                formatType(union([difference(unknownType, union([nilType, literal(false)])), nilType, literal(false)])),
            ], ["Exclude<unknown, 1>", "Exclude<unknown, 1>", "unknown"])
        }
        {
            // Dimmed is only what an exit written as one leaves: a test the
            // types say always passes may still not, and what is after it is
            // often there for exactly that.
            const program = parse([
                "declare Hooks: { [string]: { n: number } }",
                "function a(key: string) {",
                "    if (Hooks[key]) return",
                "    Hooks[key] = { n: 1 }",
                "}",
                "function b(stat: \"TimeMulti\"): boolean {",
                "    if (stat == \"TimeMulti\") { return true }",
                "    return false",
                "}",
                "function c(stat: \"A\" | \"B\"): number {",
                "    if (stat == \"A\") { return 1 } elseif (stat == \"B\") { return 2 }",
                "}",
            ].join("\n"))
            const scopes = analyzeScopes(program)
            const types = analyzeTypes(program, scopes)
            check("unreachable: an `if` the types call exhaustive dims nothing, and still counts as returning",
                [types.unreachable.length, types.diagnostics.map(d => d.message)], [0, []])
        }
        const bare = parse("function f() {\n    return\n    const x = 1\n}")
        const body = (bare.body.statements[0] as any).func.body.statements
        check("unreachable: a bare `return` before a statement returns nothing",
            [body.map((st: any) => st.type), body[0].argument], [["ReturnStatement", "VariableDeclaration"], undefined])
    }

    // Recovery: a syntax error costs as little of the tree as it can.
    const recovered = (code: string) => {
        const { program, errors } = parseWithRecovery(code)
        const scopes = analyzeScopes(program)
        const types = analyzeTypes(program, scopes)
        const bindings: Record<string, string> = {}
        for (const [id, type] of types.bindingType) { const b = scopes.bindings.get(id)!; if (!b.isBuiltin) bindings[b.name] = formatType(type) }
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
            "function",
            "",
            "const a = 1",
            "print(a)",
            "function g(): { n: number } { return { n: 1 } }",
            "const after = g().n",
        ].join("\n"))
        check("recovery: a half-written `function` costs its own line, not what follows it",
            [r.errors, r.statements, r.bindings.a, r.bindings.after],
            [["Expected the rest of 'function' before the end of the line"], ["ErrorStatement", "VariableDeclaration", "CallStatement", "FunctionDeclaration", "VariableDeclaration"], "1", "number"])
    }
    {
        const r = recovered([
            "function g() {",
            "    if (x ==",
            "    foo = 1",
            "    print(foo)",
            "}",
            "const after = 2",
        ].join("\n"))
        check("recovery: a broken statement ends with its line",
            [r.errors, r.statements, r.bindings.after],
            [["Unexpected token in expression", "Expected ')' to close the '(' on line 2"], ["FunctionDeclaration", "VariableDeclaration"], "2"])
    }
    {
        // Each half-written line is followed by the same code, which must
        // come through whole.
        const after = ["function g(): number {", "    return 1", "}", "const after = g()"]
        const cases: [string, string[]][] = [
            ["print(area({ kind: ", ["Unexpected token in expression", "Expected '}))' to close the brackets opened on line 1"]],
            ["const t = [1, ", ["Expected ']' to close the '[' on line 1"]],
            ["const x = a +", ["Expected a value before the end of the line"]],
            ["const x =", ["Expected a value before the end of the line"]],
            ["return x +", ["Expected a value before the end of the line"]],
            ["type T = { a: ", ["Unexpected token in type annotation", "Expected '}' to close the '{' on line 1"]],
            ["class A extends", ["Expected the class it extends before the end of the line"]],
            ["`oops ${", ["Expected identifier or '('", "Unterminated interpolation expression"]],
            ["`oops", ["Expected identifier or '('", "Unterminated interpolated string"]],
        ]
        check("recovery: a half-written line costs that line, not the code below it",
            cases.map(([line]) => {
                const r = recovered([line, ...after].join("\n"))
                return [r.errors.map(e => e.replace(/ \(\d+:\d+\)$/, "")), r.bindings.after, r.statements.slice(-2)]
            }),
            cases.map(([, errors]) => [errors, "number", ["FunctionDeclaration", "VariableDeclaration"]]))
    }
    {
        const r = recovered([
            "type Shape =",
            "    | { kind",
            "    | { kind: \"rect\", w: number }",
            "const s: Shape = { kind: \"rect\", w: 1 }",
        ].join("\n"))
        check("recovery: a broken member of an object type keeps the type and what follows",
            [r.statements, r.bindings.s], [["TypeAliasStatement", "VariableDeclaration"], "Shape"])
    }
    {
        const r = recovered([
            "class A {",
            "    m(a: number): number",
            "        const b = a",
            "        return b",
            "    }",
            "    n(): number { return 2 }",
            "}",
            "const after = 1",
        ].join("\n"))
        check("recovery: a body without its `{` is read by its indentation",
            [r.errors, r.statements, Object.keys(r.bindings)],
            [["Expected '{' to open the body of 'function'"], ["ClassDeclaration", "VariableDeclaration"], ["this", "a", "b", "A", "after"]])
    }
    {
        const r = recovered([
            "function f(",
            "    print(1)",
            "    return 2",
            "}",
            "const after = f()",
        ].join("\n"))
        check("recovery: a parameter list without its `)` ends where the body begins",
            [r.statements, r.bindings.after], [["FunctionDeclaration", "VariableDeclaration"], "2"])
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
            // `part.` has no name, said at the `.`; the stray `}` is its own.
            "Expected a name after '.'",
            "Expected end of file",
            "Unexpected token in type annotation",
            "In '${1 +}': Unexpected token in expression",
            "Unexpected token in expression",
            "Expected ')' to close the '(' on line 8",
            "Unexpected token in expression",
        ], ["a", "b", "part", "n", "c", "s", "d"]])
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
    // answers takes numbers (`+` a string and a string or a number, `#` a
    // string or a table), and `any` passes because nothing is known about it.
    check("operators: the operands are checked where no metamethod answers", [
        analyze("function f(n: number | nil) { return n * 2 }").errors,
        analyze("function f(s: string) { return s * 2 }").errors,
        analyze("function f(a: any) { return a * 2 }").errors,
        analyze("function f(s: string | nil) { return s + \"x\" }").errors,
        analyze("function f(n: number) { return n + \"x\" }").errors,
        analyze("function f(n: number) { return n.length }").errors,
        analyze("function f(a: number, b: string) { return a < b }").errors,
        analyze("function f(a: string, b: string) { return a < b }").errors,
    ], [
        ["Operator '*' cannot be applied to types 'number | nil' and '2'"],
        ["Operator '*' cannot be applied to types 'string' and '2'"],
        [],
        ["'+' joins a string with a string or a number, not 'string | nil': write it in a template string, `${x}`, or call 'tostring(x)'"],
        [],
        ["Property 'length' does not exist on type 'number'"],
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
            ["Argument of type '\"a\"' is not assignable to parameter of type '1'"],
            "1 | 2",
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
        analyze("declare names: string[]\nfor (let name of names) { name = name + \"!\" }\nfor (const other of names) { other = \"x\" }").errors,
        parseWithRecovery("for (const x of f, s, v) { }").errors.map(e => e.message),
        analyze("declare n: number\nfor (const x of n) { }").errors,
    ], [
        ["A loop takes one value each time: take its parts with a destructuring, 'for (const [k, v] of pairs(t))' (1:7)"],
        ["A loop over a source names its value with 'const' or 'let': 'for (const item of source)' (1:1)"],
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
        `} as const satisfies { [string]: readonly string[] }`,
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
        `readonly ["Blocking"] | readonly ["Health"]`,
        `readonly ["Blocking"] | nil`,
        `readonly ["Health"]`,
        "number",
    ])
    check("indexing: a key that certainly is not there is an error, as `.Nope` would be",
        [indexed.errors, indexed.bindings.none], [["Property 'Nope' does not exist on type '{ Blocking, BlockingTick, Health }'"], "any"])

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
        "for (const [key, value] of pairs(headers)) {",
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
            "for (const [part] of gmatch(\"a/b\", \"[^/]+\")) {",
            "    const word = part",
            "}",
            "for (const [name, count] of rows()) {",
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
            "for (const v of list) { print(v) }",
            "for (const v of map) { print(v) }",
            "for (const [k, v] of pairs(map)) { print(k, v) }",
            "for (const [i, n] of ipairs(list)) { print(i, n) }",
            "for (const c of gmatch(\"ab\", \"%a\")) { print(c) }",
            "for (const [i, n] of walk) { print(i, n) }",
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
            "declare function take(v: string | Exclude<unknown, nil | false>): nil",
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
            [`readonly [1] | readonly ["x"]`, `readonly [1] | readonly ["x"] | nil`, "nil", "number | nil"])

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
            "const long = names:filter(function(v) { return v.length > 1 })",
            "const sizes = names:map(function(v) { return v.length })",
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
        check("layered aliases: the file's own replaces them", mine.c, "any")
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
        const types = analyzeTypes(program, scopes, { libs: [lua, luau], noLib: true })
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
        [`"Blocking" | "Health"`, `readonly ["Blocking"] | readonly ["Health"]`, `"KB" | "Knocked"`])

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

        // A class bound on such an alias waits too, instead of settling on
        // `unknown` and leaving the alias it named `unknown` with it.
        const bounded = analyze([
            "type ResourceType = ReturnType<typeof Load>",
            "type SkillMapType = ResourceType[\"SkillMap\"]",
            "class Manager<C extends SkillMapType[number][\"Class\"]> {",
            "    constructor(Class: C) { }",
            "}",
            "function Load() {",
            "    const SkillMap = [{ Class: \"A\" }, { Class: \"B\" }] as const",
            "    return { SkillMap }",
            "}",
            "declare peek: SkillMapType[number][\"Class\"]",
            "const seen = peek",
            "const ok = Manager.new(\"A\")",
            "const bad = Manager.new(\"Z\")",
            "",
            "",
        ].join("\n"))
        check("type queries: a class bound on a `typeof` alias",
            [bounded.bindings.seen, bounded.errors],
            ["\"A\" | \"B\"", ["Argument of type '\"Z\"' is not assignable to parameter of type '\"A\" | \"B\"'"]])
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
        [`readonly ["Sans", "Asgore"]`, `"Sans" | "Asgore"`, [`Type '"Nope"' is not assignable to '"Sans" | "Asgore"'`]])

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
    // A warning is the lint's: `expect-warning` waits for one, `expect-error`
    // does not take one for an error, and `ignore` takes either.
    const severed = (code: string) => {
        const { program, directives } = parseWithRecovery(code)
        const scopes = analyzeScopes(program)
        const all = [...scopes.diagnostics, ...analyzeTypes(program, scopes).diagnostics]
        const { kept, unusedExpectErrors, unusedExpectWarnings } = applyDirectives(directives, all, d => d.node.line.start,
            d => (d as { severity?: string }).severity === "warning")
        return [
            ...kept.map(d => `${d.node.line.start}: ${(d as { severity?: string }).severity ?? "error"}`),
            ...unusedExpectErrors.map(d => `${d.line}: unused error`),
            ...unusedExpectWarnings.map(d => `${d.line}: unused warning`),
        ]
    }
    check("directives: expect-warning covers warnings, expect-error errors, ignore both", severed([
        "declare n: number",
        "--@tilua-expect-warning",
        "const a = n == \"x\"",
        "--@tilua-expect-error",
        "const b = n == \"x\"",
        "--@tilua-expect-warning",
        "const c: number = \"x\"",
        "--@tilua-ignore",
        "const d = n == \"x\"",
        "--@tilua-expect-warning",
        "const e = 1",
    ].join("\n")), ["5: warning", "7: error", "4: unused error", "6: unused warning", "10: unused warning"])
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
    const signatures = analyze([
        "declare function f(x: number, y?: string): boolean",
        "const r: ReturnType<typeof f> = true",
        "const p: Parameters<typeof f> = [1]",
    ].join("\n"))
    check("prelude: ReturnType and Parameters read a function with typed parameters",
        [signatures.errors, signatures.bindings.r, signatures.bindings.p], [[], "boolean", "[x: number, y?: string]"])
    check("prelude: Pick takes only the keys the type has; Omit any", analyze([
        "type User = { id: number, name: string }",
        "declare a: Pick<User, \"id\">",
        "declare b: Pick<User, \"typo\">",
        "declare c: Omit<User, \"typo\">",
    ].join("\n")).errors, [`Type '"typo"' does not satisfy the constraint '"id" | "name"'`])
    const included = analyze([
        "declare names: string[]",
        "declare letters: (\"a\" | \"b\")[]",
        "function check(s: string, u: string | number) {",
        "    if (names:includes(s)) { const isIn = s } else { const notIn = s }",
        "    if (letters:includes(s)) { const isLetter = s } else { const notLetter = s }",
        "    if (not names:includes(u)) { const notU = u }",
        "}",
    ].join("\n"))
    check("prelude: includes narrows when found, and says nothing when not",
        [included.errors, included.bindings.isIn, included.bindings.notIn, included.bindings.isLetter,
            included.bindings.notLetter, included.bindings.notU],
        [[], "string", "string", `"a" | "b"`, "string", "string | number"])
    const implied = analyze([
        "function isSmall(v: unknown): implies v is number { return v == 1 }",
        "declare function isText(v: unknown): v is string",
        "declare function wantsGuard(test: (v: unknown) => v is number): nil",
        "declare xs: (number | string)[]",
        "function f(x: number | string) {",
        "    if (isSmall(x)) { const yes = x } else { const no = x }",
        "}",
        "const nums = xs:filter(isSmall)",
        "const texts = xs:filter(isText)",
        "wantsGuard(isSmall)",
    ].join("\n"))
    check("implies: a one-sided guard narrows only its true branch, and is no two-sided one",
        [implied.bindings.yes, implied.bindings.no, implied.bindings.isSmall, implied.bindings.nums, implied.bindings.texts,
            implied.errors.length],
        ["number", "number | string", "(v: unknown) => implies v is number", "number[]", "string[]", 1])
    const narrowedParams = analyze([
        "function g<T>(v: T): T {",
        "    if (typeof v == \"array\") { const list = v; const size = v.length }",
        "    if (v == nil) { const none = v }",
        "    if (not v) { const falsy = v }",
        "    if (v) { const truthy = v }",
        "    return v",
        "}",
        "function h<T extends number | string[]>(v: T) {",
        "    if (typeof v == \"array\") { const strings = v; const first = v[1]; for (const each of v) { } }",
        "}",
        "function k<T extends string[]>(v: T) { for (const walked of v) { } }",
        "declare u: unknown",
        "if (typeof u == \"array\") { const anyList = u }",
    ].join("\n"))
    check("narrowing: a type parameter narrows to what it is there, never to nothing",
        [narrowedParams.errors, narrowedParams.bindings.list, narrowedParams.bindings.size, narrowedParams.bindings.none, narrowedParams.bindings.falsy,
            narrowedParams.bindings.strings, narrowedParams.bindings.first, narrowedParams.bindings.each, narrowedParams.bindings.walked, narrowedParams.bindings.anyList],
        [[], "T & unknown[]", "number", "T & nil", "(T & nil) | (T & (nil | false))",
            "T & string[]", "string", "string", "string", "unknown[]"])
    // What a schema library such as @tilua-types/zod leans on: a guard read
    // off a generic shape, a rest parameter's constraint, an alias of shapes
    // joined that is named by what fills it, and `{}` adding nothing.
    const library = analyze([
        "type Any = { readonly _output: unknown }",
        "type Schema<T> = { readonly _output: T, is: (self: Any, value: unknown) => implies value is T }",
        "type Output<S> = { [K in keyof S as nil extends S[K][\"_output\"] ? never : K]: S[K][\"_output\"] }",
        "    & { [K in keyof S as nil extends S[K][\"_output\"] ? K : never]?: S[K][\"_output\"] }",
        "type Obj<S> = Schema<Output<S>> & { pick: <K extends keyof S>(self: Any, ...keys: K[]) => Obj<Pick<S, K>> }",
        "declare function object<S extends { [string]: Any }>(shape: S): Obj<S>",
        "declare name: Schema<string>",
        "declare age: Schema<number | nil>",
        "const shape = { name: name, age: age }",
        "const User = object(shape)",
        "declare v: unknown",
        "if (User:is(v)) { const named = v.name }",
        "const picked = User:pick(\"name\")",
        "const typo = User:pick(\"typo\")",
        "const user: Output<{ name: Schema<string>, age: Schema<number | nil> }> = { name: \"a\" }",
    ].join("\n"))
    check("schemas: a guard, a rest parameter's constraint and a shape's name, as a library uses them",
        [library.bindings.named, library.bindings.picked, library.errors],
        ["string", "Obj<{ name: Schema<string> }>",
            [`Argument of type '"typo"' is not assignable to parameter of type '"name" | "age"'`]])
    check("generic display: a generic shape a call fills in is named with what it was filled with", analyze([
        "type Box<T> = { value: T }",
        "declare function box<T>(v: T): Box<T>",
        "const boxed = box(1)",
    ].join("\n")).bindings.boxed, "Box<number>")
    check("constraints: an empty list is a list, as a type argument", analyze([
        "type Signal<T extends unknown[]> = { args: T }",
        "declare a: Signal<[]>",
        "declare b: Signal<string>",
    ].join("\n")).errors, ["Type 'string' does not satisfy the constraint 'unknown[]'"])
    const positions = analyze([
        "const [ok, err] = pcall(() => nil)",
        "declare byNumber: { [number]: string }",
        "const [first] = byNumber",
        "const [x, y] = [1, \"a\"]",
    ].join("\n"))
    check("destructuring: `[ ]` on a table with no positions is an error",
        [positions.errors, positions.bindings.first, positions.bindings.y],
        [["'pcall(...)' is not an array: type '{ data: nil, error: nil, success: true } | { data: nil, error: unknown, success: false }' cannot be destructured with [ ]"],
            "string", "number | string"])
    check("prelude: forEach's callback may answer anything", analyze([
        "const out: number[] = []",
        "const xs = [1, 2]",
        "xs:forEach(x => out:push(x))",
    ].join("\n")).errors, [])
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
        "    for (i = 1, list.length) {",
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
            "readonly [\"KJ\"] | []", "[\"Sans\", \"Asgore\", \"KJ\"] | [\"Sans\", \"Asgore\"]", "[\"Sans\" | \"Asgore\" | \"KJ\", \"Sans\" | \"Asgore\" | \"KJ\", \"Sans\" | \"Asgore\" | \"KJ\"] | [\"Sans\" | \"Asgore\" | \"KJ\", \"Sans\" | \"Asgore\" | \"KJ\"]"])
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
            "\"Sans\"[]", "[{ Img: string, Key: \"Sans\" | \"Asgore\" }, { Img: string, Key: \"Sans\" | \"Asgore\" }]"])
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
        // False must mean exactly what the guard excludes, or it is no guard:
        // here it does, since what is kept is a string that is not "x".
        "const some = maybe:filter(v => v ~= nil and v ~= \"x\")",
        "const long = maybe:filter((v, i) => i > 2)",
        "const guard = (v: string | nil) => v ~= nil",
    ].join("\n"))
    check("filter: a guard narrows what it keeps",
        [guards.bindings.named, guards.bindings.kept, guards.bindings.ids, guards.bindings.some, guards.bindings.long, guards.bindings.guard],
        ["string[]", "string[]", "string[]", "Exclude<string, \"x\">[]", "(string | nil)[]", "(v: string | nil) => v is string"])
    check("filter: guards raise no errors", guards.errors, [])

    // `map` keeps a tuple a tuple; over a list whose elements are a type
    // parameter it is still a list, and over a type parameter that stands for
    // one it is used as one until that is known.
    const generic = analyze([
        "const Map = <T, U>(arr: T[], callback: (item: T) => U): U[] => arr:map(callback)",
        "function each<T>(arr: T[]) { const ones = arr:map(x => 1) }",
        "function listed<L extends unknown[]>(xs: L): number[] {",
        "    const mapped = xs:map(x => 1)",
        "    for (const v of mapped) { const n: number = v }",
        "    return mapped",
        "}",
        "function kept<L extends unknown[]>(xs: L): { -readonly [K in keyof L]: string } { return xs:map(x => \"s\") }",
        "const pair = kept([1, 2] as [number, number])",
    ].join("\n"))
    check("map: over a list of a type parameter, and over a type parameter that is a list",
        [generic.errors, generic.bindings.ones, generic.bindings.pair], [[], "1[]", "[string, string]"])
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
        "for (const x of xs) { const doubled = xs:map(y => { if (y > 1) { continue }\n return y * 2 }) }",
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

    // A rest parameter can depend on the call's own type arguments: once `N`
    // is inferred from the arguments before it, the list is known.
    const dependent = analyze([
        'type Commands = { Name: "attack", Args: [number] } | { Name: "heal", Args: [number, boolean] }',
        'type ArgsOf<N> = Extract<Commands, { Name: N }>["Args"]',
        'declare function run<N extends "attack" | "heal">(name: N, ...args: ArgsOf<N>): nil',
        'run("attack", 1)',
        'run("heal", 1, true)',
        'run("attack", "x")',
        'run("attack")',
        'run("heal", 1, true, 2)',
    ].join("\n"))
    check("rest: a list that depends on a type parameter is read once it is inferred",
        dependent.errors, [
            "Argument of type '\"x\"' is not assignable to parameter of type 'number'",
            "Expected 2 arguments, got 1",
            "Expected 3 arguments, got 4",
        ])

    // A union of tuples is one of those lists: how a trailing argument is
    // made optional.
    const lists = analyze([
        'declare function opt(...args: [number] | [number, string]): nil',
        'opt(1)',
        'opt(1, "a")',
        'opt("a")',
        'opt()',
        'type Opt<N> = N extends "a" ? [number] | [number, boolean] : [string]',
        'declare function pick<N extends "a" | "b">(n: N, ...args: Opt<N>): nil',
        'pick("a", 1)',
        'pick("a", 1, true)',
        'pick("b", "s")',
        'pick("b", 1)',
        'pick("a", 1, 2)',
    ].join("\n"))
    check("rest: a union of tuples takes any one of its lists",
        lists.errors, [
            "Argument of type '\"a\"' is not assignable to parameter of type 'number'",
            "Expected 1-2 arguments, got 0",
            "Argument of type '1' is not assignable to parameter of type 'string'",
            "Argument of type '2' is not assignable to parameter of type 'boolean'",
        ])

    // Inside the body, such a parameter is every list its constraint allows.
    const inside = analyze([
        'type Opt<N> = N extends "a" ? [number] | [number, boolean] : [string]',
        'function impl<N extends "a" | "b">(n: N, ...args: Opt<N>): nil {',
        '    const held = args',
        '}',
    ].join("\n"))
    check("rest: a dependent list is every list it can be, inside the body",
        [inside.errors, inside.bindings.held], [[], "[number] | [number, boolean] | [string]"])

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
        "    for (const [name, n] of pairs({ a: 1 })) {",
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
        `        return "<" + this.name + ">"`,
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
        [[], "<T>(v: T) => T", "1"])

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
        "const length = id.length",
    ].join("\n"))
    check("branded: `as` makes one, and it is still what it was branded from",
        [made.errors, made.bindings.id, made.bindings.length],
        [[], "UserId", "number"])

    // Anything that builds a new value builds an unbranded one, which is the
    // point: the brand says where the value came from.
    check("branded: an operation on one gives back the plain type", analyze([
        BRANDS,
        "declare id: UserId",
        `findUser(id + "x")`,
        `take(id + "x")`,
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

    // An array's length is not known, so it fills a rest parameter and
    // nothing else, as in TypeScript; a tuple fills exactly its own length.
    const fills = analyze([
        DECLARED,
        "declare trio: [number, number, number]",
        "declare pair: [number, number]",
        "const summed = add3(...trio)",
        "const withOne = add3(1, ...pair)",
        `const joined = join("-", ...words)`,
        "const fromArray = add3(...nums)",
        "const afterOne = add3(1, ...nums)",
    ].join("\n"))
    check("spread: an array fills a rest parameter, a tuple fills its own length",
        [fills.errors, fills.bindings.summed, fills.bindings.withOne, fills.bindings.joined],
        [["A spread of 'number[]' may hold any number of values, so it can only fill a rest parameter: spread a tuple of the right length to fill fixed parameters", "A spread of 'number[]' may hold any number of values, so it can only fill a rest parameter: spread a tuple of the right length to fill fixed parameters"], "number", "number", "string"])

    check("spread: and what it holds still has to fit", analyze([
        DECLARED,
        "declare strings: [string, string, string]",
        "add3(...strings)",
        `join("-", ...nums)`,
    ].join("\n")).errors, [
        "Argument of type 'string' is not assignable to parameter of type 'number'",
        "Argument of type 'number' is not assignable to parameter of type 'string'",
    ])

    // How many an array holds is not known, so it may only fill a rest
    // parameter; a tuple's is, and the count is checked.
    check("spread: an array cannot fill fixed parameters, a tuple is counted", analyze([
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
        "A spread of 'number[]' may hold any number of values, so it can only fill a rest parameter: spread a tuple of the right length to fill fixed parameters",
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
        "        return super.speak() + this.breed",
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
        "const size = a.length",
        "const scaled = a(3)",
        "for (const [index, label] of a) {",
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

    // A member that cannot be read costs that member: the class keeps the
    // others, and what follows the class is untouched.
    {
        const recovered = (code: string): unknown[] => {
            const { program, errors } = parseWithRecovery(code)
            const [first, ...rest] = program.body.statements
            const members = first.type === "ClassDeclaration"
                ? first.members.map(m => m.type === "ClassConstructor" ? "constructor" : m.name.name)
                : first.type
            return [members, rest.map(s => s.type), errors.map(e => e.message)]
        }
        check("class: recovery keeps the members around a broken one", [
            recovered("class A {\n    x: number\n    private y\n    m() { return 1 }\n}\nconst after = 1"),
            recovered("class A {\n    x: number\n    y:\n    m() { return 1 }\n}\nconst after = 1"),
            recovered("class A {\n    x: (a: ) => nil\n    m() { return 1 }\n}\nconst after = 1"),
            recovered("class A {\n    x: number\n    +\n    m() { return 1 }\n}\nconst after = 1"),
            recovered("class A {\n    constructor(a: number {\n        this.x = a\n    }\n    m() { return 1 }\n}\nconst after = 1"),
            recovered("class A {\n    k(a: number, { return 1 }\n    m() { return 1 }\n}\nconst after = 1"),
        ], [
            [["x", "y", "m"], ["VariableDeclaration"], ["A class field needs a type ('name: T') or a value ('name = v') (3:13)"]],
            [["x", "y", "m"], ["VariableDeclaration"], ["Expected a type, got 'm' (4:5)"]],
            [["x", "m"], ["VariableDeclaration"], ["Unexpected token in type annotation, got ')' (2:12)"]],
            [["x", "m"], ["VariableDeclaration"], ["Expected a class member: a field, a method, 'constructor', 'get' or 'set', got '+' (3:5)"]],
            [["constructor", "m"], ["VariableDeclaration"], ["Expected ')', got '{' (2:27)"]],
            [["m"], ["VariableDeclaration"], ["Expected identifier, got 'return' (2:20)", "Expected ')' to close the '(' on line 2, got 'm' (3:5)"]],
        ])
    }

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

    // A property the type names is written with what it was declared as; a
    // key it does not name is the table growing, and stays allowed.
    check("assignment: a written property is checked against its declared type", [
        analyze("declare x: number | nil\ndeclare t: { a: number }\nt.a = x").errors,
        analyze("declare t: { a: number }\nt[\"a\"] = \"x\"").errors,
        analyze("declare t: { a?: number }\nt.a = nil").errors,
        analyze("declare t: { s: \"a\" | \"b\" }\nt.s = \"b\"").errors,
        analyze("const t = {}\nt.x = 1").errors,
        analyze([
            "declare function get(): { Remote: number | nil }",
            "class M {",
            "    private Remote: number",
            "    constructor() {",
            "        const { Remote } = get()",
            "        this.Remote = Remote",
            "    }",
            "}",
        ].join("\n")).errors,
    ], [
        ["Type 'number | nil' is not assignable to 'number'"],
        ["Type '\"x\"' is not assignable to 'number'"],
        [], [], [],
        ["Type 'number | nil' is not assignable to 'number'"],
    ])

    // Where `a or b` held, one of them did: what both narrow is the union of
    // the two. Where `a and b` failed, likewise. What only one of them
    // narrows is left as it was.
    {
        const head = [
            "declare v: string | number | boolean | nil",
            "declare flag: boolean",
            "declare function isS(x: unknown): x is string",
            "declare function isN(x: unknown): x is number",
            "",
        ].join("\n")
        const isString = "isS(v)"
        const isNumber = "isN(v)"
        check("narrowing: the branch one of two tests decided", [
            analyze(`${head}if (${isString} or ${isNumber}) { const seen = v }`).bindings.seen,
            analyze(`${head}function f() {\n    if (not (${isString} or ${isNumber})) return\n    const seen = v\n}`).bindings.seen,
            analyze(`${head}function f() {\n    if (not (${isString}) and not (${isNumber})) return\n    const seen = v\n}`).bindings.seen,
            analyze(`${head}if (${isString} or ${isNumber} or v == nil) { const seen = v }`).bindings.seen,
            analyze(`${head}if (${isString} or ${isNumber}) { } else { const seen = v }`).bindings.seen,
            analyze(`${head}if (${isString} or flag) { const seen = v }`).bindings.seen,
            analyze(`${head}if (flag and (${isString} or ${isNumber})) { const seen = v }`).bindings.seen,
        ], [
            "string | number", "string | number", "string | number", "string | number | nil",
            "boolean | nil", "string | number | boolean | nil", "string | number",
        ])
    }

    // `obj.` while its name is still to be typed: `obj` is read as it stands,
    // and the line below is its own statement, not the name.
    {
        const typing = (code: string) => {
            const { program, errors } = parseWithRecovery(code)
            const scopes = analyzeScopes(program, { reportUndeclared: true })
            const types = analyzeTypes(program, scopes, {})
            const read = [...types.typeOf].filter(([node]) => node.type === "Identifier" && (node as { name: string }).name === "part")
            return {
                errors: errors.map(e => e.message),
                statements: program.body.statements.map(s => s.type),
                part: read.map(([, type]) => formatType(type)),
                diagnostics: [...scopes.diagnostics, ...types.diagnostics].map(d => d.message),
            }
        }
        const head = "const part = { Name: \"x\" }\ndeclare function show(v: unknown): nil\n"
        const below = typing(`${head}part.\nshow(part)\n`)
        const inside = typing(`${head}show(part.)\n`)
        const optional = typing(`${head}const n = part?.\nshow(n)\n`)
        const method = typing(`${head}part:\nshow(part)\n`)
        check("recovery: `obj.` keeps `obj`, and leaves the line below alone", [
            [below.errors, below.statements, below.part, below.diagnostics],
            [inside.errors, inside.part, inside.diagnostics],
            [optional.errors, optional.statements, optional.diagnostics],
            [method.errors, method.statements.slice(2), method.part, method.diagnostics],
        ], [
            [["Expected a name after '.' (3:5)"], ["VariableDeclaration", "DeclareStatement", "ExpressionStatement", "CallStatement"],
                ["{ Name: string }", "{ Name: string }"], []],
            [["Expected a name after '.' (3:10)"], ["{ Name: string }"], []],
            [["Expected a name after '.' (3:16)"], ["VariableDeclaration", "DeclareStatement", "VariableDeclaration", "CallStatement"], []],
            [["Expected a name after ':' (3:5)"], ["ExpressionStatement", "CallStatement"], ["{ Name: string }", "{ Name: string }"], []],
        ])
        // A name on a later line is the access's own, as in JavaScript. Only
        // while recovering is the line below read by its indentation: carried
        // on when deeper, a statement of its own when not.
        const names = (code: string): unknown => {
            const { program, errors } = parseWithRecovery(code)
            return [errors.map(e => e.message), program.body.statements.map(s => s.type)]
        }
        const object = "const a = { b: 1, m: () => 1 }\n"
        check("a member's name may be on a later line", [
            (() => { try { parse(`${object}const c = a.\nb`); return "parsed" } catch (e) { return (e as Error).message } })(),
            (() => { try { parse(`${object}const c = a\n    .b`); return "parsed" } catch (e) { return (e as Error).message } })(),
            names(`${object}const c = a.\n    b\n`),
            names(`${object}const c = a:\n    m()\n`),
            names(`${object}const c = a.\nb\n`),
        ], [
            "parsed", "parsed",
            [[], ["VariableDeclaration", "VariableDeclaration"]],
            [[], ["VariableDeclaration", "VariableDeclaration"]],
            [["Expected a name after '.' (2:12)"], ["VariableDeclaration", "VariableDeclaration", "ExpressionStatement"]],
        ])
    }

    // `typeof v` is an operator of the language: Luau's names, with a table
    // told apart as an "array" or an "object". A library names its own values
    // through `TypeofNames`.
    {
        const seen = (code: string, name = "seen"): string => analyze(code).bindings[name]
        const unknown = "declare v: unknown\n"
        check("typeof: what it answers", [
            seen("declare v: number | string[] | nil\nconst seen = typeof v"),
            seen("class A { }\nconst seen = typeof A.new()"),
            seen("const seen = typeof [1]"),
            seen("const seen = typeof { a: 1 }"),
            seen("const seen = typeof (() => 1)"),
            seen(`${unknown}const seen = typeof v`),
        ], [
            "\"number\" | \"array\" | \"nil\"", "\"object\"", "\"array\"", "\"object\"", "\"function\"",
            "\"nil\" | \"boolean\" | \"number\" | \"string\" | \"function\" | \"array\" | \"object\" | \"thread\" | \"buffer\" | \"userdata\"",
        ])
        check("typeof: a test narrows what was tested", [
            seen(`${unknown}if (typeof v == "array") { const seen = v }`),
            seen(`${unknown}if (typeof (v) == "object") { const seen = v }`),
            seen(`${unknown}if (typeof v == "object") { } elseif (typeof v == "array") { const seen = v }`),
            seen(`${unknown}function f() {\n    if (typeof v ~= "string") return\n    const seen = v\n}`),
            seen(`${unknown}if (typeof v == "array" or typeof v == "object") { const seen = v }`),
            seen("declare v: number[] | { a: number } | string\nif (typeof v == \"array\") { const seen = v }"),
            seen("declare v: number[] | { a: number } | string\nif (typeof v == \"object\") { const seen = v }"),
            seen("declare v: number[] | { a: number } | string\nif (typeof v == \"array\") { } elseif (typeof v == \"object\") { } else { const seen = v }"),
        ], [
            "unknown[]", "{ [unknown]: unknown }", "unknown[]", "string", "unknown[] | { [unknown]: unknown }",
            "number[]", "{ a: number }", "string",
        ])
        // There is no `typeof(v)` function. A parenthesised operand stands
        // apart from the operator.
        const syntax = (code: string): string[] => parseWithRecovery(code).errors.map(e => e.message)
        check("typeof: not a function", [
            syntax("const k = typeof(v)"),
            syntax("const k = typeof (v or w)"),
            syntax("const k = typeof v"),
            syntax("const n = 1\nconst k: typeof(n) = 1"),
            syntax("const n = 1\nconst k: typeof n = 1"),
        ], [
            ["'typeof' is an operator, not a function: write 'typeof v' (1:17)"], [], [],
            ["'typeof' is an operator, not a function: write 'typeof v' (2:16)"], [],
        ])
        check("typeof: a name it never answers", [
            analyze(`${unknown}if (typeof v == "table") { }`).errors,
            analyze(`${unknown}if (typeof v == "Table") { }`).errors,
            analyze("declare v: number\nif (typeof v == \"string\") { }").errors,
            analyze("declare v: number\nif (typeof v == \"nil\") { }").errors,
        ], [
            ["'typeof' never answers \"table\": a table is an \"array\" or an \"object\""],
            ["'typeof' never answers \"Table\""],
            ["This comparison is always false: '\"number\"' and '\"string\"' have no value in common"],
            [],
        ])
        const library = [
            "declare class Vector3 { X: number }",
            "declare class Instance { Name: string }",
            "declare class Part extends Instance { }",
            "type TypeofNames = { Vector3: Vector3, Instance: Instance }",
            "declare p: Part",
            "",
        ].join("\n")
        check("typeof: the names a library gives its own values", [
            seen(`${library}const seen = typeof p`),
            seen(`${library}${unknown}if (typeof v == "Vector3") { const seen = v }`),
            seen(`${library}declare w: Part | Vector3 | { a: number }\nif (typeof w == "Instance") { const seen = w }`),
            seen(`${library}declare w: Part | Vector3 | { a: number }\nif (typeof w == "Instance") { } else { const seen = w }`),
        ], ["\"Instance\"", "Vector3", "Part", "Vector3 | { a: number }"])
        const tables = (code: string): string[] => {
            const program = parse(code)
            return [...analyzeTypes(program, analyzeScopes(program), {}).typeofTables.values()]
        }
        check("typeof: a table its type already tells apart", [
            tables("declare v: number[] | nil\nconst k = typeof v"),
            tables("declare v: { a: number } | string\nconst k = typeof v"),
            tables("declare v: number[] | { a: number }\nconst k = typeof v"),
            tables(`${unknown}const k = typeof v`),
        ], [["array"], ["object"], [], []])
    }

    // `const { a } = v` reads `v.a`, and is checked as that read is: `v` may
    // not be `unknown`, nor possibly nil. A nested pattern names its place.
    check("destructuring: the value read from is checked as a member access is", [
        analyze("const [{ Target }] = scriptArgs").errors,
        analyze("const t = scriptArgs[1].Target").errors,
        analyze("declare u: unknown\nconst { a } = u").errors,
        analyze("declare u: unknown\nconst [a] = u").errors,
        analyze("declare u: { p: unknown }\nlet a\n{ p: { a } } = u").errors,
        analyze("function f({ a }: unknown) { }").errors,
        analyze("declare u: { a: number } | nil\nconst { a } = u").errors,
        analyze("declare u: { a: number } | nil\nconst { a } = u").bindings.a,
        analyze("declare u: { p?: { a: number } }\nconst { p: { a } = { a: 1 } } = u").errors,
        analyze("declare u: any\nconst [{ a }] = u").errors,
        analyze("declare u: { a: number }[]\nconst [{ a }] = u").errors,
    ], [
        ["'scriptArgs[1]' is of type 'unknown'"],
        ["'scriptArgs[1]' is of type 'unknown'"],
        ["'u' is of type 'unknown'"],
        ["'u' is of type 'unknown'"],
        ["'u.p' is of type 'unknown'"],
        ["Object is of type 'unknown'"],
        ["'u' is possibly nil. Check it first, or give it a default"],
        "number",
        [], [], [],
    ])

    // A pattern's key is a member read like `v.key`: one the value certainly
    // lacks is reported, in a declaration, a nested pattern or a parameter.
    check("destructuring: a key the value does not have", [
        analyze("declare load: () => { BridgeNet: number }\nconst { ClassMap } = load()").errors,
        analyze("declare u: { p: { a: number } }\nconst { p: { b } } = u").errors,
        analyze("function f({ z }: { a: number }) { return z }").errors,
        analyze("declare u: { a: number }\nlet a = 0\n{ b: a } = u").errors,
        analyze("declare u: { [string]: number }\nconst { anything } = u").errors,
        analyze("declare u: { a?: number }\nconst { a = 1 } = u").errors,
    ], [
        ["Property 'ClassMap' does not exist on type '{ BridgeNet: number }'"],
        ["Property 'b' does not exist on type '{ a: number }'"],
        ["Property 'z' does not exist on type '{ a: number }'"],
        ["Property 'b' does not exist on type '{ a: number }'"],
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

// --- writing Luau, and the lowering helpers ---------------------------------
{
    check("luauString: quotes and the named escapes",
        luauString("a\"b\\c\nd\te\r"), String.raw`"a\"b\\c\nd\te\r"`)
    // Three digits always, so the "2" after it is not read into the escape.
    check("luauString: other control characters as three digits",
        luauString("\u00012\u007f"), String.raw`"\0012\127"`)
    check("luauString: not JSON, which writes \\u0001", luauString("\u0001").includes("\\u"), false)
    check("luauString: non-ASCII is written as it is", luauString("é한"), `"é한"`)
    check("escapeLuauString: the inside, without quotes", escapeLuauString("a\"b"), String.raw`a\"b`)
    check("isLuauName: a keyword is not", [isLuauName("x_1"), isLuauName("local"), isLuauName("1x")], [true, false, false])
    check("isIdentifier: shape only", [isIdentifier("local"), isIdentifier("a-b")], [true, false])

    const program = parse([
        "declare class Instance { Name: string }",
        "declare class Part extends Instance { Size: number }",
        "declare p: Part | nil",
        "declare f: ((x: number) => string) | nil",
        "declare pair: { get: () => [number, string], one: () => number }",
        "const a = p",
        "const b = f",
        "const c = pair",
    ].join("\n"))
    const scopes = analyzeScopes(program)
    const types = analyzeTypes(program, scopes)
    const typeOf = (name: string) => [...types.bindingType.entries()]
        .find(([id]) => scopes.bindings.get(id)!.name === name)?.[1]
    check("withoutNil: the members that are not nil", withoutNil(typeOf("a")).map(formatType), ["Part"])
    check("isFunctionType: through a nil", [isFunctionType(typeOf("b")), isFunctionType(typeOf("a"))], [true, false])
    check("isInstanceOf: the class and what it extends",
        [isInstanceOf(typeOf("a"), "Part"), isInstanceOf(typeOf("a"), "Instance"), isInstanceOf(typeOf("c"), "Instance")],
        [true, true, false])
    check("returnsTuple: a method returning several values",
        [returnsTuple(typeOf("c"), "get"), returnsTuple(typeOf("c"), "one"), returnsTuple(typeOf("c"), "missing")],
        [true, false, false])
}

// --- class methods written as TypeScript writes them ------------------------
{
    const membersOf = (code: string): string[] => {
        const statement = parse(code).body.statements.find(s => s.type === "ClassDeclaration")
        return statement && statement.type === "ClassDeclaration"
            ? statement.members.map(m => [
                m.type.replace("Class", ""),
                "name" in m && m.name ? m.name.name : "",
                ...("accessibility" in m && m.accessibility ? [m.accessibility] : []),
                ...("isStatic" in m && m.isStatic ? ["static"] : []),
                ...("signatures" in m && m.signatures ? [`${m.signatures.length} signatures`] : []),
            ].join(" "))
            : []
    }
    check("method: `name() {}` without `function`", membersOf([
        "class A {",
        "    n = 0",
        "    get2() { return this.n }",
        "    public inc(by: number): number { return this.n + by }",
        "    private static make(): number { return 1 }",
        "    id<T>(x: T): T { return x }",
        "    function old() { return 1 }",
        "}",
    ].join("\n")), [
        "Field n", "Method get2", "Method inc public", "Method make private static", "Method id", "Method old",
    ])
    // A modifier or `get` followed by `(` is the method's own name, and
    // `constructor(` is still the constructor.
    check("method: a soft keyword as its name", membersOf([
        "class A {",
        "    static() { return 1 }",
        "    get() { return 2 }",
        "    get value(): number { return 1 }",
        "    constructor() {}",
        "}",
    ].join("\n")), ["Method static", "Method get", "Accessor value", "Constructor "])
    check("method: overloads without `function`, `;` after a head", membersOf([
        "class A {",
        "    f(x: number): number;",
        "    f(x: string): string;",
        "    f(x: any): any { return x }",
        "    public static g(x: number): number",
        "    public static g(x: string): string",
        "    static g(x: any): any { return x }",
        "}",
    ].join("\n")), ["Method f 2 signatures", "Method g public static 2 signatures"])
    check("method: an abstract one without `function`",
        membersOf("abstract class A {\n    abstract area(): number\n}"), ["Method area"])
    const typed = (code: string, name: string): string | undefined => {
        const program = parse(code)
        const scopes = analyzeScopes(program)
        const types = analyzeTypes(program, scopes)
        for (const [id, type] of types.bindingType) if (scopes.bindings.get(id)!.name === name) return formatType(type)
        return undefined
    }
    check("method: a shorthand method's `this` is typed", typed([
        "class A {",
        "    n = 1",
        "    get2() { return this.n }",
        "}",
        "const v = A.new():get2()",
    ].join("\n"), "v"), "number")
}

// --- type-level programming ------------------------------------------------
// The recursive, tuple- and string-walking types TypeScript programs write,
// each worked out to the type TypeScript gives.
{
    /** What each `type __name = ...` comes to, printed as its structure. */
    const computed = (code: string): { types: Record<string, string>; errors: string[] } => {
        const program = parse(code)
        const scopes = analyzeScopes(program)
        const types = analyzeTypes(program, scopes, {})
        const out: Record<string, string> = {}
        for (const [name, type] of types.aliases) {
            if (name.startsWith("__")) out[name.slice(2)] = formatType(withoutAliasName(type))
        }
        return { types: out, errors: [...scopes.diagnostics, ...types.diagnostics].map(d => d.message) }
    }
    const analyze = (code: string) => {
        const program = parse(code)
        const scopes = analyzeScopes(program)
        const types = analyzeTypes(program, scopes, {})
        const bindings: Record<string, string> = {}
        for (const [id, type] of types.bindingType) bindings[scopes.bindings.get(id)!.name] = formatType(type)
        return { errors: [...scopes.diagnostics, ...types.diagnostics].map(d => d.message), bindings }
    }
    const typeOf = (code: string): string | undefined => {
        const { types, errors } = computed(code)
        return errors.length ? `errors: ${errors.join("; ")}` : types.r
    }

    check("type-level: a tuple's head, tail and length", [
        typeOf("type First<T> = T extends [infer H, ...infer _] ? H : never\ntype __r = First<[1, 2, 3]>"),
        typeOf("type Last<T> = T extends [...infer _, infer L] ? L : never\ntype __r = Last<[1, 2, 3]>"),
        typeOf("type __r = [1, 2, 3][\"length\"]"),
        typeOf("type __r = number[][\"length\"]"),
    ], ["1", "3", "3", "number"])

    check("type-level: spreads lay out where they stand", [
        typeOf("type Concat<A extends unknown[], B extends unknown[]> = [...A, ...B]\ntype __r = Concat<[1, 2], [3]>"),
        typeOf("type __r = [0, ...[1, 2], 3]"),
        typeOf("type __r = [0, ...string[]]"),
        typeOf("type __r = [x: number, y?: string]"),
    ], ["[1, 2, 3]", "[0, 1, 2, 3]", "[0, ...string[]]", "[x: number, y?: string]"])

    check("type-level: a recursive alias recurses", [
        typeOf("type Reverse<T extends unknown[]> = T extends [infer H, ...infer R] ? [...Reverse<R>, H] : []\ntype __r = Reverse<[1, 2, 3]>"),
        typeOf("type Flatten<T> = T extends [infer H, ...infer R] ? (H extends unknown[] ? [...Flatten<H>, ...Flatten<R>] : [H, ...Flatten<R>]) : []\ntype __r = Flatten<[1, [2, [3]], 4]>"),
        typeOf("type Unwrap<T> = T extends { value: infer V } ? Unwrap<V> : T\ntype __r = Unwrap<{ value: { value: number } }>"),
    ], ["[3, 2, 1]", "[1, 2, 3, 4]", "number"])

    check("type-level: counting with tuples", [
        typeOf([
            "type Build<N extends number, Acc extends unknown[] = []> = Acc[\"length\"] extends N ? Acc : Build<N, [...Acc, unknown]>",
            "type Add<A extends number, B extends number> = [...Build<A>, ...Build<B>][\"length\"]",
            "type __r = Add<3, 4>",
        ].join("\n")),
        typeOf([
            "type Build<N extends number, Acc extends unknown[] = []> = Acc[\"length\"] extends N ? Acc : Build<N, [...Acc, 1]>",
            "type Sub<A extends number, B extends number> = Build<A> extends [...Build<B>, ...infer R] ? R[\"length\"] : never",
            "type __r = Sub<10, 3>",
        ].join("\n")),
        typeOf([
            "type Build<N extends number, Acc extends unknown[] = []> = Acc[\"length\"] extends N ? Acc : Build<N, [...Acc, 1]>",
            "type __r = Build<60>[\"length\"]",
        ].join("\n")),
    ], ["7", "7", "60"])

    check("type-level: a recursion that never ends gives up rather than hanging",
        typeOf("type Inf<T> = Inf<[T]>\ntype __r = Inf<1>"), "any")

    check("type-level: template literals take strings apart", [
        typeOf("type Split<S extends string, D extends string> = S extends `${infer A}${D}${infer B}` ? [A, ...Split<B, D>] : [S]\ntype __r = Split<\"a.b.c\", \".\">"),
        typeOf("type TrimLeft<S extends string> = S extends ` ${infer R}` ? TrimLeft<R> : S\ntype __r = TrimLeft<\"   hi\">"),
        typeOf("type StrLen<S extends string, Acc extends unknown[] = []> = S extends `${infer _}${infer R}` ? StrLen<R, [...Acc, 1]> : Acc[\"length\"]\ntype __r = StrLen<\"hello\">"),
        typeOf("type Camel<S extends string> = S extends `${infer H}_${infer T}` ? `${H}${Camel<Capitalize<T>>}` : S\ntype __r = Camel<\"foo_bar_baz\">"),
        typeOf("type ReplaceAll<S extends string, F extends string, T extends string> = F extends \"\" ? S : S extends `${infer A}${F}${infer B}` ? `${A}${T}${ReplaceAll<B, F, T>}` : S\ntype __r = ReplaceAll<\"a-b-c\", \"-\", \"+\">"),
    ], ['["a", "b", "c"]', '"hi"', "5", '"fooBarBaz"', '"a+b+c"'])

    check("type-level: `infer N extends number` reads a number out of a string", [
        typeOf("type Num<T> = T extends `${infer N extends number}` ? N : never\ntype __r = Num<\"42\">"),
        typeOf("type Num<T> = T extends `${infer N extends number}` ? N : never\ntype __r = Num<\"x\">"),
        typeOf("type Str<T> = T extends [infer S extends string, ...unknown[]] ? S : never\ntype __r = Str<[1, 2]>"),
    ], ["42", "never", "never"])

    check("type-level: distribution, and the bracket that stops it", [
        typeOf("type ToArray<T> = T extends unknown ? T[] : never\ntype __r = ToArray<string | number>"),
        typeOf("type ToArray<T> = [T] extends [unknown] ? T[] : never\ntype __r = ToArray<string | number>"),
        typeOf("type IsNever<T> = [T] extends [never] ? true : false\ntype __r = IsNever<never>"),
        typeOf("type IsAny<T> = 0 extends 1 & T ? true : false\ntype __r = [IsAny<any>, IsAny<string>]"),
    ], ["string[] | number[]", "(string | number)[]", "true", "[true, false]"])

    check("type-level: a parameter's place infers an intersection",
        typeOf("type U2I<U> = (U extends unknown ? (k: U) => nil : never) extends (k: infer I) => nil ? I : never\ntype __r = U2I<{ a: number } | { b: string }>"),
        "{ a: number } & { b: string }")

    check("type-level: mapped types rename, filter and recurse", [
        typeOf("type Getters<T> = { [K in keyof T as `get${Capitalize<K & string>}`]: () => T[K] }\ntype __r = Getters<{ name: string, age: number }>"),
        typeOf("type PickByValue<T, V> = { [K in keyof T as T[K] extends V ? K : never]: T[K] }\ntype __r = PickByValue<{ a: number, b: string, c: number }, number>"),
        typeOf("type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }\ntype __r = DeepPartial<{ a: { b: number }, c: string }>"),
        typeOf("type FromEntries<E extends [string, unknown]> = { [P in E as P[1]]: P[2] }\ntype __r = FromEntries<[\"a\", number] | [\"b\", string]>"),
        typeOf("type Boxed<T extends unknown[]> = { [K in keyof T]: { v: T[K] } }\ntype __r = Boxed<[number, string]>"),
    ], [
        "{ getAge: () => number, getName: () => string }",
        "{ a: number, c: number }",
        "{ a?: { b?: number }, c?: string }",
        "{ a: number, b: string }",
        "[{ v: number }, { v: string }]",
    ])

    check("type-level: paths through an object", [
        typeOf("type Paths<T> = T extends object ? { [K in keyof T]: K extends string ? K | `${K}.${Paths<T[K]>}` : never }[keyof T] : never\ntype __r = Paths<{ a: { b: number }, c: string }>"),
        typeOf("type Get<T, P extends string> = P extends `${infer H}.${infer R}` ? (H extends keyof T ? Get<T[H], R> : never) : (P extends keyof T ? T[P] : never)\ntype __r = Get<{ a: { b: { c: number } } }, \"a.b.c\">"),
    ], ['"a" | "a.b" | "c"', "number"])

    check("type-level: `object` is anything that is not a primitive", [
        typeOf("type IsObject<T> = T extends object ? true : false\ntype __r = [IsObject<{}>, IsObject<number[]>, IsObject<() => nil>, IsObject<string>, IsObject<nil>]"),
    ], ["[true, true, true, false, false]"])

    check("type-level: `K & string` keeps the keys that are strings", [
        typeOf("type __r = (\"a\" | \"b\" | 1) & string"),
        typeOf("type __r = \"a\" & number"),
    ], ['"a" | "b"', "never"])

    check("type-level: a variadic rest is laid out once known",
        typeOf("type Fn<A extends unknown[]> = (...args: [...A, string]) => nil\ntype __r = Fn<[number]>"),
        "(number, string) => nil")

    // A computation still waiting on its parameter is shown as what it was
    // written as, not as the machinery it expands to.
    const deferred = analyze([
        "type Reverse<T extends unknown[]> = T extends [infer H, ...infer R] ? [...Reverse<R>, H] : []",
        "declare function reverse<const T extends unknown[]>(xs: T): Reverse<T>",
        "const r = reverse([1, \"a\", true])",
        "const f = reverse",
    ].join("\n"))
    check("type-level: a generic signature reads by the alias's name", [deferred.bindings.r, deferred.bindings.f, deferred.errors], [
        '[true, "a", 1]', "<const T extends unknown[]>(xs: T) => Reverse<T>", [],
    ])

    check("type-level: a tuple literal fits the literal tuple it is annotated with",
        analyze("const r: [\"a\", 1] = [\"a\", 1]").errors, [])
}

// --- variadic tuples, Exclude, and the array methods ------------------------
{
    const analyze = (code: string) => {
        const program = parse(code)
        const scopes = analyzeScopes(program)
        const types = analyzeTypes(program, scopes, {})
        const bindings: Record<string, string> = {}
        for (const [id, type] of types.bindingType) bindings[scopes.bindings.get(id)!.name] = formatType(type)
        return { errors: [...scopes.diagnostics, ...types.diagnostics].map(d => d.message), bindings }
    }
    const result = (code: string): string => {
        const { bindings, errors } = analyze(code)
        return errors.length ? `errors: ${errors.join("; ")}` : bindings.r
    }

    check("variadic: a literal written for `[...T]` is a tuple of what it holds", [
        result("declare function id<T extends unknown[]>(xs: [...T]): T\nconst r = id([1, \"a\", true])"),
        result("declare function tail<T extends unknown[]>(xs: [unknown, ...T]): T\nconst r = tail([1, \"a\", true])"),
        result("declare function last<T extends unknown[], L>(xs: [...T, L]): L\nconst r = last([1, \"a\", true])"),
        result("declare function lit<const T extends unknown[]>(xs: [...T]): T\nconst r = lit([1, \"a\"])"),
        result("declare function id<T extends unknown[]>(xs: [...T]): T\nconst arr: number[] = []\nconst r = id(arr)"),
    ], ["[number, string, boolean]", "[string, boolean]", "boolean", '[1, "a"]', "number[]"])

    check("variadic: the result spreads what was inferred", [
        result("declare function append<T extends unknown[], V>(xs: [...T], v: V): [...T, V]\nconst r = append([1, \"a\"], true)"),
        result("declare function concat<A extends unknown[], B extends unknown[]>(a: [...A], b: [...B]): [...A, ...B]\nconst r = concat([1, 2], [\"x\"])"),
        result("function push<T extends unknown[], V>(xs: [...T], v: V): [...T, V] {\n    return [...xs, v]\n}\nconst r = push([1, \"a\"], true)"),
    ], ["[number, string, boolean]", "[number, number, string]", "[number, string, boolean]"])

    const restVariadic = analyze([
        "declare function f<T extends unknown[]>(...args: [...T, string]): T",
        "const r = f(1, true, \"x\")",
        "const only = f(\"x\")",
        "f(1, 2)",
    ].join("\n"))
    check("variadic: a rest that ends in a fixed place", [restVariadic.bindings.r, restVariadic.bindings.only, restVariadic.errors],
        ["[number, boolean]", "[]", ["Argument of type '2' is not assignable to parameter of type 'string'"]])

    check("variadic: binding a function's first arguments", result([
        "declare function bind<A extends unknown[], B extends unknown[], R>(fn: (...args: [...A, ...B]) => R, ...a: A): (...b: B) => R",
        "declare function add3(a: number, b: string, c: boolean): number",
        "const r = bind(add3, 1)",
    ].join("\n")), "(b: string, c: boolean) => number")

    const forward = analyze([
        "declare function call<A extends unknown[], R>(fn: (...args: A) => R, ...args: A): R",
        "declare function add(a: number, b: number): number",
        "const r = call(add, 1, 2)",
        "call(add, 1, \"x\")",
    ].join("\n"))
    check("variadic: arguments forwarded to a function are checked against it", [forward.bindings.r, forward.errors],
        ["number", [`Argument of type '"x"' is not assignable to parameter of type 'number'`]])

    check("variadic: currying through a recursive alias", result([
        "type Curried<A extends unknown[], R> = A extends [infer H, ...infer T] ? (x: H) => Curried<T, R> : R",
        "declare function curry<A extends unknown[], R>(f: (...args: A) => R): Curried<A, R>",
        "declare function add3(a: number, b: string, c: boolean): number",
        "const r = curry(add3)(1)(\"x\")",
    ].join("\n")), "(x: boolean) => number")

    // `-` is gone from types: `Exclude` is how it is written.
    check("exclude: `-` in a type is an error that says what to write", (() => {
        try {
            parse("type X = number - 1")
            return undefined
        } catch (error) {
            return (error as Error).message.replace(/ \(\d+:\d+\)$/, "")
        }
    })(), "A type has no '-': write 'Exclude<A, B>' for what of 'A' is not a 'B'")
    const exclude = analyze([
        "const u: Exclude<unknown, nil> = 1",
        "declare a: Exclude<any, nil>",
        "const n: number = a",
        "const bad: nil = a",
        "const fromUnion = \"a\" as Exclude<\"a\" | \"b\", \"b\">",
        "const plain = \"a\" as Exclude<string, \"a\">",
        "function f<T>(x: T): NonNullable<T> { return x as NonNullable<T> }",
        "const g = f",
    ].join("\n"))
    check("exclude: kept over unknown, any and a primitive, worked out over a union", [
        exclude.bindings.u, exclude.bindings.a, exclude.bindings.fromUnion, exclude.bindings.plain, exclude.bindings.g, exclude.errors,
    ], [
        "Exclude<unknown, nil>", "Exclude<any, nil>", '"a"', 'Exclude<string, "a">', "<T>(x: T) => Exclude<T, nil>",
        ["Type 'Exclude<any, nil>' is not assignable to 'nil'"],
    ])

    const arrays = analyze([
        "const modes = [\"a\", \"b\"] as const",
        "declare s: string",
        "const found = modes:includes(s)",
        "const at = modes:indexOf(s)",
        "if (modes:includes(s)) { const narrowed = s }",
        "const joined = [1, 2]:concat([\"x\"])",
    ].join("\n"))
    check("arrays: looking for a value takes any value, and finding it narrows", [
        arrays.bindings.found, arrays.bindings.at, arrays.bindings.narrowed, arrays.bindings.joined, arrays.errors,
    ], ["boolean", "number | nil", '"a" | "b"', "(number | string)[]", []])
}

// --- methods called with `.`, `.length`, and `Exclude` over a primitive -----
{
    const analyze = (code: string) => {
        const program = parse(code)
        const scopes = analyzeScopes(program)
        const types = analyzeTypes(program, scopes, {})
        const bindings: Record<string, string> = {}
        for (const [id, type] of types.bindingType) bindings[scopes.bindings.get(id)!.name] = formatType(type)
        return { errors: [...scopes.diagnostics, ...types.diagnostics].map(d => d.message), bindings, types }
    }

    const excluded = analyze([
        "declare a: Exclude<string, \"a\">",
        "if (a == \"a\") { }",
        "if (a == \"b\") { const b = a }",
        "const plain: string = a",
        "const upper = a.upper(a)",
        "declare u: Exclude<string | number, \"a\">",
        "declare flag: Exclude<boolean, true>",
        "const either = u",
        "const notTrue = flag",
    ].join("\n"))
    check("exclude: a string that is not \"a\" is never \"a\"", [
        excluded.bindings.a, excluded.bindings.b, excluded.bindings.upper, excluded.bindings.either, excluded.bindings.notTrue, excluded.errors,
    ], [
        'Exclude<string, "a">', '"b"', "string", 'Exclude<string, "a"> | number', "false",
        [`This comparison is always false: 'Exclude<string, "a">' and '"a"' have no value in common`],
    ])

    // A method is a member like any other, read with `.`: a function whose
    // first parameter is its `self`, handed to it as any argument is.
    const dotted = analyze([
        "const upper = \"a\".upper(\"a\")",
        "const names = [\"ab\", \"c\"]",
        "const long = names.filter(names, n => n.length > 1)",
        "const joined = names.join(names, \", \")",
        "const keys = { x: 1 }.keys({ x: 1 })",
        "const modes = [\"a\", \"b\"] as const",
        "declare s: string",
        "if (modes.includes(modes, s)) { const mode = s }",
        "const join = names.join",
        "const t = { f: (n: number) => n * 2 }",
        "const own = t.f(2)",
    ].join("\n"))
    check("methods: read with `.`, a method takes its `self` first", [
        dotted.bindings.upper, dotted.bindings.long, dotted.bindings.joined, dotted.bindings.keys,
        dotted.bindings.mode, dotted.bindings.join, dotted.bindings.own, dotted.errors,
    ], ["string", "string[]", "string", '["x"]', '"a" | "b"', "(self: readonly string[], separator?: string) => string", "number", []])
    check("methods: each `.` read of a method is recorded, and a table's own function is not",
        dotted.types.methodReads.size, 6)
    check("methods: leaving the `self` out says to call it with a colon",
        analyze("const modes = [\"a\", \"b\"] as const\ndeclare s: string\nconst found = modes.includes(s)").errors,
        ["'includes' is a method, and takes 'modes' first: call it with ':', 'modes:includes(...)'"])

    const lengths = analyze([
        "const text = \"abc\".length",
        "const list = [1, 2, 3].length",
        "const pair: [number, string] = [1, \"a\"]",
        "const two = pair.length",
        "const o = { length: \"own\" }",
        "const own = o.length",
        "function count<S extends string>(s: S): number { return s.length }",
        "const xs = [1]",
        "xs.length = 0",
    ].join("\n"))
    check("length: a string's and a list's, a tuple's known, a table's own its own", [
        lengths.bindings.text, lengths.bindings.list, lengths.bindings.two, lengths.bindings.own, lengths.errors,
    ], ["number", "number", "2", "string", ["Cannot assign to 'length': it is how many there are, and only changes with them"]])
    check("length: `#` is gone", (() => {
        try {
            parse("const n = #\"abc\"")
            return undefined
        } catch (error) {
            return (error as Error).message.replace(/ \(\d+:\d+\)$/, "")
        }
    })(), "tilua has no '#': write 'xs.length' for how many a list holds or a string's length")
}

// --- what `${...}` may hold ------------------------------------------------
{
    const errorsOf = (code: string): string[] => {
        const program = parse(code)
        return analyzeTypes(program, analyzeScopes(program), {}).diagnostics.map(d => d.message)
    }
    const printed = (type: string, as: string): string =>
        `'${type}' cannot be written into a string: it would read '${as}: 0x...'. ` +
        "A template takes a string, a number, a boolean, nil, or a value with '__tostring'"
    check("template: a table, a list, a function or a class instance prints as its address", [
        errorsOf("const t = { a: 1 }\nconst s = `${t}`"),
        errorsOf("const xs = [1]\nconst s = `${xs}`"),
        errorsOf("const f = () => 1\nconst s = `${f}`"),
        errorsOf("class A { }\nconst s = `${A.new()}`"),
    ], [[printed("{ a: number }", "table")], [printed("number[]", "table")], [printed("() => 1", "function")], [printed("A", "table")]])
    check("template: what reads as text, or says how to print itself, is written", [
        errorsOf("declare n: number | nil\nconst s = `${n} ${true} ${\"x\"} ${1}`"),
        errorsOf("class B { function __tostring(): string { return \"b\" } }\nconst s = `${B.new()}`"),
        errorsOf("declare class Part { Name: string }\ndeclare p: Part\nconst s = `${p}`"),
        errorsOf("type Id = string & { __brand: \"id\" }\ndeclare id: Id\nconst s = `${id}`"),
        errorsOf("declare a: any\ndeclare u: unknown\nconst s = `${a}${u}`"),
        errorsOf("function f<T>(x: T) { return `${x}` }"),
    ], [[], [], [], [], [], []])

    const placeholder = (type: string): string =>
        `Type '${type}' cannot stand in a template literal type: a placeholder holds a string, a number, a boolean or nil`
    check("template types: a placeholder holds text, as in TypeScript", [
        errorsOf("type T = `a${{ x: number }}`"),
        errorsOf("type T = `a${number[]}`"),
        errorsOf("type G<T extends object> = `a${T}`"),
        errorsOf("type T = `a${nil}${number}${\"x\" | 1}`"),
        errorsOf("type G<K> = `get${K}`"),
        errorsOf("type M<T> = { [K in keyof T as `get${Capitalize<K & string>}`]: T[K] }"),
    ], [[placeholder("{ x: number }")], [placeholder("number[]")], [placeholder("T")], [], [], []])
}

// TypeScript's checks that tilua held back on, and the syntax it lacked.
{
    const errorsOf = (code: string): string[] => {
        const result = parseWithRecovery(code)
        const syntax = result.errors.map(e => e.message.replace(/ \(\d+:\d+\)$/, ""))
        const scopes = analyzeScopes(result.program)
        return [...syntax, ...scopes.diagnostics.map(d => d.message), ...analyzeTypes(result.program, scopes, {}).diagnostics.map(d => d.message)]
    }

    check("soundness: a parameter takes what its callers pass, not less", [
        errorsOf("type A = { a: number }\ntype AB = { a: number, b: string }\nfunction take(f: (x: A) => nil) {}\ntake((x: AB) => nil)"),
        errorsOf("const f: (x: number | string) => nil = (x: number) => nil"),
        errorsOf("const f: (x: number) => nil = (x: number | string) => nil"),
        errorsOf("const f: (x: number) => nil = (x: number, y: string) => nil"),
        errorsOf("const f: (x: number, y: string) => nil = (x: number) => nil"),
    ], [
        ["Argument of type '(x: AB) => nil' is not assignable to parameter of type '(x: A) => nil'"],
        ["Type '(x: number) => nil' is not assignable to '(x: number | string) => nil'"],
        [],
        ["Type '(x: number, y: string) => nil' is not assignable to '(x: number) => nil'"],
        [],
    ])
    check("soundness: a method compares both ways, as TypeScript's do", [
        errorsOf("class A { constructor() {} function eat(food: string | number): nil { return nil } }\nclass B extends A { constructor() { super() } override function eat(food: string): nil { return nil } }"),
    ], [[]])
    check("soundness: a let holds what it was first given", [
        errorsOf("let n = 1\nn = \"a\""),
        errorsOf("let n = 1\nn = 2"),
        errorsOf("let x\nx = 1\nx = \"a\""),
        errorsOf("let x = nil\nx = 1"),
    ], [["Type 'string' is not assignable to 'number'"], [], [], []])
    {
        // `+` joins strings, as in TypeScript, and `..` is gone.
        const joins = (code: string) => {
            const { program, errors } = parseWithRecovery(code)
            const scopes = analyzeScopes(program)
            const types = analyzeTypes(program, scopes)
            const bindings: Record<string, string> = {}
            for (const [id, type] of types.bindingType) { const b = scopes.bindings.get(id)!; if (!b.isBuiltin) bindings[b.name] = formatType(type) }
            return { errors: [...errors.map(e => e.message), ...types.diagnostics.map(d => d.message)], bindings, joins: [...types.joins.values()] }
        }
        const typed = joins([
            "function f(n: number, s: string, a: any, e: string | number) {",
            "    const both = \"a\" + \"b\"",
            "    const left = s + n",
            "    const right = n + s",
            "    const sum = n + n",
            "    const loose = a + 1",
            "    const either = e + 1",
            "    const first = 1 + 2 + \"a\"",
            "}",
        ].join("\n"))
        check("+: a string on either side joins, two numbers add, and what only the values can say is asked of them", [
            typed.errors, typed.bindings.both, typed.bindings.left, typed.bindings.right, typed.bindings.sum,
            typed.bindings.loose, typed.bindings.either, typed.bindings.first, typed.joins,
        ], [[], "string", "string", "string", "number", "any", "string | number", "string",
            ["concat", "concat", "concat", "dynamic", "dynamic", "concat"]])
        check("+: '..' is not tilua's, and reads as the '+' it meant", [
            joins("const s = \"a\" .. \"b\"\nlet t = \"\"\nt ..= s\nconst xs = [1, 2]\nconst ys = [...xs]").errors,
            joins("const s = \"a\" .. \"b\"").bindings.s,
        ], [["tilua writes '+', not '..' (1:15)", "tilua writes '+=', not '..=' (3:3)"], "string"])
    }
    check("soundness: a compound assignment is the operator and the assignment", [
        errorsOf("let s = \"a\"\ns += 1"),
        errorsOf("let n = 1\nn += \"a\""),
        errorsOf("let n = 1\nn += 1\nn -= 2\nn *= 3"),
        errorsOf("let b = true\nb += \"a\""),
    ], [[], ["Type 'string' is not assignable to 'number'"], [], ["'+' joins a string with a string or a number, not 'boolean': write it in a template string, `${x}`, or call 'tostring(x)'"]])
    check("soundness: every way through a function that returns a value returns one", [
        errorsOf("function f(x: \"a\" | \"b\" | \"c\"): number {\n    if (x == \"a\") return 1\n    elseif (x == \"b\") return 2\n}"),
        errorsOf("function f(x: \"a\" | \"b\"): number {\n    if (x == \"a\") return 1\n    elseif (x == \"b\") return 2\n}"),
        errorsOf("function f(): number {\n    while (true) { return 1 }\n}"),
        errorsOf("function f(x: number): number {\n    if (x > 0) return 1\n    error(\"no\")\n}"),
        errorsOf("function f(x: number): number | nil {\n    if (x > 0) return 1\n}"),
    ], [["Not every path returns a value: the function returns 'number', which does not include 'nil'"], [], [], [], []])
    check("soundness: an if chain that leaves no value is exhaustive", [
        errorsOf("function f(x: \"a\" | \"b\"): number {\n    if (x == \"a\") return 1\n    elseif (x == \"b\") return 2\n    const n: never = x\n    return n\n}"),
    ], [[]])
    check("soundness: a name is read only once it has a value", [
        errorsOf("let x: number\nprint(x)"),
        errorsOf("function f(c: boolean) {\n    let x: number\n    if (c) { x = 1 }\n    print(x)\n}"),
        errorsOf("function f(c: boolean) {\n    let x: number\n    if (c) { x = 1 } else { x = 2 }\n    print(x)\n}"),
        errorsOf("let x: number\nconst read = () => x\nx = 1"),
        errorsOf("let x: number | nil\nprint(x)"),
    ], [["Variable 'x' is used before being assigned"], ["Variable 'x' is used before being assigned"], [], [], []])
    check("soundness: nothing is a never, so nothing can be called", [
        errorsOf("declare n: never\nn()"),
    ], [["This expression is not callable: 'n' is of type 'never'"]])

    check("??: nil gives way, false stays", [
        errorsOf("const a: boolean | nil = nil\nconst b: boolean = a ?? true"),
        errorsOf("const a: number | nil = nil\nconst b: string = a ?? 1"),
        errorsOf("const a: number | nil = nil\nconst b = a ?? 1 or 2"),
        errorsOf("const a: number | nil = nil\nconst b = (a ?? 1) or 2"),
    ], [[], ["Type 'number' is not assignable to 'string'"], ["'??' cannot be mixed with 'and' or 'or' without parentheses"], []])
    check("n++ and n-- are n += 1 and n -= 1", [
        errorsOf("let n = 0\nn++\nn--\nconst t = { k: 1 }\nt.k++\nconst xs = [1]\nxs[1]--"),
        errorsOf("let s = \"a\"\ns++"),
        errorsOf("const n = 0\nn++"),
        errorsOf("let n = 0\nn-- a comment, not a decrement"),
        errorsOf("let n = 0\n++n"),
    ], [[], ["Operator '+' cannot be applied to types 'string' and '1'"], ["Cannot assign to 'n' — it is a const"], [], ["tilua writes an increment after its target: 'n++'"]])
    check("in: asks a table for a key, and narrows by it", [
        errorsOf("type A = { kind: \"a\", a: number }\ntype B = { b: string }\nfunction f(x: A | B) {\n    if (\"a\" in x) { const n: number = x.a } else { const s: string = x.b }\n}"),
        errorsOf("const n = 1\nconst r = \"a\" in n"),
        errorsOf("const t = { a: 1 }\nconst r = {} in t"),
    ], [[], ["The right side of 'in' must be a table, not '1'"], ["The left side of 'in' must be a string or a number, not '{}'"]])
    check("instanceof: narrows to the class, and takes only a class written in tilua", [
        errorsOf("class A { constructor() {} }\nclass D extends A { constructor() { super() } bark = 1 }\nclass C { constructor() {} meow = 1 }\nfunction f(x: D | C | string) {\n    if (x instanceof D) { const d: D = x } elseif (x instanceof C) { const c: C = x } else { const s: string = x }\n}"),
        errorsOf("const r = 1 instanceof 2"),
        errorsOf("declare class Part { Name: string }\ndeclare Part: { Name: string }\ndeclare p: unknown\nconst r = p instanceof Part"),
    ], [[], ["The right side of 'instanceof' must be a class written in tilua, not '2'"], ["The right side of 'instanceof' must be a class written in tilua, not '{ Name: string }'"]])

    check("interface: extends, merges, and checks what it extends", [
        errorsOf("interface A { x: number }\ninterface B extends A { y: string }\nconst b: B = { x: 1, y: \"a\" }"),
        errorsOf("interface A { x: number }\ninterface A { y: string }\nconst a: A = { x: 1, y: \"a\" }\nconst n: number = a.y"),
        errorsOf("interface A { x: number }\ninterface B extends A { x: string }"),
        errorsOf("interface P {\n    x: number\n    y: number\n    label?: string\n}\nconst p: P = { x: 1, y: 2 }"),
        errorsOf("export interface E<T> { value: T }\nconst e: E<number> = { value: 1 }"),
    ], [[], ["Type 'string' is not assignable to 'number'"], ["Interface 'B' incorrectly extends 'A': its 'x' is 'string', not 'number'"], [], []])
    check("object types: methods, calls, constructors and accessors", [
        errorsOf("interface G { greet(name: string): string }\ndeclare g: G\nconst r: string = g:greet(\"a\")\nconst n: number = g:greet(\"a\")"),
        errorsOf("interface Named { name: string; greet(): string }\nclass P implements Named {\n    name = \"a\"\n    constructor() {}\n    function greet(): string { return this.name }\n}"),
        errorsOf("type F = { (x: number): string, tag: string }\ndeclare f: F\nconst s: string = f(1)\nconst t: string = f.tag"),
        errorsOf("type O = { (x: number): number; (x: string): string }\ndeclare o: O\nconst a: string = o(\"x\")\nconst b: number = o(1)"),
        errorsOf("type T = { get x(): number; set y(v: string); get z(): boolean; set z(v: boolean) }\ndeclare t: T\nconst n: number = t.x\nt.y = \"a\"\nt.z = true\nt.x = 2"),
        errorsOf("class Dog { constructor(n: string) {} }\ntype Ctor<T> = new (name: string) => T\nconst make: Ctor<Dog> = Dog\nconst d: Dog = make.new(\"x\")"),
    ], [["Type 'string' is not assignable to 'number'"], [], [], [], ["Cannot assign to 'x' because it is a read-only property"], []])
    check("this: the value a member is read from", [
        errorsOf("class A {\n    constructor() {}\n    function me(): this { return this }\n}\nclass B extends A {\n    constructor() { super() }\n    function b(): number { return 1 }\n}\nconst n: number = B.new():me():b()"),
        errorsOf("interface Chain { add(n: number): this; value: number }\ndeclare c: Chain\nconst v: number = c:add(1):add(2).value"),
    ], [[], []])
    check("utility types: InstanceType, ConstructorParameters and NoInfer", [
        errorsOf("class Dog { constructor(n: string, age: number) {} }\nconst i: InstanceType<typeof Dog> = Dog.new(\"a\", 1)\nconst p: ConstructorParameters<typeof Dog> = [\"a\", 1]\nconst q: ConstructorParameters<typeof Dog> = [1, 1]"),
        errorsOf("function pick<T>(a: T, b: NoInfer<T>): T { return a }\nconst v = pick(1, \"x\")"),
    ], [["Type '[number, number]' is not assignable to '[n: string, age: number]'"], ["Argument of type '\"x\"' is not assignable to parameter of type '1'"]])
    check("variance: in and out say how a type compares, and are checked", [
        errorsOf("type Getter<out T> = { get: () => T }\ntype Setter<in T> = { set: (v: T) => nil }\ntype Both<in out T> = { get: () => T, set: (v: T) => nil }"),
        errorsOf("type Getter<in T> = { get: () => T }"),
        errorsOf("type Setter<out T> = { set: (v: T) => nil }"),
        errorsOf("function f<out T>(x: T) {}"),
    ], [
        [],
        ["'T' is marked 'in', but 'Getter' gives it out: a 'Getter' of something wider does not fit one of something narrower"],
        ["'T' is marked 'out', but 'Setter' takes it in: a 'Setter' of something narrower does not fit one of something wider"],
        ["'in' and 'out' can only be written on the type parameters of a type alias or an interface"],
    ])
    check("export type: types only", [
        errorsOf("type A = number\nexport type { A }"),
        errorsOf("const a = 1\nexport type { a }"),
    ], [[], ["'a' is not a type: 'export type' exports types"]])
    check("object literals: get and set", [
        errorsOf("const o = {\n    first: \"a\",\n    get full(): string { return this.first + \"!\" },\n    set name(v: string) { this.first = v },\n}\nconst f: string = o.full\no.name = \"x\"\no.full = \"no\""),
        errorsOf("const o = { get x(a: number) { return 1 } }"),
    ], [["Cannot assign to 'full' because it is a read-only property"], ["A 'get' accessor takes no parameters"]])
    check("what TypeScript has and tilua does not says what to write", [
        errorsOf("enum Color { Red, Green }"),
        errorsOf("namespace N { const x = 1 }"),
        errorsOf("const x = 1\nswitch (x) { }"),
        errorsOf("declare module \"m\" { }"),
        errorsOf("declare global { }"),
        errorsOf("const n = 10n"),
    ], [
        ["tilua has no 'enum': write a union of literals, 'type Color = \"Red\" | \"Green\"', or an object 'as const'"],
        ["tilua has no 'namespace': a module is a file, 'import * as N from \"./n\"'"],
        ["tilua has no 'switch': write an 'if' / 'elseif' chain — one that leaves no value for an 'else' is exhaustive"],
        ["tilua has no 'declare module': a module is a file — point an import at a .d.tilua file with 'paths'"],
        ["tilua has no 'declare global': a 'declare' at the top level of a definitions file is already global"],
        ["'10n' is not a number"],
    ])
}

// Member access: what is there, what is not, and what `:` and `.` hand over.
{
    const errorsOf = (code: string): string[] => {
        const program = parse(code)
        const scopes = analyzeScopes(program)
        return [...scopes.diagnostics, ...analyzeTypes(program, scopes, {}).diagnostics].map(d => d.message)
    }
    check("members: a name nothing has is reported, wherever it is read from", [
        errorsOf("declare i: { a: number } & { b: string }\nconst x = i.a\nconst y = i.c"),
        errorsOf("function f<T extends { x: number }>(t: T): number { return t.y }"),
        errorsOf("declare f: (x: number) => string\nconst n = f.name"),
        errorsOf("declare r: { [number]: string }\nconst a = r[1]\nconst b = r.b"),
        errorsOf("declare n: never\nconst x = n.x"),
    ], [
        ["Property 'c' does not exist on type '{ a: number } & { b: string }'"],
        ["Property 'y' does not exist on type 'T'"],
        ["Property 'name' does not exist on type '(x: number) => string'"],
        ["Property 'b' does not exist on type '{ [number]: string }'"],
        ["Property 'x' does not exist on type 'never'"],
    ])
    check("members: what is not there reads as any, and is reported once", [
        errorsOf("const o = { a: 1 }\nconst n = o.nope + 1"),
    ], [["Property 'nope' does not exist on type '{ a: number }'"]])
    check("members: a tuple has the positions it says", [
        errorsOf("declare t: [number, string]\nconst a = t[1]\nconst c = t[3]"),
    ], [["Tuple type '[number, string]' of length '2' has no element at index '3'"]])
    check("members: super reaches the base class's methods, not its fields", [
        errorsOf("class A { x = 1 constructor() {} function m(): number { return 1 } }\nclass B extends A {\n    constructor() { super() }\n    function n(): number { return super.m() + super.x }\n}"),
    ], [["Only methods of the base class can be reached through 'super': 'x' is not one — read it as 'this.x'"]])
    check("members: ':' hands the receiver over, and '.' does not", [
        errorsOf("const o = { f: (x: number) => x + 1 }\nconst r = o:f(1)"),
        errorsOf("const o = { f: () => 1 }\nconst r = o:f()"),
        errorsOf("const S = { items: [1] }\nfunction S:push(v: number) { self.items:push(v) }\nS.push(S, 1)\nS:push(2)"),
    ], [["'f' does not take its receiver: ':' would pass 'o' as its first argument. Call it with '.', 'o.f(...)'"], [], []])
    check("members: a read-only property is the one mistake in writing it", [
        errorsOf("const C = { Red: \"red\" } as const\nC.Red = \"x\""),
    ], [["Cannot assign to 'Red' because it is a read-only property"]])
    check("members: a generic shape is shown by its name", [
        (() => {
            const program = parse("type Signal<T> = { Connect: (self: Signal<T>, f: (v: T) => nil) => nil }\ndeclare s: Signal<number>\nconst t = s")
            const scopes = analyzeScopes(program)
            const types = analyzeTypes(program, scopes, {})
            const id = [...scopes.bindings.values()].find(b => b.name === "t")!.id
            return formatType(types.bindingType.get(id)!)
        })(),
    ], ["Signal<number>"])
}

// Spreads: what each one copies, and what it cannot.
{
    const typeOfConst = (code: string, name: string): string => {
        const program = parse(code)
        const scopes = analyzeScopes(program)
        const types = analyzeTypes(program, scopes, {})
        const id = [...scopes.bindings.values()].find(b => b.name === name)!.id
        return formatType(types.bindingType.get(id)!)
    }
    const errorsOf = (code: string): string[] => {
        const program = parse(code)
        const scopes = analyzeScopes(program)
        return [...scopes.diagnostics, ...analyzeTypes(program, scopes, {}).diagnostics].map(d => d.message)
    }
    check("object spread: unions, nil, intersections, parameters and classes", [
        typeOfConst("declare a: { x?: number, y: string }\nconst c = { x: \"s\", ...a }", "c"),
        typeOfConst("declare a: { kind: \"a\", x: number } | { kind: \"b\", y: string }\nconst b = { ...a, extra: 1 }", "b"),
        typeOfConst("declare a: { x: number } | nil\nconst b = { ...a }", "b"),
        typeOfConst("declare a: { x: number } & { y: string }\nconst b = { ...a }", "b"),
        typeOfConst("function merge<A, B>(a: A, b: B) { return { ...a, ...b } }\nconst m = merge({ x: 1 }, { y: \"s\" })", "m"),
        typeOfConst("class C { f = 1 constructor() {} function m(): number { return 1 } }\nconst o = { ...C.new() }", "o"),
        typeOfConst("const a = { x: 1 } as const\nconst b = { ...a }", "b"),
    ], [
        "{ x: string | number, y: string }",
        "{ extra: number, kind: \"a\", x: number } | { extra: number, kind: \"b\", y: string }",
        "{ x?: number }",
        "{ x: number, y: string }",
        "{ x: number } & { y: string }",
        "{ f: number }",
        "{ x: 1 }",
    ])
    check("spread: a list that may be nil cannot be spread", [
        errorsOf("declare xs: number[] | nil\nconst a = [...xs]"),
        errorsOf("declare xs: number[] | nil\nfunction g(...n: number[]): number { return n.length }\nconst r = g(...xs)"),
        errorsOf("declare xs: number[] | nil\nconst a = [...(xs ?? [])]"),
    ], [
        ["'xs' is possibly nil, and nil cannot be spread: check it first, or spread 'xs ?? []'"],
        ["'xs' is possibly nil, and nil cannot be spread: check it first, or spread 'xs ?? []'"],
        [],
    ])
    check("spread: a tuple fills a variadic parameter place by place", [
        typeOfConst("function wrap<A extends unknown[]>(...args: A): A { return args }\nconst t: [number, string] = [1, \"x\"]\nconst w = wrap(...t)", "w"),
    ], ["[number, string]"])
    check("rest: what a tuple leaves is a tuple", [
        typeOfConst("const [x, ...more] = [1, \"a\", true] as const", "more"),
        typeOfConst("declare t: [string, ...number[]]\nconst [s, ...ns] = t", "ns"),
    ], ["[\"a\", true]", "number[]"])
}

// A spread of unknown length fills a rest parameter; a tuple fills its length.
{
    const errorsOf = (code: string): string[] => {
        const program = parse(code)
        const scopes = analyzeScopes(program)
        return [...scopes.diagnostics, ...analyzeTypes(program, scopes, {}).diagnostics].map(d => d.message)
    }
    const unknownLength = (t: string): string =>
        `A spread of '${t}' may hold any number of values, so it can only fill a rest parameter: spread a tuple of the right length to fill fixed parameters`
    check("spread arguments: where an array may go", [
        errorsOf("function g(...xs: number[]): number { return xs.length }\ndeclare ys: number[]\nconst a = g(...ys)\nconst b = g(1, ...ys, 2)"),
        errorsOf("function h(a: number, ...xs: number[]): number { return a }\ndeclare ys: number[]\nconst r = h(1, ...ys)"),
        errorsOf("function h(a: number, ...xs: number[]): number { return a }\ndeclare ys: number[]\nconst r = h(...ys)"),
        errorsOf("function wrap<A extends unknown[]>(...args: A): A { return args }\ndeclare ys: number[]\nconst r = wrap(...ys)"),
        errorsOf("function k(...args: [number, string]): string { return args[2] }\ndeclare ys: (number | string)[]\nconst r = k(...ys)"),
        errorsOf("class P { constructor(x: number, y: number) {} }\ndeclare ys: number[]\nconst p = P.new(...ys)\nconst q = P.new(...([1, 2] as [number, number]))"),
        errorsOf("declare xs: number[]\ndeclare ys: number[]\nconst n = xs:push(...ys)\nconst i = xs:indexOf(...ys)"),
        errorsOf("function f(a: number, b: number): number { return a }\ndeclare t: [number, ...number[]]\nconst r = f(...t)"),
    ], [
        [],
        [],
        [unknownLength("number[]")],
        [],
        [unknownLength("(number | string)[]")],
        [unknownLength("number[]")],
        [unknownLength("number[]")],
        [unknownLength("[number, ...number[]]")],
    ])
    check("spread arguments: tuples are counted, several of them too", [
        errorsOf("function f(a: number, b: string, c: boolean): boolean { return c }\nconst p: [number] = [1]\nconst q: [string, boolean] = [\"a\", true]\nconst r = f(...p, ...q)\nconst s = f(...p, ...p)"),
    ], [["Expected 3 arguments, got 2"]])
}

// Spreads of lists that generics and conditional types decide.
{
    const errorsOf = (code: string): string[] => {
        const program = parse(code)
        const scopes = analyzeScopes(program)
        return [...scopes.diagnostics, ...analyzeTypes(program, scopes, {}).diagnostics].map(d => d.message)
    }
    const ARGS = "type Args<K> = K extends \"move\" ? [x: number, y: number] : K extends \"say\" ? [text: string] : []\n"
        + "function emit<K extends \"move\" | \"say\" | \"stop\">(kind: K, ...args: Args<K>): nil { return nil }\n"
    check("generic spreads: a conditional rest takes the tuple its branch is", [
        errorsOf(ARGS + "emit(\"move\", 1, 2)\nemit(\"say\", \"hi\")\nemit(\"stop\")"),
        errorsOf(ARGS + "const m: Args<\"move\"> = [1, 2]\nemit(\"move\", ...m)\nconst s: Args<\"say\"> = [\"hi\"]\nemit(\"say\", ...s)"),
        errorsOf(ARGS + "const s: Args<\"say\"> = [\"hi\"]\nemit(\"move\", ...s)"),
        errorsOf(ARGS + "function relay<K extends \"move\" | \"say\" | \"stop\">(kind: K, ...args: Args<K>): nil {\n    return emit(kind, ...args)\n}"),
    ], [[], [], ["Expected 3 arguments, got 2"], []])
    check("generic spreads: a parameter's list, through its constraint", [
        errorsOf("function f<T extends [number, string]>(t: T): nil {\n    function g(a: number, b: string): nil { return nil }\n    return g(...t)\n}"),
        errorsOf("function f<B extends boolean>(flag: B, t: B extends true ? [number] : [string]): nil {\n    function g(x: number | string): nil { return nil }\n    return g(...t)\n}"),
        errorsOf("function f<B extends boolean>(flag: B, t: B extends true ? [number] : [string]): nil {\n    function g(x: number): nil { return nil }\n    return g(...t)\n}"),
    ], [[], [], ["Argument of type 'number | string' is not assignable to parameter of type 'number'"]])
    check("generic spreads: forwarding a function's arguments", [
        errorsOf("function call<F extends (...a: any[]) => any>(f: F, ...args: Parameters<F>): ReturnType<F> { return f(...args) }\nfunction add(a: number, b: number): number { return a + b }\nconst r = call(add, 1, 2)\nconst bad = call(add, 1, \"x\")"),
        errorsOf("function apply<T extends unknown[], R>(f: (...args: T) => R, args: T): R { return f(...args) }\nfunction add(a: number, b: number): number { return a + b }\nconst bad = apply(add, [1, \"x\"])"),
        errorsOf("function fwd<T extends unknown[]>(f: (...a: T) => nil, ...args: T): nil { return f(...args) }\nfunction two(a: number, b: string): nil { return nil }\nfwd(two, 1, \"x\")\nfwd(two, 1, 2)"),
    ], [
        ["Argument of type '\"x\"' is not assignable to parameter of type 'number'"],
        ["Argument of type '(a: number, b: number) => number' is not assignable to parameter of type '(...args: (number | string)[]) => number'"],
        ["Argument of type '2' is not assignable to parameter of type 'string'"],
    ])
    check("generic spreads: a union of tuples is each of its calls", [
        errorsOf("function g(a: number, b?: string): nil { return nil }\ndeclare t: [number] | [number, string]\ng(...t)"),
        errorsOf("function g(a: number, b?: number): nil { return nil }\ndeclare t: [number] | [number, string]\ng(...t)"),
        errorsOf("function g(a: number): nil { return nil }\ndeclare t: [number] | [number, number]\ng(...t)"),
    ], [[], ["Argument of type 'string' is not assignable to parameter of type 'number | nil'"], ["Expected 1 argument, got 2"]])
    check("functions: a rest tuple is the parameters it lays out", [
        errorsOf("function add(a: number, b: number): number { return a + b }\nconst g: (...args: [number, string]) => number = add"),
        errorsOf("function add(a: number, b: number): number { return a + b }\nconst g: (...args: [number, number]) => number = add"),
        errorsOf("function add(a: number, b: number): number { return a + b }\nconst g: (...xs: string[]) => number = add"),
    ], [
        ["Type '(a: number, b: number) => number' is not assignable to '(number, string) => number'"],
        [],
        ["Type '(a: number, b: number) => number' is not assignable to '(...args: string[]) => number'"],
    ])
}

// Type-level programs, checked against what TypeScript makes of them.
{
    const aliasOf = (code: string, name: string): string => {
        const program = parse(code)
        const types = analyzeTypes(program, analyzeScopes(program), {})
        return formatType(withoutAliasName(types.aliases.get(name)!))
    }
    const bindingOf = (code: string, name: string): string => {
        const program = parse(code)
        const scopes = analyzeScopes(program)
        const types = analyzeTypes(program, scopes, {})
        const id = [...scopes.bindings.values()].find(b => b.name === name)!.id
        return formatType(types.bindingType.get(id)!)
    }
    const errorsOf = (code: string): string[] => {
        const program = parse(code)
        const scopes = analyzeScopes(program)
        return [...scopes.diagnostics, ...analyzeTypes(program, scopes, {}).diagnostics].map(d => d.message)
    }
    check("conditional types: never distributes to never, any goes both ways", [
        aliasOf("type IsString<T> = T extends string ? true : false\ntype A = IsString<never>", "A"),
        aliasOf("type IsString<T> = T extends string ? true : false\ntype A = IsString<any>", "A"),
        aliasOf("type NoDist<T> = [T] extends [string] ? true : false\ntype A = NoDist<never>", "A"),
    ], ["never", "boolean", "true"])
    check("tuple patterns: a list of any length before what is written after it", [
        aliasOf("type Last<T> = T extends [...unknown[], infer L] ? L : never\ntype A = Last<[1, 2, 3]>", "A"),
        aliasOf("type Init<T> = T extends [...infer I, unknown] ? I : []\ntype A = Init<[1, 2, 3]>", "A"),
        aliasOf("type E<T> = T extends readonly (infer U)[] ? U : never\ntype A = E<readonly [1, 2]>", "A"),
    ], ["3", "[1, 2]", "1 | 2"])
    check("tuples: a place that may be left out, and the names places have", [
        aliasOf("type A = [number, string?]", "A"),
        aliasOf("type A = [number, string?][\"length\"]", "A"),
        aliasOf("type A = Parameters<(a: number, b?: string) => nil>", "A"),
        errorsOf("const t: [number, string?] = [1]\nconst u: [number, string?] = [1, \"a\"]\nconst v: [number, string?] = []"),
    ], ["[number, string?]", "1 | 2", "[a: number, b?: string]", ["Type '[]' is not assignable to '[number, string?]'"]])
    check("mapped types: what an optional member held for missing goes with its ?", [
        aliasOf("type A = Required<{ a?: number }>", "A"),
        aliasOf("type Copy<T> = { [K in keyof T]: T[K] }\ntype A = Copy<{ readonly a?: number }>", "A"),
    ], ["{ a: number }", "{ readonly a?: number }"])
    check("overloads: ReturnType reads the last signature", [
        aliasOf("declare function f(x: string): number\ndeclare function f(x: number): string\ntype A = ReturnType<typeof f>", "A"),
    ], ["string"])
    check("generic functions: T[K] in the body, keys kept as written, <const T> rests", [
        errorsOf("function get<T, K extends keyof T>(o: T, k: K): T[K] { return o[k] }\nconst s: string = get({ a: 1, b: \"s\" }, \"b\")"),
        bindingOf("function tuple<const T extends unknown[]>(...xs: T): T { return xs }\nconst t = tuple(1, \"a\")", "t"),
        bindingOf("function first<T extends readonly unknown[]>(xs: T): T[1] { return xs[1] }\nconst f = first([1, 2] as const)", "f"),
        bindingOf("function identity<T>(x: T): T { return x }\nconst i = identity(\"x\")", "i"),
        bindingOf("function identity<T>(x: T): T { return x }\nlet i = identity(\"x\")", "i"),
    ], [[], "[1, \"a\"]", "1", "\"x\"", "string"])
    check("generic functions: a constraint naming another type parameter is checked at the call", [
        errorsOf("function get<T, K extends keyof T>(o: T, k: K): T[K] { return o[k] }\nconst x = get({ a: 1, b: \"s\" }, \"c\")"),
        errorsOf("function pick<T, K extends keyof T>(o: T, ...ks: K[]) {}\npick({ a: 1 }, \"a\", \"z\")"),
        errorsOf("function pick<T, K extends keyof T>(o: T, ks: K[]) {}\npick({ a: 1 }, [\"a\", \"z\"])"),
        errorsOf("function f<A, B extends A>(a: A, b: B) {}\nf(1, \"s\")\nf(1, 2)"),
    ], [
        ["Argument of type '\"c\"' is not assignable to parameter of type '\"a\" | \"b\"'"],
        ["Argument of type '\"z\"' is not assignable to parameter of type '\"a\"'"],
        ["Argument of type '(\"a\" | \"z\")[]' is not assignable to parameter of type '\"a\"[]'"],
        ["Argument of type '\"s\"' is not assignable to parameter of type 'number'"],
    ])
    check("generic functions: a callback's rest list indexed by a type parameter is its elements", [
        errorsOf("type E = { click: [x: number, y: number], key: [code: string, shift?: boolean] }\ndeclare function on<K extends keyof E>(name: K, cb: (...args: E[K]) => nil): nil\non(\"click\", (x, y) => { const n: number = x; const m: number = y })\non(\"key\", c => { const s: string = c })\non(\"key\", (c, s) => { const b: boolean | nil = s })\non(\"click\", x => {})"),
        errorsOf("type E = { key: [string] }\ndeclare function on<K extends keyof E>(name: K, cb: (...args: E[K]) => nil): nil\non(\"key\", c => { const n: number = c })"),
        errorsOf("type E = { click: [number] }\ndeclare function on<K extends keyof E>(name: K, cb: (...args: E[K]) => nil): nil\non(\"click\", (x: string) => {})"),
    ], [
        [],
        ["Type 'string' is not assignable to 'number'"],
        ["Argument of type '(x: string) => nil' is not assignable to parameter of type '(number) => nil'"],
    ])
    check("generic functions: type arguments written out, defaults, and callbacks read last", [
        errorsOf("function id<T>(x: T): T { return x }\nconst r = id<number>(\"s\")"),
        errorsOf("class A { constructor() {}  function id<T>(x: T): T { return x } }\nconst r = A.new():id<number>(\"s\")"),
        bindingOf("function mk<T = string>(): T[] { return [] }\nconst r = mk()", "r"),
        bindingOf("const mk = <T = string>(): T[] => []\nconst r = mk()", "r"),
        bindingOf("declare function f<T, U = T[]>(x: T): [T, U]\nconst r = f(1)", "r"),
        bindingOf("const r = [1, 2]:reduce((a, b) => a + b, 0)", "r"),
        errorsOf("const r = [1, 2]:reduce((a, b) => a + b, 0)"),
    ], [
        ["Argument of type '\"s\"' is not assignable to parameter of type 'number'"],
        ["Argument of type '\"s\"' is not assignable to parameter of type 'number'"],
        "string[]", "string[]", "[number, number[]]", "number", [],
    ])
    check("narrowing: a discriminant inside an intersection with a union", [
        errorsOf("type X = ({ k: \"a\", x: number } | { k: \"b\", y: string }) & { id: number }\ndeclare v: X\nif (v.k == \"a\") { const n: number = v.x; const s = v.y; const i: number = v.id }"),
        errorsOf("type X = ({ k: \"a\", x: number } | { k: \"b\", y: string }) & { id: number }\nfunction f(v: X): number {\n    if (v.k == \"a\") return v.x\n    elseif (v.k == \"b\") return v.id\n    const n: never = v\n    return n\n}"),
    ], [["Property 'y' does not exist on type '{ k: \"a\", x: number } & { id: number }'"], []])
    check("methods: an optional one may not be there to call", [
        errorsOf("interface A { f?(): number }\ndeclare a: A\nconst r = a:f()"),
        bindingOf("interface A { f?(): number }\ndeclare a: A\nconst r = a:f()", "r"),
        errorsOf("interface A { f?(): number }\ndeclare a: A\nif (a.f) { const r = a:f() }"),
    ], [["'a.f' is possibly nil. Check it first"], "number", []])
    check("as: one side has to fit the other", [
        errorsOf("const a = 1 as string\nconst o = { a: 1 } as { a: string }\nconst s = \"s\" as { a: number }"),
        errorsOf("declare u: number | string\nconst a = u as number\nconst b = {} as { x: number }\nconst c = 1 as any as string\nconst d = { x: 1 } as { x: number, f: () => nil }"),
    ], [[
        "Conversion of type 'number' to type 'string' may be a mistake: neither fits the other. If it is meant, assert to 'any' first",
        "Conversion of type '{ a: number }' to type '{ a: string }' may be a mistake: neither fits the other. If it is meant, assert to 'any' first",
        "Conversion of type 'string' to type '{ a: number }' may be a mistake: neither fits the other. If it is meant, assert to 'any' first",
    ], []])
    check("narrowing: what a test rules out of an unknown leaves it unknown", [
        errorsOf("function f(u: unknown) {\n    if (typeof u == \"string\") { return }\n    const a = u.x\n    u:m()\n    const { b } = u\n}"),
        errorsOf("function f(u: unknown) {\n    if (u == nil) { return }\n    const a = u.x\n}"),
        errorsOf("function f() {\n    let u: unknown = nil\n    if (typeof u == \"string\") { u = 1 }\n    const a = u.x\n}"),
        errorsOf("function f(u: unknown) {\n    if (typeof u ~= \"string\") { return }\n    const n = u.length\n}"),
    ], [
        ["'u' is of type 'unknown'", "'u' is of type 'unknown'", "'u' is of type 'unknown'"],
        ["'u' is of type 'unknown'"],
        ["'u' is of type 'unknown'"],
        [],
    ])
    check("for ... of walks values, for ... in walks keys", [
        bindingOf("for (const r of [1, 2]) {}", "r"),
        bindingOf("for (const r in { a: 1, b: \"s\" }) {}", "r"),
        bindingOf("for (const r in [10, 20]) {}", "r"),
        bindingOf("declare d: { [string]: number }\nfor (const r in d) {}", "r"),
        bindingOf("for (let r in { a: 1 }) {}", "r"),
        bindingOf("const of = 1\nconst r = of + 1", "r"),
        bindingOf("for (const of of [1]) { const r = of }", "r"),
    ], ["number", "\"a\" | \"b\"", "number", "string", "string", "number", "number"])
    check("for ... in: an iterator, a pair, or not a table is reported, with what to write", [
        errorsOf("declare d: { [string]: number }\nfor (const [k, v] in pairs(d)) {}"),
        errorsOf("declare d: { [string]: number }\nfor (const k in pairs(d)) {}"),
        errorsOf("declare f: () => number | nil\nfor (const x in f) {}"),
        errorsOf("for (const k in 5) {}"),
        errorsOf("declare t: { a: number } | nil\nfor (const k in t) {}\nfor (const v of t) {}"),
    ], [
        ["'for ... in' walks a table's keys, one at a time: to take each '[key, value]' apart, write 'for (const [k, v] of pairs(t))'"],
        ["'for ... in' walks a table's keys, and this is an iterator: to walk what it gives, write 'for (const item of ...)'"],
        ["'for ... in' walks a table's keys, and this is an iterator: to walk what it gives, write 'for (const item of ...)'"],
        ["'for ... in' walks the keys of a table, not of '5'"],
        [
            "'t' is possibly nil, and nil cannot be walked: check it first, or walk 't ?? []'",
            "'t' is possibly nil, and nil cannot be walked: check it first, or walk 't ?? []'",
        ],
    ])
    check("in: what holds is t[k] ~= nil — the key one of t's, the slot not nil", [
        bindingOf("const o = { a: 1, b: \"s\" }\ndeclare k: string\nif (k in o) { const r = o[k] }", "r"),
        bindingOf("const o = { a: 1, b: \"s\" }\ndeclare k: string\nif (k in o) { const r = k }", "r"),
        bindingOf("declare d: { [string]: number | nil }\ndeclare k: string\nif (k in d) { const r = d[k] }", "r"),
        bindingOf("declare xs: string[]\nif (2 in xs) { const r = xs[2] }", "r"),
        bindingOf("declare t: { a?: number, b: string }\nif (\"a\" in t) { } else { const r = t.a }", "r"),
        bindingOf("type K = \"a\" | \"b\" | \"c\"\nconst o = { a: 1, b: 2 }\ndeclare k: K\nif (k in o) { } else { const r = k }", "r"),
    ], ["number | string", "\"a\" | \"b\"", "number", "string", "nil", "\"c\""])
    check("do: a block that always runs keeps what it assigns and rules out", [
        bindingOf("let x: number | string = 1\ndo { x = \"s\" }\nconst r = x", "r"),
        errorsOf("declare u: number | nil\ndo { if (u == nil) { error(\"x\") } }\nconst n: number = u"),
        bindingOf("const x = 1\ndo { const x = \"s\" }\nconst r = x", "r"),
    ], ["string", [], "1"])
    check("as const freezes its lists", [
        bindingOf("const c = [1, [2]] as const", "c"),
        errorsOf("const modes = [\"a\", \"b\"] as const\ndeclare s: string\nconst found = modes:includes(s)\nconst joined = modes:join(\",\")"),
        errorsOf("const modes = [\"a\", \"b\"] as const\nmodes:push(\"c\")"),
    ], ["readonly [1, readonly [2]]", [], ["Argument of type 'readonly [\"a\", \"b\"]' is not assignable to parameter of type '(\"a\" | \"b\")[]'"]])
    check("shapes: a string or a list fits one naming what it answers to", [
        errorsOf("function len<T extends { length: number }>(x: T): number { return x.length }\nlen(\"abc\")\nlen([1, 2])\nlen(5)"),
    ], [["Argument of type '5' is not assignable to parameter of type '{ length: number }'"]])
    check("index signatures: TypeScript's [key: K], and template literal keys", [
        errorsOf("type H = { [key: `on${string}`]: () => nil }\nconst h: H = { onClick: () => nil, bad: 1 }"),
    ], [["Object literal may only specify known properties, and 'bad' does not exist in type 'H'"]])
    check("narrowing: generic assertions, and a discriminant tested down to never", [
        bindingOf("function assertDefined<T>(v: T | nil): asserts v is T { if (v == nil) error(\"nil\") }\ndeclare x: number | nil\nassertDefined(x)\nconst y = x", "y"),
        errorsOf("type Shape = { kind: \"c\", r: number } | { kind: \"s\", s: number }\nfunction area(sh: Shape): number {\n    if (sh.kind == \"c\") return sh.r\n    elseif (sh.kind == \"s\") return sh.s\n    const n: never = sh\n    return n\n}"),
        errorsOf("declare function on<E extends \"click\" | \"key\">(e: E, f: (ev: E extends \"click\" ? { x: number } : { code: string }) => nil): nil\non(\"click\", ev => { const x: number = ev.x })\non(\"key\", ev => { const c: string = ev.code })"),
    ], ["number", [], []])
}

// `keyof` a list: its positions and its `length`.
{
    const aliasOf = (code: string, name: string): string => {
        const program = parse(code)
        const types = analyzeTypes(program, analyzeScopes(program), {})
        return formatType(withoutAliasName(types.aliases.get(name)!))
    }
    check("keyof: a list's keys are its positions and its length", [
        aliasOf("type A = keyof []", "A"),
        aliasOf("type A = keyof string[]", "A"),
        aliasOf("type A = keyof [1, 2]", "A"),
        aliasOf("type T = [1, 2]\ntype A = T[keyof T]", "A"),
        aliasOf("type A = (keyof { a: 1 })[]", "A"),
        aliasOf("type A = keyof { a: { b: 1 } }[\"a\"]", "A"),
        aliasOf("type A = keyof string", "A"),
        aliasOf("type A = keyof number", "A"),
    ], ["number | \"length\"", "number | \"length\"", "number | \"length\"", "1 | 2", "\"a\"[]", "\"b\"", "\"length\"", "never"])
}

// What only reads a list takes a read-only one: ipairs, pairs, unpack, ...
{
    const errorsOf = (code: string): string[] => {
        const program = parse(code)
        const scopes = analyzeScopes(program)
        return [...scopes.diagnostics, ...analyzeTypes(program, scopes, {}).diagnostics].map(d => d.message)
    }
    check("read-only lists: walked and read by the standard library, not changed by it", [
        errorsOf("const xs = [1, 2] as const\ndeclare ys: readonly string[]\nfor (const [i, v] of ipairs(xs)) { const n: 1 | 2 = v }\nfor (const [i, v] of pairs(ys)) { const s: string = v }\nconst u: string[] = unpack(ys)\nconst c = table.concat(ys, \",\")\nconst n = table.getn(ys)"),
        errorsOf("declare ys: readonly string[]\ntable.insert(ys, \"a\")"),
        errorsOf("const xs = [1, 2] as const\nfor (const x of xs) { const s: string = x }"),
    ], [[], ["No overload matches this call"], ["Type '1 | 2' is not assignable to 'string'"]])
}

// TypeScript's spellings of `~=`, `==`, `and`, `or` and `not`: said, and read as meant.
{
    const result = parseWithRecovery("declare a: number | nil\nconst b = a != nil && a === 1 || !a\nconst c = a !== 2")
    check("operators: TypeScript's spellings say what tilua writes", result.errors.map(e => e.message.replace(/ \(\d+:\d+\)$/, "")), [
        "tilua writes '~=', not '!='",
        "tilua writes 'and', not '&&'",
        "tilua writes '==', not '==='",
        "tilua writes 'or', not '||'",
        "tilua writes 'not', not '!'",
        "tilua writes '~=', not '!=='",
    ])
}

// A class's own name, and an array's keys, values and entries.
{
    const errorsOf = (code: string): string[] => {
        const program = parse(code)
        const scopes = analyzeScopes(program)
        return [...scopes.diagnostics, ...analyzeTypes(program, scopes, {}).diagnostics].map(d => d.message)
    }
    const reserved = "'name' is the class's own name, `Dog.name`: a static, a method or an accessor cannot be called that — an instance field can"
    check("classes: name is the class's own", [
        errorsOf("class Dog { constructor() {} }\nconst n: \"Dog\" = Dog.name\nconst m: string = Dog.new().ClassObject.name"),
        errorsOf("class A { static name = 1 constructor() {} }"),
        errorsOf("class B { constructor() {} function name(): string { return \"b\" } }"),
        errorsOf("class C { name = \"c\" constructor() {} }\nconst s: string = C.new().name"),
    ], [[], [reserved], [reserved], []])
    check("arrays: keys, values and entries, as arrays", [
        errorsOf("const xs = [\"a\", \"b\"]\nconst k: number[] = xs:keys()\nconst v: string[] = xs:values()\nconst e: [number, string][] = xs:entries()\nfor (const [i, s] of xs:entries()) { const n: number = i\n const t: string = s }"),
    ], [[]])
}

// A map keyed by a class answers the table methods; a generic function's
// ReturnType is read at its constraints, and is the type its calls fit.
{
    const errorsOf = (code: string): string[] => {
        const program = parse(code)
        const scopes = analyzeScopes(program)
        return [...scopes.diagnostics, ...analyzeTypes(program, scopes, {}).diagnostics].map(d => d.message)
    }
    const aliasOf = (code: string, name: string): string => {
        const program = parse(code)
        const types = analyzeTypes(program, analyzeScopes(program), {})
        return formatType(withoutAliasName(types.aliases.get(name)!))
    }
    check("maps: a class-keyed or number-keyed map has keys, values and entries", [
        errorsOf("declare class P { Name: string }\ndeclare b: { [P]: number }\nconst v: number[] = b:values()\nconst k: P[] = b:keys()\nconst e: [P, number][] = b:entries()\ndeclare c: { [number]: string }\nconst s: string[] = c:values()"),
    ], [[]])
    check("generic functions: ReturnType and Parameters read them at their constraints", [
        aliasOf("function find<T extends string>(x: T): T | nil { return x }\ntype R = ReturnType<typeof find>", "R"),
        aliasOf("function find<T extends string>(x: T): T | nil { return x }\ntype R = Parameters<typeof find>", "R"),
        aliasOf("function id<T>(x: T): T { return x }\ntype R = ReturnType<typeof id>", "R"),
        errorsOf("declare class Inst { Name: string }\ndeclare class Fold extends Inst { }\ndeclare function pick<T extends Inst>(name: string): T | nil\nfunction find<T extends Inst>(name: string) { return pick<T>(name) }\ntype Found = ReturnType<typeof find>\nconst f: Found = find<Fold>(\"x\")"),
    ], ["string | nil", "[x: string]", "unknown", []])
    check("generic functions: one fits a plain function type as it would be called there", [
        errorsOf("function id<T>(x: T): T { return x }\nconst a: (x: number) => number = id\nconst b: (x: number) => string = id"),
    ], [["Type '<T>(x: T) => T' is not assignable to '(x: number) => string'"]])
}

// keys, values and entries say all that is known: a tuple's place by place.
{
    const bindingOf = (code: string, name: string): string => {
        const program = parse(code)
        const scopes = analyzeScopes(program)
        const types = analyzeTypes(program, scopes, {})
        const id = [...scopes.bindings.values()].find(b => b.name === name)!.id
        return formatType(types.bindingType.get(id)!)
    }
    const T = "const t = [\"a\", 1] as const\n"
    check("keys, values, entries: a tuple's are tuples, an array's arrays", [
        bindingOf(T + "const k = t:keys()", "k"),
        bindingOf(T + "const v = t:values()", "v"),
        bindingOf(T + "const e = t:entries()", "e"),
        bindingOf("const xs = [\"a\", \"b\"]\nconst e = xs:entries()", "e"),
        bindingOf("declare tt: [x: number, y: string]\nconst k = tt:keys()", "k"),
        bindingOf("const o = { a: 1, b: \"x\" }\nconst e = o:entries()", "e"),
        bindingOf("declare m: { [string]: boolean }\nconst e = m:entries()", "e"),
        bindingOf("declare r: [number, ...string[]]\nconst x = r[5]", "x"),
    ], ["[1, 2]", "[\"a\", 1]", "[[1, \"a\"], [2, 1]]", "[number, string][]", "[x: 1, y: 2]", "[[\"a\", number], [\"b\", string]]", "[string, boolean][]", "string"])
}

// fromEntries, and what makes entries worth having: destructured callbacks
// typed from the call, list literals returned as tuples, map keeping a tuple's length.
{
    const bindingOf = (code: string, name: string): string => {
        const program = parse(code)
        const scopes = analyzeScopes(program)
        const types = analyzeTypes(program, scopes, {})
        const id = [...scopes.bindings.values()].find(b => b.name === name)!.id
        return formatType(types.bindingType.get(id)!)
    }
    const errorsOf = (code: string): string[] => {
        const program = parse(code)
        const scopes = analyzeScopes(program)
        return [...scopes.diagnostics, ...analyzeTypes(program, scopes, {}).diagnostics].map(d => d.message)
    }
    const O = "const o = { hp: 10, mp: 5 }\n"
    check("fromEntries: the object a list of pairs makes", [
        bindingOf("const t = [[\"a\", 1], [\"b\", \"x\"]] as const\nconst r = t:fromEntries()", "r"),
        bindingOf("declare ps: [string, number][]\nconst r = ps:fromEntries()", "r"),
        bindingOf("declare ps: [\"a\" | \"b\", number][]\nconst r = ps:fromEntries()", "r"),
        bindingOf(O + "const r = o:entries():fromEntries()", "r"),
        bindingOf(O + "const r = o:entries():map(([k, v]) => [k, v * 2]):fromEntries()", "r"),
        errorsOf("const r = [1, 2]:fromEntries()"),
    ], [
        "{ a: 1, b: \"x\" }",
        "{ [string]: number }",
        "{ a?: number, b?: number }",
        "{ hp: number, mp: number }",
        "{ hp: number, mp: number }",
        ["Argument of type 'number[]' is not assignable to parameter of type 'readonly (readonly [unknown, unknown])[]'"],
    ])
    check("callbacks: a destructured parameter takes its type from the call", [
        bindingOf(O + "const r = o:entries():map(([k, v]) => k)", "r"),
        bindingOf("declare xs: [string, number][]\nconst r = xs:map(([k, v]) => v)", "r"),
        bindingOf("declare xs: [string, number][]\nconst r = xs:map(e => [e[1], e[2]])", "r"),
        bindingOf("const r = [1, \"x\"] as const\nconst m = r:map(v => tostring(v))", "m"),
    ], ["[\"hp\" | \"mp\", \"hp\" | \"mp\"]", "number[]", "[string, number][]", "[string, string]"])
}

{
    const errorsOf = (code: string): string[] => {
        const program = parse(code)
        const scopes = analyzeScopes(program)
        return [...scopes.diagnostics, ...analyzeTypes(program, scopes, {}).diagnostics].map(d => d.message)
    }
    check("??: what the declaration wants is wanted of either side", [
        errorsOf("type Stat = { n: number }\ndeclare m: { [string]: Stat[] }\nconst a: Stat[] = m[\"k\"] ?? []"),
        errorsOf("declare m: { [string]: { [string]: number } }\nconst a: { [string]: number } = m[\"k\"] ?? {}"),
        errorsOf("declare m: { [string]: number[] }\nconst a: string[] = m[\"k\"] ?? []"),
    ], [[], [], ["Type 'number[] | string[]' is not assignable to 'string[]'"]])
    check("=> void: a function wanted for what it does may give something back", [
        errorsOf("declare defer: () => thread\nconst f: () => void = () => defer()"),
        errorsOf("declare each: (f: (n: number) => void) => void\neach((n) => n + 1)"),
        errorsOf("const f: () => void = function() { print(1) }\nconst g: () => void = () => nil"),
        errorsOf("const f: () => number = () => \"x\""),
        errorsOf("function f(): void { return 5 }"),
        errorsOf("function f(): void { print(1) }\nfunction g(): void { return }\nconst r: number | nil = f()"),
    ], [[], [], [], ["Type '() => \"x\"' is not assignable to '() => number'"], ["Type '5' is not assignable to 'void'"], []])
    check("generic inference: a value read from somewhere keeps its literals", [
        errorsOf([
            "type Box<T> = { value: T }",
            "declare function lit<T extends string>(v: T): Box<T>",
            "declare function obj<S>(s: S): S",
            "const L = lit(\"cmd\")",
            "const b: Box<\"cmd\"> = obj({ t: L }).t",
            "declare raw: { kind: \"a\" }",
            "const k: \"a\" = obj({ r: raw }).r.kind",
        ].join("\n")),
        errorsOf("declare function obj<S>(s: S): S\nconst w = obj({ k: \"x\" })\nconst s: \"x\" = w.k"),
    ], [[], ["Type 'string' is not assignable to '\"x\"'"]])
    check("=> nil: a function that promises nil returns nil", [
        errorsOf("declare defer: () => thread\nconst f: () => nil = () => defer()"),
        errorsOf("function f(): nil { return 5 }"),
    ], [["Type '() => thread' is not assignable to '() => nil'"], ["Type '5' is not assignable to 'nil'"]])
}

// `import "./setup"`: run for what it does, naming nothing.
{
    const program = parse("import \"./setup\"\nprint(1)")
    const statement = program.body.statements[0] as { type: string; specifiers: unknown[]; source: { value: string } }
    check("import \"...\": a statement with no names", [statement.type, statement.specifiers.length, statement.source.value], ["ImportStatement", 0, "./setup"])
    const scopes = analyzeScopes(program)
    const types = analyzeTypes(program, scopes, { resolveModule: () => undefined })
    check("import \"...\": a missing module is still reported", types.diagnostics.map(d => d.message), ["Cannot find module './setup'"])
}

// A module `import()` reaches is analyzed in the middle of the importing
// one's run; when it is done, the importer's types still compare as they did.
{
    const lib = parse("type Signal<T extends unknown[] = any[]> = { Wait: (self: Signal<T>) => T }")
    const other = parse("export const sig = nil as any as Signal<[]>")
    const resolveModule = (): ModuleExports => {
        const scopes = analyzeScopes(other)
        return moduleExports(other, scopes, analyzeTypes(other, scopes, { libs: [lib] }))
    }
    const program = parse("const m = import(\"./other\")\nconst s: Signal<[]> = m.sig\nconst t: Signal<[]> = s")
    const scopes = analyzeScopes(program)
    const types = analyzeTypes(program, scopes, { libs: [lib], resolveModule })
    check("import(): a type from the module is the type the importer names", types.diagnostics.map(d => d.message), [])
}

for (const failure of failures) console.log(`FAIL ${failure}`)
console.log(`\nproject: ${passed} passed, ${failures.length} failed`)
process.exit(failures.length ? 1 : 0)
