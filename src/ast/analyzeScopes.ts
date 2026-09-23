import type { TypeNode, TypeofTypeNode } from "./nodes"
// ============================================================
// Scope / binding analysis
// ------------------------------------------------------------
// Walks the AST once and resolves every variable-position
// `Identifier` to a `Binding`. Locals and globals are modeled
// symmetrically: both live in `bindings`, both are reachable
// through `bindingOf`, and both expose `references`. The only
// difference is `Binding.kind` and whether `declarationNode`
// is set.
//
// This pass does NOT touch the AST — it produces a side table
// (`ScopeAnalysis`) that later passes (rename, dead-code, a
// language server, ...) read from. Nodes are used as map keys,
// so re-running this pass after rebuilding the AST is fine and
// cheap; there's nothing to keep in sync by hand.
// ============================================================

import type {
    Program, Block, Statement, Expression, Identifier, TypedIdentifier,
    FunctionParameter, FunctionBody, TableField, ClassMember, GenericTypeParameter,
    BindingTarget, ObjectPattern, ArrayPattern, IdentifierPattern,
} from "./nodes"

// --------------------------------------------------------
// Public types
// --------------------------------------------------------

export type BindingId = number

export type BindingKind =
    | "local"        // `local x = ...`
    | "param"        // function parameter
    | "self"         // implicit `self` param from `function T:m()`
    | "for-numeric"  // `for i = 1, 10 do`
    | "for-generic"  // `for k, v in ... do`
    | "global"       // no enclosing declaration found

/** A node that can serve as a binding's "declared here" site. */
export type DeclarationNode = Identifier | TypedIdentifier | FunctionParameter | IdentifierPattern

export interface Binding {
    readonly id: BindingId
    /** Name at the point this binding was created. Rename passes update
     *  this and every node in `references` (+ `declarationNode`) together —
     *  this field is just what analysis saw, not a source of truth after a
     *  rename pass has run. */
    name: string
    readonly kind: BindingKind
    /** Absent for a `global` binding that was never assigned to in this
     *  file (e.g. only ever read, or a pre-registered builtin). */
    declarationNode?: DeclarationNode
    /** Every Identifier *usage* resolved to this binding (does not include
     *  `declarationNode` itself). */
    readonly references: Identifier[]
    /** True for globals pre-registered via `analyzeScopes`'s
     *  `builtinGlobals` option (e.g. `game`, `script`, `print`). Such
     *  bindings are never given a `declarationNode` from assignment
     *  inference, since they're not really "defined" in this file. */
    isBuiltin?: boolean
    /** True for a binding that cannot be reassigned: a `const`, an import, or
     *  a function declaration. */
    isConst?: boolean
    /** Set when the binding comes from something other than `const` / `let`,
     *  which is also what an error about reassigning it names. */
    declaredBy?: "import" | "namespace" | "function" | "type" | "class"
}

export interface ScopeDiagnostic {
    /** the offending node (redeclaration site, or assignment target) */
    node: { line: { start: number; end: number }; column: { start: number; end: number } }
    message: string
    kind: "redeclare" | "const-assign" | "type-only" | "undeclared" | "use-before-define"
}

export interface ScopeAnalysis {
    /** Every Identifier that appears in a variable *usage* position (i.e.
     *  every node also reachable through some `Binding.references`, plus
     *  `FunctionDeclarationStatement.target.base`), mapped to its binding.
     *  Property names, method names, table field names, and type-position
     *  identifiers are never entered here — they aren't variable refs. */
    readonly bindingOf: Map<Identifier | IdentifierPattern, BindingId>
    readonly bindings: Map<BindingId, Binding>
    /** Redeclaration-in-same-scope and assignment-to-const errors. */
    readonly diagnostics: ScopeDiagnostic[]
    /** Convenience: every global binding's id, keyed by name. Global
     *  bindings have no lexical scope, so this is the closest thing to
     *  "the" scope for them — and later a multi-file language server can
     *  swap this map out for a project-wide registry without changing
     *  anything else about this shape. */
    readonly globalsByName: Map<string, BindingId>
}

export interface AnalyzeScopesOptions {
    /** Names to pre-register as global bindings with `isBuiltin: true`
     *  before the walk starts (e.g. Roblox/Luau standard globals:
     *  `game`, `script`, `workspace`, `print`, `pairs`, ...). Referencing
     *  one of these does not count as "defining" it, so `declarationNode`
     *  is left unset even though the binding exists up front. */
    builtinGlobals?: readonly string[]
    /** Report each read of a name nothing declares — not a local, not one of
     *  `builtinGlobals`, not `declare`d in the file, never assigned as a
     *  global: "Cannot find name 'x'", as TypeScript says. Only meaningful
     *  when `builtinGlobals` lists everything the file's type libraries
     *  declare, so it is off unless asked for. */
    reportUndeclared?: boolean
}

// --------------------------------------------------------
// Convenience accessors
// --------------------------------------------------------

export function getBinding(analysis: ScopeAnalysis, id: Identifier | IdentifierPattern): Binding | undefined {
    const bindingId = analysis.bindingOf.get(id)
    return bindingId === undefined ? undefined : analysis.bindings.get(bindingId)
}

export function isGlobal(binding: Binding): boolean {
    return binding.kind === "global"
}

/** True if a global binding was never assigned to anywhere in this file
 *  (and isn't a pre-registered builtin) — i.e. it's read-only and
 *  undeclared, which is almost always a typo rather than an intentional
 *  implicit global. Handy for a "possibly undefined global" diagnostic. */
export function isUnassignedGlobal(binding: Binding): boolean {
    return binding.kind === "global" && !binding.isBuiltin && binding.declarationNode === undefined
}

// --------------------------------------------------------
// Internal scope tree
// --------------------------------------------------------

interface Scope {
    readonly parent: Scope | null
    readonly declarations: Map<string, BindingId>
}

function childScope(parent: Scope): Scope {
    return { parent, declarations: new Map() }
}

// --------------------------------------------------------
// Analyzer
// --------------------------------------------------------

class Analyzer {
    private nextId = 0
    private readonly bindingOf = new Map<Identifier | IdentifierPattern, BindingId>()
    private readonly bindings = new Map<BindingId, Binding>()
    private readonly diagnostics: ScopeDiagnostic[] = []
    private readonly globalScope: Scope = { parent: null, declarations: new Map() }

    constructor(private readonly options: AnalyzeScopesOptions) {
        // The language's own: what the script was started with. Every file
        // sees it, library or none.
        for (const name of [...LANGUAGE_GLOBALS, ...options.builtinGlobals ?? []]) {
            const id = this.getOrCreateGlobalBinding(name)
            this.bindings.get(id)!.isBuiltin = true
        }
    }

    run(program: Program): ScopeAnalysis {
        this.moduleScope = childScope(this.globalScope)
        this.visitBlock(program.body, this.moduleScope)
        this.resolveForwardReferences()
        if (this.options.reportUndeclared) this.reportUndeclared(program)
        return {
            bindingOf: this.bindingOf,
            bindings: this.bindings,
            diagnostics: this.diagnostics,
            globalsByName: this.globalScope.declarations,
        }
    }

    // ---------------- hoisting ----------------
    //
    // As in TypeScript, and as the bundle runs a module:
    //
    // - a function declaration is visible to its whole block, before it too;
    // - a name the module declares at its top level is visible to code that
    //   runs later — function bodies, and `typeof` in a type — even where that
    //   code is written above the declaration. A bundle declares every
    //   top-level name before any of the module runs, so this is what happens.
    //
    // A read of a later `const` straight in the module's own flow is not
    // resolved to it: that still reads what was there before.

    private moduleScope: Scope = this.globalScope
    /** How many function bodies enclose the walk. */
    private functionDepth = 0
    /** Function declarations already declared by their block's hoisting, with
     *  the function depth of that block. */
    private readonly hoisted = new Map<Identifier, number>()
    /** Names that resolved to a global from code that runs later, with the
     *  scope they were read in. */
    private readonly deferredGlobals: { node: Identifier; scope: Scope; assignment: boolean; depth: number }[] = []

    private hoistFunctions(block: Block, scope: Scope): void {
        for (const statement of block.statements) {
            const declaration = statement.type === "ExportStatement" ? statement.declaration : statement
            if (declaration.type === "ClassDeclaration") {
                // A class is a value built where it is written, but its name is
                // there from the top of the block, so two classes can name each
                // other and a method above one can construct it.
                this.declare(scope, declaration.name.name, "local", declaration.name, true, "class")
                this.hoisted.set(declaration.name, scope === this.moduleScope ? -1 : this.functionDepth)
                continue
            }
            if (declaration.type !== "FunctionDeclaration") continue
            this.declare(scope, declaration.name.name, "local", declaration.name, true, "function")
            this.hoisted.set(declaration.name, scope === this.moduleScope ? -1 : this.functionDepth)
        }
    }

    /** Inside a function, a function declared further down its block is
     *  hoisted only as a name: code that runs later (another function's body)
     *  can call it, but a call straight in the block before the declaration
     *  finds nothing there yet. At a module's top level the whole function is
     *  hoisted, and this does not apply. */
    private checkUseBeforeDefine(identifier: Identifier, id: BindingId, at = this.functionDepth): void {
        const binding = this.bindings.get(id)!
        if (this.typeQueryDepth > 0) return
        const declaration = binding.declarationNode as Identifier | undefined
        if (!declaration) return
        const hoisted = binding.declaredBy === "function" || binding.declaredBy === "class"
        // A name declared where the read is — `const` and `let`, and a
        // function or class whose name is hoisted no further than its own
        // block — holds nothing until its line has run.
        const depth = hoisted ? this.hoisted.get(declaration) : this.declaredDepth.get(id)
        const readable = hoisted || binding.kind === "local"
        if (!readable || depth === undefined || depth !== at) return
        const before = identifier.line.start < declaration.line.start ||
            (identifier.line.start === declaration.line.start && identifier.column.start < declaration.column.start)
        if (!before) return
        this.diagnostics.push({
            node: identifier,
            message: hoisted
                ? `'${binding.name}' is used before its definition: inside a function, a function declared further down is only there once its declaration has run`
                : `'${binding.name}' is used before its declaration, and holds nothing until that line has run`,
            kind: "use-before-define",
        })
    }

    private noteDeferred(identifier: Identifier, scope: Scope, id: BindingId, assignment: boolean): void {
        if (this.functionDepth === 0 && this.typeQueryDepth === 0) return
        if (this.bindings.get(id)!.kind !== "global") return
        this.deferredGlobals.push({ node: identifier, scope, assignment, depth: this.functionDepth })
    }

    /** Point each deferred read of a global at the declaration of that name
     *  that turned up later — in the module, or in any block around the code
     *  that reads it. Such code runs after the declaration has: a closure
     *  written inside a value reads the name the value is bound to. */
    private resolveForwardReferences(): void {
        for (const { node, scope, assignment, depth } of this.deferredGlobals) {
            const localId = this.lookup(scope, node.name)
            const globalId = this.bindingOf.get(node)
            if (localId === undefined || globalId === undefined || localId === globalId) continue
            const global = this.bindings.get(globalId)!
            const at = global.references.indexOf(node)
            if (at >= 0) global.references.splice(at, 1)
            if (global.declarationNode === node) global.declarationNode = undefined
            if (!global.isBuiltin && !global.references.length && global.declarationNode === undefined) {
                this.bindings.delete(globalId)
                this.globalScope.declarations.delete(node.name)
            }
            this.bindingOf.set(node, localId)
            this.bindings.get(localId)!.references.push(node)
            if (assignment) this.checkConstAssign(localId, node)
            else if (this.typeQueryDepth === 0) {
                this.checkTypeOnly(localId, node)
                // The read was written before the declaration it turned out
                // to name; whether that matters is the same question as ever.
                this.checkUseBeforeDefine(node, localId, depth)
            }
        }
    }

    /** Every read of a global nothing declares. A global assigned somewhere
     *  in the file (`x = 1`) is Lua's implicit global, and is left alone. */
    private reportUndeclared(program: Program): void {
        const declared = new Set<string>()
        for (const statement of program.body.statements) {
            if (statement.type === "DeclareStatement") declared.add(statement.name)
        }
        const found: ScopeDiagnostic[] = []
        for (const binding of this.bindings.values()) {
            if (!isUnassignedGlobal(binding) || declared.has(binding.name)) continue
            for (const reference of binding.references) {
                found.push({ node: reference, message: `Cannot find name '${binding.name}'`, kind: "undeclared" })
            }
        }
        found.sort((a, b) => a.node.line.start - b.node.line.start || a.node.column.start - b.node.column.start)
        this.diagnostics.push(...found)
    }

    // ---------------- declaration / resolution primitives ----------------

    private declare(
        scope: Scope, name: string, kind: BindingKind, node: DeclarationNode, isConst = false,
        declaredBy?: Binding["declaredBy"],
    ): BindingId {
        // Redeclaration in the same lexical scope is an error (`const x` / `let x`
        // twice, a param named twice, ...). The later binding still wins so the
        // rest of analysis stays sane.
        if (scope.declarations.has(name) && scope !== this.globalScope) {
            this.diagnostics.push({
                node,
                message: `Cannot redeclare '${name}' in the same scope`,
                kind: "redeclare",
            })
        }
        const id = this.nextId++
        this.bindings.set(id, { id, name, kind, declarationNode: node, references: [], isConst, declaredBy })
        this.declaredDepth.set(id, this.functionDepth)
        scope.declarations.set(name, id)
        return id
    }

    /** Which function body each name was declared in. A read of a `const` from
     *  the same body, but above it, is a read of nothing. */
    private readonly declaredDepth = new Map<BindingId, number>()

    private resolve(scope: Scope, name: string): BindingId {
        for (let s: Scope | null = scope; s; s = s.parent) {
            const id = s.declarations.get(name)
            if (id !== undefined) return id
        }
        return this.getOrCreateGlobalBinding(name)
    }

    /** Like `resolve`, but never creates a global: `undefined` when no
     *  enclosing scope declares the name. */
    private lookup(scope: Scope, name: string): BindingId | undefined {
        for (let s: Scope | null = scope; s; s = s.parent) {
            const id = s.declarations.get(name)
            if (id !== undefined) return id
        }
        return undefined
    }

    private getOrCreateGlobalBinding(name: string): BindingId {
        const existing = this.globalScope.declarations.get(name)
        if (existing !== undefined) return existing
        const id = this.nextId++
        this.bindings.set(id, { id, name, kind: "global", references: [] })
        this.globalScope.declarations.set(name, id)
        return id
    }

    /** Record a variable-usage Identifier as resolved to `scope`'s view of
     *  its name. */
    private reference(scope: Scope, identifier: Identifier): void {
        const id = this.resolve(scope, identifier.name)
        this.bindingOf.set(identifier, id)
        this.bindings.get(id)!.references.push(identifier)
        if (this.typeQueryDepth === 0) this.checkTypeOnly(id, identifier)
        this.checkUseBeforeDefine(identifier, id)
        this.noteDeferred(identifier, scope, id, false)
    }

    /** Inside `typeof x` in a type, where a type-only import may be named. */
    private typeQueryDepth = 0

    /** A name from `import type` used as a value. */
    private checkTypeOnly(id: BindingId, node: ScopeDiagnostic["node"]): void {
        const b = this.bindings.get(id)!
        if (b.declaredBy !== "type") return
        this.diagnostics.push({
            node,
            message: `'${b.name}' is imported with 'import type' and can only be used as a type`,
            kind: "type-only",
        })
    }

    /** For assignment-like targets (`x = ...`, `function foo() end`): if
     *  this resolved to a global with no declaration site yet, treat this
     *  as its "definition" for go-to-definition purposes. Locals and
     *  builtins are left alone. */
    private recordPossibleGlobalDefinition(id: BindingId, node: DeclarationNode): void {
        const binding = this.bindings.get(id)!
        if (binding.kind === "global" && !binding.isBuiltin && binding.declarationNode === undefined) {
            binding.declarationNode = node
        }
    }

    private referenceAsAssignmentTarget(scope: Scope, identifier: Identifier): void {
        const id = this.resolve(scope, identifier.name)
        this.bindingOf.set(identifier, id)
        this.bindings.get(id)!.references.push(identifier)
        this.recordPossibleGlobalDefinition(id, identifier)
        this.checkTypeOnly(id, identifier)
        this.checkConstAssign(id, identifier)
        this.noteDeferred(identifier, scope, id, true)
    }

    /** `Module.x = 1` through `import * as Module`: a module's exports belong
     *  to it and are read-only, as in ES modules. Deeper writes (`Module.x.y`)
     *  change the value, not the module, and are fine. */
    private checkModuleWrite(target: Expression): void {
        if (target.type !== "MemberExpression" && target.type !== "IndexExpression") return
        if (target.object.type !== "Identifier") return
        const id = this.bindingOf.get(target.object)
        if (id !== undefined && this.bindings.get(id)!.declaredBy === "namespace") {
            this.moduleWriteError(target.object.name, target)
        }
    }

    private moduleWriteError(name: string, node: ScopeDiagnostic["node"]): void {
        this.diagnostics.push({
            node,
            message: `Cannot assign to a member of '${name}' — a module's exports are read-only`,
            kind: "const-assign",
        })
    }

    private checkConstAssign(id: BindingId, node: ScopeDiagnostic["node"]): void {
        const b = this.bindings.get(id)!
        // Already reported as a value use.
        if (b.declaredBy === "type") return
        if (b.isConst) {
            this.diagnostics.push({
                node,
                message: `Cannot assign to '${b.name}' — it is ${
                    b.declaredBy === "import" || b.declaredBy === "namespace" ? "an import"
                        : b.declaredBy === "function" ? "a function"
                        : "a const"}`,
                kind: "const-assign",
            })
        }
    }

    // ---------------- destructuring patterns ----------------

    /** Declares every leaf binding introduced by `target`. Default values and
     *  computed keys are expressions, evaluated in `evalScope`. */
    private declarePattern(scope: Scope, target: BindingTarget, kind: BindingKind, evalScope: Scope, isConst = false): void {
        switch (target.type) {
            case "IdentifierPattern":
                this.declare(scope, target.name, kind, target, isConst)
                return
            case "ObjectPattern":
                for (const p of target.properties) {
                    if (p.computed) this.visitExpression(p.key as Expression, evalScope)
                    if (p.default) this.visitExpression(p.default, evalScope)
                    this.declarePattern(scope, p.value, kind, evalScope, isConst)
                }
                if (target.rest) this.declarePattern(scope, target.rest, kind, evalScope, isConst)
                return
            case "ArrayPattern":
                for (const el of target.elements) {
                    if (!el) continue
                    if (el.default) this.visitExpression(el.default, evalScope)
                    this.declarePattern(scope, el.value, kind, evalScope, isConst)
                }
                if (target.rest) this.declarePattern(scope, target.rest, kind, evalScope, isConst)
                return
        }
    }

    /** Like `declarePattern`, but for a destructuring *assignment* target
     *  (`{a, b} = t`): leaves resolve to existing bindings rather than
     *  declaring new ones. */
    private assignPattern(scope: Scope, target: ObjectPattern | ArrayPattern): void {
        const walk = (t: BindingTarget): void => {
            switch (t.type) {
                case "IdentifierPattern": {
                    const id = this.resolve(scope, t.name)
                    this.bindingOf.set(t, id)
                    this.recordPossibleGlobalDefinition(id, t)
                    this.checkTypeOnly(id, t)
                    this.checkConstAssign(id, t)
                    return
                }
                case "MemberExpression":
                case "IndexExpression":
                    this.visitExpression(t, scope)
                    return
                case "ObjectPattern":
                    for (const p of t.properties) {
                        if (p.computed) this.visitExpression(p.key as Expression, scope)
                        if (p.default) this.visitExpression(p.default, scope)
                        walk(p.value)
                    }
                    if (t.rest) walk(t.rest)
                    return
                case "ArrayPattern":
                    for (const el of t.elements) {
                        if (!el) continue
                        if (el.default) this.visitExpression(el.default, scope)
                        walk(el.value)
                    }
                    if (t.rest) walk(t.rest)
                    return
            }
        }
        walk(target)
    }

    // ---------------- blocks / statements ----------------

    private visitBlock(block: Block, scope: Scope): void {
        this.hoistFunctions(block, scope)
        for (const stmt of block.statements) this.visitStatement(stmt, scope)
    }

    /** Visits a block in a *fresh child scope* of `scope` — the common case
     *  for loop/if/do bodies, where the block's own locals shouldn't leak
     *  into the surrounding scope. */
    private visitBlockInNewScope(block: Block, scope: Scope): void {
        this.visitBlock(block, childScope(scope))
    }

    private visitStatement(stmt: Statement, scope: Scope): void {
        switch (stmt.type) {
            case "VariableDeclaration": {
                // Initializers see the *old* bindings — `const x = x` reads
                // the outer `x`, not the one being declared.
                if (stmt.init) this.visitExpression(stmt.init, scope)
                if (stmt.name.type !== "MemberExpression" && stmt.name.type !== "IndexExpression") {
                    this.visitType(stmt.name.typeAnnotation, scope)
                }
                this.declarePattern(scope, stmt.name, "local", scope, stmt.kind === "const")
                return
            }

            case "FunctionDeclaration": {
                // Declared when its block started (hoisting), so calls from
                // anywhere in the block, its own body included, resolve to it.
                if (!this.hoisted.has(stmt.name)) this.declare(scope, stmt.name.name, "local", stmt.name, true, "function")
                // Every other line of an overload set writes the name again;
                // each of those is a use of the same binding.
                for (const signature of stmt.signatures ?? []) {
                    if (signature.name && signature.name !== stmt.name) this.reference(scope, signature.name)
                }
                if (stmt.implementationName) this.reference(scope, stmt.implementationName)
                for (const signature of stmt.signatures ?? []) this.visitSignature(signature, scope)
                this.visitFunctionBody(stmt.func, scope)
                return
            }

            case "ClassDeclaration": {
                if (!this.hoisted.has(stmt.name)) this.declare(scope, stmt.name.name, "local", stmt.name, true, "class")
                this.visitClassBody(stmt, scope)
                return
            }

            case "FunctionDeclarationStatement": {
                // `function foo() end` rebinds `foo`; `function T.m() end` /
                // `function T:m() end` writes a *member* of `T` (not a rebind,
                // so a `const T` is fine).
                if (stmt.target.path.length === 0 && !stmt.target.method) {
                    this.referenceAsAssignmentTarget(scope, stmt.target.base)
                } else {
                    this.reference(scope, stmt.target.base)
                    // `function Module.f()` / `function Module:m()` defines a
                    // member of the module itself.
                    const id = this.bindingOf.get(stmt.target.base)
                    const depth = stmt.target.path.length + (stmt.target.method ? 1 : 0)
                    if (id !== undefined && depth === 1 && this.bindings.get(id)!.declaredBy === "namespace") {
                        this.moduleWriteError(stmt.target.base.name, stmt.target)
                    }
                }
                for (const signature of stmt.signatures ?? []) this.visitSignature(signature, scope)
                this.visitFunctionBody(stmt.func, scope, stmt.isMethod)
                return
            }

            case "AssignmentStatement": {
                this.visitExpression(stmt.value, scope)
                const target = stmt.target
                if (target.type === "Identifier") {
                    this.referenceAsAssignmentTarget(scope, target)
                } else if (target.type === "ObjectPattern" || target.type === "ArrayPattern") {
                    this.assignPattern(scope, target)
                } else {
                    // MemberExpression / IndexExpression target: the
                    // object is a reference, the property/index isn't
                    // (or is itself a full expression already handled).
                    this.visitExpression(target, scope)
                    this.checkModuleWrite(target)
                }
                return
            }

            case "CompoundAssignmentStatement": {
                this.visitExpression(stmt.value, scope)
                if (stmt.target.type === "Identifier") {
                    this.reference(scope, stmt.target)
                    const id = this.bindingOf.get(stmt.target)
                    if (id !== undefined) this.checkConstAssign(id, stmt.target)
                } else {
                    this.visitExpression(stmt.target, scope)
                    this.checkModuleWrite(stmt.target)
                }
                return
            }

            case "CallStatement":
            // An expression written as a statement does nothing, but the names
            // in it are real references — that is the point of allowing it.
            case "ExpressionStatement":
                this.visitExpression(stmt.expression, scope)
                return

            case "DoStatement":
                this.visitBlockInNewScope(stmt.body, scope)
                return

            case "WhileStatement":
                this.visitExpression(stmt.condition, scope)
                this.visitBlockInNewScope(stmt.body, scope)
                return

            case "RepeatStatement": {
                // Luau/Lua quirk: `until` can see locals declared in the
                // body, unlike `while` — so body + condition share one scope.
                const bodyScope = childScope(scope)
                this.visitBlock(stmt.body, bodyScope)
                this.visitExpression(stmt.condition, bodyScope)
                return
            }

            case "IfStatement": {
                for (const clause of stmt.clauses) {
                    this.visitExpression(clause.condition, scope)
                    this.visitBlockInNewScope(clause.body, scope)
                }
                if (stmt.alternate) this.visitBlockInNewScope(stmt.alternate, scope)
                return
            }

            case "NumericForStatement": {
                this.visitExpression(stmt.start, scope)
                this.visitExpression(stmt.end, scope)
                if (stmt.step) this.visitExpression(stmt.step, scope)
                const bodyScope = childScope(scope)
                this.declare(bodyScope, stmt.variable.name, "for-numeric", stmt.variable)
                this.visitBlock(stmt.body, bodyScope)
                return
            }

            case "GenericForStatement": {
                this.visitExpression(stmt.iterator, scope)
                const bodyScope = childScope(scope)
                this.declarePattern(bodyScope, stmt.variable, "for-generic", scope, stmt.kind === "const")
                this.visitBlock(stmt.body, bodyScope)
                return
            }

            case "ReturnStatement":
                if (stmt.argument) this.visitExpression(stmt.argument, scope)
                return

            case "BreakStatement":
            case "ContinueStatement":
            case "ErrorStatement":
                return

            case "DeclareStatement":
                this.visitType(stmt.valueType, scope)
                return

            case "DeclareClassStatement":
                this.visitType(stmt.body, scope)
                return

            case "DeclareMetatableStatement":
                this.visitGenerics(stmt.generics, scope)
                this.visitType(stmt.target, scope)
                this.visitType(stmt.metatable, scope)
                return

            case "TypeAliasStatement":
            case "ExportTypeAliasStatement":
                // Type-level names live in a separate namespace from value
                // bindings, but a `typeof x` inside the definition reads a
                // value.
                this.visitGenerics(
                    (stmt.type === "TypeAliasStatement" ? stmt : stmt.alias).generics, scope)
                this.visitType(stmt.type === "TypeAliasStatement" ? stmt.definition : stmt.alias.definition, scope)
                return

            case "ImportStatement": {
                // `import Foo, { a, b as c } from "..."` introduces locals
                // `Foo`, `a`, `c` in the current scope.
                // Imports are read-only, as in ES modules. A type-only import
                // is still declared, so that using it as a value is reported
                // rather than read as some undeclared global.
                const typeOnly = stmt.isTypeOnly ? "type" : undefined
                if (stmt.defaultImport) {
                    this.declare(scope, stmt.defaultImport.name, "local", stmt.defaultImport, true, typeOnly ?? "import")
                }
                if (stmt.namespaceImport) {
                    this.declare(scope, stmt.namespaceImport.name, "local", stmt.namespaceImport, true, typeOnly ?? "namespace")
                }
                for (const spec of stmt.specifiers) {
                    this.declare(scope, spec.local.name, "local", spec.local, true, typeOnly ?? "import")
                }
                return
            }

            case "ExportStatement":
                // `export local x = ...` / `export const f = ...` — the
                // declaration binds normally; `export` is compile-time only.
                this.visitStatement(stmt.declaration, scope)
                return

            case "ExportDefaultStatement":
                // `export default class Name ... end` declares `Name` here too.
                if (stmt.declaration.type === "ClassDeclaration") this.visitStatement(stmt.declaration, scope)
                else this.visitExpression(stmt.declaration, scope)
                return

            case "ExportNamedStatement":
                // `export { a }` reads the local `a`. A name that no scope
                // declares may be a type, which lives in the type namespace, so
                // it is left unbound rather than invented as a global. With
                // `from`, the names belong to the other module entirely.
                if (!stmt.source) {
                    for (const specifier of stmt.specifiers) {
                        const id = this.lookup(scope, specifier.local.name)
                        if (id === undefined) continue
                        this.bindingOf.set(specifier.local, id)
                        this.bindings.get(id)!.references.push(specifier.local)
                    }
                }
                return

            case "ExportAllStatement":
                return
        }
    }

    // ---------------- functions ----------------

    private visitFunctionBody(func: FunctionBody, outerScope: Scope, isMethod = false): void {
        // Params + body share one scope — nothing meaningful happens
        // "between" param declarations and the body that would need its
        // own layer.
        const fnScope = childScope(outerScope)
        this.visitGenerics(func.generics, fnScope)
        // For `function T:m(...)`, the parser already injects a real
        // `self` FunctionParameter as `params[0]` (see builders.ts) — it's
        // not synthesized here, just classified differently so rename
        // passes can special-case it (e.g. "never rename self").
        func.params.forEach((param, i) => {
            const kind: BindingKind = isMethod && i === 0 ? "self" : "param"
            // Before declaring it: `(a: number, b: typeof a)` sees the earlier
            // parameters, as in TypeScript.
            this.visitType(param.typeAnnotation, fnScope)
            if (param.default) this.visitExpression(param.default, fnScope)
            if (param.pattern) {
                this.declarePattern(fnScope, param.pattern, kind, fnScope)
            } else {
                this.declare(fnScope, param.name, kind, param)
            }
        })
        this.visitType(func.returnType, fnScope)
        this.functionDepth++
        try {
            this.visitBlock(func.body, fnScope)
        } finally {
            this.functionDepth--
        }
    }

    /** An overload signature: no body and no bindings, but its types can hold
     *  a `typeof x`. */
    private visitSignature(
        signature: {
            params: { typeAnnotation?: TypeNode }[]
            returnType?: TypeNode
            generics?: { constraint?: TypeNode; default?: TypeNode }[]
        },
        scope: Scope,
    ): void {
        this.visitGenerics(signature.generics, scope)
        for (const param of signature.params) this.visitType(param.typeAnnotation, scope)
        this.visitType(signature.returnType, scope)
    }

    /** `<K extends typeof config>` — a constraint is a type like any other,
     *  and the `typeof` in it reads a value. */
    /** A class body. Its type parameters live in a scope of their own, and
     *  every member is written inside it — so a method's annotations see `T`,
     *  and everything else sees what the class declaration sees, itself
     *  included. `this` is not declared here: the parser makes it a real first
     *  parameter, so it arrives with the rest of them. */
    private visitClassBody(
        node: {
            typeParams?: readonly GenericTypeParameter[]
            superclass?: Identifier
            superArguments?: readonly TypeNode[]
            implements?: readonly TypeNode[]
            members: readonly ClassMember[]
        },
        outer: Scope,
    ): void {
        const scope = node.typeParams?.length ? childScope(outer) : outer
        this.visitGenerics(node.typeParams, scope)
        if (node.superclass) this.reference(outer, node.superclass)
        for (const argument of node.superArguments ?? []) this.visitType(argument, scope)
        for (const shape of node.implements ?? []) this.visitType(shape, scope)
        for (const member of node.members) {
            switch (member.type) {
                case "ClassField":
                    this.visitType(member.typeAnnotation, scope)
                    if (member.init) this.visitExpression(member.init, scope)
                    break
                case "ClassMethod":
                    for (const signature of member.signatures ?? []) this.visitSignature(signature, scope)
                    this.visitFunctionBody(member.func, scope, member.func.isMethod)
                    break
                case "ClassAccessor":
                case "ClassConstructor":
                    this.visitFunctionBody(member.func, scope, member.func.isMethod)
                    break
            }
        }
    }

    private visitGenerics(
        generics: readonly { constraint?: TypeNode; default?: TypeNode }[] | undefined,
        scope: Scope,
    ): void {
        for (const generic of generics ?? []) {
            this.visitType(generic.constraint, scope)
            this.visitType(generic.default, scope)
        }
    }

    /** Resolve the value references inside a type. Only `typeof x` has any —
     *  everything else in a type names types, which live in their own
     *  namespace and are not this pass's business. */
    private visitType(node: TypeNode | undefined, scope: Scope): void {
        if (!node) return
        const walk = (value: unknown): void => {
            if (!value || typeof value !== "object") return
            if (Array.isArray(value)) {
                for (const item of value) walk(item)
                return
            }
            if ((value as { type?: unknown }).type === "TypeofTypeNode") {
                // A type query: naming a type-only import here is fine.
                this.typeQueryDepth++
                try {
                    this.visitExpression((value as TypeofTypeNode).expression, scope)
                } finally {
                    this.typeQueryDepth--
                }
                return
            }
            for (const key of Object.keys(value)) {
                if (key !== "line" && key !== "column") walk((value as Record<string, unknown>)[key])
            }
        }
        walk(node)
    }

    // ---------------- expressions ----------------

    private visitExpression(expr: Expression, scope: Scope): void {
        switch (expr.type) {
            case "Identifier":
                this.reference(scope, expr)
                return

            case "NilLiteral":
            case "BooleanLiteral":
            case "NumberLiteral":
            case "StringLiteral":
            case "ErrorExpression":
                return

            case "InterpolatedStringExpression":
                for (const part of expr.parts) {
                    if (part.kind === "expression") this.visitExpression(part.expression, scope)
                }
                return

            case "FunctionExpression":
                this.visitFunctionBody(expr.func, scope)
                return

            case "TableExpression":
                for (const field of expr.fields) this.visitTableField(field, scope)
                return

            case "ArrayExpression":
                for (const el of expr.elements) {
                    this.visitExpression(el.type === "SpreadElement" ? el.argument : el, scope)
                }
                return

            case "AsConstExpression":
                this.visitExpression(expr.expression, scope)
                return

            case "BinaryExpression":
                this.visitExpression(expr.left, scope)
                this.visitExpression(expr.right, scope)
                return

            case "UnaryExpression":
                this.visitExpression(expr.argument, scope)
                return

            case "MemberExpression":
                // `.property` is a field name, not a variable ref.
                this.visitExpression(expr.object, scope)
                return

            case "IndexExpression":
                this.visitExpression(expr.object, scope)
                this.visitExpression(expr.index, scope)
                return

            case "CallExpression":
                this.visitExpression(expr.callee, scope)
                for (const arg of expr.arguments) this.visitExpression(arg, scope)
                return

            case "SuperExpression":
                return

            case "SpreadElement":
                // In a call's arguments; an array literal walks its own.
                this.visitExpression(expr.argument, scope)
                return

            case "ClassExpression": {
                // A named class expression can name itself inside its own body
                // and nowhere else, as in JavaScript.
                const inner = childScope(scope)
                if (expr.name) this.declare(inner, expr.name.name, "local", expr.name, true, "class")
                this.visitClassBody(expr, inner)
                return
            }

            case "MethodCallExpression":
                // `.method` is a method name, not a variable ref.
                this.visitExpression(expr.object, scope)
                for (const arg of expr.arguments) this.visitExpression(arg, scope)
                return

            case "ParenthesizedExpression":
                this.visitExpression(expr.expression, scope)
                return

            case "TypeAssertionExpression":
                this.visitExpression(expr.expression, scope)
                this.visitType((expr as { typeAnnotation?: TypeNode }).typeAnnotation, scope)
                return

            case "SatisfiesExpression":
                // Was missing entirely: nothing inside `x satisfies T` was
                // resolved, so `x` had no binding there.
                this.visitExpression(expr.expression, scope)
                this.visitType(expr.typeAnnotation, scope)
                return

            case "IfElseExpression":
                for (const clause of expr.clauses) {
                    this.visitExpression(clause.condition, scope)
                    this.visitExpression(clause.body, scope)
                }
                this.visitExpression(expr.alternate, scope)
                return
        }
    }

    private visitTableField(field: TableField, scope: Scope): void {
        switch (field.type) {
            case "TableFieldNamed":
                // `.name` is a field name, not a variable ref.
                this.visitExpression(field.value, scope)
                return
            case "TableFieldShorthand":
                // `{ a }` reads `a` from scope (sugar for `{ a: a }`).
                this.reference(scope, field.name)
                return
            case "TableFieldSpread":
                this.visitExpression(field.argument, scope)
                return
            case "TableFieldComputed":
                this.visitExpression(field.key, scope)
                this.visitExpression(field.value, scope)
                return
        }
    }
}

// --------------------------------------------------------
// Entry point
// --------------------------------------------------------

/** Globals tilua itself declares, whatever the type libraries do:
 *  `scriptArgs` is the arguments the script was started with — Lua's
 *  top-level `...` — as an array. */
export const LANGUAGE_GLOBALS: readonly string[] = ["scriptArgs"]

export function analyzeScopes(program: Program, options: AnalyzeScopesOptions = {}): ScopeAnalysis {
    return new Analyzer(options).run(program)
}