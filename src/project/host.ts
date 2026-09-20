/**
 * How the project functions reach files.
 *
 * The default reads the disk. A language server passes its own, so an open,
 * unsaved document is read in preference to the disk and every read can be
 * recorded — which is what lets it tell when a config, a type library or a
 * sourcemap changed under a cached result.
 */
import { readdirSync, readFileSync, statSync } from "node:fs"

export interface ProjectHost {
    /** A file's text, or `undefined` when there is no such file. */
    readFile(path: string): string | undefined
    /** The names of the folders in a folder, or `undefined` when there is no
     *  such folder. Only a `types` entry with a `*` in it lists anything; a
     *  host without this cannot load one. */
    readDirectory?(path: string): string[] | undefined
}

export const nodeHost: ProjectHost = {
    readFile(path) {
        try {
            return statSync(path).isFile() ? readFileSync(path, "utf8") : undefined
        } catch {
            return undefined
        }
    },
    readDirectory(path) {
        try {
            return readdirSync(path, { withFileTypes: true })
                .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
                .map(entry => entry.name)
        } catch {
            return undefined
        }
    },
}
