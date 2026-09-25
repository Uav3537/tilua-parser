/**
 * Writing Luau source as text: what a name may be and how a string is quoted.
 *
 * The compiler emits Luau, a lowering plugin hands back Luau expressions, and
 * a server filling placeholders into a bundle writes Luau strings. Each needs
 * the same few rules, and they live here so none of them keeps its own copy.
 * Nothing here parses or runs Luau.
 */

/** Luau's reserved words. tilua reserves most of them too — `local` is the
 *  exception, so a tilua name can still be one of these. */
export const LUAU_KEYWORDS: ReadonlySet<string> = new Set([
    "and", "break", "do", "else", "elseif", "end", "false", "for", "function", "if", "in",
    "local", "nil", "not", "or", "repeat", "return", "then", "true", "until", "while",
])

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Is `name` shaped like a name — a letter or `_`, then letters, digits and
 *  `_`? tilua's and Luau's names are both this shape; whether it is also a
 *  keyword is another question (`isLuauName`). */
export function isIdentifier(name: string): boolean {
    return IDENTIFIER.test(name)
}

/** Can `name` be written bare in Luau — as a variable, `t.name` or `{ name = v }`? */
export function isLuauName(name: string): boolean {
    return IDENTIFIER.test(name) && !LUAU_KEYWORDS.has(name)
}

const NAMED_ESCAPES: Readonly<Record<string, string>> = {
    "\\": "\\\\", "\"": "\\\"", "\n": "\\n", "\r": "\\r", "\t": "\\t",
}

/** `text` as the inside of a double-quoted Luau string, without the quotes:
 *  for splicing into a `"..."` that is already written.
 *
 *  Every control character is escaped, as `\n` where Luau has a name for it and
 *  as three decimal digits otherwise — always three, so a digit that follows
 *  (`"\1" .. "2"`) is never read as part of the escape. Not `JSON.stringify`:
 *  its `\u0001` is not a Luau escape. Anything else, `é` or `한` included, is
 *  written as it is; Luau source is UTF-8. */
export function escapeLuauString(text: string): string {
    return text.replace(/[\\"\x00-\x1f\x7f]/g, c =>
        NAMED_ESCAPES[c] ?? `\\${c.charCodeAt(0).toString().padStart(3, "0")}`)
}

/** `text` as a double-quoted Luau string literal: `"a\nb"`. */
export function luauString(text: string): string {
    return `"${escapeLuauString(text)}"`
}
