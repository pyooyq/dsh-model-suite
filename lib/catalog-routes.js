/**
 * pi-ai 内置目录 route 名单。
 *
 * 用途：链路一/二/三的「自定义渠道判定」——只有 route 不在本名单内的渠道
 * 才默认被自动富化（`auto.includeCatalogRoutes=false` 时）。
 *
 * 名单来源：`@earendil-works/pi-ai/dist/providers/all.js` 的
 * `builtinProviders()`（DSH `0.1.5-rc.2` / pi-ai `0.85.1`，实测 40 个 id）。
 *
 * 升级维护：DSH 升级后重新枚举并与本文件对齐。`lib/index.js` 在 apply()
 * 时会 best-effort 动态 import pi-ai 的 `builtinProviders()`（与平台
 * catalogProviders() 同源）做实测覆盖，取不到时沿用本静态名单
 * （因此本名单必须保持可用）。
 *
 * @module dsh-model-suite/catalog-routes
 */

/** pi-ai 内置目录的全部 provider route id（小写）。 */
export const CATALOG_ROUTE_IDS = new Set([
  'amazon-bedrock',
  'ant-ling',
  'anthropic',
  'azure-openai-responses',
  'baseten',
  'cerebras',
  'cloudflare-ai-gateway',
  'cloudflare-workers-ai',
  'deepseek',
  'fireworks',
  'github-copilot',
  'google',
  'google-vertex',
  'groq',
  'huggingface',
  'kimi-coding',
  'minimax',
  'minimax-cn',
  'mistral',
  'moonshotai',
  'moonshotai-cn',
  'nvidia',
  'openai',
  'openai-codex',
  'opencode',
  'opencode-go',
  'openrouter',
  'qwen-token-plan',
  'qwen-token-plan-cn',
  'qwen-token-plan-individual',
  'radius',
  'together',
  'vercel-ai-gateway',
  'xai',
  'xiaomi',
  'xiaomi-token-plan-ams',
  'xiaomi-token-plan-cn',
  'xiaomi-token-plan-sgp',
  'zai',
  'zai-coding-cn',
])

/**
 * 归一化一个 route 名。
 * @param {unknown} route 原始 route
 * @returns {string} 小写去空白的 route（非字符串返回空串）
 */
export function normalizeRouteId(route) {
  return typeof route === 'string' ? route.trim().toLowerCase() : ''
}

/**
 * 判定一个 route 是否为 pi-ai 内置目录渠道。
 * @param {unknown} route 原始 route
 * @returns {boolean} 是内置目录渠道则为 true
 */
export function isCatalogRoute(route) {
  const id = normalizeRouteId(route)
  return id.length > 0 && CATALOG_ROUTE_IDS.has(id)
}

/**
 * best-effort 用 pi-ai 实测名单**覆盖**静态名单。
 *
 * 取不到（包不可解析、导出改名、import 抛错）时**不抛异常**，调用方沿用静态名单。
 *
 * ★ R-M10：旧实现的守护是 `next.length < CATALOG_ROUTE_IDS.size 则拒绝`——
 *   pi-ai 一旦**删除** provider（名单变小），实测名单永远小于静态名单，
 *   "删除型漂移"永远无法自动修正，自愈路径形同虚设。改为：实测名单足够
 *   可信（≥ 10 个，排除解析出垃圾）时**整体覆盖**（可增可删），与真机
 *   `builtinProviders()` 语义一致。
 * @param {readonly string[] | readonly {id: string}[] | undefined | null} ids 实测 provider id 列表
 * @returns {boolean} 是否发生了覆盖
 */
export function adoptCatalogRouteIds(ids) {
  if (!Array.isArray(ids) || ids.length < 10) return false
  const next = ids
    .map((id) => normalizeRouteId(typeof id === 'string' ? id : (id && typeof id === 'object' ? id.id : '')))
    .filter((id) => id.length > 0)
  if (next.length < 10) return false
  CATALOG_ROUTE_IDS.clear()
  for (const id of next) CATALOG_ROUTE_IDS.add(id)
  return true
}

export default { CATALOG_ROUTE_IDS, isCatalogRoute, normalizeRouteId, adoptCatalogRouteIds }
