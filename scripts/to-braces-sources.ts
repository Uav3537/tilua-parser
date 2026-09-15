/**
 * The same rewrite as `to-braces.ts`, for tilua written inside a TypeScript
 * file — which is where the test suites keep most of it.
 *
 * Two shapes hold a snippet:
 *
 *     analyze([ "function f()", "    return 1", "end" ].join("\n"))
 *     analyze(`function f()\n    return 1\nend`)
 *
 * and a plain double-quoted string with `\n` in it is a third. Each is
 * decoded to the tilua it stands for, rewritten, and written back in the shape
 * it came from.
 *
 * A string it cannot read as tilua, or that the rewrite leaves alone, is left
 * exactly as it was — which is what keeps the *expected* strings beside the
 * snippets (a hover's markdown, a line of emitted Luau) out of it.
 *
 *     npx tsx scripts/to-braces-sources.ts <file>... [--check]
 */
import { readFileSync, writeFileSync } from "node:fs"
import { parse } from "@ast/builders"
import { toBraces } from "./to-braces.js"

/** The tilua a snippet stands for, rewritten — or `undefined` when this is not
 *  a snippet, or has nothing to rewrite. */
function rewrite(source: string): string | undefined {
    // Markdown a test expects back, not tilua to read.
    if (source.includes("```")) return undefined
    let before
    try {
        before = JSON.stringify(parse(source), withoutSpans)
    } catch {
        return undefined
    }
    let after: string
    try {
        after = toBraces(source)
    } catch {
        return undefined
    }
    if (after === source) return undefined
    try {
        if (JSON.stringify(parse(after), withoutSpans) !== before) return undefined
    } catch {
        return undefined
    }
    return after
}

function withoutSpans(key: string, value: unknown): unknown {
    return key === "line" || key === "column" ? undefined : value
}

/** A TypeScript string literal's value. */
function decode(literal: string): string | undefined {
    try {
        return JSON.parse(literal.startsWith("`")
            ? `"${literal.slice(1, -1).replace(/"/g, '\\"')}"`
            : literal) as string
    } catch {
        return undefined
    }
}

/** The same literal, holding `value`, in the quotes it came in. */
function encode(value: string, like: string): string {
    const json = JSON.stringify(value)
    return like.startsWith("`") ? `\`${json.slice(1, -1).replace(/\\"/g, '"')}\`` : json
}

const LITERAL = String.raw`"(?:[^"\\\n]|\\.)*"`
/** A line of a snippet: either kind of quote, since an array mixes them where
 *  a line has a `"` of its own. */
const ELEMENT = String.raw`(?:${LITERAL}|\`(?:[^\`\\$]|\\.)*\`)`
const ARRAY = new RegExp(String.raw`\[\s*(?:${ELEMENT},?\s*)+\]\.join\("\\n"\)`, "g")
const TEMPLATE = /`(?:[^`\\$]|\\.)*`/g
const STRING = new RegExp(LITERAL, "g")

export function convert(text: string): string {
    // Arrays first: their elements are strings too, and the whole array is the
    // snippet rather than any one line of it.
    let out = text.replace(ARRAY, match => {
        const parts = match.match(new RegExp(ELEMENT, "g")) ?? []
        const lines = parts.map(decode)
        if (lines.some(line => line === undefined)) return match
        const rewritten = rewrite((lines as string[]).join("\n"))
        if (rewritten === undefined) return match
        const indent = /\n(\s*)"/.exec(match)?.[1] ?? "        "
        const close = indent.slice(0, -4)
        return `[\n${rewritten.split("\n").map(l => `${indent}${JSON.stringify(l)},`).join("\n")}\n${close}].join("\\n")`
    })

    out = out.replace(TEMPLATE, match => {
        const source = decode(match)
        if (source === undefined) return match
        const rewritten = rewrite(source)
        return rewritten === undefined ? match : encode(rewritten, match)
    })

    out = out.replace(STRING, match => {
        const source = decode(match)
        if (source === undefined) return match
        const rewritten = rewrite(source)
        return rewritten === undefined ? match : encode(rewritten, match)
    })

    return out
}

const args = process.argv.slice(2)
const check = args.includes("--check")
const targets = args.filter(a => !a.startsWith("--"))
if (!targets.length) {
    console.error("usage: tsx scripts/to-braces-sources.ts <file>... [--check]")
    process.exit(2)
}

let changed = 0
for (const target of targets) {
    const before = readFileSync(target, "utf8")
    const after = convert(before)
    if (after === before) continue
    changed++
    if (!check) writeFileSync(target, after)
    console.log(`${check ? "would rewrite" : "rewrote"} ${target}`)
}
console.log(`${changed} file${changed === 1 ? "" : "s"}`)
