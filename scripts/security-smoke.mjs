/**
 * dsh-model-suite security & invariant smoke test.
 *
 * 运行：`node scripts/security-smoke.mjs`
 *
 * 分三部分（对应开发文档 §14.2）：
 *   A. 纯函数行为断言 —— 从 lib/index.js 抽出"纯工具区段"用 new Function 构造，
 *      对安全助手 + 三源目录 + 仅补缺不变量做**真实行为**验证；
 *   B. 源码标记回归 —— 防止 R1/R4/R5/R6/R7/R9 类问题复发；
 *   C. 出站 / 重定向攻击面证明 —— 本地起一个 attacker server，证明"若不拦截，
 *      凭据真的会被 302 拐走"。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import http from 'node:http'
import { COMPAT_FIELD_TABLE } from '../lib/compat-fields.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'lib/index.js'), 'utf8')
const client = readFileSync(join(root, 'lib/client.js'), 'utf8')
const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')

function assert(cond, msg) {
  if (!cond) throw new Error('[security-smoke] ' + msg)
}

/* ─────────── 抽出纯工具区段并构造可调用集合 ─────────── */

const START_MARKER = "const NS = 'llm-pi-ai'"
const END_MARKER = '\nexport function apply'
const start = src.indexOf(START_MARKER)
const end = src.lastIndexOf(END_MARKER)
assert(start >= 0, 'helper region start marker not found in lib/index.js')
assert(end > start, 'helper region end marker not found in lib/index.js')
const region = src.slice(start, end)
assert(!/\bexport\b/.test(region), 'helper region must not contain export statements')
assert(!/^\s*import\b/m.test(region), 'helper region must not contain import statements')

const routesMod = await import(pathToFileURL(join(root, 'lib/catalog-routes.js')).href + '?smoke=' + Date.now())
const compatMod = await import(pathToFileURL(join(root, 'lib/compat-fields.js')).href + '?smoke=' + Date.now())

const EXPORTED = [
  'parseHostHeader', 'isLoopbackHostname', 'sameUrlOrigin', 'hasSensitiveRequestHeaders',
  'isLoopbackRemoteAddress', 'isBlockedOutboundHostname', 'assertOutboundUrlAllowed',
  'sameOriginHost', 'routeError', 'isMissingValue', 'positiveInteger',
  'normalizeModelIdKey', 'normalizeModelIdLoose', 'isSafeModelId',
  'sanitizeEfforts', 'buildEfforts', 'highestNonOff', 'effortsToInfoArray',
  'validateCompatValueFor', 'sanitizeCompatFieldValue', 'cloneModel', 'compatKeyCount',
  'normalizeCompatInput', 'normalizeHeadersInput', 'normalizeInputModalities',
  'normalizeRetryPolicyInput', 'validateCatalogUrl',
  'isEnrichableRoute', 'makeSuiteMeta', 'metadataFingerprint', 'metadataRichness',
  'pickCatalogCandidate', 'matchModel', 'matchModelCandidates',
  'parseCatalogSource', 'mergeLayered', 'buildCatalog',
  'enrichModelConfig', 'enrichDiscovered', 'enrichModelsInTree', 'enrichOpValue',
  'profileOf', 'looksLikeModelEntry', 'applyRemoteToLocal', 'restoreMethod',
  'readSourceConfig', 'readAutoConfig', 'sanitizeDiagnosticText', 'extractSvgMarkup',
  'COMPAT_OFFER', 'COMPAT_TYPES', 'CATALOG_SOURCE_ORDER', 'DEFAULT_CONTEXT_WINDOW', 'DEFAULT_MAX_TOKENS',
]

const factory = new Function(
  'CATALOG_ROUTE_IDS', 'normalizeRouteId', 'isCatalogRoute', 'adoptCatalogRouteIds',
  'COMPAT_FIELD_TABLE', 'CHAT_TEMPLATE_VARS',
  region + '\n; return { ' + EXPORTED.join(', ') + ' }',
)
const H = factory(
  routesMod.CATALOG_ROUTE_IDS,
  routesMod.normalizeRouteId,
  routesMod.isCatalogRoute,
  routesMod.adoptCatalogRouteIds,
  compatMod.COMPAT_FIELD_TABLE,
  compatMod.CHAT_TEMPLATE_VARS,
)

/* ─────────── A. 纯函数行为断言 ─────────── */

// A1. loopback 判定
assert(H.isLoopbackHostname('127.0.0.1'), '127.0.0.1 is loopback')
assert(H.isLoopbackHostname('127.1.2.3'), '127/8 is loopback')
assert(H.isLoopbackHostname('localhost'), 'localhost is loopback')
assert(H.isLoopbackHostname('::1'), '::1 is loopback')
assert(!H.isLoopbackHostname('8.8.8.8'), 'public address is not loopback')
assert(H.isLoopbackRemoteAddress('::ffff:127.0.0.1'), 'IPv4-mapped loopback detected')
assert(!H.isLoopbackRemoteAddress('10.0.0.5'), 'private address is not loopback remote')

// A2. 出站策略
let threw = false
try { H.assertOutboundUrlAllowed('http://example.com/x') } catch { threw = true }
assert(threw, 'http non-loopback must be rejected')
threw = false
try { H.assertOutboundUrlAllowed('http://127.0.0.1:11434/v1') } catch { threw = true }
assert(!threw, 'http loopback must be allowed')
threw = false
try { H.assertOutboundUrlAllowed('https://169.254.169.254/latest') } catch { threw = true }
assert(threw, 'cloud metadata must be blocked')
threw = false
try { H.assertOutboundUrlAllowed('https://models.dev/api.json', { requireHttps: true }) } catch { threw = true }
assert(!threw, 'models.dev must be allowed')
threw = false
try { H.assertOutboundUrlAllowed('http://models.dev/api.json', { requireHttps: true }) } catch { threw = true }
assert(threw, 'requireHttps must reject http')

// A3. 敏感头 + 同源比较
assert(H.hasSensitiveRequestHeaders({ Authorization: 'Bearer x' }), 'authorization is sensitive')
assert(H.hasSensitiveRequestHeaders({ 'x-api-key': 'k' }), 'x-api-key is sensitive')
assert(!H.hasSensitiveRequestHeaders({ accept: 'json' }), 'accept is not sensitive')
assert(H.sameUrlOrigin('https://a.com/x', 'https://a.com/y'), 'same origin')
assert(!H.sameUrlOrigin('https://a.com/x', 'https://evil.com/x'), 'cross host')
assert(!H.sameUrlOrigin('https://a.com/x', 'http://a.com/x'), 'cross scheme')
assert(!H.sameUrlOrigin('http://127.0.0.1:3001/x', 'http://127.0.0.1:3002/x'), 'cross port')
assert(H.sameOriginHost('http://127.0.0.1:3080', '127.0.0.1:3080'), 'same origin host')
assert(!H.sameOriginHost('http://evil.com', '127.0.0.1:3080'), 'evil origin rejected')
assert(!H.sameOriginHost('http://127.0.0.1:3080.evil.com', '127.0.0.1:3080'), 'suffix trick rejected')

// A4. 对外错误脱敏
const scrubbed = H.routeError(new Error('failed https://api.secret.example/v1/x at C:\\Users\\me\\.dsh\\settings.yaml'))
assert(!scrubbed.includes('api.secret.example'), 'url redacted in public error')
assert(!scrubbed.includes('settings.yaml'), 'path redacted in public error')

// A5. 目录 URL 校验：必须 HTTPS 且走出站策略
assert(H.validateCatalogUrl('https://models.dev/api.json') === 'https://models.dev/api.json', 'https catalog url ok')
assert(H.validateCatalogUrl('') === '', 'empty catalog url clears')
threw = false
try { H.validateCatalogUrl('http://models.dev/api.json') } catch { threw = true }
assert(threw, 'non-https catalog url rejected')
threw = false
try { H.validateCatalogUrl('https://169.254.169.254/x') } catch { threw = true }
assert(threw, 'metadata catalog url rejected')

// A6. 模型 id 归一化 + **禁止前缀模糊匹配**（修正 R4）
assert(H.normalizeModelIdKey('google/gemini-2.5-flash') === 'gemini-2.5-flash', 'vendor prefix stripped')
assert(H.normalizeModelIdKey('GLM-4.6?x=1') === 'glm-4.6', 'query stripped + lowercased')
assert(H.normalizeModelIdKey('claude-sonnet-4:thinking') === 'claude-sonnet-4', 'tag stripped')

const o1Catalog = H.buildCatalog({
  modelsDev: [H.makeSuiteMeta('o1', 'openai', 'models.dev', {
    contextWindow: 200000, maxTokens: 100000, inputModalities: ['text', 'image'], supportsReasoning: true,
  })],
}, { sourcesUsed: ['models.dev'] })
assert(H.matchModel('o1', o1Catalog) !== null, 'exact id hit')
assert(H.matchModel('O1', o1Catalog) !== null, 'case-insensitive hit')
assert(H.matchModel('openai/o1', o1Catalog) !== null, 'vendor-prefixed hit')
assert(H.matchModel('o1-mini', o1Catalog) === null, 'PREFIX MATCH FORBIDDEN: o1-mini must not hit o1')
assert(H.matchModel('o1-preview', o1Catalog) === null, 'PREFIX MATCH FORBIDDEN: o1-preview must not hit o1')
assert(H.matchModel('o1x', o1Catalog) === null, 'PREFIX MATCH FORBIDDEN: o1x must not hit o1')

// A7. 两级匹配：第 2 级只做分隔符等价（- _ . ），仍不是前缀
const sepCatalog = H.buildCatalog({
  modelsDev: [H.makeSuiteMeta('gpt-4o', 'openai', 'models.dev', { contextWindow: 128000 })],
}, { sourcesUsed: ['models.dev'] })
assert(H.matchModel('gpt-4o', sepCatalog) !== null, 'exact hit before loose')
assert(H.matchModel('gpt_4o', sepCatalog) !== null, 'loose level 2 treats _ and - as equal')
assert(H.matchModel('gpt-4o-mini', sepCatalog) === null, 'loose level 2 must not prefix-match')

// A8. 分层补缺（修正 R3）：低优先源不得把已解析的值降级
const layered = H.mergeLayered({
  modelsDev: [H.makeSuiteMeta('deepseek-chat', 'deepseek', 'models.dev', {
    contextWindow: 131072, maxTokens: 8192, inputModalities: [],
  })],
  litellm: [H.makeSuiteMeta('deepseek-chat', 'deepseek', 'litellm', {
    // 故意缺 maxTokens（undefined），contextWindow 与主源不同，且声明了视觉
    contextWindow: 65536, maxTokens: undefined, inputModalities: ['text', 'image'],
  })],
})
const layeredCandidates = layered.byNorm.get('deepseek-chat')
assert(layeredCandidates && layeredCandidates.length, 'layered merge kept a candidate')
const lay = layeredCandidates[0]
assert(lay.contextWindow === 131072, 'higher-priority source value must win (no overwrite)')
assert(lay.maxTokens === 8192, 'lower source must not downgrade a resolved value to undefined')
assert(lay.inputModalities.indexOf('image') >= 0, 'lower source fills a field the higher source left unknown')
assert(lay.source === 'models.dev', 'primary candidate keeps its source badge')

// 已声明的 text-only 不得被低优先源"加宽"
const declaredTextOnly = H.mergeLayered({
  modelsDev: [H.makeSuiteMeta('qwen-vl', 'alibaba', 'models.dev', { contextWindow: 32000, inputModalities: ['text'] })],
  litellm: [H.makeSuiteMeta('qwen-vl', 'alibaba', 'litellm', { inputModalities: ['text', 'image'], maxTokens: 4096 })],
}).byNorm.get('qwen-vl')[0]
assert(declaredTextOnly.inputModalities.indexOf('image') < 0, 'a declared text-only modality must not be widened by a lower source')
assert(declaredTextOnly.maxTokens === 4096, 'but a genuinely unknown field is still filled')

// LiteLLM-only id still resolves
const litellmOnly = H.mergeLayered({
  modelsDev: [],
  litellm: [H.makeSuiteMeta('some-litellm-only', 'litellm', 'litellm', { contextWindow: 32000, maxTokens: 4096 })],
})
assert(litellmOnly.byNorm.get('some-litellm-only'), 'litellm-only id still resolvable')

// OpenRouter fills the field neither of the first two knows
const threeWay = H.mergeLayered({
  modelsDev: [H.makeSuiteMeta('m1', 'p1', 'models.dev', { contextWindow: 1000 })],
  litellm: [H.makeSuiteMeta('m1', 'p1', 'litellm', { maxTokens: 2000 })],
  openrouter: [H.makeSuiteMeta('m1', 'p1', 'openrouter', { inputModalities: ['text', 'image'] })],
})
const t3 = threeWay.byNorm.get('m1')[0]
assert(t3.contextWindow === 1000 && t3.maxTokens === 2000, 'fields filled from successive lower sources')
assert(t3.inputModalities.indexOf('image') >= 0, 'third source fills input modalities')

// A9. 仅补缺不变量（修正 R2）：哨兵值必须被尊重
const catalogForFill = H.buildCatalog({
  modelsDev: [H.makeSuiteMeta('glm-5.3', 'zhipu', 'models.dev', {
    contextWindow: 1048576, maxTokens: 384000, inputModalities: ['text', 'image'], supportsReasoning: true,
    reasoningEfforts: { low: 'low', medium: 'medium', high: 'high' },
  })],
}, { sourcesUsed: ['models.dev'] })
const autoAll = { enabled: true, persistOnSave: true, includeCatalogRoutes: false,
  fields: { contextWindow: true, maxTokens: true, input: true, reasoningEfforts: true } }

for (const sentinel of [H.DEFAULT_CONTEXT_WINDOW, 256000, 32000, 4096]) {
  const keepCtx = H.enrichModelConfig({ id: 'glm-5.3', contextWindow: sentinel }, catalogForFill, autoAll, 'hub-gm')
  assert(keepCtx.contextWindow === sentinel, `sentinel contextWindow ${sentinel} must never be treated as unfilled`)
}
for (const sentinel of [H.DEFAULT_MAX_TOKENS, 32000, 4096, 262144]) {
  const keepOut = H.enrichModelConfig({ id: 'glm-5.3', maxTokens: sentinel }, catalogForFill, autoAll, 'hub-gm')
  assert(keepOut.maxTokens === sentinel, `sentinel maxTokens ${sentinel} must never be treated as unfilled`)
}
const keepInput = H.enrichModelConfig({ id: 'glm-5.3', input: ['text'] }, catalogForFill, autoAll, 'hub-gm')
assert(JSON.stringify(keepInput.input) === '["text"]', 'hand-written input ["text"] must be preserved (no unconditional overwrite)')
const keepManual = H.enrichModelConfig({ id: 'glm-5.3', contextWindow: 12345, maxTokens: 678, input: ['text'], reasoningEfforts: false }, catalogForFill, autoAll, 'hub-gm')
assert(keepManual.contextWindow === 12345 && keepManual.maxTokens === 678, 'manual values preserved')
assert(keepManual.reasoningEfforts === false, 'explicit reasoningEfforts:false preserved')

// 空值才补
const fillEmpty = H.enrichModelConfig({ id: 'glm-5.3' }, catalogForFill, autoAll, 'hub-gm')
assert(fillEmpty.contextWindow === 1048576, 'empty contextWindow filled from catalog')
assert(fillEmpty.maxTokens === 384000, 'empty maxTokens filled from catalog')
assert(JSON.stringify(fillEmpty.input) === '["text","image"]', 'empty input filled when catalog knows vision')
assert(fillEmpty.reasoningEfforts && fillEmpty.reasoningEfforts.high === 'high', 'empty reasoningEfforts filled from catalog levels')

// 字段开关逐个生效
const onlyCtx = H.enrichModelConfig({ id: 'glm-5.3' }, catalogForFill,
  Object.assign({}, autoAll, { fields: { contextWindow: true, maxTokens: false, input: false, reasoningEfforts: false } }), 'hub-gm')
assert(onlyCtx.contextWindow === 1048576, 'contextWindow switch on')
assert(onlyCtx.maxTokens === undefined && onlyCtx.input === undefined && onlyCtx.reasoningEfforts === undefined, 'other switches off')

// 内置渠道默认不富化（修正 R1）
assert(H.enrichModelConfig({ id: 'glm-5.3' }, catalogForFill, autoAll, 'deepseek').contextWindow === undefined, 'catalog route not enriched by default')
assert(H.enrichModelConfig({ id: 'glm-5.3' }, catalogForFill, autoAll, 'openai').contextWindow === undefined, 'catalog route openai not enriched by default')
const includeCatalog = Object.assign({}, autoAll, { includeCatalogRoutes: true })
assert(H.enrichModelConfig({ id: 'glm-5.3' }, catalogForFill, includeCatalog, 'deepseek').contextWindow === 1048576, 'includeCatalogRoutes opts catalog routes in')
assert(H.isEnrichableRoute('hub-gm', false, false), 'custom route is enrichable')
assert(!H.isEnrichableRoute('deepseek', false, false), 'catalog route is not enrichable')
assert(!H.isEnrichableRoute('', false, false), 'unknown route is not enriched when unknown')
assert(H.isEnrichableRoute('', false, true), 'new draft (no route yet) is treated as custom')

// 未命中目录时**不写任何字段**（删除 enhancer 的 128K/4096 兜底）
const unknownFill = H.enrichModelConfig({ id: 'totally-private-id' }, catalogForFill, autoAll, 'hub-gm')
assert(JSON.stringify(unknownFill) === JSON.stringify({ id: 'totally-private-id' }), 'no catalog hit => no writes at all')

// A10. R11：只在 models 键路径上富化
const tree = H.enrichModelsInTree({ providers: { 'hub-gm': { models: [{ id: 'glm-5.3' }] } } }, catalogForFill, autoAll, undefined, false)
assert(tree.providers['hub-gm'].models[0].contextWindow === 1048576, 'tree enrichment on providers.<route>.models')
const decoy = H.enrichModelsInTree({ things: [{ id: 'glm-5.3' }] }, catalogForFill, autoAll, undefined, false)
assert(decoy.things[0].contextWindow === undefined, 'R11: an arbitrary id-bearing array must NOT be treated as models')
const overrideDecoy = H.enrichModelsInTree({ providers: { 'hub-gm': { modelOverrides: { 'glm-5.3': {} } } } }, catalogForFill, autoAll, undefined, false)
assert(overrideDecoy.providers['hub-gm'].modelOverrides['glm-5.3'].contextWindow === undefined, 'modelOverrides is not a models array')

// mutate op path 形态（真机：官方页保存走 path=['providers',route,'models']）
const opModelsArray = H.enrichOpValue([{ id: 'glm-5.3' }], catalogForFill, autoAll, 'hub-gm', ['models'])
assert(opModelsArray[0].contextWindow === 1048576, 'mutate op with models-array value is enriched')
const opSingleModel = H.enrichOpValue({ id: 'glm-5.3' }, catalogForFill, autoAll, 'hub-gm', ['models', 0])
assert(opSingleModel.contextWindow === 1048576, 'mutate op with single model value is enriched')
const opProfile = H.enrichOpValue({ api: 'openai-completions', models: [{ id: 'glm-5.3' }] }, catalogForFill, autoAll, 'hub-gm', [])
assert(opProfile.models[0].contextWindow === 1048576, 'mutate op with whole-profile value is enriched')
const opScalar = H.enrichOpValue(128000, catalogForFill, autoAll, 'hub-gm', ['models', 0, 'contextWindow'])
assert(opScalar === 128000, 'scalar field op is passed through untouched')
assert(H.profileOf({ op: 'set', path: ['providers', 'hub-gm', 'models'], value: [] }).route === 'hub-gm', 'profileOf reads route from op.path')
assert(H.profileOf({ op: 'set', value: { providers: { 'hub-gm': {} } } }).route === 'hub-gm', 'profileOf falls back to op.value.providers')
assert(H.profileOf({ op: 'set', path: [], value: { api: 'x' } }).route === undefined, 'profileOf returns no route when undeterminable')

// A11. 链路一富化只写 contextWindow / maxTokens
const discovered = H.enrichDiscovered([{ id: 'glm-5.3' }], catalogForFill, autoAll, 'hub-gm')
assert(discovered[0].contextWindow === 1048576 && discovered[0].maxTokens === 384000, 'link 1 fills capacities')
assert(discovered[0].input === undefined && discovered[0].reasoningEfforts === undefined, 'link 1 must not write input/reasoningEfforts (type limits)')
assert(H.enrichDiscovered([{ id: 'glm-5.3' }], catalogForFill, autoAll, 'deepseek')[0].contextWindow === undefined, 'link 1 respects the custom-route gate')

// A12. R9/R8：档位求交集 + 最高非 off 档
assert(JSON.stringify(H.sanitizeEfforts({ off: null, low: 'low', bogus: 'x', high: '' })) === '{"off":null,"low":"low"}', 'unknown levels and empty wires dropped')
assert(H.sanitizeEfforts({ off: null }) === undefined, 'no positive level => undefined')
assert(H.buildEfforts({ supportsReasoning: true }) !== false, 'reasoning without levels => default levels')
assert(H.buildEfforts({ reasoningEfforts: false }) === false, 'explicit false preserved')
assert(H.highestNonOff({ off: null, low: 'low', high: 'high' }) === 'high', 'highest non-off level picked')
assert(H.highestNonOff({ off: null }) === undefined, 'no non-off level => undefined')
assert(H.highestNonOff([]) === undefined, 'empty array => undefined')

// A12b. DSH 形态回归：reasoning.efforts 必须是 [{id,name}] 数组，不是对象
const infoEfforts = H.effortsToInfoArray({ off: null, low: 'low', max: 'max' })
assert(Array.isArray(infoEfforts), 'effortsToInfoArray must return an array (DSH normalizeModelInfo shape)')
assert(infoEfforts.length === 3, 'effortsToInfoArray length')
assert(infoEfforts[0].id === 'off' && infoEfforts[0].name === 'Off', 'first effort shape {id,name}')
assert(infoEfforts[2].id === 'max' && infoEfforts[2].name === 'Max', 'level order follows THINKING_LEVELS')

// A13. cloneModel：完整保留 name 与 **全量 compat**（风险 #7），移除 idPattern
const cloned = H.cloneModel({
  id: '  GLM-5.3 ',
  name: 'GLM 5.3',
  contextWindow: 4096.7,
  maxTokens: 1024,
  input: ['text', 'image'],
  reasoningEfforts: { off: null, low: 'low', medium: 'medium' },
  idPattern: 'glm-*',
  compat: {
    supportsDeveloperRole: false,
    supportsStore: true,
    maxTokensField: 'max_tokens',
    thinkingFormat: 'deepseek',
    vllmPriority: 3,
    chatTemplateKwargs: { effort: { $var: 'thinking.effort', omitWhenOff: true } },
    notARealField: 'x',
    supportsReasoningEffort: 'yes',
  },
  unknownField: 1,
})
assert(cloned.id === 'GLM-5.3', 'id trimmed but NOT lowercased (gateways can be case-sensitive)')
assert(cloned.name === 'GLM 5.3', 'name preserved (risk #7)')
assert(cloned.contextWindow === 4096, 'contextWindow floored')
assert(cloned.idPattern === undefined, 'idPattern removed (dead field)')
assert(cloned.unknownField === undefined, 'unknown top-level field dropped')
assert(cloned.compat.supportsDeveloperRole === false, 'compat boolean preserved')
assert(cloned.compat.supportsStore === true, 'compat boolean preserved (2nd)')
assert(cloned.compat.maxTokensField === 'max_tokens', 'compat enum preserved')
assert(cloned.compat.thinkingFormat === 'deepseek', 'compat thinkingFormat preserved (was the only one before)')
assert(cloned.compat.vllmPriority === 3, 'compat number preserved')
assert(cloned.compat.chatTemplateKwargs && cloned.compat.chatTemplateKwargs.effort.$var === 'thinking.effort', 'compat object preserved')
assert(cloned.compat.notARealField === undefined, 'unknown compat field dropped')
assert(cloned.compat.supportsReasoningEffort === undefined, 'wrong-typed compat value dropped')
assert(H.compatKeyCount(cloned) === 6, 'compat key count for badges (got ' + H.compatKeyCount(cloned) + ')')

// A14. compat 白名单：协议不支持的字段必须报错（不是静默丢弃）
threw = false
try { H.normalizeCompatInput({ supportsStore: true }, 'openai-responses') } catch { threw = true }
assert(threw, 'model-level compat with a field the protocol does not offer must throw')
threw = false
try { H.normalizeCompatInput({ thinkingFormat: 'nope' }, 'openai-completions') } catch { threw = true }
assert(threw, 'invalid enum value must throw')
threw = false
try { H.normalizeCompatInput({ supportsDeveloperRole: 'yes' }, 'openai-completions') } catch { threw = true }
assert(threw, 'non-boolean for boolean field must throw')
const compatOk = H.normalizeCompatInput({ supportsDeveloperRole: false, store: undefined }, 'openai-responses')
assert(compatOk.present === true && compatOk.value.supportsDeveloperRole === false, 'offered field accepted')
assert(compatOk.value.store === undefined, 'undefined keys omitted')
assert(H.normalizeCompatInput(null, 'openai-responses').value === undefined, 'null clears compat')
assert(H.normalizeCompatInput({}, 'openai-responses').value === undefined, 'empty object clears compat')
assert(H.normalizeCompatInput(undefined, 'openai-responses').present === false, 'undefined means "leave alone"')
assert(H.COMPAT_OFFER['openai-completions'].has('supportsDeveloperRole'), 'gate offers supportsDeveloperRole')
assert(H.COMPAT_OFFER['openai-completions'].size === 19, 'openai-completions offers 19 fields')
assert(H.COMPAT_OFFER['openai-responses'].size === 4, 'openai-responses offers 4 fields')
assert(H.COMPAT_OFFER['anthropic-messages'].size === 7, 'anthropic-messages offers 7 fields')
assert(!H.COMPAT_OFFER['openai-completions'].has('openRouterRouting'), 'withhold fields are not offered')

// A15. headers 校验：拒绝换行（防请求头注入）
threw = false
try { H.normalizeHeadersInput({ 'X-Title': 'a\nb' }) } catch { threw = true }
assert(threw, 'header value with \\n must be rejected')
threw = false
try { H.normalizeHeadersInput({ 'X-Bad Name': 'v' }) } catch { threw = true }
assert(threw, 'invalid header name rejected')
threw = false
try { H.normalizeHeadersInput({ 'X-Ok': 'v', 'X-Ok2': 'x'.repeat(9000) }) } catch { threw = true }
assert(threw, 'oversized headers rejected')
const headersOk = H.normalizeHeadersInput({ 'X-Title': 'my-app', 'User-Agent': 'x' })
assert(headersOk.value['X-Title'] === 'my-app', 'valid header kept')
assert(headersOk.warnings.length === 1, 'reserved header name yields a non-blocking warning')
assert(H.normalizeHeadersInput(null).value === undefined, 'null clears headers')

// A16. defaultInput 不可为空
threw = false
try { H.normalizeInputModalities([]) } catch { threw = true }
assert(threw, 'empty defaultInput rejected')
assert(JSON.stringify(H.normalizeInputModalities(['image']).value) === '["text","image"]', 'text is always present')

// A17. retryPolicy
threw = false
try { H.normalizeRetryPolicyInput({ mode: 'sometimes' }) } catch { threw = true }
assert(threw, 'invalid retry mode rejected')
threw = false
try { H.normalizeRetryPolicyInput({ mode: 'normal', maxRetries: 100000 }) } catch { threw = true }
assert(threw, 'maxRetries above the cap rejected')
assert(H.normalizeRetryPolicyInput({ mode: 'always' }).value.mode === 'always', 'always mode ok')
assert(H.normalizeRetryPolicyInput(null).value === undefined, 'null clears retryPolicy')
assert(H.normalizeRetryPolicyInput({ mode: 'normal', maxRetries: 7 }).value.maxRetries === 7, 'normal mode ok')

// A18. applyRemoteToLocal：预览/写回的补缺与覆盖语义
const localKeep = H.applyRemoteToLocal({ id: 'm', contextWindow: 256000, maxTokens: 32000 }, { contextWindow: 1000, maxTokens: 2000 }, false, true)
assert(localKeep.model.contextWindow === 256000 && localKeep.model.maxTokens === 32000, 'overwrite=false keeps manual values')
assert(localKeep.changed === false, 'no change reported when nothing filled')
const localOver = H.applyRemoteToLocal({ id: 'm', contextWindow: 256000 }, { contextWindow: 1000 }, true, true)
assert(localOver.model.contextWindow === 1000 && localOver.changed === true, 'overwrite=true replaces')
const localFill = H.applyRemoteToLocal({ id: 'm' }, { contextWindow: 1000, input: ['text', 'image'], reasoningEfforts: { low: 'low', medium: 'medium' } }, false, true)
assert(localFill.model.contextWindow === 1000, 'missing field filled')
assert(JSON.stringify(localFill.model.input) === '["text","image"]', 'vision synced')
assert(localFill.model.reasoningEfforts.low === 'low', 'efforts synced')

// A19. R7：还原分支——原本无自有属性就 delete
const targetNoOwn = Object.create({ inherited: 1 })
targetNoOwn.inherited = undefined
delete targetNoOwn.inherited
const proto = { discoverModels: function original() { return 'proto' } }
const instance = Object.create(proto)
H.restoreMethod(instance, 'discoverModels', undefined, false)
assert(!Object.prototype.hasOwnProperty.call(instance, 'discoverModels'), 'restoreMethod deletes when there was no own property (no forwarding shell)')
assert(typeof instance.discoverModels === 'function', 'prototype method visible again after delete')
const own = { discoverModels: function mine() { return 1 } }
const original = own.discoverModels
own.discoverModels = function patched() { return 2 }
H.restoreMethod(own, 'discoverModels', original, true)
assert(own.discoverModels() === 1, 'restoreMethod puts the original value back when it was own')

// A20. 源配置 / 自动配置默认值
const srcCfg = H.readSourceConfig({})
assert(srcCfg.modelsDev.enabled && srcCfg.litellm.enabled && srcCfg.openrouter.enabled, 'three sources enabled by default')
assert(srcCfg.modelsDev.url === 'https://models.dev/api.json', 'models.dev default url')
assert(srcCfg.litellm.url.includes('model_prices_and_context_window.json'), 'litellm default url')
assert(srcCfg.openrouter.url === 'https://openrouter.ai/api/v1/models', 'openrouter default url')
const srcCfg2 = H.readSourceConfig({ sources: { litellm: { enabled: false, url: 'https://x.example/l.json' } } })
assert(srcCfg2.litellm.enabled === false && srcCfg2.litellm.url === 'https://x.example/l.json', 'source override applied')
const autoDefaults = H.readAutoConfig({})
assert(autoDefaults.enabled && autoDefaults.persistOnSave, 'auto enabled by default')
assert(autoDefaults.fields.contextWindow && autoDefaults.fields.maxTokens && autoDefaults.fields.input && autoDefaults.fields.reasoningEfforts, 'four field switches default on')
assert(autoDefaults.includeCatalogRoutes === false, 'includeCatalogRoutes default off')
const autoOff = H.readAutoConfig({ auto: { enabled: false, fields: { input: false } } })
assert(autoOff.enabled === false && autoOff.fields.input === false && autoOff.fields.maxTokens === true, 'explicit false honoured, others stay on')

// A21. 目录源解析（三源各自的字段映射）
const mdParsed = H.parseCatalogSource('modelsDev', {
  deepseek: { id: 'deepseek', models: { 'deepseek-chat': { id: 'deepseek-chat', name: 'DeepSeek Chat', limit: { context: 131072, output: 8192 }, modalities: { input: ['text'] }, reasoning: false } } },
})
assert(mdParsed.length === 1 && mdParsed[0].contextWindow === 131072 && mdParsed[0].maxTokens === 8192, 'models.dev mapping')
assert(mdParsed[0].reasoningEfforts === false, 'models.dev reasoning:false -> reasoningEfforts false')
// 目录给出显式档位时必须附上 off：否则那类模型的思考菜单里没有「关闭」项
const mdEfforts = H.parseCatalogSource('modelsDev', {
  zhipu: { id: 'zhipu', models: { 'glm-5.3': { id: 'glm-5.3', limit: { context: 1000, output: 100 }, reasoning: true, reasoning_options: [{ type: 'effort', values: ['low', 'medium', 'high'] }] } } },
})
assert(mdEfforts[0].reasoningEfforts && mdEfforts[0].reasoningEfforts.off === null, 'models.dev levels always include off')
assert(mdEfforts[0].reasoningEfforts.low === 'low' && mdEfforts[0].reasoningEfforts.high === 'high', 'models.dev level values kept')
assert(H.effortsToInfoArray(mdEfforts[0].reasoningEfforts).some((e) => e.id === 'off'), 'the off entry reaches dsh-llm reasoning.efforts')
const llParsed = H.parseCatalogSource('litellm', {
  'openai/gpt-x': { max_input_tokens: 128000, max_output_tokens: 16384, supports_vision: true, supports_thinking: true, litellm_provider: 'openai' },
  'flat/vision-model': { max_input_tokens: 64000, supported_modalities: ['text', 'image'], litellm_provider: 'flat' },
})
assert(llParsed.length === 2, 'litellm emits one entry per key (no redundant bare alias)')
assert(llParsed[0].contextWindow === 128000 && llParsed[0].maxTokens === 16384, 'litellm mapping')
assert(llParsed[0].inputModalities.indexOf('image') >= 0, 'litellm vision mapping')
assert(llParsed[0].normId === 'gpt-x', 'litellm vendor prefix stripped by normalizeModelIdKey (alias was redundant)')
assert(llParsed[1].inputModalities.indexOf('image') >= 0, 'litellm flat supported_modalities ["text","image"] maps to vision')
const orParsed = H.parseCatalogSource('openrouter', {
  data: [{ id: 'vendor/model-x', name: 'Model X', context_length: 200000, top_provider: { max_completion_tokens: 8192 }, architecture: { input_modalities: ['text', 'image'] }, reasoning: { supported_efforts: ['low', 'high'] } }],
})
assert(orParsed.length === 1 && orParsed[0].contextWindow === 200000 && orParsed[0].maxTokens === 8192, 'openrouter mapping')
assert(orParsed[0].reasoningEfforts && orParsed[0].reasoningEfforts.high === 'high', 'openrouter efforts mapping')
assert(orParsed[0].reasoningEfforts.off === null, 'openrouter levels always include off')
assert(orParsed[0].provider === 'vendor', 'openrouter provider derived from vendor prefix')
threw = false
try { H.parseCatalogSource('modelsDev', []) } catch { threw = true }
assert(threw, 'models.dev array payload rejected')

// A22. SVG 消毒
assert(H.extractSvgMarkup('<svg></svg>') === '', 'tiny svg rejected')
assert(H.extractSvgMarkup('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>') === '', 'svg with <script> rejected')
assert(H.extractSvgMarkup('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="x()"><rect/></svg>') === '', 'svg with on*= rejected')
assert(H.extractSvgMarkup('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect fill="red"/></svg>').startsWith('<svg'), 'clean svg accepted')

// A23. 跨端口凭据重定向必须视为跨源
function shouldBlockCredentialRedirect(fromUrl, toUrl, headers) {
  return H.hasSensitiveRequestHeaders(headers) && !H.sameUrlOrigin(fromUrl, toUrl)
}
assert(shouldBlockCredentialRedirect('http://127.0.0.1:3001/models', 'http://127.0.0.1:3002/models', { authorization: 'Bearer sk-secret-demo' }), 'cross-port credential redirect blocked')
assert(!shouldBlockCredentialRedirect('http://127.0.0.1:3001/models', 'http://127.0.0.1:3001/next', { authorization: 'Bearer sk' }), 'same-origin credential redirect allowed')

/* ─────────── B. 源码标记回归 ─────────── */

// 链路二命名空间闸门 + 写盘开关
assert(src.includes("ns !== NS"), 'link 2 must gate on the llm-pi-ai namespace (R1)')
assert(src.includes('auto.persistOnSave'), 'link 2 must honour the persistOnSave switch')
assert(src.includes('readAuto()'), 'auto config must be read per call (hot reload)')
// signal 完整转发（R6）
assert(src.includes('originalDiscover(settingsNs, request, signal)'), 'link 1 must forward the signal argument (R6)')
// 干净还原（R7）
assert(src.includes('delete target[key]'), 'dispose must delete a non-own patch slot (R7)')
assert(src.includes('hasOwnProperty.call(llm, \'discoverModels\')'), 'link 1 must record whether discoverModels was an own property')
assert(src.includes('hasOwnProperty.call(llm, \'resolveModelInfo\')'), 'link 3 must record whether resolveModelInfo was an own property')
// 自定义渠道名单（R1）
assert(src.includes('CATALOG_ROUTE_IDS'), 'catalog route list must be referenced')
assert(routesMod.CATALOG_ROUTE_IDS.has('deepseek') && routesMod.CATALOG_ROUTE_IDS.has('openai'), 'CATALOG_ROUTE_IDS must contain deepseek and openai')
// 链路三不把 32K/4096 视为未标注（R2）
assert(src.includes('!info.defaultMaxTokens'), 'link 3 must treat only a missing defaultMaxTokens as unset')
assert(src.includes('!info.context'), 'link 3 must treat only a missing context as unset')
// 失败源不写缓存（R5）
assert(src.includes('catalogCache.set(url'), 'sources cache successful fetches')
assert(src.indexOf('catalogCache.set(url') > src.indexOf('const metas = parseCatalogSource'), 'cache write happens only after a successful parse')
// inflight 去重
assert(src.includes('catalogInflight.get(url)') && src.includes('catalogInflight.set(url'), 'in-flight de-duplication present')
// 缓存按 URL 分键 + 30 分钟 TTL
assert(src.includes('CATALOG_TTL_MS'), 'catalog TTL constant present')
assert(/catalogCache\s*=\s*new Map\(\)/.test(src), 'catalog cache is keyed per URL')
// 仅补缺：不得出现哨兵值比较
for (const bad of [
  /contextWindow\s*===\s*(?:262144|256000|32000|4096|32768)/,
  /maxTokens\s*===\s*(?:262144|256000|32000|4096|32768)/,
  /===\s*(?:256000|32000)\b/,
  /SENTINEL/,
]) {
  assert(!bad.test(src), 'no sentinel "treat as unfilled" comparison allowed: ' + bad)
}
assert(!src.includes("next.input = norm.vision === true ? ['text', 'image'] : ['text']"), 'forced text input must stay removed')
assert(src.includes('isMissingValue'), 'only-fill invariant uses isMissingValue')
// 未命中目录不得写默认值
assert(!src.includes('?? 128000') && !src.includes('|| 128000'), 'no 128K fallback for unknown models')
assert(!src.includes('?? 4096') && !src.includes('|| 4096'), 'no 4096 fallback for unknown models')
// headers 校验存在
assert(src.includes('HEADER_NAME_PATTERN'), 'header name pattern present')
assert(/\[\\r\\n\]/.test(src) || src.includes('不得包含换行'), 'header value newline rejection present')
assert(src.includes('normalizeHeadersInput'), 'headers validation function present')
// compat 白名单校验存在
assert(src.includes("gate === 'offer'") || src.includes('COMPAT_OFFER'), 'compat offer-gate filtering present')
assert(src.includes('不支持 ') && src.includes(' 协议'), 'compat rejects protocol-unsupported fields with a message')
// 端点前缀与移除项
assert(src.includes("const API_PREFIX = '/api/suite'"), 'API prefix is /api/suite')
assert(!src.includes("'/api/plus'"), 'legacy /api/plus prefix removed')
assert(!src.includes('add-provider'), 'add-provider endpoint removed')
assert(!/save-provider(?!-advanced)/.test(src), 'legacy save-provider / save-provider-retry endpoints removed')
assert(!src.includes('writeProviderProfile'), 'provider-create write path removed')
assert(src.includes('/save-provider-advanced'), 'save-provider-advanced endpoint present')
assert(src.includes('/delete-model'), 'delete-model endpoint present')
assert(src.includes('/save-sources'), 'save-sources endpoint present')
assert(src.includes('/save-auto-config'), 'save-auto-config endpoint present')
// 迁移
assert(src.includes("PREF_KEY = '__modelSuite'"), 'pref key is __modelSuite')
assert(src.includes("LEGACY_PREF_KEY = '__modelPlus'"), 'legacy pref key migration present')
assert(src.includes('migratedFromModelPlus'), 'migration marker present')
// 出站策略
assert(src.includes('携带凭据的请求禁止跨域重定向'), 'credential redirect guard present')
assert(src.includes('unauthenticated write denied'), 'write trust fence present')
assert(src.includes('assertTrustedWriteRequest'), 'trust fence wiring present')
assert(src.includes('expectedRevision'), 'CAS expectedRevision used')
assert(src.includes('禁止访问链路本地或云元数据地址'), 'SSRF guard present')
assert(src.includes('HTTPS 请求禁止降级到 HTTP 重定向'), 'https downgrade guard present')
assert(src.includes('重定向次数超限'), 'redirect cap present')

// cordis.patch.yml
assert(patch.includes('- insert:'), 'patch has an insert row')
assert(patch.includes('dsh-model-suite'), 'patch references dsh-model-suite')
assert(!patch.includes('model-plus') && !patch.includes('custom-provider-enhancer'), 'patch must not reference predecessor plugins')

// client 半区标记
assert(client.includes('refreshSeqRef'), 'client must keep refreshSeqRef')
assert(client.includes('providerRef'), 'client must keep providerRef')
assert(client.includes('/api/suite'), 'client must use the /api/suite prefix')
assert(!client.includes('/api/plus'), 'client must not use the legacy /api/plus prefix')
assert(client.includes("localStorage['ms.lang']") || client.includes("'ms.lang'"), 'client language key is ms.lang')
assert(client.includes('LEGACY_LANG_STORAGE_KEY') || client.includes("'mp.lang'"), 'client falls back to the legacy mp.lang key')
assert(client.includes('__ModuleLoader__.load('), 'client bundle marker present')
assert(client.includes('return module.exports'), 'client bundle tail marker present')
assert(!client.includes('idPattern'), 'idPattern must be gone from the client too')

// 客户端 ↔ 主机端点契约：客户端只能调用本插件真实注册的端点。
// 先把相邻字符串字面量拼起来，避免 `'save-' + 'provider' + '-advanced'` 这类写法绕过检查。
const clientFlat = client.replace(/'\s*\+\s*'/g, '').replace(/"\s*\+\s*"/g, '')
const clientEndpoints = new Set()
for (const m of clientFlat.matchAll(/API\s*\+\s*'([^']+)'/g)) clientEndpoints.add(m[1].replace(/^\/+/, '').split('?')[0])
const HOST_ENDPOINTS = [
  'bootstrap', 'list-models', 'save-model', 'apply-preset', 'discover-models', 'refresh-models',
  'add-models', 'delete-model', 'enrich-models', 'save-sources', 'save-provider-advanced',
  'save-auto-config', 'test-model', 'check-update',
]
for (const endpoint of HOST_ENDPOINTS) {
  assert(clientEndpoints.has(endpoint), 'client must call /api/suite/' + endpoint + ' (found: ' + Array.from(clientEndpoints).sort().join(', ') + ')')
}
for (const endpoint of Array.from(clientEndpoints)) {
  assert(HOST_ENDPOINTS.includes(endpoint), 'client calls an endpoint the host does not register: ' + endpoint)
}
// host 侧注册的端点集合必须与上面这张表完全一致（14 个，不多不少）
const registered = (src.match(/`\$\{API_PREFIX\}\/[a-z-]+`/g) || [])
  .map((m) => m.slice('`${API_PREFIX}/'.length, -1)).sort()
assert(registered.join(',') === HOST_ENDPOINTS.slice().sort().join(','), 'host registers exactly the 14 documented endpoints (found ' + registered.join(',') + ')')

// 客户端读取的 bootstrap / list-models 字段必须存在（§12.8 API↔UI 映射表）
const BOOT_FIELDS = [
  'writable', 'version', 'levels', 'presets', 'listableProtocols', 'providers',
  'compatFields', 'catalogSources', 'defaultTestPrompt', 'defaultTestMaxTokens',
  'withEffort', 'withVision', 'withCompat', 'retryLabel', 'isCatalogRoute', 'defaultsConfigured',
  'headersCount', 'modelCount', 'displayName',
]
for (const field of BOOT_FIELDS) {
  assert(client.includes(field), 'client must use bootstrap field ' + field)
}
const MODEL_FIELDS = ['levels', 'summary', 'vision', 'compatCount', 'contextWindow', 'maxTokens', 'source', 'hasEffort']
for (const field of MODEL_FIELDS) {
  assert(client.includes(field), 'client must use list-models model field ' + field)
}
const SYNC_FIELDS = ['persistOnSave', 'includeCatalogRoutes', 'reasoningEfforts', 'modelsDev', 'litellm', 'openrouter', 'sourcesUsed', 'hitCount', 'localCount', 'changes', 'remaining', 'unmatched', 'unmatchedCount']
for (const field of SYNC_FIELDS) {
  assert(client.includes(field), 'client must use sync/auto field ' + field)
}
// 三态控件必须能表达"未设置"（提交时省略键）
assert(/未设置/.test(client), 'client renders a tri-state "未设置" option')
// 双语词典
const enEntries = (client.match(/^\s{4,}'[^']+':\s*'/gm) || []).length
assert(enEntries >= 150, 'client EN dictionary looks substantial (found ' + enEntries + ' entries)')

/* ─────────── B2. i18n 双向完备性 ───────────
   正向：凡是被用到的一定有词条（否则英文界面静默掉回中文）。
   反向：凡是词条一定可达（否则就是删功能后留下的僵尸词条）。
   可达性的定义 = 字面量 t('X') ∪ client 里的逐行字符串字面量（覆盖动态查表：
   SOURCE_TEXT 的值、档位名…）∪ compat 字段表的标签/说明 ∪ host 的 label（预设/目录源）。
   ⚠️ 字符串字面量必须**逐行**提取（[^'\\\n]）：英文注释里的撇号会让跨行匹配吞掉代码。 */
const EN_BLOCK_START = client.indexOf('const EN = {')
const EN_BLOCK_END = client.indexOf('\n    };', EN_BLOCK_START)
const clientBody = client.slice(0, EN_BLOCK_START) + client.slice(EN_BLOCK_END)
function lineLiterals(text) {
  const out = new Set()
  for (const m of text.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)) out.add(m[1].replace(/\\'/g, "'"))
  for (const m of text.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) out.add(m[1].replace(/\\"/g, '"'))
  return out
}
function clientDictKeys(text) {
  const keys = new Set()
  for (const m of text.matchAll(/^\s*'((?:[^'\\\n]|\\.)*)'\s*:\s*'/gm)) keys.add(m[1].replace(/\\'/g, "'"))
  return keys
}
const dictKeys = clientDictKeys(client)
// 正向 1：字面量 t()
{
  const missing = []
  for (const m of client.matchAll(/\bt\(\s*'((?:[^'\\\n]|\\.)*)'\s*\)/g)) {
    const key = m[1].replace(/\\'/g, "'")
    if (!dictKeys.has(key) && missing.indexOf(key) < 0) missing.push(key)
  }
  assert(missing.length === 0, 'every literal t() key has an EN entry (missing: ' + JSON.stringify(missing) + ')')
}
// 正向 2：host 下发的 compat 字段标签/说明（客户端 t(field.label) 渲染）
{
  const missing = []
  for (const api of Object.keys(COMPAT_FIELD_TABLE)) {
    for (const row of COMPAT_FIELD_TABLE[api]) {
      for (const text of [row[2], row[3]]) {
        // 纯 ASCII 的标签本身就是字段名（chat_template_kwargs 等），无需翻译
        if (typeof text === 'string' && /[^\x00-\x7F]/.test(text) && !dictKeys.has(text) && missing.indexOf(text) < 0) missing.push(text)
      }
    }
  }
  assert(missing.length === 0, 'every compat field label/description has an EN entry (missing: ' + JSON.stringify(missing) + ')')
}
// 反向：不允许存在不可达词条
{
  const reachable = new Set()
  for (const m of clientBody.matchAll(/\bt\(\s*'((?:[^'\\\n]|\\.)*)'\s*\)/g)) reachable.add(m[1].replace(/\\'/g, "'"))
  for (const k of lineLiterals(clientBody)) reachable.add(k)
  for (const k of lineLiterals(readFileSync(join(root, 'lib/compat-fields.js'), 'utf8'))) reachable.add(k)
  for (const m of src.matchAll(/label: '([^'\n]+)'/g)) reachable.add(m[1])
  const dead = [...dictKeys].filter((k) => !reachable.has(k))
  assert(dead.length === 0, 'no unreachable EN entries (dead: ' + JSON.stringify(dead) + ')')
}

/* ─────────── C. 出站攻击面证明（若不拦截，凭据真的会被拐走） ─────────── */

const attackerHits = []
const attacker = http.createServer((req, res) => {
  attackerHits.push(req.headers.authorization || '')
  res.writeHead(200)
  res.end('ok')
})
await new Promise((resolve) => attacker.listen(0, '127.0.0.1', resolve))
const aport = attacker.address().port
await new Promise((resolve, reject) => {
  const req = http.request(
    { hostname: '127.0.0.1', port: aport, path: '/models', method: 'GET', headers: { authorization: 'Bearer sk-secret-demo' } },
    (res) => { res.resume(); res.on('end', resolve) },
  )
  req.on('error', reject)
  req.end()
})
assert(attackerHits[0] === 'Bearer sk-secret-demo', 'baseline: attacker can receive auth if forwarded')
attacker.close()

console.log('[security-smoke] OK — ' + (EXPORTED.length + 40) + '+ assertions passed')
