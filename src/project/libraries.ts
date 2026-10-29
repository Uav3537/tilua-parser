/**
 * `types` in a config: which `.d.tilua` files to load, in order.
 *
 * Lua's standard library is always there, without being listed (see
 * `standardLibrary`; `"noLib": true` leaves it out). An entry names a type
 * library to load on top of it:
 *
 *   "roblox"               `@tilua-types/roblox`, or failing that a package
 *                          called `roblox` — a library of your own, published
 *                          under any name, is written the same way
 *   "@tilua-types/roblox"  a package by its full name; so is `"@me/types"`
 *   "@tilua-types/*"       every type library installed under that scope
 *                          (`*` stands for any part of the last segment)
 *   "./types"              a folder of the project (its `package.json`, or `index.d.tilua`)
 *   "./defs.d.tilua"       a file of the project
 *
 * A package is looked for in `node_modules` from the config's folder upward.
 * Its definitions file is `tilua.types` in its `package.json`, or
 * `index.d.tilua`. Any of its dependencies that are type libraries load first.
 * `@tilua-types/lua` is the one exception: what it declared is the standard
 * library now, so naming it — or depending on it, as `@tilua-types/roblox`
 * does — loads nothing a second time. With `noLib` it loads as it always did.
 * A later file adds to the names an earlier one declared rather than
 * replacing them, which is what makes those layers layers.
 *
 * A library may also add options to the config — what only it knows how to
 * act on. Its package.json declares them:
 *
 *   "tilua": {
 *       "lowering": "lowering.mjs",
 *       "options": {
 *           "typedExports": { "type": "boolean", "default": true, "description": "..." }
 *       }
 *   }
 *
 * and the config sets them beside its own (`"typedExports": false`). They are
 * checked here, where the libraries are known: a key no loaded library
 * declares is an unknown option, and a value of the wrong type is reported
 * and the default kept. What they mean is the library's lowering's to say;
 * it is handed its own (`LoweringModule.options`).
 */
import { dirname, join, resolve } from "node:path"
import type { ConfigProblem, TiluaConfig } from "./config"
import { CONFIG_OPTIONS, keyPosition } from "./config"
import { nodeHost, type ProjectHost } from "./host"

export interface TypeLibraries {
    /** Definitions files, dependencies before what depends on them. */
    readonly files: readonly string[]
    /** Lowering modules the libraries ship, in the same order. */
    readonly lowerings: readonly LoweringModule[]
    /** The options the libraries declare, in the order they were loaded. */
    readonly options: readonly LibraryOption[]
    readonly problems: readonly ConfigProblem[]
}

/** What a library's option may hold. */
export type LibraryOptionType = "boolean" | "number" | "string"

/** An option a type library adds to the config. */
export interface LibraryOption {
    readonly name: string
    readonly type: LibraryOptionType
    /** What it is when the config does not set it. */
    readonly default?: boolean | number | string
    /** The only values it may take, where it is one of a few. */
    readonly values?: readonly (number | string)[]
    readonly description?: string
    /** The package that declares it. */
    readonly from: string
    /** What it is for this config: the config's value if that fits, else
     *  the default. */
    readonly value: boolean | number | string | undefined
}

/** A library's own lowering: JavaScript the compiler loads and asks what a
 *  call written against this library's types should become.
 *
 *  The library declares the *types* in its definitions file; this is the other
 *  half. `names:first()` is a call to a function only because the library that
 *  put `first` in an array's metatable says so and ships the Luau behind it —
 *  the compiler knows how to ask, and nothing about `first`.
 *
 *  `tilua.lowering` in the package.json names the module; what it must export
 *  is the compiler's business (see @tilua/compiler's `LoweringPlugin`). */
export interface LoweringModule {
    /** The JavaScript module to load. */
    readonly file: string
    /** The package it came from, for reporting. */
    readonly from: string
    /** The package's definitions file, as its index in `files` — what the
     *  analyzer names when a method comes from a metatable the package
     *  declared (`MethodSource`), so the compiler asks this lowering. */
    readonly library: number
    /** The package's own options, as this config has them — the default for
     *  one it does not set. */
    readonly options: Readonly<Record<string, boolean | number | string | undefined>>
}

export function resolveTypeLibraries(config: TiluaConfig, host: ProjectHost = nodeHost): TypeLibraries {
    const files: string[] = []
    const lowerings: (Omit<LoweringModule, "options"> & { directory: string })[] = []
    const problems: ConfigProblem[] = []
    const loaded = new Set<string>()
    /** Every option declared, by name: the first package to declare it. */
    const declared = new Map<string, Omit<LibraryOption, "value">>()
    /** The names each package declares, by its folder. */
    const ownOptions = new Map<string, string[]>()

    const addFile = (file: string): void => {
        const key = pathKey(file)
        if (loaded.has(key)) return
        loaded.add(key)
        files.push(file)
    }

    /** A package folder: its dependencies' definitions, then its own. */
    const addPackage = (directory: string, entryFile: string, visiting: Set<string>): void => {
        const key = pathKey(directory)
        if (visiting.has(key)) return
        visiting.add(key)
        // However it was reached — by name, by `@tilua-types/*`, by a path.
        const name = readJson(join(directory, "package.json"), host)?.name
        if (typeof name === "string" && builtIn(name)) return
        for (const dependency of dependencyNames(directory, host)) {
            if (builtIn(dependency)) continue
            const found = findPackage(dependency, directory, host)
            if (found) addPackage(found.directory, found.file, visiting)
        }
        addFile(entryFile)
        const own = packageOptions(directory, host, problems, config)
        for (const option of own) {
            const before = declared.get(option.name)
            if (before && before.type !== option.type) {
                problems.push({
                    file: config.path,
                    message: `'${option.from}' and '${before.from}' both declare the option '${option.name}', as different types`,
                })
            } else if (!before) declared.set(option.name, option)
        }
        ownOptions.set(key, own.map(o => o.name))
        const lowering = loweringModule(directory, host, problems, config)
        const library = files.findIndex(file => pathKey(file) === pathKey(entryFile))
        if (lowering) lowerings.push({ ...lowering, library, directory: key })
    }

    /** The standard library's old package, which is built in unless `noLib`. */
    const builtIn = (name: string): boolean => !config.noLib && name === STANDARD_PACKAGE

    for (const entry of config.types) {
        const relative = entry.startsWith("./") || entry.startsWith("../") || entry.startsWith("/") || /^[A-Za-z]:[\\/]/.test(entry)
        if (relative) {
            const target = resolve(config.directory, entry)
            if (entry.endsWith(".tilua")) {
                if (host.readFile(target) !== undefined) addFile(target)
                else problems.push({ file: config.path, message: `Cannot find type library file '${entry}'`, ...entryPosition(config, entry) })
                continue
            }
            const file = packageEntry(target, host)
            if (file) addPackage(target, file, new Set())
            else problems.push({ file: config.path, message: `'${entry}' has no ${ENTRY_FILE} (or 'tilua.types' in its package.json)`, ...entryPosition(config, entry) })
            continue
        }

        if (entry.includes("*")) {
            const matched = matchPackages(entry, config.directory, host)
            if (matched === undefined) {
                problems.push({
                    file: config.path,
                    message: `'${entry}' needs the folders listed, and this tool cannot list them; name the libraries one by one`,
                    ...entryPosition(config, entry),
                })
            } else if (!matched.length) {
                problems.push({
                    file: config.path,
                    message: `No installed type library matches '${entry}'`,
                    ...entryPosition(config, entry),
                })
            }
            for (const found of matched ?? []) addPackage(found.directory, found.file, new Set())
            continue
        }

        // A bare name is one of ours first, then whatever package has that
        // name — which is how a library someone else published is loaded. A
        // scoped name says where it is already.
        const names = entry.startsWith("@") ? [entry] : [`@tilua-types/${entry}`, entry]
        // `"lua"`: already there.
        if (builtIn(names[0])) continue
        const found = names.map(name => findPackage(name, config.directory, host)).find(Boolean)
        if (found) addPackage(found.directory, found.file, new Set())
        else {
            problems.push({
                file: config.path,
                message: names.length === 1
                    ? `Cannot find type library '${entry}'. Install it with: npm i -D ${entry}`
                    : `Cannot find type library '${names[0]}' or '${entry}'. Install it with: npm i -D ${names[0]}`,
                ...entryPosition(config, entry),
            })
        }
    }

    // What the config sets, checked against what the libraries declare.
    const values = new Map<string, boolean | number | string | undefined>()
    for (const option of declared.values()) values.set(option.name, option.default)
    for (const [key, value] of Object.entries(config.libraryOptions)) {
        const at = keyPosition(config.source, key)
        const option = declared.get(key)
        if (!option) {
            const known = [...CONFIG_OPTIONS, ...declared.keys()]
            problems.push({ file: config.path, message: `Unknown option '${key}'. Options are: ${known.join(", ")}`, ...at })
            continue
        }
        const fits = typeof value === option.type && (!option.values || option.values.includes(value as number | string))
        if (fits) values.set(key, value as boolean | number | string)
        else problems.push({ file: config.path, message: `'${key}' must be ${describeOption(option)} (an option of '${option.from}')`, ...at })
    }
    const options: LibraryOption[] = [...declared.values()].map(o => ({ ...o, value: values.get(o.name) }))
    const withOptions: LoweringModule[] = lowerings.map(({ directory, ...lowering }) => ({
        ...lowering,
        options: Object.fromEntries((ownOptions.get(directory) ?? []).map(name => [name, values.get(name)])),
    }))

    return { files, lowerings: withOptions, options, problems }
}

/** The options the package in `directory` declares, as far as they are
 *  declared well; a declaration that is not is reported and skipped. */
function packageOptions(
    directory: string,
    host: ProjectHost,
    problems: ConfigProblem[],
    config: TiluaConfig,
): Omit<LibraryOption, "value">[] {
    const manifest = readJson(join(directory, "package.json"), host)
    const declared = (manifest?.tilua as { options?: unknown } | undefined)?.options
    if (declared === undefined) return []
    const from = typeof manifest?.name === "string" ? manifest.name : directory
    const bad = (message: string): void => { problems.push({ file: config.path, message: `'${from}': ${message}` }) }
    if (!declared || typeof declared !== "object" || Array.isArray(declared)) {
        bad("'tilua.options' must be an object of options by name")
        return []
    }
    const out: Omit<LibraryOption, "value">[] = []
    for (const [name, raw] of Object.entries(declared)) {
        if ((CONFIG_OPTIONS as readonly string[]).includes(name) || name === "target") {
            bad(`the option '${name}' is the config's own, and cannot be declared again`)
            continue
        }
        const spec = raw && typeof raw === "object" ? raw as Record<string, unknown> : {}
        const type = spec.type
        if (type !== "boolean" && type !== "number" && type !== "string") {
            bad(`the option '${name}' needs a 'type': "boolean", "number" or "string"`)
            continue
        }
        const listed = spec.values
        const values = type !== "boolean" && Array.isArray(listed) && listed.every(v => typeof v === type)
            ? listed as (number | string)[] : undefined
        if (listed !== undefined && !values) bad(`the 'values' of the option '${name}' must be a list of ${type}s`)
        let fallback: boolean | number | string | undefined
        if (spec.default !== undefined) {
            if (typeof spec.default === type && (!values || values.includes(spec.default as number | string))) {
                fallback = spec.default as boolean | number | string
            } else bad(`the default of the option '${name}' is not a ${values ? "listed value" : type}`)
        }
        out.push({
            name, type, from,
            ...(fallback !== undefined && { default: fallback }),
            ...(values && { values }),
            ...(typeof spec.description === "string" && { description: spec.description }),
        })
    }
    return out
}

/** What an option's value has to be, in words. */
function describeOption(option: Omit<LibraryOption, "value">): string {
    if (option.values) return `one of: ${option.values.map(v => JSON.stringify(v)).join(", ")}`
    return option.type === "boolean" ? "true or false" : `a ${option.type}`
}

/** The `tilua.lowering` of a package, if it has one. */
function loweringModule(
    directory: string,
    host: ProjectHost,
    problems: ConfigProblem[],
    config: TiluaConfig,
): Omit<LoweringModule, "library" | "options"> | undefined {
    const manifest = readJson(join(directory, "package.json"), host)
    const declared = (manifest?.tilua as { lowering?: unknown } | undefined)?.lowering
    if (typeof declared !== "string") return undefined
    const from = typeof manifest?.name === "string" ? manifest.name : directory
    const file = resolve(directory, declared)
    if (host.readFile(file) === undefined) {
        problems.push({ file: config.path, message: `'${from}' names a lowering module '${declared}', which is not there` })
        return undefined
    }
    return { file, from }
}

const ENTRY_FILE = "index.d.tilua"

/** Where Lua's standard library was a package of its own. */
const STANDARD_PACKAGE = "@tilua-types/lua"

/** The definitions file of the package in `directory`, if it is a type library. */
function packageEntry(directory: string, host: ProjectHost): string | undefined {
    const manifest = readJson(join(directory, "package.json"), host)
    const declared = (manifest?.tilua as { types?: unknown } | undefined)?.types
    const file = resolve(directory, typeof declared === "string" ? declared : ENTRY_FILE)
    return host.readFile(file) !== undefined ? file : undefined
}

/** `name` in `node_modules`, searching from `from` upward. */
function findPackage(name: string, from: string, host: ProjectHost): { directory: string; file: string } | undefined {
    let directory = resolve(from)
    for (;;) {
        const candidate = join(directory, "node_modules", ...name.split("/"))
        const file = packageEntry(candidate, host)
        if (file) return { directory: candidate, file }
        const parent = dirname(directory)
        if (parent === directory) return undefined
        directory = parent
    }
}

/** Every installed type library whose name `pattern` matches, in name order —
 *  from the nearest `node_modules` that has it. `undefined` when the host
 *  cannot list folders. Packages that are not type libraries are passed over:
 *  `@tilua/*` names the parser too. */
function matchPackages(
    pattern: string,
    from: string,
    host: ProjectHost,
): { directory: string; file: string }[] | undefined {
    if (!host.readDirectory) return undefined
    const slash = pattern.lastIndexOf("/")
    const scope = slash < 0 ? "" : pattern.slice(0, slash)
    const last = pattern.slice(slash + 1)
    const matches = new RegExp(`^${last.split("*").map(escapeRegExp).join(".*")}$`)
    const found = new Map<string, { directory: string; file: string }>()
    let directory = resolve(from)
    for (;;) {
        const folder = join(directory, "node_modules", ...(scope ? scope.split("/") : []))
        for (const name of host.readDirectory(folder) ?? []) {
            const full = scope ? `${scope}/${name}` : name
            if (!matches.test(name) || found.has(full)) continue
            const candidate = join(folder, name)
            const file = packageEntry(candidate, host)
            if (file) found.set(full, { directory: candidate, file })
        }
        const parent = dirname(directory)
        if (parent === directory) break
        directory = parent
    }
    return [...found.keys()].sort().map(name => found.get(name)!)
}

function escapeRegExp(text: string): string {
    return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
}

function dependencyNames(directory: string, host: ProjectHost): string[] {
    const manifest = readJson(join(directory, "package.json"), host)
    const names = new Set<string>()
    for (const field of ["dependencies", "peerDependencies"]) {
        const deps = manifest?.[field]
        if (deps && typeof deps === "object") for (const name of Object.keys(deps)) names.add(name)
    }
    return [...names]
}

function readJson(path: string, host: ProjectHost): Record<string, unknown> | undefined {
    const text = host.readFile(path)
    if (text === undefined) return undefined
    try {
        const value = JSON.parse(text)
        return value && typeof value === "object" ? value : undefined
    } catch {
        return undefined
    }
}

/** Where `entry` is written in the config, for pointing a problem at it. */
function entryPosition(config: TiluaConfig, entry: string): { line?: number; column?: number } {
    return keyPosition(config.source, entry)
}

function pathKey(path: string): string {
    const normalized = resolve(path)
    return process.platform === "win32" ? normalized.toLowerCase() : normalized
}
