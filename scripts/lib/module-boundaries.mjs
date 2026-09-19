import { parse } from '@babel/parser'
import { isBuiltin } from 'node:module'
import { posix } from 'node:path'

const SOURCE_EXTENSION = /\.[cm]?[jt]sx?$/
const ALLOWED_LAYERS = {
  main: new Set(['main', 'shared']),
  preload: new Set(['preload', 'shared']),
  renderer: new Set(['renderer', 'shared']),
  shared: new Set(['shared'])
}

/** Resolve repository imports before applying rules; syntax and nesting do not grant exceptions. */
export function findModuleBoundaryViolations(entries) {
  const violations = []
  const graph = new Map()
  for (const [file, text] of entries) {
    if (!file.startsWith('src/') || !SOURCE_EXTENSION.test(file)) continue
    const layer = file.split('/')[1]
    const dependencies = []
    graph.set(file, dependencies)
    let tree
    try {
      tree = parse(text, {
        sourceType: 'module', createImportExpressions: true,
        plugins: [['typescript', { dts: file.endsWith('.d.ts') }], ...(/\.[jt]sx$/.test(file) ? ['jsx'] : [])]
      })
    } catch {
      violations.push(`${file}: 无法解析模块依赖`)
      continue
    }
    walk(tree, node => {
      const source = moduleSource(node)
      if (source === undefined) return
      const specifier = literal(source)
      if (specifier === undefined) {
        // The sole runtime-selected import is the explicitly configured smoke driver.
        if (file === 'src/main/index.ts' && node.type === 'ImportExpression' &&
          text.slice(source.start, source.end).replace(/\s/g, '') === 'pathToFileURL(runtime.smoke.driverPath).href') return
        violations.push(`${file}: 动态依赖必须使用可枚举的模块字面量`)
        return
      }
      if (isBuiltin(specifier) || specifier === 'electron' || specifier.startsWith('electron/')) {
        if (layer === 'renderer' || layer === 'shared') {
          violations.push(`${file}: ${layer} 层不得依赖 Electron、Node 或 main 层（${specifier}）`)
        }
        return
      }
      if (!specifier.startsWith('.')) {
        // There are no path aliases in this repository. New packages/aliases
        // need an explicit boundary decision instead of silently skipping checks.
        if (!['hls.js', '@phosphor-icons/web'].includes(specifier)) {
          violations.push(`${file}: 未声明的外部模块或路径别名 ${specifier}`)
        }
        return
      }
      const base = posix.normalize(posix.join(posix.dirname(file), specifier))
      // TypeScript resolves emitted .js/.mjs/.cjs specifiers back to source files.
      const extension = posix.extname(base)
      const substitutions = { '.js': ['.ts', '.tsx', '.d.ts'], '.jsx': ['.tsx', '.d.ts'],
        '.mjs': ['.mts', '.d.mts'], '.cjs': ['.cts', '.d.cts'] }[extension] ?? []
      const candidates = [
        ...substitutions.map(suffix => base.slice(0, -extension.length) + suffix), base,
        ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.tsx', '/index.js'].map(suffix => base + suffix)
      ]
      const target = candidates.find(candidate => entries.has(candidate)) ?? base
      dependencies.push(target)
      const targetLayer = target.startsWith('src/') ? target.split('/')[1] : undefined
      if (!ALLOWED_LAYERS[layer]?.has(targetLayer)) {
        violations.push(`${file}: ${layer} 层不得依赖 ${target}（只允许本层和声明的 shared 边界）`)
      }
    })
  }
  for (const file of graph.keys()) {
    if (file.startsWith('src/renderer/') && reaches(file, 'src/shared/catalog.ts', graph, new Set())) {
      violations.push(`${file}: renderer 不得直接或间接执行目录安全投影`)
    }
  }
  return [...new Set(violations)]
}

function moduleSource(node) {
  if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression'].includes(node.type)) return node.source ?? undefined
  if (node.type === 'TSImportType') return node.argument
  if (node.type === 'TSExternalModuleReference') return node.expression
  if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'require') return node.arguments[0] ?? null
}

function literal(node) {
  if (node?.type === 'StringLiteral') return node.value
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0]?.value.cooked
}

function walk(node, visit) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return
  visit(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) { for (const child of value) walk(child, visit) }
    else if (value && typeof value === 'object' && typeof value.type === 'string') walk(value, visit)
  }
}

function reaches(file, target, graph, visited) {
  if (file === target) return true
  if (visited.has(file)) return false
  visited.add(file)
  return (graph.get(file) ?? []).some(dependency => reaches(dependency, target, graph, visited))
}
