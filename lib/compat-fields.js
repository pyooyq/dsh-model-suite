/**
 * compat 字段全量表（唯一真源）。
 *
 * 来源：`@deepseek-ai/dsh-llm-pi-ai/lib/types/catalog.d.ts` 的四个 gate
 * （`COMPLETIONS_COMPAT_GATE` / `RESPONSES_COMPAT_GATE` / anthropic / bedrock）。
 * 只列出 **gate === 'offer'** 的字段；`withhold` 字段是 pi-ai 从目录/vendor 推导的，
 * 不开放给 profile，因此不出现在本表。
 *
 * ⚠️ DSH 升级可能增减 gate 字段。升级后请对照 `catalog.d.ts` 同步本表，
 * `scripts/build.mjs` 会断言每个协议的字段数（19 / 4 / 7 / 1）以防漂移。
 *
 * 每项结构：[字段名, 类型, 中文短标签, 中文说明, 枚举可选值?]
 * 类型取值：'boolean' | 'enum' | 'number' | 'object'
 *
 * @module dsh-model-suite/compat-fields
 */

/** 各协议可编辑的 compat 字段。 */
export const COMPAT_FIELD_TABLE = {
  'openai-completions': [
    ['supportsStore', 'boolean', '允许 store', '端点是否接受 store 参数（OpenAI 的响应持久化开关）'],
    ['supportsDeveloperRole', 'boolean', '允许 developer 角色', '端点是否接受 developer 角色的系统提示（仅推理模型发送）；false 退回 system'],
    ['supportsReasoningEffort', 'boolean', '允许 reasoning_effort', '端点是否接受 reasoning_effort 请求字段'],
    ['supportsUsageInStreaming', 'boolean', '流式返回 usage', '是否接受 stream_options: { include_usage: true }'],
    ['supportsFinishReason', 'boolean', '返回 finish_reason', '流是否带 finish_reason；false 让 pi-ai 在流结束时自行推断终止原因'],
    ['maxTokensField', 'enum', '输出上限字段', '输出上限使用的字段拼写', ['max_completion_tokens', 'max_tokens']],
    ['requiresToolResultName', 'boolean', '工具结果需带 name', '工具结果消息是否必须带 name'],
    ['requiresAssistantAfterToolResult', 'boolean', '工具结果后需 assistant', '工具结果与下一条用户消息之间是否必须有 assistant 消息'],
    ['requiresThinkingAsText', 'boolean', '思考以文本传输', '思考块是否必须以 <thinking> 分隔的文本形式传输'],
    ['requiresReasoningContentOnAssistantMessages', 'boolean', '回放需 reasoning_content', '推理开启时回放的 assistant 消息是否需要空 reasoning_content'],
    ['thinkingFormat', 'enum', '思考参数格式', '推理参数的 wire 格式', ['openai', 'deepseek', 'openrouter', 'together', 'baseten', 'zai', 'qwen', 'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling']],
    ['chatTemplateKwargs', 'object', 'chat_template_kwargs', '作为 chat_template_kwargs 发送（仅在两个 chat-template 格式下被读取）'],
    ['chatTemplateArgs', 'object', 'chat_template_args', '作为 chat_template_args 发送（baseten 格式）'],
    ['supportsThinkingTokenBudget', 'boolean', '允许思考预算', 'thinkingTokenBudgetField: "thinking_token_budget" 的别名；显式字段优先'],
    ['thinkingTokenBudgetField', 'enum', '思考预算字段', '承载推理预算的请求字段', ['thinking_token_budget', 'thinking_budget', 'thinking_budget_tokens']],
    ['vllmPriority', 'number', 'vLLM 优先级', 'vLLM 调度 priority（越小越早；服务端需开启优先级调度）'],
    ['supportsStrictMode', 'boolean', '允许 strict 工具', '工具定义是否接受 strict'],
    ['cacheControlFormat', 'enum', '提示缓存格式', '提示缓存标记约定', ['anthropic']],
    ['supportsLongCacheRetention', 'boolean', '允许长缓存保留', '是否接受长提示缓存保留'],
  ],
  'openai-responses': [
    ['supportsDeveloperRole', 'boolean', '允许 developer 角色', '端点是否接受 developer 角色的系统提示（仅推理模型发送）；false 退回 system'],
    ['supportsMaxOutputTokens', 'boolean', '允许 max_output_tokens', '是否接受 max_output_tokens；false 则省略（Azure/Codex 忽略此共享字段）'],
    ['supportsStrictMode', 'boolean', '允许 strict 工具', '工具定义是否接受 strict'],
    ['supportsLongCacheRetention', 'boolean', '允许长缓存保留', '是否接受长提示缓存保留'],
  ],
  'anthropic-messages': [
    ['supportsEagerToolInputStreaming', 'boolean', '允许工具急切流式', '是否接受按工具的 eager_input_streaming'],
    ['supportsLongCacheRetention', 'boolean', '允许长缓存保留', '是否接受长提示缓存保留'],
    ['supportsCacheControlOnTools', 'boolean', '工具支持 cache_control', '工具定义上是否接受 cache_control'],
    ['supportsTemperature', 'boolean', '允许 temperature', '是否接受 temperature 请求字段'],
    ['forceAdaptiveThinking', 'boolean', '强制自适应思考', '是否无视模型 id 强制自适应思考'],
    ['allowEmptySignature', 'boolean', '允许空思考签名', '是否回放空思考签名而不是把思考转成文本'],
    ['supportsStrictTools', 'boolean', '允许严格工具 schema', '是否接受 Anthropic 严格工具 schema'],
  ],
  'amazon-bedrock': [
    ['supportsStrictMode', 'boolean', '允许 strict 工具', '工具定义是否接受 strict'],
  ],
}

/** DSH 内部 bedrock 路径的原协议名同样映射到 bedrock 字段表。 */
COMPAT_FIELD_TABLE['bedrock-converse-stream'] = COMPAT_FIELD_TABLE['amazon-bedrock']

/** build.mjs / smoke 断言用的字段数基线。 */
export const COMPAT_PROTOCOL_FIELD_COUNTS = {
  'openai-completions': 19,
  'openai-responses': 4,
  'anthropic-messages': 7,
  'amazon-bedrock': 1,
}

/** chat_template_kwargs / chat_template_args 的 $var 占位符白名单。 */
export const CHAT_TEMPLATE_VARS = ['thinking.enabled', 'thinking.effort', 'thinking.budget']

/** 本插件可管理（并据此渲染 compat 表单）的协议。 */
export const COMPAT_MANAGED_PROTOCOLS = ['openai-completions', 'openai-responses', 'anthropic-messages']

/** 把表格行转成 UI 用的字段元数据数组。 */
export function compatFieldMetadata(api) {
  const rows = COMPAT_FIELD_TABLE[api]
  if (!Array.isArray(rows)) return []
  return rows.map((row) => ({
    field: row[0],
    type: row[1],
    label: row[2],
    description: row[3],
    ...(row[4] ? { options: row[4].slice() } : {}),
  }))
}

export default {
  COMPAT_FIELD_TABLE,
  COMPAT_PROTOCOL_FIELD_COUNTS,
  CHAT_TEMPLATE_VARS,
  COMPAT_MANAGED_PROTOCOLS,
  compatFieldMetadata,
}
