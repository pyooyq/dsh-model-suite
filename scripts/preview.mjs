/**
 * dsh-model-suite 静态预览生成器（开发工具，不参与 verify）。
 *
 * 运行：`node scripts/preview.mjs [输出路径]`
 *
 * 复用 ui-smoke 的极小 React 运行时，把设置页在六个状态下真实挂载渲染
 * （五个 Tab 展开态 + 英文渠道设置），再把虚拟树序列化成 HTML，连同从
 * lib/client.js 提取的插件 CSS 一起写进一个可离线打开的预览文件。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outPath = process.argv[2] || join(root, '..', 'dsh-model-suite-preview.html')

/* ─────────── 极小 React 替身（与 ui-smoke 同款） ─────────── */

function makeReactRuntime() {
  let hooks = []
  let cursor = 0
  let dirty = false
  const cleanups = []

  const React = {
    Fragment: Symbol('Fragment'),
    createElement(type, props) {
      const children = []
      for (let i = 2; i < arguments.length; i++) children.push(arguments[i])
      return { type, props: props || {}, children }
    },
    useState(initial) {
      const i = cursor++
      if (!(i in hooks)) hooks[i] = typeof initial === 'function' ? initial() : initial
      const set = (next) => {
        const value = typeof next === 'function' ? next(hooks[i]) : next
        if (value === hooks[i]) return
        hooks[i] = value
        dirty = true
      }
      return [hooks[i], set]
    },
    useRef(initial) {
      const i = cursor++
      if (!(i in hooks)) hooks[i] = { current: initial }
      return hooks[i]
    },
    useMemo(fn) { cursor++; return fn() },
    useCallback(fn) { cursor++; return fn },
    useEffect(fn, deps) {
      const i = cursor++
      const prev = hooks[i]
      const changed = !prev || !deps || deps.some((d, k) => d !== prev.deps[k])
      if (!changed) return
      hooks[i] = { deps: deps || null, cleanup: null }
      cleanups.push(() => {
        const out = fn()
        hooks[i].cleanup = typeof out === 'function' ? out : null
      })
    },
    createContext() { return { Provider: 'Provider', Consumer: 'Consumer' } },
  }

  function resolve(node) {
    if (Array.isArray(node)) return node.map(resolve)
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function') {
      const children = node.children.length <= 1 ? node.children[0] : node.children
      return resolve(node.type(Object.assign({}, node.props, { children: children })))
    }
    return { type: node.type, props: node.props, children: (node.children || []).map(resolve) }
  }

  const state = { tree: null }

  async function renderPass(render) {
    for (let round = 0; round < 50; round++) {
      dirty = false
      cursor = 0
      state.tree = resolve(render())
      const pending = cleanups.splice(0, cleanups.length)
      if (!pending.length && !dirty) break
      for (const fn of pending) fn()
      await new Promise((resolve) => setTimeout(resolve, 0))
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (!dirty) break
    }
    return state.tree
  }

  async function mount(render) {
    await renderPass(render)
    return { get tree() { return state.tree }, flush: () => renderPass(render) }
  }

  return { React, mount }
}

function walk(node, visit) {
  if (node === null || node === undefined || node === false || node === true) return
  if (Array.isArray(node)) { for (const child of node) walk(child, visit); return }
  if (typeof node !== 'object') { visit(node); return }
  visit(node)
  for (const child of node.children || []) walk(child, visit)
}

function textOf(node) {
  let out = ''
  walk(node, (n) => { if (typeof n === 'string') out += n })
  return out
}

function findAll(node, predicate) {
  const hits = []
  walk(node, (n) => { if (predicate(n)) hits.push(n) })
  return hits
}

/* ─────────── 假 window / fetch（fixture 与 ui-smoke 同源，加了 compat 值便于展示分组） ─────────── */

const store = new Map()
let registered = null
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  },
  __ModuleLoader__: { load: (entry) => { registered = entry } },
  addEventListener: () => {},
  removeEventListener: () => {},
  confirm: () => true,
  location: { origin: 'http://127.0.0.1:3080', href: 'http://127.0.0.1:3080/settings', pathname: '/settings' },
}

const COMPAT_FIELDS_OC = [
  { field: 'supportsStore', type: 'boolean', label: '允许 store', description: '端点是否接受 store 参数（OpenAI 的响应持久化开关）' },
  { field: 'supportsDeveloperRole', type: 'boolean', label: '允许 developer 角色', description: '端点是否接受 developer 角色的系统提示（仅推理模型发送）；false 退回 system' },
  { field: 'supportsReasoningEffort', type: 'boolean', label: '允许 reasoning_effort', description: '端点是否接受 reasoning_effort 请求字段' },
  { field: 'maxTokensField', type: 'enum', label: '输出上限字段', description: '输出上限使用的字段拼写', values: ['max_completion_tokens', 'max_tokens'] },
  { field: 'thinkingFormat', type: 'enum', label: '思考参数格式', description: '推理参数的 wire 格式', values: ['openai', 'deepseek', 'openrouter', 'together'] },
  { field: 'requiresToolResultName', type: 'boolean', label: '工具结果需带 name', description: '工具结果消息是否必须带 name' },
  { field: 'supportsUsageInStreaming', type: 'boolean', label: '流式返回 usage', description: '是否接受 stream_options: { include_usage: true }' },
  { field: 'cacheControlFormat', type: 'enum', label: '提示缓存格式', description: '提示缓存标记约定', values: ['anthropic'] },
  { field: 'vllmPriority', type: 'number', label: 'vLLM 优先级', description: 'vLLM 调度 priority（越小越早；服务端需开启优先级调度）' },
]

const BOOTSTRAP = {
  ok: true, writable: true, version: '0.1.1',
  levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  presets: [{ id: 'basic', label: '通用三档' }, { id: 'all', label: '全开' }, { id: 'none', label: '关闭推理' }],
  protocols: ['openai-completions', 'openai-responses', 'anthropic-messages'],
  listableProtocols: ['openai-completions', 'openai-responses'],
  compatFields: { 'openai-completions': COMPAT_FIELDS_OC },
  compatFieldCounts: { 'openai-completions': 19 },
  auto: { enabled: true, persistOnSave: true, fields: { contextWindow: true, maxTokens: true, input: true, reasoningEfforts: true }, includeCatalogRoutes: false },
  sources: { modelsDev: { url: 'https://models.dev/api.json', enabled: true }, litellm: { url: 'https://x/litellm.json', enabled: true }, openrouter: { url: 'https://x/or.json', enabled: true } },
  catalogSources: [
    { id: 'official', label: '官方 models.dev', url: 'https://models.dev/api.json' },
    { id: 'china', label: '国内 GitHub 加速', url: 'https://gh-proxy.org/x/api.json' },
    { id: 'custom', label: '自定义', url: '' },
  ],
  defaults: { contextWindow: 262144, maxTokens: 32768, input: ['text'], providerMaxRetries: 5 },
  canStoreApiKey: false, migratedFromModelPlus: false,
  defaultTestPrompt: '我要去洗车，洗车店离家63米我是开车去还是走路去。', defaultTestMaxTokens: 16384, note: '',
  repo: 'https://github.com/kingsunb/dsh-model-suite',
  homepage: 'https://github.com/kingsunb/dsh-model-suite#readme',
  issues: 'https://github.com/kingsunb/dsh-model-suite/issues',
  providers: [
    {
      provider: 'hub-gm', api: 'openai-completions', baseURL: 'https://hub.example.com/v1',
      displayName: '示例网关 hub-gm',
      modelCount: 2, visionCount: 1, withEffort: 1, retryLabel: '默认 5 次', retryPolicy: null,
      retryMode: 'normal', retryMaxRetries: null, headersCount: 2,
      defaults: {}, defaultsConfigured: {},
      compat: { supportsDeveloperRole: false, thinkingFormat: 'deepseek' }, compatCount: 2,
      apiKeyEnv: '', isCatalogRoute: false,
      headers: { 'X-Title': 'model-suite-preview', 'X-Api-Base': 'https://hub.example.com' },
    },
  ],
}

const LIST_MODELS = {
  ok: true, provider: 'hub-gm', baseURL: 'https://hub.example.com/v1', api: 'openai-completions', writable: true,
  models: [
    {
      id: 'glm-5.3', name: 'GLM 5.3', disabled: false, vision: true, summary: 'high', hasEffort: true,
      levels: [
        { level: 'off', enabled: false, wire: '', wireNull: true },
        { level: 'medium', enabled: true, wire: 'medium', wireNull: false },
        { level: 'high', enabled: true, wire: 'high', wireNull: false },
      ],
      input: ['text', 'image'], contextWindow: 1048576, maxTokens: 384000, compatCount: 1, source: 'auto',
      compat: { supportsStore: true },
    },
    {
      id: 'unset-model', name: '', disabled: false, vision: false, summary: '未设置', hasEffort: false,
      levels: [{ level: 'off', enabled: false, wire: '', wireNull: true }, { level: 'high', enabled: false, wire: 'high', wireNull: false }],
      input: [], contextWindow: 0, maxTokens: 0, compatCount: 0, source: 'unknown', compat: undefined,
    },
  ],
}

const jsonResponse = (data, status) => ({
  ok: (status || 200) < 400, status: status || 200,
  json: async () => data, text: async () => JSON.stringify(data),
})
globalThis.fetch = async (path, init) => {
  const url = String(path)
  if (url.indexOf('/bootstrap') >= 0) return jsonResponse(BOOTSTRAP)
  if (url.indexOf('/list-models') >= 0) return jsonResponse(LIST_MODELS)
  return jsonResponse({ ok: true, message: 'stub', providers: BOOTSTRAP.providers })
}

/* ─────────── 挂载并收集六个快照 ─────────── */

await import(pathToFileURL(join(root, 'lib/client.js')).href + '?preview=' + Date.now())
if (!registered || registered.id !== 'dsh-model-suite') throw new Error('client bundle did not register')

const { React, mount } = makeReactRuntime()
const exportsObj = registered.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
let section = null
exportsObj.apply({ get: () => ({
  inject: (name, fn) => fn(),
  register: (meta, render) => { section = { meta, render } },
}) })

const view = await mount(() => section.render())

const clickButton = async (predicate, label) => {
  const btn = findAll(view.tree, predicate)[0]
  if (!btn) throw new Error('preview: button not found: ' + label)
  btn.props.onClick()
  await view.flush()
}
const navTo = async (label) => clickButton(
  (n) => n.props && n.props.className === 'mp-tab' && textOf(n) === label, 'tab ' + label)

// ① 模型 tab：展开编辑器 + wire 高级编辑 + 模型级 compat
await clickButton((n) => n.props && n.props.className === 'mp-btn small' && textOf(n) === '编辑', '编辑')
await clickButton((n) => n.props && n.props.className === 'mp-linkbtn' && textOf(n).indexOf('wire 高级编辑（网关映射）') >= 0, 'wire 高级编辑')
await clickButton((n) => n.props && n.props.className === 'mp-linkbtn' && textOf(n).indexOf('模型级兼容开关') >= 0, '模型级兼容开关')
const modelsSnap = view.tree

// ②③④⑤ 其它 tab
await navTo('渠道设置'); const advancedSnap = view.tree
await navTo('模型测试'); const testSnap = view.tree
await navTo('目录与自动化'); const syncSnap = view.tree
await navTo('关于'); const aboutSnap = view.tree

// ⑥ 英文 · 渠道设置
const langBar = findAll(view.tree, (n) => n.props && n.props.className === 'mp-lang')[0]
const enBtn = (langBar.children || []).find((c) => c && typeof c === 'object' && textOf(c) === 'EN')
enBtn.props.onClick()
await view.flush()
await navTo('Channel settings'); const advancedEnSnap = view.tree

/* ─────────── 虚拟树 → HTML 序列化 ─────────── */

const VOID_TAGS = new Set(['input', 'br', 'hr', 'img'])
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const kebab = (k) => k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())

const ATTR_MAP = { className: 'class', htmlFor: 'for', colSpan: 'colspan', srcDoc: 'srcdoc' }
const DATA_ATTRS = new Set(['dataOn', 'dataSrc', 'dataKind', 'dataB', 'dataLocked', 'dataDirty'])

function styleToCss(style) {
  if (!style || typeof style !== 'object') return ''
  return Object.keys(style).map((k) => kebab(k) + ':' + String(style[k])).join(';')
}

function serialize(node, selectValue) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (Array.isArray(node)) return node.map((child) => serialize(child, selectValue)).join('')
  if (typeof node !== 'object') return esc(node)
  const { type, props } = node
  if (typeof type === 'symbol') return (node.children || []).map((child) => serialize(child, selectValue)).join('')
  const tag = String(type)
  const attrs = []
  let childSelectValue = null
  for (const key of Object.keys(props || {})) {
    if (key === 'key' || /^on[A-Z]/.test(key)) continue
    const v = props[key]
    if (v === undefined || v === null || v === false) continue
    const attrName = ATTR_MAP[key] || (DATA_ATTRS.has(key) ? kebab(key) : key.toLowerCase())
    if (key === 'value' && (tag === 'select')) { childSelectValue = String(v); continue }
    if (key === 'value' && tag === 'textarea') continue
    if (v === true) { attrs.push(attrName); continue }
    if (key === 'style') { attrs.push('style="' + esc(styleToCss(v)) + '"'); continue }
    attrs.push(attrName + '="' + esc(v) + '"')
  }
  if (tag === 'details') attrs.push('open')
  if (tag === 'select') {
    // 给匹配 value 的 option 打 selected
    const inner = (node.children || []).map((child) => serialize(child, childSelectValue)).join('')
    return '<select' + (attrs.length ? ' ' + attrs.join(' ') : '') + '>' + inner + '</select>'
  }
  if (tag === 'option' && selectValue != null && String(props.value) === selectValue) {
    attrs.push('selected')
  }
  if (VOID_TAGS.has(tag)) return '<' + tag + (attrs.length ? ' ' + attrs.join(' ') : '') + '>'
  let inner = (node.children || []).map((child) => serialize(child, selectValue)).join('')
  if (tag === 'textarea') inner = esc(props.value || '')
  return '<' + tag + (attrs.length ? ' ' + attrs.join(' ') : '') + '>' + inner + '</' + tag + '>'
}

/* ─────────── 提取插件 CSS 并拼装预览页 ─────────── */

const source = readFileSync(join(root, 'lib/client.js'), 'utf8')
const cssStart = source.indexOf('insertStyles(`')
const cssEnd = source.indexOf('`);', cssStart)
if (cssStart < 0 || cssEnd < 0) throw new Error('preview: insertStyles block not found')
const pluginCss = source.slice(cssStart + 'insertStyles(`'.length, cssEnd)

const sections = [
  ['① 模型（展开编辑器 + 模型级兼容开关）', modelsSnap],
  ['② 渠道设置（四张卡片 · 兼容开关分组）', advancedSnap],
  ['③ 模型测试', testSnap],
  ['④ 目录与自动化', syncSnap],
  ['⑤ 关于', aboutSnap],
  ['⑥ English · Channel settings', advancedEnSnap],
]

const html = `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>dsh-model-suite · UI 预览</title>
<style>
  body{margin:0;padding:32px 24px 64px;background:#eef0f4;font-family:system-ui,-apple-system,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;color:#1f2328;display:flex;flex-direction:column;align-items:center;gap:28px}
  h1{margin:0;font-size:20px}
  .pv-note{margin:0;font-size:12px;color:#6a737d;max-width:960px;text-align:center;line-height:1.6}
  .pv-sec{display:flex;flex-direction:column;gap:10px;width:100%;align-items:center}
  .pv-sec h2{margin:0;font-size:14px;color:#424a53}
  .pv-wrap{width:100%;max-width:1000px;background:#fff;border-radius:14px;box-shadow:0 8px 28px rgba(31,35,40,.10);padding:20px;box-sizing:border-box}
  /* 插件运行时注入的样式（与线上完全一致） */
${pluginCss}
  /* 预览容器内的 token 兜底（线上由宿主提供） */
  .pv-wrap{--dsw-alias-label-primary:#1f2328;--dsw-alias-label-secondary:#57606a;--dsw-alias-label-tertiary:#8b949e;--dsw-alias-border-l2:#d0d7de;--dsw-alias-bg-layer-1:#ffffff;--dsw-alias-bg-layer-2:rgba(125,139,149,.14);--dsw-alias-bg-base:#f6f8fa;--dsw-alias-state-business-primary:#2563eb;--dsw-alias-label-on-primary:#ffffff;--dsw-alias-state-danger:#e5534b;--dsw-alias-state-success:#2da44e;--dsw-alias-state-warning:#bf8700;--dsw-alias-interactive-bg-secondary:#f6f8fa;--dsw-font-sm-14:14px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;--dsw-font-md-16:16px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif}
</style>
</head>
<body>
<h1>dsh-model-suite · 新版 UI 预览</h1>
<p class="pv-note">由 <code>scripts/preview.mjs</code> 用与 ui-smoke 相同的无头 React 运行时真实渲染并序列化；样式逐字节取自 <code>lib/client.js</code> 的注入 CSS。交互（按钮/输入）在此静态文件中不可用。</p>
${sections.map(([title, tree]) => `  <section class="pv-sec"><h2>${title}</h2><div class="pv-wrap">${serialize(tree)}</div></section>`).join('\n')}
</body>
</html>
`

writeFileSync(outPath, html, 'utf8')
console.log('[preview] OK — ' + outPath + ' (' + (html.length / 1024).toFixed(1) + ' KB)')
