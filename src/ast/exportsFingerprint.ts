/**
 * Telling whether a module's exports changed, for whoever analyzes a project: an
 * import cycle is analyzed over until its exports come to rest.
 */
import type { ModuleExports } from "./analyzeTypes"
import type { GenericRefType } from "./typeModel"
import type { Program } from "./nodes"

/** The classes a set of definitions declares. */
export function classesOf(libs: readonly Program[]): Set<string> {
    const names = new Set<string>()
    for (const lib of libs) {
        for (const statement of lib.body.statements) {
            if (statement.type === "DeclareClassStatement") names.add(statement.name.name)
        }
    }
    return names
}

/**
 * Everything a module's exports say, as a string: equal strings, equal
 * exports, as far as any module importing them could tell.
 *
 * Types are plain data, so this is a walk over the objects, with a number
 * standing in for one already written — types are recursive. What it leaves
 * out is only what cannot differ: a library class is written as its name,
 * since the libraries are the same for both analyses or the importing module
 * would be out of date anyway (and writing one out would write the engine);
 * a `private` member's owner is a node, told apart by identity alone. A ref
 * to an alias is written with what the alias resolves to in the module that
 * wrote it, which is where the alias's own changes show.
 *
 * Something too big to be worth comparing gives `undefined`.
 */
export function exportsFingerprint(exports: ModuleExports, libraryClasses: ReadonlySet<string>): string | undefined {
    const LIMIT = 200_000
    const out: string[] = []
    const ids = new Map<object, number>()
    const expanding = new Set<string>()
    const idOf = (value: object): number => {
        let id = ids.get(value)
        if (id === undefined) ids.set(value, id = ids.size)
        return id
    }
    const write = (value: unknown): boolean => {
        if (out.length > LIMIT) return false
        if (value === null || typeof value !== "object") {
            out.push(typeof value === "function" ? "fn" : value === undefined ? "u" : JSON.stringify(value))
            return true
        }
        const seen = ids.get(value)
        if (seen !== undefined) {
            out.push(`#${seen}`)
            return true
        }
        idOf(value)
        if (value instanceof Map) {
            out.push("M{")
            for (const [key, entry] of value) {
                out.push(String(key), ":")
                if (!write(entry)) return false
            }
            out.push("}")
            return true
        }
        if (Array.isArray(value)) {
            out.push("[")
            for (const entry of value) if (!write(entry)) return false
            out.push("]")
            return true
        }
        const record = value as Record<string, unknown>
        if (record.kind === "object" && record.class) {
            const info = record.class as { name: string; typeArguments?: unknown }
            if (libraryClasses.has(info.name)) {
                out.push(`C:${info.name}`)
                return write(info.typeArguments)
            }
        }
        if (record.kind === "genericRef" && record.origin) {
            const ref = record as unknown as GenericRefType
            const key = `${idOf(ref.origin!)}:${ref.name}`
            out.push(`R:${ref.name}<`)
            if (!write(ref.typeArguments)) return false
            out.push(">")
            if (expanding.has(key)) return true
            expanding.add(key)
            try {
                return write(ref.origin!.expand(ref))
            } finally {
                expanding.delete(key)
            }
        }
        out.push("{")
        for (const key of Object.keys(record)) {
            if (key === "origin" || key === "owner") continue
            out.push(key, "=")
            if (!write(record[key])) return false
        }
        out.push("}")
        return true
    }
    const whole = { values: exports.values, types: exports.types, default: exports.default }
    return write(whole) ? out.join(" ") : undefined
}
