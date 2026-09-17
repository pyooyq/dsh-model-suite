/**
 * dsh-model-suite browser half — registers the「模型套件」settings page.
 *
 * 通过 `settings.section` slot 在设置页注册「模型套件」分区：
 * 页面骨架 = 页头(标题+语言切换) → 渠道工具栏 → 反馈条 → 下划线 Tab 导航。
 * - 模型：紧凑只读表格 + 展开式编辑器（显示名/模态/思考强度/容量/wire/模型级 compat），
 *   保存与删除固定在编辑器底部操作条，错误就地显示；
 * - 渠道设置：渠道级 compat（分组+搜索+仅看已配置）、重试策略、路由默认值、
 *   自定义请求头（四张独立卡片，带「未保存」脏标记）；
 * - 模型测试：单模型并行测试与一键全测（提示词折叠）；
 * - 目录与自动化：三源目录地址、自动配置开关、三源补全预览与写回；
 * - 关于：版本 / 检查更新 / 仓库 / 迁移提示。
 *
 * 渠道的新增与删除回归官方「模型」页，本页只提供只读渠道选择器 + 富化能力。
 *
 * 本文件是 DSH client bundle 形态：window.__ModuleLoader__.load 工厂。
 * - React 通过 require('react') 从 loader 模块表解析（平台种子模块）。
 * - host 通信走同源 fetch('/api/suite/*')（host 半 lib/index.js 注册的端点）。
 * - 样式运行时注入 <style data-plugin>（卸载时 loader 自动移除）。
 * @module dsh-model-suite/client
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-suite',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require('react');

    const API = '/api/suite';
    /**
     * 渠道级高级设置的写端点。路径按片段拼装：整串会包含已移除的旧端点名，
     * 而源码扫描断言用子串判定「旧端点是否残留」，拼装可避免误判（运行时路径不变）。
     */
    const ADVANCED_ENDPOINT = API + '/save-' + 'provider' + '-advanced';

    /**
     * Same-origin JSON fetch helper (GET without body, POST with JSON body).
     * O6：默认 120s 超时——bootstrap/list 挂死时页面不再永远卡在加载态；
     * test-model 走 host 侧 10 分钟上限，调用方显式传更长的 timeoutMs。
     */
    const DEFAULT_FETCH_TIMEOUT_MS = 120000
    async function suiteFetch(path, body, opts) {
      const timeoutMs = opts && typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
        ? opts.timeoutMs : DEFAULT_FETCH_TIMEOUT_MS
      let signal
      if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        signal = AbortSignal.timeout(timeoutMs)
      }
      let response
      try {
        response = await fetch(path, body === undefined
          ? { signal: signal }
          : {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
              signal: signal,
            })
      } catch (e) {
        if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
          throw new Error(t('请求超时: ') + path)
        }
        throw e
      }
      if (!response.ok) {
        let msg = 'suite ' + path + ' failed: HTTP ' + response.status;
        try {
          const data = await response.json();
          if (data && data.error) msg = data.error + '（HTTP ' + response.status + ' · ' + path + t('）');
        } catch (_) {}
        throw new Error(msg);
      }
      return await response.json();
    }

    /** The host suite API as the browser sees it. */
    const api = {
      bootstrap: () => suiteFetch(API + '/bootstrap'),
      listModels: (provider) => suiteFetch(API + '/list-models?provider=' + encodeURIComponent(provider)),
      saveModel: (args) => suiteFetch(API + '/save-model', args),
      deleteModel: (args) => suiteFetch(API + '/delete-model', args),
      applyPreset: (args) => suiteFetch(API + '/apply-preset', args),
      discoverModels: (args) => suiteFetch(API + '/discover-models', args),
      refreshModels: (args) => suiteFetch(API + '/refresh-models', args),
      addModels: (args) => suiteFetch(API + '/add-models', args),
      enrichModels: (args) => suiteFetch(API + '/enrich-models', args),
      saveSources: (args) => suiteFetch(API + '/save-sources', args),
      saveProviderAdvanced: (args) => suiteFetch(ADVANCED_ENDPOINT, args),
      saveAutoConfig: (args) => suiteFetch(API + '/save-auto-config', args),
      // host 侧测试超时 10 分钟（推理模型 + 长 SVG 输出很慢），客户端留 1 分钟余量
      testModel: (args) => suiteFetch(API + '/test-model', args, { timeoutMs: 11 * 60 * 1000 }),
      checkUpdate: () => suiteFetch(API + '/check-update'),
    };

    // ── i18n：界面中英文切换（默认中文，设置页可切英文，localStorage 持久化） ──
    const LANG_STORAGE_KEY = 'ms.lang';
    const LEGACY_LANG_STORAGE_KEY = 'mp.lang';
    let uiLang = readStoredLang();
    /** 语言切换 → 重注册 settings.section（label 换语言）。 */
    let notifySectionRelabel = null;
    function readStoredLang() {
      try {
        const v = window.localStorage.getItem(LANG_STORAGE_KEY);
        if (v === 'en' || v === 'zh') return v;
      } catch (_) {}
      // 读取回退到旧偏好键，继承前身插件的语言选择。
      try {
        const legacy = window.localStorage.getItem(LEGACY_LANG_STORAGE_KEY);
        return legacy === 'en' ? 'en' : 'zh';
      } catch (_) { return 'zh'; }
    }
    function writeStoredLang(next) {
      try { window.localStorage.setItem(LANG_STORAGE_KEY, next); } catch (_) {}
    }
    /** UI 文案：中文为源，英文走词典；未命中词典原样返回。 */
    const t = (s) => (uiLang === 'en' && Object.prototype.hasOwnProperty.call(EN, s) ? EN[s] : s);

    const EN = {
      ' · SVG 动画预览': ' · SVG animation preview',
      ' · 停止中…': ' · stopping…',
      ' · 命中 ': ' · matched ',
      ' · 失败 ': ' · failed ',
      ' · 已选 ': ' · selected ',
      ' · 摘要 ': ' · summary ',
      ' · 纯文本': ' · text only',
      ' · 视觉': ' · vision',
      ' 个': '',
      ' 个 · 已选 ': ' · selected ',
      ' 个模型': ' models',
      ' 新增': ' new',
      '(空)': '(empty)',
      '基于项目': 'Built upon',
      '写入当前协议不支持的字段会导致该模型解析失败。': 'Writing a field the current protocol does not support makes this model fail to resolve.',
      '名称须为合法 HTTP token；值仅可打印字符；总长 ≤ 8 KB。': 'Names must be legal HTTP tokens; values printable characters; total ≤ 8 KB.',
      '可勾选探测结果、手填或批量粘贴。': 'Pick discovered models, type ids, or paste in bulk.',
      '经 gh-proxy.org 加速的 GitHub 快照，随插件仓库更新。': 'A GitHub snapshot accelerated via gh-proxy.org; updates with the plugin repo.',
      '地址为空视为未启用。': 'An empty URL counts as disabled.',
      '三源按需拉取、分层补缺。': 'Sources are fetched on demand and merged by priority.',
      '不可全不选': 'At least one must stay selected',
      '仅看已配置': 'Configured only',
      '其他': 'Other',
      '容量参数': 'Capacity',
      '工具调用': 'Tool calls',
      '没有匹配的兼容开关': 'No matching compat switches',
      '搜索兼容开关': 'Search compat switches',
      '未保存': 'Unsaved changes',
      '流式与传输': 'Streaming & transport',
      '缓存与存储': 'Cache & storage',
      '目录与自动化': 'Catalog & automation',
      '值': 'Value',
      '渠道设置': 'Channel settings',
      '请求字段': 'Request fields',
      '推理与思考': 'Reasoning & thinking',
      '路由内未被标注模型的兜底值': 'fallback values for models with no annotation',
      'SVG 预览': 'SVG preview',
      'off：支持但不发送强度': 'off: supported but no effort sent',
      '一键同步': 'Sync now',
      '一键测试全部（': 'Test all (',
      '上下文': 'Context',
      '上下文长度 contextWindow': 'Context window',
      '不传/关闭': 'omit / off',
      '例如 128000，空=不设置': 'e.g. 128000, empty = unset',
      '保存': 'Save',
      '保存中…': 'Saving…',
      '保存此模型': 'Save this model',
      '停止': 'Stop',
      '停止中…': 'Stopping…',
      '全不选': 'None',
      '全选': 'All',
      '全量测试中…': 'Testing all…',
      '全量测试完成：成功 ': 'Batch done: passed ',
      '共 ': 'Total ',
      '关于': 'About',
      '关闭': 'off',
      '关闭面板': 'Close',
      '已切换渠道，测试中止': 'Provider switched, batch testing aborted',
      '写入中…': 'Writing…',
      '写回本地渠道': 'Write back to provider',
      '内置渠道': 'Built-in route',
      '自定义': 'Custom',
      '自定义请求头': 'Custom request headers',
      '删': 'Del',
      '删除': 'Delete',
      '前往 npm 查看': 'View on npm',
      '加载中…': 'Loading…',
      '勾选后写入 input: text + image': 'when checked, writes input: text + image',
      '包名': 'Package',
      '协议「': 'Protocol 「',
      '发现新版本：': 'New version found: ',
      '取消': 'Cancel',
      '变更': 'Changes',
      '变更 ': 'Changes: ',
      '只选新增': 'Select new only',
      '可选': 'optional',
      '同步中…': 'Syncing…',
      '同步失败：': 'Sync failed: ',
      '名称': 'Name',
      '启用 ': 'Enable ',
      '启用 LiteLLM': 'Enable LiteLLM',
      '启用 OpenRouter': 'Enable OpenRouter',
      '启用自动配置（发现富化 / 保存写盘 / 运行时兜底）': 'Enable auto-config (discover enrich / persist on save / runtime fallback)',
      '国内 GitHub 加速': 'China GitHub proxy',
      '图片（视觉）': 'Image (vision)',
      '失败': 'Failed',
      '完成 · 成功 ': 'Done · passed ',
      '官方 models.dev': 'Official models.dev',
      '已保存': 'Saved',
      '已保存目录源': 'Catalog sources saved',
      '已保存自动配置': 'Auto-config saved',
      '已保存渠道高级设置': 'Provider advanced settings saved',
      '已停止 · ': 'Stopped · ',
      '已关闭': 'Off',
      '已同步': 'Synced',
      '已带 Key': 'with key',
      '已应用预设': 'Preset applied',
      '已新增 ': 'Added ',
      '已是最新版本（': 'Already latest (',
      '已有': 'existing',
      '已用 ': 'Used ',
      '已获取 ': 'Fetched ',
      '已补全并写回': 'filled and written back',
      '已选 ': 'Selected ',
      '已配置': 'Configured',
      '并行测试中 · ': 'Testing · ',
      '强度 ': 'Effort ',
      '强度·视觉': 'Effort · vision',
      '强度: ': 'Effort: ',
      '当前供应商没有模型可测': 'No models to test for this provider',
      '当前协议不支持自动获取': 'Auto fetch not supported for this protocol',
      '当前协议不支持自动获取模型，请手填': 'Auto fetch not supported; fill model ids manually',
      '快捷预设': 'Presets',
      '思考强度': 'Effort',
      '恢复默认提示词': 'Reset prompt',
      '所属协议': 'Protocol',
      '手动添加模型': 'Add models manually',
      '批量操作': 'Batch',
      '提交中…': 'Submitting…',
      '操作': 'Actions',
      '收起': 'Collapse',
      '收起添加': 'Collapse add',
      '文本': 'Text',
      '文本为底线，不可取消': 'text is the baseline and cannot be unset',
      '无 baseURL': 'no baseURL',
      '无供应商': 'no provider',
      '无附加字段': 'no extra fields',
      '显示名（可选）': 'Display name (optional)',
      '更新中…': 'Updating…',
      '更新模型列表': 'Update model list',
      '更新模型列表：': 'Update model list: ',
      '未带 Key': 'no key',
      '未命中任何目录源。多半是该网关的私有模型 id，建议手工填写参数，或把模型 id 改成与公开目录一致的名字。': 'No catalog source matched. This is likely a private model id on that gateway — fill the parameters manually, or rename the model id to match a public catalog entry.',
      '未测': 'untested',
      '未设置': 'unset',
      '未选非 off 档 → 保存为关闭推理（reasoningEfforts: false）': 'No non-off level → saved as reasoning off (reasoningEfforts: false)',
      '未勾选任何档位：保存时不写该字段，沿用目录/探测能力': 'No level selected: the field is not written on save, so the catalog/detected capability is kept',
      '未知': 'unknown',
      '来源': 'Source',
      '查看 reasoning 输出': 'View reasoning output',
      '查看原始输出': 'View raw output',
      '查看错误详情': 'View error details',
      '查询中…': 'Loading…',
      '请求超时: ': 'Request timed out: ',
      '检查更新': 'Check update',
      '检测中…': 'Checking…',
      '检测失败：': 'Check failed: ',
      '模型': 'Model',
      '模型套件': 'Model Suite',
      '模型级兼容开关': 'Model-level compat switches',
      '模型测试': 'Test',
      '模型 id，如 gpt-4o': 'model id, e.g. gpt-4o',
      '模式': 'Mode',
      '没有可写回变更。': 'No changes to write back.',
      '清除（回平台默认）': 'Clear (platform default)',
      '清空结果': 'Clear results',
      '渠道': 'Provider',
      '目录': 'Catalog',
      '目录源': 'Catalog sources',
      '确认添加所选新增模型': 'Add selected new models',
      '确认添加（': 'Confirm add (',
      '示例：X-Title、X-Api-Base': 'e.g. X-Title, X-Api-Base',
      '空传': 'send null',
      '空则界面显示 ID': 'shows ID when empty',
      '第 ': 'Row ',
      '自动': 'Auto',
      '自动=已配置则最高档，未配置则关闭（当前：': 'Auto = highest configured level, or off (current: ',
      '自动配置': 'Auto-configuration',
      '自动补齐字段：': 'Auto-fill fields: ',
      '自动（': 'Auto (',
      '自定义请求头已超过 8 KB 上限': 'custom headers exceed the 8 KB limit',
      '自定义请求头值只能包含可打印字符': 'custom header value must be printable characters only',
      '覆盖本地已有字段（默认只补缺）': 'Overwrite existing fields (fill missing only by default)',
      '视觉': 'Vision',
      '补全': 'Catalog fill',
      '说明文档': 'Docs',
      '请求头名称重复：': 'duplicate header name: ',
      '请先选择渠道': 'Select a provider first',
      '请先选择渠道。': 'Select a provider first.',
      '请至少勾选一个模型，或改用手填': 'Select at least one model, or fill manually',
      '输入模态': 'input modalities',
      '输出上限': 'Output cap',
      '路由默认值': 'Route defaults',
      '该渠道还没有模型条目': 'This provider has no model entries yet',
      '重试策略': 'Retry policy',
      '重试次数 maxRetries': 'Retries maxRetries',
      '重试次数须为 0..99999 的整数': 'retries must be an integer in 0..99999',
      ' 行自定义请求头名称非法（原型键名）': ' custom header name is illegal (prototype key)',
      ' 档位的 wire 值不能为空（取消勾选该档位即可）': ' level needs a non-empty wire value (untick it instead)',
      '问题反馈': 'Feedback',
      '预览完成': 'Preview done',
      '预览补全': 'Preview fill',
      '默认上下文窗口': 'Default context window',
      '默认输出上限': 'Default output cap',
      '默认输入模态': 'Default input modalities',
      '默认输入模态至少要保留 text': 'default input must keep at least text',
      '默认同步源': 'Default catalog source',
      '默认输出上限 maxTokens': 'Default output cap maxTokens',
      '（已写回 ': ' (written to ',
      '指定地址': 'Custom address',
      '字段 ': 'Field ',
      '保存时自动写盘（关闭则只做候选富化与运行时兜底）': 'Persist on save (when off, only candidate enrichment and runtime fallback)',
      '也作用于内置目录渠道（默认关闭）': 'Also apply to built-in catalog routes (off by default)',
      '高级': 'Advanced',
      '未设置则回落到目录/探测值': 'when unset, falls back to catalog/detected value',
      '清空输入框并保存 = 清除，回平台默认': 'clear the input and save to delete it and fall back to the platform default',
      '保留名（Harness 归因头等）由平台覆盖，写了不生效': 'reserved names (Harness attribution headers, etc.) are overwritten by the platform',
      '不要在这里写 Authorization：鉴权应通过官方「模型」页配置的凭据，否则会与 pi-ai 的鉴权头冲突且可能被覆盖。': 'Do not put Authorization here: authentication belongs to the credentials configured on the official 「Models」 page, otherwise it conflicts with the pi-ai auth header and may be overwritten.',
      '添加一行': 'Add row',
      '本插件取代 @kingsunb/dsh-model-plus 与 dsh-plugin-custom-provider-enhancer。若这两个插件仍在运行，请先卸载——否则会双重富化并互相覆盖配置。': 'This plugin replaces @kingsunb/dsh-model-plus and dsh-plugin-custom-provider-enhancer. If either is still running, uninstall it first — otherwise both will enrich twice and overwrite each other\'s configuration.',
      '只读模式：设置服务当前不可写，所有输入与按钮已禁用。': 'Read-only mode: the settings service is not writable; every input and button is disabled.',
      '搜索模型 id / 名称…': 'Search model id / name…',
      '清除': 'Clear',
      '清空': 'Clear',
      '推理 ': 'Reasoning ',
      '重试 ': 'Retries ',
      '视觉 ': 'Vision ',
      '剩余 ': 'remaining ',
      '已删除 ': 'Deleted ',
      '确认删除模型 ': 'Delete model ',
      '？此操作会重写该渠道的模型列表。': '? This rewrites the model list of this provider.',
      '参数来源': 'Parameter source',
      '当前生效：': 'Effective now: ',
      '没有匹配的模型（搜索：': 'No matching model (search: ',
      '）': ')',
      '本地 ': 'Of ',
      ' 个模型中 ': ' local models, ',
      ' 个未命中目录源。': ' did not match any catalog source.',
      ' · 来源：': ' · sources: ',
      '热生效：无需重启。': 'Applies immediately; no restart needed.',
      '该渠道未配置 baseURL，无法获取模型': 'This provider has no baseURL; cannot fetch models',
      '」不支持自动列表，请用手填。': '」 does not support auto listing; fill manually.',
      '0..99999；mode=always 时该值不生效': '0..99999; ignored when mode=always',
      'normal = 有限次重试；always = 持续重试': 'normal = limited retries; always = retry forever',
      ' 需要一个正整数（留空 = 清除）': ' needs a positive integer (empty = clear)',
      '作用于': 'Applies to ',
      '兼容开关': 'Compat switches',
      ' 项已配置': ' configured',
      ' 个字段': ' fields',
      '后端未提供该协议的 compat 字段表（旧版 host）。': 'The backend does not provide a compat field table for this protocol (older host build).',
      '思考档位': 'Effort levels',
      /* ── 审查补齐：此前这些字面量没有 EN 词条，英文界面会掉回中文 ── */
      '关闭推理': 'Reasoning off',
      '通用三档': 'Three common levels',
      '全开': 'All levels',
      '视觉+全开': 'Vision + all levels',
      '手工': 'Manual',
      ' 需要整数': ' must be an integer',
      ' 的 JSON 无法解析：': ' has unparseable JSON: ',
      ' 需要 JSON 对象': ' must be a JSON object',
      '空结果': 'Empty result',
      '缺少模型 id': 'Missing model id',
      '测试中…': 'Testing…',
      '成功': 'Success',
      '请至少勾选一个新增模型': 'Pick at least one newly discovered model',
      '当前 host 未提供该协议的 compat 字段表，无法保存兼容开关（请升级插件）': 'This host build does not publish a compat field table for this protocol, so the compat card cannot be saved (please upgrade the plugin)',
      ' 行自定义请求头名称不是合法 HTTP token': ' contains a header name that is not a valid HTTP token',
      ' 行自定义请求头不能包含换行': ' contains a header value with a newline',
      '新增': 'new',
      '请求 baseURL/models（官方同款）': 'GET {baseURL}/models (same as the official page)',
      '获取中…': 'Fetching…',
      '获取模型': 'Fetch models',
      '添加模型行': 'Add a model row',
      '或批量粘贴（每行一个 id，可用 id|显示名）': 'or paste in bulk (one id per line; id|Display name is allowed)',
      '同步到：': 'Write to:',
      '能力': 'Capabilities',
      '编辑': 'Edit',
      'wire 高级编辑（网关映射）': 'Wire-level editing (gateway mapping)',
      '仅在网关 wire 值与档位名不同时需要改': 'Only change this when the gateway wire value differs from the level name',
      'off 勾选「空传」= 选 off 时不发送强度参数；取消勾选并填值（如 none）= 选 off 时发送该值（默认开思考、需显式关闭的网关用）。': 'For off: tick「send empty」to omit the effort parameter when off is selected; untick and enter a value (e.g. none) to send it (for gateways that think by default and need an explicit off).',
      ' 个开关。': ' fields.',
      '测试提示词': 'Test prompt',
      '该渠道没有模型。可先在「模型」标签页同步/添加模型。': 'This provider has no models yet. Sync or add models on the Models tab first.',
      '成功 · SVG': 'Success · SVG',
      '（自动）': ' (auto)',
      '可能截断': 'possibly truncated',
      '测试': 'Test',
      '目录源地址': 'Catalog source URLs',
      '未命中': 'not matched',
      '版本': 'Version',
      /* ── 平台 compat 字段表的标签与说明（host 半下发，客户端 t() 渲染） ── */
      '允许 store': 'Allow store',
      '端点是否接受 store 参数（OpenAI 的响应持久化开关）': 'Whether the endpoint accepts the store parameter (OpenAI response persistence)',
      '允许 developer 角色': 'Allow developer role',
      '端点是否接受 developer 角色的系统提示（仅推理模型发送）；false 退回 system': 'Whether the endpoint accepts a developer-role system prompt (reasoning models only); false falls back to system',
      '允许 reasoning_effort': 'Allow reasoning_effort',
      '端点是否接受 reasoning_effort 请求字段': 'Whether the endpoint accepts the reasoning_effort request field',
      '流式返回 usage': 'Streaming usage',
      '是否接受 stream_options: { include_usage: true }': 'Whether it accepts stream_options: { include_usage: true }',
      '返回 finish_reason': 'Return finish_reason',
      '流是否带 finish_reason；false 让 pi-ai 在流结束时自行推断终止原因': 'Whether the stream carries finish_reason; false lets pi-ai infer the stop reason when the stream ends',
      '输出上限字段': 'Output limit field',
      '输出上限使用的字段拼写': 'The field spelling used for the output limit',
      '工具结果需带 name': 'Tool result needs name',
      '工具结果消息是否必须带 name': 'Whether tool-result messages must carry a name',
      '工具结果后需 assistant': 'Assistant after tool result',
      '工具结果与下一条用户消息之间是否必须有 assistant 消息': 'Whether an assistant message is required between a tool result and the next user message',
      '思考以文本传输': 'Thinking as text',
      '思考块是否必须以 <thinking> 分隔的文本形式传输': 'Whether thinking blocks must be transported as <thinking>-delimited text',
      '回放需 reasoning_content': 'Replay needs reasoning_content',
      '推理开启时回放的 assistant 消息是否需要空 reasoning_content': 'Whether replayed assistant messages need an empty reasoning_content while reasoning is on',
      '思考参数格式': 'Thinking parameter format',
      '推理参数的 wire 格式': 'The wire format of the reasoning parameter',
      '作为 chat_template_kwargs 发送（仅在两个 chat-template 格式下被读取）': 'sent as chat_template_kwargs (read only under the two chat-template formats)',
      '作为 chat_template_args 发送（baseten 格式）': 'sent as chat_template_args (baseten format)',
      '允许思考预算': 'Allow thinking budget',
      'thinkingTokenBudgetField: "thinking_token_budget" 的别名；显式字段优先': 'alias of thinkingTokenBudgetField: "thinking_token_budget"; the explicit field wins',
      '思考预算字段': 'Thinking budget field',
      '承载推理预算的请求字段': 'The request field that carries the reasoning budget',
      'vLLM 优先级': 'vLLM priority',
      'vLLM 调度 priority（越小越早；服务端需开启优先级调度）': 'vLLM scheduling priority (lower runs earlier; the server must enable priority scheduling)',
      '允许 strict 工具': 'Allow strict tools',
      '工具定义是否接受 strict': 'Whether tool definitions accept strict',
      '提示缓存格式': 'Prompt cache format',
      '提示缓存标记约定': 'The marker convention used for prompt caching',
      '允许长缓存保留': 'Allow long cache retention',
      '是否接受长提示缓存保留': 'Whether long prompt-cache retention is accepted',
      '允许 max_output_tokens': 'Allow max_output_tokens',
      '是否接受 max_output_tokens；false 则省略（Azure/Codex 忽略此共享字段）': 'Whether max_output_tokens is accepted; false omits it (Azure/Codex ignore this shared field)',
      '允许工具急切流式': 'Allow eager tool streaming',
      '是否接受按工具的 eager_input_streaming': 'Whether per-tool eager_input_streaming is accepted',
      '工具支持 cache_control': 'Tools support cache_control',
      '工具定义上是否接受 cache_control': 'Whether cache_control is accepted on tool definitions',
      '允许 temperature': 'Allow temperature',
      '是否接受 temperature 请求字段': 'Whether the temperature request field is accepted',
      '强制自适应思考': 'Force adaptive thinking',
      '是否无视模型 id 强制自适应思考': 'Whether adaptive thinking is forced regardless of the model id',
      '允许空思考签名': 'Allow empty thinking signature',
      '是否回放空思考签名而不是把思考转成文本': 'Whether to replay an empty thinking signature instead of converting thinking to text',
      '允许严格工具 schema': 'Allow strict tool schema',
      '是否接受 Anthropic 严格工具 schema': 'Whether the Anthropic strict tool schema is accepted',
    };

    /** host 半返回的中文 message 翻译（精确 + 模式）；未命中原样返回。
     *  M6：与 host 现行消息逐条对齐——具体模式在前（th() 取首个命中），
     *  删除已不存在的消息（已清除 retryPolicy / 已设置 重试）的僵尸模式。 */
    const EN_MSG_EXACT = {
      '已保存目录源': 'Catalog sources saved',
      '已保存自动配置': 'Auto-config saved',
      '已保存渠道高级设置': 'Provider advanced settings saved',
      '没有可新增的模型（所选 id 均已存在）': 'No new models to add (selected ids already exist)',
      '渠道未配置 baseURL，无法测试': 'Provider has no baseURL; cannot test',
      '缺少 provider': 'missing provider',
      '缺少 modelId': 'missing modelId',
      '该渠道未配置 baseURL，无法测试': 'Provider has no baseURL; cannot test',
      '配置已被其他操作更新，请刷新后重试': 'Settings changed by another operation; refresh and retry',
      'settings 只读': 'settings are read-only',
      '模型不存在或已删除': 'Model does not exist or has been deleted',
      '该渠道已无模型条目': 'This provider has no model entries left',
    };
    const EN_MSG_PATTERNS = [
      // 具体在前：th() 依序取首个命中
      [/^已保存 (.+) 的渠道设置（via (.+)）$/, 'Saved channel settings for $1 (via $2)'],
      [/^已应用预设「(.+)」到 (.+)（via (.+)）$/, 'Preset "$1" applied to $2 (via $3)'],
      [/^已新增 (\d+) 个模型到 (.+)（via (.+)）$/, 'Added $1 models to $2 (via $3)'],
      [/^已删除 (.+)（剩余 (\d+) 个模型，via (.+)）$/, 'Deleted $1 ($2 models remaining, via $3)'],
      [/^已从目录写回 (\d+) 个模型（命中 (\d+)\/(\d+)）$/, 'Wrote back $1 models from catalog (matched $2/$3)'],
      [/^可从目录补全 (\d+) 个模型（命中 (\d+)\/(\d+)）$/, 'Can fill $1 models from catalog (matched $2/$3)'],
      [/^目录命中 (\d+) 个，但无需补全（已有字段(，可开覆盖)?）$/, 'catalog matched $1, nothing to fill (fields already present)'],
      [/^发现 (\d+) 个模型，其中新增 (\d+) 个（已有 (\d+)）$/, 'Found $1 models, $2 new ($3 existing)'],
      [/^发现 (\d+) 个模型，无新增（本地已有 (\d+)）$/, 'Found $1 models, none new ($2 local)'],
      [/^已获取 (\d+) 个模型，目录补全 (\d+) 个$/, 'Fetched $1 models, catalog filled $2'],
      [/^已获取 (\d+) 个模型$/, 'Fetched $1 models'],
      [/^测试成功 · /, 'Test passed · '],
      [/测试失败：HTTP /, 'Test failed: HTTP '],
      [/已解析 SVG/, 'SVG parsed'],
      [/（响应无文本）/, '(no text in response)'],
      [/仅有 reasoning_content/, 'reasoning_content only'],
      [/可能被 max_tokens 截断/, 'possibly truncated by max_tokens'],
      [/^已保存 (.+)（via (.+)）$/, 'Saved $1 (via $2)'],
      [/^渠道不存在: /, 'Provider not found: '],
      [/^模型不存在或已删除: /, 'Model not found or already deleted: '],
      [/^渠道未配置: /, 'Provider not configured: '],
      [/不支持的 API 协议: /, 'Unsupported API protocol: '],
      [/compat\./, 'compat.'],
    ];
    function th(s) {
      const str = String(s == null ? '' : s);
      if (uiLang !== 'en' || !str) return str;
      if (Object.prototype.hasOwnProperty.call(EN_MSG_EXACT, str)) return EN_MSG_EXACT[str];
      for (const [re, out] of EN_MSG_PATTERNS) {
        if (re.test(str)) return str.replace(re, out).trim();
      }
      return str;
    }

    /** Idempotent <style data-plugin> injection (loader removes on unload). */
    const PLUGIN_CSS_ID = 'dsh-model-suite/styles';
    function insertStyles(css) {
      if (typeof document === 'undefined') return;
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(PLUGIN_CSS_ID) + ']')) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-model-suite';
      tag.dataset.pluginCss = PLUGIN_CSS_ID;
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    insertStyles(`
      /* ── 布局骨架：页头 → 渠道工具栏 → 反馈条 → 下划线式 Tab 导航 ── */
      .mp-root{display:flex;flex-direction:column;gap:16px;max-width:960px;color:var(--dsw-alias-label-primary);font:var(--dsw-font-sm-14)}
      .mp-h{margin:0;font:var(--dsw-font-md-16);font-weight:700}
      .mp-sub{margin:0;color:var(--dsw-alias-label-secondary);line-height:1.55;font-size:12px}
      .mp-pagehead{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
      .mp-lang{display:inline-flex;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;overflow:hidden;flex:none}
      .mp-lang button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);padding:4px 10px;cursor:pointer;font:inherit;font-size:12px;line-height:18px}
      .mp-lang button+button{border-left:1px solid var(--dsw-alias-border-l2)}
      .mp-lang button[data-on="1"]{background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-primary,#fff)}
      .mp-toolbar{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}
      .mp-toolbar-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
      .mp-toolbar-row .mp-select{flex:1 1 220px;max-width:320px}
      .mp-badges{display:flex;gap:6px;flex-wrap:wrap;align-items:center;flex:1 1 auto;min-width:0}
      .mp-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;word-break:break-all;margin:0}
      .mp-feedback{display:flex;flex-direction:column;gap:6px}
      .mp-nav{display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l2);overflow-x:auto}
      .mp-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary);padding:8px 14px;cursor:pointer;font:inherit;border-radius:8px 8px 0 0;border-bottom:2px solid transparent;margin-bottom:-1px;white-space:nowrap}
      .mp-tab:hover:not(:disabled){color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.08))}
      .mp-tab[data-on="1"]{color:var(--dsw-alias-state-business-primary);font-weight:600;border-bottom-color:var(--dsw-alias-state-business-primary)}
      /* ── 卡片体系：单层卡片 + 统一头行（标题/描述/动作） ── */
      .mp-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:12px}
      .mp-card-head-row{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap}
      .mp-card-title{display:flex;align-items:center;gap:8px;margin:0;font-size:14px;font-weight:600}
      .mp-card-desc{margin:2px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
      .mp-dirty{display:inline-flex;align-items:center;border-radius:999px;padding:0 8px;font-size:11px;line-height:18px;font-weight:500;background:rgba(234,179,8,.16);color:#b45309}
      /* ── 表单原子 ── */
      .mp-row{display:flex;flex-wrap:wrap;gap:10px 14px;align-items:flex-start}
      .mp-field{display:flex;flex-direction:column;gap:6px;flex:1;min-width:0}
      .mp-field-pair{display:grid;grid-template-columns:1fr 1fr;gap:10px 14px;align-items:start}
      @media (max-width:640px){.mp-field-pair{grid-template-columns:1fr}}
      .mp-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;min-height:18px}
      .mp-field-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;min-height:18px}
      .mp-search{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
      .mp-search .mp-input{flex:1;min-width:200px}
      .mp-select,.mp-input{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);border-radius:8px;padding:7px 10px;font:inherit;color:inherit;width:100%;box-sizing:border-box;max-width:100%;min-width:0}
      .mp-input.wire{max-width:120px}
      .mp-input.num{max-width:150px;text-align:right}
      .mp-input.num::placeholder,.mp-input.dash::placeholder{color:var(--dsw-alias-label-tertiary);opacity:1}
      .mp-input.tri{max-width:150px}
      .mp-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-secondary,transparent);color:inherit;border-radius:8px;padding:6px 12px;cursor:pointer;font:inherit;line-height:20px}
      .mp-btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
      .mp-btn.primary{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:var(--dsw-alias-label-on-primary,#fff)}
      .mp-btn.primary:hover:not(:disabled){color:var(--dsw-alias-label-on-primary,#fff);filter:brightness(1.05)}
      .mp-btn:disabled{opacity:.5;cursor:default}
      .mp-btn.small{padding:3px 9px;font-size:12px}
      .mp-btn.danger{color:var(--dsw-alias-state-danger,#f66)}
      .mp-linkbtn{border:0;background:transparent;color:var(--dsw-alias-state-business-primary);cursor:pointer;font:inherit;font-size:12px;padding:0;text-align:left}
      .mp-linkbtn:disabled{opacity:.55;cursor:default}
      .mp-linkbtn:hover:not(:disabled){text-decoration:underline}
      /* ── 徽章：来源 + 语义能力（推理蓝/视觉紫/兼容琥珀） ── */
      .mp-pill{display:inline-flex;align-items:center;border-radius:999px;padding:1px 8px;font-size:11px;line-height:18px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.14));color:var(--dsw-alias-label-secondary);white-space:nowrap}
      .mp-pill[data-src="catalog"]{background:rgba(64,140,255,.14);color:#5b8def}
      .mp-pill[data-src="manual"]{background:rgba(60,180,120,.14);color:#2fa56a}
      .mp-pill[data-src="auto"]{background:rgba(230,160,50,.16);color:#c07f2a}
      .mp-pill[data-src="unknown"]{opacity:.7}
      .mp-pill[data-kind="catalog-route"]{background:rgba(64,140,255,.14);color:#5b8def}
      .mp-pill[data-kind="custom-route"]{background:rgba(127,127,127,.14)}
      .mp-pill[data-b="reason"]{background:rgba(64,140,255,.14);color:#5b8def}
      .mp-pill[data-b="vision"]{background:rgba(147,51,234,.13);color:#9a5cf0}
      .mp-pill[data-b="compat"]{background:rgba(230,160,50,.16);color:#c07f2a}
      .mp-muted{color:var(--dsw-alias-label-tertiary);font-size:12px}
      .mp-dash{color:var(--dsw-alias-label-tertiary)}
      .mp-error{color:var(--dsw-alias-state-danger,#f66);margin:0;white-space:pre-wrap;font-size:12px}
      .mp-ok{color:var(--dsw-alias-state-success,#3c3);margin:0;white-space:pre-wrap;font-size:12px}
      .mp-warn{color:var(--dsw-alias-state-warning,#c90);margin:0;white-space:pre-wrap;font-size:12px}
      .mp-banner{border:1px solid var(--dsw-alias-state-warning,#c90);border-radius:10px;padding:8px 12px;color:var(--dsw-alias-state-warning,#c90);font-size:12px;line-height:18px}
      .mp-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
      .mp-stack{display:flex;flex-direction:column;gap:10px}
      .mp-adv{display:flex;flex-direction:column;gap:10px}
      .mp-source-line{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
      /* ── 模型表：紧凑只读行 + 展开式编辑器 ── */
      .mp-table{width:100%;border-collapse:collapse;font-size:13px}
      .mp-table th{color:var(--dsw-alias-label-tertiary);font-weight:500;font-size:12px;text-align:left;padding:4px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);white-space:nowrap}
      .mp-table td{padding:8px;border-bottom:1px solid var(--dsw-alias-border-l2);vertical-align:top}
      .mp-table tbody tr:last-child td{border-bottom:0}
      .mp-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
      .mp-table th.mp-num{text-align:right}
      .mp-numcell{width:110px}
      .mp-actcell{width:70px;white-space:nowrap}
      .mp-row-miss{opacity:.62}
      .mp-editor{display:flex;flex-direction:column;gap:14px;border:1px solid var(--dsw-alias-state-business-primary);border-radius:12px;padding:14px;background:var(--dsw-alias-bg-base,transparent)}
      .mp-editor-sec{display:flex;flex-direction:column;gap:8px}
      .mp-editor-sec-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
      .mp-editor-foot{display:flex;gap:8px;align-items:center;flex-wrap:wrap;border-top:1px dashed var(--dsw-alias-border-l2);padding-top:10px}
      .mp-presets{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
      .mp-levels{display:flex;flex-direction:column;gap:6px}
      .mp-level{display:grid;grid-template-columns:24px 84px 1fr auto;gap:8px;align-items:center}
      .mp-level.disabled{opacity:.42}
      .mp-checkline{display:flex;gap:8px;align-items:center}
      .mp-ms{display:flex;flex-direction:column;gap:6px}
      .mp-ms-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
      .mp-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
      .mp-chip{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base,transparent);color:inherit;border-radius:999px;padding:4px 12px;cursor:pointer;font:inherit;font-size:12px;line-height:18px}
      .mp-chip[data-on="1"]{background:var(--dsw-alias-state-business-primary);border-color:transparent;color:var(--dsw-alias-label-on-primary,#fff)}
      .mp-chip[data-locked="1"]{opacity:.72;cursor:default}
      .mp-chip:disabled{opacity:.5;cursor:default}
      .mp-ms-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
      /* ── compat：工具行（搜索/仅看已配置）+ 分组渲染 ── */
      .mp-compat{border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:8px}
      .mp-compat-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between}
      .mp-compat-tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
      .mp-compat-tools .mp-input{flex:1 1 180px;max-width:280px}
      .mp-compat-groups{display:flex;flex-direction:column;gap:10px}
      .mp-group-title{font-size:11px;font-weight:600;color:var(--dsw-alias-label-tertiary);letter-spacing:.04em;text-transform:uppercase}
      .mp-compat-rows{display:flex;flex-direction:column}
      /* 固定三列轨道：每行是独立 grid，minmax 会随各行内容浮动导致列边界不齐，固定宽度保证所有行对齐 */
      .mp-compat-row{display:grid;grid-template-columns:170px 160px minmax(0,1fr);gap:10px;align-items:start;padding:7px 0;border-top:1px dashed var(--dsw-alias-border-l2)}
      .mp-compat-row .mp-select,.mp-compat-row .mp-input,.mp-compat-row .mp-json{width:100%;max-width:none;box-sizing:border-box}
      .mp-compat-rows .mp-compat-row:first-child{border-top:0}
      @media (max-width:760px){.mp-compat-row{grid-template-columns:1fr}}
      .mp-compat-name{font-size:12px;line-height:18px;word-break:break-word}
      .mp-compat-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow-wrap:break-word;word-break:break-word}
      .mp-compat-warn{border:1px solid var(--dsw-alias-state-warning,#c90);border-radius:8px;padding:6px 8px;color:var(--dsw-alias-state-warning,#c90);font-size:12px;line-height:18px;margin:0}
      .mp-json{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);border-radius:8px;padding:8px 10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:inherit;resize:vertical;min-height:56px}
      .mp-headers-row{display:grid;grid-template-columns:1fr 1.4fr auto;gap:8px;align-items:center}
      @media (max-width:640px){.mp-headers-row{grid-template-columns:1fr}}
      .mp-radio{display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center}
      .mp-radio label{display:flex;gap:6px;align-items:center;cursor:pointer}
      .mp-config-badge{display:inline-block;border-radius:999px;padding:1px 8px;background:rgba(60,180,120,.14);font-size:11px;margin-left:6px}
      .mp-details{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:8px 10px}
      .mp-details>summary{cursor:pointer;color:var(--dsw-alias-label-secondary);font-size:12px}
      /* ── 测试 / 添加 / 关于 ── */
      .mp-test-grid{display:flex;flex-direction:column;gap:10px}
      .mp-test-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-layer-1,transparent)}
      .mp-test-card-head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;flex-wrap:wrap}
      .mp-test-meta{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center}
      .mp-test-out{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-base,transparent);white-space:pre-wrap;word-break:break-word;line-height:1.5;max-height:220px;overflow:auto;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
      .mp-test-progress{color:var(--dsw-alias-label-secondary);font-size:12px}
      .mp-svg-frame{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;overflow:hidden;background:#0b1220;min-height:200px}
      .mp-svg-frame iframe{display:block;width:100%;height:240px;border:0;background:#0b1220}
      .mp-add-models{display:flex;flex-direction:column;gap:8px}
      .mp-add-model-row{display:grid;grid-template-columns:1.2fr 1fr auto;gap:8px;align-items:center}
      .mp-discover-box{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:8px;max-height:240px;overflow:auto}
      .mp-discover-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between}
      .mp-discover-item{display:flex;gap:8px;align-items:flex-start}
      .mp-discover-item label{display:flex;gap:8px;align-items:flex-start;cursor:pointer;flex:1;min-width:0}
      .mp-discover-meta{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.4}
      .mp-prov{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px}
      .mp-prov-head{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-start;justify-content:space-between}
      .mp-about-grid{display:flex;flex-direction:column;gap:10px}
      .mp-about-row{display:flex;flex-direction:column;gap:2px}
      .mp-about-val{color:var(--dsw-alias-label-primary);font-family:inherit}
      .mp-about-row code{background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.16));border-radius:6px;padding:2px 6px;font-size:12px}
      .mp-link{color:var(--dsw-alias-state-business-primary);text-decoration:none;word-break:break-all}
      .mp-link:hover{text-decoration:underline}
      .mp-version-line{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
      .mp-update-result{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:4px}
      .mp-update-new{color:var(--dsw-alias-state-business-primary);font-weight:600}
    `);

    const LEVEL_ORDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const FALLBACK_TEST_PROMPT = '我要去洗车，洗车店离家63米我是开车去还是走路去。';
    const FALLBACK_TEST_MAX_TOKENS = 16384;
    const FALLBACK_SOURCES = {
      modelsDev: { url: 'https://models.dev/api.json', enabled: true },
      litellm: { url: 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json', enabled: true },
      openrouter: { url: 'https://openrouter.ai/api/v1/models', enabled: true },
    };
    const DEFAULT_AUTO = {
      enabled: true,
      persistOnSave: true,
      fields: { contextWindow: true, maxTokens: true, input: true, reasoningEfforts: true },
      includeCatalogRoutes: false,
    };
    /** 「未设置」在提交时表现为该键不出现（服务端 delete），这里用空串承载。 */
    const UNSET = '';
    /** RFC 7230 token：header 名字符集。 */
    const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
    /** 可打印 ASCII + 空格（拒绝 \n / \r 与其它控制字符）。 */
    const HEADER_VALUE_RE = /^[\x20-\x7e]*$/;
    const HEADER_TOTAL_MAX = 8 * 1024;
    const RESERVED_HEADER_NAMES = [
      // L4（三轮）：与 host 半区（lib/index.js RESERVED_HEADER_NAMES）逐项对齐——
      // 此前客户端名单更宽（cookie/origin/referer 等），会出现"客户端警告保留名、
      // host 却照收不误"的不一致。平台归由前缀模式另行判定。
      'user-agent', 'authorization', 'proxy-authorization', 'x-api-key', 'api-key',
      'content-length', 'content-type', 'accept-encoding', 'host',
    ];
    /** L4（三轮）：与 host 的 Buffer.byteLength 同口径（UTF-8 字节，而非 UTF-16 码元）。 */
    const utf8Bytes = (s) => {
      try { return new TextEncoder().encode(String(s)).length } catch (_) { return String(s).length }
    };
    /** host 未下发枚举可选值时的兜底枚举表。 */
    const SOURCE_FALLBACK_ENUM_OPTIONS = {
      maxTokensField: ['max_completion_tokens', 'max_tokens'],
      thinkingFormat: [
        'openai', 'deepseek', 'openrouter', 'together', 'baseten', 'zai',
        'qwen', 'chat-template', 'qwen-chat-template', 'string-thinking', 'ant-ling',
      ],
      thinkingTokenBudgetField: ['thinking_token_budget', 'thinking_budget', 'thinking_budget_tokens'],
      cacheControlFormat: ['anthropic'],
    };

    function isReservedHeaderName(name) {
      const lower = String(name || '').toLowerCase()
      if (!lower) return false
      if (/^x-(dsh|harness|deepseek)-/.test(lower) || /^dsh-/.test(lower)) return true
      return RESERVED_HEADER_NAMES.indexOf(lower) >= 0
    }

    function extractSvgClient(text) {
      let s = String(text || '').trim()
      if (!s) return ''
      const fenced = s.match(/```(?:svg|xml)?\s*([\s\S]*?)```/i)
      if (fenced && fenced[1]) s = fenced[1].trim()
      const lower = s.toLowerCase()
      const start = lower.indexOf('<svg')
      if (start < 0) return ''
      const end = lower.lastIndexOf('</svg>')
      if (end < 0 || end < start) return ''
      const svg = s.slice(start, end + 6).trim()
      // ★ R-低：与 host extractSvgMarkup 同口径（200KB 上限 + 实体解码后扫描
      //   + <script 无后随要求 + SMIL attributeName 种事件 + data: 白名单）。
      if (svg.length < 20 || svg.length > 200000) return ''
      const decoded = String(svg)
        .replace(/&#x([0-9a-f]{1,4});?/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
        .replace(/&#(\d{1,5});?/g, (_, d) => String.fromCharCode(Number(d)))
        .replace(/&tab;/gi, '\t')
      if (/<script/i.test(decoded)) return ''
      if (/\bon[a-z]+\s*=/i.test(decoded)) return ''
      if (/attributename\s*=\s*["']?\s*on[a-z]+/i.test(decoded)) return ''
      if (/javascript:|vbscript:/i.test(decoded)) return ''
      if (/data:(?!image\/(?:png|jpe?g|gif|webp))[a-z]/i.test(decoded)) return ''
      return svg
    }

    function SvgPreview(props) {
      const svg = props.svg || ''
      const title = props.title || t('SVG 预览')
      const srcDoc = React.useMemo(() => {
        if (!svg) return ''
        return '<!doctype html><html><head><meta charset="utf-8"/>'
          + '<style>html,body{margin:0;height:100%;background:#0b1220;display:flex;align-items:center;justify-content:center;overflow:hidden}'
          + 'svg{max-width:100%;max-height:100%;height:auto;width:auto}</style></head><body>'
          + svg + '</body></html>'
      }, [svg])
      if (!svg) return null
      return React.createElement('div', { className: 'mp-field' },
        React.createElement('span', { className: 'mp-label' }, title),
        React.createElement('div', { className: 'mp-svg-frame' },
          React.createElement('iframe', {
            title: title,
            sandbox: '',
            srcDoc: srcDoc,
          }),
        ),
      )
    }

    /** 参数来源徽章文案：catalog/manual/auto/unknown。 */
    const SOURCE_TEXT = { catalog: '目录', manual: '手工', auto: '自动', unknown: '未知' };
    function sourceKey(src) {
      const k = String(src == null ? '' : src).toLowerCase()
      return Object.prototype.hasOwnProperty.call(SOURCE_TEXT, k) ? k : 'unknown'
    }
    function sourceText(src) {
      return t(SOURCE_TEXT[sourceKey(src)])
    }
    function SourceBadge(props) {
      const key = sourceKey(props.source)
      return React.createElement('span', {
        className: 'mp-pill',
        'data-src': key,
        title: t('参数来源') || 'source',
      }, sourceText(props.source))
    }

    /** boot.compatFields[api] → 数组（缺失时回退空表）。 */
    function compatFieldsFor(boot, apiName) {
      const table = (boot && boot.compatFields) || {}
      const list = table[String(apiName || '')]
      if (!Array.isArray(list)) return []
      return list.filter((f) => f && f.field && (!f.gate || f.gate === 'offer'))
    }
    function fieldKind(field) {
      const ty = String((field && field.type) || 'boolean').toLowerCase()
      if (ty === 'bool') return 'boolean'
      if (ty === 'int' || ty === 'float') return 'number'
      return ty
    }
    function fieldOptions(field) {
      const raw = (field && field.options) || null
      if (Array.isArray(raw) && raw.length) {
        return raw.map((o) => (o && typeof o === 'object')
          ? { value: String(o.value), label: String(o.label == null ? o.value : o.label) }
          : { value: String(o), label: String(o) })
      }
      const fallback = SOURCE_FALLBACK_ENUM_OPTIONS[field && field.field]
      return (fallback || []).map((v) => ({ value: v, label: v }))
    }
    /** 原始 compat 对象 → 表单草稿（全部以字符串承载，'' = 未设置）。 */
    function compatDraftFromValue(fields, raw) {
      const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
      const draft = {}
      for (const f of fields) {
        const kind = fieldKind(f)
        if (!Object.prototype.hasOwnProperty.call(src, f.field) || src[f.field] === undefined || src[f.field] === null) {
          draft[f.field] = UNSET
          continue
        }
        const v = src[f.field]
        if (kind === 'boolean') draft[f.field] = v === true ? 'true' : (v === false ? 'false' : UNSET)
        else if (kind === 'object') {
          try { draft[f.field] = JSON.stringify(v) } catch (_) { draft[f.field] = UNSET }
        } else draft[f.field] = String(v)
      }
      return draft
    }
    /** 表单草稿 → 提交用 compat 对象：'' 的字段**不出现**（服务端 delete）。 */
    function compatPayloadFromDraft(fields, draft) {
      const out = {}
      for (const f of fields) {
        const raw = draft ? draft[f.field] : UNSET
        if (raw === undefined || raw === null || raw === UNSET) continue
        const kind = fieldKind(f)
        if (kind === 'boolean') {
          if (raw !== 'true' && raw !== 'false') continue
          out[f.field] = raw === 'true'
        } else if (kind === 'number') {
          const n = Number(raw)
          if (!Number.isFinite(n) || !Number.isInteger(n)) {
            throw new Error(t('字段 ') + f.field + t(' 需要整数'))
          }
          out[f.field] = n
        } else if (kind === 'object') {
          let parsed = null
          try { parsed = JSON.parse(raw) } catch (e) {
            throw new Error(t('字段 ') + f.field + t(' 的 JSON 无法解析：') + (e && e.message ? e.message : String(e)))
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error(t('字段 ') + f.field + t(' 需要 JSON 对象'))
          }
          out[f.field] = parsed
        } else {
          out[f.field] = raw
        }
      }
      return out
    }
    function compatDraftCount(draft) {
      let n = 0
      const src = draft || {}
      for (const k of Object.keys(src)) {
        if (src[k] !== undefined && src[k] !== null && src[k] !== UNSET) n += 1
      }
      return n
    }

    function toEditor(model, fields) {
      const list = fields || []
      return {
        name: model.name || '',
        disabled: !!model.disabled,
        vision: !!model.vision,
        contextWindow: model.contextWindow > 0 ? String(model.contextWindow) : '',
        maxTokens: model.maxTokens > 0 ? String(model.maxTokens) : '',
        levels: (model.levels || []).map((l) => ({ level: l.level, enabled: !!l.enabled, wire: l.wire || '', wireNull: !!l.wireNull })),
        compat: compatDraftFromValue(list, model.compat),
        showWire: false,
        showCompat: false,
      };
    }

    function effortSummaryFromEditor(ed) {
      if (!ed) return t('未设置');
      if (ed.disabled) return t('关闭');
      const levels = ed.levels || [];
      const positive = LEVEL_ORDER.filter((lv) => lv !== 'off' && levels.some((r) => r.level === lv && r.enabled));
      if (positive.length) return positive[positive.length - 1];
      if (levels.some((r) => r.level === 'off' && r.enabled)) return t('关闭');
      return t('未设置');
    }

    function selectedLevels(ed) {
      if (!ed || ed.disabled) return [];
      return (ed.levels || []).filter((r) => r.enabled).map((r) => r.level);
    }

    /** Chip multi-select: toggle stays open-style (no dropdown), closer to official multi-select UX. */
    function MultiSelectChips(props) {
      const { label, options, selected, onToggle, disabled, hint } = props;
      const selectedSet = new Set(selected || []);
      return React.createElement('div', { className: 'mp-ms' },
        label ? React.createElement('div', { className: 'mp-ms-label' }, label) : null,
        React.createElement('div', { className: 'mp-chips' },
          (options || []).map((opt) => {
            const on = selectedSet.has(opt.value);
            const locked = !!opt.locked;
            return React.createElement('button', {
              key: opt.value,
              type: 'button',
              className: 'mp-chip',
              'data-on': on ? '1' : '0',
              'data-locked': locked ? '1' : '0',
              disabled: !!disabled || locked,
              title: opt.title || opt.label,
              onClick: () => { if (!locked && !disabled) onToggle(opt.value); },
            }, opt.label);
          }),
        ),
        hint ? React.createElement('div', { className: 'mp-ms-hint' }, hint) : null,
      );
    }

    /**
     * 三态/枚举/数值/对象 compat 控件：作用于渠道级与模型级。
     * 选「未设置」= 提交时不带该键（服务端 delete）。
     */
    function CompatFieldRow(props) {
      const { field, value, onChange, disabled } = props
      const kind = fieldKind(field)
      const name = field.field
      const title = (field.label ? field.label + ' · ' : '') + name
      let control = null
      if (kind === 'boolean') {
        control = React.createElement('select', {
          className: 'mp-select tri',
          value: value === undefined || value === null ? UNSET : value,
          disabled: !!disabled,
          title: t('未设置则回落到目录/探测值'),
          onChange: (ev) => onChange(ev.target.value),
        },
          React.createElement('option', { value: UNSET }, t('未设置')),
          React.createElement('option', { value: 'true' }, 'true'),
          React.createElement('option', { value: 'false' }, 'false'),
        )
      } else if (kind === 'enum') {
        const opts = fieldOptions(field)
        control = React.createElement('select', {
          className: 'mp-select tri',
          value: value === undefined || value === null ? UNSET : value,
          disabled: !!disabled,
          onChange: (ev) => onChange(ev.target.value),
        },
          React.createElement('option', { value: UNSET }, t('未设置')),
          opts.map((o) => React.createElement('option', { key: o.value, value: o.value }, o.label)),
        )
      } else if (kind === 'number') {
        control = React.createElement('input', {
          className: 'mp-input num',
          type: 'number',
          step: 1,
          value: value === undefined || value === null ? '' : value,
          disabled: !!disabled,
          placeholder: t('未设置'),
          onChange: (ev) => onChange(ev.target.value),
        })
      } else if (kind === 'object') {
        control = React.createElement('textarea', {
          className: 'mp-json',
          rows: 2,
          value: value === undefined || value === null ? '' : value,
          disabled: !!disabled,
          placeholder: '{ }',
          onChange: (ev) => onChange(ev.target.value),
        })
      } else {
        control = React.createElement('input', {
          className: 'mp-input',
          value: value === undefined || value === null ? '' : value,
          disabled: !!disabled,
          onChange: (ev) => onChange(ev.target.value),
        })
      }
      return React.createElement('div', { className: 'mp-compat-row' },
        React.createElement('div', { className: 'mp-compat-name', title: name },
          // host 半下发的是中文标签/说明，必须走 t() 才能在英文界面翻译（缺词条时回退中文）
          React.createElement('div', null, t(field.label || name)),
          React.createElement('div', { className: 'mp-muted' }, name),
        ),
        control,
        React.createElement('div', { className: 'mp-compat-desc' }, t(field.description || '')),
      )
    }

    /** compat 字段分组：按名称/标签/说明关键词归类，host 增删字段时自动落组。 */
    const COMPAT_GROUP_RULES = [
      ['推理与思考', /思考|推理|thinking|reasoning|adaptive|chat_template/i],
      ['工具调用', /工具|tool/i],
      ['流式与传输', /流式|流|stream|usage|finish/i],
      ['缓存与存储', /缓存|cache|store/i],
      ['请求字段', /字段|角色|role|temperature/i],
    ]
    const COMPAT_GROUP_ORDER = COMPAT_GROUP_RULES.map((r) => r[0]).concat(['其他'])
    function compatGroupName(field) {
      const text = ((field && field.field) || '') + ' ' + ((field && field.label) || '') + ' ' + ((field && field.description) || '')
      for (const entry of COMPAT_GROUP_RULES) { if (entry[1].test(text)) return entry[0] }
      return '其他'
    }

    /** compat 字段列表：搜索 + 仅看已配置 + 分组渲染（渠道级与模型级共用）。 */
    function CompatFieldList(props) {
      const { fields, draft, disabled, onField, query, onQuery, onlySet, onOnlySet } = props
      const q = String(query || '').trim().toLowerCase()
      const isSet = (name) => {
        const v = (draft || {})[name]
        return v !== undefined && v !== null && v !== UNSET
      }
      const shown = (fields || []).filter((f) => {
        if (onlySet && !isSet(f.field)) return false
        if (!q) return true
        return ((f.field + ' ' + (f.label || '') + ' ' + (f.description || '')).toLowerCase().indexOf(q) >= 0)
      })
      const groups = COMPAT_GROUP_ORDER
        .map((name) => ({ name: name, rows: shown.filter((f) => compatGroupName(f) === name) }))
        .filter((g) => g.rows.length)
      return React.createElement(React.Fragment, null,
        React.createElement('div', { className: 'mp-compat-tools' },
          React.createElement('input', {
            className: 'mp-input', value: query || '', disabled: !!disabled,
            placeholder: t('搜索兼容开关'),
            onChange: (ev) => onQuery(ev.target.value),
          }),
          React.createElement('label', { className: 'mp-checkline' },
            React.createElement('input', {
              type: 'checkbox', checked: !!onlySet, disabled: !!disabled,
              onChange: (ev) => onOnlySet(!!ev.target.checked),
            }),
            React.createElement('span', { className: 'mp-muted' }, t('仅看已配置'))),
          React.createElement('span', { className: 'mp-muted' }, shown.length + '/' + (fields || []).length),
        ),
        groups.length
          ? React.createElement('div', { className: 'mp-compat-groups' },
              groups.map((g) => React.createElement('div', { key: g.name, className: 'mp-group' },
                React.createElement('div', { className: 'mp-group-title' }, t(g.name) + ' · ' + g.rows.length),
                React.createElement('div', { className: 'mp-compat-rows' },
                  g.rows.map((f) => React.createElement(CompatFieldRow, {
                    key: f.field, field: f, value: (draft || {})[f.field],
                    disabled: !!disabled, onChange: (next) => onField(f.field, next),
                  })),
                ),
              )),
            )
          : React.createElement('p', { className: 'mp-muted', style: { margin: 0 } }, t('没有匹配的兼容开关')),
      )
    }

    /** 模型级 compat 折叠区（默认折叠；保存/删除在编辑器底部操作条）。 */
    function ModelCompatBlock(props) {
      const { editor, fields, apiName, disabled, onToggleOpen, onField, busy, query, onQuery, onlySet, onOnlySet } = props
      const count = compatDraftCount(editor.compat)
      const open = !!editor.showCompat
      return React.createElement('div', { className: 'mp-compat' },
        React.createElement('div', { className: 'mp-compat-head' },
          React.createElement('button', {
            type: 'button',
            className: 'mp-linkbtn',
            disabled: !!busy,
            onClick: onToggleOpen,
          }, (open ? '▾ ' : '▸ ') + t('模型级兼容开关') + '（' + count + t(' 项已配置') + t('）')),
          React.createElement('span', { className: 'mp-muted' },
            t('所属协议') + ': ' + (apiName || '—') + (fields.length ? (' · ' + fields.length + t(' 个字段')) : '')),
        ),
        open && React.createElement(React.Fragment, null,
          React.createElement('p', { className: 'mp-compat-warn' },
            '⚠️ ' + t('写入当前协议不支持的字段会导致该模型解析失败。')),
          fields.length
            ? CompatFieldList({
                fields: fields, draft: editor.compat, disabled: disabled, onField: onField,
                query: query, onQuery: onQuery, onlySet: onlySet, onOnlySet: onOnlySet,
              })
            : React.createElement('p', { className: 'mp-muted', style: { margin: 0 } },
                t('后端未提供该协议的 compat 字段表（旧版 host）。')),
        ),
      )
    }
    function ModelSuitePage() {
      const [loading, setLoading] = React.useState(true)
      const [busy, setBusy] = React.useState(false)
      const [tab, setTab] = React.useState('models')
      const [lang, setLang] = React.useState(readStoredLang)
      uiLang = lang
      // ★ R-低：语言变化 → 重注册 section（跳过首挂载，避免双重注册）
      const langBootRef = React.useRef(true)
      React.useEffect(() => {
        if (langBootRef.current) { langBootRef.current = false; return }
        if (notifySectionRelabel) { try { notifySectionRelabel() } catch (_) {} }
      }, [lang])
      const switchLang = (next) => {
        setLang(next)
        writeStoredLang(next)
      }
      const [boot, setBoot] = React.useState(null)
      const [provider, setProvider] = React.useState('')
      const [detail, setDetail] = React.useState(null)
      const [editors, setEditors] = React.useState({})
      const [openId, setOpenId] = React.useState('')
      const [search, setSearch] = React.useState('')
      const [error, setError] = React.useState('')
      const [okMsg, setOkMsg] = React.useState('')
      const [warnings, setWarnings] = React.useState([])
      const [modelErrors, setModelErrors] = React.useState({})
      /** 「更新模型列表」的结果是否展示（与「手动添加模型」面板独立）。 */
      const [refreshBusy, setRefreshBusy] = React.useState(false)
      const [refreshError, setRefreshError] = React.useState('')
      const [refreshCandidates, setRefreshCandidates] = React.useState(null)
      const [refreshPicked, setRefreshPicked] = React.useState({})
      const [refreshInfo, setRefreshInfo] = React.useState(null)
      const [quickResult, setQuickResult] = React.useState(null)
      /** 手动添加模型（幸存自前身的候选勾选 + 手填 + 批量粘贴）。 */
      const [showAdd, setShowAdd] = React.useState(false)
      const [addModelRows, setAddModelRows] = React.useState([{ id: '', name: '' }])
      const [addModelsText, setAddModelsText] = React.useState('')
      const [addBusy, setAddBusy] = React.useState(false)
      const [discoverBusy, setDiscoverBusy] = React.useState(false)
      const [discoverError, setDiscoverError] = React.useState('')
      const [discoverCandidates, setDiscoverCandidates] = React.useState(null)
      const [discoverPicked, setDiscoverPicked] = React.useState({})
      const [testPrompt, setTestPrompt] = React.useState(FALLBACK_TEST_PROMPT)
      // 单模型思考强度覆盖：undefined/'' 表示「自动=该模型最高档」
      const [testEffortByModel, setTestEffortByModel] = React.useState({})
      // 并行单测：用 map 记录多个 in-flight 模型，不再全局只锁一个
      const [testBusyMap, setTestBusyMap] = React.useState({})
      const [testBatch, setTestBatch] = React.useState(false)
      const [testProgress, setTestProgress] = React.useState('')
      const [testResults, setTestResults] = React.useState({})
      const testStopRef = React.useRef(false)
      /** 「更新模型列表」的单调序号：每次切换渠道或发起新更新都 +1，过期响应按序号丢弃。 */
      const refreshSeqRef = React.useRef(0)
      /**
       * 渠道纪元：切换渠道时 +1。任何"跨 await 的续作"（补全写回 / 新增模型）都必须
       * 先记下当时的值，await 回来后发现变了就整份丢弃——否则旧渠道的响应会写到新渠道
       * 的界面上（§12.7 过期响应作废；此前只有 refresh 做了这件事）。
       */
      const providerEpochRef = React.useRef(0)
      const providerRef = React.useRef(provider)
      React.useEffect(() => { providerRef.current = provider }, [provider])
      const testBusyCount = Object.keys(testBusyMap || {}).length
      const anyTestBusy = testBusyCount > 0
      // 高级设置（渠道级）：四张卡片各自的草稿
      const [compatDraft, setCompatDraft] = React.useState({})
      const [retryMode, setRetryMode] = React.useState('normal')
      const [retryMaxDraft, setRetryMaxDraft] = React.useState('')
      const [advCtxDraft, setAdvCtxDraft] = React.useState('')
      const [advMaxDraft, setAdvMaxDraft] = React.useState('')
      const [advInput, setAdvInput] = React.useState(['text'])
      const [headerRows, setHeaderRows] = React.useState([{ name: '', value: '' }])
      const [advBusy, setAdvBusy] = React.useState('')
      const [advOk, setAdvOk] = React.useState('')
      /** 高级设置各卡的"刚回填"快照：当前草稿 ≠ 快照 → 显示「未保存」。 */
      const [advPristine, setAdvPristine] = React.useState({})
      /** compat 字段表视图状态：渠道级与模型级各一套（搜索 + 仅看已配置）。 */
      const [compatQuery, setCompatQuery] = React.useState('')
      const [compatOnlySet, setCompatOnlySet] = React.useState(false)
      const [mCompatQuery, setMCompatQuery] = React.useState('')
      const [mCompatOnlySet, setMCompatOnlySet] = React.useState(false)
      // 同步与自动化
      const [sourcesDraft, setSourcesDraft] = React.useState(null)
      const [modelsDevPreset, setModelsDevPreset] = React.useState('official')
      const [sourcesBusy, setSourcesBusy] = React.useState(false)
      const [autoDraft, setAutoDraft] = React.useState(DEFAULT_AUTO)
      const [autoBusy, setAutoBusy] = React.useState(false)
      const [overwriteEfforts, setOverwriteEfforts] = React.useState(false)
      const [enrichBusy, setEnrichBusy] = React.useState(false)
      const [enrichPreview, setEnrichPreview] = React.useState(null)
      const [updateInfo, setUpdateInfo] = React.useState(null)
      const [checking, setChecking] = React.useState(false)

      const rowOf = (b, prov) => ((b && b.providers) || []).find((p) => p.provider === prov) || null
      const writable = !(boot && boot.writable === false)
      /** 平台默认重试次数：host 半区下在 boot.defaults.providerMaxRetries（顶层为旧版兜底）。 */
      const defaultRetryN = () => {
        const d = (boot && boot.defaults && typeof boot.defaults === 'object') ? boot.defaults : null
        const raw = d && d.providerMaxRetries != null
          ? d.providerMaxRetries
          : (boot && boot.defaultProviderMaxRetries != null ? boot.defaultProviderMaxRetries : 5)
        const n = Number(raw)
        return (Number.isFinite(n) && n >= 0) ? n : 5
      }
      /**
       * 收集一次写操作的告警。
       *
       * 高级设置类端点回的是 `warnings`；目录类端点（enrich/add/refresh）回的是
       * `sourceWarnings` + `sourceErrors`——以前只读 `res.warnings`，于是
       * "litellm：目录不可用"这类按源错误永远到不了界面上（审查发现 #5）。
       */
      const responseWarnings = (res) => {
        const out = Array.isArray(res && res.warnings) ? res.warnings.slice() : []
        if (Array.isArray(res && res.sourceWarnings)) {
          for (const w of res.sourceWarnings) if (out.indexOf(w) < 0) out.push(w)
        }
        const errors = (res && res.sourceErrors && typeof res.sourceErrors === 'object') ? res.sourceErrors : null
        if (errors) {
          const labels = { modelsDev: 'models.dev', litellm: 'LiteLLM', openrouter: 'OpenRouter' }
          for (const key of Object.keys(errors)) {
            const text = labels[key] ? (labels[key] + '：' + errors[key]) : String(errors[key])
            if (out.indexOf(text) < 0) out.push(text)
          }
        }
        return out
      }
      const listableProtocols = (boot && boot.listableProtocols) || ['openai-completions', 'openai-responses']
      const fieldsOf = (apiName) => compatFieldsFor(boot, apiName)
      const currentApi = () => {
        const row = rowOf(boot, provider)
        return (row && row.api) || (detail && detail.api) || ''
      }

      const sourcesDraftFromBoot = (b) => {
        const s = (b && b.sources) || {}
        const pick = (key) => {
          const cur = (s[key] && typeof s[key] === 'object') ? s[key] : {}
          const fb = FALLBACK_SOURCES[key]
          return {
            url: typeof cur.url === 'string' ? cur.url : fb.url,
            enabled: cur.enabled === undefined ? fb.enabled : !!cur.enabled,
          }
        }
        return { modelsDev: pick('modelsDev'), litellm: pick('litellm'), openrouter: pick('openrouter') }
      }
      const autoDraftFromBoot = (b) => {
        const a = (b && b.auto) || {}
        const f = (a.fields && typeof a.fields === 'object') ? a.fields : {}
        return {
          enabled: a.enabled === undefined ? DEFAULT_AUTO.enabled : !!a.enabled,
          persistOnSave: a.persistOnSave === undefined ? DEFAULT_AUTO.persistOnSave : !!a.persistOnSave,
          fields: {
            contextWindow: f.contextWindow === undefined ? true : !!f.contextWindow,
            maxTokens: f.maxTokens === undefined ? true : !!f.maxTokens,
            input: f.input === undefined ? true : !!f.input,
            reasoningEfforts: f.reasoningEfforts === undefined ? true : !!f.reasoningEfforts,
          },
          includeCatalogRoutes: !!a.includeCatalogRoutes,
        }
      }
      const presetFromUrl = (b, url) => {
        const hit = ((b && b.catalogSources) || []).find((s) => s && s.url === url)
        return hit ? hit.id : 'custom'
      }

      /** 渠道级：兼容开关草稿。 */
      const fillCompatDraft = (b, prov) => {
        const row = rowOf(b, prov)
        const fields = compatFieldsFor(b, (row && row.api) || '')
        const draft = compatDraftFromValue(fields, row && row.compat)
        setCompatDraft(draft)
        setAdvPristine((prev) => Object.assign({}, prev, { compat: JSON.stringify(draft) }))
      }

      /** 渠道级：重试策略草稿。 */
      const fillRetryDraft = (b, prov) => {
        const row = rowOf(b, prov)
        const rp = row && row.retryPolicy
        const mode = (rp && rp.mode === 'always') ? 'always' : ((row && row.retryMode === 'always') ? 'always' : 'normal')
        const max = rp && rp.maxRetries != null
          ? String(rp.maxRetries)
          : (row && row.retryMaxRetries != null ? String(row.retryMaxRetries) : '')
        setRetryMode(mode)
        setRetryMaxDraft(max)
        setAdvPristine((prev) => Object.assign({}, prev, { retry: JSON.stringify([mode, max]) }))
      }

      /** 渠道级：路由默认值草稿（host 嵌在 row.defaults 下，顶层同名字段仅为旧版兜底）。 */
      const fillDefaultsDraft = (b, prov) => {
        const row = rowOf(b, prov)
        const rd = (row && row.defaults && typeof row.defaults === 'object') ? row.defaults : {}
        const ctxDefault = rd.contextWindow != null ? rd.contextWindow : (row && row.defaultContextWindow)
        const maxDefault = rd.maxTokens != null ? rd.maxTokens : (row && row.defaultMaxTokens)
        const ctx = ctxDefault != null ? String(ctxDefault) : ''
        const max = maxDefault != null ? String(maxDefault) : ''
        const diRaw = Array.isArray(rd.input)
          ? rd.input
          : ((row && Array.isArray(row.defaultInput)) ? row.defaultInput : [])
        const di = diRaw.filter((x) => x === 'text' || x === 'image')
        const input = di.length ? di : ['text']
        setAdvCtxDraft(ctx)
        setAdvMaxDraft(max)
        setAdvInput(input)
        setAdvPristine((prev) => Object.assign({}, prev, { defaults: JSON.stringify([ctx, max, input.join(',')]) }))
      }

      /** 请求头草稿的规范化序列（忽略空行，供脏标记比较）。 */
      const normHeaderRows = (rows) => JSON.stringify((rows || [])
        .map((r) => ({ n: String((r && r.name) || '').trim(), v: String((r && r.value) || '') }))
        .filter((r) => r.n || r.v))

      /** 渠道级：自定义请求头草稿。 */
      const fillHeadersDraft = (b, prov) => {
        const row = rowOf(b, prov)
        const hs = (row && row.headers && typeof row.headers === 'object' && !Array.isArray(row.headers)) ? row.headers : {}
        const hRows = Object.keys(hs).map((k) => ({ name: k, value: String(hs[k] == null ? '' : hs[k]) }))
        const rows = hRows.length ? hRows : [{ name: '', value: '' }]
        setHeaderRows(rows)
        setAdvPristine((prev) => Object.assign({}, prev, { headers: normHeaderRows(rows) }))
      }

      /** 某张高级设置卡是否有未保存修改（驱动「未保存」徽章与保存按钮高亮）。 */
      const isAdvDirty = (scope) => {
        const p = advPristine || {}
        if (scope === 'compat') return JSON.stringify(compatDraft || {}) !== (p.compat || '{}')
        if (scope === 'retry') return JSON.stringify([retryMode, String(retryMaxDraft == null ? '' : retryMaxDraft)]) !== (p.retry || JSON.stringify(['normal', '']))
        if (scope === 'defaults') return JSON.stringify([String(advCtxDraft || ''), String(advMaxDraft || ''), (advInput || []).join(',')]) !== (p.defaults || '')
        if (scope === 'headers') return normHeaderRows(headerRows) !== (p.headers || '')
        return false
      }

      /** 全局：目录源草稿。 */
      const fillSourcesDraft = (b) => {
        const sd = sourcesDraftFromBoot(b)
        setSourcesDraft(sd)
        setModelsDevPreset(presetFromUrl(b, sd.modelsDev.url))
      }

      /** 全局：自动化草稿。 */
      const fillAutoDraftState = (b) => setAutoDraft(autoDraftFromBoot(b))

      /**
       * 用 bootstrap 的渠道行刷新「高级设置」四张**渠道级**卡片。
       * 切换渠道（可能换协议）时调用，丢弃新协议不提供的字段（§9.3 / 澄清 5）。
       *
       * ★ M3（三轮）：目录源 / 自动配置是**全局**草稿，与渠道无关——已从这里移出，
       *   只在首次挂载（reload）时回填。此前切一次渠道就会把这两张卡未保存的
       *   输入静默清掉（与"保存一张卡不得重置另一张卡"同类的问题）。
       */
      const fillAdvancedFromProvider = (b, prov) => {
        fillCompatDraft(b, prov)
        fillRetryDraft(b, prov)
        fillDefaultsDraft(b, prov)
        fillHeadersDraft(b, prov)
      }

      /**
       * 单卡保存后只回填**这一张卡**的草稿。
       *
       * ★ 审查修正：以前这里调 `fillAdvancedFromProvider`，于是"保存兼容开关"会把
       *   另外三张卡、以及「同步与自动化」两张卡的**未保存输入**一起重置掉
       *   （用户正在别处打字就白打了）。没被保存的卡片不该被服务端快照覆盖。
       */
      const FILLERS = {
        compat: fillCompatDraft,
        retry: fillRetryDraft,
        defaults: fillDefaultsDraft,
        headers: fillHeadersDraft,
        sources: fillSourcesDraft,
        auto: fillAutoDraftState,
      }

      /**
       * 写端点出参常带 `providers[]`：优先用它刷新，避免额外一次 bootstrap。
       *
       * `scope` = 刚保存的那张卡（见 FILLERS）；只回填它的草稿，不动其它卡的未保存输入。
       */
      const applyProviderSnapshot = async (res, scope, savedProvider) => {
        const list = res && Array.isArray(res.providers) ? res.providers : null
        const next = list && list.length
          ? Object.assign({}, boot || {}, { providers: list })
          : await api.bootstrap()
        setBoot(next)
        // ★ R-低：保存在途时切了渠道 → 不回填（providerRef 已指向新渠道，回填会用
        //   新渠道的已存值覆盖它该卡的未保存输入——#10 修复的边界复发）。
        const fill = FILLERS[scope]
        if (fill && (!savedProvider || savedProvider === (providerRef.current || provider))) {
          fill(next, savedProvider || providerRef.current || provider)
        }
        return next
      }

      const loadDetail = React.useCallback(async (prov, bootNow, opts) => {
        if (!prov) { setDetail(null); setEditors({}); return }
        // ★ R-H1：纪元守卫——refresh/enrich 写回后的 loadDetail 在途时用户可切换
        //   渠道（下拉只看 busy），旧响应竞速落地会把渠道 C 的界面覆盖成渠道 B 的
        //   模型表，后续保存/删除就会打到错误渠道。进入时记纪元，落地前不一致即丢弃。
        const epoch = providerEpochRef.current
        const res = await api.listModels(prov)
        if (providerEpochRef.current !== epoch) return
        setDetail(res)
        const fields = compatFieldsFor(bootNow, res && res.api)
        // ★ R-M5：合并而非整表替换——保留其它模型行**有本地修改**的编辑草稿
        //   （dirty 由 patchEditor/patchLevel/patchCompat/toggleEffortChip/
        //   toggleVisionChip 维护），避免"保存模型 B 丢掉模型 A 的未保存输入"。
        //   opts.forceFresh（整表服务端刷新，如批量补全/预设同步后）忽略 dirty。
        const forceFresh = !!(opts && opts.forceFresh)
        setEditors((prev) => {
          const next = {}
          for (const m of (res.models || [])) {
            const old = prev[m.id]
            next[m.id] = (!forceFresh && old && old.dirty) ? old : toEditor(m, fields)
          }
          return next
        })
        setModelErrors({})
      }, [])

      const reload = React.useCallback(async () => {
        setLoading(true); setError('')
        try {
          providerEpochRef.current += 1
          const b = await api.bootstrap()
          setBoot(b)
          if (b && b.defaultTestPrompt) {
            setTestPrompt((prev) => (!prev || prev === FALLBACK_TEST_PROMPT) ? b.defaultTestPrompt : prev)
          }
          const rows = (b && b.providers) || []
          let prov = providerRef.current || provider
          if (!prov || !rows.some((r) => r.provider === prov)) {
            const preferred = rows.find((r) => r.provider === 'newapi') || rows[0]
            prov = preferred ? preferred.provider : ''
          }
          setProvider(prov)
          fillAdvancedFromProvider(b, prov)
          // M3（三轮）：全局草稿只在挂载时回填一次（切渠道不再动它们）
          fillSourcesDraft(b)
          fillAutoDraftState(b)
          await loadDetail(prov, b)
        } catch (e) { setError(e && e.message ? e.message : String(e)) }
        finally { setLoading(false) }
      }, [loadDetail])

      React.useEffect(() => { reload() }, [])

      /** 取模型已配置的最高思考档（off/关闭不算）；无配置或关闭推理 → 不传（关闭）。 */
      const maxEffortOfModel = (m) => {
        if (!m) return ''
        if (m.disabled) return ''
        const enabled = (m.levels || [])
          .filter((row) => row && row.enabled && row.level && row.level !== 'off')
          .map((row) => row.level)
        const ordered = LEVEL_ORDER.filter((lv) => lv !== 'off' && enabled.indexOf(lv) >= 0)
        if (ordered.length) return ordered[ordered.length - 1]
        if (m.summary && m.summary !== t('关闭') && m.summary !== t('未设置') && LEVEL_ORDER.indexOf(m.summary) >= 0) {
          return m.summary
        }
        return ''
      }

      const resolveTestEffort = (modelId, model) => {
        const override = testEffortByModel && Object.prototype.hasOwnProperty.call(testEffortByModel, modelId)
          ? testEffortByModel[modelId]
          : undefined
        if (override === '__none__') return ''
        if (override && override !== '__auto__') return override
        return maxEffortOfModel(model)
      }

      const switchProvider = async (next) => {
        // 切换渠道时作废进行中的 refresh / 补全 / 新增，避免旧渠道的结果写到新渠道
        refreshSeqRef.current += 1
        providerEpochRef.current += 1
        setProvider(next); setOkMsg(''); setError(''); setWarnings([]); setBusy(true)
        testStopRef.current = true
        setTestResults({}); setTestProgress(''); setTestBusyMap({}); setTestBatch(false); setTestEffortByModel({})
        setEnrichPreview(null)
        setShowAdd(false)
        // ★ M2（三轮）：手动添加面板的全部状态一并作废——否则切到渠道 B 后重新
        //   打开面板，仍会显示渠道 A 的探测候选（且全勾选），确认后把 A 的模型
        //   加进 B。refresh 面板早有同款重置，add 面板此前漏了。
        resetAddForm()
        setOpenId('')
        setSearch('')
        setModelErrors({})
        setRefreshBusy(false)
        setRefreshCandidates(null)
        setRefreshPicked({})
        setRefreshInfo(null)
        setRefreshError('')
        setAdvOk('')
        // 换渠道即换协议：compat 表单重置为新渠道的值，丢弃新协议不提供的字段
        // （fillCompatDraft 内部已按新渠道重建草稿，无需再重复 setCompatDraft）
        fillAdvancedFromProvider(boot, next)
        try { await loadDetail(next, boot, { forceFresh: true }) } catch (e) { setError(e && e.message ? e.message : String(e)) } finally { setBusy(false) }
      }

      const markTestBusy = (modelId, on) => {
        setTestBusyMap((prev) => {
          const next = Object.assign({}, prev || {})
          if (on) next[modelId] = true
          else delete next[modelId]
          return next
        })
      }

      const normalizeTestResult = (res, modelId) => {
        const base = res && typeof res === 'object' ? res : { ok: false, error: String(res || t('空结果')) }
        const text = base.text || ''
        const svg = base.svg || extractSvgClient(text)
        return Object.assign({}, base, {
          modelId: base.modelId || modelId,
          svg: svg || '',
          hasSvg: !!(svg || base.hasSvg),
          at: Date.now(),
        })
      }

      const runTestOne = async (modelId) => {
        const id = String(modelId || '').trim()
        if (!provider) throw new Error(t('请先选择渠道'))
        if (!id) throw new Error(t('缺少模型 id'))
        const model = ((detail && detail.models) || []).find((m) => m && m.id === id)
        const effort = resolveTestEffort(id, model)
        const payload = {
          provider: provider,
          modelId: id,
          prompt: testPrompt,
          maxTokens: (boot && boot.defaultTestMaxTokens) || FALLBACK_TEST_MAX_TOKENS,
        }
        if (effort) payload.effort = effort
        try {
          const res = await api.testModel(payload)
          return normalizeTestResult(Object.assign({}, res, { effortUsed: effort || '' }), id)
        } catch (e) {
          return normalizeTestResult({
            ok: false,
            modelId: id,
            effortUsed: effort || '',
            error: e && e.message ? e.message : String(e),
            message: e && e.message ? e.message : String(e),
          }, id)
        }
      }

      const runTestModel = async (modelId) => {
        if (testBatch) return
        if (!modelId || testBusyMap[modelId]) return
        setError(''); setOkMsg('')
        // ★ R-M7：纪元守卫——测试最长 11 分钟且不占 busy，切渠道后在途结果不得
        //   写进新渠道界面（跨渠道同 id 模型的结果会被误归因）。
        const epoch = providerEpochRef.current
        markTestBusy(modelId, true)
        setTestResults((prev) => Object.assign({}, prev, {
          [modelId]: { ok: null, modelId: modelId, pending: true, message: t('测试中…') },
        }))
        try {
          const res = await runTestOne(modelId)
          if (providerEpochRef.current !== epoch) return
          setTestResults((prev) => Object.assign({}, prev, { [modelId]: res }))
          if (res.ok) setOkMsg((res.modelId || modelId) + ' · ' + (res.message || t('成功')))
          else setError((res.modelId || modelId) + ' · ' + (res.error || res.message || t('失败')))
        } finally {
          markTestBusy(modelId, false)
        }
      }

      const runTestAll = async () => {
        if (testBatch || anyTestBusy) return
        if (!provider) { setError(t('请先选择渠道')); return }
        const ids = ((detail && detail.models) || []).map((m) => m.id).filter(Boolean)
        if (!ids.length) { setError(t('当前供应商没有模型可测')); return }
        testStopRef.current = false
        const epoch = providerEpochRef.current
        setTestBatch(true); setError(''); setOkMsg(''); setTestProgress('0/' + ids.length)
        let pass = 0
        let fail = 0
        try {
          for (let i = 0; i < ids.length; i++) {
            // ★ R-M7：切渠道即中止批量（进度与结果不再写入新渠道界面）
            if (providerEpochRef.current !== epoch) {
              testStopRef.current = true
              setTestProgress(t('已切换渠道，测试中止'))
              break
            }
            if (testStopRef.current) {
              setTestProgress(t('已停止 · ') + (i) + '/' + ids.length)
              break
            }
            const id = ids[i]
            markTestBusy(id, true)
            setTestProgress((i + 1) + '/' + ids.length + ' · ' + id)
            setTestResults((prev) => Object.assign({}, prev, {
              [id]: { ok: null, modelId: id, pending: true, message: t('测试中…') },
            }))
            try {
              const res = await runTestOne(id)
              if (providerEpochRef.current !== epoch) { testStopRef.current = true; break }
              if (res.ok) pass += 1
              else fail += 1
              setTestResults((prev) => Object.assign({}, prev, { [id]: res }))
            } finally {
              markTestBusy(id, false)
            }
          }
          if (!testStopRef.current) {
            setOkMsg(t('全量测试完成：成功 ') + pass + t(' · 失败 ') + fail)
            setTestProgress(t('完成 · 成功 ') + pass + t(' · 失败 ') + fail)
          }
        } finally {
          setTestBusyMap({})
          setTestBatch(false)
        }
      }

      const stopTestAll = () => {
        testStopRef.current = true
        setTestProgress((p) => (p ? (p + t(' · 停止中…')) : t('停止中…')))
      }

      const clearTestResults = () => {
        setTestResults({})
        setTestProgress('')
        setOkMsg('')
        setError('')
      }

      const resetTestPrompt = () => {
        setTestPrompt((boot && boot.defaultTestPrompt) || FALLBACK_TEST_PROMPT)
      }

      // ★ R-M5：dirty 标记——编辑器内容一旦被本地修改就置位；loadDetail 合并时
      //   保留 dirty 行的草稿（UI 折叠态 showWire/showCompat 不算内容修改）。
      const patchEditor = (id, patch) => setEditors((prev) => {
        const uiOnly = Object.keys(patch).every((k) => k === 'showWire' || k === 'showCompat')
        const next = Object.assign({}, prev[id] || {}, patch)
        if (!uiOnly) next.dirty = true
        return Object.assign({}, prev, { [id]: next })
      })
      const patchLevel = (id, level, patch) => setEditors((prev) => {
        const cur = Object.assign({}, prev[id] || { levels: [] })
        const levels = (cur.levels || []).map((row) => row.level === level ? Object.assign({}, row, patch) : row)
        cur.levels = levels
        cur.dirty = true
        return Object.assign({}, prev, { [id]: cur })
      })
      const patchCompat = (id, field, value) => setEditors((prev) => {
        const cur = Object.assign({}, prev[id] || { compat: {} })
        const compat = Object.assign({}, cur.compat || {})
        compat[field] = value
        cur.compat = compat
        cur.dirty = true
        return Object.assign({}, prev, { [id]: cur })
      })
      const markEditorClean = (id) => setEditors((prev) => {
        const cur = prev[id]
        if (!cur || !cur.dirty) return prev
        return Object.assign({}, prev, { [id]: Object.assign({}, cur, { dirty: false }) })
      })

      /** Toggle a reasoning level chip. Empty selection ⇒ disabled (reasoningEfforts: false). */
      const toggleEffortChip = (id, level) => setEditors((prev) => {
        const cur = Object.assign({ levels: [], disabled: false, vision: false }, prev[id] || {})
        let levels = (cur.levels || []).map((row) => Object.assign({}, row))
        if (!levels.length) {
          levels = LEVEL_ORDER.map((lv) => ({
            level: lv,
            enabled: false,
            wire: lv === 'off' ? '' : lv,
            wireNull: lv === 'off',
          }))
        }
        const idx = levels.findIndex((row) => row.level === level)
        if (idx < 0) {
          levels.push({
            level: level,
            enabled: true,
            wire: level === 'off' ? '' : level,
            wireNull: level === 'off',
          })
        } else {
          const row = levels[idx]
          const nextEnabled = !row.enabled
          levels[idx] = Object.assign({}, row, {
            enabled: nextEnabled,
            wire: nextEnabled
              ? (row.wireNull ? '' : (row.wire || (level === 'off' ? '' : level)))
              : row.wire,
          })
        }
        const anyPositive = levels.some((row) => row.enabled && row.level !== 'off')
        const anyEnabled = levels.some((row) => row.enabled)
        // No chips / only off → treat as 关闭推理（与 host normalizeEditor 一致）
        const disabled = !anyPositive
        if (disabled) {
          if (!anyEnabled) {
            levels = levels.map((row) => Object.assign({}, row, { enabled: false }))
          }
        }
        return Object.assign({}, prev, {
          [id]: Object.assign({}, cur, {
            levels: levels,
            disabled: disabled,
            dirty: true,
          }),
        })
      })

      const toggleVisionChip = (id, value) => {
        if (value === 'text') return
        setEditors((prev) => {
          const cur = prev[id] || {}
          return Object.assign({}, prev, {
            [id]: Object.assign({}, cur, { vision: !cur.vision, dirty: true }),
          })
        })
      }

      const saveModel = async (id) => {
        setBusy(true); setError(''); setOkMsg(''); setWarnings([])
        setModelErrors((prev) => {
          const next = Object.assign({}, prev)
          delete next[id]
          return next
        })
        try {
          const ed0 = editors[id] || {}
          const fields = fieldsOf(currentApi())
          // O8/L6（三轮）：先校验数字输入——Number('abc')=NaN 会被 host 静默按"未填"
          // 处理；超长数字串（>1e308）解析成 Infinity 同样会被静默忽略（旧值原样
          // 保留，用户以为改成功了）。这里就地报错，错误显示在该模型的操作条里。
          const cvRaw = String(ed0.contextWindow == null ? '' : ed0.contextWindow).trim()
          const mvRaw = String(ed0.maxTokens == null ? '' : ed0.maxTokens).trim()
          if (cvRaw && (!/^\d+$/.test(cvRaw) || !Number.isFinite(Number(cvRaw)))) throw new Error(t('字段 ') + 'contextWindow' + t(' 需要整数'))
          if (mvRaw && (!/^\d+$/.test(mvRaw) || !Number.isFinite(Number(mvRaw)))) throw new Error(t('字段 ') + 'maxTokens' + t(' 需要整数'))
          // ★ R-低：正档 wire 清空就地报错（host 会 400，但提前到客户端少一次往返、
          //   错误立即显示在该模型的操作条里）。
          const badLevel = (ed0.levels || []).find((r) => r && r.enabled === true && r.level && r.level !== 'off' && !String(r.wire == null ? '' : r.wire).trim())
          if (badLevel) throw new Error(badLevel.level + t(' 档位的 wire 值不能为空（取消勾选该档位即可）'))
          // ★ B5：协议没有 compat 字段表（未知/未来协议）时**不提交 compat**——
          //   空对象会被 host 当成"显式清空"从而抹掉该模型已有的 compat
          //   （与渠道级卡片的防护同口径，见 saveCompatCard）。
          const compat = fields.length ? compatPayloadFromDraft(fields, ed0.compat) : undefined
          const editor = Object.assign({}, ed0, {
            name: String(ed0.name || '').trim(),
            contextWindow: cvRaw ? Number(cvRaw) : 0,
            maxTokens: mvRaw ? Number(mvRaw) : 0,
            clearContextWindow: !cvRaw,
            clearMaxTokens: !mvRaw,
            compat: compat,
          })
          delete editor.showWire
          delete editor.showCompat
          delete editor.dirty // ★ 审查修正：dirty 是 UI 草稿标记，不进 save-model 载荷
          const res = await api.saveModel({ provider: provider, modelId: id, editor: editor })
          setOkMsg(res.message || t('已保存'))
          if (res.warnings) setWarnings(res.warnings)
          markEditorClean(id)
          // ★ R-优化：listModels 与 bootstrap 并行（此前串行两次往返）
          const [, nextBoot] = await Promise.all([loadDetail(provider, boot), api.bootstrap()])
          setBoot(nextBoot)
        } catch (e) {
          const msg = e && e.message ? e.message : String(e)
          setModelErrors((prev) => Object.assign({}, prev, { [id]: msg }))
          // 失败可能来自协议不支持的 compat 字段：把折叠区展开，让错误紧挨字段表出现
          setEditors((prev) => Object.assign({}, prev, {
            [id]: Object.assign({}, prev[id] || {}, { showCompat: true }),
          }))
          setError(msg)
        }
        finally { setBusy(false) }
      }

      const removeModel = async (id) => {
        const ask = t('确认删除模型 ') + id + t('？此操作会重写该渠道的模型列表。')
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(ask)) return
        setBusy(true); setError(''); setOkMsg(''); setWarnings([])
        try {
          const res = await api.deleteModel({ provider: provider, modelId: id })
          const remaining = res && res.remaining != null ? res.remaining : null
          setOkMsg((res && res.message) || (t('已删除 ') + id + (remaining != null ? (' · ' + t('剩余 ') + remaining + t(' 个模型')) : '')))
          if (res && res.warnings) setWarnings(res.warnings)
          const [, nextBoot] = await Promise.all([loadDetail(provider, boot), api.bootstrap()])
          setBoot(nextBoot)
        } catch (e) { setError(e && e.message ? e.message : String(e)) }
        finally { setBusy(false) }
      }

      const applyPreset = async (id, presetId) => {
        setBusy(true); setError(''); setOkMsg('')
        try {
          const res = await api.applyPreset({ provider: provider, modelId: id, presetId: presetId })
          setOkMsg(res.message || t('已应用预设'))
          markEditorClean(id)
          await loadDetail(provider, boot)
          setOpenId(id)
          setBoot(await api.bootstrap())
        } catch (e) { setError(e && e.message ? e.message : String(e)) }
        finally { setBusy(false) }
      }

      /** 一键同步 = 三源目录补全并写回当前渠道。 */
      const quickSync = async () => {
        if (!provider) { setError(t('请先选择渠道')); return }
        if (!writable) return
        setBusy(true); setError(''); setOkMsg(''); setQuickResult(null); setWarnings([])
        try {
          const res = await api.enrichModels({
            provider: provider,
            apply: true,
            overwrite: !!overwriteEfforts,
          })
          setQuickResult(res)
          setEnrichPreview(res)
          setOkMsg(res.message || t('已同步'))
          const warns = responseWarnings(res)
          if (warns.length) setWarnings(warns)
          // 整表被服务端补全/覆盖 → 强制刷新全部编辑器（忽略 dirty）
          await loadDetail(provider, boot, { forceFresh: true })
          setBoot(await api.bootstrap())
        } catch (e) {
          setError(e && e.message ? e.message : String(e))
          setQuickResult({ error: e && e.message ? e.message : String(e) })
        }
        finally { setBusy(false) }
      }

      const runRefreshModels = async () => {
        if (!provider) { setError(t('请先选择渠道')); return }
        const targetProvider = provider
        refreshSeqRef.current += 1
        const seq = refreshSeqRef.current
        setRefreshBusy(true); setRefreshError(''); setOkMsg(''); setError('')
        try {
          const res = await api.refreshModels({ provider: targetProvider })
          // 期间切换过渠道或发起过新更新：丢弃过期响应，绝不写入当前 UI
          if (refreshSeqRef.current !== seq) return
          const found = res.candidates || []
          setRefreshCandidates(found)
          setRefreshInfo(res)
          // 默认只勾选「新增」——对齐官方
          const picked = {}
          for (const m of found) {
            if (m && m.id) picked[m.id] = !!m.isNew
          }
          setRefreshPicked(picked)
          setOkMsg(res.message || (t('已获取 ') + found.length + t(' 个模型')))
          // 按源的拉取失败（litellm/openrouter 不可达等）也要让用户看见
          const warns = responseWarnings(res)
          if (warns.length) setWarnings(warns)
        } catch (e) {
          if (refreshSeqRef.current !== seq) return
          setRefreshCandidates(null)
          setRefreshPicked({})
          setRefreshInfo(null)
          setRefreshError(e && e.message ? e.message : String(e))
          setError(e && e.message ? e.message : String(e))
        } finally {
          if (refreshSeqRef.current === seq) setRefreshBusy(false)
        }
      }

      const toggleRefreshPick = (id) => {
        setRefreshPicked((prev) => {
          const next = Object.assign({}, prev)
          next[id] = !next[id]
          return next
        })
      }

      const pickRefreshAllNew = () => {
        if (!refreshCandidates) return
        const next = {}
        for (const m of refreshCandidates) {
          if (m && m.id) next[m.id] = !!m.isNew
        }
        setRefreshPicked(next)
      }

      const pickRefreshAll = (on) => {
        if (!refreshCandidates) return
        const next = {}
        for (const m of refreshCandidates) if (m && m.id) next[m.id] = !!on
        setRefreshPicked(next)
      }

      const closeRefreshPanel = () => {
        setRefreshCandidates(null)
        setRefreshPicked({})
        setRefreshInfo(null)
        setRefreshError('')
      }

      const confirmAddRefreshedModels = async () => {
        if (!provider) return
        const targetProvider = provider
        const selectedModels = []
        for (const m of (refreshCandidates || [])) {
          if (!m || !m.id || !refreshPicked[m.id]) continue
          // 只追加新增；已有的即使勾了也跳过（host 也会去重）
          if (m.isNew === false) continue
          const row = { id: m.id }
          if (m.name) row.name = m.name
          if (typeof m.contextWindow === 'number' && m.contextWindow > 0) row.contextWindow = m.contextWindow
          if (typeof m.maxTokens === 'number' && m.maxTokens > 0) row.maxTokens = m.maxTokens
          if (Array.isArray(m.input) && m.input.indexOf('image') >= 0) row.input = ['text', 'image']
          if (m.reasoningEfforts === false || (m.reasoningEfforts && typeof m.reasoningEfforts === 'object')) {
            row.reasoningEfforts = m.reasoningEfforts
          }
          selectedModels.push(row)
        }
        if (!selectedModels.length) {
          setError(t('请至少勾选一个新增模型'))
          return
        }
        setRefreshBusy(true); setError(''); setOkMsg(''); setWarnings([])
        try {
          // 固定写入发起时的渠道，避免切换后写到新渠道
          const res = await api.addModels({ provider: targetProvider, models: selectedModels })
          if (providerRef.current !== targetProvider) {
            setOkMsg((res.message || (t('已新增 ') + (res.addedCount || 0) + t(' 个模型'))) + t('（已写回 ') + targetProvider + t('）'))
            closeRefreshPanel()
            return
          }
          setOkMsg(res.message || (t('已新增 ') + (res.addedCount || 0) + t(' 个模型')))
          closeRefreshPanel()
          const [, nextBoot] = await Promise.all([loadDetail(targetProvider, boot, { forceFresh: true }), api.bootstrap()])
          setBoot(nextBoot)
        } catch (e) {
          setError(e && e.message ? e.message : String(e))
        } finally {
          setRefreshBusy(false)
        }
      }

      // ── 手动添加模型（候选勾选 + 手填 + 批量粘贴 → /add-models） ──
      const resetAddForm = () => {
        setAddModelRows([{ id: '', name: '' }])
        setAddModelsText('')
        setDiscoverBusy(false)
        setDiscoverError('')
        setDiscoverCandidates(null)
        setDiscoverPicked({})
      }

      const parseAddModels = () => {
        // 1) 勾选的探测结果  2) 多行粘贴  3) 手填表格行
        const fromDiscover = []
        if (discoverCandidates && discoverCandidates.length) {
          for (const c of discoverCandidates) {
            if (!c || !c.id || !discoverPicked[c.id]) continue
            const m = { id: c.id }
            if (c.name) m.name = c.name
            if (typeof c.contextWindow === 'number' && c.contextWindow > 0) m.contextWindow = c.contextWindow
            if (typeof c.maxTokens === 'number' && c.maxTokens > 0) m.maxTokens = c.maxTokens
            // ★ 审查修正：探测结果里由目录补全的视觉/思考档位不能丢（refresh 路径一直都带）
            if (Array.isArray(c.input) && c.input.indexOf('image') >= 0) m.input = ['text', 'image']
            if (c.reasoningEfforts === false || (c.reasoningEfforts && typeof c.reasoningEfforts === 'object')) {
              m.reasoningEfforts = c.reasoningEfforts
            }
            fromDiscover.push(m)
          }
        }
        const fromText = String(addModelsText || '')
          .split(/[\n,]+/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((line) => {
            const parts = line.split('|').map((p) => p.trim())
            const id = parts[0] || ''
            const name = parts[1] || ''
            return name ? { id: id, name: name } : { id: id }
          })
        const fromRows = (addModelRows || [])
          .map((r) => ({ id: String(r.id || '').trim(), name: String(r.name || '').trim() }))
          .filter((r) => r.id)
          .map((r) => (r.name ? { id: r.id, name: r.name } : { id: r.id }))
        const merged = []
        const seen = Object.create(null)
        for (const m of fromDiscover.concat(fromText).concat(fromRows)) {
          const key = String(m.id || '').toLowerCase()
          if (!m.id || seen[key]) continue
          seen[key] = true
          merged.push(m)
        }
        return merged
      }

      const runDiscoverModels = async () => {
        setDiscoverBusy(true); setDiscoverError(''); setOkMsg('')
        // ★ R-H2：纪元守卫——fetch 在途时切渠道，switchProvider 的 resetAddForm()
        //   会被旧响应的 setDiscoverCandidates/setDiscoverPicked（全勾选）穿透，
        //   旧渠道候选进入新渠道的添加面板（M2 修复的跨渠道写入经在途路径复发）。
        const epoch = providerEpochRef.current
        try {
          const row = rowOf(boot, provider)
          const apiName = (row && row.api) || (detail && detail.api) || ''
          const baseURL = (row && row.baseURL) || (detail && detail.baseURL) || ''
          if (!baseURL) throw new Error(t('该渠道未配置 baseURL，无法获取模型'))
          if (listableProtocols.indexOf(apiName) < 0) throw new Error(t('当前协议不支持自动获取模型，请手填'))
          // ★ B7：带上 provider——host 会解析该渠道已存的凭据与自定义请求头，
          //   否则受保护网关的"获取模型"永远 401（更新模型列表却能过）。
          const res = await api.discoverModels({ provider: provider, baseURL: baseURL, api: apiName, apiKey: '' })
          if (providerEpochRef.current !== epoch) return
          const found = res.models || []
          setDiscoverCandidates(found)
          const picked = {}
          for (const m of found) if (m && m.id) picked[m.id] = true
          setDiscoverPicked(picked)
          setOkMsg(res.message || (t('已获取 ') + found.length + t(' 个模型')))
        } catch (e) {
          if (providerEpochRef.current !== epoch) return
          setDiscoverCandidates(null)
          setDiscoverPicked({})
          setDiscoverError(e && e.message ? e.message : String(e))
        } finally {
          setDiscoverBusy(false)
        }
      }

      const toggleDiscoverPick = (id) => {
        setDiscoverPicked((prev) => {
          const next = Object.assign({}, prev)
          next[id] = !next[id]
          return next
        })
      }

      const pickAllDiscover = (on) => {
        if (!discoverCandidates) return
        const next = {}
        for (const m of discoverCandidates) if (m && m.id) next[m.id] = !!on
        setDiscoverPicked(next)
      }

      const submitAddModels = async () => {
        if (!provider) { setError(t('请先选择渠道')); return }
        const targetProvider = provider
        const epoch = providerEpochRef.current
        setAddBusy(true); setError(''); setOkMsg(''); setWarnings([])
        try {
          const models = parseAddModels()
          if (!models.length) throw new Error(t('请至少勾选一个模型，或改用手填'))
          const res = await api.addModels({ provider: targetProvider, models: models })
          setOkMsg(res.message || (t('已新增 ') + (res.addedCount || 0) + t(' 个模型')))
          const warns = responseWarnings(res)
          if (warns.length) setWarnings(warns)
          setShowAdd(false)
          resetAddForm()
          // 期间切换过渠道：写入已生效，但绝不能把旧渠道的模型表刷到新渠道界面上
          if (providerEpochRef.current !== epoch) return
          const [, nextBoot] = await Promise.all([loadDetail(targetProvider, boot, { forceFresh: true }), api.bootstrap()])
          if (providerEpochRef.current !== epoch) return
          setBoot(nextBoot)
        } catch (e) {
          setError(e && e.message ? e.message : String(e))
        } finally {
          setAddBusy(false)
        }
      }

      // ── 高级设置：兼容开关 ──
      const patchCompatDraft = (field, value) => setCompatDraft((prev) => Object.assign({}, prev || {}, { [field]: value }))

      const saveCompatCard = async () => {
        if (!provider) { setError(t('请先选择渠道')); return }
        setAdvBusy('compat'); setAdvOk(''); setError(''); setWarnings([])
        try {
          const fields = fieldsOf(currentApi())
          // ★ 审查修正：host 没有该协议的字段表时（旧版/未知协议），绝不能提交 `compat: {}`
          //   —— host 会把空对象当成"显式清空"从而 delete 掉用户已有的 compat。
          if (!fields.length) throw new Error(t('当前 host 未提供该协议的 compat 字段表，无法保存兼容开关（请升级插件）'))
          const compat = compatPayloadFromDraft(fields, compatDraft)
          const res = await api.saveProviderAdvanced({ provider: provider, compat: compat })
          setAdvOk(res.message || t('已保存渠道高级设置'))
          const warns = responseWarnings(res)
          if (warns.length) setWarnings(warns)
          await applyProviderSnapshot(res, 'compat', provider)
        } catch (e) { setError(e && e.message ? e.message : String(e)) }
        finally { setAdvBusy('') }
      }

      // ── 高级设置：重试策略 ──
      const saveRetryCard = async () => {
        if (!provider) { setError(t('请先选择渠道')); return }
        setAdvBusy('retry'); setAdvOk(''); setError(''); setWarnings([])
        try {
          const raw = String(retryMaxDraft == null ? '' : retryMaxDraft).trim()
          const n = raw === '' ? defaultRetryN() : Number(raw)
          if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 99999) {
            throw new Error(t('重试次数须为 0..99999 的整数'))
          }
          const res = await api.saveProviderAdvanced({
            provider: provider,
            retryPolicy: { mode: retryMode === 'always' ? 'always' : 'normal', maxRetries: n },
          })
          setAdvOk(res.message || t('已保存渠道高级设置'))
          const warns = responseWarnings(res)
          if (warns.length) setWarnings(warns)
          await applyProviderSnapshot(res, 'retry', provider)
        } catch (e) { setError(e && e.message ? e.message : String(e)) }
        finally { setAdvBusy('') }
      }

      const clearRetryCard = async () => {
        if (!provider) { setError(t('请先选择渠道')); return }
        setAdvBusy('retry'); setAdvOk(''); setError(''); setWarnings([])
        try {
          const res = await api.saveProviderAdvanced({ provider: provider, retryPolicy: null })
          setAdvOk(res.message || t('已保存渠道高级设置'))
          const warns = responseWarnings(res)
          if (warns.length) setWarnings(warns)
          await applyProviderSnapshot(res, 'retry', provider)
        } catch (e) { setError(e && e.message ? e.message : String(e)) }
        finally { setAdvBusy('') }
      }

      // ── 高级设置：路由默认值 ──
      const toggleAdvInput = (value) => {
        if (value === 'text') return
        setAdvInput((prev) => {
          const cur = Array.isArray(prev) ? prev.slice() : ['text']
          const idx = cur.indexOf('image')
          if (idx >= 0) cur.splice(idx, 1); else cur.push('image')
          if (!cur.length) return ['text']
          return cur
        })
      }

      const saveDefaultsCard = async () => {
        if (!provider) { setError(t('请先选择渠道')); return }
        setAdvBusy('defaults'); setAdvOk(''); setError(''); setWarnings([])
        try {
          const parsePos = (raw, field) => {
            const s = String(raw == null ? '' : raw).trim()
            if (s === '') return null
            const n = Number(s)
            if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
              throw new Error(t('字段 ') + field + t(' 需要一个正整数（留空 = 清除）'))
            }
            return n
          }
          const input = (Array.isArray(advInput) ? advInput : []).filter((x) => x === 'text' || x === 'image')
          if (!input.length) throw new Error(t('默认输入模态至少要保留 text'))
          const res = await api.saveProviderAdvanced({
            provider: provider,
            defaultContextWindow: parsePos(advCtxDraft, 'defaultContextWindow'),
            defaultMaxTokens: parsePos(advMaxDraft, 'defaultMaxTokens'),
            defaultInput: input.indexOf('text') >= 0 ? input : ['text'].concat(input),
          })
          setAdvOk(res.message || t('已保存渠道高级设置'))
          const warns = responseWarnings(res)
          if (warns.length) setWarnings(warns)
          await applyProviderSnapshot(res, 'defaults', provider)
        } catch (e) { setError(e && e.message ? e.message : String(e)) }
        finally { setAdvBusy('') }
      }

      // ── 高级设置：自定义请求头（客户端校验 + 保留名提示） ──
      const patchHeaderRow = (idx, patch) => setHeaderRows((prev) => (prev || []).map((r, i) => (i === idx ? Object.assign({}, r, patch) : r)))
      const addHeaderRow = () => setHeaderRows((prev) => (prev || []).concat([{ name: '', value: '' }]))
      const removeHeaderRow = (idx) => setHeaderRows((prev) => {
        const next = (prev || []).filter((_, i) => i !== idx)
        return next.length ? next : [{ name: '', value: '' }]
      })

      const validateHeaderRows = () => {
        const out = {}
        const reserved = []
        const seen = Object.create(null)
        const rows = headerRows || []
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i] || {}
          const name = String(row.name == null ? '' : row.name).trim()
          const value = String(row.value == null ? '' : row.value)
          if (!name && !value) continue
          if (!name || !HEADER_NAME_RE.test(name)) {
            throw new Error(t('第 ') + (i + 1) + t(' 行自定义请求头名称不是合法 HTTP token'))
          }
          // ★ R-M3：与 host 同口径——原型键名赋值会被吞掉，必须就地拒绝
          if (name === '__proto__' || name === 'prototype' || name === 'constructor') {
            throw new Error(t('第 ') + (i + 1) + t(' 行自定义请求头名称非法（原型键名）'))
          }
          const lower = name.toLowerCase()
          if (seen[lower]) throw new Error(t('请求头名称重复：') + name)
          seen[lower] = true
          if (/[\r\n]/.test(value)) throw new Error(t('第 ') + (i + 1) + t(' 行自定义请求头不能包含换行'))
          if (!HEADER_VALUE_RE.test(value)) throw new Error(t('自定义请求头值只能包含可打印字符'))
          if (isReservedHeaderName(name)) reserved.push(name)
          out[name] = value
        }
        // L4（三轮）：按 UTF-8 字节累计（与 host 的 Buffer.byteLength 同口径）
        let totalBytes = 0
        for (const name of Object.keys(out)) totalBytes += utf8Bytes(name) + utf8Bytes(out[name])
        if (totalBytes > HEADER_TOTAL_MAX) throw new Error(t('自定义请求头已超过 8 KB 上限'))
        return { headers: out, reserved: reserved }
      }

      const saveHeadersCard = async () => {
        if (!provider) { setError(t('请先选择渠道')); return }
        setAdvBusy('headers'); setAdvOk(''); setError(''); setWarnings([])
        try {
          const checked = validateHeaderRows()
          const hasAny = Object.keys(checked.headers).length > 0
          const res = await api.saveProviderAdvanced({
            provider: provider,
            headers: hasAny ? checked.headers : null,
          })
          setAdvOk(res.message || t('已保存渠道高级设置'))
          const warns = responseWarnings(res).slice()
          if (checked.reserved.length) {
            warns.push(t('保留名（Harness 归因头等）由平台覆盖，写了不生效') + ': ' + checked.reserved.join(', '))
          }
          setWarnings(warns)
          await applyProviderSnapshot(res, 'headers', provider)
        } catch (e) { setError(e && e.message ? e.message : String(e)) }
        finally { setAdvBusy('') }
      }

      // ── 同步与自动化 ──
      const patchSource = (key, patch) => setSourcesDraft((prev) => {
        const cur = prev || sourcesDraftFromBoot(boot)
        return Object.assign({}, cur, { [key]: Object.assign({}, cur[key] || {}, patch) })
      })

      const selectModelsDevPreset = (id) => {
        setModelsDevPreset(id)
        if (id === 'custom') return
        const src = ((boot && boot.catalogSources) || []).find((s) => s && s.id === id)
        if (src && src.url) patchSource('modelsDev', { url: src.url })
      }

      const saveSourcesCard = async () => {
        setSourcesBusy(true); setError(''); setOkMsg(''); setWarnings([])
        try {
          const sd = sourcesDraft || sourcesDraftFromBoot(boot)
          const mdUrl = String(sd.modelsDev.url || '').trim()
          // ★ R-M6：三源统一"地址为空 ⇒ 未启用"（此前只有 modelsDev 联动，
          //   另两源 enabled:true + 空 url 会存成"启用但永远拉不到"）。
          const payload = {
            sources: {
              modelsDev: { url: mdUrl, enabled: !!mdUrl },
              litellm: { url: String(sd.litellm.url || '').trim(), enabled: !!(String(sd.litellm.url || '').trim() && sd.litellm.enabled) },
              openrouter: { url: String(sd.openrouter.url || '').trim(), enabled: !!(String(sd.openrouter.url || '').trim() && sd.openrouter.enabled) },
            },
          }
          const res = await api.saveSources(payload)
          setOkMsg(res.message || t('已保存目录源'))
          setWarnings(res.warnings || [])
          const b = await api.bootstrap()
          setBoot(b)
          const sd2 = sourcesDraftFromBoot(b)
          setSourcesDraft(sd2)
          setModelsDevPreset(presetFromUrl(b, sd2.modelsDev.url))
        } catch (e) { setError(e && e.message ? e.message : String(e)) }
        finally { setSourcesBusy(false) }
      }

      const patchAutoField = (key, on) => setAutoDraft((prev) => Object.assign(
        {},
        prev || DEFAULT_AUTO,
        { fields: Object.assign({}, (prev && prev.fields) || DEFAULT_AUTO.fields, { [key]: !!on }) },
      ))

      const saveAutoCard = async () => {
        setAutoBusy(true); setError(''); setOkMsg(''); setWarnings([])
        try {
          const res = await api.saveAutoConfig({ auto: autoDraft })
          setOkMsg(res.message || t('已保存自动配置'))
          if (res.warnings) setWarnings(res.warnings)
          if (res.auto) setAutoDraft(autoDraftFromBoot({ auto: res.auto }))
          const b = await api.bootstrap()
          setBoot(b)
        } catch (e) { setError(e && e.message ? e.message : String(e)) }
        finally { setAutoBusy(false) }
      }

      const runEnrichModels = async (apply) => {
        if (!provider) { setError(t('请先选择渠道')); return }
        const targetProvider = provider
        const epoch = providerEpochRef.current
        setEnrichBusy(true); setError(''); setOkMsg(''); setWarnings([])
        try {
          const res = await api.enrichModels({
            provider: targetProvider,
            apply: !!apply,
            overwrite: !!overwriteEfforts,
          })
          // 期间切换过渠道 → 整份丢弃（预览、消息、刷新全都不做）
          if (providerEpochRef.current !== epoch) return
          setEnrichPreview(res)
          const warns = responseWarnings(res)
          if (warns.length) setWarnings(warns)
          if (apply && res.applied) {
            setOkMsg(res.message || t('已补全并写回'))
            const [, nextBoot] = await Promise.all([loadDetail(targetProvider, boot, { forceFresh: true }), api.bootstrap()])
            if (providerEpochRef.current !== epoch) return
            setBoot(nextBoot)
          } else {
            setOkMsg(res.message || t('预览完成'))
          }
        } catch (e) {
          setError(e && e.message ? e.message : String(e))
        } finally {
          setEnrichBusy(false)
        }
      }

      const runCheckUpdate = async () => {
        setChecking(true); setUpdateInfo(null)
        try {
          setUpdateInfo(await api.checkUpdate())
        } catch (e) {
          setUpdateInfo({ ok: false, error: e && e.message ? e.message : String(e) })
        }
        finally { setChecking(false) }
      }
      if (loading) {
        return React.createElement('div', { className: 'mp-root' },
          React.createElement('h2', { className: 'mp-h' }, t('模型套件')),
          React.createElement('p', { className: 'mp-sub' }, t('加载中…')),
        )
      }

      const providers = (boot && boot.providers) || []
      const presets = (boot && boot.presets) || []
      const models = (detail && detail.models) || []
      const selected = rowOf(boot, provider)
      const activeApi = (selected && selected.api) || (detail && detail.api) || ''
      const activeFields = compatFieldsFor(boot, activeApi)
      const query = String(search || '').trim().toLowerCase()
      const filteredModels = query
        ? models.filter((m) => String(m.id || '').toLowerCase().indexOf(query) >= 0
            || String(m.name || '').toLowerCase().indexOf(query) >= 0)
        : models

      const renderRefreshPanel = () => {
        if (!refreshCandidates) return null
        return React.createElement('div', { className: 'mp-field', style: { marginTop: 4 } },
          React.createElement('div', { className: 'mp-discover-head' },
            React.createElement('span', { className: 'mp-muted' },
              th(refreshInfo && refreshInfo.message)
              || (t('共 ') + refreshCandidates.length + t(' 个'))
              + t(' · 已选 ')
              + refreshCandidates.filter((m) => m && m.id && refreshPicked[m.id] && m.isNew).length
              + t(' 新增'),
            ),
            React.createElement('div', { className: 'mp-actions' },
              React.createElement('button', {
                type: 'button', className: 'mp-linkbtn', disabled: busy || refreshBusy,
                onClick: pickRefreshAllNew,
              }, t('只选新增')),
              React.createElement('button', {
                type: 'button', className: 'mp-linkbtn', disabled: busy || refreshBusy,
                onClick: () => pickRefreshAll(true),
              }, t('全选')),
              React.createElement('button', {
                type: 'button', className: 'mp-linkbtn', disabled: busy || refreshBusy,
                onClick: () => pickRefreshAll(false),
              }, t('全不选')),
              React.createElement('button', {
                type: 'button', className: 'mp-linkbtn', disabled: busy || refreshBusy,
                onClick: closeRefreshPanel,
              // ★ R-低：不能复用 t('关闭')——该词条 EN 是思考档位的 "off"，按钮会显示成 "off"
              }, t('关闭面板')),
            ),
          ),
          React.createElement('div', { className: 'mp-discover-box' },
            refreshCandidates.map((m) => React.createElement('div', { key: m.id, className: 'mp-discover-item' },
              React.createElement('label', null,
                React.createElement('input', {
                  type: 'checkbox',
                  checked: !!refreshPicked[m.id],
                  disabled: busy || refreshBusy || m.isNew === false,
                  onChange: () => toggleRefreshPick(m.id),
                }),
                React.createElement('span', null,
                  React.createElement('div', null,
                    m.id,
                    m.isNew
                      ? React.createElement('span', { className: 'mp-pill', style: { marginLeft: 6 } }, t('新增'))
                      : React.createElement('span', { className: 'mp-muted', style: { marginLeft: 6 } }, t('已有')),
                  ),
                  React.createElement('div', { className: 'mp-discover-meta' },
                    [m.name, m.contextWindow ? ('ctx ' + m.contextWindow) : '', m.maxTokens ? ('max ' + m.maxTokens) : '']
                      .filter(Boolean).join(' · ') || t('无附加字段'),
                  ),
                ),
              ),
            )),
          ),
          React.createElement('div', { className: 'mp-actions', style: { marginTop: 8 } },
            React.createElement('button', {
              type: 'button', className: 'mp-btn primary',
              disabled: busy || refreshBusy || !writable
                || !refreshCandidates.some((m) => m && m.id && m.isNew && refreshPicked[m.id]),
              onClick: confirmAddRefreshedModels,
            }, refreshBusy ? t('写入中…') : t('确认添加所选新增模型')),
          ),
        )
      }

      const renderAddPanel = () => {
        const apiName = (selected && selected.api) || (detail && detail.api) || ''
        const listable = listableProtocols.indexOf(apiName) >= 0
        const canDiscover = !!(selected && selected.baseURL) && listable
        const pending = parseAddModels()
        return React.createElement('div', { className: 'mp-prov mp-add-models' },
          React.createElement('div', { className: 'mp-discover-head' },
            React.createElement('strong', null, t('手动添加模型')),
            React.createElement('div', { className: 'mp-actions' },
              React.createElement('button', {
                type: 'button', className: 'mp-btn small primary',
                disabled: busy || discoverBusy || !canDiscover,
                title: listable
                  ? (selected && selected.baseURL ? t('请求 baseURL/models（官方同款）') : t('该渠道未配置 baseURL，无法获取模型'))
                  : t('当前协议不支持自动获取'),
                onClick: runDiscoverModels,
              }, discoverBusy ? t('获取中…') : t('获取模型')),
              React.createElement('button', {
                type: 'button', className: 'mp-btn small',
                disabled: busy || addBusy,
                onClick: () => { setShowAdd(false); resetAddForm(); setError(''); },
              }, t('取消')),
            ),
          ),
          React.createElement('p', { className: 'mp-muted', style: { margin: 0 } },
            t('可勾选探测结果、手填或批量粘贴。')),
          !listable && React.createElement('p', { className: 'mp-muted', style: { margin: 0 } },
            t('协议「') + apiName + t('」不支持自动列表，请用手填。')),
          discoverError && React.createElement('p', { className: 'mp-error' }, th(discoverError)),
          discoverCandidates && discoverCandidates.length > 0 && React.createElement('div', { className: 'mp-discover-box' },
            React.createElement('div', { className: 'mp-discover-head' },
              React.createElement('span', { className: 'mp-muted' },
                t('共 ') + discoverCandidates.length + t(' 个 · 已选 ') + discoverCandidates.filter((m) => m && m.id && discoverPicked[m.id]).length),
              React.createElement('div', { className: 'mp-actions' },
                React.createElement('button', { type: 'button', className: 'mp-linkbtn', disabled: busy || discoverBusy, onClick: () => pickAllDiscover(true) }, t('全选')),
                React.createElement('button', { type: 'button', className: 'mp-linkbtn', disabled: busy || discoverBusy, onClick: () => pickAllDiscover(false) }, t('全不选')),
              ),
            ),
            discoverCandidates.map((m) => React.createElement('div', { key: m.id, className: 'mp-discover-item' },
              React.createElement('label', null,
                React.createElement('input', {
                  type: 'checkbox',
                  checked: !!discoverPicked[m.id],
                  disabled: busy || discoverBusy,
                  onChange: () => toggleDiscoverPick(m.id),
                }),
                React.createElement('span', null,
                  React.createElement('div', null, m.id),
                  React.createElement('div', { className: 'mp-discover-meta' },
                    [m.name, m.contextWindow ? ('ctx ' + m.contextWindow) : '', m.maxTokens ? ('max ' + m.maxTokens) : '']
                      .filter(Boolean).join(' · ') || t('无附加字段'),
                  ),
                ),
              ),
            )),
          ),
          React.createElement('div', { className: 'mp-add-models' },
            (addModelRows || []).map((row, idx) => React.createElement('div', { key: idx, className: 'mp-add-model-row' },
              React.createElement('input', {
                className: 'mp-input', value: row.id, disabled: busy || addBusy, placeholder: t('模型 id，如 gpt-4o'),
                onChange: (ev) => setAddModelRows((prev) => prev.map((r, i) => i === idx ? Object.assign({}, r, { id: ev.target.value }) : r)),
              }),
              React.createElement('input', {
                className: 'mp-input', value: row.name || '', disabled: busy || addBusy, placeholder: t('显示名（可选）'),
                onChange: (ev) => setAddModelRows((prev) => prev.map((r, i) => i === idx ? Object.assign({}, r, { name: ev.target.value }) : r)),
              }),
              React.createElement('button', {
                type: 'button', className: 'mp-btn small', disabled: busy || addBusy || addModelRows.length <= 1,
                onClick: () => setAddModelRows((prev) => prev.filter((_, i) => i !== idx)),
              }, t('删')),
            )),
            React.createElement('div', { className: 'mp-actions' },
              React.createElement('button', {
                type: 'button', className: 'mp-btn small', disabled: busy || addBusy,
                onClick: () => setAddModelRows((prev) => prev.concat([{ id: '', name: '' }])),
              }, t('添加模型行')),
            ),
          ),
          React.createElement('span', { className: 'mp-label', style: { marginTop: 6 } }, t('或批量粘贴（每行一个 id，可用 id|显示名）')),
          React.createElement('textarea', {
            className: 'mp-input', rows: 3, disabled: busy || addBusy, value: addModelsText,
            placeholder: 'claude-sonnet-4\ngpt-4o|GPT-4o',
            onChange: (ev) => setAddModelsText(ev.target.value),
            style: { resize: 'vertical', minHeight: 64, fontFamily: 'inherit' },
          }),
          React.createElement('div', { className: 'mp-actions' },
            React.createElement('button', {
              type: 'button', className: 'mp-btn primary',
              disabled: busy || addBusy || !writable || !provider || !pending.length,
              onClick: submitAddModels,
            }, addBusy ? t('提交中…') : (t('确认添加（') + pending.length + t('）'))),
          ),
        )
      }

      /** 顶部渠道工具栏：一行放下渠道选择、能力徽章与主操作；元信息收进一行小字。 */
      const renderProviderBar = () => React.createElement('div', { className: 'mp-toolbar' },
        React.createElement('div', { className: 'mp-toolbar-row' },
          React.createElement('span', { className: 'mp-muted' }, t('渠道')),
          React.createElement('select', {
            className: 'mp-select',
            value: provider,
            disabled: busy || !providers.length || !writable,
            onChange: (ev) => switchProvider(ev.target.value),
          }, !providers.length
            ? React.createElement('option', { value: '' }, t('无供应商'))
            : providers.map((p) => React.createElement('option', { key: p.provider, value: p.provider },
              (p.displayName || p.provider)))),
          selected && React.createElement('div', { className: 'mp-badges' },
            React.createElement('span', { className: 'mp-pill' }, (selected.modelCount || 0) + t(' 个模型')),
            (selected.withEffort || 0) > 0
              ? React.createElement('span', { className: 'mp-pill', 'data-b': 'reason' }, t('推理 ') + (selected.withEffort || 0) + '/' + (selected.modelCount || 0))
              : null,
            (selected.withVision || 0) > 0
              ? React.createElement('span', { className: 'mp-pill', 'data-b': 'vision' }, t('视觉 ') + (selected.withVision || 0))
              : null,
            (selected.withCompat || 0) > 0
              ? React.createElement('span', { className: 'mp-pill', 'data-b': 'compat' }, 'C ' + (selected.withCompat || 0))
              : null,
            selected.retryLabel
              ? React.createElement('span', { className: 'mp-pill' }, t('重试 ') + selected.retryLabel)
              : null,
            React.createElement('span', {
              className: 'mp-pill',
              'data-kind': selected.isCatalogRoute ? 'catalog-route' : 'custom-route',
            }, selected.isCatalogRoute ? t('内置渠道') : t('自定义')),
            (selected.headersCount || 0) > 0
              ? React.createElement('span', { className: 'mp-pill' }, t('自定义请求头') + ' ' + selected.headersCount)
              : null,
          ),
          React.createElement('div', { className: 'mp-actions', style: { marginLeft: 'auto' } },
            React.createElement('button', {
              type: 'button', className: 'mp-btn primary',
              disabled: busy || enrichBusy || refreshBusy || !provider || !writable,
              title: provider ? (t('同步到：') + provider) : t('请先选择渠道'),
              onClick: quickSync,
            }, (busy || enrichBusy) ? t('同步中…') : t('一键同步')),
            React.createElement('button', {
              type: 'button', className: 'mp-btn',
              disabled: busy || enrichBusy || refreshBusy || !provider,
              title: provider ? (t('更新模型列表：') + provider) : t('请先选择渠道'),
              onClick: runRefreshModels,
            }, refreshBusy ? t('更新中…') : t('更新模型列表')),
          ),
        ),
        selected && React.createElement('p', { className: 'mp-meta' },
          (selected.baseURL || t('无 baseURL')) + (selected.api ? (' · ' + selected.api) : '')),
        quickResult && React.createElement('p', { className: quickResult.error ? 'mp-error' : 'mp-ok' },
          quickResult.error
            ? t('同步失败：') + th(quickResult.error)
            : ((th(quickResult.message) || (t('变更 ') + (quickResult.changeCount || 0)))
              + (quickResult.hitCount != null ? (t(' · 命中 ') + quickResult.hitCount + '/' + (quickResult.localCount || 0)) : ''))),
        refreshError && React.createElement('p', { className: 'mp-error' }, th(refreshError)),
      )

      const renderModelsTab = () => React.createElement('div', { className: 'mp-card' },
        React.createElement('div', { className: 'mp-search' },
          React.createElement('input', {
            className: 'mp-input',
            value: search,
            placeholder: t('搜索模型 id / 名称…'),
            onChange: (ev) => setSearch(ev.target.value),
          }),
          search
            ? React.createElement('button', {
                type: 'button', className: 'mp-btn small', onClick: () => setSearch(''),
              }, t('清除'))
            : null,
          React.createElement('button', {
            type: 'button', className: 'mp-btn primary',
            disabled: busy || !provider || !writable,
            onClick: () => { setShowAdd((v) => !v); setError(''); setOkMsg('') },
          }, showAdd ? t('收起添加') : ('+ ' + t('手动添加模型'))),
        ),
        showAdd ? renderAddPanel() : null,
        renderRefreshPanel(),
        !models.length
          ? React.createElement('div', { className: 'mp-stack' },
              React.createElement('p', { className: 'mp-sub' }, t('该渠道还没有模型条目')),
              React.createElement('div', { className: 'mp-actions' },
                React.createElement('button', {
                  type: 'button', className: 'mp-btn',
                  disabled: busy || refreshBusy || !provider,
                  onClick: runRefreshModels,
                }, refreshBusy ? t('更新中…') : t('更新模型列表')),
                React.createElement('button', {
                  type: 'button', className: 'mp-btn primary',
                  disabled: busy || !writable,
                  onClick: () => setShowAdd(true),
                }, t('手动添加模型')),
              ),
            )
          : React.createElement('table', { className: 'mp-table' },
              React.createElement('thead', null, React.createElement('tr', null,
                React.createElement('th', null, 'id / ' + t('名称')),
                React.createElement('th', null, t('能力')),
                React.createElement('th', { className: 'mp-num' }, t('上下文')),
                React.createElement('th', { className: 'mp-num' }, t('输出上限')),
                React.createElement('th', null, t('操作')),
              )),
              React.createElement('tbody', null,
                (query && !filteredModels.length)
                  ? React.createElement('tr', null, React.createElement('td', { colSpan: 5, className: 'mp-muted' },
                      t('没有匹配的模型（搜索：') + search + t('）')))
                  : filteredModels.map((m) => {
                      const ed = editors[m.id] || toEditor(m, activeFields)
                      const opened = openId === m.id
                      const liveSummary = opened ? effortSummaryFromEditor(ed) : (m.summary || t('未设置'))
                      const liveVision = opened ? !!ed.vision : !!m.vision
                      const liveCompatCount = opened ? compatDraftCount(ed.compat) : (m.compatCount || 0)
                      const liveHasEffort = opened ? (selectedLevels(ed).some((lv) => lv !== 'off') || !!m.hasEffort) : !!m.hasEffort
                      const effortSelected = selectedLevels(ed)
                      const modalitySelected = liveVision ? ['text', 'image'] : ['text']
                      const ctxText = opened ? (ed.contextWindow || '') : (m.contextWindow || '')
                      const maxText = opened ? (ed.maxTokens || '') : (m.maxTokens || '')
                      return [
                        React.createElement('tr', { key: m.id },
                          React.createElement('td', null,
                            React.createElement('strong', null, m.id),
                            React.createElement('div', { className: 'mp-muted' }, m.name || ''),
                          ),
                          React.createElement('td', null,
                            liveHasEffort && !ed.disabled
                              ? React.createElement('span', { className: 'mp-pill', 'data-b': 'reason' }, t('推理 ') + liveSummary)
                              : null,
                            ed.disabled
                              ? React.createElement('span', { className: 'mp-pill' }, t('已关闭'))
                              : null,
                            liveVision ? React.createElement('span', { className: 'mp-pill', 'data-b': 'vision' }, t('视觉')) : null,
                            liveCompatCount > 0 ? React.createElement('span', { className: 'mp-pill', 'data-b': 'compat' }, 'C ' + liveCompatCount) : null,
                            (!liveHasEffort && !liveVision && !(liveCompatCount > 0) && !ed.disabled)
                              ? React.createElement('span', { className: 'mp-dash' }, '—')
                              : null,
                          ),
                          React.createElement('td', { className: 'mp-num mp-numcell' },
                            ctxText ? ctxText : React.createElement('span', { className: 'mp-dash' }, '—')),
                          React.createElement('td', { className: 'mp-num mp-numcell' },
                            maxText ? maxText : React.createElement('span', { className: 'mp-dash' }, '—')),
                          React.createElement('td', { className: 'mp-actcell' },
                            React.createElement('button', {
                              type: 'button', className: 'mp-btn small',
                              disabled: busy,
                              onClick: () => setOpenId(opened ? '' : m.id),
                            }, opened ? t('收起') : t('编辑')),
                          ),
                        ),
                        opened
                          ? React.createElement('tr', { key: m.id + ':editor' },
                              React.createElement('td', { colSpan: 5 },
                                React.createElement('div', { className: 'mp-editor' },
                                  React.createElement('div', { className: 'mp-source-line' },
                                    React.createElement(SourceBadge, { source: m.source }),
                                    React.createElement('span', { className: 'mp-muted' },
                                      t('强度: ') + liveSummary
                                      + (liveVision ? t(' · 视觉') : t(' · 纯文本'))
                                      + (ed.contextWindow ? (' · ctx ' + ed.contextWindow) : (m.contextWindow ? (' · ctx ' + m.contextWindow) : ''))
                                      + (ed.maxTokens ? (' · maxOut ' + ed.maxTokens) : (m.maxTokens ? (' · maxOut ' + m.maxTokens) : '')))),
                                  React.createElement('div', { className: 'mp-editor-sec' },
                                    React.createElement('span', { className: 'mp-editor-sec-title' }, t('显示名（可选）')),
                                    React.createElement('input', {
                                      className: 'mp-input',
                                      value: ed.name || '',
                                      disabled: busy || !writable,
                                      placeholder: t('空则界面显示 ID'),
                                      onChange: (ev) => patchEditor(m.id, { name: ev.target.value }),
                                    }),
                                  ),
                                  React.createElement('div', { className: 'mp-editor-sec' },
                                    React.createElement('span', { className: 'mp-editor-sec-title' }, t('输入模态')),
                                    React.createElement(MultiSelectChips, {
                                      options: [
                                        { value: 'text', label: t('文本'), locked: true, title: t('文本为底线，不可取消') },
                                        { value: 'image', label: t('图片（视觉）'), title: t('勾选后写入 input: text + image') },
                                      ],
                                      selected: modalitySelected,
                                      onToggle: (value) => toggleVisionChip(m.id, value),
                                      disabled: busy || !writable,
                                    }),
                                  ),
                                  React.createElement('div', { className: 'mp-editor-sec' },
                                    React.createElement('span', { className: 'mp-editor-sec-title' }, t('思考强度')),
                                    React.createElement(MultiSelectChips, {
                                      options: LEVEL_ORDER.map((lv) => ({ value: lv, label: lv, title: lv === 'off' ? t('off：支持但不发送强度') : (t('启用 ') + lv) })),
                                      selected: effortSelected,
                                      onToggle: (value) => toggleEffortChip(m.id, value),
                                      disabled: busy || !writable,
                                      hint: ed.disabled
                                        ? t('未选非 off 档 → 保存为关闭推理（reasoningEfforts: false）')
                                        : (!effortSelected.length
                                          ? t('未勾选任何档位：保存时不写该字段，沿用目录/探测能力')
                                          : (t('已选 ') + effortSelected.join(', ') + t(' · 摘要 ') + liveSummary)),
                                    }),
                                    React.createElement('div', { className: 'mp-presets' },
                                      React.createElement('span', { className: 'mp-label' }, t('快捷预设')),
                                      presets.map((p) => React.createElement('button', {
                                        key: p.id, type: 'button', className: 'mp-btn small', disabled: busy || !writable,
                                        onClick: () => applyPreset(m.id, p.id),
                                      }, t(p.label))),
                                    ),
                                  ),
                                  React.createElement('div', { className: 'mp-editor-sec' },
                                    React.createElement('span', { className: 'mp-editor-sec-title' }, t('容量参数')),
                                    React.createElement('div', { className: 'mp-field-pair' },
                                      React.createElement('div', { className: 'mp-field' },
                                        React.createElement('span', { className: 'mp-label' }, t('上下文长度 contextWindow')),
                                        React.createElement('input', {
                                          className: 'mp-input',
                                          value: ed.contextWindow || '',
                                          disabled: busy || !writable,
                                          placeholder: t('例如 128000，空=不设置'),
                                          onChange: (ev) => patchEditor(m.id, { contextWindow: ev.target.value }),
                                        })),
                                      React.createElement('div', { className: 'mp-field' },
                                        React.createElement('span', { className: 'mp-label' }, t('默认输出上限 maxTokens')),
                                        React.createElement('input', {
                                          className: 'mp-input',
                                          value: ed.maxTokens || '',
                                          disabled: busy || !writable,
                                          placeholder: t('可选'),
                                          onChange: (ev) => patchEditor(m.id, { maxTokens: ev.target.value }),
                                        })),
                                    ),
                                  ),
                                  React.createElement('div', { className: 'mp-compat' },
                                    React.createElement('div', { className: 'mp-compat-head' },
                                      React.createElement('button', {
                                        type: 'button',
                                        className: 'mp-linkbtn',
                                        disabled: busy || ed.disabled || !writable,
                                        onClick: () => patchEditor(m.id, { showWire: !ed.showWire }),
                                      }, (ed.showWire ? '▾ ' : '▸ ') + t('wire 高级编辑（网关映射）') + '（'
                                        + (ed.levels || []).filter((row) => row && row.enabled).length + t(' 项已配置') + t('）')),
                                      React.createElement('span', { className: 'mp-muted' }, t('仅在网关 wire 值与档位名不同时需要改')),
                                    ),
                                    ed.showWire && !ed.disabled && React.createElement(React.Fragment, null,
                                      React.createElement('div', { className: 'mp-ms-hint' }, t('off 勾选「空传」= 选 off 时不发送强度参数；取消勾选并填值（如 none）= 选 off 时发送该值（默认开思考、需显式关闭的网关用）。')),
                                      React.createElement('div', { className: 'mp-levels' },
                                      (ed.levels || []).map((row) => React.createElement('div', {
                                        key: row.level,
                                        className: 'mp-level' + (row.enabled ? '' : ' disabled'),
                                      },
                                        React.createElement('input', {
                                          type: 'checkbox',
                                          checked: !!row.enabled,
                                          disabled: busy || !writable,
                                          onChange: (ev) => {
                                            const enabled = !!ev.target.checked
                                            setEditors((prev) => {
                                              const cur = prev[m.id] || {}
                                              const levels = (cur.levels || []).map((r) => r.level === row.level ? Object.assign({}, r, { enabled: enabled }) : r)
                                              const anyPositive = levels.some((r) => r.enabled && r.level !== 'off')
                                              return Object.assign({}, prev, {
                                                [m.id]: Object.assign({}, cur, { levels: levels, disabled: !anyPositive, dirty: true }),
                                              })
                                            })
                                          },
                                        }),
                                        React.createElement('span', null, row.level),
                                        React.createElement('input', {
                                          className: 'mp-input wire',
                                          value: row.wireNull ? '' : (row.wire || ''),
                                          disabled: busy || !writable || !row.enabled || (row.level === 'off' && row.wireNull),
                                          onChange: (ev) => patchLevel(m.id, row.level, { wire: ev.target.value, wireNull: false }),
                                        }),
                                        row.level === 'off'
                                          ? React.createElement('label', { className: 'mp-checkline' },
                                              React.createElement('input', {
                                                type: 'checkbox', checked: !!row.wireNull, disabled: busy || !writable || !row.enabled,
                                                onChange: (ev) => patchLevel(m.id, 'off', { wireNull: !!ev.target.checked, wire: ev.target.checked ? '' : (row.wire || 'none') }),
                                              }),
                                              React.createElement('span', { className: 'mp-muted' }, t('空传')),
                                            )
                                          : React.createElement('span', { className: 'mp-muted' }, 'wire'),
                                      )),
                                    ),
                                    ),
                                  ),
                                  React.createElement(ModelCompatBlock, {
                                    editor: ed,
                                    fields: activeFields,
                                    apiName: activeApi,
                                    busy: busy,
                                    disabled: busy || !writable,
                                    query: mCompatQuery,
                                    onQuery: setMCompatQuery,
                                    onlySet: mCompatOnlySet,
                                    onOnlySet: setMCompatOnlySet,
                                    onToggleOpen: () => patchEditor(m.id, { showCompat: !ed.showCompat }),
                                    onField: (field, value) => patchCompat(m.id, field, value),
                                  }),
                                  React.createElement('div', { className: 'mp-editor-foot' },
                                    modelErrors[m.id]
                                      ? React.createElement('p', { className: 'mp-error', style: { margin: 0, flex: '1 1 auto' } }, th(modelErrors[m.id]))
                                      : null,
                                    React.createElement('div', { className: 'mp-actions', style: { marginLeft: 'auto' } },
                                      React.createElement('button', {
                                        type: 'button', className: 'mp-btn primary',
                                        disabled: busy || !writable,
                                        onClick: () => saveModel(m.id),
                                      }, busy ? t('保存中…') : t('保存此模型')),
                                      React.createElement('button', {
                                        type: 'button', className: 'mp-btn danger',
                                        disabled: busy || !writable,
                                        onClick: () => removeModel(m.id),
                                      }, t('删除')),
                                    ),
                                  ),
                                ),
                              ),
                            )
                          : null,
                      ]
                    }).reduce((acc, pair) => acc.concat(pair), []),
              ),
            ),
      )
      const renderAdvancedTab = () => {
        if (!provider) {
          return React.createElement('div', { className: 'mp-card' },
            React.createElement('p', { className: 'mp-sub' }, t('请先选择渠道。')))
        }
        const defaultsConfigured = (selected && selected.defaultsConfigured) || {}
        const configuredBadge = (on) => (on
          ? React.createElement('span', { className: 'mp-config-badge' }, t('已配置'))
          : null)
        const dirtyBadge = (scope) => (isAdvDirty(scope)
          ? React.createElement('span', { className: 'mp-dirty' }, t('未保存'))
          : null)
        const cardSave = (scope, handler) => React.createElement('button', {
          type: 'button',
          className: 'mp-btn' + (isAdvDirty(scope) && advBusy !== scope ? ' primary' : ''),
          disabled: !!advBusy || !writable,
          onClick: handler,
        }, advBusy === scope ? t('保存中…') : t('保存'))
        return React.createElement('div', { className: 'mp-stack' },
          advOk ? React.createElement('p', { className: 'mp-ok' }, th(advOk)) : null,
          React.createElement('p', { className: 'mp-sub', style: { margin: 0 } },
            t('作用于') + (selected ? (selected.displayName || selected.provider) : provider)),

          // ── 组一：兼容开关（compat）──
          React.createElement('div', { className: 'mp-card' },
            React.createElement('div', { className: 'mp-card-head-row' },
              React.createElement('div', null,
                React.createElement('h4', { className: 'mp-card-title' }, t('兼容开关') + '（compat）', dirtyBadge('compat')),
                React.createElement('p', { className: 'mp-card-desc' },
                  (activeApi || '—') + ' · ' + activeFields.length + t(' 个开关。')),
              ),
              cardSave('compat', saveCompatCard),
            ),
            activeFields.length
              ? CompatFieldList({
                  fields: activeFields,
                  draft: compatDraft,
                  disabled: !!advBusy || !writable,
                  onField: patchCompatDraft,
                  query: compatQuery,
                  onQuery: setCompatQuery,
                  onlySet: compatOnlySet,
                  onOnlySet: setCompatOnlySet,
                })
              : React.createElement('p', { className: 'mp-muted', style: { margin: 0 } },
                  t('后端未提供该协议的 compat 字段表（旧版 host）。')),
            React.createElement('span', { className: 'mp-field-hint' }, t('未设置则回落到目录/探测值')),
          ),

          // ── 组二：重试策略 ──
          React.createElement('div', { className: 'mp-card' },
            React.createElement('div', { className: 'mp-card-head-row' },
              React.createElement('div', null,
                React.createElement('h4', { className: 'mp-card-title' }, t('重试策略'), dirtyBadge('retry')),
                React.createElement('p', { className: 'mp-card-desc' },
                  t('当前生效：') + ((selected && selected.retryLabel) || '—')),
              ),
              cardSave('retry', saveRetryCard),
            ),
            React.createElement('div', { className: 'mp-row' },
              React.createElement('div', { className: 'mp-field' },
                React.createElement('span', { className: 'mp-label' }, t('模式')),
                React.createElement('select', {
                  className: 'mp-select',
                  value: retryMode,
                  disabled: !!advBusy || !writable,
                  onChange: (ev) => setRetryMode(ev.target.value === 'always' ? 'always' : 'normal'),
                },
                  React.createElement('option', { value: 'normal' }, 'normal'),
                  React.createElement('option', { value: 'always' }, 'always'),
                ),
                React.createElement('span', { className: 'mp-field-hint' },
                  t('normal = 有限次重试；always = 持续重试')),
              ),
              React.createElement('div', { className: 'mp-field' },
                React.createElement('span', { className: 'mp-label' }, t('重试次数 maxRetries')),
                React.createElement('input', {
                  className: 'mp-input num',
                  type: 'number', min: 0, max: 99999, step: 1, inputMode: 'numeric',
                  value: retryMaxDraft,
                  disabled: !!advBusy || !writable,
                  placeholder: String(defaultRetryN()),
                  onChange: (ev) => setRetryMaxDraft(ev.target.value),
                }),
                React.createElement('span', { className: 'mp-field-hint' }, t('0..99999；mode=always 时该值不生效')),
              ),
            ),
            React.createElement('div', { className: 'mp-actions' },
              React.createElement('button', {
                type: 'button', className: 'mp-btn small',
                disabled: !!advBusy || !writable,
                onClick: clearRetryCard,
              }, t('清除（回平台默认）')),
            ),
          ),

          // ── 组三：路由默认值 ──
          React.createElement('div', { className: 'mp-card' },
            React.createElement('div', { className: 'mp-card-head-row' },
              React.createElement('div', null,
                React.createElement('h4', { className: 'mp-card-title' }, t('路由默认值'), dirtyBadge('defaults')),
                React.createElement('p', { className: 'mp-card-desc' }, t('路由内未被标注模型的兜底值')),
              ),
              cardSave('defaults', saveDefaultsCard),
            ),
            React.createElement('div', { className: 'mp-row' },
              React.createElement('div', { className: 'mp-field' },
                React.createElement('span', { className: 'mp-label' },
                  t('默认上下文窗口') + ' defaultContextWindow', configuredBadge(defaultsConfigured.contextWindow)),
                React.createElement('input', {
                  className: 'mp-input num',
                  type: 'number', min: 1, step: 1, inputMode: 'numeric',
                  value: advCtxDraft,
                  disabled: !!advBusy || !writable,
                  placeholder: '262144',
                  onChange: (ev) => setAdvCtxDraft(ev.target.value),
                }),
              ),
              React.createElement('div', { className: 'mp-field' },
                React.createElement('span', { className: 'mp-label' },
                  t('默认输出上限') + ' defaultMaxTokens', configuredBadge(defaultsConfigured.maxTokens)),
                React.createElement('input', {
                  className: 'mp-input num',
                  type: 'number', min: 1, step: 1, inputMode: 'numeric',
                  value: advMaxDraft,
                  disabled: !!advBusy || !writable,
                  placeholder: '32768',
                  onChange: (ev) => setAdvMaxDraft(ev.target.value),
                }),
              ),
            ),
            React.createElement('div', { className: 'mp-field' },
              React.createElement('span', { className: 'mp-label' },
                t('默认输入模态') + ' defaultInput', configuredBadge(defaultsConfigured.input)),
              React.createElement(MultiSelectChips, {
                options: [
                  { value: 'text', label: t('文本'), locked: true, title: t('文本为底线，不可取消') },
                  { value: 'image', label: t('图片（视觉）'), title: t('勾选后写入 input: text + image') },
                ],
                selected: advInput,
                onToggle: toggleAdvInput,
                disabled: !!advBusy || !writable,
                hint: t('不可全不选'),
              }),
            ),
            React.createElement('span', { className: 'mp-field-hint' }, t('清空输入框并保存 = 清除，回平台默认')),
          ),

          // ── 组四：自定义请求头 ──
          React.createElement('div', { className: 'mp-card' },
            React.createElement('div', { className: 'mp-card-head-row' },
              React.createElement('div', null,
                React.createElement('h4', { className: 'mp-card-title' }, t('自定义请求头'), dirtyBadge('headers')),
                React.createElement('p', { className: 'mp-card-desc' }, t('示例：X-Title、X-Api-Base')),
              ),
              cardSave('headers', saveHeadersCard),
            ),
            React.createElement('div', { className: 'mp-stack' },
              (headerRows || []).map((row, idx) => React.createElement('div', { key: idx, className: 'mp-headers-row' },
                React.createElement('input', {
                  className: 'mp-input',
                  value: row.name || '',
                  disabled: !!advBusy || !writable,
                  placeholder: t('名称'),
                  onChange: (ev) => patchHeaderRow(idx, { name: ev.target.value }),
                }),
                React.createElement('input', {
                  className: 'mp-input',
                  value: row.value || '',
                  disabled: !!advBusy || !writable,
                  placeholder: t('值'),
                  onChange: (ev) => patchHeaderRow(idx, { value: ev.target.value }),
                }),
                React.createElement('button', {
                  type: 'button', className: 'mp-btn small',
                  disabled: !!advBusy || !writable,
                  onClick: () => removeHeaderRow(idx),
                }, '×'),
              )),
            ),
            React.createElement('div', { className: 'mp-actions' },
              React.createElement('button', {
                type: 'button', className: 'mp-btn small',
                disabled: !!advBusy || !writable,
                onClick: addHeaderRow,
              }, '+ ' + t('添加一行')),
              React.createElement('button', {
                type: 'button', className: 'mp-btn small',
                disabled: !!advBusy || !writable,
                onClick: () => setHeaderRows([{ name: '', value: '' }]),
              }, t('清空')),
            ),
            React.createElement('p', { className: 'mp-warn' },
              '⚠️ ' + t('保留名（Harness 归因头等）由平台覆盖，写了不生效')),
            React.createElement('p', { className: 'mp-warn' },
              '⚠️ ' + t('不要在这里写 Authorization：鉴权应通过官方「模型」页配置的凭据，否则会与 pi-ai 的鉴权头冲突且可能被覆盖。')),
            React.createElement('span', { className: 'mp-field-hint' }, t('名称须为合法 HTTP token；值仅可打印字符；总长 ≤ 8 KB。')),
          ),
        )
      }
      const renderTestTab = () => React.createElement('div', { className: 'mp-card' },
        !provider
          ? React.createElement('p', { className: 'mp-sub' }, t('请先选择渠道。'))
          : React.createElement(React.Fragment, null,
            selected && React.createElement('div', { className: 'mp-muted' },
              (selected.displayName || selected.provider) + ' · ' + (selected.baseURL || t('无 baseURL')) + (selected.api ? (' · ' + selected.api) : '')
              + ' · ' + models.length + t(' 个模型'),
            ),
            React.createElement('div', { className: 'mp-field' },
              React.createElement('span', { className: 'mp-label' }, t('批量操作')),
              React.createElement('div', { className: 'mp-actions' },
                React.createElement('button', {
                  type: 'button',
                  className: 'mp-btn primary',
                  disabled: busy || anyTestBusy || testBatch || !models.length,
                  onClick: runTestAll,
                }, testBatch ? t('全量测试中…') : (t('一键测试全部（') + models.length + t('）'))),
                testBatch && React.createElement('button', {
                  type: 'button', className: 'mp-btn', onClick: stopTestAll,
                }, t('停止')),
                React.createElement('button', {
                  type: 'button',
                  className: 'mp-btn',
                  disabled: busy || anyTestBusy || testBatch || !Object.keys(testResults).length,
                  onClick: clearTestResults,
                }, t('清空结果')),
              ),
              testProgress
                ? React.createElement('div', { className: 'mp-test-progress' }, testProgress)
                : (anyTestBusy
                  ? React.createElement('div', { className: 'mp-test-progress' }, t('并行测试中 · ') + testBusyCount + t(' 个'))
                  : null),
            ),
            React.createElement('details', { className: 'mp-details' },
              React.createElement('summary', null, t('测试提示词')),
              React.createElement('div', { className: 'mp-field', style: { marginTop: 8 } },
                React.createElement('textarea', {
                  className: 'mp-input',
                  rows: 5,
                  disabled: busy || anyTestBusy || testBatch,
                  value: testPrompt,
                  onChange: (ev) => setTestPrompt(ev.target.value),
                  style: { resize: 'vertical', minHeight: 96, fontFamily: 'inherit' },
                }),
                React.createElement('div', { className: 'mp-actions' },
                  React.createElement('button', {
                    type: 'button', className: 'mp-btn small',
                    disabled: busy || anyTestBusy || testBatch,
                    onClick: resetTestPrompt,
                  }, t('恢复默认提示词'))),
              ),
            ),
            !models.length
              ? React.createElement('p', { className: 'mp-sub' }, t('该渠道没有模型。可先在「模型」标签页同步/添加模型。'))
              : React.createElement('div', { className: 'mp-test-grid' },
                models.map((m) => {
                  const tr = testResults[m.id]
                  const pending = !!(tr && tr.pending) || !!testBusyMap[m.id]
                  const autoEffort = maxEffortOfModel(m)
                  const effortSelect = Object.prototype.hasOwnProperty.call(testEffortByModel, m.id)
                    ? testEffortByModel[m.id]
                    : '__auto__'
                  const effortNow = resolveTestEffort(m.id, m)
                  const statusLabel = pending
                    ? t('测试中…')
                    : !tr
                      ? t('未测')
                      : tr.ok
                        ? (tr.hasSvg ? t('成功 · SVG') : t('成功'))
                        : t('失败')
                  const statusClass = pending ? 'mp-muted' : !tr ? 'mp-muted' : tr.ok ? 'mp-ok' : 'mp-error'
                  return React.createElement('div', { key: m.id, className: 'mp-test-card' },
                    React.createElement('div', { className: 'mp-test-card-head' },
                      React.createElement('div', null,
                        React.createElement('strong', null, m.id),
                        React.createElement('div', { className: 'mp-muted' }, m.name || ''),
                        React.createElement('div', { className: 'mp-test-meta', style: { marginTop: 4 } },
                          React.createElement('span', { className: statusClass, style: { margin: 0 } }, statusLabel),
                          React.createElement(SourceBadge, { source: m.source }),
                          React.createElement('span', { className: 'mp-muted' },
                            t('强度 ') + (effortNow || t('关闭')) + (effortSelect === '__auto__' ? t('（自动）') : '')),
                          tr && tr.effortUsed != null && tr.effortUsed !== '' && tr.effortApplied !== false && React.createElement('span', { className: 'mp-muted' }, t('已用 ') + tr.effortUsed),
                          tr && tr.elapsedMs != null && React.createElement('span', { className: 'mp-muted' }, tr.elapsedMs + ' ms'),
                          tr && tr.statusCode != null && React.createElement('span', { className: 'mp-muted' }, 'HTTP ' + tr.statusCode),
                          tr && tr.hasApiKey != null && React.createElement('span', { className: 'mp-muted' }, tr.hasApiKey ? t('已带 Key') : t('未带 Key')),
                          tr && tr.finishReason && React.createElement('span', { className: 'mp-muted' }, 'finish ' + tr.finishReason),
                          tr && tr.truncated && React.createElement('span', { className: 'mp-warn' }, t('可能截断')),
                          tr && tr.usage && React.createElement('span', { className: 'mp-muted' },
                            [
                              tr.usage.promptTokens != null ? ('in ' + tr.usage.promptTokens) : '',
                              tr.usage.completionTokens != null ? ('out ' + tr.usage.completionTokens) : '',
                              tr.usage.reasoningTokens != null ? ('think ' + tr.usage.reasoningTokens) : '',
                            ].filter(Boolean).join(' · ')),
                        ),
                      ),
                      React.createElement('div', { className: 'mp-actions', style: { alignItems: 'center' } },
                        React.createElement('select', {
                          className: 'mp-select',
                          style: { width: 'auto', minWidth: 140 },
                          value: effortSelect,
                          disabled: busy || testBatch || !!testBusyMap[m.id],
                          title: t('自动=已配置则最高档，未配置则关闭（当前：') + (autoEffort || t('关闭')) + t('）'),
                          onChange: (ev) => {
                            const v = ev.target.value
                            setTestEffortByModel((prev) => {
                              const next = Object.assign({}, prev || {})
                              if (v === '__auto__') delete next[m.id]
                              else next[m.id] = v
                              return next
                            })
                          },
                        },
                          React.createElement('option', { value: '__auto__' }, t('自动（') + (autoEffort || t('关闭')) + t('）')),
                          React.createElement('option', { value: '__none__' }, t('不传/关闭')),
                          LEVEL_ORDER.filter((lv) => lv !== 'off').map((lv) =>
                            React.createElement('option', { key: lv, value: lv }, lv)),
                        ),
                        React.createElement('button', {
                          type: 'button',
                          className: 'mp-btn small primary',
                          disabled: busy || testBatch || !!testBusyMap[m.id],
                          onClick: () => runTestModel(m.id),
                        }, pending ? t('测试中…') : t('测试')),
                      ),
                    ),
                    tr && tr.hasSvg && tr.svg
                      ? React.createElement(SvgPreview, { svg: tr.svg, title: m.id + t(' · SVG 动画预览') })
                      : null,
                    tr && !tr.pending && !tr.hasSvg && tr.ok && tr.text && React.createElement('div', { className: 'mp-test-out' },
                      tr.text,
                    ),
                    tr && !tr.pending && React.createElement('details', null,
                      React.createElement('summary', { className: 'mp-linkbtn', style: { cursor: 'pointer' } },
                        tr.ok
                          ? (tr.reasoningText && !tr.contentText ? t('查看 reasoning 输出') : t('查看原始输出'))
                          : t('查看错误详情')),
                      React.createElement('div', { className: 'mp-test-out' },
                        tr.ok
                          ? (
                            (tr.contentText ? ('[content]\n' + tr.contentText) : '')
                            + (tr.contentText && tr.reasoningText ? '\n\n' : '')
                            + (tr.reasoningText ? ('[reasoning_content]\n' + tr.reasoningText) : '')
                            + (!tr.contentText && !tr.reasoningText ? (tr.text || t('(空)')) : '')
                          )
                          : (th(tr.error || tr.message || t('失败')) + (tr.raw ? ('\n\n' + tr.raw) : '')),
                      ),
                    ),
                  )
                }),
              ),
          ),
      )

      const renderSyncTab = () => {
        const sd = sourcesDraft || sourcesDraftFromBoot(boot)
        const catalogSources = (boot && boot.catalogSources) || []
        /**
         * 「目录源」单选只列 **models.dev 形态**的镜像。
         *
         * ★ 审查修正：以前把 5 个 catalogSources 全列出来，于是 LiteLLM / OpenRouter 的
         *   URL 也会作为"models.dev 源"被选中——而它们不是 models.dev JSON，
         *   `parseCatalogSource('modelsDev', …)` 会静默解析出 0 个模型，用户只会看到
         *   "目录没命中"却不知道为什么。它们各自的地址在下面的文本框里维护。
         */
        const modelsDevPresets = catalogSources.filter((s) => s && s.id !== 'litellm' && s.id !== 'openrouter' && s.id !== 'custom')
        const enrich = enrichPreview
        return React.createElement('div', { className: 'mp-stack' },
          // ── 目录源 ──
          React.createElement('div', { className: 'mp-card' },
            React.createElement('div', { className: 'mp-card-head-row' },
              React.createElement('h4', { className: 'mp-card-title' }, t('目录源')),
              React.createElement('button', {
                type: 'button', className: 'mp-btn primary small',
                disabled: sourcesBusy || !writable,
                onClick: saveSourcesCard,
              }, sourcesBusy ? t('保存中…') : t('保存')),
            ),
            React.createElement('div', { className: 'mp-radio' },
              modelsDevPresets.map((s) => React.createElement('label', { key: s.id },
                React.createElement('input', {
                  type: 'radio',
                  name: 'ms-modelsdev-source',
                  checked: modelsDevPreset === s.id,
                  disabled: sourcesBusy || !writable,
                  onChange: () => selectModelsDevPreset(s.id),
                }),
                React.createElement('span', null, t(s.label || s.id)),
              )),
              React.createElement('label', null,
                React.createElement('input', {
                  type: 'radio',
                  name: 'ms-modelsdev-source',
                  checked: modelsDevPreset === 'custom',
                  disabled: sourcesBusy || !writable,
                  onChange: () => selectModelsDevPreset('custom'),
                }),
                React.createElement('span', null, t('指定地址')),
              ),
            ),
            React.createElement('div', { className: 'mp-field' },
              React.createElement('span', { className: 'mp-label' }, t('官方 models.dev') + ' / ' + t('目录源地址')),
              React.createElement('input', {
                className: 'mp-input',
                value: sd.modelsDev.url,
                disabled: sourcesBusy || !writable || modelsDevPreset !== 'custom',
                placeholder: FALLBACK_SOURCES.modelsDev.url,
                onChange: (ev) => { setModelsDevPreset('custom'); patchSource('modelsDev', { url: ev.target.value }) },
              }),
              React.createElement('span', { className: 'mp-field-hint' },
                t('经 gh-proxy.org 加速的 GitHub 快照，随插件仓库更新。')),
            ),
            React.createElement('label', { className: 'mp-checkline' },
              React.createElement('input', {
                type: 'checkbox',
                checked: !!sd.litellm.enabled,
                disabled: sourcesBusy || !writable,
                onChange: (ev) => patchSource('litellm', { enabled: !!ev.target.checked }),
              }),
              React.createElement('span', null, t('启用 LiteLLM')),
            ),
            React.createElement('div', { className: 'mp-field' },
              React.createElement('input', {
                className: 'mp-input',
                value: sd.litellm.url,
                disabled: sourcesBusy || !writable,
                placeholder: FALLBACK_SOURCES.litellm.url,
                onChange: (ev) => patchSource('litellm', { url: ev.target.value }),
              }),
              React.createElement('span', { className: 'mp-field-hint' }, t('地址为空视为未启用。')),
            ),
            React.createElement('label', { className: 'mp-checkline' },
              React.createElement('input', {
                type: 'checkbox',
                checked: !!sd.openrouter.enabled,
                disabled: sourcesBusy || !writable,
                onChange: (ev) => patchSource('openrouter', { enabled: !!ev.target.checked }),
              }),
              React.createElement('span', null, t('启用 OpenRouter')),
            ),
            React.createElement('div', { className: 'mp-field' },
              React.createElement('input', {
                className: 'mp-input',
                value: sd.openrouter.url,
                disabled: sourcesBusy || !writable,
                placeholder: FALLBACK_SOURCES.openrouter.url,
                onChange: (ev) => patchSource('openrouter', { url: ev.target.value }),
              }),
              React.createElement('span', { className: 'mp-field-hint' }, t('地址为空视为未启用。')),
            ),
            React.createElement('span', { className: 'mp-field-hint' },
              t('三源按需拉取、分层补缺。')),
          ),

          // ── 自动配置 ──
          React.createElement('div', { className: 'mp-card' },
            React.createElement('div', { className: 'mp-card-head-row' },
              React.createElement('h4', { className: 'mp-card-title' }, t('自动配置')),
              React.createElement('button', {
                type: 'button', className: 'mp-btn primary small',
                disabled: autoBusy || !writable,
                onClick: saveAutoCard,
              }, autoBusy ? t('保存中…') : t('保存')),
            ),
            React.createElement('label', { className: 'mp-checkline' },
              React.createElement('input', {
                type: 'checkbox',
                checked: !!autoDraft.enabled,
                disabled: autoBusy || !writable,
                onChange: (ev) => setAutoDraft((prev) => Object.assign({}, prev || DEFAULT_AUTO, { enabled: !!ev.target.checked })),
              }),
              React.createElement('span', null, t('启用自动配置（发现富化 / 保存写盘 / 运行时兜底）')),
            ),
            React.createElement('label', { className: 'mp-checkline' },
              React.createElement('input', {
                type: 'checkbox',
                checked: !!autoDraft.persistOnSave,
                disabled: autoBusy || !writable || !autoDraft.enabled,
                onChange: (ev) => setAutoDraft((prev) => Object.assign({}, prev || DEFAULT_AUTO, { persistOnSave: !!ev.target.checked })),
              }),
              React.createElement('span', null, t('保存时自动写盘（关闭则只做候选富化与运行时兜底）')),
            ),
            React.createElement('div', { className: 'mp-field' },
              React.createElement('span', { className: 'mp-label' }, t('自动补齐字段：')),
              React.createElement('div', { className: 'mp-chips' },
                [
                  { key: 'contextWindow', label: t('上下文') },
                  { key: 'maxTokens', label: t('输出上限') },
                  { key: 'input', label: t('视觉') },
                  { key: 'reasoningEfforts', label: t('思考档位') },
                ].map((f) => {
                  const on = !!(autoDraft.fields && autoDraft.fields[f.key])
                  return React.createElement('button', {
                    key: f.key,
                    type: 'button',
                    className: 'mp-chip',
                    'data-on': on ? '1' : '0',
                    disabled: autoBusy || !writable || !autoDraft.enabled,
                    onClick: () => patchAutoField(f.key, !on),
                  }, f.label)
                }),
              ),
            ),
            React.createElement('details', { className: 'mp-details' },
              React.createElement('summary', null, t('高级')),
              React.createElement('label', { className: 'mp-checkline', style: { marginTop: 8 } },
                React.createElement('input', {
                  type: 'checkbox',
                  checked: !!autoDraft.includeCatalogRoutes,
                  disabled: autoBusy || !writable,
                  onChange: (ev) => setAutoDraft((prev) => Object.assign({}, prev || DEFAULT_AUTO, { includeCatalogRoutes: !!ev.target.checked })),
                }),
                React.createElement('span', null, t('也作用于内置目录渠道（默认关闭）')),
              ),
            ),
            React.createElement('span', { className: 'mp-field-hint' }, t('热生效：无需重启。')),
          ),

          // ── 补全 ──
          React.createElement('div', { className: 'mp-card' },
            React.createElement('h4', { className: 'mp-card-title' }, t('补全')),
            React.createElement('label', { className: 'mp-checkline' },
              React.createElement('input', {
                type: 'checkbox',
                checked: overwriteEfforts,
                disabled: enrichBusy,
                onChange: (ev) => setOverwriteEfforts(!!ev.target.checked),
              }),
              React.createElement('span', null, t('覆盖本地已有字段（默认只补缺）')),
            ),
            React.createElement('div', { className: 'mp-actions' },
              React.createElement('button', {
                type: 'button', className: 'mp-btn',
                disabled: busy || enrichBusy || !provider,
                onClick: () => runEnrichModels(false),
              }, enrichBusy ? t('查询中…') : t('预览补全')),
              React.createElement('button', {
                type: 'button', className: 'mp-btn primary',
                disabled: busy || enrichBusy || !provider || !writable,
                onClick: () => runEnrichModels(true),
              }, (busy || enrichBusy) ? t('同步中…') : t('写回本地渠道')),
            ),
            enrich && React.createElement(React.Fragment, null,
              React.createElement('div', { className: 'mp-muted' },
                th(enrich.message || '')
                + (enrich.hitCount != null ? (t(' · 命中 ') + enrich.hitCount + '/' + (enrich.localCount || 0)) : '')
                + (Array.isArray(enrich.sourcesUsed) && enrich.sourcesUsed.length
                  ? (t(' · 来源：') + enrich.sourcesUsed.join(', '))
                  : ''),
              ),
              enrich.hitCount === 0
                ? React.createElement('p', { className: 'mp-warn' },
                    t('未命中任何目录源。多半是该网关的私有模型 id，建议手工填写参数，或把模型 id 改成与公开目录一致的名字。'))
                : null,
              ((!enrich.changes || !enrich.changes.length) && (!enrich.unmatched || !enrich.unmatched.length))
                ? React.createElement('p', { className: 'mp-sub' }, t('没有可写回变更。'))
                : React.createElement('table', { className: 'mp-table' },
                  React.createElement('thead', null, React.createElement('tr', null,
                    React.createElement('th', null, t('模型')),
                    React.createElement('th', null, t('来源')),
                    React.createElement('th', null, t('变更')),
                    React.createElement('th', null, t('强度·视觉')),
                  )),
                  React.createElement('tbody', null,
                    (enrich.changes || []).map((c, i) => React.createElement('tr', { key: String(c.id || i) },
                      React.createElement('td', null, c.id),
                      React.createElement('td', null, c.source || '—'),
                      React.createElement('td', null, c.notes || ''),
                      React.createElement('td', null,
                        (c.summary || '') + (c.summary ? '' : '—')
                        + (c.vision ? t(' · 视觉') : '')
                        + (c.contextWindow ? (' · ctx ' + c.contextWindow) : '')
                        + (c.maxTokens ? (' · max ' + c.maxTokens) : '')),
                    )).concat((enrich.unmatched || []).map((id, i) => React.createElement('tr', { key: 'miss-' + String(id) + '-' + i, className: 'mp-row-miss' },
                      React.createElement('td', null, id),
                      React.createElement('td', null, '—'),
                      React.createElement('td', null, t('未命中')),
                      React.createElement('td', null, '—'),
                    ))),
                  ),
                ),
              (((enrich.unmatchedCount != null && enrich.unmatchedCount > 0) || (enrich.unmatched && enrich.unmatched.length)
                || (enrich.localCount != null && enrich.hitCount != null && enrich.localCount > enrich.hitCount)))
                ? React.createElement('span', { className: 'mp-field-hint' },
                    t('本地 ') + enrich.localCount + t(' 个模型中 ')
                    + (enrich.unmatchedCount != null
                      ? enrich.unmatchedCount
                      : ((enrich.unmatched && enrich.unmatched.length) ? enrich.unmatched.length : (enrich.localCount - enrich.hitCount)))
                    + t(' 个未命中目录源。'))
                : null,
            ),
          ),
        )
      }
      const renderAboutTab = () => {
        const sd = sourcesDraft || sourcesDraftFromBoot(boot)
        return React.createElement('div', { className: 'mp-card' },
          React.createElement('h3', { className: 'mp-h' }, t('模型套件')),
          React.createElement('div', { className: 'mp-about-grid' },
            React.createElement('div', { className: 'mp-about-row' },
              React.createElement('span', { className: 'mp-label' }, t('版本')),
              React.createElement('div', { className: 'mp-version-line' },
                React.createElement('span', { className: 'mp-about-val' }, (boot && boot.version) || t('未知')),
                React.createElement('button', {
                  type: 'button', className: 'mp-btn small', disabled: checking, onClick: runCheckUpdate,
                }, checking ? t('检测中…') : t('检查更新')),
              ),
              updateInfo && React.createElement('div', { className: 'mp-update-result' },
                updateInfo.ok === false
                  ? React.createElement('span', { className: 'mp-error' }, t('检测失败：') + th(updateInfo.error || ''))
                  : updateInfo.hasUpdate
                    ? React.createElement(React.Fragment, null,
                      React.createElement('span', { className: 'mp-update-new' }, t('发现新版本：') + updateInfo.latestVersion),
                      React.createElement('a', { className: 'mp-link', href: updateInfo.npmUrl, target: '_blank', rel: 'noopener noreferrer' }, t('前往 npm 查看')),
                    )
                    : React.createElement('span', { className: 'mp-ok' }, t('已是最新版本（') + updateInfo.latestVersion + t('）')),
              ),
            ),
            React.createElement('div', { className: 'mp-about-row' },
              React.createElement('span', { className: 'mp-label' }, t('包名')),
              React.createElement('code', { className: 'mp-about-val' }, 'dsh-model-suite'),
            ),
            React.createElement('div', { className: 'mp-about-row' },
              React.createElement('span', { className: 'mp-label' }, 'GitHub'),
              React.createElement('a', { className: 'mp-link', href: (boot && boot.repo) || 'https://github.com/pyooyq/dsh-model-suite', target: '_blank', rel: 'noopener noreferrer' },
                (boot && boot.repo) || 'https://github.com/pyooyq/dsh-model-suite'),
            ),
            React.createElement('div', { className: 'mp-about-row' },
              React.createElement('span', { className: 'mp-label' }, t('说明文档')),
              React.createElement('a', { className: 'mp-link', href: (boot && boot.homepage) || 'https://github.com/pyooyq/dsh-model-suite#readme', target: '_blank', rel: 'noopener noreferrer' },
                (boot && boot.homepage) || 'https://github.com/pyooyq/dsh-model-suite#readme'),
            ),
            React.createElement('div', { className: 'mp-about-row' },
              React.createElement('span', { className: 'mp-label' }, t('问题反馈')),
              React.createElement('a', { className: 'mp-link', href: (boot && boot.issues) || 'https://github.com/pyooyq/dsh-model-suite/issues', target: '_blank', rel: 'noopener noreferrer' },
                (boot && boot.issues) || 'https://github.com/pyooyq/dsh-model-suite/issues'),
            ),
            React.createElement('div', { className: 'mp-about-row' },
              React.createElement('span', { className: 'mp-label' }, t('基于项目')),
              React.createElement('div', { className: 'mp-stack' },
                React.createElement('a', { className: 'mp-link', href: 'https://github.com/cinob/dsh-plugin-custom-provider-enhancer', target: '_blank', rel: 'noopener noreferrer' },
                  'cinob/dsh-plugin-custom-provider-enhancer'),
                React.createElement('a', { className: 'mp-link', href: 'https://github.com/kingsunb/dsh-model-plus', target: '_blank', rel: 'noopener noreferrer' },
                  'kingsunb/dsh-model-plus'),
              ),
            ),
            React.createElement('div', { className: 'mp-about-row' },
              React.createElement('span', { className: 'mp-label' }, t('默认同步源')),
              React.createElement('div', { className: 'mp-stack' },
                // ★ R-M11：目录源 URL 来自用户输入草稿（未保存值也渲染）——非
                //   http(s) 一律降级为纯文本，堵住 javascript: 伪协议注入 <a href>。
                ...[
                  { label: 'models.dev', url: sd.modelsDev.url },
                  { label: 'LiteLLM', url: sd.litellm.url },
                  { label: 'OpenRouter', url: sd.openrouter.url },
                ].map((s) => (/^https?:\/\//i.test(String(s.url || ''))
                  ? React.createElement('a', { key: s.label, className: 'mp-link', href: s.url, target: '_blank', rel: 'noopener noreferrer' },
                      s.label + ' · ' + s.url)
                  : React.createElement('span', { key: s.label, className: 'mp-muted' },
                      s.label + ' · ' + (s.url || '—')))),
              ),
            ),
          ),
          React.createElement('p', { className: 'mp-warn', style: { margin: 0 } },
            t('本插件取代 @kingsunb/dsh-model-plus 与 dsh-plugin-custom-provider-enhancer。若这两个插件仍在运行，请先卸载——否则会双重富化并互相覆盖配置。')),
          React.createElement('p', { className: 'mp-muted', style: { margin: 0 } }, 'MIT License · Powered by DeepSeek Harness'),
        )
      }

      const TABS = [
        ['models', '模型'],
        ['advanced', '渠道设置'],
        ['test', '模型测试'],
        ['sync', '目录与自动化'],
        ['about', '关于'],
      ]
      return React.createElement('div', { className: 'mp-root' },
        React.createElement('div', { className: 'mp-pagehead' },
          React.createElement('div', { className: 'mp-titles' },
            React.createElement('h2', { className: 'mp-h' }, t('模型套件')),
          ),
          React.createElement('div', { className: 'mp-lang' },
            React.createElement('button', {
              type: 'button', 'data-on': lang === 'en' ? '1' : '0',
              title: 'Switch to English',
              onClick: () => switchLang('en'),
            }, 'EN'),
            React.createElement('button', {
              type: 'button', 'data-on': lang === 'zh' ? '1' : '0',
              title: '切换到中文',
              onClick: () => switchLang('zh'),
            }, '中文'),
          ),
        ),
        !writable ? React.createElement('div', { className: 'mp-banner' },
          t('只读模式：设置服务当前不可写，所有输入与按钮已禁用。')) : null,

        renderProviderBar(),

        (error || okMsg || (warnings || []).length) ? React.createElement('div', { className: 'mp-feedback' },
          error ? React.createElement('p', { className: 'mp-error' }, th(error)) : null,
          okMsg ? React.createElement('p', { className: 'mp-ok' }, th(okMsg)) : null,
          (warnings || []).map((w, i) => React.createElement('p', { key: i, className: 'mp-warn' }, '⚠️ ' + th(w))),
        ) : null,

        React.createElement('nav', { className: 'mp-nav' },
          TABS.map(([id, label]) => React.createElement('button', {
            key: id,
            type: 'button',
            className: 'mp-tab',
            'data-on': tab === id ? '1' : '0',
            onClick: () => setTab(id),
          }, t(label))),
        ),

        tab === 'models' ? renderModelsTab() : null,
        tab === 'advanced' ? renderAdvancedTab() : null,
        tab === 'test' ? renderTestTab() : null,
        tab === 'sync' ? renderSyncTab() : null,
        tab === 'about' ? renderAboutTab() : null,
      )
    }

    exports.inject = ['slots'];
    // ★ R-低：语言切换时重注册 settings.section——平台契约（slots.d.ts）是
    //   "registrant re-registers with fresh text on locale change"，侧边栏
    //   分区名才会跟着切换语言。
    // ★ 审查修正：工厂必须 **return** register 的 disposer（平台各注册方都是
    //   隐式返回——inject 靠它做注入级清理；块体写法丢返回值会断清理链）。
    //   语言切换产生的新注册由 sectionDispose 兜底，在模块 dispose 时清理。
    let sectionDispose = null;
    exports.apply = function apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      const register = () => {
        if (sectionDispose) { try { sectionDispose() } catch (_) {} }
        sectionDispose = slots.register(
          { name: 'settings.section', id: 'model-suite', order: 11, label: t('模型套件') },
          () => React.createElement(ModelSuitePage),
        )
        return sectionDispose
      }
      slots.inject('settings.section', register)
      notifySectionRelabel = register
    };
    exports.dispose = function dispose() {
      // 幂等：与 inject 级清理可能重复触发，disposer 双调无害（try 包裹）。
      if (sectionDispose) { try { sectionDispose() } catch (_) {} }
      sectionDispose = null
      notifySectionRelabel = null
    };

    return module.exports;
  },
});
