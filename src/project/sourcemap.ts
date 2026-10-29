/**
 * The instance tree from a Rojo sourcemap, as types.
 *
 * `rojo sourcemap` writes the tree a project builds —
 * `{ name, className, filePaths?, children? }` all the way down. Each instance
 * becomes a class extending its Roblox class, with a member per child and
 * `Parent` narrowed to the parent instance. It is still that class — a
 * `Folder` in the tree passes wherever a `Folder` is expected. From that:
 *
 *   - a `DataModel` root declares `game`, and its `Workspace` child `workspace`;
 *   - a file the tree maps declares `script` as its own instance, so
 *     `script.Parent.Remotes` is typed.
 *
 * A sourcemap lists the Luau files Rojo syncs; a `.tilua` file matches the
 * entry with the same path apart from the extension.
 *
 * An instance with children also answers `FindFirstChild` and `WaitForChild`
 * for each of them by name — `workspace:WaitForChild("Baseplate")` is that
 * part, and the editor offers the names — and as Roblox declares them for
 * any other name.
 *
 * The tree can also be read straight off a Rojo project (`rojoSourceMap`):
 * the project's own nodes, and below each `$path` the files there, as Rojo
 * would turn them into instances. A config that names no sourcemap reads the
 * `default.project.json` beside it (`sourceMapOf`).
 *
 * The types are emitted as `.d.tilua` source and parsed, so they go through
 * exactly the same resolution as a hand-written definitions file — recursive
 * references (`Parent`) included.
 */
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path"
import { parse } from "@ast/builders"
import type { Program } from "@ast/nodes"
import { isIdentifier } from "../luau"
import type { TiluaConfig } from "./config"
import { nodeHost, type ProjectHost } from "./host"

export interface SourceMapNode {
    name: string
    className: string
    filePaths?: string[]
    children?: SourceMapNode[]
}

export interface SourceMapOptions {
    /** The type names the loaded libraries define. An instance of a class not
     *  among them is typed as `Instance`. */
    readonly classes: ReadonlySet<string>
    /** A class's own member names. A child whose name a member already takes
     *  is left out — Roblox resolves the member first. Defaults to the members
     *  every instance has. */
    readonly membersOf?: (className: string) => ReadonlySet<string>
}

export interface SourceMapTypes {
    /** The tree's classes, and `game` / `workspace` for a place. */
    readonly program: Program
    /** `declare script: ...` for a file the tree maps, or `undefined`. */
    scriptFor(file: string): Program | undefined
}

const INSTANCE_MEMBERS: ReadonlySet<string> = new Set(["Name", "ClassName", "Parent", "Archivable"])
const SCRIPT_EXTENSIONS = new Set([".tilua", ".luau", ".lua"])

export function sourceMapTypes(
    text: string,
    path: string,
    options: SourceMapOptions,
): { types?: SourceMapTypes; problem?: string } {
    let root: unknown
    try {
        root = JSON.parse(text)
    } catch (error) {
        return { problem: `Invalid sourcemap: ${(error as Error).message}` }
    }
    if (!isNode(root)) return { problem: "Invalid sourcemap: the root must be an object with 'name' and 'className'" }

    const directory = dirname(resolve(path))
    const lines: string[] = []
    const aliasOfFile = new Map<string, string>()
    const used = new Set<string>()

    const aliasOfNode = new Map<SourceMapNode, string>()

    const aliasFor = (segments: readonly string[]): string => {
        const base = `SourceMap_${segments.map(s => s.replace(/[^A-Za-z0-9_]/g, "_")).join("_")}`
        let alias = base
        for (let n = 2; used.has(alias); n++) alias = `${base}_${n}`
        used.add(alias)
        return alias
    }

    const visit = (node: SourceMapNode, segments: readonly string[], parent: string | undefined): string => {
        const alias = aliasFor(segments)
        aliasOfNode.set(node, alias)
        for (const filePath of node.filePaths ?? []) aliasOfFile.set(fileKey(resolve(directory, filePath)), alias)

        const className = isIdentifier(node.className) && options.classes.has(node.className)
            ? node.className
            : "Instance"
        const taken = options.membersOf?.(className) ?? INSTANCE_MEMBERS

        const members: string[] = []
        if (parent) members.push(`Parent: ${parent}`)
        const named = new Set<string>()
        // Each child by its name, the first of a name as Roblox finds it —
        // then any name, as Roblox declares them.
        const found = new Map<string, string>()
        for (const child of node.children ?? []) {
            if (!isNode(child)) continue
            const childAlias = visit(child, [...segments, child.name], alias)
            if (!found.has(child.name)) found.set(child.name, childAlias)
            // Only a name `.` can reach, not already a member, and the first
            // child of that name — `FindFirstChild` returns the first. A
            // service is the exception: `game.ReplicatedStorage` is a member
            // of `DataModel` typed as that very class, and the child is that
            // service, so its tree only narrows what the member already says.
            const service = child.name === child.className && options.classes.has(child.className)
            if (!isIdentifier(child.name) || (taken.has(child.name) && !service) || named.has(child.name)) continue
            named.add(child.name)
            members.push(`${child.name}: ${childAlias}`)
        }
        if (found.size) {
            for (const [name, childAlias] of found) {
                const literal = JSON.stringify(name)
                members.push(`FindFirstChild: (self: Instance, name: ${literal}, recursive?: boolean) => ${childAlias} | nil`)
                members.push(`WaitForChild: (self: Instance, name: ${literal}) => ${childAlias}`)
                members.push(`WaitForChild: (self: Instance, name: ${literal}, timeout: number) => ${childAlias} | nil`)
            }
            members.push("FindFirstChild: <T = Instance>(self: Instance, name: string, recursive?: boolean) => T | nil")
            members.push("WaitForChild: <T = Instance>(self: Instance, name: string) => T")
            members.push("WaitForChild: <T = Instance>(self: Instance, name: string, timeout: number) => T | nil")
        }

        lines.push(`declare class ${alias} extends ${className} { ${members.join(", ")} }`)
        return alias
    }

    const rootAlias = visit(root, [root.name], undefined)
    if (root.className === "DataModel") {
        lines.push(`declare game: ${rootAlias}`)
        const workspace = (root.children ?? []).find(child => isNode(child) && child.className === "Workspace")
        const workspaceAlias = workspace && aliasOfNode.get(workspace)
        if (workspaceAlias) lines.push(`declare workspace: ${workspaceAlias}`)
    }

    let program: Program
    try {
        program = parse(lines.join("\n"))
    } catch (error) {
        return { problem: `Could not turn the sourcemap into types: ${(error as Error).message}` }
    }

    return {
        types: {
            program,
            scriptFor(file) {
                const alias = aliasOfFile.get(fileKey(file))
                return alias ? parse(`declare script: ${alias}`) : undefined
            },
        },
    }
}

/** Script files, by what their name ends with, as Rojo makes them. A
 *  `.tilua` is the `.luau` it compiles to. */
const SCRIPT_FILES: readonly [RegExp, string][] = [
    [/\.(server|legacy|plugin)\.(luau|lua|tilua)$/, "Script"],
    [/\.(client|local)\.(luau|lua|tilua)$/, "LocalScript"],
    [/\.(luau|lua|tilua)$/, "ModuleScript"],
]

/** The instance Rojo makes of a file that is not a script, by its extension. */
const OTHER_FILES: readonly [RegExp, string][] = [
    [/\.model\.json$/, ""],
    [/\.(rbxm|rbxmx)$/, "Instance"],
    [/\.txt$/, "StringValue"],
    [/\.csv$/, "LocalizationTable"],
    [/\.(json|toml|yaml|yml)$/, "ModuleScript"],
]

/**
 * The tree the Rojo project at `projectFile` builds, as a sourcemap's root:
 * the project's nodes, and under each `$path` what Rojo makes of the files
 * there — a folder a `Folder`, or the script its `init` file is; `.server`
 * a `Script`, `.client` a `LocalScript`, any other script a `ModuleScript`;
 * a `.tilua` as the `.luau` it compiles to. A script's `filePaths` name it in
 * the `$path` folder.
 *
 * `sourceFolder` says where a `$path` folder's files are written, when that
 * is elsewhere — a project that reads what tilua builds into `out` lists the
 * `src` it builds from, so a `.tilua` not built yet is in the tree already.
 */
export function rojoSourceMap(
    projectFile: string,
    host: ProjectHost = nodeHost,
    options: { readonly sourceFolder?: (folder: string) => string } = {},
): { root?: SourceMapNode; problem?: string } {
    const text = host.readFile(projectFile)
    if (text === undefined) return { problem: `Cannot read the Rojo project ${projectFile}` }
    let project: { name?: unknown; tree?: unknown }
    try {
        project = JSON.parse(text) as typeof project
    } catch (error) {
        return { problem: `Invalid Rojo project: ${(error as Error).message}` }
    }
    if (!project || typeof project !== "object" || !project.tree || typeof project.tree !== "object") {
        return { problem: "Invalid Rojo project: it has no 'tree'" }
    }
    const directory = dirname(resolve(projectFile))
    const sourceOf = options.sourceFolder ?? (folder => folder)

    /** The children Rojo makes of the files in `folder` (where they are
     *  read from), named as they are in `mapped` (where the project says). */
    const folderChildren = (folder: string, mapped: string, depth: number): SourceMapNode[] => {
        if (depth > 32) return []
        const children: SourceMapNode[] = []
        for (const name of host.readDirectory?.(folder) ?? []) {
            if (name.startsWith(".") || name === "node_modules") continue
            children.push(folderNode(join(folder, name), join(mapped, name), name, depth + 1))
        }
        for (const name of host.listFiles?.(folder) ?? []) {
            if (name.startsWith(".") || /^init\./.test(name)) continue
            const child = fileNode(join(folder, name), join(mapped, name), name)
            if (child) children.push(child)
        }
        return children
    }
    /** A folder: a `Folder`, or the script its `init` file is. */
    const folderNode = (folder: string, mapped: string, name: string, depth: number): SourceMapNode => {
        const files = host.listFiles?.(folder) ?? []
        const init = files.find(file => /^init\./.test(file) && SCRIPT_FILES.some(([pattern]) => pattern.test(file)))
        const className = init ? SCRIPT_FILES.find(([pattern]) => pattern.test(init))![1] : classOfMeta(join(folder, "init.meta.json")) ?? "Folder"
        return {
            name, className,
            ...(init && { filePaths: [join(mapped, init)] }),
            children: folderChildren(folder, mapped, depth),
        }
    }
    /** A file, or `undefined` for one Rojo makes nothing of. */
    const fileNode = (file: string, mapped: string, name: string): SourceMapNode | undefined => {
        if (name.endsWith(".d.tilua") || name.endsWith(".meta.json") || name.endsWith(".project.json")) return undefined
        for (const [pattern, className] of SCRIPT_FILES) {
            if (pattern.test(name)) return { name: name.replace(pattern, ""), className, filePaths: [mapped] }
        }
        for (const [pattern, className] of OTHER_FILES) {
            if (!pattern.test(name)) continue
            const model = className === "" ? classOfModel(file) : className
            return { name: name.replace(pattern, ""), className: model }
        }
        return undefined
    }
    const classOfModel = (file: string): string => {
        try {
            const model = JSON.parse(host.readFile(file) ?? "{}") as { className?: unknown; ClassName?: unknown }
            const className = model.className ?? model.ClassName
            return typeof className === "string" ? className : "Instance"
        } catch {
            return "Instance"
        }
    }
    const classOfMeta = (file: string): string | undefined => {
        const meta = host.readFile(file)
        if (meta === undefined) return undefined
        try {
            const className = (JSON.parse(meta) as { className?: unknown }).className
            return typeof className === "string" ? className : undefined
        } catch {
            return undefined
        }
    }

    /** A node of the project: what its `$path` makes, its `$className`, and
     *  its own children after the ones its `$path` has. */
    const projectNode = (node: Record<string, unknown>, name: string, parentClass: string | undefined, depth: number): SourceMapNode => {
        const path = typeof node.$path === "string" ? node.$path
            : node.$path && typeof node.$path === "object" ? (node.$path as { optional?: unknown }).optional : undefined
        let made: SourceMapNode | undefined
        if (typeof path === "string") {
            const mapped = resolve(directory, path)
            const source = sourceOf(mapped)
            const isFolder = host.readDirectory?.(source) !== undefined
            made = isFolder ? folderNode(source, mapped, name, depth) : fileNode(source, mapped, basename(mapped))
            if (made) made.name = name
        }
        // A service under the DataModel is the class of its name, whatever
        // folder its `$path` fills it from.
        const className = typeof node.$className === "string" ? node.$className
            : parentClass === "DataModel" ? name
            : made?.className ?? "Folder"
        const children = [...(made?.children ?? [])]
        for (const [key, child] of Object.entries(node)) {
            if (key.startsWith("$") || !child || typeof child !== "object") continue
            children.push(projectNode(child as Record<string, unknown>, key, className, depth + 1))
        }
        return { name, className, ...(made?.filePaths && { filePaths: made.filePaths }), children }
    }

    const name = typeof project.name === "string" ? project.name : basename(directory)
    return { root: projectNode(project.tree as Record<string, unknown>, name, undefined, 0) }
}

/** The project file a config reads its instance tree from, and whether the
 *  config named it. */
function sourceMapPath(config: TiluaConfig, host: ProjectHost): { path: string; named: boolean } | undefined {
    if (config.sourceMap === null) return undefined
    if (config.sourceMap !== undefined) return { path: config.sourceMap, named: true }
    const project = join(config.directory, "default.project.json")
    return host.readFile(project) !== undefined ? { path: project, named: false } : undefined
}

/**
 * The instance tree a config's project has, as a sourcemap's text for
 * `sourceMapTypes`: the sourcemap `sourceMap` names; or the Rojo project it
 * names (`*.project.json`), read as the tree it builds; or, when it names
 * neither, the `default.project.json` beside the config. `undefined` when
 * there is none — or when the config named none and the project is not one.
 * `named` is false for the one found by itself, whose problems are no one's.
 */
export function sourceMapOf(
    config: TiluaConfig,
    host: ProjectHost = nodeHost,
): { path: string; text: string; named: boolean } | { path: string; problem: string; named: boolean } | undefined {
    const found = sourceMapPath(config, host)
    if (!found) return undefined
    const { path, named } = found
    if (!path.endsWith(".project.json")) {
        const text = host.readFile(path)
        return text === undefined ? { path, named, problem: `Cannot find the sourceMap file ${path}` } : { path, named, text }
    }
    // A project that reads what tilua builds into its own `outDir` is listed
    // from `rootDir`, which that is built from.
    const mirrored = config.output === "files" && resolve(config.outDir) !== resolve(config.rootDir)
    const sourceFolder = (folder: string): string => {
        if (!mirrored) return folder
        const below = relative(config.outDir, folder)
        return below.startsWith("..") || isAbsolute(below) ? folder : join(config.rootDir, below)
    }
    const { root, problem } = rojoSourceMap(path, host, { sourceFolder })
    return root ? { path, named, text: JSON.stringify(root) } : { path, named, problem: problem! }
}

function isNode(value: unknown): value is SourceMapNode {
    if (!value || typeof value !== "object") return false
    const node = value as Record<string, unknown>
    return typeof node.name === "string" && typeof node.className === "string"
}

/** A script file without its extension — the part a `.tilua` file and the
 *  Luau file synced for it share. */
function fileKey(path: string): string {
    const extension = extname(path)
    const bare = SCRIPT_EXTENSIONS.has(extension) ? path.slice(0, -extension.length) : path
    const normalized = resolve(bare)
    return process.platform === "win32" ? normalized.toLowerCase() : normalized
}
