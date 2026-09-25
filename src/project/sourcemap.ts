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
 * The types are emitted as `.d.tilua` source and parsed, so they go through
 * exactly the same resolution as a hand-written definitions file — recursive
 * references (`Parent`) included.
 */
import { dirname, extname, resolve } from "node:path"
import { parse } from "@ast/builders"
import type { Program } from "@ast/nodes"
import { isIdentifier } from "../luau"

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
        for (const child of node.children ?? []) {
            if (!isNode(child)) continue
            const childAlias = visit(child, [...segments, child.name], alias)
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
