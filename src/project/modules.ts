/**
 * Which file an `import` means.
 *
 * `./x` and `../x` resolve from the importing file. Anything else goes
 * through the config's `paths`, tsconfig-style: an exact pattern wins, then
 * the matching `*` pattern with the longest prefix, and each of its targets —
 * relative to `baseUrl` — is tried in order. In every case the extension may be
 * left off, and a folder means its `index.tilua` — or its `init.tilua`, the
 * folder-module of Luau and Rojo, which compiles to the `init.luau` they read
 * as the folder itself.
 */
import { dirname, join, resolve } from "node:path"
import type { ImportExpression, Program } from "@ast/nodes"
import type { TiluaConfig } from "./config"
import { nodeHost, type ProjectHost } from "./host"

/** Every file `specifier` could mean from `fromFile`, in the order they are
 *  tried. A resolver that caches should watch all of them: creating an earlier
 *  candidate changes what the import means. */
export function moduleCandidates(fromFile: string, specifier: string, config?: TiluaConfig): string[] {
    const bases = specifier.startsWith("./") || specifier.startsWith("../")
        ? [resolve(dirname(fromFile), specifier)]
        : config ? aliasTargets(config, specifier) : []
    return bases.flatMap(base => (base.endsWith(".tilua")
        ? [base]
        : [`${base}.tilua`, `${base}.d.tilua`, join(base, "index.tilua"), join(base, "init.tilua")]))
}

/** The file `specifier` names from `fromFile`, if it exists. */
export function resolveModulePath(
    fromFile: string,
    specifier: string,
    config?: TiluaConfig,
    host: ProjectHost = nodeHost,
): string | undefined {
    return moduleCandidates(fromFile, specifier, config).find(path => host.readFile(path) !== undefined)
}

function aliasTargets(config: TiluaConfig, specifier: string): string[] {
    let match: { pattern: string; wildcard: string } | undefined
    let prefixLength = -1
    for (const pattern of Object.keys(config.paths)) {
        const star = pattern.indexOf("*")
        if (star < 0) {
            if (pattern === specifier) {
                match = { pattern, wildcard: "" }
                break
            }
            continue
        }
        const prefix = pattern.slice(0, star)
        const suffix = pattern.slice(star + 1)
        const fits = specifier.length >= prefix.length + suffix.length
            && specifier.startsWith(prefix) && specifier.endsWith(suffix)
        if (fits && prefix.length > prefixLength) {
            prefixLength = prefix.length
            match = { pattern, wildcard: specifier.slice(prefix.length, specifier.length - suffix.length) }
        }
    }
    if (!match) return []
    const { pattern, wildcard } = match
    return config.paths[pattern].map(target => resolve(config.baseUrl, target.replace("*", wildcard)))
}

/** Every `import("...")` in `program`, wherever it is written — in the order
 *  they are written. A module they name belongs to the project as much as one
 *  an `import` statement names, though nothing says so at the top of the file. */
export function importExpressions(program: Program): ImportExpression[] {
    const out: ImportExpression[] = []
    const visit = (value: unknown): void => {
        if (!value || typeof value !== "object") return
        if (Array.isArray(value)) return void value.forEach(visit)
        const record = value as Record<string, unknown>
        if (record.type === "ImportExpression") out.push(value as ImportExpression)
        for (const [key, child] of Object.entries(record)) {
            if (key !== "line" && key !== "column") visit(child)
        }
    }
    visit(program.body)
    return out
}
