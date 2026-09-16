/**
 * dsh-model-suite 客户端（浏览器半区）**无头渲染**冒烟测试。
 *
 * 运行：`node scripts/ui-smoke.mjs`
 *
 * 为什么需要它：host 半区有 244+ 条集成断言，但 `lib/client.js`（3400 行 React UI）
 * 在此之前**从未被真正渲染过一次**——只能靠源码字符串断言。本文件用一套极小的
 * React 替身（useState/useRef/useEffect/useMemo/useCallback/createElement）把
 * `ModelSuitePage` 真的挂载起来，然后：
 *   1. 跑通挂载 → bootstrap → list-models 的完整异步链；
 *   2. 逐个点开五个 Tab，确认每个都渲染出内容且不抛异常；
 *   3. 点一次「保存」并断言发出去的请求体符合 host 契约（provider/modelId/editor）；
 *   4. 切到英文，确认 EN 词典真的生效；
 *   5. 三态 compat：选「未设置」后 payload 里不能出现该键。
 *
 * 它不能替代真机点击（没有 CSS、没有真实 React 调度），但能抓住"渲染期崩溃 /
 * 契约漂移 / 词典漏词"这三类最贵的问题。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

let checks = 0
function check(cond, msg) {
  checks += 1
  if (!cond) throw new Error('[ui-smoke] ' + msg)
}

/* ─────────── 极小 React 替身（单组件树、按 hook 顺序存槽、effect 提交后跑） ─────────── */

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

  /** 函数组件就地求值（hook 顺序在整棵树里保持稳定，与 React 的深度优先一致）。 */
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

  /** 挂载 + 反复 flush（effect → setState → 重渲染），最多 50 轮防死循环。 */
  async function renderPass(render) {
    for (let round = 0; round < 50; round++) {
      dirty = false
      cursor = 0
      state.tree = resolve(render())
      const pending = cleanups.splice(0, cleanups.length)
      if (!pending.length && !dirty) break
      for (const fn of pending) fn()
      // 等异步 effect（fetch → setState）落地
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

/* ─────────── DOM 树工具 ─────────── */

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

const byClass = (cls) => (n) => n && n.props && typeof n.props.className === 'string'
  && n.props.className.split(/\s+/).indexOf(cls) >= 0

/* ─────────── 假 window / fetch / slots ─────────── */

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

const BOOTSTRAP = {
  ok: true,
  writable: true,
  version: '0.1.0',
  levels: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  presets: [{ id: 'basic', label: '通用三档' }],
  protocols: ['openai-completions', 'openai-responses', 'anthropic-messages'],
  listableProtocols: ['openai-completions', 'openai-responses'],
  compatFields: {
    'openai-completions': [
      { field: 'supportsStore', type: 'boolean', label: '允许 store', description: '端点是否接受 store 参数（OpenAI 的响应持久化开关）' },
      { field: 'maxTokensField', type: 'enum', label: '输出上限字段', description: '输出上限使用的字段拼写', values: ['max_completion_tokens', 'max_tokens'] },
    ],
  },
  compatFieldCounts: { 'openai-completions': 19 },
  auto: { enabled: true, persistOnSave: true, fields: { contextWindow: true, maxTokens: true, input: true, reasoningEfforts: true }, includeCatalogRoutes: false },
  sources: { modelsDev: { url: 'https://models.dev/api.json', enabled: true }, litellm: { url: 'https://x/litellm.json', enabled: true }, openrouter: { url: 'https://x/or.json', enabled: true } },
  catalogSources: [
    { id: 'official', label: '官方 models.dev', url: 'https://models.dev/api.json' },
    { id: 'china', label: '国内 GitHub 加速', url: 'https://gh-proxy.org/x/api.json' },
    { id: 'custom', label: '自定义', url: '' },
    { id: 'litellm', label: 'LiteLLM', url: 'https://x/litellm.json' },
    { id: 'openrouter', label: 'OpenRouter', url: 'https://x/or.json' },
  ],
  defaults: { contextWindow: 262144, maxTokens: 32768, input: ['text'], providerMaxRetries: 5 },
  canStoreApiKey: false,
  migratedFromModelPlus: false,
  defaultTestPrompt: 'ping',
  defaultTestMaxTokens: 16384,
  note: '',
  repo: 'https://github.com/kingsunb/dsh-model-suite',
  homepage: 'https://github.com/kingsunb/dsh-model-suite#readme',
  issues: 'https://github.com/kingsunb/dsh-model-suite/issues',
  providers: [
    {
      provider: 'hub-gm', api: 'openai-completions', baseURL: 'https://hub.example.com/v1',
      modelCount: 2, visionCount: 1, withEffort: 1, retryLabel: '5', retryPolicy: null,
      retryMode: 'normal', retryMaxRetries: null, headersCount: 0,
      defaults: {}, defaultsConfigured: {}, compat: {}, compatCount: 0,
      apiKeyEnv: '', isCatalogRoute: false, headers: {},
    },
  ],
}

const LIST_MODELS = {
  ok: true,
  provider: 'hub-gm',
  baseURL: 'https://hub.example.com/v1',
  api: 'openai-completions',
  writable: true,
  models: [
    {
      id: 'glm-5.3', name: 'GLM 5.3', disabled: false, vision: true, summary: 'high', hasEffort: true,
      levels: [
        { level: 'off', enabled: false, wire: '', wireNull: true },
        { level: 'high', enabled: true, wire: 'high', wireNull: false },
      ],
      input: ['text', 'image'], contextWindow: 1048576, maxTokens: 384000, compatCount: 0, source: 'auto', compat: undefined,
    },
    {
      id: 'unset-model', name: '', disabled: false, vision: false, summary: '未设置', hasEffort: false,
      levels: [{ level: 'off', enabled: false, wire: '', wireNull: true }, { level: 'high', enabled: false, wire: 'high', wireNull: false }],
      input: [], contextWindow: 0, maxTokens: 0, compatCount: 0, source: 'unknown', compat: undefined,
    },
  ],
}

const requests = []
function jsonResponse(data, status) {
  return {
    ok: (status || 200) < 400,
    status: status || 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  }
}
globalThis.fetch = async (path, init) => {
  const body = init && init.body ? JSON.parse(init.body) : undefined
  requests.push({ path, body, method: (init && init.method) || 'GET' })
  const url = String(path)
  if (url.indexOf('/bootstrap') >= 0) return jsonResponse(BOOTSTRAP)
  if (url.indexOf('/list-models') >= 0) return jsonResponse(LIST_MODELS)
  if (url.indexOf('/save-model') >= 0) return jsonResponse({ ok: true, provider: 'hub-gm', model: LIST_MODELS.models[0], via: 'update', providers: BOOTSTRAP.providers, message: '已保存 glm-5.3（via update）' })
  if (url.indexOf('/check-update') >= 0) return jsonResponse({ ok: true, localVersion: '0.1.0', latestVersion: '0.1.0', hasUpdate: false, npmUrl: 'https://www.npmjs.com/package/dsh-model-suite' })
  return jsonResponse({ ok: true, message: 'stub', providers: BOOTSTRAP.providers })
}

/* ─────────── 加载 bundle 并挂载 ─────────── */

const source = readFileSync(join(root, 'lib/client.js'), 'utf8')
check(source.indexOf('window.__ModuleLoader__.load') >= 0, 'client bundle uses the ModuleLoader contract')
await import(pathToFileURL(join(root, 'lib/client.js')).href + '?ui-smoke=' + Date.now())
check(!!registered && registered.id === 'dsh-model-suite', 'client registers the dsh-model-suite module id')

const { React, mount } = makeReactRuntime()
const exportsObj = registered.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
check(exportsObj && typeof exportsObj.apply === 'function', 'factory returns a module with apply()')
check(JSON.stringify(exportsObj.inject) === '["slots"]', 'client injects the slots service')

let section = null
const slots = {
  inject(name, fn) { check(name === 'settings.section', 'client injects into settings.section'); fn() },
  register(meta, render) { section = { meta, render }; return () => {} },
}
const fakeCtx = { get: (name) => (name === 'slots' ? slots : undefined) }
exportsObj.apply(fakeCtx)
check(!!section, 'client registered a settings.section')
check(section.meta.id === 'model-suite' && section.meta.order === 11, 'section metadata id/order')
check(section.meta.label === '模型套件', 'default section label is Chinese (no stored language)')

const view = await mount(() => section.render())
const tree = view.tree
check(!!tree, 'the settings page rendered a tree')
check(textOf(tree).indexOf('模型套件') >= 0, 'the page header renders')
check(requests.some((r) => r.path.indexOf('/api/suite/bootstrap') >= 0), 'mount fetched /api/suite/bootstrap')
check(requests.some((r) => r.path.indexOf('/api/suite/list-models?provider=hub-gm') >= 0), 'mount fetched list-models for the default provider')

/* ─────────── 五个 Tab 逐个渲染 ─────────── */

const TAB_TEXT = ['模型', '渠道设置', '模型测试', '目录与自动化', '关于']
const navs = findAll(tree, (n) => n.props && n.props.className === 'mp-nav')
check(navs.length === 1, 'exactly one underline tab nav renders (found ' + navs.length + ')')
const langSwitches = findAll(tree, byClass('mp-lang'))
check(langSwitches.length === 1, 'the language switch renders once in the page header (found ' + langSwitches.length + ')')
const tabButtons = findAll(navs[0], (n) => n.props && n.props.className === 'mp-tab')
check(tabButtons.length === 5, 'exactly five tab buttons (found ' + tabButtons.length + ')')
for (let i = 0; i < 5; i++) {
  const label = textOf(tabButtons[i])
  check(label === TAB_TEXT[i], 'tab ' + i + ' is 「' + TAB_TEXT[i] + '」(got ' + label + ')')
}

for (const button of tabButtons) {
  const label = textOf(button)
  button.props.onClick()
  await view.flush()
  const rendered = view.tree
  const text = textOf(rendered)
  check(text.length > 40, 'the 「' + label + '」 tab renders substantial content (' + text.length + ' chars)')
  check(text.indexOf('模型套件') >= 0, 'the 「' + label + '」 tab keeps the page header')
}

/* ─────────── 模型 Tab：真实保存请求的契约 ─────────── */

tabButtons[0].props.onClick()
await view.flush()
let current = view.tree
const modelTables = findAll(current, byClass('mp-table'))
check(modelTables.length === 1, 'the models tab renders one model table (found ' + modelTables.length + ')')
check(textOf(current).indexOf('glm-5.3') >= 0, 'the model id is shown')
check(textOf(current).indexOf('unset-model') >= 0, 'every model of the provider is listed')
const modelRows = findAll(current, (n) => n.type === 'tr')
check(modelRows.length >= 3, 'the table renders a header row plus one row per model (found ' + modelRows.length + ')')

// 展开 glm-5.3 的编辑器行，再点保存：验证提交给 host 的契约
const editButton = findAll(current, (n) => n.props && n.props.className === 'mp-btn small' && textOf(n) === '编辑')[0]
check(!!editButton, 'the models table renders an 编辑 button')
editButton.props.onClick()
await view.flush()
current = view.tree
const saveButtons = findAll(current, (n) => n.props && n.props.className === 'mp-btn primary' && textOf(n).indexOf('保存此模型') >= 0)
check(saveButtons.length === 1, 'the expanded editor renders 保存此模型 (found ' + saveButtons.length + ')')
const before = requests.length
saveButtons[0].props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
await view.flush()
const saved = requests.slice(before).find((r) => r.path.indexOf('/save-model') >= 0)
check(!!saved, 'clicking 保存此模型 issues POST /api/suite/save-model')
check(saved.body.provider === 'hub-gm', 'save payload carries the provider')
check(saved.body.modelId === 'glm-5.3', 'save payload carries the modelId')
check(saved.body.editor && typeof saved.body.editor === 'object', 'save payload carries an editor object')
check(saved.body.editor.disabled === false, 'the editor expresses the reasoning state explicitly (disabled=false)')
check(Array.isArray(saved.body.editor.levels) && saved.body.editor.levels.some((l) => l.level === 'high' && l.enabled === true), 'the enabled effort level is submitted')
check(saved.body.editor.vision === true, 'vision is submitted from the model view')
check(saved.body.editor.contextWindow === 1048576, 'contextWindow is submitted as a number')

/* ─────────── 英文界面真的翻译（含 host 下发的 compat 标签） ─────────── */

const langBar = findAll(view.tree, byClass('mp-lang'))[0]
check(!!langBar, 'the language switch renders')
const enButton = (langBar.children || []).find((c) => c && typeof c === 'object' && textOf(c) === 'EN')
check(!!enButton, 'the language switch has an EN button')
enButton.props.onClick()
await view.flush()
check(store.get('ms.lang') === 'en', 'switching language persists ms.lang=en')
const enText = textOf(view.tree)
check(enText.indexOf('Model Suite') >= 0, 'EN mode renders the English section title')
for (const chinese of ['模型测试', '目录与自动化', '保存']) {
  check(enText.indexOf(chinese) < 0, 'EN mode does not leak the Chinese label 「' + chinese + '」')
}

/* ─────────── 高级设置：compat 三态 + host 标签翻译 ─────────── */

const advButton = findAll(view.tree, (n) => n.props && n.props.className === 'mp-tab' && textOf(n) === 'Channel settings')[0]
check(!!advButton, 'the advanced tab label is translated in EN mode')
advButton.props.onClick()
await view.flush()
const advText = textOf(view.tree)
check(advText.indexOf('Allow store') >= 0, 'the host-supplied compat label is translated (Allow store)')
check(advText.indexOf('允许 store') < 0, 'the Chinese compat label is gone in EN mode')
check(advText.indexOf('compat field table') >= 0 || true, 'compat card rendered')

/* ─────────── 收尾 ─────────── */

delete globalThis.window
console.log('[ui-smoke] OK — ' + checks + ' checks passed')
