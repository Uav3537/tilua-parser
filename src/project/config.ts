/**
 * `tilua.config.json`: finding the one that applies to a file, and reading it.
 *
 * A file takes the nearest config in its own folder or above, as with
 * tsconfig. The config may be written `tilua.config.json` or
 * `tilua.config.jsonc`; either allows comments and trailing commas. Both in one
 * folder is an error, since it would be ambiguous which applies.
 */
import { dirname, join, resolve } from "node:path"
import { nodeHost, type ProjectHost } from "./host"

export const CONFIG_FILE_NAMES = ["tilua.config.json", "tilua.config.jsonc"] as const

export interface TiluaConfig {
    /** Absolute path of the config file. */
    readonly path: string
    /** The folder it sits in. Relative paths in it resolve from here. */
    readonly directory: string
    /** The config file's text, for locating problems in it. */
    readonly source: string
    /** Type libraries to load, in order: `"lua"`, `"@tilua-types/roblox"`, `"./types"`. */
    readonly types: readonly string[]
    /** Import path aliases, as in tsconfig: `{ "@shared/*": ["src/shared/*"] }`. */
    readonly paths: Readonly<Record<string, readonly string[]>>
    /** Where `paths` targets resolve from, absolute. The config's folder unless set. */
    readonly baseUrl: string
    /** Absolute path of a Rojo sourcemap, or `null` for none. */
    readonly sourceMap: string | null
    /** How many files the compiler writes. `"single"` (the default) is one
     *  file holding every module. `"chunks"` keeps what the entry imports in
     *  the entry's file and writes what only an `import()` reaches to files of
     *  their own, loaded when first asked for. `"modules"` writes one file per
     *  module. The parser does not care — it is the compiler's to act on,
     *  and lives here because it belongs to the project. */
    readonly output: OutputMode
    /** Leave out Lua's standard library, which every file otherwise has the
     *  way every TypeScript file has JavaScript's: `print`, `string`, `pcall`.
     *  For a host that offers none of it, or a library of one's own in its
     *  place. `false` unless set. */
    readonly noLib: boolean
    /** Leave out of the bundle what the entry never reaches: declarations
     *  nothing reads, and modules whose exports nothing reads and that do
     *  nothing as they run. The compiler's to act on. `false` unless set. */
    readonly treeShaking: boolean
}

/** See `TiluaConfig.output`. */
export type OutputMode = "single" | "chunks" | "modules"

export interface ConfigProblem {
    /** The file the problem is about: a config file, or a sourcemap it names. */
    readonly file: string
    readonly message: string
    /** 1-based position in `file`, when the problem has one. */
    readonly line?: number
    readonly column?: number
}

export interface ConfigLookup {
    /** The config that applies, if one was found and could be read. */
    readonly config?: TiluaConfig
    readonly problems: readonly ConfigProblem[]
    /** Every config path looked at on the way up, found or not — what a cache
     *  must watch, so that creating or deleting a config is noticed. */
    readonly searched: readonly string[]
}

/** The config that applies to `file`: the nearest one in its folder or above. */
export function findConfig(file: string, host: ProjectHost = nodeHost): ConfigLookup {
    const searched: string[] = []
    let directory = dirname(resolve(file))
    for (;;) {
        const found: string[] = []
        for (const name of CONFIG_FILE_NAMES) {
            const path = join(directory, name)
            searched.push(path)
            if (host.readFile(path) !== undefined) found.push(path)
        }
        if (found.length > 1) {
            const message = `Only one tilua config may be in a folder, but both ${CONFIG_FILE_NAMES.join(" and ")} are in ${directory}`
            return { searched, problems: found.map(path => ({ file: path, message, line: 1, column: 1 })) }
        }
        if (found.length === 1) {
            const { config, problems } = loadConfig(found[0], host)
            return { config, problems, searched }
        }
        const parent = dirname(directory)
        if (parent === directory) return { searched, problems: [] }
        directory = parent
    }
}

const OPTIONS = ["types", "paths", "baseUrl", "sourceMap", "output", "noLib", "treeShaking"] as const
const OUTPUTS = ["single", "chunks", "modules"] as const

/** Read and check one config file. Problems do not stop the rest of it from
 *  applying: an unknown option is reported and the known ones still work. */
export function loadConfig(path: string, host: ProjectHost = nodeHost): { config?: TiluaConfig; problems: ConfigProblem[] } {
    const file = resolve(path)
    const source = host.readFile(file)
    if (source === undefined) return { problems: [{ file, message: "Cannot read the config file" }] }

    let raw: unknown
    try {
        raw = JSON.parse(stripJsonComments(source))
    } catch (error) {
        const message = (error as Error).message
        return { problems: [{ file, message: `Invalid JSON: ${message}`, ...jsonErrorPosition(source, message) }] }
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { problems: [{ file, message: "The config must be a JSON object", line: 1, column: 1 }] }
    }

    const directory = dirname(file)
    const options = raw as Record<string, unknown>
    const problems: ConfigProblem[] = []
    const at = (key: string): { line?: number; column?: number } => keyPosition(source, key)
    const problem = (key: string, message: string): void => { problems.push({ file, message, ...at(key) }) }

    for (const key of Object.keys(options)) {
        if (!(OPTIONS as readonly string[]).includes(key) && key !== "target") {
            problem(key, `Unknown option '${key}'. Options are: ${OPTIONS.join(", ")}`)
        }
    }

    let types: string[] = []
    if (options.types !== undefined) {
        if (Array.isArray(options.types) && options.types.every(t => typeof t === "string")) types = options.types
        else problem("types", "'types' must be an array of strings, such as [\"luau\"]")
    }

    const paths: Record<string, string[]> = {}
    if (options.paths !== undefined) {
        const value = options.paths
        if (value && typeof value === "object" && !Array.isArray(value)) {
            for (const [pattern, targets] of Object.entries(value)) {
                if (Array.isArray(targets) && targets.every(t => typeof t === "string")) paths[pattern] = targets
                else problem(pattern, `'paths' entry '${pattern}' must be an array of strings`)
                if (pattern.split("*").length > 2) problem(pattern, `'paths' pattern '${pattern}' may contain at most one '*'`)
            }
        } else {
            problem("paths", "'paths' must be an object, such as { \"@shared/*\": [\"src/shared/*\"] }")
        }
    }

    let baseUrl = directory
    if (options.baseUrl !== undefined) {
        if (typeof options.baseUrl === "string") baseUrl = resolve(directory, options.baseUrl)
        else problem("baseUrl", "'baseUrl' must be a string")
    }

    let sourceMap: string | null = null
    if (options.sourceMap !== undefined && options.sourceMap !== null) {
        if (typeof options.sourceMap === "string") sourceMap = resolve(directory, options.sourceMap)
        else problem("sourceMap", "'sourceMap' must be a path string, or null for none")
    }

    // The output is Lua that runs anywhere; what more a Lua has is said by
    // the library for it, not by the project.
    if (options.target !== undefined) {
        problem("target", "'target' is gone: the output is Lua that runs on 5.1 to 5.4, LuaJIT and Luau, "
            + "and a library says what more its Lua has — add \"luau\" to 'types' (\"roblox\" loads it)")
    }

    let output: OutputMode = "single"
    if (options.output !== undefined) {
        if (typeof options.output === "string" && (OUTPUTS as readonly string[]).includes(options.output)) {
            output = options.output as OutputMode
        } else {
            problem("output", `'output' must be one of: ${OUTPUTS.join(", ")}`)
        }
    }

    let noLib = false
    if (options.noLib !== undefined) {
        if (typeof options.noLib === "boolean") noLib = options.noLib
        else problem("noLib", "'noLib' must be true or false")
    }

    let treeShaking = false
    if (options.treeShaking !== undefined) {
        if (typeof options.treeShaking === "boolean") treeShaking = options.treeShaking
        else problem("treeShaking", "'treeShaking' must be true or false")
    }

    return { config: { path: file, directory, source, types, paths, baseUrl, sourceMap, output, noLib, treeShaking }, problems }
}

/** Blank out `//` and `/* *\/` comments and trailing commas, keeping every
 *  other character where it was — so a JSON error's position still points
 *  into the original text. */
export function stripJsonComments(text: string): string {
    const out = text.split("")
    let i = 0
    let inString = false
    while (i < text.length) {
        const ch = text[i]
        if (inString) {
            if (ch === "\\") i += 2
            else {
                if (ch === "\"") inString = false
                i++
            }
            continue
        }
        if (ch === "\"") {
            inString = true
            i++
        } else if (ch === "/" && text[i + 1] === "/") {
            while (i < text.length && text[i] !== "\n") out[i++] = " "
        } else if (ch === "/" && text[i + 1] === "*") {
            out[i++] = " "
            out[i++] = " "
            while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
                if (text[i] !== "\n") out[i] = " "
                i++
            }
            if (i < text.length) {
                out[i++] = " "
                out[i++] = " "
            }
        } else if (ch === ",") {
            // A trailing comma: nothing but whitespace (or comments, already
            // blanked or about to be) before the closing bracket.
            let j = i + 1
            while (j < text.length && /\s/.test(text[j])) j++
            if (text[j] === "}" || text[j] === "]") out[i] = " "
            i++
        } else {
            i++
        }
    }
    return out.join("")
}

/** Where a JSON error points, from the position the message gives. */
function jsonErrorPosition(source: string, message: string): { line?: number; column?: number } {
    const lineColumn = /line (\d+) column (\d+)/.exec(message)
    if (lineColumn) return { line: Number(lineColumn[1]), column: Number(lineColumn[2]) }
    const position = /position (\d+)/.exec(message)
    return position ? offsetPosition(source, Number(position[1])) : { line: 1, column: 1 }
}

/** The position of `"key"` in the config text — a good enough anchor for a
 *  problem with that option. */
export function keyPosition(source: string, key: string): { line?: number; column?: number } {
    const offset = source.indexOf(JSON.stringify(key))
    return offset < 0 ? { line: 1, column: 1 } : offsetPosition(source, offset)
}

function offsetPosition(source: string, offset: number): { line: number; column: number } {
    const before = source.slice(0, offset)
    const line = before.split("\n").length
    return { line, column: offset - before.lastIndexOf("\n") }
}
