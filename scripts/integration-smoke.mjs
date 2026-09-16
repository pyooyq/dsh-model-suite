/**
 * dsh-model-suite integration smoke test.
 *
 * 运行：`node scripts/integration-smoke.mjs`
 *
 * 用**真实 apply(ctx)** 驱动全部 14 个端点与三条自动链路：
 *   - 假 settings 服务（CAS + 三连降级语义），并用 dsh-llm-pi-ai 的**真 Config schema**
 *     校验每次写入，确保补丁产出的配置一定能被 DSH 接受；
 *   - 假 webServer 收集路由并按 path 派发（走真实 HTTP 语义：Origin/loopback 栅栏、JSON body）；
 *   - 假 llm 服务（方法挂在原型上，用于验证 dispose 后 `delete` 干净还原）；
 *   - 本地 HTTP 服务器提供三源目录 JSON（loopback + http 允许，走真实 httpRequestText）。
 *
 * 覆盖开发文档 §14.3 手工清单里的 #1–#7、#9–#13 的可自动化部分。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import http from 'node:http'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function assert(cond, msg) {
  if (!cond) throw new Error('[integration] ' + msg)
}
let checks = 0
function check(cond, msg) {
  checks += 1
  assert(cond, msg)
}

/* ─────────── 真 DSH 的 llm-pi-ai Config schema（可选） ─────────── */

const DSH_PI_AI = 'C:/Users/yooy/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'
let ConfigSchema = null
try {
  const mod = await import(pathToFileURL(DSH_PI_AI).href)
  ConfigSchema = mod.Config
} catch (e) {
  console.warn('[integration] WARN: dsh-llm-pi-ai Config schema unavailable — writes are not schema-validated:', e.message)
}
check(!!ConfigSchema, 'real dsh-llm-pi-ai Config schema loaded (defence against writing invalid settings)')

/* ─────────── 三源目录：本地 HTTP 服务器 ─────────── */

const hits = { modelsDev: 0, litellm: 0, openrouter: 0, byPath: {} }

const MODELS_DEV_BODY = {
  deepseek: {
    id: 'deepseek',
    models: {
      'deepseek-chat': {
        id: 'deepseek-chat', name: 'DeepSeek Chat',
        limit: { context: 131072, output: 8192 },
        modalities: { input: ['text'] },
        reasoning: false,
      },
    },
  },
  zhipu: {
    id: 'zhipu',
    models: {
      'glm-5.3': {
        id: 'glm-5.3', name: 'GLM 5.3',
        limit: { context: 1048576, output: 384000 },
        modalities: { input: ['text', 'image'] },
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }],
      },
      'glm-4.6': {
        id: 'glm-4.6', name: 'GLM 4.6',
        limit: { context: 131072, output: 16384 },
        modalities: { input: ['text'] },
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
      },
    },
  },
}

const LITELLM_BODY = {
  // LiteLLM 独有的 id（另两源都没有）
  'litellm-only-model': {
    max_input_tokens: 64000,
    max_output_tokens: 2000,
    supports_vision: true,
    litellm_provider: 'somewhere',
  },
  // 与 models.dev 同 id 但**故意缺 max_output_tokens**：不得把主源的值降级（R3）
  'zhipu/glm-5.3': {
    max_input_tokens: 65536,
    litellm_provider: 'zhipu',
  },
}

const OPENROUTER_BODY = {
  data: [
    {
      id: 'vendor/or-only-model',
      name: 'OR Only',
      context_length: 200000,
      top_provider: { max_completion_tokens: 4096 },
      architecture: { input_modalities: ['text', 'image'] },
      supported_parameters: ['reasoning'],
    },
  ],
}

const catalogServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  hits.byPath[url.pathname] = (hits.byPath[url.pathname] || 0) + 1
  // M2 专用：拖 4 秒再 404 的"慢失败"源（≥ PATCH_CATALOG_WAIT_MS 视为慢失败）
  if (url.pathname === '/slow-fail.json') {
    setTimeout(() => { res.writeHead(404); res.end('nope') }, 4000)
    return
  }
  let body = null
  if (url.pathname === '/models-dev.json') { hits.modelsDev += 1; body = MODELS_DEV_BODY }
  else if (url.pathname === '/litellm.json') { hits.litellm += 1; body = LITELLM_BODY }
  else if (url.pathname === '/openrouter.json') { hits.openrouter += 1; body = OPENROUTER_BODY }
  if (!body) { res.writeHead(404); res.end('nope'); return }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
})
await new Promise((resolve) => catalogServer.listen(0, '127.0.0.1', resolve))
const CATALOG_PORT = catalogServer.address().port
const CATALOG_BASE = 'http://127.0.0.1:' + CATALOG_PORT

/* ─────────── 假 settings 服务（CAS + mutate 语义） ─────────── */

function cloneJson(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)) }

function applyPathOp(section, op) {
  const path = op.path
  let cursor = section
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]
    if (!cursor[key] || typeof cursor[key] !== 'object') cursor[key] = {}
    cursor = cursor[key]
  }
  const last = path[path.length - 1]
  if (op.op === 'set') cursor[last] = cloneJson(op.value)
  else delete cursor[last]
  return section
}

function mergeLayers(base, patch) {
  if (!patch || typeof patch !== 'object') return base
  const out = Object.assign({}, base)
  for (const key of Object.keys(patch)) {
    const value = patch[key]
    if (value && typeof value === 'object' && !Array.isArray(value) && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = mergeLayers(out[key], value)
    } else {
      out[key] = cloneJson(value)
    }
  }
  return out
}

function makeSettings(initialSection, options) {
  const opts = options || {}
  const state = {
    section: cloneJson(initialSection) || {},
    revision: 1,
    writes: [],
  }
  function resolved() {
    const raw = cloneJson(state.section) || {}
    if (ConfigSchema) return ConfigSchema(raw)
    return raw
  }
  function guard(expectedRevision, mode) {
    const fail = opts.fail && opts.fail[mode]
    if (fail) {
      opts.fail[mode] = fail - 1
      const err = new Error('simulated failure (' + mode + ')')
      err.code = 'SIMULATED_' + mode.toUpperCase()
      throw err
    }
    // opts.conflict[mode]：强制抛一次 CAS 冲突（B2 的 409 回归用）
    const forcedConflict = opts.conflict && opts.conflict[mode]
    if (forcedConflict) {
      opts.conflict[mode] = forcedConflict - 1
      const err = new Error('settings conflict for "llm-pi-ai": forced conflict (' + mode + ')')
      err.name = 'SettingsConflictError'
      err.code = 'SETTINGS_CONFLICT'
      throw err
    }
    if (expectedRevision !== undefined && expectedRevision !== state.revision) {
      const err = new Error('settings conflict for "llm-pi-ai": expected revision ' + expectedRevision + ' but current revision is ' + state.revision)
      err.name = 'SettingsConflictError'
      err.code = 'SETTINGS_CONFLICT'
      throw err
    }
  }
  const settings = {
    writable: opts.writable !== false,
    get(ns) { return ns === 'llm-pi-ai' ? resolved() : undefined },
    describe() {
      return [{
        ns: 'llm-pi-ai',
        schema: {},
        revision: state.revision,
        // opts.hideUser 模拟"用户层没有任何该 ns 的片段"（配置全来自组合基座）
        user: opts.hideUser ? undefined : (cloneJson(state.section) || {}),
        value: resolved(),
      }]
    },
    async update(ns, patch, expectedRevision) {
      if (ns !== 'llm-pi-ai') {
        guard(expectedRevision, 'update')
        state.other = state.other || {}
        state.other[ns] = mergeLayers(state.other[ns] || {}, patch)
        state.writes.push({ ns, mode: 'update', patch: cloneJson(patch) })
        return state.other[ns]
      }
      guard(expectedRevision, 'update')
      const next = mergeLayers(cloneJson(state.section) || {}, patch)
      if (ConfigSchema) ConfigSchema(next) // 真 schema 校验：不合法就抛
      state.section = next
      state.revision += 1
      state.writes.push({ ns, mode: 'update', patch: cloneJson(patch) })
      return resolved()
    },
    async replace(ns, section, expectedRevision) {
      if (ns !== 'llm-pi-ai') {
        guard(expectedRevision, 'replace')
        state.other = state.other || {}
        state.other[ns] = cloneJson(section) || {}
        state.writes.push({ ns, mode: 'replace', section: cloneJson(section) })
        return state.other[ns]
      }
      guard(expectedRevision, 'replace')
      const next = cloneJson(section) || {}
      if (ConfigSchema) ConfigSchema(next)
      state.section = next
      state.revision += 1
      state.writes.push({ ns, mode: 'replace', section: cloneJson(section) })
      return resolved()
    },
    async mutate(ns, ops, expectedRevision) {
      if (ns !== 'llm-pi-ai') {
        guard(expectedRevision, 'mutate')
        state.other = state.other || {}
        state.other[ns] = cloneJson(state.other[ns]) || {}
        for (const op of ops) applyPathOp(state.other[ns], op)
        state.writes.push({ ns, mode: 'mutate', ops: cloneJson(ops) })
        return state.other[ns]
      }
      guard(expectedRevision, 'mutate')
      const next = cloneJson(state.section) || {}
      for (const op of ops) applyPathOp(next, op)
      if (ConfigSchema) ConfigSchema(next)
      state.section = next
      state.revision += 1
      state.writes.push({ ns, mode: 'mutate', ops: cloneJson(ops) })
      return resolved()
    },
  }
  return { settings, state, resolved }
}

/* ─────────── 假 llm 服务（方法在原型上 → 验证 dispose 的 delete 分支） ─────────── */

class FakeLlm {
  constructor() { this.discoverCalls = []; this.resolveCalls = [] }
  async discoverModels(settingsNs, request, signal) {
    this.discoverCalls.push({ settingsNs, request, hadSignal: !!signal })
    return [{ id: 'glm-5.3' }, { id: 'litellm-only-model' }, { id: 'private-unknown-model' }]
  }
  async resolveModelInfo(provider, model, signal) {
    this.resolveCalls.push({ provider, model, hadSignal: !!signal })
    const info = { provider, id: model, name: model, inputModalities: ['text'] }
    if (model === 'glm-5.3-already-annotated') {
      info.context = { contextWindow: 999 }
      info.defaultMaxTokens = 111
      info.reasoning = { efforts: [{ id: 'low', name: 'Low' }], defaultEffort: 'low' }
    }
    return info
  }
}

/* ─────────── 假 ctx 组装 + 路由派发 ─────────── */

async function makeHarness(initialSection, options) {
  const opts = options || {}
  const { settings, state } = makeSettings(initialSection, opts)
  const llm = Object.prototype.hasOwnProperty.call(opts, 'llm') ? opts.llm : new FakeLlm()
  const routes = []
  const disposers = []
  const disposeHandlers = []
  const logs = []
  const ctx = {
    settings,
    llm,
    timer: { timeout: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))) },
    webServer: { register(route) { routes.push(route); return () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1) } } },
    get(name) { return opts.services ? opts.services[name] : undefined },
    effect(fn, label) { const dispose = fn(); disposers.push({ dispose, label }) },
    on(event, fn) { if (event === 'dispose') disposeHandlers.push(fn) },
    logger: {
      info: (m) => logs.push('info ' + m),
      warn: (m) => logs.push('warn ' + m),
      debug: (m) => logs.push('debug ' + m),
      error: (m) => logs.push('error ' + m),
    },
  }
  const mod = await import(pathToFileURL(join(root, 'lib/index.js')).href + '?it=' + Date.now() + Math.random())
  mod.apply(ctx)

  function dispatch(fullPath, method, body, headers) {
    const qIndex = fullPath.indexOf('?')
    const pathOnly = qIndex >= 0 ? fullPath.slice(0, qIndex) : fullPath
    const query = qIndex >= 0 ? fullPath.slice(qIndex) : ''
    const route = routes.find((r) => r.path === pathOnly)
    if (!route) throw new Error('no route for ' + fullPath)
    const payload = body === undefined ? '' : JSON.stringify(body)
    const req = {
      method,
      url: pathOnly + query,
      headers: Object.assign({ host: '127.0.0.1:3080' }, headers || {}),
      socket: { remoteAddress: '127.0.0.1' },
      on(event, fn) {
        if (event === 'data') { if (payload) fn(Buffer.from(payload)); return this }
        if (event === 'end') { fn(); return this }
        return this
      },
      destroy() {},
    }
    return new Promise((resolve, reject) => {
      const res = {
        statusCode: 0,
        headers: null,
        body: '',
        writeHead(status, h) { res.statusCode = status; res.headers = h },
        end(chunk) {
          res.body = chunk
          try { resolve({ status: res.statusCode, json: JSON.parse(chunk), headers: res.headers || {} }) } catch (e) { reject(e) }
        },
      }
      route.handler(req, res)
      setTimeout(() => reject(new Error('route timeout: ' + fullPath)), 20000).unref?.()
    })
  }

  async function get(path, headers) { return dispatch(path, 'GET', undefined, headers) }
  async function post(path, body, headers) { return dispatch(path, 'POST', body === undefined ? {} : body, headers) }
  function runDispose() { for (const fn of disposeHandlers) fn(); for (const d of disposers) d.dispose() }

  return { ctx, settings, state, llm, routes, get, post, runDispose, mod, logs, resolved: () => settings.get('llm-pi-ai') }
}

/* ─────────── 初始配置 ─────────── */

const PREF = {
  modelsDevUrl: CATALOG_BASE + '/models-dev.json',
  litellmUrl: CATALOG_BASE + '/litellm.json',
  openrouterUrl: CATALOG_BASE + '/openrouter.json',
  sources: {
    modelsDev: { enabled: true },
    litellm: { enabled: true },
    openrouter: { enabled: true },
  },
}

const INITIAL = {
  __modelSuite: cloneJson(PREF),
  providers: {
    'hub-gm': {
      api: 'openai-completions',
      baseURL: 'https://hub.example.com/v1',
      models: [
        { id: 'glm-5.3' },
        { id: 'litellm-only-model' },
        { id: 'private-unknown-model' },
        { id: 'glm-4.6', contextWindow: 256000, maxTokens: 32000, input: ['text'], name: 'My GLM' },
      ],
    },
    deepseek: {
      api: 'openai-completions',
      baseURL: 'https://api.deepseek.com',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      models: [{ id: 'deepseek-chat' }],
    },
  },
}

/* ═══════════════ 1. bootstrap / 路由注册 ═══════════════ */

const h = await makeHarness(INITIAL)
check(h.routes.length === 14, 'exactly 14 routes registered (found ' + h.routes.length + ')')
const paths = h.routes.map((r) => r.path).sort()
for (const required of [
  '/api/suite/bootstrap', '/api/suite/list-models', '/api/suite/save-model', '/api/suite/apply-preset',
  '/api/suite/discover-models', '/api/suite/refresh-models', '/api/suite/add-models', '/api/suite/delete-model',
  '/api/suite/enrich-models', '/api/suite/save-sources', '/api/suite/save-provider-advanced',
  '/api/suite/save-auto-config', '/api/suite/test-model', '/api/suite/check-update',
]) {
  check(paths.indexOf(required) >= 0, 'route present: ' + required)
}
check(!paths.some((p) => p.includes('add-provider')), 'no add-provider route')
check(!paths.some((p) => /save-provider$/.test(p)), 'no legacy save-provider route')

let r = await h.get('/api/suite/bootstrap')
check(r.status === 200 && r.json.ok !== false, 'bootstrap returns 200')
check(r.json.writable === true, 'bootstrap.writable true')
check(r.json.version === h.mod.VERSION && h.mod.VERSION === '0.1.1', 'bootstrap.version mirrors the lib VERSION export (0.1.1)')
check(JSON.stringify(r.json.levels) === '["off","minimal","low","medium","high","xhigh","max"]', 'bootstrap.levels = 7 thinking levels')
check(r.json.protocols.length === 3 && r.json.listableProtocols.length === 2, 'bootstrap protocols')
check(Array.isArray(r.json.compatFields['openai-completions']) && r.json.compatFields['openai-completions'].length === 19, 'bootstrap.compatFields[openai-completions] = 19')
check(r.json.compatFields['openai-responses'].length === 4, 'bootstrap.compatFields[openai-responses] = 4')
check(r.json.compatFields['anthropic-messages'].length === 7, 'bootstrap.compatFields[anthropic-messages] = 7')
check(r.json.compatFields['openai-completions'][0].field && r.json.compatFields['openai-completions'][0].label, 'compat field metadata has field/label/description')
check(r.json.auto.enabled === true && r.json.auto.persistOnSave === true, 'bootstrap.auto defaults on')
check(r.json.auto.includeCatalogRoutes === false, 'bootstrap.auto.includeCatalogRoutes default off')
check(r.json.defaults.contextWindow === 262144 && r.json.defaults.maxTokens === 32768, 'bootstrap platform defaults are labels only')
check(r.json.defaultTestPrompt.length > 0 && r.json.defaultTestMaxTokens === 16384, 'bootstrap test defaults')
const bootHub = r.json.providers.find((p) => p.provider === 'hub-gm')
const bootDs = r.json.providers.find((p) => p.provider === 'deepseek')
check(bootHub && bootHub.modelCount === 4 && bootHub.api === 'openai-completions', 'bootstrap providers[hub-gm]')
check(bootHub.isCatalogRoute === false && bootDs.isCatalogRoute === true, 'bootstrap isCatalogRoute classification')
check(bootHub.withVision === 0 && bootHub.withEffort === 0, 'bootstrap capability counters start at 0')
check(bootHub.defaultsConfigured.contextWindow === false, 'defaultsConfigured false when the user never set it')
check(bootHub.headersCount === 0 && bootHub.retryPolicy === null, 'headersCount / retryPolicy initial')
check(bootHub.retryLabel === '默认 5 次', 'unconfigured retry label matches the real dsh-llm default (DEFAULT_MAX_RETRIES = 5), got: ' + bootHub.retryLabel)
check(r.json.defaults.providerMaxRetries === 5, 'bootstrap.defaults.providerMaxRetries = 5')
check((r.headers || {})['cache-control'] === 'no-store', 'M7: API responses carry cache-control: no-store')

// 405 / 403 / 404 语义
let bad = await h.post('/api/suite/bootstrap', {})
check(bad.status === 405, 'GET route rejects POST with 405')
bad = await h.get('/api/suite/save-model')
check(bad.status === 405, 'POST route rejects GET with 405')
bad = await h.post('/api/suite/save-model', {}, { origin: 'http://evil.example.com' })
check(bad.status === 403, 'cross-origin POST rejected with 403: ' + JSON.stringify(bad.json))
bad = await h.post('/api/suite/save-model', {}, { origin: 'http://127.0.0.1:3080' })
check(bad.status === 400, 'same-origin POST passes the fence (400 for a bad body)')
// H1（三轮）：Host 头栅栏——DNS rebinding 下 Origin 与 Host 同为攻击者域名，
// 旧的 Origin≈Host 一致性检查会放行；必须靠「Host 必须是 loopback 字面量」拦下。
bad = await h.get('/api/suite/bootstrap', { host: 'evil.example.com:3080' })
check(bad.status === 403 && /host/i.test(bad.json.error), 'H1: GET with a rebinding Host is rejected with 403 (bootstrap leaks baseURLs/headers)')
bad = await h.get('/api/suite/bootstrap', { host: 'localhost:3080' })
check(bad.status === 200, 'H1: a loopback Host (localhost) passes the GET gate')
bad = await h.get('/api/suite/bootstrap', { host: '127.0.0.1.evil.com:3080' })
check(bad.status === 403, 'H1: suffix trick on the Host header is rejected')
bad = await h.post('/api/suite/save-model', { provider: 'hub-gm', modelId: 'x', editor: {} }, { host: 'evil.example.com:3080', origin: 'http://evil.example.com:3080' })
check(bad.status === 403 && /host/i.test(bad.json.error), 'H1: a full rebinding write (Origin==Host==evil, loopback remote) is blocked by the Host gate')
bad = await h.post('/api/suite/delete-model', { provider: 'hub-gm', modelId: 'nope' })
check(bad.status === 404, 'delete-model on a missing id returns 404')
// M3：超限 body → 400（排干而不是销毁连接——响应必须能送达）
bad = await h.post('/api/suite/save-model', { provider: 'hub-gm', modelId: 'x', editor: 'y'.repeat(300 * 1024) })
check(bad.status === 400 && /body-too-large/.test(bad.json.error), 'M3: an oversized body is rejected with a deliverable 400')
bad = await h.post('/api/suite/save-model', { provider: 'ghost', modelId: 'x', editor: {} })
check(bad.status === 400 && /渠道不存在/.test(bad.json.error), 'save-model on an unknown provider returns 400')

// 只读 settings → writable=false
const ro = await makeHarness(INITIAL, { writable: false })
const roBoot = await ro.get('/api/suite/bootstrap')
check(roBoot.json.writable === false, 'read-only settings reported')
const roWrite = await ro.post('/api/suite/save-model', { provider: 'hub-gm', modelId: 'glm-5.3', editor: {} })
check(roWrite.status === 400 && /只读/.test(roWrite.json.error), 'read-only settings rejects writes')
ro.runDispose()

/* ═══════════════ 2. list-models ═══════════════ */

r = await h.get('/api/suite/list-models?provider=hub-gm')
check(r.status === 200 && r.json.models.length === 4, 'list-models returns all models')
const mv = r.json.models.find((m) => m.id === 'glm-4.6')
check(mv.contextWindow === 256000 && mv.maxTokens === 32000, 'list-models reports manual values')
check(mv.levels.length === 7 && mv.levels[0].level === 'off', 'list-models levels = 7 entries')
check(mv.compatCount === 0, 'list-models compatCount 0 when unset')
check(typeof mv.source === 'string', 'list-models has a parameter-source badge')
bad = await h.get('/api/suite/list-models?provider=ghost')
check(bad.status === 404 && /渠道不存在/.test(bad.json.error), 'list-models unknown provider -> 404')

/* ═══════════════ 3. save-model：name / compat / 校验 ═══════════════ */

r = await h.post('/api/suite/save-model', {
  provider: 'hub-gm',
  modelId: 'glm-5.3',
  editor: {
    disabled: false,
    levels: [
      { level: 'off', enabled: true, wireNull: true },
      { level: 'low', enabled: true, wire: 'low' },
      { level: 'medium', enabled: true, wire: 'medium' },
      { level: 'high', enabled: true, wire: 'high' },
    ],
    vision: true,
    contextWindow: 1048576,
    maxTokens: 384000,
    name: '  GLM 5.3 中文名  ',
    compat: { supportsDeveloperRole: false, supportsStore: true, maxTokensField: 'max_tokens' },
  },
})
check(r.status === 200 && r.json.ok === true, 'save-model succeeded: ' + JSON.stringify(r.json).slice(0, 200))
check(r.json.model.name === 'GLM 5.3 中文名', 'name trimmed and saved')
check(r.json.model.compatCount === 3, 'model-level compat saved (3 fields)')
check(JSON.stringify(r.json.model.input) === '["text","image"]', 'vision saved as input [text,image]')
check(r.json.model.contextWindow === 1048576 && r.json.model.maxTokens === 384000, 'capacities saved')
check(r.json.model.summary === 'high', 'effort summary = highest enabled level')

let stored = h.state.section.providers['hub-gm'].models.find((m) => m.id === 'glm-5.3')
check(stored.compat.supportsDeveloperRole === false, 'model compat persisted to settings')
check(stored.compat.supportsStore === true && stored.compat.maxTokensField === 'max_tokens', 'full model compat persisted (risk #7: not only thinkingFormat/supportsReasoningEffort)')
check(stored.name === 'GLM 5.3 中文名', 'model name persisted')

// 协议不支持的字段 → 400（不是静默丢弃）
bad = await h.post('/api/suite/save-model', {
  provider: 'hub-gm', modelId: 'glm-5.3',
  editor: { disabled: true, levels: [], vision: false, compat: { supportsEagerToolInputStreaming: true } },
})
check(bad.status === 400 && /不支持/.test(bad.json.error), 'model-level compat with a field the protocol does not offer is rejected: ' + JSON.stringify(bad.json))
bad = await h.post('/api/suite/save-model', {
  provider: 'hub-gm', modelId: 'glm-5.3',
  editor: { disabled: true, levels: [], vision: false, compat: { maxTokensField: 'not_a_field' } },
})
check(bad.status === 400, 'invalid enum rejected')
bad = await h.post('/api/suite/save-model', {
  provider: 'hub-gm', modelId: 'glm-5.3',
  editor: { disabled: false, levels: [{ level: 'high', enabled: true, wire: '' }], vision: false },
})
check(bad.status === 400 && /wire/.test(bad.json.error), 'empty wire for a non-off level rejected')

// 保存 name 为空 → 删除该键
r = await h.post('/api/suite/save-model', {
  provider: 'hub-gm', modelId: 'glm-5.3',
  editor: { disabled: false, levels: [{ level: 'low', enabled: true, wire: 'low' }], vision: true, name: '', compat: null },
})
check(r.status === 200, 'save-model with cleared name/compat succeeded')
stored = h.state.section.providers['hub-gm'].models.find((m) => m.id === 'glm-5.3')
check(stored.name === undefined, 'empty name removes the key')
check(stored.compat === undefined, 'compat:null removes the key')

// 保存单个模型不得抹掉其它模型的 compat（风险 #7 的端到端验证）
const before4 = cloneJson(h.state.section.providers['hub-gm'].models.find((m) => m.id === 'glm-4.6'))
r = await h.post('/api/suite/save-model', {
  provider: 'hub-gm', modelId: 'glm-5.3',
  editor: { disabled: true, levels: [], vision: false },
})
check(r.status === 200, 'save another model')
const after4 = h.state.section.providers['hub-gm'].models.find((m) => m.id === 'glm-4.6')
check(JSON.stringify(after4) === JSON.stringify(before4), 'saving one model must not damage siblings')
check(h.state.section.providers['hub-gm'].models.length === 4, 'model count preserved')

/* ═══════════════ 4. apply-preset ═══════════════ */

r = await h.post('/api/suite/apply-preset', { provider: 'hub-gm', modelId: 'glm-5.3', presetId: 'all' })
check(r.status === 200, 'apply-preset all')
stored = h.state.section.providers['hub-gm'].models.find((m) => m.id === 'glm-5.3')
check(Object.keys(stored.reasoningEfforts).length === 7, 'preset "all" enables all 7 levels')
r = await h.post('/api/suite/apply-preset', { provider: 'hub-gm', modelId: 'glm-5.3', presetId: 'none' })
check(r.status === 200 && h.state.section.providers['hub-gm'].models.find((m) => m.id === 'glm-5.3').reasoningEfforts === false, 'preset "none" sets reasoningEfforts false')
bad = await h.post('/api/suite/apply-preset', { provider: 'hub-gm', modelId: 'glm-5.3', presetId: 'nope' })
check(bad.status === 400, 'unknown preset rejected')

/* ═══════════════ 5. save-provider-advanced ═══════════════ */

r = await h.post('/api/suite/save-provider-advanced', {
  provider: 'hub-gm',
  compat: { supportsDeveloperRole: false, supportsStore: true, thinkingFormat: 'deepseek' },
  retryPolicy: { mode: 'normal', maxRetries: 4 },
  defaultContextWindow: 200000,
  defaultMaxTokens: 20000,
  defaultInput: ['image'],
  headers: { 'X-Title': 'my-app', 'X-Api-Base': 'https://x.example.com' },
})
check(r.status === 200 && r.json.ok === true, 'save-provider-advanced ok: ' + JSON.stringify(r.json).slice(0, 200))
check(r.json.via === 'mutate', 'wrote via mutate first')
const prof = h.state.section.providers['hub-gm']
check(prof.compat.supportsDeveloperRole === false && prof.compat.thinkingFormat === 'deepseek', 'route-level compat written')
check(prof.retryPolicy.mode === 'normal' && prof.retryPolicy.maxRetries === 4, 'retryPolicy written')
check(prof.defaultContextWindow === 200000 && prof.defaultMaxTokens === 20000, 'route defaults written')
check(JSON.stringify(prof.defaultInput) === '["text","image"]', 'defaultInput written with text forced in')
check(prof.headers['X-Title'] === 'my-app', 'headers written')
check(h.resolved().providers['hub-gm'].defaultContextWindow === 200000, 'real dsh-llm-pi-ai schema accepts the written profile')

// 白名单：未知键拒绝
bad = await h.post('/api/suite/save-provider-advanced', { provider: 'hub-gm', timeoutMs: 1000 })
check(bad.status === 400 && /不支持的字段/.test(bad.json.error), 'non-whitelisted field rejected: ' + JSON.stringify(bad.json))
// 协议不支持的 compat 字段拒绝
bad = await h.post('/api/suite/save-provider-advanced', { provider: 'hub-gm', compat: { forceAdaptiveThinking: true } })
check(bad.status === 400 && /不支持/.test(bad.json.error), 'route-level compat with a foreign-protocol field rejected')
// headers 注入拒绝
bad = await h.post('/api/suite/save-provider-advanced', { provider: 'hub-gm', headers: { 'X-Title': 'a\r\nX-Evil: 1' } })
check(bad.status === 400 && /换行/.test(bad.json.error), 'header CRLF injection rejected: ' + JSON.stringify(bad.json))
// defaultInput 不可为空
bad = await h.post('/api/suite/save-provider-advanced', { provider: 'hub-gm', defaultInput: [] })
check(bad.status === 400 && /不可为空/.test(bad.json.error), 'empty defaultInput rejected')
// 保留名 → 黄色提示（非阻断）
r = await h.post('/api/suite/save-provider-advanced', { provider: 'hub-gm', headers: { 'X-Title': 'ok', 'User-Agent': 'spoof' } })
check(r.status === 200 && r.json.warnings.some((w) => /保留名/.test(w)), 'reserved header name yields a warning, not a rejection')
// 清除：null 真的把键删掉
r = await h.post('/api/suite/save-provider-advanced', { provider: 'hub-gm', retryPolicy: null, headers: null, defaultInput: null })
check(r.status === 200, 'clear request accepted')
const profAfterClear = h.state.section.providers['hub-gm']
check(profAfterClear.retryPolicy === undefined, 'retryPolicy actually removed by clear')
check(profAfterClear.headers === undefined, 'headers actually removed by clear')
check(profAfterClear.defaultInput === undefined, 'defaultInput actually removed by clear')
check(profAfterClear.compat !== undefined, 'untouched fields survive a clear request')
// 三连降级：mutate 失败 → replace；replace 也失败 → update（并警告"清除不生效"）；全失败 → 聚合错误
const degrade = await makeHarness(INITIAL, { fail: { mutate: 2, replace: 2 } })
r = await degrade.post('/api/suite/save-provider-advanced', { provider: 'hub-gm', retryPolicy: { mode: 'normal', maxRetries: 9 } })
check(r.status === 200 && r.json.via === 'update', 'mutate+replace failing degrades to update (via=' + r.json.via + ')')
check(degrade.state.section.providers['hub-gm'].retryPolicy.maxRetries === 9, 'degraded write actually landed')
degrade.runDispose()
const degradeClear = await makeHarness(Object.assign({}, cloneJson(INITIAL), {
  providers: {
    'hub-gm': Object.assign({}, cloneJson(INITIAL.providers['hub-gm']), { headers: { 'X-Old': 'v' } }),
    deepseek: cloneJson(INITIAL.providers.deepseek),
  },
}), { fail: { mutate: 2, replace: 2 } })
r = await degradeClear.post('/api/suite/save-provider-advanced', { provider: 'hub-gm', headers: null })
check(r.status === 200 && r.json.warnings.some((w) => /未能清除/.test(w)), 'a clear that the update channel cannot express is warned about, not silently dropped')
degradeClear.runDispose()
const degrade2 = await makeHarness(INITIAL, { fail: { mutate: 2, replace: 2, update: 2 } })
r = await degrade2.post('/api/suite/save-provider-advanced', { provider: 'hub-gm', retryPolicy: { mode: 'normal', maxRetries: 9 } })
check(r.status === 400 && /保存渠道设置失败/.test(r.json.error), 'triple failure aggregates into one error: ' + JSON.stringify(r.json))
degrade2.runDispose()

/* ═══════════════ 6. 链路二：settings 写入自动补缺 ═══════════════ */

// 官方页形态：mutate + path=['providers',route,'models']
const rev = h.settings.describe()[0].revision
await h.settings.mutate('llm-pi-ai', [{
  op: 'set',
  path: ['providers', 'hub-gm', 'models'],
  value: [
    { id: 'glm-5.3' },
    { id: 'litellm-only-model' },
    { id: 'private-unknown-model' },
    { id: 'glm-4.6', contextWindow: 256000, maxTokens: 32000, input: ['text'] },
  ],
}], rev)
const afterChain2 = h.state.section.providers['hub-gm'].models
const c2glm = afterChain2.find((m) => m.id === 'glm-5.3')
check(c2glm.contextWindow === 1048576 && c2glm.maxTokens === 384000, 'link 2 filled capacities on save (#2)')
check(c2glm.input && c2glm.input.indexOf('image') >= 0, 'link 2 filled vision')
check(c2glm.reasoningEfforts && c2glm.reasoningEfforts.high === 'high', 'link 2 filled reasoning efforts')
check(c2glm.reasoningEfforts.low === 'low' && c2glm.reasoningEfforts.medium === 'medium', 'link 2 used catalog levels, not a hardcoded default')
const c2litellm = afterChain2.find((m) => m.id === 'litellm-only-model')
check(c2litellm.contextWindow === 64000 && c2litellm.maxTokens === 2000, 'link 2 hit a LiteLLM-only id (three sources)')
check(c2litellm.input && c2litellm.input.indexOf('image') >= 0, 'litellm vision flag mapped')
const c2private = afterChain2.find((m) => m.id === 'private-unknown-model')
check(JSON.stringify(c2private) === JSON.stringify({ id: 'private-unknown-model' }), 'link 2 writes NOTHING for an unknown id (#4)')
const c2keep = afterChain2.find((m) => m.id === 'glm-4.6')
check(c2keep.contextWindow === 256000 && c2keep.maxTokens === 32000, 'link 2 preserves hand-written 256000/32000 (#4 only-fill)')
check(JSON.stringify(c2keep.input) === '["text"]', 'link 2 preserves hand-written text-only input')
check(!!ConfigSchema, 'schema validated the enriched write')

// 命名空间闸门（修正 R1）：只有 llm-pi-ai 会被富化，其它 ns 原样透传。
// 观察点是 fake settings 自身记录的写入（即补丁内部 bound(...) 真正收到的东西）。
const gate = await makeHarness(INITIAL, {})
const gateOps = () => [{ op: 'set', path: ['providers', 'hub-gm', 'models'], value: [{ id: 'glm-5.3' }] }]
await gate.settings.mutate('llm-pi-ai', gateOps())
let gateWrite = gate.state.writes[gate.state.writes.length - 1]
check(gateWrite.ns === 'llm-pi-ai' && gateWrite.mode === 'mutate', 'gate: llm-pi-ai mutate reached the real channel')
check(gateWrite.ops[0].value[0].contextWindow === 1048576, 'llm-pi-ai ops ARE enriched before the real write')
await gate.settings.mutate('some-other-ns', gateOps())
gateWrite = gate.state.writes[gate.state.writes.length - 1]
check(gateWrite.ns === 'some-other-ns' && gateWrite.ops[0].value[0].contextWindow === undefined, 'R1 namespace gate: a non-llm-pi-ai namespace passes through untouched')
check(gate.state.other['some-other-ns'].providers['hub-gm'].models[0].contextWindow === undefined, 'the foreign namespace document stayed raw')
gate.runDispose()

// 保存时自动写盘开关：关掉后链路二不再补写
const noPersist = await makeHarness(Object.assign({}, cloneJson(INITIAL), {
  __modelSuite: Object.assign(cloneJson(PREF), { auto: { enabled: true, persistOnSave: false } }),
}))
await noPersist.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'hub-gm', 'models'], value: [{ id: 'glm-5.3' }] }])
check(noPersist.state.section.providers['hub-gm'].models[0].contextWindow === undefined, 'persistOnSave=false stops link 2 from writing (#5)')
noPersist.runDispose()

// 逐个字段开关
for (const off of ['contextWindow', 'maxTokens', 'input', 'reasoningEfforts']) {
  const fields = { contextWindow: true, maxTokens: true, input: true, reasoningEfforts: true }
  fields[off] = false
  const fh = await makeHarness(Object.assign({}, cloneJson(INITIAL), {
    __modelSuite: Object.assign(cloneJson(PREF), { auto: { enabled: true, persistOnSave: true, fields: fields } }),
  }))
  await fh.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'hub-gm', 'models'], value: [{ id: 'glm-5.3' }] }])
  const m = fh.state.section.providers['hub-gm'].models[0]
  check(m[off] === undefined, 'field switch off: ' + off + ' not written (#6)')
  const stillWritten = ['contextWindow', 'maxTokens', 'input', 'reasoningEfforts'].filter((k) => k !== off)
  for (const other of stillWritten) check(m[other] !== undefined, 'field switch off ' + off + ': ' + other + ' is still written')
  check(Object.keys(m).sort().join(',') === ['id'].concat(stillWritten).sort().join(','), 'field switch off ' + off + ': exactly the enabled fields were written (got ' + Object.keys(m).join(',') + ')')
  fh.runDispose()
}

// 总开关
const offAll = await makeHarness(Object.assign({}, cloneJson(INITIAL), {
  __modelSuite: Object.assign(cloneJson(PREF), { auto: { enabled: false } }),
}))
await offAll.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'hub-gm', 'models'], value: [{ id: 'glm-5.3' }] }])
check(offAll.state.section.providers['hub-gm'].models[0].contextWindow === undefined, 'auto.enabled=false disables link 2')
offAll.runDispose()

// 内置渠道默认不被富化（#7），除非 includeCatalogRoutes
await h.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'deepseek', 'models'], value: [{ id: 'deepseek-chat' }] }])
check(h.state.section.providers.deepseek.models[0].contextWindow === undefined, 'link 2 skips catalog routes by default (#7)')
const incl = await makeHarness(Object.assign({}, cloneJson(INITIAL), {
  __modelSuite: Object.assign(cloneJson(PREF), { auto: { enabled: true, persistOnSave: true, includeCatalogRoutes: true } }),
}))
await incl.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'deepseek', 'models'], value: [{ id: 'deepseek-chat' }] }])
check(incl.state.section.providers.deepseek.models[0].contextWindow === 131072, 'includeCatalogRoutes opts catalog routes in')
incl.runDispose()

// 冲突：不得降级重试，直接抛出
const conflictHarness = await makeHarness(INITIAL)
let conflictError = null
try {
  await conflictHarness.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'hub-gm', 'models'], value: [{ id: 'glm-5.3' }] }], 999)
} catch (e) { conflictError = e }
check(conflictError && conflictError.name === 'SettingsConflictError', 'CAS conflict propagates unchanged (no silent retry)')
conflictHarness.runDispose()

// B2：经 HTTP 端点的 CAS 冲突必须返回 409（README §8 承诺的终端状态码），而不是 400
const httpConflict = await makeHarness(INITIAL, { conflict: { update: 1 } })
let cfr = await httpConflict.post('/api/suite/save-model', {
  provider: 'hub-gm', modelId: 'glm-5.3',
  editor: { disabled: true, levels: [], vision: false, contextWindow: 0, maxTokens: 0 },
})
check(cfr.status === 409 && /刷新后重试/.test(cfr.json.error), 'B2: an HTTP CAS conflict returns 409 with the refresh hint (got ' + cfr.status + ' ' + JSON.stringify(cfr.json.error) + ')')
httpConflict.runDispose()

/* ═══════════════ 7. 链路一：discoverModels ═══════════════ */

const spec = new AbortController()
let discovered = await h.llm.discoverModels('llm-pi-ai', { provider: 'hub-gm', baseURL: 'https://hub.example.com/v1' }, spec.signal)
check(h.llm.discoverCalls.length === 1, 'original discoverModels called once')
check(h.llm.discoverCalls[0].hadSignal === true, 'R6: the signal argument is forwarded to the original method')
const dGlm = discovered.find((m) => m.id === 'glm-5.3')
check(dGlm.contextWindow === 1048576 && dGlm.maxTokens === 384000, 'link 1 filled capacities (#1)')
check(dGlm.input === undefined && dGlm.reasoningEfforts === undefined, 'link 1 only writes contextWindow/maxTokens')
check(discovered.find((m) => m.id === 'private-unknown-model').contextWindow === undefined, 'link 1 leaves unknown ids alone (no 128K/4096 fallback)')
check(discovered.find((m) => m.id === 'litellm-only-model').contextWindow === 64000, 'link 1 consults all three sources')
discovered = await h.llm.discoverModels('llm-pi-ai', { provider: 'deepseek' }, undefined)
check(discovered.find((m) => m.id === 'glm-5.3').contextWindow === undefined, 'link 1 skips catalog routes by default')
discovered = await h.llm.discoverModels('llm-pi-ai', { baseURL: 'https://brand-new.example.com/v1' }, undefined)
check(discovered.find((m) => m.id === 'glm-5.3').contextWindow === 1048576, 'link 1 treats a brand-new draft (no route yet) as custom')

/* ═══════════════ 8. 链路三：resolveModelInfo ═══════════════ */

const info = await h.llm.resolveModelInfo('hub-gm', 'glm-5.3', spec.signal)
check(h.llm.resolveCalls[0].hadSignal === true, 'R6: resolveModelInfo forwards the signal')
check(info.context && info.context.contextWindow === 1048576, 'link 3 injected context')
check(info.defaultMaxTokens === 384000, 'link 3 injected defaultMaxTokens')
check(info.inputModalities.indexOf('image') >= 0 && info.inputModalities.indexOf('text') >= 0, 'link 3 merged image into inputModalities (not replaced)')
check(info.reasoning && Array.isArray(info.reasoning.efforts), 'link 3 reasoning.efforts is an ARRAY (DSH normalizeModelInfo shape)')
check(info.reasoning.efforts.every((e) => typeof e.id === 'string' && typeof e.name === 'string'), 'link 3 efforts entries are {id,name}')
check(info.reasoning.efforts.map((e) => e.id).join(',') === 'off,low,medium,high', 'link 3 efforts = catalog levels (off always present) in THINKING_LEVELS order')
check(info.reasoning.efforts[0].id === 'off' && info.reasoning.efforts[0].name === 'Off', 'the off entry is exposed so the UI can turn reasoning off (got ' + JSON.stringify(info.reasoning.efforts[0]) + ')')
check(info.reasoning.defaultEffort === 'high', 'R8: defaultEffort is the highest injected non-off level (not hardcoded "high" by luck)')
const infoDs = await h.llm.resolveModelInfo('deepseek', 'glm-5.3')
check(infoDs.context === undefined && infoDs.reasoning === undefined, 'link 3 skips catalog routes by default')
const infoAnnotated = await h.llm.resolveModelInfo('hub-gm', 'glm-5.3-already-annotated')
check(infoAnnotated.context.contextWindow === 999, 'link 3 does not overwrite an existing context (only-fill)')
check(infoAnnotated.defaultMaxTokens === 111, 'link 3 does not overwrite an existing defaultMaxTokens (no 32K/4096 sentinel)')
check(infoAnnotated.reasoning.defaultEffort === 'low' && infoAnnotated.reasoning.efforts.length === 1, 'link 3 does not overwrite existing reasoning')

/* ═══════════════ 9. enrich-models（预览 + 写回） ═══════════════ */

// 专用 harness：一个"未被链路二补过"的干净渠道，且 glm-4.6 已手填全部四类字段
const ENRICH_INITIAL = {
  __modelSuite: cloneJson(PREF),
  providers: {
    'hub-gm': {
      api: 'openai-completions',
      baseURL: 'https://hub.example.com/v1',
      models: [
        { id: 'glm-5.3' },
        { id: 'litellm-only-model' },
        { id: 'private-unknown-model' },
        { id: 'glm-4.6', contextWindow: 256000, maxTokens: 32000, input: ['text'], reasoningEfforts: { low: 'low' }, name: 'My GLM' },
      ],
    },
  },
}
const en = await makeHarness(ENRICH_INITIAL)
r = await en.post('/api/suite/enrich-models', { provider: 'hub-gm', apply: false })
check(r.status === 200 && r.json.ok === true, 'enrich-models preview ok')
check(r.json.localCount === 4, 'enrich-models localCount')
check(r.json.changes.length > 0, 'enrich-models produced changes')
const changeGlm = r.json.changes.find((c) => c.id === 'glm-5.3')
check(changeGlm && changeGlm.source === 'models.dev', 'change source is models.dev: ' + JSON.stringify(changeGlm))
check(changeGlm.contextWindow === 1048576 && changeGlm.maxTokens === 384000, 'change reports the filled capacities')
check(changeGlm.vision === true, 'change reports vision')
const changeLitellm = r.json.changes.find((c) => c.id === 'litellm-only-model')
check(changeLitellm && changeLitellm.source === 'litellm', 'litellm-only id reported with litellm source: ' + JSON.stringify(changeLitellm))
check(!r.json.changes.some((c) => c.id === 'private-unknown-model'), 'unknown id produces no change entry')
check(r.json.unmatched && r.json.unmatched.indexOf('private-unknown-model') >= 0, 'unknown id is reported in unmatched[] so the UI can show the 未命中 row')
check(r.json.unmatchedCount === 1, 'unmatchedCount matches')
check(!r.json.changes.some((c) => c.id === 'glm-4.6'), 'overwrite=false leaves fully hand-filled values alone (no change entry)')
check(r.json.sourcesUsed.indexOf('models.dev') >= 0 && r.json.sourcesUsed.indexOf('litellm') >= 0, 'sourcesUsed lists the sources actually queried')
check(r.json.applied === false, 'preview does not apply')
const preStateStr = JSON.stringify(en.state.section)
r = await en.post('/api/suite/enrich-models', { provider: 'hub-gm', apply: false })
check(JSON.stringify(en.state.section) === preStateStr, 'preview writes nothing (no settings write recorded)')

r = await en.post('/api/suite/enrich-models', { provider: 'hub-gm', overwrite: true })
check(r.status === 200 && r.json.applied === true, 'enrich-models apply ok: ' + JSON.stringify(r.json).slice(0, 200))
const applied4 = en.state.section.providers['hub-gm'].models.find((m) => m.id === 'glm-4.6')
check(applied4.contextWindow === 131072 && applied4.maxTokens === 16384, 'overwrite=true replaced the manual 256000/32000 with the catalog values')
check(applied4.name === 'GLM 4.6', 'overwrite=true also replaces the display name with the catalog name (documented)')
check(en.state.section.providers['hub-gm'].models.find((m) => m.id === 'glm-5.3').name === 'GLM 5.3', 'overwrite=true filled a missing display name')
en.runDispose()

// 0 命中提示
const zero = await makeHarness({
  __modelSuite: cloneJson(PREF),
  providers: { 'hub-gm': { api: 'openai-completions', baseURL: 'https://hub.example.com/v1', models: [{ id: 'totally-private-xyz' }] } },
})
r = await zero.post('/api/suite/enrich-models', { provider: 'hub-gm', apply: false })
check(r.status === 200 && r.json.hitCount === 0, 'zero-hit preview reports hitCount 0')
check(r.json.unmatched && r.json.unmatched.length === 1, 'zero-hit preview lists the unmatched id')
check(/未命中任何目录源/.test(r.json.message), 'zero-hit message explains private ids (#8)')
zero.runDispose()

/* ═══════════════ 10. 按需拉取 & 失败源不缓存 ═══════════════ */

const needHits = Object.assign({}, hits)
const need = await makeHarness({
  __modelSuite: cloneJson(PREF),
  providers: { 'hub-gm': { api: 'openai-completions', baseURL: 'https://hub.example.com/v1', models: [{ id: 'glm-5.3' }] } },
})
await need.post('/api/suite/enrich-models', { provider: 'hub-gm', apply: false, forceCatalog: true })
const afterCovered = { m: hits.modelsDev - needHits.modelsDev, l: hits.litellm - needHits.litellm, o: hits.openrouter - needHits.openrouter }
check(afterCovered.m === 1, 'models.dev fetched once')
check(afterCovered.l === 0 && afterCovered.o === 0, 'R5/on-demand: sources 2 and 3 are NOT fetched when models.dev covers every queried id (' + JSON.stringify(afterCovered) + ')')
need.runDispose()

// 失败源不写缓存：一个不存在的 URL 每次调用都应重试
const badSrc = await makeHarness({
  __modelSuite: {
    modelsDevUrl: CATALOG_BASE + '/models-dev.json',
    litellmUrl: CATALOG_BASE + '/does-not-exist.json',
    openrouterUrl: CATALOG_BASE + '/undefined.json',
    sources: { modelsDev: { enabled: true }, litellm: { enabled: true }, openrouter: { enabled: true } },
  },
  providers: { 'hub-gm': { api: 'openai-completions', baseURL: 'https://hub.example.com/v1', models: [{ id: 'litellm-only-model' }] } },
})
const beforeBad = hits.byPath['/does-not-exist.json'] || 0
r = await badSrc.post('/api/suite/enrich-models', { provider: 'hub-gm', apply: false })
check(r.status === 200 && r.json.sourceErrors && r.json.sourceErrors.litellm, 'failing source reported in sourceErrors: ' + JSON.stringify(r.json.sourceErrors))
check(r.json.sourceWarnings && r.json.sourceWarnings.length > 0, 'failing source surfaces a human-readable warning')
r = await badSrc.post('/api/suite/enrich-models', { provider: 'hub-gm', apply: false })
const badAttempts = (hits.byPath['/does-not-exist.json'] || 0) - beforeBad
check(badAttempts >= 2, 'R5: a failing source is NOT cached and is retried on the next call (attempts=' + badAttempts + ')')
check((hits.byPath['/models-dev.json'] || 0) > 1, 'a successful source IS cached (models.dev served from cache on the 2nd call)')
badSrc.runDispose()

// B1：三源全部失败（快速 404）不得把"空快照"缓存成新鲜聚合结果——
// 下一次 bounded 调用（链路二保存）必须重新真实尝试，而不是被空快照挡 30 分钟。
const ALL_BAD_PREF = {
  modelsDevUrl: CATALOG_BASE + '/none-a.json',
  litellmUrl: CATALOG_BASE + '/none-b.json',
  openrouterUrl: CATALOG_BASE + '/none-c.json',
  sources: { modelsDev: { enabled: true }, litellm: { enabled: true }, openrouter: { enabled: true } },
}
const allBad = await makeHarness({
  __modelSuite: cloneJson(ALL_BAD_PREF),
  providers: { 'hub-gm': { api: 'openai-completions', baseURL: 'https://hub.example.com/v1', models: [{ id: 'glm-5.3' }] } },
})
r = await allBad.post('/api/suite/enrich-models', { provider: 'hub-gm', apply: false })
check(r.status === 200 && r.json.hitCount === 0 && r.json.sourceErrors && r.json.sourceErrors.modelsDev, 'B1: an all-sources failure reports per-source errors')
const beforeNone = hits.byPath['/none-a.json'] || 0
await allBad.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'hub-gm', 'models'], value: [{ id: 'glm-5.3' }] }])
check((hits.byPath['/none-a.json'] || 0) > beforeNone, 'B1: a total catalog failure is NOT cached as a fresh empty snapshot (the bounded path retries)')
allBad.runDispose()

// M2：**慢失败**（≥3s 的超时/挂起类）后进入冷却——bounded 热路径不再重复发起
// 拉取（否则断网期间每次解析都白等 3 秒）；写入本身必须立刻放行。
const slowBad = await makeHarness({
  __modelSuite: {
    modelsDevUrl: CATALOG_BASE + '/slow-fail.json',
    litellmUrl: CATALOG_BASE + '/none-b.json',
    openrouterUrl: CATALOG_BASE + '/none-c.json',
    sources: { modelsDev: { enabled: true }, litellm: { enabled: true }, openrouter: { enabled: true } },
  },
  providers: { 'hub-gm': { api: 'openai-completions', baseURL: 'https://hub.example.com/v1', models: [{ id: 'glm-5.3' }] } },
})
r = await slowBad.post('/api/suite/enrich-models', { provider: 'hub-gm', apply: false })
check(r.status === 200 && r.json.hitCount === 0, 'M2: a slow all-source failure still reports an empty catalog')
const slowHits = hits.byPath['/slow-fail.json'] || 0
check(slowHits >= 1, 'M2: the slow source was actually probed once')
const slowStart = Date.now()
await slowBad.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', 'hub-gm', 'models'], value: [{ id: 'glm-5.3' }] }])
check((hits.byPath['/slow-fail.json'] || 0) === slowHits, 'M2: the bounded hot path skips refetching during the slow-failure cooldown')
check(Date.now() - slowStart < 3000, 'M2: the save is not stalled waiting for the catalog during cooldown')
slowBad.runDispose()

/* ═══════════════ 11. delete-model / add-models / save-sources / save-auto-config ═══════════════ */

r = await h.post('/api/suite/delete-model', { provider: 'hub-gm', modelId: 'private-unknown-model' })
check(r.status === 200 && r.json.remaining === 3 && r.json.removed === 'private-unknown-model', 'delete-model removes one entry')
check(!h.state.section.providers['hub-gm'].models.some((m) => m.id === 'private-unknown-model'), 'deleted model gone from settings')
bad = await h.post('/api/suite/delete-model', { provider: 'hub-gm', modelId: 'private-unknown-model' })
check(bad.status === 404, 'delete-model is not idempotent (404 on a repeat delete)')
bad = await h.post('/api/suite/delete-model', { provider: 'ghost', modelId: 'x' })
check(bad.status === 400 && /渠道不存在/.test(bad.json.error), 'delete-model unknown provider -> 400')
bad = await h.post('/api/suite/delete-model', { provider: 'hub-gm', modelId: 'a b' })
check(bad.status === 400 && /非法字符/.test(bad.json.error), 'delete-model rejects an illegal id charset')
bad = await h.post('/api/suite/delete-model', { provider: 'hub-gm', modelId: 'x'.repeat(201) })
check(bad.status === 400 && /长度非法/.test(bad.json.error), 'delete-model rejects an over-long id')

// 删到空 → warnings
const emp = await makeHarness({
  __modelSuite: cloneJson(PREF),
  providers: { 'hub-gm': { api: 'openai-completions', baseURL: 'https://hub.example.com/v1', models: [{ id: 'only-one' }] } },
})
r = await emp.post('/api/suite/delete-model', { provider: 'hub-gm', modelId: 'only-one' })
check(r.status === 200 && r.json.remaining === 0 && r.json.warnings.some((w) => /已无模型条目/.test(w)), 'deleting the last model is allowed but warns (#12)')
emp.runDispose()

// B4：官方页/手写 settings 存入的"字符集之外"的 id（如中文）必须仍能被删除
// （先查表、查不到才做入参字符集校验——'a b' 不存在时依旧 400）
const uni = await makeHarness({
  __modelSuite: cloneJson(PREF),
  providers: { 'hub-gm': { api: 'openai-completions', baseURL: 'https://hub.example.com/v1', models: [{ id: '中文模型-一号' }, { id: 'ok-model' }] } },
})
r = await uni.post('/api/suite/delete-model', { provider: 'hub-gm', modelId: '中文模型-一号' })
check(r.status === 200 && r.json.remaining === 1, 'B4: a foreign id outside the plugin charset can still be deleted (got ' + r.status + ' ' + JSON.stringify(r.json.error) + ')')
uni.runDispose()

// B5：无 api（= 无 compat 字段表）的渠道上，空 compat 草稿绝不能清掉已有 compat
const NOAPI_INITIAL = {
  __modelSuite: cloneJson(PREF),
  providers: { 'odd-gw': { baseURL: 'https://odd.example.com/v1', models: [{ id: 'm1', compat: { futureCompat: 'keep' } }] } },
}
const wh = await makeHarness(NOAPI_INITIAL)
r = await wh.post('/api/suite/save-model', { provider: 'odd-gw', modelId: 'm1', editor: { disabled: false, levels: [], vision: false, name: 'Kept', compat: {} } })
check(r.status === 200, 'B5: saving a model on a provider without api succeeds (' + JSON.stringify(r.json.error) + ')')
const oddModels = wh.state.section.providers['odd-gw'].models
check(oddModels[0].compat && oddModels[0].compat.futureCompat === 'keep', 'B5: an empty compat draft on a table-less protocol leaves model compat untouched')
check(oddModels[0].name === 'Kept', 'B5: the name edit was still applied')
wh.runDispose()

// B6：保存一个模型不得抹掉其它条目（及自身）的未知/未来字段
const FUT_INITIAL = {
  __modelSuite: cloneJson(PREF),
  providers: {
    'hub-gm': {
      api: 'openai-completions',
      baseURL: 'https://hub.example.com/v1',
      models: [
        { id: 'glm-5.3' },
        { id: 'glm-4.6', futureField: 42, compat: { futureCompat: 'keep' } },
      ],
    },
  },
}
const fh = await makeHarness(FUT_INITIAL)
r = await fh.post('/api/suite/save-model', { provider: 'hub-gm', modelId: 'glm-5.3', editor: { disabled: false, levels: [{ level: 'low', enabled: true, wire: 'low' }], vision: false, contextWindow: 1000, maxTokens: 100 } })
check(r.status === 200, 'B6: saving one model succeeds')
let sibling = fh.state.section.providers['hub-gm'].models.find((m) => m.id === 'glm-4.6')
check(sibling.futureField === 42, 'B6: unknown fields on sibling entries survive a save')
check(sibling.compat && sibling.compat.futureCompat === 'keep', 'B6: unknown compat fields on sibling entries survive a save')
r = await fh.post('/api/suite/save-model', { provider: 'hub-gm', modelId: 'glm-4.6', editor: { disabled: false, levels: [], vision: false, name: 'Edited' } })
check(r.status === 200, 'B6: editing the entry with unknown fields succeeds')
sibling = fh.state.section.providers['hub-gm'].models.find((m) => m.id === 'glm-4.6')
check(sibling.futureField === 42 && sibling.compat && sibling.compat.futureCompat === 'keep', 'B6: the edited entry keeps its own unknown fields')
fh.runDispose()

// M1（三轮）：跨协议 compat 字段——手写在 openai-completions 模型上的 anthropic
// 表字段（supportsTemperature）——不得在一次无关编辑中被抹掉。"已知"必须按
// **当前协议**的 offer 判定，而不是全协议并集（并集会让它被误判为"本次提交已管辖"）。
const CROSS_INITIAL = {
  __modelSuite: cloneJson(PREF),
  providers: {
    'hub-gm': {
      api: 'openai-completions',
      baseURL: 'https://hub.example.com/v1',
      models: [{ id: 'glm-5.3', compat: { supportsTemperature: true, futureCompat: 'keep', supportsStore: true } }],
    },
  },
}
const ch = await makeHarness(CROSS_INITIAL)
r = await ch.post('/api/suite/save-model', { provider: 'hub-gm', modelId: 'glm-5.3', editor: { disabled: false, levels: [], vision: false, name: 'Edited', compat: { supportsStore: false } } })
check(r.status === 200, 'M1: saving with a current-protocol compat payload succeeds (' + JSON.stringify(r.json.error) + ')')
const crossModel = ch.state.section.providers['hub-gm'].models[0]
check(crossModel.name === 'Edited', 'M1: the unrelated edit applied')
check(crossModel.compat.supportsStore === false, 'M1: the submitted current-protocol field is updated')
check(crossModel.compat.supportsTemperature === true, 'M1: a hand-written CROSS-protocol compat field survives the edit (was silently dropped before)')
check(crossModel.compat.futureCompat === 'keep', 'M1: unknown future compat fields still survive (B6 intact)')
ch.runDispose()

r = await h.post('/api/suite/add-models', { provider: 'hub-gm', models: [{ id: 'new-model-x', contextWindow: 1000, name: 'New' }] })
check(r.status === 200 && r.json.addedCount === 1, 'add-models appends: ' + JSON.stringify(r.json).slice(0, 160))
r = await h.post('/api/suite/add-models', { provider: 'hub-gm', models: [{ id: 'new-model-x' }] })
check(r.status === 200 && r.json.skipped === true, 'add-models skips duplicates')
bad = await h.post('/api/suite/add-models', { provider: 'hub-gm', models: [{ id: 'bad id!' }] })
check(bad.status === 400 && /非法字符/.test(bad.json.error), 'B3: add-models rejects an illegal id charset (same whitelist as delete-model)')

bad = await h.post('/api/suite/save-sources', { sources: { litellm: { url: 'http://insecure.example.com/l.json' } } })
check(bad.status === 400, 'save-sources rejects a non-HTTPS url: ' + JSON.stringify(bad.json))
r = await h.post('/api/suite/save-sources', { sources: { litellm: { url: 'https://litellm.example.com/x.json', enabled: false }, openrouter: { enabled: false } } })
check(r.status === 200 && r.json.sources.litellm.url === 'https://litellm.example.com/x.json', 'save-sources persists a valid https url')
check(r.json.warnings.some((w) => /命中率/.test(w)), 'save-sources warns when both secondary sources are off')
check(r.json.sources.modelsDev.enabled === true, 'models.dev stays enabled (minimum viable source)')
bad = await h.post('/api/suite/save-sources', { sources: { bogus: { enabled: true } } })
check(bad.status === 400, 'save-sources rejects an unknown source id')

r = await h.post('/api/suite/save-auto-config', { auto: { enabled: true, persistOnSave: false, fields: { input: false }, includeCatalogRoutes: true } })
check(r.status === 200 && r.json.auto.persistOnSave === false && r.json.auto.fields.input === false, 'save-auto-config persists switches')
check(r.json.auto.fields.contextWindow === true, 'unspecified switches keep their previous value')
check(r.json.warnings.some((w) => /内置目录渠道/.test(w)), 'includeCatalogRoutes raises a warning')
check(h.state.section.__modelSuite.auto.includeCatalogRoutes === true, 'auto config written under __modelSuite')
check(h.state.section.__modelSuite.sources !== undefined, 'save-auto-config does not clobber sources')

/* ═══════════════ 12. test-model 参数校验 / check-update 容错 ═══════════════ */

bad = await h.post('/api/suite/test-model', { provider: 'hub-gm', modelId: 'glm-5.3', effort: 'nonsense' })
check(bad.status === 400 && /思考强度/.test(bad.json.error), 'test-model rejects an unknown effort')
bad = await h.post('/api/suite/test-model', { provider: 'hub-gm', modelId: 'glm-5.3', prompt: 'x'.repeat(9000) })
check(bad.status === 400 && /8000/.test(bad.json.error), 'test-model caps the prompt length (#13 input sanitisation)')
check(h.state.section.__modelSuite.auto.fields.input === false, 'test-model rejects before any write')

// L1（三轮）：testModel 按 pi-ai 的 thinkingFormat wire 表逐格式编码，并如实
// 报告 effortApplied——此前只特判 openrouter/deepseek，其余格式一律发
// reasoning_effort，qwen/zai/together 类端点会因未知字段 400（假故障）。
const chatBodies = []
const chatServer = http.createServer((req, res) => {
  let raw = ''
  req.on('data', (c) => { raw += c })
  req.on('end', () => {
    try { chatBodies.push(JSON.parse(raw)) } catch (_) { chatBodies.push(null) }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
  })
})
await new Promise((resolve) => chatServer.listen(0, '127.0.0.1', resolve))
const CHAT_BASE = 'http://127.0.0.1:' + chatServer.address().port
const THINK_INITIAL = {
  __modelSuite: cloneJson(PREF),
  providers: {
    'think-gw': {
      api: 'openai-completions',
      baseURL: CHAT_BASE,
      models: [
        { id: 'plain-model' },
        { id: 'qwen-model', compat: { thinkingFormat: 'qwen' } },
        { id: 'ct-model', compat: { thinkingFormat: 'chat-template' } },
      ],
    },
  },
}
const tg = await makeHarness(THINK_INITIAL)
chatBodies.length = 0
r = await tg.post('/api/suite/test-model', { provider: 'think-gw', modelId: 'plain-model', effort: 'high' })
check(r.status === 200 && r.json.ok === true, 'L1: a default-format test succeeds end to end (' + JSON.stringify(r.json.error) + ')')
check(chatBodies.length === 1 && chatBodies[0].reasoning_effort === 'high', 'L1: default/openai format sends reasoning_effort')
check(r.json.effortApplied === true, 'L1: default format reports effortApplied=true')
chatBodies.length = 0
r = await tg.post('/api/suite/test-model', { provider: 'think-gw', modelId: 'qwen-model', effort: 'high' })
check(chatBodies.length === 1 && chatBodies[0].enable_thinking === true && chatBodies[0].reasoning_effort === undefined, 'L1: qwen format sends enable_thinking and no stray reasoning_effort (supportsReasoningEffort unset)')
check(r.json.effortApplied === true, 'L1: qwen format reports effortApplied=true')
chatBodies.length = 0
r = await tg.post('/api/suite/test-model', { provider: 'think-gw', modelId: 'ct-model', effort: 'high' })
check(chatBodies.length === 1 && chatBodies[0].reasoning_effort === undefined && chatBodies[0].thinking === undefined && chatBodies[0].reasoning === undefined, 'L1: chat-template injects no half-guessed thinking params')
check(r.json.effortApplied === false, 'L1: chat-template honestly reports effortApplied=false (needs user-configured $var kwargs)')
tg.runDispose()

/* ═══════════════ 13. discover-models / refresh-models 参数校验 ═══════════════ */

bad = await h.post('/api/suite/discover-models', { baseURL: 'https://x.example.com/v1', api: 'anthropic-messages' })
check(bad.status === 400 && /不支持自动获取/.test(bad.json.error), 'discover-models rejects a non-listable protocol')
bad = await h.post('/api/suite/discover-models', { baseURL: 'http://insecure.example.com/v1', api: 'openai-completions' })
check(bad.status === 400, 'discover-models rejects a non-https draft baseURL')
// L2（三轮）：空串 api 视为"未提供"——回落渠道真实协议，而不是拿
// openai-completions 去乱探一个 anthropic-messages 渠道。
{
  const antH = await makeHarness({
    __modelSuite: cloneJson(PREF),
    providers: { 'ant-gw': { api: 'anthropic-messages', baseURL: 'https://ant.example.com/v1', models: [{ id: 'claude-x' }] } },
  })
  bad = await antH.post('/api/suite/discover-models', { provider: 'ant-gw', api: '' })
  check(bad.status === 400 && /anthropic-messages[\s\S]*不支持自动获取/.test(bad.json.error), 'L2: an empty-string api falls back to the provider protocol (got: ' + JSON.stringify(bad.json.error) + ')')
  antH.runDispose()
}
bad = await h.post('/api/suite/refresh-models', { provider: 'ghost' })
check(bad.status === 400 && /渠道不存在/.test(bad.json.error), 'refresh-models unknown provider')

/* ═══════════════ 13b. 获取模型：大小写保留 / models 对象形态 / 自定义请求头透传 ═══════════════ */

// 一个真的会回模型列表的端点（loopback HTTP 被 §13 白名单放行）
const listingHits = { count: 0, headers: null, urls: [] }
const listingServer = http.createServer((req, res) => {
  listingHits.count += 1
  listingHits.headers = req.headers
  listingHits.urls.push(req.url)
  let body = null
  if (req.url === '/v1/models') {
    body = {
      data: [
        { id: 'Llama-3.1-8B', name: 'Llama 3.1 8B' },
        { id: 'glm-5.3', limit: { context: 1048576, output: 384000 } },
      ],
    }
  } else if (req.url === '/obj/v1/models') {
    // 官方 readListing 也认的 { models: { key: {...} } } 形态
    body = { models: { 'vendor/Model-X': { max_input_tokens: 11, top_provider: { max_completion_tokens: 9 } } } }
  }
  if (!body) { res.writeHead(404); res.end('no'); return }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
})
await new Promise((resolve) => listingServer.listen(0, '127.0.0.1', resolve))
const LIST_BASE = 'http://127.0.0.1:' + listingServer.address().port

r = await h.post('/api/suite/discover-models', { baseURL: LIST_BASE + '/v1', api: 'openai-completions', enrich: false })
check(r.status === 200 && r.json.count === 2, 'discover-models reads the data array (' + JSON.stringify(r.json.error || r.json.count) + ')')
check(r.json.models[0].id === 'Llama-3.1-8B', 'discovered model id keeps its original case (gateways can be case-sensitive)')
check(r.json.models[0].name === 'Llama 3.1 8B', 'discovered name kept')
check(r.json.models[1].contextWindow === 1048576 && r.json.models[1].maxTokens === 384000, 'discover-models reads limit.context / limit.output aliases')
check(r.json.models[1].name === undefined, 'name omitted when the endpoint gives none (falls back to the id client-side)')

r = await h.post('/api/suite/discover-models', { baseURL: LIST_BASE + '/obj/v1', api: 'openai-completions', enrich: false })
check(r.status === 200 && r.json.models.length === 1, 'discover-models accepts the { models: {...} } object form')
check(r.json.models[0].id === 'vendor/Model-X', 'object-form key keeps its case')
check(r.json.models[0].maxTokens === 9 && r.json.models[0].contextWindow === 11, 'object-form aliases (top_provider.max_completion_tokens / max_input_tokens)')

// refresh-models 必须带上该渠道已保存的自定义请求头（保留名不得覆盖鉴权）
process.env.SUITE_LOCAL_KEY = 'sk-local-1234567890'
const DISCOVER_INITIAL = {
  __modelSuite: cloneJson(PREF),
  providers: {
    'local-gw': {
      api: 'openai-completions',
      baseURL: LIST_BASE + '/v1',
      apiKeyEnv: 'SUITE_LOCAL_KEY',
      headers: { 'X-Title': 'suite-test', Authorization: 'Bearer hand-written', 'Content-Type': 'text/plain' },
      models: [{ id: 'glm-5.3' }, { id: 'Llama-3.1-8B' }],
    },
  },
}
const dh = await makeHarness(DISCOVER_INITIAL)
r = await dh.post('/api/suite/refresh-models', { provider: 'local-gw', enrich: false })
check(r.status === 200 && r.json.count === 2, 'refresh-models probes the endpoint (' + JSON.stringify(r.json.error || r.json.count) + ')')
check(listingHits.headers['x-title'] === 'suite-test', "the route's custom header is sent when refreshing (got " + JSON.stringify(listingHits.headers['x-title']) + ')')
check(listingHits.headers.authorization === 'Bearer sk-local-1234567890', 'a stored Authorization header never overrides the resolved credential')
check(listingHits.headers['content-type'] !== 'text/plain', 'a stored Content-Type cannot mislabel the probe request')
check(r.json.candidates.find((c) => c.id === 'Llama-3.1-8B').isNew === false, 'case-insensitive dedupe: an existing mixed-case id is recognised as known')
check(r.json.newCount === 0 && r.json.knownCount === 2, 'refresh-models reports 0 new / 2 known')

// B7：discover-models 带 provider 时复用渠道已存的 baseURL / 凭据 / 自定义请求头
r = await dh.post('/api/suite/discover-models', { provider: 'local-gw', api: 'openai-completions', enrich: false })
check(r.status === 200 && r.json.count === 2, 'B7: discover-models with provider reuses the stored baseURL (' + JSON.stringify(r.json.error || r.json.count) + ')')
check(listingHits.headers.authorization === 'Bearer sk-local-1234567890', 'B7: discover-models resolves the stored credential (previously always 401 on protected gateways)')
check(listingHits.headers['x-title'] === 'suite-test', 'B7: discover-models sends the route custom headers')

// 大小写保留：保存 / 定位 / 删除
r = await dh.post('/api/suite/save-model', { provider: 'local-gw', modelId: 'Llama-3.1-8B', editor: { name: 'Renamed', disabled: false, levels: [], vision: false, contextWindow: 1000, maxTokens: 100 } })
check(r.status === 200, 'save-model works on a mixed-case id (' + JSON.stringify(r.json.error) + ')')
check(dh.state.section.providers['local-gw'].models[1].id === 'Llama-3.1-8B', 'the stored id keeps its original case after a save')
check(dh.state.section.providers['local-gw'].models[1].name === 'Renamed', 'the mixed-case model was actually the one edited')
r = await dh.post('/api/suite/delete-model', { provider: 'local-gw', modelId: 'LLAMA-3.1-8B' })
check(r.status === 200 && r.json.remaining === 1, 'delete-model matches a mixed-case id case-insensitively')

// 三态推理档位：未设置就必须保持未设置（不得静默改成"关闭推理"）
const TRI_INITIAL = {
  __modelSuite: cloneJson(PREF),
  providers: {
    'hub-gm': {
      api: 'openai-completions',
      baseURL: 'https://hub.example.com/v1',
      models: [{ id: 'unset-model', name: 'Keep' }, { id: 'off-model', reasoningEfforts: false }],
    },
  },
}
const th = await makeHarness(TRI_INITIAL)
r = await th.post('/api/suite/save-model', { provider: 'hub-gm', modelId: 'unset-model', editor: { name: 'Kept', disabled: false, levels: [], vision: false, contextWindow: 0, maxTokens: 0 } })
check(r.status === 200, 'save-model with no level enabled succeeds (' + JSON.stringify(r.json.error) + ')')
const triUnset = th.state.section.providers['hub-gm'].models[0]
check(triUnset.name === 'Kept', 'the name edit was applied')
check(!Object.prototype.hasOwnProperty.call(triUnset, 'reasoningEfforts'), 'a model whose reasoningEfforts was UNSET stays unset (no silent "reasoning off")')
r = await th.post('/api/suite/save-model', { provider: 'hub-gm', modelId: 'off-model', editor: { disabled: true, levels: [], vision: false } })
check(r.status === 200 && th.state.section.providers['hub-gm'].models[1].reasoningEfforts === false, 'an explicitly disabled model stays disabled')
r = await th.post('/api/suite/save-model', { provider: 'hub-gm', modelId: 'off-model', editor: { disabled: false, levels: [{ level: 'low', enabled: true, wire: 'low' }, { level: 'high', enabled: true, wire: 'high' }], vision: false } })
check(r.status === 200 && JSON.stringify(th.state.section.providers['hub-gm'].models[1].reasoningEfforts) === '{"low":"low","high":"high"}', 'levels rebuild the effort map')
// 目录补出来的 off 档（off: null = 支持关闭、关闭时不发参数）必须能原样写回
r = await th.post('/api/suite/save-model', { provider: 'hub-gm', modelId: 'off-model', editor: { disabled: false, levels: [{ level: 'off', enabled: true, wire: '', wireNull: true }, { level: 'low', enabled: true, wire: 'low' }], vision: false } })
check(r.status === 200 && JSON.stringify(th.state.section.providers['hub-gm'].models[1].reasoningEfforts) === '{"off":null,"low":"low"}', 'the off level round-trips as off:null (' + JSON.stringify(th.state.section.providers['hub-gm'].models[1].reasoningEfforts) + ')')
r = await th.post('/api/suite/save-model', { provider: 'hub-gm', modelId: 'off-model', editor: { disabled: false, levels: [{ level: 'off', enabled: true, wire: '', wireNull: true }], vision: false } })
check(r.status === 400, 'only-off levels are rejected (schema requires a non-off level)')
th.runDispose()

// retryPolicy：手写的 retryableCodes / backoff 必须活过一次 UI 保存
const RETRY_INITIAL = {
  __modelSuite: cloneJson(PREF),
  providers: {
    'hub-gm': {
      api: 'openai-completions',
      baseURL: 'https://hub.example.com/v1',
      retryPolicy: { mode: 'normal', maxRetries: 3, retryableCodes: ['429', '503'], backoff: { initialDelayMs: 250 } },
      models: [{ id: 'glm-5.3' }],
    },
  },
}
const rh = await makeHarness(RETRY_INITIAL)
r = await rh.post('/api/suite/save-provider-advanced', { provider: 'hub-gm', retryPolicy: { mode: 'normal', maxRetries: 7 } })
check(r.status === 200, 'save-provider-advanced retryPolicy (' + JSON.stringify(r.json.error) + ')')
const rpSaved = rh.state.section.providers['hub-gm'].retryPolicy
check(rpSaved.maxRetries === 7, 'the new maxRetries was written')
check(JSON.stringify(rpSaved.retryableCodes) === '["429","503"]', 'hand-written retryableCodes survive a UI save')
check(rpSaved.backoff && rpSaved.backoff.initialDelayMs === 250, 'hand-written backoff survives a UI save')
check((r.json.warnings || []).some((w) => /retryableCodes/.test(w)), 'the preservation is reported as a warning')
r = await rh.post('/api/suite/save-provider-advanced', { provider: 'hub-gm', retryPolicy: null })
check(r.status === 200 && rh.state.section.providers['hub-gm'].retryPolicy === undefined, 'retryPolicy null still clears the whole key')
rh.runDispose()

/* ═══════════════ 14. dispose：干净还原（R7） ═══════════════ */

check(Object.prototype.hasOwnProperty.call(h.llm, 'discoverModels') === true, 'before dispose: discoverModels is an own property (patched)')
check(Object.prototype.hasOwnProperty.call(h.llm, 'resolveModelInfo') === true, 'before dispose: resolveModelInfo is an own property (patched)')
check(Object.prototype.hasOwnProperty.call(h.settings, 'mutate') === true, 'before dispose: settings.mutate is patched')
h.runDispose()
check(Object.prototype.hasOwnProperty.call(h.llm, 'discoverModels') === false, 'R7: dispose DELETES the patch slot (no forwarding shell) when the method came from the prototype')
check(Object.prototype.hasOwnProperty.call(h.llm, 'resolveModelInfo') === false, 'R7: resolveModelInfo restored by delete')
check(typeof h.llm.discoverModels === 'function', 'prototype method usable again after dispose')
check(h.routes.length === 0, 'all 14 routes disposed')
const afterDispose = await h.llm.discoverModels('llm-pi-ai', { provider: 'hub-gm' })
check(afterDispose.find((m) => m.id === 'glm-5.3').contextWindow === undefined, 'after dispose the original behaviour is back (#13)')

// own-property variant: the original value must be restored, not a bound shell
const ownLlm = new FakeLlm()
const ownDiscover = ownLlm.discoverModels
const ownResolve = ownLlm.resolveModelInfo
const ownHarness = await makeHarness(INITIAL, { llm: ownLlm })
check(Object.prototype.hasOwnProperty.call(ownLlm, 'discoverModels') === true, 'own-property variant patched')
check(ownLlm.discoverModels !== ownDiscover, 'own-property variant actually replaced')
ownHarness.runDispose()
check(ownLlm.discoverModels === ownDiscover, 'own-property variant restores the ORIGINAL function value (not a bound shell)')
check(ownLlm.resolveModelInfo === ownResolve, 'own-property variant restores resolveModelInfo')

/* ═══════════════ 15. 迁移 ═══════════════ */

const legacy = await makeHarness({
  __modelPlus: { modelsDevUrl: 'https://legacy.example.com/api.json' },
  providers: { 'hub-gm': { api: 'openai-completions', baseURL: 'https://hub.example.com/v1', models: [] } },
})
const legacyBoot = await legacy.get('/api/suite/bootstrap')
await new Promise((resolve) => setTimeout(resolve, 30))
check(legacyBoot.status === 200, 'legacy bootstrap returned 200 (status=' + legacyBoot.status + ' body=' + JSON.stringify(legacyBoot.json).slice(0, 200) + ')')
check(legacyBoot.json.migratedFromModelPlus === true, 'bootstrap reports the migration to the UI')
check(legacy.state.section.__modelSuite !== undefined, 'legacy __modelPlus prefs migrated to __modelSuite (section=' + JSON.stringify(legacy.state.section).slice(0, 200) + ' logs=' + JSON.stringify(legacy.logs) + ')')
check(legacy.state.section.__modelSuite.migratedFromModelPlus === true, 'migration marker set')
check(legacy.state.section.__modelPlus !== undefined, 'legacy pref key is NOT deleted')
legacy.runDispose()

/* ═══════════════ 16. 协议维度的 compat 白名单（anthropic / responses） ═══════════════ */

const ANTHROPIC_INITIAL = {
  __modelSuite: cloneJson(PREF),
  providers: {
    'claude-gw': {
      api: 'anthropic-messages',
      baseURL: 'https://claude-gw.example.com',
      models: [{ id: 'claude-sonnet-4' }],
    },
    'resp-gw': {
      api: 'openai-responses',
      baseURL: 'https://resp-gw.example.com/v1',
      models: [{ id: 'gpt-5' }],
    },
  },
}
const proto = await makeHarness(ANTHROPIC_INITIAL)
r = await proto.get('/api/suite/bootstrap')
check(r.json.compatFields['anthropic-messages'].length === 7, 'bootstrap advertises 7 anthropic compat fields')
check(r.json.compatFields['anthropic-messages'].some((f) => f.field === 'supportsTemperature'), 'anthropic table includes supportsTemperature')
check(!r.json.compatFields['anthropic-messages'].some((f) => f.field === 'supportsStore'), 'anthropic table excludes openai-only supportsStore')
check(!r.json.compatFields['openai-completions'].some((f) => f.field === 'openRouterRouting'), 'withhold fields are never advertised')

r = await proto.post('/api/suite/save-model', {
  provider: 'claude-gw', modelId: 'claude-sonnet-4',
  editor: { disabled: true, levels: [], vision: false, compat: { supportsTemperature: false, allowEmptySignature: true } },
})
check(r.status === 200 && r.json.model.compatCount === 2, 'anthropic model-level compat accepted for offered fields')
bad = await proto.post('/api/suite/save-model', {
  provider: 'claude-gw', modelId: 'claude-sonnet-4',
  editor: { disabled: true, levels: [], vision: false, compat: { supportsStore: true } },
})
check(bad.status === 400 && /supportsStore/.test(bad.json.error) && /anthropic-messages/.test(bad.json.error), 'anthropic model rejects an openai-completions field: ' + JSON.stringify(bad.json))
r = await proto.post('/api/suite/save-provider-advanced', { provider: 'claude-gw', compat: { supportsCacheControlOnTools: true } })
check(r.status === 200, 'anthropic route-level compat accepted')
bad = await proto.post('/api/suite/save-provider-advanced', { provider: 'claude-gw', compat: { supportsDeveloperRole: false } })
check(bad.status === 400, 'anthropic route-level compat rejects the developer-role switch (not offered by anthropic-messages)')
r = await proto.post('/api/suite/save-provider-advanced', { provider: 'resp-gw', compat: { supportsDeveloperRole: false, supportsMaxOutputTokens: true } })
check(r.status === 200, 'openai-responses route-level compat accepted')
bad = await proto.post('/api/suite/save-provider-advanced', { provider: 'resp-gw', compat: { thinkingFormat: 'deepseek' } })
check(bad.status === 400, 'openai-responses rejects a completions-only field')
check(proto.resolved().providers['claude-gw'].compat.supportsCacheControlOnTools === true, 'the real schema accepts the anthropic route compat')
proto.runDispose()

// 用户层缺失（配置全部来自组合基座）时，replace 回退通道**不得**把平台默认值物化进配置
// （fail.update = 2：链路二的"失败用原始入参重试一次"会先吃掉一次）
const baseLayer = await makeHarness(INITIAL, { hideUser: true, fail: { update: 2 } })
r = await baseLayer.post('/api/suite/save-model', { provider: 'hub-gm', modelId: 'glm-5.3', editor: { disabled: true, levels: [], vision: false, contextWindow: 0, maxTokens: 0 } })
check(r.status === 200 && r.json.via === 'replace', 'with no user layer the update channel fails over to replace (via=' + r.json.via + ', writes=' + JSON.stringify(baseLayer.state.writes.map((w) => w.mode)) + ')')
const baseWritten = baseLayer.state.section
check(baseWritten.providers['hub-gm'].models.length === 4, 'the replace payload still carries the edited model table')
check(baseWritten.providers['hub-gm'].defaultContextWindow === undefined, 'replace must NOT materialize defaultContextWindow into the user layer')
check(baseWritten.providers['hub-gm'].defaultMaxTokens === undefined, 'replace must NOT materialize defaultMaxTokens')
check(baseWritten.providers['hub-gm'].defaultInput === undefined, 'replace must NOT materialize defaultInput')
check(baseWritten.providers['hub-gm'].compat === undefined, 'replace must NOT materialize the resolved compat object')
check(baseWritten.providers.deepseek === undefined, 'replace writes only the touched provider, not the whole resolved tree')
baseLayer.runDispose()

/* ═══════════════ 17. 降级环境（服务缺失 / 对象不可写） ═══════════════ */

// 没有 llm 服务：插件仍须加载并注册全部路由，只是链路一/三不生效
const noLlm = await makeHarness(INITIAL, { llm: null })
check(noLlm.routes.length === 14, 'without ctx.llm the plugin still registers all 14 routes')
check(noLlm.logs.some((l) => /链路一未启用/.test(l)), 'missing discoverModels is logged, not thrown')
check(noLlm.logs.some((l) => /链路三未启用/.test(l)), 'missing resolveModelInfo is logged, not thrown')
r = await noLlm.post('/api/suite/save-model', {
  provider: 'hub-gm', modelId: 'glm-5.3',
  editor: { disabled: false, levels: [{ level: 'low', enabled: true, wire: 'low' }], vision: false, contextWindow: 500, maxTokens: 100 },
})
check(r.status === 200, 'without llm the write endpoints still work')
const noLlmModel = noLlm.state.section.providers['hub-gm'].models.find((m) => m.id === 'glm-5.3')
check(noLlmModel.contextWindow === 500 && noLlmModel.maxTokens === 100, 'link 2 preserves the values just written (only-fill)')
check(noLlmModel.reasoningEfforts && noLlmModel.reasoningEfforts.low === 'low', 'the editor-authored reasoningEfforts survived')
check(JSON.stringify(noLlmModel.input) === '["text","image"]', 'link 2 still enriches the missing vision field without llm')
noLlm.runDispose()

// llm 方法存在但对象被冻结 → 降级为警告，插件不崩
class FrozenLlm { constructor() { this.calls = 0 } async discoverModels() { this.calls += 1; return [] } async resolveModelInfo(p, m) { return { provider: p, id: m, name: m } } }
const frozenLlm = new FrozenLlm()
Object.freeze(frozenLlm)
let freezeThrew = null
let frozen = null
try { frozen = await makeHarness(INITIAL, { llm: frozenLlm }) } catch (e) { freezeThrew = e.message }
check(freezeThrew === null, 'a frozen llm service must not make apply() throw (got: ' + freezeThrew + ')')
check(frozen && frozen.routes.length === 14, 'routes still registered with a frozen llm service')
check(frozen.logs.some((l) => /不可写/.test(l)), 'a frozen service produces a downgrade log')
check(Object.isFrozen(frozenLlm) && frozenLlm.calls === 0, 'the frozen service was left untouched')
frozen.runDispose()

/* ─────────── 收尾 ─────────── */

catalogServer.close()
listingServer.close()
chatServer.close()
console.log('[integration] OK — ' + checks + ' checks passed')
