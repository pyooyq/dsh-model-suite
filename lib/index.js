/**
 * dsh-model-suite host half — mounts the `/api/suite/*` JSON API.
 *
 * 浏览器半区（lib/client.js）通过同源 `/api/suite/*` 端点与本半区通信。
 *
 * 本插件 = model-plus 的 UI 能力 + enhancer 的三链路自动配置，按《dsh-model-suite
 * 开发文档》重新设计：
 *   - 供应商 CRUD 全部移除（回归官方「模型」页），本插件只读供应商、写模型与渠道字段；
 *   - 新增渠道级「高级设置」写入（compat / retryPolicy / 路由默认值 / headers）；
 *   - 目录改为三源聚合（models.dev → LiteLLM → OpenRouter，分层补缺、按需拉取、
 *     失败源不缓存、in-flight 去重、两级匹配且**不做前缀模糊匹配**）；
 *   - 三条自动链路（discoverModels 富化 / settings.* 保存写盘 / resolveModelInfo 兜底），
 *     命名空间闸门 + 自定义渠道判定 + **仅补缺** + 四字段开关 + 干净还原。
 *
 * 安装：`dsh plugin --profile web add dsh-model-suite`
 * cordis.patch.yml 把本插件行插入 web profile 的 cordis 层。
 *
 * ⚠️ 禁止与前身插件（model-plus / custom-provider-enhancer）共存：三者都拦截
 * settings 写入与 llm.resolveModelInfo，会互相覆盖配置。
 *
 * @module dsh-model-suite
 */
import {
  CATALOG_ROUTE_IDS,
  normalizeRouteId,
  isCatalogRoute,
  adoptCatalogRouteIds,
} from './catalog-routes.js'
import { COMPAT_FIELD_TABLE, CHAT_TEMPLATE_VARS, compatFieldMetadata } from './compat-fields.js'

/**
 * Stable cordis plugin name (matches cordis.patch.yml insert id).
 */
export const name = 'model-suite'

/**
 * Host 半区 inject：cordis 只认 string[] 或 { 服务名: config }。
 * 不要写 { required, optional }——会被当成服务名 "required"/"optional"，插件永远 pending。
 * `llm` 是三链路 monkey-patch 的必需依赖。
 * credentials / web 用 ctx.get(...) 可选读取，不进 inject。
 */
export const inject = ['settings', 'webServer', 'timer', 'llm']

/**
 * 插件版本（package.json 的镜像；build.mjs 会比对两者防止漂移）。
 * 刻意放在纯函数区段起点标记之前——security-smoke 用该标记切片构造断言，
 * 区段内不允许出现 `export` 语句。
 */
export const VERSION = '0.1.1'

/** 读写命名空间（与官方「模型」页共享）。 */
const NS = 'llm-pi-ai'
/** 插件自身偏好键。 */
const PREF_KEY = '__modelSuite'
/** 前身插件的偏好键，用于一次性迁移。 */
const LEGACY_PREF_KEY = '__modelPlus'
const API_PREFIX = '/api/suite'

/** DSH 思考档位（升序，与 dsh-llm-pi-ai THINKING_LEVELS 一致）。 */
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
/** 输入模态（与 dsh-llm-pi-ai MODALITIES 一致）。 */
const INPUTS = ['text', 'image']
/** 平台默认值——**仅作展示文案**，绝不作为"视为未填"的判定依据。 */
const DEFAULT_CONTEXT_WINDOW = 262144
const DEFAULT_MAX_TOKENS = 32768
const DEFAULT_INPUT = ['text']
/**
 * retryPolicy 展示口径（未配置时的"当前生效"文案）。
 *
 * ✅ 真机核对 `@deepseek-ai/dsh-llm/lib/types/retry-policy.js`：
 * `DEFAULT_MAX_RETRIES = 5`（normal 模式未配置 `maxRetries` 时的实际值）。
 * 开发文档 §10.2 / 附录 C 写的 2 是前身插件的口径，与当前 DSH 不符，这里以真机为准。
 */
const DEFAULT_PROVIDER_MAX_RETRIES = 5
const MAX_PROVIDER_MAX_RETRIES = 99999

/** 模型测试超时：10 分钟（推理 + 长 SVG 输出可能很慢）。 */
const TEST_TIMEOUT_MS = 10 * 60 * 1000
const MAX_TEST_BYTES = 1024 * 1024

/** 目录源 1（最高优先）：models.dev。 */
const MODELS_DEV_URL = 'https://models.dev/api.json'
/** 仓库根 api.json 的 GitHub raw 地址；国内源通过 gh-proxy.org 加速该快照。 */
const MODELS_GITHUB_SNAPSHOT_URL = 'https://github.com/pyooyq/dsh-model-suite/raw/refs/heads/main/api.json'
const MODELS_CN_PROXY_URL = 'https://gh-proxy.org/' + MODELS_GITHUB_SNAPSHOT_URL
/** 目录源 2：LiteLLM 价格/能力表。 */
const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
/** 目录源 3：OpenRouter 模型清单。 */
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models'

/** models.dev 地址预设（UI 单选用）。 */
const CATALOG_SOURCES = [
  { id: 'official', label: '官方 models.dev', url: MODELS_DEV_URL },
  { id: 'china', label: '国内 GitHub 加速', url: MODELS_CN_PROXY_URL },
  { id: 'custom', label: '自定义', url: '' },
  { id: 'litellm', label: 'LiteLLM', url: LITELLM_URL },
  { id: 'openrouter', label: 'OpenRouter', url: OPENROUTER_URL },
]

/** 目录缓存 TTL：30 分钟（按 URL 分键）。 */
const CATALOG_TTL_MS = 30 * 60 * 1000
/** 目录"全源慢失败"后的冷却窗口（M2）：期间 bounded 热路径不再发起拉取。 */
const CATALOG_FAIL_COOLDOWN_MS = 60 * 1000
/** models.dev 单源超时 / 体积上限。 */
const MODELS_DEV_TIMEOUT_MS = 20000
const MAX_MODELS_DEV_BYTES = 8 * 1024 * 1024
/** LiteLLM / OpenRouter 超时 / 体积上限。 */
const FETCH_TIMEOUT_MS = 15000
const MAX_REMOTE_BYTES = 2 * 1024 * 1024
/** 自身 discover-models 端点探测超时 / 上限。 */
const DISCOVER_TIMEOUT_MS = 20000
const MAX_DISCOVER_BYTES = 4 * 1024 * 1024

/** 默认测试提示词：一道生活常识推理题（开车 vs 走路 63 米）。 */
const DEFAULT_TEST_PROMPT = '我要去洗车，洗车店离家63米我是开车去还是走路去。'
/** SVG 动画输出较长；推理模型还会先占 reasoning_content，默认 16k。 */
const DEFAULT_TEST_MAX_TOKENS = 16384

/** 与 dsh-llm-pi-ai supportedProtocols() 对齐：手写 gateway 可声明的协议。 */
const PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages']
/** 官方 discoverModels 可探测列表的协议（anthropic-messages 无可读 listing）。 */
const LISTABLE_PROTOCOLS = ['openai-completions', 'openai-responses']
/** 官方 Models 页同款 route id：小写字母开头，仅 a-z0-9 与短横线。 */
const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const LEGAL_API_KEY = /^[\x21-\x7E]+$/
const ENV_LINE_KEY = /^[A-Z][A-Z0-9_]*=[^=]/
/** RFC 7230 token（header 名）。 */
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/
/** 自定义请求头总长上限。 */
const MAX_HEADERS_BYTES = 8 * 1024
/** 被平台覆盖 / 与鉴权或请求体语义冲突的保留头名（黄色提示，不阻断）。 */
const RESERVED_HEADER_NAMES = ['user-agent', 'authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'content-length', 'content-type', 'accept-encoding', 'host']

const MAX_REDIRECTS = 5
const MAX_MODEL_ID_LENGTH = 200
const MAX_PUBLIC_ERROR_LENGTH = 512
/**
 * 自动链路等待目录的**上限**（毫秒）。超时就用旧快照放行写入，拉取继续在后台跑——
 * 自动富化永远不能把用户的保存操作卡在网络上（冷启动 models.dev 最多 20 s）。
 */
const PATCH_CATALOG_WAIT_MS = 3000

/* compat 字段表来自 ./compat-fields.js（唯一真源；build.mjs 会断言字段数）。 */

/** 每个协议可用（gate === offer）的字段名集合。 */
const COMPAT_OFFER = {}
/** 每个协议下字段的类型与枚举约束。 */
const COMPAT_TYPES = {}
for (const api of Object.keys(COMPAT_FIELD_TABLE)) {
  const offer = new Set()
  const types = {}
  for (const row of COMPAT_FIELD_TABLE[api]) {
    offer.add(row[0])
    types[row[0]] = { type: row[1], values: row[4] }
  }
  COMPAT_OFFER[api] = offer
  COMPAT_TYPES[api] = types
}
/** 所有协议 offer 字段的并集（cloneModel 的类型校验用）。 */
const COMPAT_ALL_FIELDS = {}
for (const api of Object.keys(COMPAT_TYPES)) {
  for (const field of Object.keys(COMPAT_TYPES[api])) {
    if (!COMPAT_ALL_FIELDS[field]) COMPAT_ALL_FIELDS[field] = COMPAT_TYPES[api][field]
  }
}

const ALL_EFFORTS = {
  off: null, minimal: 'minimal', low: 'low', medium: 'medium',
  high: 'high', xhigh: 'xhigh', max: 'max',
}
/** 目录只表明"支持推理"但没给出档位时的 5 档默认。 */
const DEFAULT_EFFORTS = { off: null, low: 'low', medium: 'medium', high: 'high', max: 'max' }
const PRESETS = {
  none: { label: '关闭推理', efforts: false },
  basic: { label: '通用三档', efforts: { low: 'low', medium: 'medium', high: 'high' } },
  all: { label: '全开', efforts: ALL_EFFORTS },
  visionAll: { label: '视觉+全开', efforts: ALL_EFFORTS, vision: true },
}

/* ─────────────────────────── 纯工具函数 ───────────────────────────
   以下区段（到 apply 之前）必须保持「纯函数 + 只依赖模块常量」，
   以便 scripts/security-smoke.mjs 抽出并用 new Function 直接构造断言。
   请勿在本区段内使用动态 import / await / 闭包变量。 */

function parseHostHeader(host, protocol) {
  const value = typeof host === 'string' ? host.trim() : ''
  if (!value || /[\s\/@?#]/.test(value)) return null
  try {
    const parsed = new URL(protocol + '//' + value)
    if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) return null
    return parsed
  } catch (_) {
    return null
  }
}

function isLoopbackHostname(hostname) {
  const value = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (value === 'localhost' || value === '::1' || value === '0:0:0:0:0:0:0:1') return true
  if (value === '::ffff:127.0.0.1') return true
  const parts = value.split('.')
  if (parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    return true
  }
  return false
}

function sameUrlOrigin(left, right) {
  try {
    const a = new URL(left)
    const b = new URL(right)
    if (a.protocol !== b.protocol) return false
    if (a.hostname.toLowerCase() !== b.hostname.toLowerCase()) return false
    const aPort = a.port || (a.protocol === 'https:' ? '443' : '80')
    const bPort = b.port || (b.protocol === 'https:' ? '443' : '80')
    return aPort === bPort
  } catch (_) {
    return false
  }
}

/**
 * 跨域重定向上仍可安全保留的请求头（L3·三轮审查）。
 *
 * 此前只把 authorization / x-api-key 等**保留名**当作敏感——但渠道自定义头
 * （X-Gateway-Key 等）同样可能携带凭据，网关一旦 302 到别的 origin 就会被
 * 原样转发过去。现在跨域重定向时**除这三个无状态默认头外一律视为敏感**并拒绝。
 */
const SAFE_CROSS_ORIGIN_REDIRECT_HEADERS = ['accept', 'user-agent', 'content-length']

function hasCrossOriginUnsafeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return false
  return Object.keys(headers).some((key) => SAFE_CROSS_ORIGIN_REDIRECT_HEADERS.indexOf(String(key).toLowerCase()) < 0)
}

/** Create an absolute-deadline AbortSignal on supported Node versions. */
function createDeadlineSignal(ms) {
  const timeout = Number.isFinite(ms) && ms > 0 ? Math.ceil(ms) : 1
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(timeout)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  if (timer && typeof timer.unref === 'function') timer.unref()
  return controller.signal
}

function isLoopbackRemoteAddress(address) {
  const value = String(address || '').toLowerCase()
  if (!value) return false
  if (value === '::1' || value === '0:0:0:0:0:0:0:1') return true
  if (value.startsWith('::ffff:')) return isLoopbackHostname(value.slice('::ffff:'.length))
  return isLoopbackHostname(value)
}

/** 云元数据 / 链路本地等默认禁止出站目标（防 SSRF）。 */
function isBlockedOutboundHostname(hostname) {
  const value = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!value) return true
  if (value === 'metadata' || value === 'metadata.google.internal') return true
  if (value === '169.254.169.254' || value === '169.254.169.253') return true
  const v4 = value.split('.')
  if (v4.length === 4 && v4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
    const a = Number(v4[0])
    const b = Number(v4[1])
    if (a === 169 && b === 254) return true
    if (a === 0 || a === 255) return true
  }
  if (value.startsWith('fe80:')) return true
  return false
}

function assertOutboundUrlAllowed(rawUrl, options) {
  const opts = options && typeof options === 'object' ? options : {}
  let parsed
  try { parsed = new URL(rawUrl) } catch (_) { throw new Error('请求 URL 非法') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('仅支持 http/https')
  if (parsed.username || parsed.password) throw new Error('请求 URL 不得包含用户名/密码')
  const host = parsed.hostname
  if (isBlockedOutboundHostname(host)) throw new Error('禁止访问链路本地或云元数据地址')
  if (parsed.protocol === 'http:' && !isLoopbackHostname(host)) {
    throw new Error('非本机目标必须使用 HTTPS；HTTP 仅允许 localhost/127.0.0.0/8/::1')
  }
  if (opts.requireHttps === true && parsed.protocol !== 'https:') {
    throw new Error('该请求仅允许 HTTPS')
  }
  return parsed
}

/** Compare an Origin with Host using parsed host/port components, never suffix matching. */
function sameOriginHost(origin, host) {
  if (typeof origin !== 'string' || origin === '' || origin === 'null') return false
  try {
    const originUrl = new URL(origin)
    if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') return false
    if (originUrl.username || originUrl.password || originUrl.pathname !== '/' || originUrl.search || originUrl.hash) return false
    const hostUrl = parseHostHeader(host, originUrl.protocol)
    if (!hostUrl || originUrl.hostname.toLowerCase() !== hostUrl.hostname.toLowerCase()) return false
    const defaultPort = originUrl.protocol === 'https:' ? '443' : '80'
    return (originUrl.port || defaultPort) === (hostUrl.port || defaultPort)
  } catch (_) {
    return false
  }
}

/**
 * Host 头是否为 loopback 字面量（H1·三轮审查：DNS-rebinding 防线）。
 *
 * 平台 webServer 只按 pathname 分发、**不校验 Host**；写栅栏的 Origin≈Host
 * 一致性检查只能防 CSRF——DNS rebinding 下两者同为攻击者域名（evil.com:3080），
 * 一致性照样成立，且此时 TCP 远端恰好是本机浏览器（loopback），无 Origin 的
 * 兜底分支也拦不住。因此 /api/suite/*（**读 + 写**）一律要求 Host 是
 * localhost / 127.0.0.0/8 / ::1 字面量，非 loopback 直接 403。
 * 副作用：0.0.0.0 监听下的局域网主机名访问会被拒（见 README 部署说明）。
 */
function isLoopbackHostHeader(host) {
  const parsed = parseHostHeader(host, 'http:')
  if (!parsed) return false
  return isLoopbackHostname(parsed.hostname)
}

function routeError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[remote-url]')
    .replace(/[A-Za-z]:[\\/][^\r\n]*/g, '[path]')
    .slice(0, MAX_PUBLIC_ERROR_LENGTH)
}

function asObject(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {} }
function str(v, fb) { return typeof v === 'string' ? v : (fb === undefined ? '' : fb) }
function isPlainObject(v) { return !!v && typeof v === 'object' && !Array.isArray(v) }

/** 正整数或 undefined。 */
function positiveInteger(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

/**
 * 朴素语义化版本比较（M5）：返回 >0 表示 a 更新。
 * checkUpdate 之前用 `latest !== local` 判更新——把降级也报成"发现新版本"。
 * 按数字段逐段比较（0.10.0 > 0.9.9），预发布后缀（-rc.1）按其数字前缀参与比较。
 */
function compareVersion(a, b) {
  const pa = String(a == null ? '' : a).trim().replace(/^v/i, '').split('.')
  const pb = String(b == null ? '' : b).trim().replace(/^v/i, '').split('.')
  const n = Math.max(pa.length, pb.length)
  for (let i = 0; i < n; i++) {
    const x = parseInt(pa[i], 10) || 0
    const y = parseInt(pb[i], 10) || 0
    if (x !== y) return x - y
  }
  return 0
}

/** 字段是否"未填"（undefined / null / 空串 / 非正数 / 空数组 / 空对象）。 */
function isMissingValue(value) {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim().length === 0
  if (typeof value === 'number') return !(value > 0)
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value).length === 0
  return false
}

/**
 * 模型 id 归一化：lower → 去 query/fragment → 去结尾 :tag/@tag → 取最后一段 path。
 * 刻意**不做**任何前缀包含匹配（修正 enhancer R4：`o1-mini` 不得命中 `o1`）。
 */
function normalizeModelIdKey(id) {
  let s = String(id || '').trim().toLowerCase()
  if (!s) return ''
  s = s.split('?')[0].split('#')[0]
  s = s.replace(/[:@][a-z0-9._-]+$/i, '')
  if (s.indexOf('/') >= 0) {
    const parts = s.split('/').filter(Boolean)
    s = parts[parts.length - 1] || s
  }
  return s
}

/** 宽松归一化（第 2 级匹配）：分隔符 - _ . 等价。仍然不是前缀匹配。 */
function normalizeModelIdLoose(id) {
  return normalizeModelIdKey(id).replace(/[._]+/g, '-')
}

/**
 * 两个模型 id 是否指向同一个条目（大小写不敏感）。
 *
 * 用于"表内定位"（保存/删除/预设/测试取 source），不改变存储里的原始拼写。
 */
function sameModelId(left, right) {
  return String(left || '').trim().toLowerCase() === String(right || '').trim().toLowerCase()
}

/** 在模型表里按 id 定位（先精确匹配，再大小写不敏感兜底）。 */
function findModelIndex(models, modelId) {
  if (!Array.isArray(models)) return -1
  const exact = models.findIndex((m) => m && m.id === modelId)
  if (exact >= 0) return exact
  return models.findIndex((m) => m && sameModelId(m.id, modelId))
}

/**
 * 模型 id 字符集白名单（§13.4）。
 * 允许厂商前缀（`google/gemini-2.5-flash`）、版本 tag（`…-v2:0`）、通配（`*`/`?`）；
 * 拒绝空白、引号、尖括号、反斜杠与控制字符（防注入进 YAML / 路径）。
 */
function isSafeModelId(id) {
  if (typeof id !== 'string' || !id.length || id.length > MAX_MODEL_ID_LENGTH) return false
  return /^[A-Za-z0-9][A-Za-z0-9._:/@+~*?,\-[\]]*$/.test(id)
}

/** 思考档位与 THINKING_LEVELS 求交集并去重；非 off 档必须有非空 wire 值（修正 R9）。 */
function sanitizeEfforts(raw) {
  if (raw === false) return false
  if (!isPlainObject(raw)) return undefined
  const out = {}
  let positive = 0
  for (const level of LEVELS) {
    if (!Object.prototype.hasOwnProperty.call(raw, level)) continue
    const wire = raw[level]
    if (level === 'off') {
      out.off = wire === null || wire === undefined || wire === '' ? null : String(wire).slice(0, 64)
      continue
    }
    if (typeof wire !== 'string') continue
    const value = wire.trim()
    if (!value || value.length > 64) continue
    out[level] = value
    positive += 1
  }
  if (!positive) return undefined
  return out
}

/**
 * 由目录命中构造 reasoningEfforts（模型条目形态：{ 档位: wire 值 | null }）。
 * 返回 false（明确无推理）/ 对象 / 空对象（无法判定）。
 */
function buildEfforts(matched) {
  if (!matched || typeof matched !== 'object') return {}
  if (matched.reasoningEfforts === false) return false
  const explicit = sanitizeEfforts(matched.reasoningEfforts)
  if (explicit) return explicit
  if (matched.supportsReasoning === true) return Object.assign({}, DEFAULT_EFFORTS)
  return {}
}

/** 取实际注入档位中的最高非 off 档（修正 R8：不再硬编码 'high'）。 */
function highestNonOff(efforts) {
  if (!efforts || typeof efforts !== 'object') return undefined
  const levels = Array.isArray(efforts) ? efforts.map((e) => (isPlainObject(e) ? e.id : e)) : Object.keys(efforts)
  let best
  for (const level of LEVELS) {
    if (level === 'off') continue
    if (levels.indexOf(level) >= 0) best = level
  }
  return best
}

/**
 * 把 { 档位: wire } 转成 dsh-llm 的 `reasoning.efforts` 数组形态（[{ id, name }]）。
 *
 * ⚠️ 与开发文档 §7.5 的伪代码不同：本机 DSH 0.1.5-rc.2 的
 * `LlmService.normalizeModelInfo()` 产出 `reasoning.efforts = [{ id, name }]`，
 * 消费方（dsh-client-ui-model-selection / dsh-api-session-controller）直接
 * `reasoning.efforts.map(e => e.id)`。若照抄伪代码写对象会被运行时打爆。
 */
function effortsToInfoArray(efforts) {
  if (!efforts || typeof efforts !== 'object') return []
  const out = []
  for (const level of LEVELS) {
    if (!Object.prototype.hasOwnProperty.call(efforts, level)) continue
    out.push({ id: level, name: level.charAt(0).toUpperCase() + level.slice(1) })
  }
  return out
}

/** chat_template_kwargs / chat_template_args 的值校验（$var 形态或标量）。 */
function normalizeChatTemplateValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  if (isPlainObject(value)) {
    if (typeof value.$var !== 'string' || CHAT_TEMPLATE_VARS.indexOf(value.$var) < 0) {
      throw new Error('chat template 变量仅支持 ' + CHAT_TEMPLATE_VARS.join(' / '))
    }
    const out = { $var: value.$var }
    if (value.omitWhenOff !== undefined) {
      if (typeof value.omitWhenOff !== 'boolean') throw new Error('omitWhenOff 必须是布尔值')
      out.omitWhenOff = value.omitWhenOff
    }
    return out
  }
  throw new Error('chat template 值类型不支持')
}

/** 按类型校验一个 compat 字段值。 */
function validateCompatValueFor(field, type, values, value) {
  if (type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error('compat.' + field + ' 需要布尔值')
    return value
  }
  if (type === 'enum') {
    if (typeof value !== 'string' || (values && values.indexOf(value) < 0)) {
      throw new Error('compat.' + field + ' 取值非法' + (values ? '（可选 ' + values.join(', ') + '）' : ''))
    }
    return value
  }
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('compat.' + field + ' 需要数字')
    return Math.floor(value)
  }
  if (type === 'object') {
    if (!isPlainObject(value)) throw new Error('compat.' + field + ' 需要对象')
    const out = {}
    for (const key of Object.keys(value)) out[key] = normalizeChatTemplateValue(value[key])
    return out
  }
  throw new Error('compat.' + field + ' 类型未知')
}

/** 通用形态校验（用于 cloneModel：不知协议的字段也要按类型过滤）。 */
function sanitizeCompatFieldValue(field, value) {
  const spec = COMPAT_ALL_FIELDS[field]
  if (!spec) return undefined
  try {
    const clean = validateCompatValueFor(field, spec.type, spec.values, value)
    // ✅ 真机核对：schemastery 会把 compatProfile 里的 object 字段物化成 `{}`
    // （读 resolved 值时每个模型都带 chatTemplateKwargs:{} / chatTemplateArgs:{}）。
    // 空对象等价于"未设置"，必须丢掉，否则会污染 settings 并让 `C n` 徽章恒为 2。
    if (spec.type === 'object' && isPlainObject(clean) && Object.keys(clean).length === 0) return undefined
    return clean
  } catch (_) {
    return undefined
  }
}

/**
 * 归一化模型条目（白名单重建）。
 *
 * ★ 关键修正（风险 #7）：完整保留 `name` 与 **全量 `compat`**。model-plus 只透传
 * compat.thinkingFormat 与 supportsReasoningEffort，导致"保存任一模型"会把其它
 * compat 配置静默抹掉。
 * ★ `idPattern` 已移除（当前 pi-ai schema 无此字段）。
 * ★ **不折叠 id 大小写**（审查修正）：本函数既用于读取也用于整表重写，
 *   若在此 lower 化，保存任意一个模型就会把所有 id 一起改写；而部分网关的
 *   模型 id 是大小写敏感的（`Llama-3.1-8B`）。官方「模型」页同样只 trim 不 lower。
 *   比较一律走 `sameModelId()`，长度/字符集限制只在**入参**路径上校验。
 */
function cloneModel(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const id = typeof entry.id === 'string' ? entry.id.trim() : ''
  if (!id) return null
  const out = { id: id }
  if (typeof entry.name === 'string') {
    const name = entry.name.trim()
    if (name) out.name = name
  }
  const contextWindow = positiveInteger(entry.contextWindow)
  if (contextWindow !== undefined) out.contextWindow = contextWindow
  const maxTokens = positiveInteger(entry.maxTokens)
  if (maxTokens !== undefined) out.maxTokens = maxTokens
  if (Array.isArray(entry.input)) {
    const input = []
    for (const item of entry.input) {
      if (typeof item === 'string' && INPUTS.indexOf(item) >= 0 && input.indexOf(item) < 0) input.push(item)
    }
    // 文本是默认模态；只有视觉能力需要落盘 input 字段。
    if (input.indexOf('image') >= 0) out.input = ['text', 'image']
  }
  if (!out.input && entry.vision === true) out.input = ['text', 'image']
  if (entry.reasoningEfforts === false) {
    out.reasoningEfforts = false
  } else if (isPlainObject(entry.reasoningEfforts)) {
    const efforts = sanitizeEfforts(entry.reasoningEfforts)
    if (efforts) out.reasoningEfforts = efforts
  }
  if (isPlainObject(entry.compat)) {
    const compat = {}
    for (const field of Object.keys(entry.compat)) {
      const value = entry.compat[field]
      if (value === undefined || value === null) continue
      const clean = sanitizeCompatFieldValue(field, value)
      if (clean !== undefined) compat[field] = clean
    }
    if (Object.keys(compat).length) out.compat = compat
  }
  return out
}

/**
 * 写回路径专用的模型条目深拷贝（B6）：**原样保留全部自有键**——包括 DSH 未来
 * 版本新增、本插件 compat/模型表尚未认识的字段。cloneModel 是白名单重建器，
 * 任何"整表写回"（保存/删除/新增/补全）经过它都会把同渠道其它条目的未知字段
 * 静默抹掉；真机已核对 pi-ai Config schema 对未知键是宽松的（会原样持久化），
 * 所以透传写回是合法且必要的。
 *
 * 仅做三件清洗（与 cloneModel 的既有约定一致）：
 *   1. 丢掉 schemastery 在 resolved 值上物化的空对象（chatTemplateKwargs:{} 等），
 *      防止"平台默认值被钉进用户配置"；对表外字段同样适用（无法区分物化与手填，
 *      空对象一律视为未设置）。
 *   2. 丢掉物化的空 `input: []`（真机核对：裸条目 resolve 后 input 恒为 []，
 *      显式 ['text'] / ['text','image'] 原样保留——否则视觉补缺的"仅补缺"
 *      判定会被物化值骗过）。
 *   3. reasoningEfforts 为空对象时视为未设置（与 sanitizeEfforts 口径一致）。
 * 读路径/UI 视图继续走 cloneModel（白名单 + 类型校验）。
 */
function rawCloneModelEntry(entry) {
  if (entry === undefined || entry === null) return entry
  let out
  try { out = JSON.parse(JSON.stringify(entry)) } catch (_) { return null }
  if (!isPlainObject(out)) return out
  if (Array.isArray(out.input) && !out.input.length) delete out.input
  if (isPlainObject(out.compat)) {
    for (const key of Object.keys(out.compat)) {
      const value = out.compat[key]
      if (value === undefined || value === null || (isPlainObject(value) && Object.keys(value).length === 0)) {
        delete out.compat[key]
      }
    }
    if (!Object.keys(out.compat).length) delete out.compat
  }
  if (isPlainObject(out.reasoningEfforts) && !Object.keys(out.reasoningEfforts).length) delete out.reasoningEfforts
  return out
}

/** compat 里"真的被用户设置过"的键（空对象视为未设置——见 sanitizeCompatFieldValue）。 */
function compatEntries(compat) {
  const out = {}
  if (!isPlainObject(compat)) return out
  for (const field of Object.keys(compat)) {
    const value = compat[field]
    if (value === undefined || value === null) continue
    if (isPlainObject(value) && Object.keys(value).length === 0) continue
    out[field] = value
  }
  return out
}

/** 模型级 compat 计数（徽章用）。 */
function compatKeyCount(entry) {
  return Object.keys(compatEntries(entry && entry.compat)).length
}

/**
 * 校验并归一化客户端提交的模型级 compat。
 * 协议不支持的字段**报错**（不是静默丢弃）——否则用户以为保存成功而模型解析失败。
 */
function normalizeCompatInput(raw, api) {
  if (raw === undefined) return { present: false, value: undefined }
  if (raw === null) return { present: true, value: undefined }
  if (!isPlainObject(raw)) throw new Error('compat 需要对象')
  const offer = COMPAT_OFFER[api]
  // ★ B5：协议没有字段表（未知/未来协议）时，空对象意味着"客户端无法管理 compat"
  //   （compatDraftFromValue([], …) 只能产出空草稿），绝不能当成"显式清空"——
  //   否则对这类模型改个显示名就会顺手把它的 compat 抹掉。
  if (!offer && Object.keys(raw).length === 0) return { present: false, value: undefined }
  const types = COMPAT_TYPES[api]
  const out = {}
  for (const field of Object.keys(raw)) {
    const value = raw[field]
    if (value === undefined || value === null) continue
    if (!offer || !offer.has(field)) {
      throw new Error('compat.' + field + ' 不支持 ' + (api || '未知') + ' 协议')
    }
    const clean = validateCompatValueFor(field, types[field].type, types[field].values, value)
    if (types[field].type === 'object' && Object.keys(clean).length === 0) continue
    out[field] = clean
  }
  return { present: true, value: Object.keys(out).length ? out : undefined }
}

/** 自定义请求头校验（名 RFC 7230 token，值仅可打印字符，总长 ≤ 8KB）。
 * ★ 大小写不敏感去重（M1）：`{X-Foo, x-foo}` 若都放行，Node 会把两个头都发出去，
 *   网关行为未定义——与客户端 validateHeaderRows 的 seen[lower] 同口径。 */
function normalizeHeadersInput(raw) {
  if (raw === undefined) return { present: false, value: undefined, warnings: [] }
  if (raw === null) return { present: true, value: undefined, warnings: [] }
  if (!isPlainObject(raw)) throw new Error('headers 需要对象')
  const out = {}
  const warnings = []
  const seen = Object.create(null)
  let total = 0
  for (const name of Object.keys(raw)) {
    const value = raw[name]
    const key = name.trim()
    if (!key || !HEADER_NAME_PATTERN.test(key)) throw new Error('请求头名称非法: ' + clipText(key || '(空)', 60))
    if (typeof value !== 'string') throw new Error('请求头 ' + key + ' 的值必须是字符串')
    if (/[\r\n]/.test(value)) throw new Error('请求头 ' + key + ' 的值不得包含换行（防请求头注入）')
    if (!/^[\x20-\x7E\t]*$/.test(value)) throw new Error('请求头 ' + key + ' 的值仅允许可打印字符')
    const lower = key.toLowerCase()
    if (seen[lower]) throw new Error('请求头名称重复（大小写不同）：' + key)
    seen[lower] = true
    if (RESERVED_HEADER_NAMES.indexOf(lower) >= 0) {
      warnings.push('请求头「' + key + '」是保留名，会被平台覆盖或与鉴权冲突')
    }
    total += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(value, 'utf8')
    out[key] = value
  }
  if (total > MAX_HEADERS_BYTES) throw new Error('请求头总长度超过 8 KB 限制')
  return { present: true, value: Object.keys(out).length ? out : undefined, warnings: warnings }
}

/**
 * 取出可以安全外发的自定义请求头名（过滤保留名：会被平台覆盖或与鉴权冲突）。
 *
 * 用于「更新模型列表」与「测试模型」复用渠道级 headers。
 */
function customHeadersOf(headers) {
  const out = {}
  if (!isPlainObject(headers)) return out
  for (const name of Object.keys(headers)) {
    if (RESERVED_HEADER_NAMES.indexOf(String(name).toLowerCase()) >= 0) continue
    if (typeof headers[name] === 'string') out[name] = headers[name]
  }
  return out
}

/** 非空模态数组校验（不可为空）。 */function normalizeInputModalities(raw) {
  if (raw === undefined) return { present: false, value: undefined }
  if (raw === null) return { present: true, value: undefined }
  if (!Array.isArray(raw)) throw new Error('defaultInput 需要数组')
  const out = []
  for (const item of raw) {
    if (typeof item !== 'string' || INPUTS.indexOf(item) < 0) throw new Error('defaultInput 元素仅支持 text / image')
    if (out.indexOf(item) < 0) out.push(item)
  }
  if (!out.length) throw new Error('defaultInput 不可为空数组')
  if (out.indexOf('text') < 0) out.unshift('text')
  return { present: true, value: out }
}

/** retryPolicy 入参归一化（null / false = 清除）。 */
function normalizeRetryPolicyInput(raw) {
  if (raw === undefined) return { present: false, value: undefined }
  if (raw === null || raw === false) return { present: true, value: undefined }
  if (!isPlainObject(raw)) throw new Error('retryPolicy 需要对象')
  const mode = str(raw.mode, 'normal').trim() || 'normal'
  if (mode !== 'normal' && mode !== 'always') throw new Error('retryPolicy.mode 仅支持 normal / always')
  if (mode === 'always') {
    const next = { mode: 'always' }
    if (raw.backoff !== undefined) next.backoff = raw.backoff
    return { present: true, value: next }
  }
  let maxRetries = raw.maxRetries
  if (maxRetries === undefined || maxRetries === null || maxRetries === '') maxRetries = DEFAULT_PROVIDER_MAX_RETRIES
  maxRetries = Number(maxRetries)
  if (!Number.isFinite(maxRetries) || !Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new Error('maxRetries 须为 >= 0 的整数')
  }
  if (maxRetries > MAX_PROVIDER_MAX_RETRIES) throw new Error('maxRetries 最大 ' + MAX_PROVIDER_MAX_RETRIES)
  const next = { mode: 'normal', maxRetries: maxRetries }
  if (raw.retryableCodes !== undefined) next.retryableCodes = raw.retryableCodes
  if (raw.backoff !== undefined) next.backoff = raw.backoff
  return { present: true, value: next }
}

/** 目录 / 出站 URL 校验（默认要求 HTTPS，体积与协议策略见 §13）。 */
function validateCatalogUrl(value) {
  const raw = str(value, '').trim()
  if (!raw) return ''
  if (raw.length > 2048) throw new Error('目录地址过长（最长 2048 字符）')
  const parsed = assertOutboundUrlAllowed(raw, { requireHttps: true })
  return parsed.href
}

function clipText(value, max) {
  const s = String(value == null ? '' : value)
  const n = typeof max === 'number' && max > 0 ? max : 2000
  if (s.length <= n) return s
  return s.slice(0, n) + '…'
}

/** Keep diagnostic upstream text useful without echoing credentials or secrets. */
function sanitizeDiagnosticText(value, max) {
  return clipText(value, max)
    .replace(/(authorization|proxy-authorization|x-api-key|api-key|token|bearer)\s*([:=]\s*|\s+)[^\s,;"']+/gi, '$1: [redacted]')
    .replace(/\bsk-[A-Za-z0-9._-]{6,}\b/g, '[redacted-key]')
}

function joinNonEmptyTexts(parts) {
  return (parts || []).map((p) => String(p || '').trim()).filter(Boolean).join('\n\n')
}

function textFromContentField(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((c) => {
      if (typeof c === 'string') return c
      if (!c || typeof c !== 'object') return ''
      if (typeof c.text === 'string') return c.text
      if (typeof c.content === 'string') return c.content
      return ''
    }).filter(Boolean).join('')
  }
  return ''
}

/** 抽取助手可见文本（三协议）。 */
function extractAssistantText(api, body) {
  if (!body || typeof body !== 'object') return { text: '', reasoning: '', finishReason: '' }
  let text = ''
  let reasoning = ''
  let finishReason = ''

  if (api === 'anthropic-messages') {
    const content = body.content
    if (Array.isArray(content)) {
      const texts = []
      const thinks = []
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
        if ((block.type === 'thinking' || block.type === 'reasoning') && typeof block.thinking === 'string') thinks.push(block.thinking)
        if ((block.type === 'thinking' || block.type === 'reasoning') && typeof block.text === 'string') thinks.push(block.text)
      }
      text = texts.join('')
      reasoning = thinks.join('\n')
    }
    finishReason = str(body.stop_reason, '')
    return { text: text || '', reasoning: reasoning || '', finishReason: finishReason, display: text || reasoning || '' }
  }

  if (api === 'openai-responses') {
    if (typeof body.output_text === 'string') text = body.output_text
    const output = body.output
    if (Array.isArray(output)) {
      const parts = []
      const thinks = []
      for (const item of output) {
        if (item && typeof item === 'object') {
          if (item.type === 'reasoning' && typeof item.content === 'string') thinks.push(item.content)
          if (Array.isArray(item.summary)) {
            for (const s of item.summary) if (s && typeof s.text === 'string') thinks.push(s.text)
          }
        }
        const content = item && item.content
        if (!Array.isArray(content)) continue
        for (const c of content) {
          if (c && typeof c === 'object') {
            // 先看类型再取值：reasoning_text 属于思考内容，不能混进可见文本
            if (c.type === 'reasoning_text') { if (typeof c.text === 'string') thinks.push(c.text) }
            else if (typeof c.text === 'string') parts.push(c.text)
          }
        }
      }
      if (!text && parts.length) text = parts.join('')
      if (thinks.length) reasoning = thinks.join('\n')
    }
    finishReason = str(body.status, '')
    return { text: text || '', reasoning: reasoning || '', finishReason: finishReason, display: text || reasoning || '' }
  }

  const choices = body.choices
  if (Array.isArray(choices) && choices[0]) {
    const choice = choices[0]
    finishReason = str(choice.finish_reason, '') || str(choice.finishReason, '')
    const msg = choice.message || choice.delta || {}
    text = textFromContentField(msg.content)
    if (!text && typeof choice.text === 'string') text = choice.text
    const reasoningCandidates = [msg.reasoning_content, msg.reasoning, msg.thinking, msg.reasoningContent, choice.reasoning_content, body.reasoning_content]
    for (const c of reasoningCandidates) {
      const t = textFromContentField(c)
      if (t) { reasoning = t; break }
    }
  }
  return {
    text: text || '',
    reasoning: reasoning || '',
    finishReason: finishReason,
    display: joinNonEmptyTexts([text, !text && reasoning ? reasoning : '']),
  }
}

function extractErrorMessage(body, fallback) {
  if (body && typeof body === 'object') {
    if (typeof body.error === 'string' && body.error) return body.error
    if (body.error && typeof body.error === 'object') {
      if (typeof body.error.message === 'string' && body.error.message) return body.error.message
      if (typeof body.error.code === 'string' && body.error.code) return body.error.code
    }
    if (typeof body.message === 'string' && body.message) return body.message
  }
  return fallback || '请求失败'
}

/** 从模型回复中抽出第一个完整 <svg>...</svg>（容忍 markdown 代码围栏）。 */
function extractSvgMarkup(text) {
  const raw = String(text || '')
  if (!raw) return ''
  let s = raw.trim()
  const fenced = s.match(/```(?:svg|xml)?\s*([\s\S]*?)```/i)
  if (fenced && fenced[1]) s = fenced[1].trim()
  const lower = s.toLowerCase()
  const start = lower.indexOf('<svg')
  if (start < 0) return ''
  const end = lower.lastIndexOf('</svg>')
  if (end < 0 || end < start) return ''
  const svg = s.slice(start, end + 6).trim()
  if (svg.length < 20 || svg.length > 200000) return ''
  if (/<script[\s>]/i.test(svg) || /\bon[a-z]+\s*=/i.test(svg) || /javascript:/i.test(svg)) return ''
  return svg
}

/* ─────────────────── 三源目录：单源解析 ─────────────────── */

/** 判定一个路由是否为可富化的"自定义渠道"（修正 R1：显式 provider 判定）。 */
function isEnrichableRoute(route, includeCatalogRoutes, fallbackUnknown) {
  if (includeCatalogRoutes === true) return true
  const id = normalizeRouteId(route)
  if (!id) return fallbackUnknown === true
  return !CATALOG_ROUTE_IDS.has(id)
}

/** 目录候选的统一元数据。 */
function makeSuiteMeta(id, provider, source, fields) {
  const f = fields || {}
  const meta = {
    id: String(id || '').trim().toLowerCase(),
    normId: normalizeModelIdKey(id),
    looseId: normalizeModelIdLoose(id),
    provider: String(provider || '').trim().toLowerCase() || 'unknown',
    source: source,
    name: typeof f.name === 'string' && f.name ? f.name.slice(0, MAX_MODEL_ID_LENGTH) : undefined,
    contextWindow: positiveInteger(f.contextWindow),
    maxTokens: positiveInteger(f.maxTokens),
    inputModalities: Array.isArray(f.inputModalities) ? f.inputModalities.filter((m) => INPUTS.indexOf(m) >= 0) : [],
    supportsReasoning: typeof f.supportsReasoning === 'boolean' ? f.supportsReasoning : undefined,
    reasoningEfforts: f.reasoningEfforts === false ? false : sanitizeEfforts(f.reasoningEfforts),
  }
  return meta
}

/** 元数据指纹（用于多候选择一的指纹比较）。 */
function metadataFingerprint(meta) {
  return JSON.stringify({
    context: meta.contextWindow,
    output: meta.maxTokens,
    input: meta.inputModalities.slice().sort(),
    reasoning: meta.supportsReasoning === false ? false : (meta.reasoningEfforts ? Object.keys(meta.reasoningEfforts).sort() : undefined),
  })
}

/** 元数据丰富度（打分用）。 */
function metadataRichness(meta) {
  let n = 0
  if (positiveInteger(meta.contextWindow)) n += 2
  if (positiveInteger(meta.maxTokens)) n += 2
  if (Array.isArray(meta.inputModalities) && meta.inputModalities.length) n += 1
  if (meta.supportsReasoning === false || meta.reasoningEfforts) n += 2
  if (meta.name) n += 1
  return n
}

const PRIMARY_CATALOG_PROVIDERS = {
  deepseek: 100,
  openai: 90,
  anthropic: 90,
  google: 80,
  gemini: 80,
  xai: 70,
  mistral: 70,
  moonshotai: 70,
  moonshot: 70,
  qwen: 60,
  alibaba: 60,
  meta: 50,
  openrouter: 20,
}

function providerPreferScore(provider, modelId, hostname) {
  const pid = String(provider || '').toLowerCase()
  let score = 0
  if (PRIMARY_CATALOG_PROVIDERS[pid] != null) score += PRIMARY_CATALOG_PROVIDERS[pid]
  if (pid && hostname && hostname.indexOf(pid) >= 0) score += 50
  const nid = normalizeModelIdKey(modelId)
  if (pid && nid.indexOf(pid) === 0) score += 40
  return score
}

/**
 * 多候选择一（顺序即优先级，§8.5）。
 * @returns 选中的元数据，或 null
 */
function pickCatalogCandidate(candidates, id, baseURL, api) {
  if (!Array.isArray(candidates) || !candidates.length) return null
  if (candidates.length === 1) return candidates[0]

  let hostname = ''
  try { hostname = new URL(baseURL || '').hostname.toLowerCase() } catch (_) {}

  // 1) 主机名命中
  const hostMatch = candidates.find((meta) => meta.provider && hostname && hostname.indexOf(meta.provider) >= 0)
  if (hostMatch) return hostMatch

  // 2) 协议暗示的官方厂
  const canonicalProvider = api === 'openai-responses' ? 'openai' : api === 'anthropic-messages' ? 'anthropic' : undefined
  if (canonicalProvider) {
    const canonical = candidates.find((meta) => meta.provider === canonicalProvider)
    if (canonical) return canonical
  }

  // 3) 指纹唯一
  const fingerprints = new Set(candidates.map(metadataFingerprint))
  if (fingerprints.size === 1) return candidates[0]

  // 4) 指纹多数（占比 > 50% 且至少 2 个）
  const counts = Object.create(null)
  for (const meta of candidates) {
    const fp = metadataFingerprint(meta)
    counts[fp] = (counts[fp] || 0) + 1
  }
  let bestFp = ''
  let bestN = 0
  for (const fp of Object.keys(counts)) if (counts[fp] > bestN) { bestN = counts[fp]; bestFp = fp }
  if (bestN >= 2 && bestN > candidates.length / 2) {
    const major = candidates.find((meta) => metadataFingerprint(meta) === bestFp)
    if (major) return major
  }

  // 5) 加权打分
  let best = candidates[0]
  let bestScore = -1
  for (const meta of candidates) {
    const score = providerPreferScore(meta.provider, id, hostname) * 10 + metadataRichness(meta)
    if (score > bestScore) { bestScore = score; best = meta }
  }
  return best || null
}

/**
 * 两级匹配（§8.5，❌ 无前缀模糊匹配）。
 * 第 1 级 = 规范化相等（byNorm）；第 2 级 = 宽松相等（byLoose，分隔符等价）。
 */
function matchModelCandidates(id, catalog) {
  if (!catalog || !catalog.byNorm) return { candidates: [], level: 0 }
  const norm = normalizeModelIdKey(id)
  if (!norm) return { candidates: [], level: 0 }
  const exact = catalog.byNorm.get(norm)
  if (exact && exact.length) return { candidates: exact.slice(), level: 1 }
  const loose = catalog.byLoose ? catalog.byLoose.get(normalizeModelIdLoose(id)) : undefined
  if (loose && loose.length) return { candidates: loose.slice(), level: 2 }
  return { candidates: [], level: 0 }
}

/** 目录命中：返回选中的统一元数据（无命中返回 null）。 */
function matchModel(id, catalog, options) {
  const opts = options || {}
  const matched = matchModelCandidates(id, catalog)
  if (!matched.candidates.length) return null
  return pickCatalogCandidate(matched.candidates, id, opts.baseURL, opts.api)
}

/* ─────────────────── 三源目录：源解析与分层补缺 ─────────────────── */

/** models.dev 记录 → 元数据字段。 */
function fieldsFromModelsDev(record) {
  if (!isPlainObject(record)) return null
  const limit = isPlainObject(record.limit) ? record.limit : {}
  const modalities = isPlainObject(record.modalities) ? record.modalities : {}
  const input = []
  if (Array.isArray(modalities.input)) {
    for (const m of modalities.input) if ((m === 'text' || m === 'image') && input.indexOf(m) < 0) input.push(m)
  }
  let supportsReasoning
  let reasoningEfforts
  if (record.reasoning === false) {
    supportsReasoning = false
    reasoningEfforts = false
  } else {
    const options = Array.isArray(record.reasoning_options) ? record.reasoning_options : []
    const effort = options.find((o) => isPlainObject(o) && o.type === 'effort')
    if (effort && Array.isArray(effort.values)) {
      // off 默认给出：pi-ai 里 `reasoningEfforts.off = null` 的语义是"支持关闭，且关闭时
      // 不发送该参数"。目录列出档位就说明这模型可推理，而"不发参数"本来就是默认状态，
      // 所以这里总是附上 off，让 UI 的思考菜单里一定有「关闭」项（`none`/`off` 也映射到它）。
      const map = { off: null }
      let positive = 0
      for (const value of effort.values) {
        if (value === 'none' || value === 'off') continue
        if (typeof value !== 'string' || LEVELS.indexOf(value) < 0) continue
        map[value] = value
        positive += 1
      }
      if (positive) { supportsReasoning = true; reasoningEfforts = map }
      else supportsReasoning = true
    } else {
      supportsReasoning = true
    }
  }
  return {
    name: typeof record.name === 'string' ? record.name : undefined,
    contextWindow: positiveInteger(limit.context),
    maxTokens: positiveInteger(limit.output),
    inputModalities: input,
    supportsReasoning: supportsReasoning,
    reasoningEfforts: reasoningEfforts,
  }
}

/** LiteLLM 记录 → 元数据字段。 */
function fieldsFromLitellm(record) {
  if (!isPlainObject(record)) return null
  const ctx = positiveInteger(record.max_input_tokens) || positiveInteger(record.max_context) || positiveInteger(record.context_window)
  const out = positiveInteger(record.max_output_tokens) || positiveInteger(record.max_tokens)
  const input = []
  if (record.supports_vision === true) input.push('image')
  const modalities = record.supported_modalities
  if (Array.isArray(modalities)) {
    // LiteLLM 两种形态都见过：扁平的 `['text','image']` 与按端点的 `{ chat: ['text','image'] }`
    for (const m of modalities) {
      if (typeof m === 'string' && m === 'image' && input.indexOf('image') < 0) input.push('image')
      else if (Array.isArray(m) && m.indexOf('image') >= 0 && input.indexOf('image') < 0) input.push('image')
    }
  }
  let supportsReasoning
  if (record.supports_thinking === true) supportsReasoning = true
  else if (typeof record.mode === 'string' && record.mode === 'reasoning') supportsReasoning = true
  return {
    name: typeof record.model_name === 'string' ? record.model_name : undefined,
    contextWindow: ctx,
    maxTokens: out,
    inputModalities: input.length ? ['text'].concat(input) : [],
    supportsReasoning: supportsReasoning,
    reasoningEfforts: undefined,
  }
}

/** OpenRouter 记录 → 元数据字段。 */
function fieldsFromOpenRouter(record) {
  if (!isPlainObject(record)) return null
  const top = isPlainObject(record.top_provider) ? record.top_provider : {}
  const limits = isPlainObject(record.per_request_limits) ? record.per_request_limits : {}
  const arch = isPlainObject(record.architecture) ? record.architecture : {}
  const ctx = positiveInteger(record.context_length) || positiveInteger(top.context_length)
  const out = positiveInteger(top.max_completion_tokens) || positiveInteger(limits.max_tokens)
  const input = []
  if (Array.isArray(arch.input_modalities)) {
    for (const m of arch.input_modalities) if (m === 'image' && input.indexOf('image') < 0) input.push('image')
  }
  if (typeof arch.modality === 'string' && arch.modality.indexOf('image') >= 0 && input.indexOf('image') < 0) input.push('image')
  let supportsReasoning
  let reasoningEfforts
  const reasoning = isPlainObject(record.reasoning) ? record.reasoning : null
  if (reasoning && Array.isArray(reasoning.supported_efforts) && reasoning.supported_efforts.length) {
    supportsReasoning = true
    // off 默认给出（与 models.dev 同口径）：见 fieldsFromModelsDev 的说明
    const map = { off: null }
    let positive = 0
    for (const value of reasoning.supported_efforts) {
      if (typeof value !== 'string') continue
      if (value === 'none' || value === 'off') continue
      if (LEVELS.indexOf(value) < 0) continue
      map[value] = value
      positive += 1
    }
    if (positive) reasoningEfforts = map
  } else if (Array.isArray(record.supported_parameters)) {
    const params = record.supported_parameters.map(String)
    if (params.some((p) => p === 'reasoning' || p === 'reasoning_effort' || p === 'include_reasoning')) supportsReasoning = true
  }
  return {
    name: typeof record.name === 'string' ? record.name : undefined,
    contextWindow: ctx,
    maxTokens: out,
    inputModalities: input.length ? ['text'].concat(input) : [],
    supportsReasoning: supportsReasoning,
    reasoningEfforts: reasoningEfforts,
  }
}

/** 一个目录源的原始 JSON → SuiteModelMeta[]。 */
function parseCatalogSource(sourceId, data) {
  const out = []
  if (sourceId === 'modelsDev') {
    if (!isPlainObject(data)) throw new Error('models.dev 目录格式无效（需为对象）')
    for (const providerKey of Object.keys(data)) {
      const provider = data[providerKey]
      if (!isPlainObject(provider)) continue
      const models = provider.models
      if (!isPlainObject(models)) continue
      const pid = str(provider.id, providerKey) || providerKey
      for (const modelKey of Object.keys(models)) {
        const record = models[modelKey]
        const fields = fieldsFromModelsDev(record)
        if (!fields) continue
        const id = str(record && record.id, modelKey) || modelKey
        out.push(makeSuiteMeta(id, pid, 'models.dev', fields))
      }
    }
    return out
  }
  if (sourceId === 'litellm') {
    if (!isPlainObject(data)) throw new Error('LiteLLM 目录格式无效（需为对象）')
    for (const key of Object.keys(data)) {
      const record = data[key]
      if (!isPlainObject(record)) continue
      const fields = fieldsFromLitellm(record)
      if (!fields) continue
      const pid = str(record.litellm_provider, 'litellm') || 'litellm'
      // 只留原始键一条：`makeSuiteMeta` 的 normId/looseId 本来就会去掉 vendor 前缀
      // （`deepseek/deepseek-chat` → `deepseek-chat`），再补一条别名纯属重复，
      // 会让同 normId 的候选数翻倍、目录常驻内存翻倍（审查修正）。
      out.push(makeSuiteMeta(key, pid, 'litellm', fields))
    }
    return out
  }
  if (sourceId === 'openrouter') {
    const list = isPlainObject(data) && Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : null)
    if (!list) throw new Error('OpenRouter 目录格式无效（需为 { data: [...] }）')
    for (const record of list) {
      const fields = fieldsFromOpenRouter(record)
      if (!fields) continue
      const id = str(record && record.id, '')
      if (!id) continue
      const pid = String(id).split('/')[0] || 'openrouter'
      out.push(makeSuiteMeta(id, pid, 'openrouter', fields))
    }
    return out
  }
  return out
}

/** 源的优先级顺序（1 最高）。 */
const CATALOG_SOURCE_ORDER = ['modelsDev', 'litellm', 'openrouter']
const CATALOG_SOURCE_LABEL = { modelsDev: 'models.dev', litellm: 'litellm', openrouter: 'openrouter' }

/** 单个元数据字段是否仍为空（分层补缺用）。 */
function metaFieldMissing(meta, field) {
  if (field === 'name') return !meta.name
  if (field === 'contextWindow') return meta.contextWindow === undefined
  if (field === 'maxTokens') return meta.maxTokens === undefined
  if (field === 'inputModalities') return !meta.inputModalities.length
  if (field === 'supportsReasoning') return meta.supportsReasoning === undefined
  if (field === 'reasoningEfforts') return meta.reasoningEfforts === undefined
  return true
}

/**
 * 分层补缺（修正 R3）：先注册的源提供"有值的字段"，后注册源只填**仍为空**的字段。
 *
 * 同 normId 下按源优先级分组：取"有候选的最高优先源"作为主候选集，其余更低的源
 * 只用于给主候选的空字段补值（不会覆盖任何已有值，也不会用 undefined 降级）。
 */
function mergeLayered(perSource) {
  const byNorm = new Map()
  const byLoose = new Map()
  const perSourceNorm = new Map()
  for (const sourceId of CATALOG_SOURCE_ORDER) {
    const list = perSource[sourceId] || []
    const map = new Map()
    for (const meta of list) {
      if (!meta.normId) continue
      const bucket = map.get(meta.normId)
      if (bucket) bucket.push(meta)
      else map.set(meta.normId, [meta])
    }
    perSourceNorm.set(sourceId, map)
  }

  const allNormIds = new Set()
  for (const map of perSourceNorm.values()) for (const key of map.keys()) allNormIds.add(key)

  const FILL_FIELDS = ['name', 'contextWindow', 'maxTokens', 'inputModalities', 'supportsReasoning', 'reasoningEfforts']

  for (const normId of allNormIds) {
    // 主候选集 = 第一个有候选的源
    let primarySource = null
    let primary = null
    for (const sourceId of CATALOG_SOURCE_ORDER) {
      const bucket = perSourceNorm.get(sourceId).get(normId)
      if (bucket && bucket.length) { primarySource = sourceId; primary = bucket; break }
    }
    if (!primary) continue
    const lower = []
    let passedPrimary = false
    for (const sourceId of CATALOG_SOURCE_ORDER) {
      if (sourceId === primarySource) { passedPrimary = true; continue }
      if (!passedPrimary) continue
      const bucket = perSourceNorm.get(sourceId).get(normId)
      if (bucket) for (const meta of bucket) lower.push(meta)
    }
    const merged = primary.map((meta) => {
      if (!lower.length) return meta
      const copy = Object.assign({}, meta)
      for (const field of FILL_FIELDS) {
        if (!metaFieldMissing(copy, field)) continue
        for (const donor of lower) {
          if (metaFieldMissing(donor, field)) continue
          if (field === 'inputModalities') copy.inputModalities = donor.inputModalities.slice()
          else if (field === 'reasoningEfforts') copy.reasoningEfforts = donor.reasoningEfforts === false ? false : Object.assign({}, donor.reasoningEfforts)
          else copy[field] = donor[field]
          break
        }
      }
      if (copy.name && copy.name.length > MAX_MODEL_ID_LENGTH) copy.name = copy.name.slice(0, MAX_MODEL_ID_LENGTH)
      return copy
    })
    for (const meta of merged) {
      const bucket = byNorm.get(normId)
      if (bucket) bucket.push(meta)
      else byNorm.set(normId, [meta])
      const loose = meta.looseId || normId
      const looseBucket = byLoose.get(loose)
      if (looseBucket) looseBucket.push(meta)
      else byLoose.set(loose, [meta])
    }
  }
  return { byNorm: byNorm, byLoose: byLoose }
}

/** 用一组原始目录构建 catalog（供缓存复用）。 */
function buildCatalog(perSource, extras) {
  const merged = mergeLayered(perSource)
  const info = extras || {}
  return {
    byNorm: merged.byNorm,
    byLoose: merged.byLoose,
    sourcesUsed: info.sourcesUsed || [],
    sourceErrors: info.sourceErrors || {},
    at: Date.now(),
  }
}

/** 从 UI 偏好读取三源配置。 */
function readSourceConfig(prefs) {
  const p = asObject(prefs)
  const sources = asObject(p.sources)
  const cfg = {
    modelsDev: { url: str(p.modelsDevUrl, MODELS_DEV_URL) || MODELS_DEV_URL, enabled: true },
    litellm: { url: str(p.litellmUrl, LITELLM_URL) || LITELLM_URL, enabled: true },
    openrouter: { url: str(p.openrouterUrl, OPENROUTER_URL) || OPENROUTER_URL, enabled: true },
  }
  for (const key of CATALOG_SOURCE_ORDER) {
    const entry = asObject(sources[key])
    if (typeof entry.enabled === 'boolean') cfg[key].enabled = entry.enabled
    if (typeof entry.url === 'string') cfg[key].url = entry.url.trim() || cfg[key].url
  }
  return cfg
}

/**
 * 自动配置开关（每次调用都重新读取偏好 → 热生效）。
 * 默认全开；只有显式 false 才关闭。
 */
function readAutoConfig(prefs) {
  const p = asObject(asObject(prefs).auto)
  const fields = asObject(p.fields)
  return {
    enabled: p.enabled !== false,
    persistOnSave: p.persistOnSave !== false,
    fields: {
      contextWindow: fields.contextWindow !== false,
      maxTokens: fields.maxTokens !== false,
      input: fields.input !== false,
      reasoningEfforts: fields.reasoningEfforts !== false,
    },
    includeCatalogRoutes: p.includeCatalogRoutes === true,
  }
}

/**
 * 从 mutate op 提取 route 与路径尾部（§6.6 profileOf）。
 *
 * ✅ 真机核对（dsh-client-ui-settings-models）：官方「模型」页保存走 `mutate`，
 * op 形如 `{ op:'set', path:['providers', <route>, 'models'], value: [...] }`
 * 或 `{ op:'set', path:['providers', <route>, 'models', i, 'contextWindow'], value: 128000 }`。
 * 因此 route 主要来自 `op.path`，其次才是 `op.value.providers` 的键。
 */
function profileOf(op) {
  const path = Array.isArray(op && op.path) ? op.path : []
  if (path.length >= 2 && path[0] === 'providers' && typeof path[1] === 'string' && path[1]) {
    return { route: path[1], fields: path.slice(2) }
  }
  const value = op && op.value
  if (isPlainObject(value)) {
    const providers = isPlainObject(value.providers) ? value.providers : null
    if (providers) {
      const route = Object.keys(providers)[0]
      if (route) return { route: route, fields: Object.keys(asObject(providers[route])) }
    }
    // value 是一个 provider 对象但没有 path 信息时无法反推 route
    return {}
  }
  return {}
}

/** 一个对象是否"像"模型条目（有非空字符串 id）。 */
function looksLikeModelEntry(value) {
  return isPlainObject(value) && typeof value.id === 'string' && value.id.length > 0
}

/**
 * 富化一个 mutate op 的 value。
 *
 * 三种形态都要照顾（真机核对）：
 *   - `path=[...,'models']` + value 为模型数组 → 逐个富化；
 *   - `path=[...,'models',i]` + value 为单个模型条目 → 富化该条目；
 *   - `path=['providers',route]`（整 profile）或 `value={providers:{...}}` → 树内富化。
 * 其余（标量、非模型子字段）原样透传。
 */
function enrichOpValue(value, catalog, auto, route, fields) {
  if (!isEnrichableRoute(route, auto.includeCatalogRoutes, false)) return value
  const tail = Array.isArray(fields) ? fields[fields.length - 1] : undefined
  const inModelsArray = Array.isArray(fields) && fields.indexOf('models') >= 0
  if (Array.isArray(value)) {
    const isModelsArray = tail === 'models' || inModelsArray || value.some(looksLikeModelEntry)
    if (!isModelsArray) return value
    return value.map((item) => (looksLikeModelEntry(item) ? enrichModelConfig(item, catalog, auto, route) : item))
  }
  if (looksLikeModelEntry(value) && inModelsArray) return enrichModelConfig(value, catalog, auto, route)
  if (isPlainObject(value)) return enrichModelsInTree(value, catalog, auto, route, false)
  return value
}

/**
 * 递归富化器（修正 R11）：只在 `providers.<route>.models` 与显式 `models` 键路径上富化，
 * 不再"任何含 id 的数组都当模型数组"。
 *
 * 幂等 + 引用稳定：**没有任何改动时返回原引用**。这让链路二的补丁在"无需补缺"时
 * 等价于不存在（不产生多余写入，也不会在失败回退时重复尝试）。
 */
function enrichModelsInTree(value, catalog, auto, routeHint, parentIsProviders) {
  if (!value || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    let changed = false
    const out = value.map((item) => {
      const next = enrichModelsInTree(item, catalog, auto, routeHint, false)
      if (next !== item) changed = true
      return next
    })
    return changed ? out : value
  }
  let changed = false
  const out = {}
  for (const key of Object.keys(value)) {
    const child = value[key]
    const childRoute = parentIsProviders && isPlainObject(child) ? key : routeHint
    let nextChild = child
    if (key === 'models' && Array.isArray(child)) {
      if (isEnrichableRoute(routeHint, auto.includeCatalogRoutes, false)) {
        let modelsChanged = false
        const nextModels = child.map((m) => {
          const next = enrichModelConfig(m, catalog, auto, routeHint)
          if (next !== m) modelsChanged = true
          return next
        })
        if (modelsChanged) nextChild = nextModels
      }
    } else if (child && typeof child === 'object') {
      nextChild = enrichModelsInTree(child, catalog, auto, childRoute, key === 'providers')
    }
    if (nextChild !== child) changed = true
    out[key] = nextChild
  }
  return changed ? out : value
}

/** 单模型富化（四类字段，**仅补缺**）。未命中目录时不写任何字段。 */
function enrichModelConfig(entry, catalog, auto, routeHint) {
  if (!isPlainObject(entry) || typeof entry.id !== 'string' || !entry.id) return entry
  if (!isEnrichableRoute(routeHint, auto.includeCatalogRoutes, false)) return entry
  const matched = matchModel(entry.id, catalog)
  if (!matched) return entry
  const out = Object.assign({}, entry)
  const fields = auto.fields
  if (fields.contextWindow && isMissingValue(out.contextWindow) && positiveInteger(matched.contextWindow)) {
    out.contextWindow = positiveInteger(matched.contextWindow)
  }
  if (fields.maxTokens && isMissingValue(out.maxTokens) && positiveInteger(matched.maxTokens)) {
    out.maxTokens = positiveInteger(matched.maxTokens)
  }
  if (fields.input && isMissingValue(out.input) && matched.inputModalities.indexOf('image') >= 0) {
    out.input = ['text', 'image']
  }
  if (fields.reasoningEfforts && !Object.prototype.hasOwnProperty.call(out, 'reasoningEfforts')) {
    const efforts = buildEfforts(matched)
    if (efforts && Object.keys(efforts).length) out.reasoningEfforts = efforts
  }
  return out
}

/** 链路一富化：只写 contextWindow / maxTokens（LlmDiscoveredModel 的类型限制）。 */
function enrichDiscovered(models, catalog, auto, route, gateAlreadyPassed) {
  if (!Array.isArray(models) || !models.length) return models
  if (!auto.fields.contextWindow && !auto.fields.maxTokens) return models
  // 调用方（链路一）已判定过渠道闸门时可以跳过——新草稿没有 route，闸门在那里按"自定义"放行
  if (gateAlreadyPassed !== true && !isEnrichableRoute(route, auto.includeCatalogRoutes, false)) return models
  return models.map((m) => {
    if (!isPlainObject(m) || typeof m.id !== 'string' || !m.id) return m
    const matched = matchModel(m.id, catalog)
    if (!matched) return m
    const out = Object.assign({}, m)
    if (auto.fields.contextWindow && isMissingValue(out.contextWindow) && positiveInteger(matched.contextWindow)) {
      out.contextWindow = positiveInteger(matched.contextWindow)
    }
    if (auto.fields.maxTokens && isMissingValue(out.maxTokens) && positiveInteger(matched.maxTokens)) {
      out.maxTokens = positiveInteger(matched.maxTokens)
    }
    return out
  })
}

/**
 * 把目录补丁应用到本地模型条目（§11.9）。
 * @param localModel 本地条目
 * @param remote 远程补丁 { name?, contextWindow?, maxTokens?, input?, reasoningEfforts? }
 * @param overwrite false = 仅补缺失字段
 * @param syncInput true 时 remote 有 image 则写 ['text','image']
 */
function applyRemoteToLocal(localModel, remote, overwrite, syncInput) {
  // ★ B6：基座用透传克隆（保留未知/未来字段），已知字段的补缺/覆盖逻辑不变
  const base = rawCloneModelEntry(localModel)
  let next = isPlainObject(base) ? base : { id: str(localModel && localModel.id, '') }
  const notes = []
  let changed = false
  const patch = isPlainObject(remote) ? remote : {}

  if (patch.reasoningEfforts === false) {
    if (overwrite || !Object.prototype.hasOwnProperty.call(next, 'reasoningEfforts')) {
      if (next.reasoningEfforts !== false) { next.reasoningEfforts = false; changed = true; notes.push('关闭推理') }
    }
  } else if (isPlainObject(patch.reasoningEfforts)) {
    const efforts = sanitizeEfforts(patch.reasoningEfforts)
    if (efforts) {
      if (overwrite || !Object.prototype.hasOwnProperty.call(next, 'reasoningEfforts')) {
        if (JSON.stringify(next.reasoningEfforts || null) !== JSON.stringify(efforts)) {
          next.reasoningEfforts = efforts
          changed = true
          notes.push('推理档')
        }
      }
    }
  }

  if (syncInput && Array.isArray(patch.input) && patch.input.indexOf('image') >= 0) {
    const before = JSON.stringify(next.input || [])
    if (overwrite || !Object.prototype.hasOwnProperty.call(next, 'input')) {
      next.input = ['text', 'image']
      if (JSON.stringify(next.input) !== before) { changed = true; notes.push('输入类型') }
    }
  }

  const ctxValue = positiveInteger(patch.contextWindow)
  if (ctxValue !== undefined && (overwrite || next.contextWindow === undefined)) {
    if (next.contextWindow !== ctxValue) { next.contextWindow = ctxValue; changed = true; notes.push('上下文') }
  }
  const outValue = positiveInteger(patch.maxTokens)
  if (outValue !== undefined && (overwrite || next.maxTokens === undefined)) {
    if (next.maxTokens !== outValue) { next.maxTokens = outValue; changed = true; notes.push('maxTokens') }
  }
  if (patch.name && (overwrite || !next.name)) {
    if (next.name !== patch.name) { next.name = String(patch.name).slice(0, MAX_MODEL_ID_LENGTH); changed = true; notes.push('名称') }
  }
  return { model: next, changed: changed, notes: notes.join(',') }
}

/** 还原补丁：原本无自有属性就 delete，不留转发壳（修正 R7）。 */
function restoreMethod(target, key, original, hadOwn) {
  if (hadOwn) target[key] = original
  else delete target[key]
}

/**
 * Register the model-suite host API on the context: the settings-backed model
 * catalog plus the same-origin JSON endpoints the browser half calls, plus the
 * three automatic-configuration patch chains.
 */
export function apply(ctx) {
  let hostProto = null
  function refreshHostProto() {
    try {
      const list = ctx.settings.describe()
      if (Array.isArray(list) && list.length) { hostProto = Object.getPrototypeOf(list[0]); return }
    } catch (_) {}
    try {
      const v = ctx.settings.get(NS)
      if (v && typeof v === 'object') hostProto = Object.getPrototypeOf(v)
    } catch (_) {}
  }
  refreshHostProto()

  function H(data) {
    if (data === null || typeof data === 'string' || typeof data === 'boolean' || typeof data === 'number') return data
    if (Array.isArray(data)) {
      const a = []
      for (let i = 0; i < data.length; i++) a[i] = H(data[i])
      return a
    }
    if (data && typeof data === 'object') {
      const o = hostProto ? Object.create(hostProto) : Object.create(null)
      for (const k of Object.keys(data)) { if (data[k] !== undefined) o[k] = H(data[k]) }
      return o
    }
    return data
  }

  function log(level, message) {
    try {
      const logger = ctx.logger || (ctx.root && ctx.root.logger)
      if (logger && typeof logger[level] === 'function') logger[level]('[model-suite] ' + message)
    } catch (_) {}
  }

  function readPiAi() { return asObject(ctx.settings.get(NS)) }
  function readPrefs() { return asObject(readPiAi()[PREF_KEY]) }
  function readLegacyPrefs() { return asObject(readPiAi()[LEGACY_PREF_KEY]) }
  function readAuto() { return readAutoConfig(readPrefs()) }

  function listProvidersRaw() { return asObject(readPiAi().providers) }

  function providerProfile(provider) {
    return asObject(listProvidersRaw()[provider])
  }

  function getRawModels(provider) {
    const profile = providerProfile(provider)
    return Array.isArray(profile.models) ? profile.models.map(cloneModel).filter(Boolean) : []
  }

  /**
   * 写回路径的模型表（B6）：原样透传（含未知/未来字段），仅剔除物化的空对象。
   * 保存/删除/新增/补全都改用本函数取整表——"改一个模型"不再重写其它条目的
   * 本插件不认识的字段。读路径（UI 视图、查找）继续用 getRawModels。
   */
  function getRawModelsEntries(provider) {
    const profile = providerProfile(provider)
    return Array.isArray(profile.models)
      ? profile.models.map(rawCloneModelEntry).filter((m) => m !== null && m !== undefined && typeof m === 'object')
      : []
  }

  function hasVision(m) { return Array.isArray(m.input) && m.input.map(String).indexOf('image') >= 0 }

  function effortSummary(m) {
    if (m.reasoningEfforts === false) return '关闭'
    if (isPlainObject(m.reasoningEfforts)) {
      const keys = Object.keys(m.reasoningEfforts)
      if (!keys.length) return '未设置'
      const positive = LEVELS.filter((l) => l !== 'off' && Object.prototype.hasOwnProperty.call(m.reasoningEfforts, l))
      if (positive.length) return positive[positive.length - 1]
      if (Object.prototype.hasOwnProperty.call(m.reasoningEfforts, 'off')) return '关闭'
      return keys.join(', ') || '未设置'
    }
    return '未设置'
  }

  function modelView(m, autoCfg) {
    const effortsObj = (m.reasoningEfforts && m.reasoningEfforts !== false && isPlainObject(m.reasoningEfforts)) ? m.reasoningEfforts : null
    const levels = LEVELS.map((level) => {
      const enabled = !!(effortsObj && Object.prototype.hasOwnProperty.call(effortsObj, level))
      let wire = ''
      let wireNull = false
      if (enabled) {
        if (effortsObj[level] === null) wireNull = true
        else wire = String(effortsObj[level] == null ? '' : effortsObj[level])
      } else if (level === 'off') wireNull = true
      else wire = level
      return { level: level, enabled: enabled, wire: wire, wireNull: wireNull }
    })
    return {
      id: m.id,
      name: str(m.name, ''),
      disabled: m.reasoningEfforts === false,
      vision: hasVision(m),
      levels: levels,
      summary: effortSummary(m),
      hasEffort: !!(effortsObj && Object.keys(effortsObj).length),
      input: Array.isArray(m.input) ? m.input.slice() : [],
      contextWindow: positiveInteger(m.contextWindow) || 0,
      maxTokens: positiveInteger(m.maxTokens) || 0,
      compat: (() => {
        const entries = compatEntries(m.compat)
        return Object.keys(entries).length ? JSON.parse(JSON.stringify(entries)) : undefined
      })(),
      compatCount: compatKeyCount(m),
      source: paramSource(m, autoCfg),
    }
  }

  /** 参数来源提示（§12.8 术语统一）。基于已缓存的目录做无网络比较。
   *  autoCfg（O2）：listModels 逐模型渲染时由调用方读一次 readAuto() 传入，
   *  避免每个模型都触发一次 settings.get。 */
  function paramSource(m, autoCfg) {
    const hasAny = positiveInteger(m.contextWindow) !== undefined || positiveInteger(m.maxTokens) !== undefined
      || hasVision(m) || (isPlainObject(m.reasoningEfforts) && Object.keys(m.reasoningEfforts).length)
    if (!hasAny) return 'unknown'
    const catalog = peekCatalog()
    if (!catalog) return 'manual'
    const matched = matchModel(m.id, catalog)
    if (!matched) return 'manual'
    const ctxMatch = positiveInteger(m.contextWindow) !== undefined && positiveInteger(m.contextWindow) === positiveInteger(matched.contextWindow)
    const outMatch = positiveInteger(m.maxTokens) !== undefined && positiveInteger(m.maxTokens) === positiveInteger(matched.maxTokens)
    const visionMatch = hasVision(m) && matched.inputModalities.indexOf('image') >= 0
    if (!ctxMatch && !outMatch && !visionMatch) return 'manual'
    const auto = autoCfg || readAuto()
    return auto.enabled && auto.persistOnSave ? 'auto' : 'catalog'
  }

  function readRetryPolicyView(profile) {
    const rp = asObject(profile && profile.retryPolicy)
    if (!Object.keys(rp).length) {
      return { configured: false, mode: 'normal', maxRetries: null, effectiveMaxRetries: DEFAULT_PROVIDER_MAX_RETRIES, label: '默认 ' + DEFAULT_PROVIDER_MAX_RETRIES + ' 次' }
    }
    const mode = str(rp.mode, 'normal') || 'normal'
    if (mode === 'always') return { configured: true, mode: 'always', maxRetries: null, effectiveMaxRetries: null, label: 'always（持续重试）' }
    let maxRetries = null
    if (typeof rp.maxRetries === 'number' && Number.isFinite(rp.maxRetries)) maxRetries = Math.max(0, Math.floor(rp.maxRetries))
    const effective = maxRetries == null ? DEFAULT_PROVIDER_MAX_RETRIES : maxRetries
    return { configured: true, mode: 'normal', maxRetries: maxRetries, effectiveMaxRetries: effective, label: String(effective) }
  }

  function listProviders() {
    const providers = listProvidersRaw()
    const userLayer = getUserLayer()
    const userProviders = asObject(userLayer.providers)
    return Object.keys(providers).sort().map((id) => {
      const p = asObject(providers[id])
      const models = Array.isArray(p.models) ? p.models.map(cloneModel).filter(Boolean) : []
      let withEffort = 0
      let withVision = 0
      let withCompat = 0
      for (const m of models) {
        if (isPlainObject(m.reasoningEfforts) && Object.keys(m.reasoningEfforts).length) withEffort += 1
        if (hasVision(m)) withVision += 1
        if (compatKeyCount(m) > 0) withCompat += 1
      }
      const retry = readRetryPolicyView(p)
      const rawUser = asObject(userProviders[id])
      const headers = asObject(rawUser.headers)
      const api = str(p.api, '')
      return {
        provider: id,
        displayName: str(p.displayName, id),
        baseURL: str(p.baseURL, ''),
        api: api,
        modelCount: models.length,
        withEffort: withEffort,
        withVision: withVision,
        withCompat: withCompat,
        retryConfigured: retry.configured,
        retryMode: retry.mode,
        retryMaxRetries: retry.maxRetries,
        retryEffectiveMaxRetries: retry.effectiveMaxRetries,
        retryLabel: retry.label,
        headersCount: Object.keys(headers).length,
        headers: Object.keys(headers).length ? JSON.parse(JSON.stringify(headers)) : {},
        retryPolicy: isPlainObject(rawUser.retryPolicy) ? JSON.parse(JSON.stringify(rawUser.retryPolicy)) : null,
        compat: isPlainObject(rawUser.compat) ? JSON.parse(JSON.stringify(rawUser.compat)) : {},
        defaults: {
          contextWindow: positiveInteger(rawUser.defaultContextWindow) || null,
          maxTokens: positiveInteger(rawUser.defaultMaxTokens) || null,
          input: Array.isArray(rawUser.defaultInput) ? rawUser.defaultInput.slice() : null,
        },
        defaultsConfigured: {
          contextWindow: positiveInteger(rawUser.defaultContextWindow) !== undefined,
          maxTokens: positiveInteger(rawUser.defaultMaxTokens) !== undefined,
          input: Array.isArray(rawUser.defaultInput) && rawUser.defaultInput.length > 0,
        },
        isCatalogRoute: isCatalogRoute(id),
        offeredCompatFields: api && COMPAT_OFFER[api] ? Array.from(COMPAT_OFFER[api]) : [],
      }
    })
  }

  /* ───────────── 设置读写（三连降级 + CAS） ───────────── */

  /**
   * settings 里 **用户层** 的 llm-pi-ai 原文（不含平台默认值 / 上层组合基座）。
   *
   * ★ 审查修正：describe() 没有 `user` 时**必须回落到空对象**，而不是回落到
   * `settings.get(NS)`（已解析值）。否则：
   *   1) replace 回退通道会把整份平台默认值（defaultContextWindow / defaultMaxTokens /
   *      defaultInput / 物化出来的 compat 空对象…）写进用户的 settings.yaml；
   *   2) list-models 的 `defaultsConfigured` / `headersCount` 会把"用户没配过"报成已配置。
   * 只用用户层还有一个好处：`replace` 语义本来就是"缺的键回落到基座"。
   */
  function getUserLayer() {
    refreshHostProto()
    try {
      const list = ctx.settings.describe()
      for (const d of list) if (d && d.ns === NS && d.user && typeof d.user === 'object') return JSON.parse(JSON.stringify(d.user))
    } catch (_) {}
    return { providers: {} }
  }

  /** 当前 llm-pi-ai namespace 的 settings revision，用于 expectedRevision CAS。 */
  function readNsRevision() {
    try {
      const list = ctx.settings.describe()
      if (Array.isArray(list)) {
        for (const d of list) {
          if (d && d.ns === NS && typeof d.revision === 'number' && Number.isFinite(d.revision)) return d.revision
        }
      }
    } catch (_) {}
    return undefined
  }

  function isSettingsConflictError(error) {
    if (!error) return false
    if (error.code === 'SETTINGS_CONFLICT') return true
    const name = error.name ? String(error.name) : ''
    const msg = error.message ? String(error.message) : String(error)
    return name === 'SettingsConflictError' || /SETTINGS_CONFLICT|settings conflict|stale.*revision|revision mismatch/i.test(msg)
  }

  const CONFLICT_MESSAGE = '配置已被其他操作更新，请刷新后重试'

  /**
   * CAS 冲突专用错误（B2）：挂上 statusCode = 409。
   * 之前冲突以裸 Error 冒出，postRoute 兜底成 HTTP 400——README §8 明确承诺
   * 409 是"终端状态、不得自动重试"，客户端也需要靠它区分"刷新重试"与"改参数"。
   */
  function conflictError() {
    const err = new Error(CONFLICT_MESSAGE)
    err.statusCode = 409
    return err
  }

  /** 模型级写入：update → replace → mutate（带 CAS）。 */
  async function writeModels(provider, models) {
    if (!ctx.settings.writable) throw new Error('settings 只读')
    refreshHostProto()
    const errors = []
    const profileNow = providerProfile(provider)
    const expectedRevision = readNsRevision()

    try {
      await ctx.settings.update(NS, H({ providers: { [provider]: { models: models } } }), expectedRevision)
      return 'update'
    } catch (e) {
      if (isSettingsConflictError(e)) throw conflictError()
      errors.push('update:' + (e && e.message ? e.message : String(e)))
    }

    try {
      const user = getUserLayer() || { providers: {} }
      if (!isPlainObject(user.providers)) user.providers = {}
      const prev = isPlainObject(user.providers[provider]) ? user.providers[provider] : {}
      // ★ 审查修正：只补"让渠道仍可解析"的定位字段（api/apiKeyEnv/baseURL），
      //   其余一律**不**从解析值回落。`defaultContextWindow` / `defaultMaxTokens` /
      //   `defaultInput` / `compat` 都是"带默认值的派生值"，把它们写进用户层会
      //   （a）让默认值被钉死、(b) 让 defaultsConfigured 把"没配过"报成"已配置"。
      //   缺的键本来就会从基座/平台默认层回落，这正是 replace 的语义。
      const nextProfile = Object.assign({}, prev, {
        apiKeyEnv: prev.apiKeyEnv || profileNow.apiKeyEnv,
        api: prev.api || profileNow.api,
        baseURL: prev.baseURL || profileNow.baseURL,
        models: models,
      })
      for (const key of Object.keys(nextProfile)) if (nextProfile[key] === undefined) delete nextProfile[key]
      user.providers[provider] = nextProfile
      await ctx.settings.replace(NS, H(user), expectedRevision)
      return 'replace'
    } catch (e) {
      if (isSettingsConflictError(e)) throw conflictError()
      errors.push('replace:' + (e && e.message ? e.message : String(e)))
    }

    try {
      const ops = [Object.assign(H({ op: 'set', path: ['providers', provider, 'models'], value: models }), {
        op: 'set',
        path: ['providers', String(provider), 'models'],
        value: H(models),
      })]
      await ctx.settings.mutate(NS, ops, expectedRevision)
      return 'mutate'
    } catch (e) {
      if (isSettingsConflictError(e)) throw conflictError()
      errors.push('mutate:' + (e && e.message ? e.message : String(e)))
    }

    throw new Error('写回失败: ' + errors.join(' | '))
  }

  /**
   * 渠道级字段写入（高级设置）：白名单字段，mutate（set/unset）→ replace → update。
   *
   * 顺序说明：clear（置 null）必须走 `unset` 或整层 replace；`update` 是 merge 语义，
   * 无法删除键。因此把 replace 排在 update 之前，保证"清除"真的生效，而不是静默失败。
   */
  async function writeProviderFields(provider, sets, clears) {
    if (!ctx.settings.writable) throw new Error('settings 只读')
    refreshHostProto()
    const errors = []
    const expectedRevision = readNsRevision()
    const warnings = []

    const ops = []
    for (const field of sets.keys()) {
      ops.push(Object.assign(H({ op: 'set', path: ['providers', provider, field], value: sets.get(field) }), {
        op: 'set',
        path: ['providers', String(provider), String(field)],
        value: H(sets.get(field)),
      }))
    }
    for (const field of clears) {
      ops.push(Object.assign(H({ op: 'unset', path: ['providers', provider, field] }), {
        op: 'unset',
        path: ['providers', String(provider), String(field)],
      }))
    }

    try {
      await ctx.settings.mutate(NS, ops, expectedRevision)
      return { via: 'mutate', warnings: warnings }
    } catch (e) {
      if (isSettingsConflictError(e)) throw conflictError()
      errors.push('mutate:' + (e && e.message ? e.message : String(e)))
    }

    try {
      const user = getUserLayer() || { providers: {} }
      if (!isPlainObject(user.providers)) user.providers = {}
      const prev = isPlainObject(user.providers[provider]) ? JSON.parse(JSON.stringify(user.providers[provider])) : {}
      for (const field of clears) delete prev[field]
      for (const field of sets.keys()) prev[field] = JSON.parse(JSON.stringify(sets.get(field)))
      user.providers[provider] = prev
      await ctx.settings.replace(NS, H(user), expectedRevision)
      return { via: 'replace', warnings: warnings }
    } catch (e) {
      if (isSettingsConflictError(e)) throw conflictError()
      errors.push('replace:' + (e && e.message ? e.message : String(e)))
    }

    try {
      const patch = {}
      for (const field of sets.keys()) patch[field] = sets.get(field)
      await ctx.settings.update(NS, H({ providers: { [provider]: patch } }), expectedRevision)
      for (const field of clears) warnings.push('字段 ' + field + ' 未能清除（该写入通道不支持删除）')
      return { via: 'update', warnings: warnings }
    } catch (e) {
      if (isSettingsConflictError(e)) throw conflictError()
      errors.push('update:' + (e && e.message ? e.message : String(e)))
    }

    throw new Error('保存渠道设置失败: ' + errors.join(' | '))
  }

  /** 插件偏好写入（llm-pi-ai.__modelSuite）。 */
  async function saveSuitePrefs(patch) {
    if (!ctx.settings.writable) throw new Error('settings 只读')
    refreshHostProto()
    const next = Object.assign({}, readPrefs(), patch || {})
    const expectedRevision = readNsRevision()
    try {
      await ctx.settings.update(NS, H({ [PREF_KEY]: next }), expectedRevision)
      return next
    } catch (e) {
      if (isSettingsConflictError(e)) throw conflictError()
    }
    const user = getUserLayer() || {}
    user[PREF_KEY] = next
    try {
      await ctx.settings.replace(NS, H(user), expectedRevision)
    } catch (e) {
      // ★ B2：replace 回退通道的冲突同样规范化为 409，而不是让原始错误裸奔
      if (isSettingsConflictError(e)) throw conflictError()
      throw e
    }
    return next
  }

  /** 一次性从 __modelPlus 迁移目录地址（不删除旧键）。 */
  function migrateLegacyPrefs() {
    try {
      if (Object.keys(readPrefs()).length) return false
      const legacy = readLegacyPrefs()
      if (!Object.keys(legacy).length) return false
      const url = str(legacy.modelsDevUrl, '') || str(legacy.modelsUrl, '') || str(legacy.indexUrl, '')
      const patch = {
        migratedFromModelPlus: true,
        modelsDevUrl: /^https:\/\//i.test(url) ? url : MODELS_DEV_URL,
        sources: { modelsDev: { enabled: true }, litellm: { enabled: true }, openrouter: { enabled: true } },
        auto: { enabled: true, persistOnSave: true, fields: { contextWindow: true, maxTokens: true, input: true, reasoningEfforts: true }, includeCatalogRoutes: false },
      }
      saveSuitePrefs(patch).catch((e) => log('warn', '偏好迁移失败: ' + (e && e.message ? e.message : String(e))))
      return true
    } catch (_) {
      return false
    }
  }

  /* ───────────── 出站 HTTP ───────────── */

  function httpRequestText(url, options, redirectCount, budgetLeft) {
    const opts = options && typeof options === 'object' ? options : {}
    const method = str(opts.method, 'GET').toUpperCase() || 'GET'
    const headersIn = opts.headers && typeof opts.headers === 'object' ? opts.headers : {}
    const body = typeof opts.body === 'string' ? opts.body : ''
    const timeoutMs = (typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0) ? opts.timeoutMs : DISCOVER_TIMEOUT_MS
    const maxBytes = (typeof opts.maxBytes === 'number' && opts.maxBytes > 0) ? opts.maxBytes : MAX_DISCOVER_BYTES
    const rejectHttpError = opts.rejectHttpError === true
    if (typeof redirectCount !== 'number' || redirectCount < 0) redirectCount = 0
    const budget = (typeof budgetLeft === 'number' && budgetLeft > 0) ? budgetLeft : timeoutMs
    const hopStart = Date.now()

    return new Promise((resolve, reject) => {
      Promise.all([import('node:https'), import('node:http')]).then(([httpsMod, httpMod]) => {
        let parsed
        try {
          parsed = assertOutboundUrlAllowed(url)
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)))
          return
        }
        const isHttps = parsed.protocol === 'https:'
        const lib = isHttps ? httpsMod : httpMod
        const targetHost = parsed.hostname
        const targetPort = parsed.port || (isHttps ? 443 : 80)
        const targetPath = parsed.pathname + (parsed.search || '')
        const isLoopback = isLoopbackHostname(targetHost)
        const proxyUrl = isLoopback
          ? ''
          : (process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '')

        const deadlineSignal = createDeadlineSignal(budget)

        const finishResponse = (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume()
            if (redirectCount >= MAX_REDIRECTS) {
              reject(new Error('重定向次数超限（' + MAX_REDIRECTS + '）'))
              return
            }
            if (method !== 'GET' && method !== 'HEAD') {
              reject(new Error('非 GET 请求遇到重定向（HTTP ' + res.statusCode + '），已中止'))
              return
            }
            const spent = Date.now() - hopStart
            const nextBudget = budget - spent
            if (nextBudget <= 50) {
              reject(new Error('请求超过总截止时间（' + timeoutMs + 'ms）'))
              return
            }
            let nextUrl
            try { nextUrl = new URL(res.headers.location, url).href } catch (_) {
              reject(new Error('重定向目标非法'))
              return
            }
            try {
              const nextParsed = assertOutboundUrlAllowed(nextUrl)
              if (parsed.protocol === 'https:' && nextParsed.protocol !== 'https:') {
                reject(new Error('HTTPS 请求禁止降级到 HTTP 重定向'))
                return
              }
              if (hasCrossOriginUnsafeHeaders(headersIn) && !sameUrlOrigin(url, nextUrl)) {
                reject(new Error('携带请求头（凭据/自定义头）的请求禁止跨域重定向'))
                return
              }
            } catch (e) {
              reject(e instanceof Error ? e : new Error('重定向目标非法'))
              return
            }
            httpRequestText(nextUrl, opts, redirectCount + 1, nextBudget).then(resolve, reject)
            return
          }

          const declared = Number(res.headers['content-length'])
          if (Number.isFinite(declared) && declared > maxBytes) {
            res.resume()
            reject(new Error('响应超过 ' + maxBytes + ' 字节限制'))
            return
          }
          const chunks = []
          let total = 0
          let aborted = false
          res.on('data', (c) => {
            if (aborted) return
            total += c.length
            if (total > maxBytes) {
              aborted = true
              res.destroy()
              reject(new Error('响应超过 ' + maxBytes + ' 字节限制'))
              return
            }
            chunks.push(c)
          })
          res.on('end', () => {
            if (aborted) return
            const text = Buffer.concat(chunks).toString('utf8')
            const statusCode = res.statusCode || 0
            if (rejectHttpError && (statusCode < 200 || statusCode >= 300)) {
              if (statusCode === 401 || statusCode === 403) {
                reject(new Error('端点返回 ' + statusCode + '；请检查 API Key'))
                return
              }
              reject(new Error('端点返回 HTTP ' + statusCode))
              return
            }
            resolve({ statusCode: statusCode, text: text })
          })
          res.on('error', reject)
        }

        const reqHeaders = Object.assign({
          accept: 'application/json',
          'user-agent': 'dsh-model-suite',
        }, headersIn)
        if (body && !reqHeaders['content-length'] && !reqHeaders['Content-Length']) {
          reqHeaders['content-length'] = Buffer.byteLength(body)
        }

        const doRequest = (reqOpts) => {
          const req = lib.request(Object.assign({}, reqOpts, { signal: deadlineSignal }), finishResponse)
          req.on('error', (error) => {
            if (error && (error.name === 'AbortError' || error.name === 'TimeoutError' || error.code === 'ABORT_ERR')) {
              reject(new Error('请求超过总截止时间（' + timeoutMs + 'ms）'))
              return
            }
            reject(error)
          })
          req.on('timeout', () => { req.destroy(); reject(new Error('请求超时（' + timeoutMs + 'ms）')) })
          deadlineSignal.addEventListener('abort', () => {
            req.destroy(new Error('请求超过总截止时间（' + timeoutMs + 'ms）'))
          })
          if (body) req.write(body)
          req.end()
          return req
        }

        const directOpts = {
          hostname: targetHost,
          port: targetPort,
          path: targetPath,
          method: method,
          headers: reqHeaders,
          timeout: timeoutMs,
        }

        if (!proxyUrl || !isHttps) {
          doRequest(directOpts)
          return
        }

        // O4：用标准 URL 解析代理地址（urlMod.parse 是废弃 API），默认端口按协议
        //   推断（https→443 / http→80），不再臆造 8080。解析失败按直连处理。
        let proxy = null
        try { proxy = new URL(proxyUrl) } catch (_) { proxy = null }
        if (!proxy || !proxy.hostname) { doRequest(directOpts); return }
        const tunnelReq = httpMod.request(Object.assign({
          hostname: proxy.hostname,
          port: Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80),
          method: 'CONNECT',
          path: targetHost + ':' + targetPort,
          timeout: timeoutMs,
          headers: { host: targetHost + ':' + targetPort },
        }, { signal: deadlineSignal }))
        tunnelReq.on('error', (error) => {
          if (error && (error.name === 'AbortError' || error.name === 'TimeoutError' || error.code === 'ABORT_ERR')) {
            reject(new Error('请求超过总截止时间（' + timeoutMs + 'ms）'))
            return
          }
          reject(error)
        })
        tunnelReq.on('timeout', () => { tunnelReq.destroy(); reject(new Error('代理连接超时（' + timeoutMs + 'ms）')) })
        deadlineSignal.addEventListener('abort', () => {
          tunnelReq.destroy(new Error('请求超过总截止时间（' + timeoutMs + 'ms）'))
        })
        tunnelReq.on('connect', (proxyRes, socket) => {
          if (proxyRes.statusCode !== 200) {
            reject(new Error('代理 CONNECT 失败: HTTP ' + proxyRes.statusCode))
            return
          }
          doRequest(Object.assign({}, directOpts, { socket: socket, agent: false }))
        })
        tunnelReq.end()
      }).catch(reject)
    })
  }

  function httpGetText(url, headers, timeoutMs, maxBytes, redirectCount) {
    return httpRequestText(url, {
      method: 'GET',
      headers: headers,
      timeoutMs: timeoutMs,
      maxBytes: maxBytes,
      rejectHttpError: true,
    }, redirectCount).then((r) => r.text)
  }

  function httpsGetText(url, timeoutMs) {
    return httpGetText(url, null, timeoutMs || FETCH_TIMEOUT_MS, MAX_REMOTE_BYTES, 0)
  }

  /* ───────────── SuiteCatalog（三源聚合 + 缓存 + 匹配） ───────────── */

  const catalogCache = new Map()      // url → { at, metas }
  const catalogInflight = new Map()   // url → Promise
  const catalogErrors = new Map()     // sourceId → message
  let catalogSnapshot = null          // 最近一次**至少一源成功**的聚合结果（供 peekCatalog 使用）
  /** 最近一次"全源失败"的时间戳（0 = 无）；只有慢失败才进入冷却（见 getCatalogBounded）。 */
  let catalogFailureAt = 0
  /** 最近一次全源失败是否为"慢失败"（耗时 ≥ PATCH_CATALOG_WAIT_MS，即超时/挂起类）。 */
  let catalogFailureSlow = false

  /**
   * 单源缓存条目上限（O1：6 → 3）。
   *
   * 每个条目是一整份解析后的目录（models.dev 快照有上万条），是**大对象**；
   * 3 份 = 三源各一份 + 换一次地址的余量，再多的历史地址纯属浪费内存
   * （此前 6 份上限在用户多改几次目录地址后常驻内存可达几十 MB）。
   * 依然按 LRU 语义（最近写入时间）裁剪。
   */
  const CATALOG_CACHE_MAX_ENTRIES = 3

  function trimCatalogCache() {
    while (catalogCache.size > CATALOG_CACHE_MAX_ENTRIES) {
      let oldestKey = null
      let oldestAt = Infinity
      for (const [key, entry] of catalogCache) {
        const at = entry && typeof entry.at === 'number' ? entry.at : 0
        if (at < oldestAt) { oldestAt = at; oldestKey = key }
      }
      if (oldestKey === null) return
      catalogCache.delete(oldestKey)
    }
  }

  /** 单源拉取：**只缓存成功源**；失败源下次调用重试（修正 R5）。 */
  async function fetchSource(sourceId, url, force) {
    const now = Date.now()
    const hit = catalogCache.get(url)
    if (!force && hit && (now - hit.at) < CATALOG_TTL_MS) return hit.metas
    const running = catalogInflight.get(url)
    if (running) return running
    const timeoutMs = sourceId === 'modelsDev' ? MODELS_DEV_TIMEOUT_MS : FETCH_TIMEOUT_MS
    const maxBytes = sourceId === 'modelsDev' ? MAX_MODELS_DEV_BYTES : MAX_REMOTE_BYTES
    const job = (async () => {
      const text = await httpGetText(url, { accept: 'application/json' }, timeoutMs, maxBytes, 0)
      let data
      try { data = JSON.parse(text) } catch (_) { throw new Error('目录返回非 JSON：' + url) }
      const metas = parseCatalogSource(sourceId, data)
      catalogCache.set(url, { at: Date.now(), metas: metas })
      trimCatalogCache()
      return metas
    })()
    catalogInflight.set(url, job)
    try {
      return await job
    } finally {
      if (catalogInflight.get(url) === job) catalogInflight.delete(url)
    }
  }

  /**
   * 三源聚合。
   *
   * @param options.force 强制忽略缓存
   * @param options.queryIds 本次关心的模型 id；若 models.dev 全部命中则不拉另两源（省流量）
   * @param options.only 仅使用这些源（临时覆盖，UI 用）
   */
  async function getCatalog(options) {
    const opts = options || {}
    const cfg = readSourceConfig(readPrefs())
    const enabled = CATALOG_SOURCE_ORDER.filter((id) => {
      if (opts.only && Array.isArray(opts.only) && opts.only.length && opts.only.indexOf(id) < 0) return false
      const spec = cfg[id]
      return !!spec && spec.enabled !== false && typeof spec.url === 'string' && spec.url.length > 0
    })
    const perSource = {}
    const sourcesUsed = []
    const sourceErrors = {}
    const queryIds = Array.isArray(opts.queryIds) && opts.queryIds.length ? opts.queryIds : null

    let needMore = true
    const startedAt = Date.now()
    for (const sourceId of enabled) {
      if (sourceId !== 'modelsDev' && !needMore) break
      const spec = cfg[sourceId]
      try {
        const metas = await fetchSource(sourceId, spec.url, !!opts.force)
        perSource[sourceId] = metas
        sourcesUsed.push(CATALOG_SOURCE_LABEL[sourceId])
        catalogErrors.delete(sourceId)
      } catch (e) {
        // 失败源不写缓存（fetchSource 只在成功时 set），下次调用自然重试
        const message = e && e.message ? e.message : String(e)
        sourceErrors[sourceId] = clipText(message, 200)
        catalogErrors.set(sourceId, sourceErrors[sourceId])
        perSource[sourceId] = []
      }
      if (sourceId === 'modelsDev' && queryIds) {
        const seen = new Set()
        for (const meta of perSource[sourceId] || []) if (meta.normId) seen.add(meta.normId)
        needMore = queryIds.some((id) => !seen.has(normalizeModelIdKey(id)))
      }
    }
    for (const sourceId of CATALOG_SOURCE_ORDER) {
      if (!(sourceId in perSource) && catalogErrors.has(sourceId) && !sourceErrors[sourceId]) {
        sourceErrors[sourceId] = catalogErrors.get(sourceId)
      }
    }

    const catalog = buildCatalog(perSource, { sourcesUsed: sourcesUsed, sourceErrors: sourceErrors })
    if (sourcesUsed.length) {
      catalogSnapshot = catalog
      catalogFailureAt = 0
      catalogFailureSlow = false
    } else if (enabled.length && !opts.only) {
      // ★ B1：全源失败**绝不**把空快照缓存成"新鲜聚合结果"——旧实现里失败的源也会
      //   `perSource[id] = []`，于是 `Object.keys(perSource).length` 恒 >0，空目录
      //   会被 catalogSnapshot 接管，TTL 30 分钟内自动链路全部静默失效。
      //   现在：有上一次的成功快照就沿用（带上本次的按源错误），没有就记录失败。
      catalogFailureAt = Date.now()
      catalogFailureSlow = (catalogFailureAt - startedAt) >= PATCH_CATALOG_WAIT_MS
      if (catalogSnapshot) {
        return Object.assign({}, catalogSnapshot, { sourceErrors: sourceErrors })
      }
    }
    return catalog
  }

  /** 只用已缓存内容做一次聚合（不触发网络），用于 list-models 的来源徽章。 */
  function peekCatalog() {
    if (catalogSnapshot) return catalogSnapshot
    return null
  }

  /**
   * 自动链路专用的**有界**目录获取。
   *
   * 自动富化绝不能把用户的"保存"卡住：冷启动时 models.dev 最多要 20 s。这里
   * 先用新鲜快照直接返回；否则把一次真实拉取与 `PATCH_CATALOG_WAIT_MS` 赛跑，
   * 超时就用上一次快照（没有就空目录）先把写入放行，拉取在后台继续
   * （in-flight 去重保证下一次调用直接受益）。
   */
  async function getCatalogBounded(queryIds) {
    if (catalogSnapshot && (Date.now() - catalogSnapshot.at) < CATALOG_TTL_MS) return catalogSnapshot
    // ★ M2："慢失败"刚发生（拉取超时/挂起类，单次就 ≥3s）时短暂冷却，避免断网期间
    //   每次 resolveModelInfo / 保存都白等 3 秒——有旧快照就用旧快照，没有就空目录。
    //   快失败（404 / DNS 立即失败）不冷却——重试开销极低，下一次调用立即再试。
    if (catalogFailureSlow && catalogFailureAt && (Date.now() - catalogFailureAt) < CATALOG_FAIL_COOLDOWN_MS) {
      return catalogSnapshot || buildCatalog({}, {})
    }
    const job = getCatalog({ force: false, queryIds: queryIds })
    let timer = null
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), PATCH_CATALOG_WAIT_MS)
      if (timer && typeof timer.unref === 'function') timer.unref()
    })
    const raced = await Promise.race([job.then((value) => value, () => null), timeout])
    if (timer) clearTimeout(timer)
    if (raced) return raced
    job.catch(() => {})
    return catalogSnapshot || buildCatalog({}, {})
  }

  /* ───────────── 端点实现 ───────────── */

  function resolveProviderApiKey(profile, overrideKey) {
    const draft = validateApiKeyDraft(overrideKey)
    if (draft) return Promise.resolve(draft)
    const ref = str(profile && profile.apiKeyEnv, '').trim()
    if (!ref) return Promise.resolve('')
    const credentials = ctx.get('credentials')
    if (credentials && typeof credentials.resolve === 'function') {
      return Promise.resolve(credentials.resolve(ref)).then((hit) => {
        const value = hit && typeof hit.value === 'string' ? hit.value : ''
        return value ? validateApiKeyDraft(value) : ''
      }).catch(() => '')
    }
    try {
      const envVal = process.env[ref]
      if (typeof envVal === 'string' && envVal.trim()) return Promise.resolve(validateApiKeyDraft(envVal))
    } catch (_) {}
    return Promise.resolve('')
  }

  function validateApiKeyDraft(draft) {
    if (draft === undefined || draft === null) return ''
    if (typeof draft !== 'string') throw new Error('API Key 格式无效')
    if (draft.length === 0) return ''
    const value = draft.trim()
    if (!value) throw new Error('API Key 不能只含空白')
    if (ENV_LINE_KEY.test(value) || ((value[0] === '"' || value[0] === "'" || value[0] === '`') && value.length > 1 && value.endsWith(value[0]))) {
      throw new Error('API Key 不要粘贴 NAME=value 或带引号的整行')
    }
    if (!LEGAL_API_KEY.test(value)) throw new Error('API Key 含非法字符（仅允许可打印 ASCII，不含空格）')
    if (value.length > 4096) throw new Error('API Key 过长')
    return value
  }

  function validateProviderBaseURL(value) {
    const url = str(value, '').trim()
    if (!url) return ''
    if (url.length > 2048) throw new Error('baseURL 过长')
    assertOutboundUrlAllowed(url)
    return url
  }

  /** Join baseURL with /models the same way dsh-llm-pi-ai listingUrl does (prefix, not URL resolve). */
  function listingUrl(baseURL) {
    return String(baseURL).replace(/\/+$/, '') + '/models'
  }

  function joinEndpoint(baseURL, suffix) {
    const base = String(baseURL || '').replace(/\/+$/, '')
    const path = String(suffix || '').replace(/^\/+/, '')
    return base + '/' + path
  }

  function capacityField() {
    for (let i = 0; i < arguments.length; i++) {
      const c = arguments[i]
      if (typeof c === 'number' && Number.isInteger(c) && c > 0) return c
    }
    return undefined
  }

  function labelField() {
    for (let i = 0; i < arguments.length; i++) {
      const c = arguments[i]
      if (typeof c === 'string' && c.trim().length > 0 && c.trim().length <= MAX_MODEL_ID_LENGTH) return c.trim()
    }
    return undefined
  }

  /** Parse OpenAI-compatible { data: [...] } listing. */
  function readOpenAiListing(body) {
    const listing = isPlainObject(body) ? body : {}
    let listed = []
    if (Array.isArray(listing.data)) {
      listed = listing.data.map((raw) => ({ key: undefined, raw: raw }))
    } else if (isPlainObject(listing.models)) {
      const map = listing.models
      listed = Object.keys(map).filter((k) => isPlainObject(map[k])).map((k) => ({ key: k, raw: map[k] }))
    } else {
      throw new Error('端点模型列表既不是 data 数组也不是 models 对象；请改用手填模型，或检查 baseURL / 协议')
    }
    const models = []
    const seen = Object.create(null)
    for (const item of listed) {
      const entry = isPlainObject(item.raw) ? item.raw : {}
      const rawId = labelField(item.key, entry.id)
      if (!rawId) continue
      // 去重用小写键，但存储保留原始大小写（网关 id 可能大小写敏感）
      const dedupe = rawId.toLowerCase()
      if (seen[dedupe]) continue
      seen[dedupe] = true
      const name = labelField(entry.name, entry.display_name, entry.displayName) || rawId
      const limit = isPlainObject(entry.limit) ? entry.limit : {}
      const top = isPlainObject(entry.top_provider) ? entry.top_provider : {}
      const contextWindow = capacityField(entry.contextWindow, entry.context_window, entry.context_length, entry.max_input_tokens, limit.context)
      const maxTokens = capacityField(entry.maxOutputTokens, entry.max_output_tokens, entry.maxTokens, entry.max_tokens, entry.output_tokens, limit.output, top.max_completion_tokens)
      const m = { id: rawId }
      if (name && name !== rawId) m.name = name
      if (contextWindow !== undefined) m.contextWindow = contextWindow
      if (maxTokens !== undefined) m.maxTokens = maxTokens
      models.push(m)
    }
    return models
  }

  /** 用三源目录补全候选模型（仅补缺）。 */
  async function enrichModelsList(models, baseURL, api, options) {
    const opts = options || {}
    if (opts.enrich === false || !Array.isArray(models) || !models.length) {
      return { models: models || [], catalogApplied: false, catalogError: '', enrichedCount: 0, sourcesUsed: [] }
    }
    try {
      const catalog = await getCatalog({ force: !!opts.forceCatalog, queryIds: models.map((m) => m && m.id).filter(Boolean) })
      let enrichedCount = 0
      const next = models.map((m) => {
        if (!isPlainObject(m) || !m.id) return m
        const matched = matchModel(m.id, catalog, { baseURL: baseURL, api: api })
        if (!matched) return m
        const out = Object.assign({}, m)
        let filled = 0
        if (isMissingValue(out.name) && matched.name) { out.name = matched.name; filled += 1 }
        if (isMissingValue(out.contextWindow) && positiveInteger(matched.contextWindow)) { out.contextWindow = positiveInteger(matched.contextWindow); filled += 1 }
        if (isMissingValue(out.maxTokens) && positiveInteger(matched.maxTokens)) { out.maxTokens = positiveInteger(matched.maxTokens); filled += 1 }
        if (isMissingValue(out.input) && matched.inputModalities.indexOf('image') >= 0) { out.input = ['text', 'image']; filled += 1 }
        if (!Object.prototype.hasOwnProperty.call(out, 'reasoningEfforts')) {
          const efforts = buildEfforts(matched)
          if (efforts && Object.keys(efforts).length) { out.reasoningEfforts = efforts; filled += 1 }
        }
        if (filled) enrichedCount += 1
        return out
      })
      return {
        models: next,
        catalogApplied: true,
        catalogError: '',
        enrichedCount: enrichedCount,
        sourcesUsed: catalog.sourcesUsed.slice(),
        sourceErrors: catalog.sourceErrors,
      }
    } catch (e) {
      return {
        models: models,
        catalogApplied: false,
        catalogError: e && e.message ? e.message : String(e),
        enrichedCount: 0,
        sourcesUsed: [],
      }
    }
  }

  /** 官方「获取模型」同款：按草稿 baseURL/api/apiKey 探测端点 /models，再用三源补全。
   * 传入 provider 时（B7）：baseURL/api/自定义请求头缺省回落到该渠道的已存配置，
   *  API Key 未显式给出时解析渠道凭据——否则"手动添加模型"面板的探测对受保护
   *  网关永远 401，而"更新模型列表"却能过（两条路径能力不一致）。 */
  async function discoverModels(args) {
    // ★ B7：带 provider 的探测复用渠道配置（凭据/请求头/baseURL）
    const providerRef = str(args && args.provider, '').trim()
    let profile = {}
    if (providerRef) {
      profile = providerProfile(providerRef)
      if (!Object.keys(profile).length) throw new Error('渠道不存在: ' + providerRef)
    }
    const hasProfile = Object.keys(profile).length > 0
    let baseURL = validateProviderBaseURL(args && args.baseURL)
    if (!baseURL && hasProfile) baseURL = validateProviderBaseURL(profile.baseURL)
    if (!baseURL) throw new Error('缺少 baseURL')
    // ★ L2（三轮）：空串 api 视为"未提供"——str('', fallback) 会返回空串并让
    //   下面的兜底把它改成 openai-completions，从而用错误协议探测一个
    //   anthropic-messages 渠道。显式传 api 必须传非空值。
    const apiArg = str(args && args.api, '').trim()
    const api = apiArg || (hasProfile ? str(profile.api, '') : '').trim() || 'openai-completions'
    if (PROTOCOLS.indexOf(api) < 0) throw new Error('不支持的 API 协议: ' + api)
    if (LISTABLE_PROTOCOLS.indexOf(api) < 0) {
      throw new Error('协议「' + api + '」不支持自动获取模型列表，请手填模型 id')
    }
    const apiKey = await resolveProviderApiKey(hasProfile ? profile : null, args && args.apiKey)
    const url = listingUrl(baseURL)
    const headers = {}
    // ★ 审查修正：已有渠道的探测必须带上该渠道的自定义请求头（官方同款），
    //   否则被 X-Title / X-Gateway-Key 之类网关头保护的端点永远 401/403。
    //   显式传入 args.headers 优先（refresh-models 走这条），否则回落渠道已存 headers。
    const headersSource = (args && args.headers !== undefined) ? args.headers : (hasProfile ? profile.headers : null)
    for (const name of Object.keys(customHeadersOf(headersSource))) headers[name] = headersSource[name]
    if (apiKey) headers.authorization = 'Bearer ' + apiKey
    let text
    try {
      text = await httpGetText(url, headers, DISCOVER_TIMEOUT_MS, MAX_DISCOVER_BYTES, 0)
    } catch (e) {
      const msg = e && e.message ? e.message : String(e)
      if (/请求超时|总截止时间|端点返回|API Key|字节限制|重定向|代理/.test(msg)) throw e
      throw new Error('无法访问模型列表: ' + msg)
    }
    let body
    try { body = JSON.parse(text) } catch (_) { throw new Error('端点未返回 JSON 模型列表') }
    let models = readOpenAiListing(body)
    if (!models.length) throw new Error('端点未返回可用模型（列表为空）')
    const enriched = await enrichModelsList(models, baseURL, api, { enrich: args && args.enrich === false ? false : true })
    models = enriched.models
    let message = '已获取 ' + models.length + ' 个模型'
    if (enriched.catalogApplied && enriched.enrichedCount) message += '，目录补全 ' + enriched.enrichedCount + ' 个'
    else if (enriched.catalogError) message += '（目录不可用：' + clipText(enriched.catalogError, 80) + '）'
    return {
      ok: true,
      url: url,
      api: api,
      models: models,
      count: models.length,
      catalogApplied: enriched.catalogApplied,
      catalogError: enriched.catalogError || undefined,
      enrichedCount: enriched.enrichedCount,
      sourcesUsed: enriched.sourcesUsed || [],
      message: message,
    }
  }

  /** 对已配置渠道拉 /models，标记本地已有 / 新增。 */
  async function refreshProviderModels(args) {
    const provider = str(args && args.provider, '').trim()
    if (!provider) throw new Error('缺少 provider')
    const profile = providerProfile(provider)
    if (!Object.keys(profile).length) throw new Error('渠道不存在: ' + provider)
    const baseURL = str(profile.baseURL, '').trim()
    if (!baseURL) throw new Error('该渠道未配置 baseURL，无法更新模型列表')
    const api = str(profile.api, 'openai-completions').trim() || 'openai-completions'
    if (LISTABLE_PROTOCOLS.indexOf(api) < 0) throw new Error('协议「' + api + '」不支持自动获取模型列表')

    let apiKey = ''
    if (args && args.apiKey !== undefined && args.apiKey !== null && String(args.apiKey).length) {
      apiKey = validateApiKeyDraft(args.apiKey)
    } else {
      apiKey = await resolveProviderApiKey(profile, '')
    }

    const discovered = await discoverModels({
      baseURL: baseURL,
      api: api,
      apiKey: apiKey,
      enrich: args && args.enrich === false ? false : true,
      // 复用该渠道已保存的自定义请求头（保留名会被过滤）
      headers: profile.headers,
    })

    const existing = getRawModels(provider)
    const existingSet = Object.create(null)
    for (const m of existing) if (m && m.id) existingSet[String(m.id).toLowerCase()] = true

    const candidates = []
    let newCount = 0
    let knownCount = 0
    for (const m of (discovered.models || [])) {
      if (!m || !m.id) continue
      const isNew = !existingSet[String(m.id).toLowerCase()]
      if (isNew) newCount += 1
      else knownCount += 1
      candidates.push(Object.assign({}, m, { isNew: isNew }))
    }
    return {
      ok: true,
      provider: provider,
      baseURL: baseURL,
      api: api,
      url: discovered.url,
      existingCount: existing.length,
      count: candidates.length,
      newCount: newCount,
      knownCount: knownCount,
      candidates: candidates,
      catalogApplied: discovered.catalogApplied,
      catalogError: discovered.catalogError,
      enrichedCount: discovered.enrichedCount,
      sourcesUsed: discovered.sourcesUsed || [],
      message: newCount
        ? ('发现 ' + candidates.length + ' 个模型，其中新增 ' + newCount + ' 个（已有 ' + knownCount + '）')
        : ('发现 ' + candidates.length + ' 个模型，无新增（本地已有 ' + existing.length + '）'),
    }
  }

  /** 把勾选 / 手填的模型追加进已有渠道（已有 id 保留本地配置）。 */
  async function addProviderModels(args) {
    const provider = str(args && args.provider, '').trim()
    if (!provider) throw new Error('缺少 provider')
    if (!ctx.settings.writable) throw new Error('settings 只读')
    const profile = providerProfile(provider)
    if (!Object.keys(profile).length) throw new Error('渠道不存在: ' + provider)

    const incoming = normalizeCreateModels(args && args.models)
    // ★ B6：已有条目原样透传，新增条目走 normalizeCreateModels 的白名单校验
    const existing = getRawModelsEntries(provider)
    // O2（三轮补全）：auto 配置读一次复用，避免逐模型 readAuto → settings.get
    const autoCfg = readAuto()
    const byId = Object.create(null)
    const next = []
    for (const m of existing) {
      if (!m || !m.id) continue
      byId[String(m.id).toLowerCase()] = true
      next.push(m)
    }
    const added = []
    for (const m of incoming) {
      const key = String(m.id).toLowerCase()
      if (byId[key]) continue
      byId[key] = true
      next.push(m)
      added.push(m.id)
    }
    if (!added.length) {
      return {
        ok: true,
        skipped: true,
        provider: provider,
        addedCount: 0,
        added: [],
        localCount: existing.length,
        message: '没有可新增的模型（所选 id 均已存在）',
        providers: listProviders(),
      }
    }
    const via = await writeModels(provider, next)
    return {
      ok: true,
      skipped: false,
      provider: provider,
      addedCount: added.length,
      added: added,
      localCount: next.length,
      via: via,
      message: '已新增 ' + added.length + ' 个模型到 ' + provider + '（via ' + via + '）',
      providers: listProviders(),
      models: next.map((m) => modelView(m, autoCfg)),
    }
  }

  function normalizeCreateModels(raw) {
    if (!Array.isArray(raw) || !raw.length) throw new Error('至少需要一个模型')
    const out = []
    const seen = Object.create(null)
    for (let i = 0; i < raw.length; i++) {
      const entry = raw[i]
      // ★ 保留用户/端点给出的原始大小写（网关 id 可能大小写敏感）；去重用小写键
      const id = (entry && typeof entry === 'object' ? str(entry.id, '').trim() : str(entry, '').trim())
      if (!id) throw new Error('模型 ' + (i + 1) + ' 缺少 id')
      if (id.length > MAX_MODEL_ID_LENGTH) throw new Error('模型 ' + (i + 1) + ' id 过长')
      // ★ B3：与 delete-model 同口径的字符集白名单——此前 add 路径只查长度，
      //   带引号/换行/控制字符的 id 能一路走到写盘（README §7 声称有白名单）。
      if (!isSafeModelId(id)) throw new Error('模型 ' + (i + 1) + ' id 含非法字符')
      const dedupe = id.toLowerCase()
      if (seen[dedupe]) throw new Error('模型 id 重复: ' + id)
      seen[dedupe] = true
      const m = { id: id }
      if (isPlainObject(entry)) {
        if (typeof entry.name === 'string' && entry.name.trim()) m.name = entry.name.trim()
        if (positiveInteger(entry.contextWindow) !== undefined) m.contextWindow = positiveInteger(entry.contextWindow)
        if (positiveInteger(entry.maxTokens) !== undefined) m.maxTokens = positiveInteger(entry.maxTokens)
        if (entry.vision === true) m.input = ['text', 'image']
        else if (Array.isArray(entry.input)) m.input = entry.input
        if (entry.reasoningEfforts !== undefined) m.reasoningEfforts = entry.reasoningEfforts
        if (isPlainObject(entry.compat)) m.compat = entry.compat
      }
      const cloned = cloneModel(m)
      if (!cloned) throw new Error('模型 ' + (i + 1) + ' 无效')
      out.push(cloned)
    }
    return out
  }

  /** 三源补全（可预览 / 写回）。 */
  async function enrichProviderModels(args) {
    const provider = str(args && args.provider, '').trim()
    if (!provider) throw new Error('缺少 provider')
    const profile = providerProfile(provider)
    if (!Object.keys(profile).length) throw new Error('渠道不存在: ' + provider)
    const baseURL = str(profile.baseURL, '')
    const api = str(profile.api, 'openai-completions') || 'openai-completions'
    const overwrite = !!(args && args.overwrite === true)
    // ★ L5（三轮）：改名 applyNow——原变量名遮蔽模块级导出的 apply(ctx)，阅读易混
    const applyNow = args && args.apply === false ? false : true
    // ★ B6：整表写回用透传克隆——未命中目录的条目原样保留（含未知/未来字段）
    const existing = getRawModelsEntries(provider)
    if (!existing.length) throw new Error('当前渠道没有模型')
    // O2（三轮补全）：auto 配置读一次复用，避免逐模型 readAuto → settings.get
    const autoCfg = readAuto()

    let catalog
    try {
      catalog = await getCatalog({
        force: !!(args && (args.forceCatalog === true)),
        queryIds: existing.map((m) => m.id),
        only: Array.isArray(args && args.sources) && args.sources.length ? args.sources : undefined,
      })
    } catch (e) {
      throw new Error('无法加载目录：' + (e && e.message ? e.message : String(e)))
    }

    const changes = []
    const unmatched = []
    const nextModels = []
    let hitCount = 0
    for (const m of existing) {
      // local 已是透传克隆（getRawModelsEntries）；命中目录时 applyRemoteToLocal
      // 以它为基座做"仅补缺/覆盖"的已知字段写入，未知字段不受影响。
      const local = m
      const matched = matchModel(local.id, catalog, { baseURL: baseURL, api: api })
      if (!matched) {
        unmatched.push(local.id)
        nextModels.push(local)
        continue
      }
      hitCount += 1
      const remote = {}
      if (matched.name) remote.name = matched.name
      if (positiveInteger(matched.contextWindow)) remote.contextWindow = positiveInteger(matched.contextWindow)
      if (positiveInteger(matched.maxTokens)) remote.maxTokens = positiveInteger(matched.maxTokens)
      if (matched.inputModalities.indexOf('image') >= 0) remote.input = ['text', 'image']
      const efforts = buildEfforts(matched)
      if (efforts === false) remote.reasoningEfforts = false
      else if (efforts && Object.keys(efforts).length) remote.reasoningEfforts = efforts

      const applied = applyRemoteToLocal(local, remote, overwrite, true)
      nextModels.push(applied.model)
      if (applied.changed) {
        changes.push({
          id: local.id,
          notes: applied.notes,
          summary: effortSummary(applied.model),
          vision: hasVision(applied.model),
          contextWindow: positiveInteger(applied.model.contextWindow) || 0,
          maxTokens: positiveInteger(applied.model.maxTokens) || 0,
          name: str(applied.model.name, ''),
          source: matched.source,
        })
      }
    }

    let via = ''
    if (applyNow && changes.length) via = await writeModels(provider, nextModels)

    const sampleIds = existing.slice(0, 5).map((m) => m.id).filter(Boolean)
    const sourcesUsed = catalog.sourcesUsed.slice()
    let message = ''
    if (changes.length) {
      message = (apply ? '已从目录写回 ' : '可从目录补全 ') + changes.length + ' 个模型（命中 ' + hitCount + '/' + existing.length + '）'
    } else if (hitCount) {
      message = '目录命中 ' + hitCount + ' 个，但无需补全（已有字段' + (overwrite ? '' : '，可开覆盖') + '）'
    } else {
      message = '未命中任何目录源。多半是该网关的私有模型 id，建议手工填写参数，或把模型 id 改成与公开目录一致的名字。'
        + (sampleIds.length ? '（本地示例：' + sampleIds.join(', ') + '）' : '')
    }
    const sourceWarnings = []
    for (const key of Object.keys(catalog.sourceErrors || {})) {
      sourceWarnings.push(CATALOG_SOURCE_LABEL[key] + '：' + catalog.sourceErrors[key])
    }
    return {
      ok: true,
      provider: provider,
      hitCount: hitCount,
      changeCount: changes.length,
      localCount: existing.length,
      applied: applyNow && changes.length > 0,
      via: via || undefined,
      changes: changes,
      // 未命中目录的本地 id（§12.5 预览表的「— 未命中 —」行）
      unmatched: unmatched,
      unmatchedCount: unmatched.length,
      sampleIds: sampleIds,
      sourcesUsed: sourcesUsed,
      sourceErrors: catalog.sourceErrors || {},
      sourceWarnings: sourceWarnings,
      models: applyNow ? nextModels.map((m) => modelView(m, autoCfg)) : undefined,
      message: message,
    }
  }

  /* ───────────── 端点：保存 / 删除 / 设置 ───────────── */

  async function saveFromEditor(provider, modelId, editor, messagePrefix) {
    const profile = providerProfile(provider)
    if (!Object.keys(profile).length) throw new Error('渠道不存在: ' + provider)
    // ★ B5：compat 校验用**真实** api（缺省 → 空字段表 → 空草稿=不动、非空=明确报错），
    //   不再兜底成 openai-completions——兜底会让"无 api 渠道"的 compat 按错误协议校验。
    const api = str(profile.api, '')
    // ★ B6：整表写回用透传克隆——其它条目（与本条目自身）的未知/未来字段原样保留
    const models = getRawModelsEntries(provider)
    const idx = findModelIndex(models, modelId)
    if (idx < 0) throw new Error('模型不存在或已删除: ' + modelId)
    const norm = normalizeEditor(editor, api)
    const next = Object.assign({}, models[idx])
    // ★ 仅在编辑器明确表达了推理档位意图时才写该键（见 normalizeEditor 的三态说明）
    if (norm.reasoningPresent) next.reasoningEfforts = norm.reasoningEfforts
    if (norm.vision === true) next.input = ['text', 'image']
    else delete next.input
    if (norm.clearContextWindow) delete next.contextWindow
    else if (norm.contextWindow !== undefined) next.contextWindow = norm.contextWindow
    if (norm.clearMaxTokens) delete next.maxTokens
    else if (norm.maxTokens !== undefined) next.maxTokens = norm.maxTokens
    if (norm.clearName) delete next.name
    else if (norm.name !== undefined) next.name = norm.name
    if (norm.compatPresent) {
      if (norm.compat === undefined) delete next.compat
      else {
        // ★ B6：已知字段以本次校验结果为准；表外（未来版本新增的）compat 字段
        //   从原条目原样带回，不在一次无关编辑中被抹掉。
        // ★ M1（三轮）："已知"必须按**当前协议**的 offer 表判定，不能用全协议
        //   并集 COMPAT_ALL_FIELDS——否则手写在 openai-completions 模型上的
        //   anthropic 表字段（如 supportsTemperature）会被误判为"本次提交已
        //   管辖"而遭静默清除；客户端只提交本协议字段，永远覆盖不到它。
        const compat = Object.assign({}, norm.compat)
        const baseCompat = isPlainObject(next.compat) ? next.compat : {}
        const offer = COMPAT_OFFER[api]
        for (const key of Object.keys(baseCompat)) {
          if ((offer && offer.has(key)) || compat[key] !== undefined) continue
          compat[key] = baseCompat[key]
        }
        next.compat = compat
      }
    }
    models[idx] = next
    const via = await writeModels(provider, models)
    return {
      ok: true,
      provider: provider,
      model: modelView(next),
      via: via,
      providers: listProviders(),
      message: (messagePrefix || '已保存 ') + modelId + '（via ' + via + '）',
    }
  }

  /**
   * 编辑器归一化。
   * ★ compat 按 provider.api 的 offer gate 过滤校验：协议不支持的字段**报错**
   *   （不是静默丢弃），避免"保存成功但模型解析失败"。
   */
  function normalizeEditor(editor, api) {
    if (!isPlainObject(editor)) throw new Error('无效编辑数据')
    const vision = editor.vision === true
    // ★ L6（三轮）：客户端超长数字串会解析成 Infinity，positiveInteger 把它当
    //   "未填"处理 → 既不写入也不清除，旧值被静默保留（用户以为改成功了）。
    if (typeof editor.contextWindow === 'number' && !Number.isFinite(editor.contextWindow)) throw new Error('contextWindow 数值超出范围')
    if (typeof editor.maxTokens === 'number' && !Number.isFinite(editor.maxTokens)) throw new Error('maxTokens 数值超出范围')
    const contextWindow = positiveInteger(editor.contextWindow)
    const maxTokens = positiveInteger(editor.maxTokens)
    const clearContextWindow = editor.clearContextWindow === true
    const clearMaxTokens = editor.clearMaxTokens === true
    const nameRaw = typeof editor.name === 'string' ? editor.name.trim() : undefined
    if (nameRaw !== undefined && nameRaw.length > MAX_MODEL_ID_LENGTH) throw new Error('显示名超过 ' + MAX_MODEL_ID_LENGTH + ' 字符')
    const compatNorm = normalizeCompatInput(editor.compat, api)

    const base = {
      vision: vision,
      contextWindow: contextWindow,
      maxTokens: maxTokens,
      clearContextWindow: clearContextWindow,
      clearMaxTokens: clearMaxTokens,
      name: nameRaw || undefined,
      clearName: nameRaw === '',
      compatPresent: compatNorm.present,
      compat: compatNorm.value,
    }
    if (editor.disabled === true) return Object.assign(base, { reasoningPresent: true, reasoningEfforts: false })
    const efforts = {}
    let positive = 0
    for (const row of (Array.isArray(editor.levels) ? editor.levels : [])) {
      if (!row || row.enabled !== true) continue
      const level = str(row.level, '')
      if (LEVELS.indexOf(level) < 0) continue
      if (level === 'off') {
        efforts.off = null
      } else {
        const wire = str(row.wire, level).trim()
        if (!wire) throw new Error(level + ' 需要 wire 值')
        if (wire.length > 64) throw new Error(level + ' 的 wire 值过长')
        efforts[level] = wire
        positive += 1
      }
    }
    // ★ 审查修正：既没勾「关闭推理」也没启用任何非 off 档 ⇒ **不动该字段**。
    //
    // 之前这里返回 `reasoningEfforts: false`，导致"模型本来『未设置』（沿用安装目录的
    // 能力）"的条目在用户只是改个显示名时被静默改成"关闭推理"——这是能力降级，
    // 而且不报错。真正的"关闭推理"意图由 `disabled: true` 表达（UI 的所有档位 chip
    // 全空时会派生出 disabled=true）。
    if (!Object.keys(efforts).length) return Object.assign(base, { reasoningPresent: false, reasoningEfforts: undefined })
    if (!positive) throw new Error('只启用 off 档没有意义：请勾选至少一个非 off 档，或改用「关闭推理」')
    return Object.assign(base, { reasoningPresent: true, reasoningEfforts: efforts })
  }

  async function saveModel(args) {
    const provider = str(args && args.provider, '').trim()
    // ★ 不 lower 化：id 是大小写敏感的网关标识，定位靠 findModelIndex() 的不敏感比较
    const modelId = str(args && args.modelId, '').trim()
    if (!provider || !modelId) throw new Error('缺少 provider/modelId')
    if (modelId.length > MAX_MODEL_ID_LENGTH) throw new Error('modelId 超过 ' + MAX_MODEL_ID_LENGTH + ' 字符')
    return saveFromEditor(provider, modelId, args && args.editor, '已保存 ')
  }

  async function applyPreset(args) {
    const provider = str(args && args.provider, '').trim()
    const modelId = str(args && args.modelId, '').trim()
    const presetId = str(args && args.presetId, '')
    const preset = PRESETS[presetId]
    if (!preset) throw new Error('未知预设')
    if (!provider || !modelId) throw new Error('缺少 provider/modelId')
    const current = getRawModels(provider).find((m) => m && sameModelId(m.id, modelId))
    const vision = (typeof preset.vision === 'boolean') ? preset.vision : (current ? hasVision(current) : false)
    const editor = {
      disabled: preset.efforts === false,
      levels: [],
      vision: vision,
      name: current ? str(current.name, '') : '',
    }
    if (preset.efforts && preset.efforts !== false) {
      for (const level of LEVELS) {
        if (!Object.prototype.hasOwnProperty.call(preset.efforts, level)) editor.levels.push({ level: level, enabled: false, wire: level === 'off' ? '' : level, wireNull: level === 'off' })
        else if (preset.efforts[level] === null) editor.levels.push({ level: level, enabled: true, wire: '', wireNull: true })
        else editor.levels.push({ level: level, enabled: true, wire: String(preset.efforts[level]), wireNull: false })
      }
    } else {
      editor.levels = LEVELS.map((level) => ({ level: level, enabled: false, wire: level === 'off' ? '' : level, wireNull: level === 'off' }))
    }
    if (current && current.compat !== undefined) editor.compat = JSON.parse(JSON.stringify(current.compat))
    return saveFromEditor(provider, modelId, editor, '已应用预设「' + preset.label + '」到 ')
  }

  /** 删除单个模型条目（幂等性：不存在 → 404 语义的错误）。 */
  async function deleteModel(args) {
    const provider = str(args && args.provider, '').trim()
    const modelId = str(args && args.modelId, '').trim()
    if (!provider) throw new Error('缺少 provider')
    if (!modelId || modelId.length > MAX_MODEL_ID_LENGTH) throw new Error('modelId 长度非法（1..' + MAX_MODEL_ID_LENGTH + '）')
    if (!ctx.settings.writable) throw new Error('settings 只读')
    const profile = providerProfile(provider)
    if (!Object.keys(profile).length) throw new Error('渠道不存在: ' + provider)
    const models = getRawModelsEntries(provider)
    const idx = findModelIndex(models, modelId)
    if (idx < 0) {
      // ★ B4：查无此条时才回落到入参字符集校验。官方「模型」页/手写 settings 可以
      //   存入本插件字符集之外的 id（如中文 id）——它们必须能被删除；id 在删除
      //   里只用于查表定位，先查后校验对已存在的条目零伤害，查不到时仍尽早报 400。
      if (!isSafeModelId(modelId)) {
        const bad = new Error('modelId 含非法字符')
        bad.statusCode = 400
        throw bad
      }
      const err = new Error('模型不存在或已删除: ' + modelId)
      err.statusCode = 404
      throw err
    }
    const next = models.filter((m, i) => i !== idx)
    const via = await writeModels(provider, next)
    // O2（三轮补全）：auto 配置读一次复用，避免逐模型 readAuto → settings.get
    const autoCfg = readAuto()
    const warnings = []
    if (!next.length) warnings.push('该渠道已无模型条目')
    return {
      ok: true,
      provider: provider,
      remaining: next.length,
      removed: modelId,
      via: via,
      warnings: warnings,
      providers: listProviders(),
      models: next.map((m) => modelView(m, autoCfg)),
      message: '已删除 ' + modelId + '（剩余 ' + next.length + ' 个模型，via ' + via + '）',
    }
  }

  /** 渠道级高级设置（白名单字段写入）。 */
  async function saveProviderAdvanced(args) {
    const provider = str(args && args.provider, '').trim()
    if (!provider) throw new Error('缺少 provider')
    if (!ctx.settings.writable) throw new Error('settings 只读')
    const profile = providerProfile(provider)
    if (!Object.keys(profile).length) throw new Error('渠道不存在: ' + provider)
    // ★ B5：与 saveFromEditor 同口径——compat 校验用真实 api，无 api 即空表
    const api = str(profile.api, '')

    const allowed = ['compat', 'retryPolicy', 'defaultContextWindow', 'defaultMaxTokens', 'defaultInput', 'headers']
    const sets = new Map()
    const clears = []
    const warnings = []
    const applied = {}
    let touched = 0

    for (const key of Object.keys(args || {})) {
      if (key === 'provider') continue
      if (allowed.indexOf(key) < 0) throw new Error('不支持的字段: ' + key)
    }

    if (Object.prototype.hasOwnProperty.call(args, 'compat')) {
      touched += 1
      const norm = normalizeCompatInput(args.compat, api)
      if (norm.value === undefined) { clears.push('compat'); applied.compat = null }
      else { sets.set('compat', norm.value); applied.compat = norm.value }
    }

    if (Object.prototype.hasOwnProperty.call(args, 'retryPolicy')) {
      touched += 1
      const norm = normalizeRetryPolicyInput(args.retryPolicy)
      if (norm.value === undefined) { clears.push('retryPolicy'); applied.retryPolicy = null }
      else {
        // ★ 审查修正：本卡片只管理 mode / maxRetries，手写的 `retryableCodes` / `backoff`
        //   必须原样保留——否则在 UI 里点一次保存就把它们抹掉了（`retryPolicy` 是整键替换）。
        const prevPolicy = asObject(asObject(asObject(getUserLayer().providers)[provider]).retryPolicy)
        const merged = Object.assign({}, prevPolicy, norm.value)
        sets.set('retryPolicy', merged)
        applied.retryPolicy = merged
        if (Object.keys(prevPolicy).some((k) => k !== 'mode' && k !== 'maxRetries')) {
          warnings.push('已保留手写的 retryableCodes / backoff（本卡片不管理它们）')
        }
      }
    }

    for (const field of ['defaultContextWindow', 'defaultMaxTokens']) {
      if (!Object.prototype.hasOwnProperty.call(args, field)) continue
      touched += 1
      const raw = args[field]
      if (raw === null) { clears.push(field); applied[field] = null; continue }
      const value = positiveInteger(raw)
      if (value === undefined) throw new Error(field + ' 须为正整数或 null')
      sets.set(field, value)
      applied[field] = value
    }

    if (Object.prototype.hasOwnProperty.call(args, 'defaultInput')) {
      touched += 1
      const norm = normalizeInputModalities(args.defaultInput)
      if (norm.value === undefined) { clears.push('defaultInput'); applied.defaultInput = null }
      else { sets.set('defaultInput', norm.value); applied.defaultInput = norm.value }
    }

    if (Object.prototype.hasOwnProperty.call(args, 'headers')) {
      touched += 1
      const norm = normalizeHeadersInput(args.headers)
      for (const w of norm.warnings) warnings.push(w)
      if (norm.value === undefined) { clears.push('headers'); applied.headers = null }
      else { sets.set('headers', norm.value); applied.headers = norm.value }
    }

    if (!touched) throw new Error('没有可保存的字段')

    const result = await writeProviderFields(provider, sets, clears)
    for (const w of result.warnings || []) warnings.push(w)
    return {
      ok: true,
      provider: provider,
      applied: applied,
      cleared: clears.slice(),
      warnings: warnings,
      via: result.via,
      providers: listProviders(),
      message: '已保存 ' + provider + ' 的渠道设置（via ' + result.via + '）',
    }
  }

  /** 保存三源目录地址与启用状态。 */
  async function saveSources(args) {
    if (!isPlainObject(args)) throw new Error('入参需要对象')
    const incoming = args.sources
    if (incoming !== undefined && !isPlainObject(incoming)) throw new Error('sources 需要对象')
    const current = readSourceConfig(readPrefs())
    const next = {
      modelsDev: { url: current.modelsDev.url, enabled: current.modelsDev.enabled },
      litellm: { url: current.litellm.url, enabled: current.litellm.enabled },
      openrouter: { url: current.openrouter.url, enabled: current.openrouter.enabled },
    }
    const warnings = []
    if (isPlainObject(incoming)) {
      for (const key of Object.keys(incoming)) {
        if (CATALOG_SOURCE_ORDER.indexOf(key) < 0) throw new Error('未知目录源: ' + key)
        const entry = incoming[key]
        if (!isPlainObject(entry)) throw new Error('目录源 ' + key + ' 需要对象')
        if (Object.prototype.hasOwnProperty.call(entry, 'url')) {
          const raw = str(entry.url, '').trim()
          if (!raw) {
            if (key === 'modelsDev') throw new Error('models.dev 地址不可为空')
            next[key].url = current[key].url
            next[key].enabled = false
            continue
          }
          next[key].url = validateCatalogUrl(raw)
        }
        if (Object.prototype.hasOwnProperty.call(entry, 'enabled')) {
          if (typeof entry.enabled !== 'boolean') throw new Error('目录源 ' + key + ' 的 enabled 需要布尔值')
          next[key].enabled = entry.enabled
        }
      }
    }
    if (!next.modelsDev.enabled) { next.modelsDev.enabled = true; warnings.push('models.dev 是最低限度可用的目录源，已保持启用') }
    if (!next.litellm.enabled && !next.openrouter.enabled) warnings.push('LiteLLM 与 OpenRouter 均已关闭；私有网关 id 的命中率会降到 models.dev 的水平')
    const prefs = await saveSuitePrefs({
      modelsDevUrl: next.modelsDev.url,
      litellmUrl: next.litellm.url,
      openrouterUrl: next.openrouter.url,
      sources: next,
    })
    // ★ 审查修正：地址/开关变了 ⇒ 立刻作废聚合快照，别让改动被 30 分钟 TTL 挡住。
    //   单源缓存按 URL 分键，无需清理（新 URL 自然要重新拉）。
    catalogSnapshot = null
    return { ok: true, sources: next, prefs: { modelsDevUrl: prefs.modelsDevUrl }, warnings: warnings, message: '已保存目录源' }
  }

  /** 保存自动配置开关（热生效）。 */
  async function saveAutoConfig(args) {
    if (!isPlainObject(args)) throw new Error('入参需要对象')
    const incoming = args.auto === undefined ? args : args.auto
    if (!isPlainObject(incoming)) throw new Error('auto 需要对象')
    const current = readAuto()
    const auto = {
      enabled: Object.prototype.hasOwnProperty.call(incoming, 'enabled') ? incoming.enabled === true : current.enabled,
      persistOnSave: Object.prototype.hasOwnProperty.call(incoming, 'persistOnSave') ? incoming.persistOnSave === true : current.persistOnSave,
      fields: {
        contextWindow: current.fields.contextWindow,
        maxTokens: current.fields.maxTokens,
        input: current.fields.input,
        reasoningEfforts: current.fields.reasoningEfforts,
      },
      includeCatalogRoutes: Object.prototype.hasOwnProperty.call(incoming, 'includeCatalogRoutes')
        ? incoming.includeCatalogRoutes === true
        : current.includeCatalogRoutes,
    }
    const fields = isPlainObject(incoming.fields) ? incoming.fields : null
    if (fields) {
      for (const key of Object.keys(auto.fields)) {
        if (Object.prototype.hasOwnProperty.call(fields, key)) auto.fields[key] = fields[key] === true
      }
    }
    const warnings = []
    if (auto.includeCatalogRoutes) warnings.push('已放开到内置目录渠道：内置渠道的模型条目也会被自动补缺')
    await saveSuitePrefs({ auto: auto })
    return { ok: true, auto: auto, warnings: warnings, message: '已保存自动配置' }
  }

  /** 真调一次模型 API。 */
  async function testModel(args) {
    const provider = str(args && args.provider, '').trim()
    const modelId = str(args && args.modelId, '').trim()
    if (!provider) throw new Error('缺少 provider')
    if (!modelId) throw new Error('缺少 modelId')
    if (modelId.length > MAX_MODEL_ID_LENGTH) throw new Error('modelId 过长')

    const profile = providerProfile(provider)
    if (!Object.keys(profile).length) throw new Error('渠道不存在: ' + provider)
    const baseURL = str(profile.baseURL, '').trim()
    if (!baseURL) throw new Error('该渠道未配置 baseURL，无法测试')
    validateProviderBaseURL(baseURL)

    const api = str(profile.api, 'openai-completions').trim() || 'openai-completions'
    if (PROTOCOLS.indexOf(api) < 0) throw new Error('不支持的 API 协议: ' + api)

    // 路由级 compat 打底、模型级覆盖（与 pi-ai 的 resolveModelCompat 同序）。
    // 测试请求必须尊重 maxTokensField / supportsReasoningEffort / thinkingFormat，
    // 否则会出现"真实会话能跑、测试页 400"的假故障。
    const modelEntry = getRawModels(provider).find((m) => m && sameModelId(m.id, modelId))
    const compat = Object.assign({}, asObject(profile.compat), asObject(modelEntry && modelEntry.compat))
    const maxTokensField = compat.maxTokensField === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens'
    const effortAllowed = compat.supportsReasoningEffort !== false
    const thinkingFormat = str(compat.thinkingFormat, '')

    let prompt = str(args && args.prompt, DEFAULT_TEST_PROMPT).trim() || DEFAULT_TEST_PROMPT
    if (prompt.length > 8000) throw new Error('测试提示词最长 8000 字符')
    let maxTokens = Number(args && args.maxTokens)
    if (!Number.isFinite(maxTokens) || maxTokens <= 0) maxTokens = DEFAULT_TEST_MAX_TOKENS
    maxTokens = Math.min(32768, Math.max(64, Math.floor(maxTokens)))

    const effort = str(args && args.effort, '').trim()
    if (effort && LEVELS.indexOf(effort) < 0) throw new Error('无效思考强度: ' + effort)

    const apiKey = await resolveProviderApiKey(profile, args && args.apiKey)
    const started = Date.now()

    let url = ''
    const headers = { 'content-type': 'application/json', accept: 'application/json' }
    let bodyObj = null
    // ★ L1（三轮）：是否真的把 effort 编码进了请求体（chat-template / baseten
    //   依赖用户自配的 $var kwargs、anthropic 走 budget ——测试无法可靠构造，
    //   如实报告 false，客户端不再显示误导性的「已用 X」）。
    let effortApplied = false
    const effortRequested = !!(effort && effort !== 'off' && effortAllowed)
    // pi-ai 只在 supportsReasoningEffort 显式为 true 时才附带 reasoning_effort 子参数
    const effortSubParamAllowed = compat.supportsReasoningEffort === true

    if (api === 'openai-completions') {
      url = joinEndpoint(baseURL, 'chat/completions')
      // ★ M4：不再硬编码固定温度字段——o1/o3 等"仅默认温度"端点会因该字段直接 400，
      //   制造"真实会话能跑、测试页失败"的假故障（与 maxTokensField 同类问题）。
      bodyObj = { model: modelId, messages: [{ role: 'user', content: prompt }], stream: false }
      bodyObj[maxTokensField] = maxTokens
      if (effortRequested) {
        // ★ L1（三轮）：按 pi-ai openai-completions 的 thinkingFormat wire 表逐格式
        //   编码（此前只特判 openrouter/deepseek，其余一律 reasoning_effort——
        //   qwen/zai/together 等格式的端点会因未知字段 400，制造假故障）。
        if (thinkingFormat === 'openrouter' || thinkingFormat === 'ant-ling') {
          bodyObj.reasoning = { effort: effort }
          effortApplied = true
        } else if (thinkingFormat === 'deepseek') {
          bodyObj.thinking = { type: 'enabled' }
          if (effortSubParamAllowed) bodyObj.reasoning_effort = effort
          effortApplied = true
        } else if (thinkingFormat === 'together') {
          bodyObj.reasoning = { enabled: true }
          if (effortSubParamAllowed) bodyObj.reasoning_effort = effort
          effortApplied = true
        } else if (thinkingFormat === 'zai') {
          bodyObj.thinking = { type: 'enabled', clear_thinking: false }
          if (effortSubParamAllowed) bodyObj.reasoning_effort = effort
          effortApplied = true
        } else if (thinkingFormat === 'qwen') {
          bodyObj.enable_thinking = true
          if (effortSubParamAllowed) bodyObj.reasoning_effort = effort
          effortApplied = true
        } else if (thinkingFormat === 'qwen-chat-template') {
          bodyObj.chat_template_kwargs = { enable_thinking: true, preserve_thinking: true }
          effortApplied = true
        } else if (thinkingFormat === 'string-thinking') {
          bodyObj.thinking = effort
          effortApplied = true
        } else if (thinkingFormat === 'chat-template' || thinkingFormat === 'baseten') {
          // 依赖用户在 chatTemplateKwargs/Args 里自配的 $var 展开，测试无法可靠构造
          effortApplied = false
        } else {
          bodyObj.reasoning_effort = effort
          effortApplied = true
        }
      }
      if (apiKey) headers.authorization = 'Bearer ' + apiKey
    } else if (api === 'openai-responses') {
      url = joinEndpoint(baseURL, 'responses')
      bodyObj = { model: modelId, input: prompt, max_output_tokens: maxTokens }
      if (effortRequested) {
        bodyObj.reasoning = { effort: effort }
        effortApplied = true
      }
      if (apiKey) headers.authorization = 'Bearer ' + apiKey
    } else if (api === 'anthropic-messages') {
      url = joinEndpoint(baseURL, 'messages')
      bodyObj = { model: modelId, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }
      headers['anthropic-version'] = '2023-06-01'
      if (apiKey) headers['x-api-key'] = apiKey
    } else {
      throw new Error('不支持的 API 协议: ' + api)
    }
    // 渠道级自定义请求头（保留名由平台覆盖）
    const customHeaders = customHeadersOf(profile.headers)
    for (const name of Object.keys(customHeaders)) headers[name] = customHeaders[name]

    const body = JSON.stringify(bodyObj)
    let response
    try {
      response = await httpRequestText(url, {
        method: 'POST',
        headers: headers,
        body: body,
        timeoutMs: TEST_TIMEOUT_MS,
        maxBytes: MAX_TEST_BYTES,
        rejectHttpError: false,
      })
    } catch (e) {
      const msg = e && e.message ? e.message : String(e)
      throw new Error('测试请求失败: ' + msg)
    }

    const elapsedMs = Date.now() - started
    let parsed = null
    try { parsed = JSON.parse(response.text) } catch (_) { parsed = null }

    const source = modelEntry ? paramSource(modelEntry) : 'unknown'

    if (response.statusCode < 200 || response.statusCode >= 300) {
      const errMsg = extractErrorMessage(parsed, 'HTTP ' + response.statusCode)
      return {
        ok: false,
        provider: provider,
        modelId: modelId,
        api: api,
        url: url,
        statusCode: response.statusCode,
        elapsedMs: elapsedMs,
        hasApiKey: !!apiKey,
        source: source,
        effortApplied: effortApplied,
        error: clipText(errMsg, 500),
        raw: sanitizeDiagnosticText(response.text, 1200),
        message: '测试失败：HTTP ' + response.statusCode + ' · ' + clipText(errMsg, 200),
      }
    }

    const extracted = extractAssistantText(api, parsed)
    const text = extracted && extracted.text ? extracted.text : ''
    const reasoning = extracted && extracted.reasoning ? extracted.reasoning : ''
    const display = (extracted && extracted.display) || text || reasoning || ''
    const finishReason = extracted && extracted.finishReason ? extracted.finishReason : ''
    const svg = extractSvgMarkup(display) || extractSvgMarkup(text) || extractSvgMarkup(reasoning)
    const usage = parsed && parsed.usage && typeof parsed.usage === 'object' ? {
      promptTokens: Number(parsed.usage.prompt_tokens || parsed.usage.input_tokens) || undefined,
      completionTokens: Number(parsed.usage.completion_tokens || parsed.usage.output_tokens) || undefined,
      totalTokens: Number(parsed.usage.total_tokens) || undefined,
      reasoningTokens: Number(parsed.usage.completion_tokens_details && parsed.usage.completion_tokens_details.reasoning_tokens) || undefined,
    } : undefined

    const truncated = finishReason === 'length' || finishReason === 'incomplete' || (usage && usage.completionTokens && usage.completionTokens >= maxTokens)
    let message = '测试成功 · ' + elapsedMs + 'ms'
    if (svg) message += ' · 已解析 SVG'
    else if (!display) message += '（响应无文本）'
    else if (!text && reasoning) message += ' · 仅有 reasoning_content'
    if (truncated) message += ' · 可能被 max_tokens 截断'

    return {
      ok: true,
      provider: provider,
      modelId: modelId,
      api: api,
      url: url,
      statusCode: response.statusCode,
      elapsedMs: elapsedMs,
      hasApiKey: !!apiKey,
      source: source,
      effortApplied: effortRequested ? effortApplied : undefined,
      finishReason: finishReason || undefined,
      truncated: !!truncated,
      text: clipText(display || '(空响应)', 12000),
      contentText: clipText(text, 12000),
      reasoningText: clipText(reasoning, 12000),
      svg: svg || '',
      hasSvg: !!svg,
      usage: usage,
      message: message,
    }
  }

  async function checkUpdate() {
    const localVersion = VERSION
    const registryUrl = 'https://registry.npmjs.org/dsh-model-suite/latest'
    let latestVersion = ''
    try {
      let text = ''
      const web = ctx.get('web')
      if (web && typeof web.fetch === 'function') {
        try {
          const result = await Promise.race([
            web.fetch({ url: registryUrl }).then((value) => ({ kind: 'result', value: value })),
            ctx.timer.timeout(FETCH_TIMEOUT_MS).then(() => ({ kind: 'timeout' })),
          ])
          if (result.kind === 'timeout') throw new Error('npm registry 请求超时')
          const response = result.value
          if (!response || response.statusCode < 200 || response.statusCode >= 300) throw new Error('HTTP ' + (response && response.statusCode))
          const body = response.body
          if (typeof body === 'string') text = body
          else if (body && typeof body.content === 'string') text = body.content
          else if (body && typeof body.text === 'string') text = body.text
          else throw new Error('unsupported body')
        } catch (e) {
          const msg = e && (e.code || e.message) ? String(e.code || e.message) : String(e)
          if (!/WEB_PROVIDER_UNAVAILABLE|no usable web provider|not registered|configured web provider/i.test(msg)) throw e
          text = await httpsGetText(registryUrl, FETCH_TIMEOUT_MS)
        }
      } else {
        text = await httpsGetText(registryUrl, FETCH_TIMEOUT_MS)
      }
      const data = JSON.parse(text)
      latestVersion = str(data.version, '')
    } catch (e) {
      return { ok: false, localVersion: localVersion, latestVersion: '', hasUpdate: false, error: e instanceof Error ? e.message : String(e) }
    }
    return {
      ok: true,
      localVersion: localVersion,
      latestVersion: latestVersion,
      // ★ M5：语义化版本比较——`latest !== local` 会把降级（dist-tag 回退、本地
      //   预发布版）也报成"发现新版本"。
      hasUpdate: !!latestVersion && !!localVersion && compareVersion(latestVersion, localVersion) > 0,
      npmUrl: 'https://www.npmjs.com/package/dsh-model-suite',
      registryUrl: registryUrl,
    }
  }

  async function bootstrap() {
    refreshHostProto()
    const migrating = migrateLegacyPrefs()
    const prefs = readPrefs()
    const sources = readSourceConfig(prefs)
    return {
      writable: !!ctx.settings.writable,
      version: VERSION,
      levels: LEVELS.slice(),
      presets: Object.keys(PRESETS).map((id) => ({ id: id, label: PRESETS[id].label })),
      protocols: PROTOCOLS.slice(),
      listableProtocols: LISTABLE_PROTOCOLS.slice(),
      providers: listProviders(),
      compatFields: compatFieldsForBootstrap(),
      compatFieldCounts: compatFieldCounts(),
      auto: readAuto(),
      sources: {
        modelsDev: { url: sources.modelsDev.url, enabled: sources.modelsDev.enabled },
        litellm: { url: sources.litellm.url, enabled: sources.litellm.enabled },
        openrouter: { url: sources.openrouter.url, enabled: sources.openrouter.enabled },
      },
      catalogSources: CATALOG_SOURCES.map((s) => Object.assign({}, s)),
      defaults: {
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxTokens: DEFAULT_MAX_TOKENS,
        input: DEFAULT_INPUT.slice(),
        providerMaxRetries: DEFAULT_PROVIDER_MAX_RETRIES,
      },
      // 本插件不做 API Key 管理（apiKeyEnv 只读展示）；保留该字段仅为兼容旧客户端。
      canStoreApiKey: false,
      migratedFromModelPlus: migrating || prefs.migratedFromModelPlus === true,
      defaultTestPrompt: DEFAULT_TEST_PROMPT,
      defaultTestMaxTokens: DEFAULT_TEST_MAX_TOKENS,
      repo: 'https://github.com/pyooyq/dsh-model-suite',
      homepage: 'https://github.com/pyooyq/dsh-model-suite#readme',
      issues: 'https://github.com/pyooyq/dsh-model-suite/issues',
    }
  }

  async function listModels(args) {
    const provider = str(args && args.provider, '')
    if (!provider) throw new Error('缺少 provider')
    const profile = providerProfile(provider)
    if (!Object.keys(profile).length) {
      const err = new Error('渠道不存在或已删除: ' + provider)
      err.statusCode = 404
      throw err
    }
    // O2：auto 配置读一次复用到每个 modelView（此前每个模型都 readAuto→settings.get）
    const autoCfg = readAuto()
    return {
      provider: provider,
      baseURL: str(profile.baseURL, ''),
      api: str(profile.api, ''),
      displayName: str(profile.displayName, provider),
      apiKeyEnv: str(profile.apiKeyEnv, ''),
      isCatalogRoute: isCatalogRoute(provider),
      offeredCompatFields: COMPAT_OFFER[str(profile.api, '')] ? Array.from(COMPAT_OFFER[str(profile.api, '')]) : [],
      auto: autoCfg,
      models: getRawModels(provider).map((m) => modelView(m, autoCfg)),
      writable: !!ctx.settings.writable,
    }
  }

  /** bootstrap 下发的 compat 字段元数据（按协议分组，只含 gate === 'offer' 的字段）。 */
  function compatFieldsForBootstrap() {
    const out = {}
    for (const api of Object.keys(COMPAT_FIELD_TABLE)) out[api] = compatFieldMetadata(api)
    return out
  }

  function compatFieldCounts() {
    const out = {}
    for (const api of Object.keys(COMPAT_FIELD_TABLE)) out[api] = COMPAT_FIELD_TABLE[api].length
    return out
  }

  /* ───────────── 三链路 monkey-patch ───────────── */

  /**
   * 统一的三链路补丁安装：返回 restore 函数数组。
   *
   * 每处补丁都：
   *   - 先调原方法（不抢权、不接管失败）；
   *   - 读取**最新**偏好（热生效）；
   *   - 外层 try/catch，富化失败降级为原值（绝不把富化失败升级为业务失败）；
   *   - 卸载时按"原本是否有自有属性"决定赋回还是 delete。
   */
  function installPatches() {
    const restores = []

    /**
     * 安全赋值：某些宿主可能把服务对象冻结/密封。此时**降级**为"该链路不生效 +
     * 一条日志"，而不是让整个插件加载失败（插件其余能力仍然可用）。
     */
    function assignPatch(target, key, value, label) {
      try {
        target[key] = value
        return true
      } catch (e) {
        log('warn', label + ' 安装失败（服务对象不可写）: ' + (e && e.message ? e.message : String(e)))
        return false
      }
    }

    // ── 链路一：llm.discoverModels（发现富化，只写 contextWindow / maxTokens） ──
    const llm = ctx.llm
    if (llm && typeof llm.discoverModels === 'function') {
      const originalDiscover = llm.discoverModels.bind(llm)
      const hadOwnDiscover = Object.prototype.hasOwnProperty.call(llm, 'discoverModels')
      const rawDiscover = llm.discoverModels
      const patchedDiscover = async (settingsNs, request, signal) => {
        // ① 完整转发 signal（修正 enhancer R6：原实现丢掉第三参）
        const models = await originalDiscover(settingsNs, request, signal)
        try {
          const auto = readAuto()
          if (!auto.enabled) return models
          if (!auto.fields.contextWindow && !auto.fields.maxTokens) return models
          const route = str(request && request.provider, '')
          // 新草稿（尚无 route）视为自定义渠道；已有 route 走内置名单判定
          const isCustom = isEnrichableRoute(route, auto.includeCatalogRoutes, route.length === 0)
          if (!isCustom) return models
          const catalog = await getCatalogBounded(Array.isArray(models) ? models.map((m) => m && m.id).filter(Boolean) : [])
          // 只写 contextWindow / maxTokens（LlmDiscoveredModel 的类型限制）
          return enrichDiscovered(models, catalog, auto, route, true)
        } catch (_) {
          return models
        }
      }
      if (assignPatch(llm, 'discoverModels', patchedDiscover, '链路一')) {
        restores.push(() => restoreMethod(llm, 'discoverModels', rawDiscover, hadOwnDiscover))
      }
    } else {
      log('warn', 'ctx.llm.discoverModels 不可用，链路一未启用')
    }

    // ── 链路二：settings.mutate / update / replace（保存写盘，唯一能持久化 input/reasoningEfforts 的通道） ──
    const settings = ctx.settings
    const patched = []
    const patchSettings = (key, buildValue) => {
      const raw = settings[key]
      if (typeof raw !== 'function') return
      const hadOwn = Object.prototype.hasOwnProperty.call(settings, key)
      const bound = raw.bind(settings)
      const patchedMethod = async (ns, input, expectedRevision) => {
        // ① 命名空间闸门（修正 enhancer R1：原实现对所有 ns 一视同仁）
        const auto = readAuto()
        if (ns !== NS || !auto.enabled || !auto.persistOnSave) return bound(ns, input, expectedRevision)
        // 没有模型条目（例如写插件偏好本身）→ 无富化可言，既不联网也不改写
        const ids = collectModelIds(input, key)
        if (!ids.length) return bound(ns, input, expectedRevision)
        let next = input
        try {
          const catalog = await getCatalogBounded(ids)
          next = buildValue(input, catalog, auto)
        } catch (_) {
          next = input
        }
        try {
          return await bound(ns, next, expectedRevision)
        } catch (error) {
          if (isSettingsConflictError(error)) throw error
          // ② 校验前落盘：富化结果非法时尚未写入，用原始入参重试即可（表现为"静默不生效"）
          if (next === input) throw error
          return await bound(ns, input, expectedRevision)
        }
      }
      if (assignPatch(settings, key, patchedMethod, '链路二（' + key + '）')) patched.push([key, raw, hadOwn])
    }

    patchSettings('mutate', (ops, catalog, auto) => {
      if (!Array.isArray(ops)) return ops
      let changed = false
      const next = ops.map((op) => {
        if (!op || op.op !== 'set' || op.value === undefined) return op
        const profile = profileOf(op)
        if (!profile.route) return op
        const value = enrichOpValue(op.value, catalog, auto, profile.route, profile.fields)
        if (value === op.value) return op
        changed = true
        return Object.assign({}, op, { value: value })
      })
      // 引用稳定：无需补缺时原样返回入参（补丁等价于不存在）
      return changed ? next : ops
    })
    patchSettings('update', (patch, catalog, auto) => {
      const route = firstRouteOf(patch)
      if (!route) return patch
      return enrichModelsInTree(patch, catalog, auto, route, false)
    })
    patchSettings('replace', (section, catalog, auto) => {
      return enrichModelsInTree(section, catalog, auto, undefined, false)
    })
    for (const [key, raw, hadOwn] of patched) restores.push(() => restoreMethod(settings, key, raw, hadOwn))

    // ── 链路三：llm.resolveModelInfo（运行时兜底，修复"装插件前就已保存"的旧模型） ──
    if (llm && typeof llm.resolveModelInfo === 'function') {
      const originalResolve = llm.resolveModelInfo.bind(llm)
      const hadOwnResolve = Object.prototype.hasOwnProperty.call(llm, 'resolveModelInfo')
      const rawResolve = llm.resolveModelInfo
      const patchedResolve = async (provider, model, signal) => {
        // 先调原方法
        const info = await originalResolve(provider, model, signal)
        try {
          const auto = readAuto()
          if (!auto.enabled || !info || typeof info !== 'object') return info
          if (!isEnrichableRoute(provider, auto.includeCatalogRoutes, false)) return info
          // O2：profile 读一次复用（此前 baseURL/api 各读一次 settings）
          const routeProfile = providerProfile(provider)
          const matched = matchModel(model, await getCatalogBounded([model]), {
            baseURL: str(routeProfile.baseURL, ''),
            api: str(routeProfile.api, ''),
          })
          if (!matched) return info
          // ① 上下文：仅当原本未标注
          if (auto.fields.contextWindow && positiveInteger(matched.contextWindow) && !info.context) {
            info.context = { contextWindow: positiveInteger(matched.contextWindow) }
          }
          // ② 输出上限：仅当原本未标注（❌ 不把 32K/4096 视为未标注）
          if (auto.fields.maxTokens && positiveInteger(matched.maxTokens) && !info.defaultMaxTokens) {
            info.defaultMaxTokens = positiveInteger(matched.maxTokens)
          }
          // ③ 视觉：并入而非替换
          if (auto.fields.input && matched.inputModalities.indexOf('image') >= 0) {
            const current = Array.isArray(info.inputModalities) ? info.inputModalities.slice() : ['text']
            if (current.indexOf('image') < 0) current.push('image')
            info.inputModalities = current
          }
          // ④ 思考档位：仅在原本没有时注入
          if (auto.fields.reasoningEfforts && !info.reasoning) {
            const efforts = buildEfforts(matched)
            if (efforts && Object.keys(efforts).length) {
              const list = effortsToInfoArray(efforts)
              if (list.length) {
                const defaultEffort = highestNonOff(efforts)
                info.reasoning = defaultEffort === undefined ? { efforts: list } : { efforts: list, defaultEffort: defaultEffort }
              }
            }
          }
        } catch (_) { /* 异常保持原样 */ }
        return info
      }
      if (assignPatch(llm, 'resolveModelInfo', patchedResolve, '链路三')) {
        restores.push(() => restoreMethod(llm, 'resolveModelInfo', rawResolve, hadOwnResolve))
      }
    } else {
      log('warn', 'ctx.llm.resolveModelInfo 不可用，链路三未启用')
    }

    return restores
  }

  /** 从 settings 写入入参里收集模型 id（决定是否按需拉取另两个源）。 */
  function collectModelIds(input, key) {
    const ids = []
    const push = (value) => {
      if (looksLikeModelEntry(value)) ids.push(value.id)
    }
    if (key === 'mutate') {
      if (!Array.isArray(input)) return ids
      for (const op of input) {
        if (!op || op.op !== 'set' || op.value === undefined) continue
        const path = Array.isArray(op.path) ? op.path : []
        if (path[0] === 'providers' && path.indexOf('models') >= 0) {
          if (Array.isArray(op.value)) for (const m of op.value) push(m)
          else push(op.value)
          continue
        }
        collectFromTree(op.value, push)
      }
      return ids
    }
    collectFromTree(input, push)
    return ids
  }

  /** 递归收集树里的模型 id（只认 `models` 数组键路径，修正 R11）。 */
  function collectFromTree(value, push) {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) {
        if (looksLikeModelEntry(item)) push(item)
        else collectFromTree(item, push)
      }
      return
    }
    for (const k of Object.keys(value)) {
      const child = value[k]
      if (k === 'models' && Array.isArray(child)) {
        for (const m of child) push(m)
      } else if (child && typeof child === 'object') {
        collectFromTree(child, push)
      }
    }
  }

  /** 从 `{ providers: { <route>: ... } }` 形态取第一个 route。 */
  function firstRouteOf(value) {
    if (!isPlainObject(value)) return ''
    const providers = isPlainObject(value.providers) ? value.providers : null
    if (providers) {
      const keys = Object.keys(providers)
      if (keys.length) return keys[0]
    }
    return ''
  }

  /* ───────────── 启动时的目录名单自校验（best-effort） ───────────── */

  async function calibrateCatalogRoutes() {
    for (const spec of ['@earendil-works/pi-ai/providers/all', '@deepseek-ai/dsh-llm-pi-ai']) {
      try {
        const mod = await import(spec)
        const ids = mod && typeof mod.getBuiltinProviders === 'function' ? mod.getBuiltinProviders() : null
        if (Array.isArray(ids) && ids.length) {
          if (adoptCatalogRouteIds(ids)) log('info', '已用实测 pi-ai 名单覆盖静态 route 名单（' + CATALOG_ROUTE_IDS.size + ' 个）')
          return
        }
      } catch (_) { /* 取不到就沿用静态名单 */ }
    }
  }

  /* ───────────── HTTP 路由 ───────────── */

  function json(res, status, body) {
    // M7：设置类数据禁止任何中间层/启发式缓存
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }

  function readJsonBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0
      let settled = false
      const chunks = []
      req.on('data', (chunk) => {
        if (settled) return
        size += chunk.length
        if (size > 256 * 1024) {
          settled = true
          reject(new Error('body-too-large'))
          // ★ M3：排干剩余数据而不是销毁连接——destroy 可能抢在 400 响应刷出
          //   之前断开 socket，客户端会看到连接重置而非 400。
          if (typeof req.resume === 'function') req.resume()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (settled) return
        if (chunks.length === 0) { resolve({}); return }
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
        catch { settled = true; reject(new Error('invalid-json')) }
      })
      req.on('error', (e) => { if (!settled) { settled = true; reject(e) } })
    })
  }

  function getRoute(path, run) {
    return {
      kind: 'exact', path,
      handler: (req, res) => {
        // ★ H1：读端点同样过 Host 栅栏——bootstrap/list-models 会吐出 baseURL 与
        //   自定义请求头明文，绝不能被 DNS-rebinding 页面读到。
        if (!isLoopbackHostHeader(req && req.headers ? req.headers.host : '')) {
          json(res, 403, { ok: false, error: 'untrusted host header' })
          return
        }
        if (req.method !== 'GET') { json(res, 405, { ok: false, error: 'method not allowed' }); return }
        run(req).then(
          (value) => json(res, 200, value),
          (error) => json(res, (error && error.statusCode) || 500, { ok: false, error: routeError(error) }),
        )
      },
    }
  }

  /**
   * 写接口信任栅栏：
   * 1) 有 Origin 时必须与 Host 同源（防 CSRF）
   * 2) 无 Origin 时仅允许 loopback 远端（本机进程）
   */
  function assertTrustedWriteRequest(req) {
    const host = req && req.headers ? req.headers.host : ''
    const origin = req && req.headers ? req.headers.origin : undefined
    if (origin) {
      if (!host || !sameOriginHost(origin, host)) {
        const err = new Error('cross-origin denied')
        err.statusCode = 403
        throw err
      }
      return
    }
    const remote = (req && (req.socket && (req.socket.remoteAddress || req.socket.remoteFamily)))
      || (req && req.connection && req.connection.remoteAddress)
      || ''
    if (!isLoopbackRemoteAddress(remote)) {
      const err = new Error('unauthenticated write denied')
      err.statusCode = 403
      throw err
    }
  }

  function postRoute(path, run) {
    return {
      kind: 'exact', path,
      handler: (req, res) => {
        // ★ H1：Host 栅栏先于 Origin 栅栏——rebinding 下 Origin 与 Host 同为
        //   攻击者域名，Origin≈Host 一致性检查拦不住，必须要求 Host 是 loopback。
        if (!isLoopbackHostHeader(req && req.headers ? req.headers.host : '')) {
          json(res, 403, { ok: false, error: 'untrusted host header' })
          return
        }
        if (req.method !== 'POST') { json(res, 405, { ok: false, error: 'method not allowed' }); return }
        try {
          assertTrustedWriteRequest(req)
        } catch (error) {
          const status = (error && error.statusCode) || 403
          json(res, status, { ok: false, error: routeError(error) })
          return
        }
        readJsonBody(req).then(
          (body) => {
            const record = (typeof body === 'object' && body !== null) ? body : {}
            return run(record).then(
              (value) => json(res, 200, value),
              (error) => json(res, (error && error.statusCode) || 400, { ok: false, error: routeError(error) }),
            )
          },
          (error) => json(res, 400, { ok: false, error: routeError(error) }),
        )
      },
    }
  }

  /** Build the /api/suite/* route family (14 endpoints). */
  function makeRoutes() {
    return [
      getRoute(`${API_PREFIX}/bootstrap`, () => bootstrap()),
      getRoute(`${API_PREFIX}/list-models`, (req) => {
        const provider = str(new URL(req.url, 'http://x').searchParams.get('provider'), '')
        return listModels({ provider })
      }),
      postRoute(`${API_PREFIX}/save-model`, (b) => saveModel(b)),
      postRoute(`${API_PREFIX}/apply-preset`, (b) => applyPreset(b)),
      postRoute(`${API_PREFIX}/discover-models`, (b) => discoverModels(b)),
      postRoute(`${API_PREFIX}/refresh-models`, (b) => refreshProviderModels(b)),
      postRoute(`${API_PREFIX}/add-models`, (b) => addProviderModels(b)),
      postRoute(`${API_PREFIX}/delete-model`, (b) => deleteModel(b)),
      postRoute(`${API_PREFIX}/enrich-models`, (b) => enrichProviderModels(b)),
      postRoute(`${API_PREFIX}/save-sources`, (b) => saveSources(b)),
      postRoute(`${API_PREFIX}/save-provider-advanced`, (b) => saveProviderAdvanced(b)),
      postRoute(`${API_PREFIX}/save-auto-config`, (b) => saveAutoConfig(b)),
      postRoute(`${API_PREFIX}/test-model`, (b) => testModel(b)),
      getRoute(`${API_PREFIX}/check-update`, () => checkUpdate()),
    ]
  }

  const restores = installPatches()
  const routes = makeRoutes()
  const disposers = routes.map((route) => ctx.webServer.register(route))

  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
    log('info', '已摘除 ' + disposers.length + ' 条路由')
  }, 'model-suite: routes')

  ctx.on('dispose', () => {
    for (const restore of restores) {
      try { restore() } catch (_) {}
    }
    log('info', '已还原 ' + restores.length + ' 处补丁')
  })

  calibrateCatalogRoutes().catch(() => {})
}
