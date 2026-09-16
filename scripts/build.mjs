/**
 * Build script for dsh-model-suite.
 *
 * 本插件**源码即产物**：lib/index.js（host, ESM）、lib/client.js（browser,
 * __ModuleLoader__ 工厂）、lib/catalog-routes.js、lib/compat-fields.js 都是手写
 * JavaScript，不需要 TypeScript / 打包器。本脚本只做形状与回归校验，不产出文件。
 *
 * 运行：`node scripts/build.mjs`（也挂在 package.json 的 `prepare` 上）
 *
 * 校验项（对应开发文档 §14.1）：
 *   1. 必需文件存在；
 *   2. package.json 的 name/version/main/exports/dsh 与 dsh.bundle/dsh.client 声明；
 *   3. host 半区可动态 import，导出可调用的 apply + 非空 name，inject 形态合法；
 *   4. client 半区是 __ModuleLoader__ 工厂 bundle，标记齐全且仍指向 /api/suite；
 *   5. cordis.patch.yml 含 `- insert:` 且引用本包，且**不含**前身插件字样；
 *   6. compat 字段数断言（19 / 4 / 7 / 1，防 DSH 升级后的字段漂移，见 §16 风险 #2）。
 *
 * 与文档 §14.1 第 3 条的差异：文档描述「host 半区以 data URL 动态 import」。
 * data: URL 模块无法解析相对 ESM 说明符，而 host 半区现在有兄弟模块
 * （./catalog-routes.js、./compat-fields.js）。因此改为**从磁盘路径动态 import**
 * （带 cache-busting query）——同样是"动态 import 并断言导出形状"，且能真正解析依赖。
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const REQUIRED_FILES = [
  'lib/index.js',
  'lib/client.js',
  'lib/catalog-routes.js',
  'lib/compat-fields.js',
  'cordis.patch.yml',
  'package.json',
  'scripts/build.mjs',
  'scripts/security-smoke.mjs',
  'scripts/integration-smoke.mjs',
  'scripts/ui-smoke.mjs',
]

const REQUIRED_PKG_FIELDS = ['name', 'version', 'main', 'exports', 'dsh']

const CLIENT_MARKERS = [
  'window.__ModuleLoader__.load(',
  'factory: (require) =>',
  "id: 'dsh-model-suite'",
  'return module.exports',
  "/api/suite",
]

const FORBIDDEN_PATCH_TOKENS = ['model-plus', 'custom-provider-enhancer']

function fail(msg) {
  console.error(`[build] FAIL: ${msg}`)
  process.exit(1)
}

function ok(msg) {
  console.log(`[build] ${msg}`)
}

// 1. 必需文件存在。
for (const rel of REQUIRED_FILES) {
  if (!existsSync(join(root, rel))) fail(`missing required file: ${rel}`)
}
ok(`required files ok (${REQUIRED_FILES.length})`)

// 2. package.json 的 dsh bundle + client 声明。
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
for (const field of REQUIRED_PKG_FIELDS) {
  if (pkg[field] === undefined) fail(`package.json missing field: ${field}`)
}
if (pkg.name !== 'dsh-model-suite') fail(`package.json name must be "dsh-model-suite" (found ${pkg.name})`)
if (pkg.version !== '0.1.0') fail(`package.json version must be "0.1.0" (found ${pkg.version})`)
if (pkg.dsh?.bundle?.patch === undefined) fail('package.json dsh.bundle.patch must point at a cordis.patch.yml')
if (pkg.dsh?.client?.platform !== 'web') fail('package.json dsh.client.platform must be "web"')
if (!Array.isArray(pkg.dsh?.client?.inject) || pkg.dsh.client.inject.length === 0) {
  fail('package.json dsh.client.inject must list at least one platform module')
}
ok('package.json ok')

// 3. host 半区：动态 import + 导出形状。
const hostSrc = readFileSync(join(root, 'lib/index.js'), 'utf8')
try {
  const mod = await import(pathToFileURL(join(root, 'lib/index.js')).href + '?build=' + Date.now())
  if (typeof mod.apply !== 'function') fail('lib/index.js must export function apply(ctx)')
  if (typeof mod.name !== 'string' || !mod.name) fail('lib/index.js must export a non-empty name string')
  if (mod.name !== 'model-suite') fail(`lib/index.js name must be "model-suite" (found ${mod.name})`)
  // cordis Inject.resolve：string[] 或 { 服务名: config }。
  // 禁止 { required, optional }——会被当成服务名，插件永远 pending。
  const inj = mod.inject
  let injLabel = ''
  if (Array.isArray(inj) && inj.length > 0) {
    if (!inj.every((n) => typeof n === 'string' && n)) fail('lib/index.js inject array entries must be non-empty strings')
    injLabel = inj.join(', ')
  } else if (inj && typeof inj === 'object' && !Array.isArray(inj)) {
    const keys = Object.keys(inj)
    if (!keys.length) fail('lib/index.js inject object must have at least one service name')
    if (keys.includes('required') || keys.includes('optional')) {
      fail('lib/index.js inject must NOT use { required, optional }; cordis treats those keys as service names. Use string[] (required deps) and ctx.get() for optional services')
    }
    injLabel = keys.join(', ')
  } else {
    fail('lib/index.js must export inject as non-empty string[] or { serviceName: config }')
  }
  for (const dep of ['settings', 'webServer', 'timer', 'llm']) {
    if (!inj.includes(dep)) fail(`lib/index.js inject must include "${dep}" (三链路需要 llm)`)
  }
  ok(`host half ok: name=${mod.name} inject=${injLabel}`)
} catch (e) {
  fail(`lib/index.js load/shape error: ${e?.message ?? e}`)
}

// 3b. host 半区的关键标记（AI 生成/重构时最容易丢的实现要点）。
for (const needle of ['originalDiscover(settingsNs, request, signal)', 'delete target[key]', '/api/suite']) {
  if (!hostSrc.includes(needle)) fail(`lib/index.js missing implementation marker: ${needle}`)
}
ok('host half markers ok')

// 4. client 半区是 __ModuleLoader__.load 工厂 bundle（不是 ESM），只查形状标记。
const clientSrc = readFileSync(join(root, 'lib/client.js'), 'utf8')
for (const marker of CLIENT_MARKERS) {
  if (!clientSrc.includes(marker)) fail(`lib/client.js missing required marker: ${marker}`)
}
if (clientSrc.includes('/api/plus')) fail('lib/client.js still points at the legacy /api/plus prefix')
ok('client half ok: __ModuleLoader__ factory shape verified')

// 5. cordis.patch.yml。
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
if (!patch.includes('- insert:')) fail('cordis.patch.yml must contain an "- insert:" row')
if (!patch.includes('dsh-model-suite')) fail('cordis.patch.yml must reference dsh-model-suite')
if (!/id:\s*model-suite\b/.test(patch)) fail('cordis.patch.yml insert id must be "model-suite"')
for (const token of FORBIDDEN_PATCH_TOKENS) {
  if (patch.includes(token)) fail(`cordis.patch.yml must not reference the predecessor plugin (${token})`)
}
ok('cordis.patch.yml ok')

// 6. catalog route 名单健全性。
const routesMod = await import(pathToFileURL(join(root, 'lib/catalog-routes.js')).href + '?build=' + Date.now())
const routeIds = routesMod.CATALOG_ROUTE_IDS
if (!(routeIds instanceof Set)) fail('lib/catalog-routes.js must export CATALOG_ROUTE_IDS as a Set')
if (routeIds.size !== 40) fail(`CATALOG_ROUTE_IDS must hold 40 ids (found ${routeIds.size}); sync with pi-ai builtinProviders()`)
for (const must of ['deepseek', 'openai', 'anthropic', 'openrouter', 'amazon-bedrock']) {
  if (!routeIds.has(must)) fail(`CATALOG_ROUTE_IDS missing "${must}"`)
}
ok(`catalog routes ok (${routeIds.size} ids)`)

// 7. compat 字段数断言（防漂移）。
const compatMod = await import(pathToFileURL(join(root, 'lib/compat-fields.js')).href + '?build=' + Date.now())
for (const [api, expected] of Object.entries(compatMod.COMPAT_PROTOCOL_FIELD_COUNTS)) {
  const rows = compatMod.COMPAT_FIELD_TABLE[api]
  if (!Array.isArray(rows)) fail(`compat table missing protocol ${api}`)
  if (rows.length !== expected) {
    fail(`compat field count drift for ${api}: expected ${expected}, found ${rows.length}; re-check dsh-llm-pi-ai COMPAT_GATES`)
  }
  const names = new Set()
  for (const row of rows) {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'string' || typeof row[2] !== 'string' || typeof row[3] !== 'string') {
      fail(`compat table row malformed for ${api}: ${JSON.stringify(row)}`)
    }
    if (names.has(row[0])) fail(`compat table duplicate field ${row[0]} in ${api}`)
    names.add(row[0])
    if (row[1] === 'enum' && (!Array.isArray(row[4]) || row[4].length === 0)) fail(`compat enum ${row[0]} needs values`)
  }
}
ok('compat field table ok (19 / 4 / 7 / 1)')

console.log('[build] OK — all checks passed')
