import { parseWithRecovery, analyzeScopes, analyzeTypes, formatType } from "../src/index"
import { readFileSync } from "fs"
const src = readFileSync(process.argv[2], "utf8")
const { program, errors } = parseWithRecovery(src)
const scopes = analyzeScopes(program); const t = analyzeTypes(program, scopes)
console.log("errors:", [...errors, ...scopes.diagnostics].map(e => e.message))
for (const d of t.diagnostics) console.log(`  ${d.severity ?? "error"} ${d.node.line.start}: ${d.message}`)
for (const [id, ty] of t.bindingType) { const b = scopes.bindings.get(id)!; if (!b.isBuiltin && /^r/.test(b.name)) console.log(`  ${b.name}: ${formatType(ty)}`) }
console.log([...t.joins].map(([n, j]) => `${n.line.start}:${j}`).join(" "))
