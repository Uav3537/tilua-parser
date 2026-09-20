/**
 * `types` in a config: which `.d.tilua` files to load, in order.
 *
 * Nothing is loaded by default. An entry names a type library:
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
 * `index.d.tilua`. Any of its dependencies that are type libraries load first,
 * so `["roblox"]` brings `@tilua-types/lua` along, first.
 * A later file adds to the names an earlier one declared rather than
 * replacing them, which is what makes those layers layers.
 */
import { dirname, join, resolve } from "node:path"
import type { ConfigProblem, TiluaConfig } from "./config"
import { keyPosition } from "./config"
import { nodeHost, type ProjectHost } from "./host"

export interface TypeLibraries {
    /** Definitions files, dependencies before what depends on them. */
    readonly files: readonly string[]
    /** Lowering modules the libraries ship, in the same order. */
    readonly lowerings: readonly LoweringModule[]
    readonly problems: readonly ConfigProblem[]
}

/** A library's own lowering: JavaScript the compiler loads and asks what a
 *  call written against this library's types should become.
 *
 *  The library declares the *types* in its definitions file; this is the other
 *  half. `names:filter(f)` is a call to a function only because `@tilua-types/lua`
 *  says so and ships the Luau behind it — the compiler knows how to ask, and
 *  nothing about `filter`.
 *
 *  `tilua.lowering` in the package.json names the module; what it must export
 *  is the compiler's business (see @tilua/compiler's `LoweringPlugin`). */
export interface LoweringModule {
    /** The JavaScript module to load. */
    readonly file: string
    /** The package it came from, for reporting. */
    readonly from: string
}

export function resolveTypeLibraries(config: TiluaConfig, host: ProjectHost = nodeHost): TypeLibraries {
    const files: string[] = []
    const lowerings: LoweringModule[] = []
    const problems: ConfigProblem[] = []
    const loaded = new Set<string>()

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
        for (const dependency of dependencyNames(directory, host)) {
            const found = findPackage(dependency, directory, host)
            if (found) addPackage(found.directory, found.file, visiting)
        }
        addFile(entryFile)
        const lowering = loweringModule(directory, host, problems, config)
        if (lowering) lowerings.push(lowering)
    }

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

    return { files, lowerings, problems }
}

/** The `tilua.lowering` of a package, if it has one. */
function loweringModule(
    directory: string,
    host: ProjectHost,
    problems: ConfigProblem[],
    config: TiluaConfig,
): LoweringModule | undefined {
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
