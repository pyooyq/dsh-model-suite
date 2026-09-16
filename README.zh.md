# dsh-model-suite

[English](README.md) | 简体中文

> DSH Web 插件：**模型套件** —— 一个页面覆盖模型配置的全部面：逐模型编辑（含官方页做不到的**思考档位**与**兼容开关**）、渠道级高级设置、三源目录一键同步，以及对自定义渠道的**自动参数补全**。

> 本项目基于 [cinob/dsh-plugin-custom-provider-enhancer](https://github.com/cinob/dsh-plugin-custom-provider-enhancer) 与 [kingsunb/dsh-model-plus](https://github.com/kingsunb/dsh-model-plus) 整合重构而来，感谢两个前身项目的作者。

- 包名 `dsh-model-suite`，cordis 插件名 `model-suite`，HTTP 前缀 `/api/suite`
- 读写命名空间 `llm-pi-ai`，插件偏好键 `llm-pi-ai.__modelSuite`
- **无构建步骤**：`lib/*.js` 源码即产物（`scripts/build.mjs` 只做形状校验）
- 目标 DSH：`0.1.5-rc.2`（核对基准）

---

## 1. 它解决什么问题

DSH 官方「模型」页负责供应商与模型条目的基础字段，但**不提供**：

| 能力 | 官方「模型」页 | 本插件 |
| :-- | :-- | :-- |
| 供应商新建/编辑/删除 | ✅ | ❌（主动移除，回归官方页） |
| `contextWindow` / `maxTokens` | ✅ | ✅ |
| `input`（视觉模态） | 部分 | ✅ chips 编辑 |
| `reasoningEfforts`（思考档位） | ❌ 完全没有 | ✅ 7 档 + wire 值 |
| `compat`（兼容开关） | ❌ | ✅ 渠道级 + 模型级全量（19/4/7/1） |
| `headers` / 路由默认值 / `retryPolicy` | ❌ | ✅ 渠道设置 |
| 模型测试 / 目录同步 / 自动补全 | ❌ | ✅ |

典型场景：某个 OpenAI 兼容网关不认 `developer` 角色，聊天直接 400。以前只能手改 `settings.yaml`，现在在「渠道设置 → 兼容开关」把「允许 developer 角色」设为 `false` 即可。

---

## 2. 安装

作为标准 DSH Profile Bundle 组合包，从 GitHub 一键安装并自动挂载：

```sh
dsh plugin --profile web add github:pyooyq/dsh-model-suite
dsh web
```

或从 npm 安装（发布后）：

```sh
dsh plugin --profile web add dsh-model-suite
dsh web
```

本地开发可用 link（仓库根即包目录，含 `package.json` 的那一层）：

```sh
dsh plugin --profile web add link:<绝对路径>/dsh-model-suite
dsh web
```

---

## 3. 从两个前身插件迁移（必做）

本插件取代 `@kingsunb/dsh-model-plus` 与 `dsh-plugin-custom-provider-enhancer`。三者都会拦截 settings 写入与 `llm.resolveModelInfo`，**同时启用会双重富化并互相覆盖配置**。

```sh
# 1) 卸载冲突插件
dsh plugin --profile web remove @kingsunb/dsh-model-plus
dsh plugin --profile web remove dsh-plugin-custom-provider-enhancer

# 2) 安装本插件
dsh plugin --profile web add link:<绝对路径>/dsh-model-suite

# 3) 重启 web
dsh web
```

- 已写入 `llm-pi-ai` 的模型配置**不会被回滚**（那是内核配置，不是插件数据）。
- 偏好迁移：首次 bootstrap 时把 `__modelPlus` 的目录地址复制到 `__modelSuite`（一次性，**不删除**旧键）。
- 界面语言偏好：写 `localStorage['ms.lang']`，首次读取时回退 `mp.lang`。

卸载：

```sh
dsh plugin --profile web remove dsh-model-suite
```

卸载会摘除 14 条路由并**干净还原**三处补丁（原本没有自有属性的方法会被 `delete`，不留转发壳），无需重启即恢复原行为。

---

## 4. 界面结构

页面骨架：**页头**（标题 + 中英切换）→ **渠道工具栏**（只读渠道选择器、语义化能力徽章——推理/视觉/兼容/重试/内置或自定义——以及「一键同步」「更新模型列表」；baseURL 与协议收进一行小字）→ **全局反馈条** → **下划线式 Tab 导航**。

五个 Tab：

1. **模型** — 紧凑只读表格（id、能力徽章、上下文、输出上限），点「编辑」展开编辑器：分区排版（显示名 / 输入模态 / 思考强度 7 档 + 快捷预设 / 容量参数 / wire 高级 / 模型级兼容开关），底部固定操作条「保存此模型 / 删除」，该模型的错误就地显示；支持搜索、手动添加与删除（删除有二次确认）。
   - 思考强度是**三态**：勾了非 off 档 → 写档位表；勾「关闭推理」（所有档位留空）→ 写 `reasoningEfforts: false`；**一个档位都不勾** → 保存时**不写该字段**，沿用目录/探测能力（不会把"未设置"静默变成"关闭"）。
   - 目录自动补全的档位**总是带 `off`**，所以这类模型的思考菜单里一定有「关闭」项（`off: null` = 支持关闭，选它就不发送强度参数）。
   - 模型 id **原样保留大小写**（`Llama-3.1-8B` 不会被改写成小写）；插件写回时也不会顺手改动你其它条目的 id。
2. **渠道设置** — 四张卡片，各自独立保存：兼容开关、重试策略、路由默认值、自定义请求头。卡片头行带**「未保存」脏标记**，保存按钮只在草稿与服务端快照不一致时高亮；兼容开关按主题分组（推理与思考 / 工具调用 / 流式与传输 / 缓存与存储 / 请求字段），支持**搜索**与**「仅看已配置」**——渠道级与模型级共用这套交互。
3. **模型测试** — 并行测试、SVG 预览（`iframe sandbox=""`）、原始输出与错误详情保留；测试提示词折叠进可展开区块；结果卡带**参数来源徽章**。
4. **目录与自动化** — 三源地址与启用状态、自动配置开关（总开关 / 写盘开关 / 四字段开关 / 高级范围）、补全预览与写回。
5. **关于** — 版本与检查更新、仓库与反馈入口、迁移提示。

---

## 5. 自动配置（三链路）

安装后对**自定义渠道**（route 不在 pi-ai 内置目录名单内的 40 个 id 里）自动补全模型参数，**只补缺，绝不覆盖你已填的值**。

| 链路 | 触发点 | 可写字段 |
| :-- | :-- | :-- |
| 一 · 发现 | 官方「模型」页点「获取可用模型」 | `contextWindow`、`maxTokens` |
| 二 · 保存 | 任何对 `llm-pi-ai` 的 settings 写入 | `contextWindow`、`maxTokens`、`input`、`reasoningEfforts` |
| 三 · 运行时 | 聊天/模型目录解析模型信息 | `context`、`defaultMaxTokens`、`inputModalities`、`reasoning` |

开关（「目录与自动化」Tab，**热生效**，无需重启）：

```jsonc
{
  "auto": {
    "enabled": true,            // 总开关：三链路
    "persistOnSave": true,      // 链路二：保存时自动写盘
    "fields": {                 // 四类字段各自开关
      "contextWindow": true, "maxTokens": true, "input": true, "reasoningEfforts": true
    },
    "includeCatalogRoutes": false  // 是否也富化内置目录渠道（高级）
  }
}
```

**不变量**（有回归测试守着）：

- 字段有值就绝不改写——`262144 / 256000 / 32768 / 32000 / 4096` **不再**被当作"未填"；
- 未命中目录时**一个字段都不写**（不再有"未知模型补 128K/4096"的误导性兜底）；
- 内置目录渠道默认不被富化（自定义渠道请用自定义 route 名，如 `hub-gm`）；
- 自动富化绝不把保存操作卡在网络上（等待目录最多 3 秒，超时放行并在后台继续拉）。

---

## 6. 三源目录

| 优先级 | 源 | 地址 | 默认 |
| :-- | :-- | :-- | :-- |
| 1 | **models.dev** | `https://models.dev/api.json`（可切国内加速 / 自定义） | 启用 |
| 2 | **LiteLLM** | `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json` | 启用 |
| 3 | **OpenRouter** | `https://openrouter.ai/api/v1/models` | 启用 |

- **分层补缺**：先注册的源提供有值的字段，低优先源只填**仍为空**的字段（不会把已解析的值降级成 `undefined`）。
- **按需拉取**：models.dev 全部命中时不再拉另两源。
- **缓存**：按 URL 分键 30 分钟 + in-flight 去重；**失败源不写缓存**，下次调用重试。
- **匹配**：两级（规范化相等 → 分隔符等价的宽松相等）。**明确不做前缀模糊匹配**——`o1-mini` 不会命中 `o1`。

仓库根 `api.json` 是 models.dev 快照，供国内加速源读取。**发布流程需包含"重新下载并提交快照"**：

```sh
curl -fsSL https://models.dev/api.json -o api.json
```

---

## 7. 安全模型

- **写端点信任栅栏**：有 `Origin` 必须与 `Host` 同源（协议 + 主机 + 端口逐项比较，绝不做后缀匹配）；无 `Origin` 仅允许 loopback 远端，否则 `403 unauthenticated write denied`。
- **出站策略**：仅 `http`/`https`；拒绝 URL 内嵌凭据、云元数据/链路本地地址、非 loopback 的明文 HTTP；目录拉取强制 HTTPS。
- **重定向**：最多 5 跳、总截止时间逐跳扣减、携带凭据禁止跨源重定向、HTTPS 禁止降级。
- **输入校验**：模型 id / 显示名长度与字符集白名单；请求头名 RFC 7230 token、值禁换行、总长 ≤ 8 KB；compat 字段只接受当前协议 `gate === 'offer'` 的字段与合法值类型（协议不支持 → `400`，**不静默丢弃**）。
- **输出消毒**：诊断文本中的凭据 → `[redacted]`、`sk-*` → `[redacted-key]`；对外错误里的 URL → `[remote-url]`、路径 → `[path]`、截断 512；SVG 拒绝 `<script` / `on*=` / `javascript:`。
- ⚠️ 这不是完整会话认证：本机任意进程仍可无 `Origin` 直连写配置（明确的取舍，与 `dsh-model-plus` 一致）。

---

## 8. HTTP API（`/api/suite`，14 个端点）

| # | 方法 | 路径 | 作用 | 写盘 |
| :-- | :-- | :-- | :-- | :-- |
| 1 | GET | `/bootstrap` | 初始化整页数据 | — |
| 2 | GET | `/list-models?provider=` | 单渠道模型视图 | — |
| 3 | POST | `/save-model` | 保存单模型（含 `name` / `compat`） | ✅ |
| 4 | POST | `/apply-preset` | 套用快捷预设 | ✅ |
| 5 | POST | `/discover-models` | 探测 `/models`（三源补全可选） | — |
| 6 | POST | `/refresh-models` | 已配置渠道拉候选（标 `isNew`） | — |
| 7 | POST | `/add-models` | 追加勾选/手填模型 | ✅ |
| 8 | POST | `/delete-model` | 删除单个模型条目 | ✅ |
| 9 | POST | `/enrich-models` | 三源补全（可预览/写回） | ✅（apply 时） |
| 10 | POST | `/save-sources` | 保存三源地址与启用状态 | ✅ |
| 11 | POST | `/save-provider-advanced` | 保存渠道级字段（白名单） | ✅ |
| 12 | POST | `/save-auto-config` | 保存自动配置开关 | ✅ |
| 13 | POST | `/test-model` | 真调一次模型 API | — |
| 14 | GET | `/check-update` | 查 npm 最新版 | — |

错误码：`400` 入参校验失败 · `403` 写栅栏拒绝 · `404` 渠道/模型不存在 · `405` 方法不匹配 · `409` CAS 冲突（**终态，不自动重试**）· `500` 内部异常（已脱敏）。

---

## 9. 开发与校验

```sh
node scripts/build.mjs             # 形状与字段数校验（发布时自动跑；刻意不用 prepare，避免 git 安装被 pnpm 拦截）
node scripts/security-smoke.mjs    # 安全与不变量回归（含真实行为断言）
node scripts/integration-smoke.mjs # 用真实 apply(ctx) 驱动 14 端点 + 三链路
node scripts/ui-smoke.mjs          # 无头渲染浏览器半区（极小 React 替身 + 树遍历点击）
npm run verify                     # 上面四个串起来跑
```

- `build.mjs`：必需文件、`package.json` 的 `dsh` 声明、host 半区导出形状（拒绝 `inject: { required, optional }`）、client 半区标记、`cordis.patch.yml`（且**不得**出现前身插件名）、目录 route 数（40）、compat 字段数（19/4/7/1，防 DSH 升级漂移）。
- `security-smoke.mjs`：把 host 半区的纯工具区段抽出来用 `new Function` 构造，对 loopback 判定、出站策略、同源比较、id 归一化、**禁止前缀匹配**、分层补缺、**仅补缺不变量**、`cloneModel` 全量保留 `compat`、compat 白名单、headers 校验、还原分支等做真实行为断言；核对 client↔host 的端点契约；并对**英文词典做双向断言**——凡被用到的一定有词条，凡词条一定可达（同时防"英文界面掉回中文"和"删功能后留下的僵尸词条"）。
- `integration-smoke.mjs`：假 settings（带 CAS 与三连降级语义，**用真 `dsh-llm-pi-ai` 的 `Config` schema 校验每次写入**）、假 `webServer`（走真实 HTTP 语义）、假 `llm`（方法挂在原型上以验证 `delete` 还原）、本地 HTTP 服务器提供三源目录**与模型列表**。
- `ui-smoke.mjs`：`lib/client.js` 是 3400 行 React UI，源码字符串断言抓不到渲染期崩溃。这里用一套极小的 React 替身（`useState/useRef/useEffect/useMemo/useCallback/createElement` + 函数组件求值 + effect→setState 重渲染循环）真的把设置页挂载起来，跑通 `bootstrap → list-models`，逐个点开五个 Tab，点开某模型卡片并点「保存此模型」，再断言发出去的请求体符合 host 契约（`provider` / `modelId` / `editor.disabled` / `levels` / `vision` / `contextWindow`）；最后切英文，确认词典与 host compat 标签都被翻译。它不替代真机点击（无 CSS、无真实调度），但能抓住"渲染期崩溃 / 契约漂移 / 词典漏词"。

### 9.1 复审（code review）修正记录

v0.1.0 在交付后做了一遍全量代码复审，以下为**行为相关**的修正（都有对应断言）：

| # | 位置 | 问题 | 修正 |
| :-- | :-- | :-- | :-- |
| 1 | `cloneModel` / `save-model` / `delete-model` / `apply-preset` / `test-model` / `discover-models` | 读取与整表重写都会把模型 id **lower 化**；部分网关的模型 id 大小写敏感（`Llama-3.1-8B`），保存任意一个模型会静默改写全部 id | 存储保留原始大小写；表内定位改用 `sameModelId()` 做大小写不敏感比较；入参路径才做长度/字符集校验 |
| 2 | `normalizeEditor` | 模型"未设置"思考档位时，只要点一次保存就会被写成 `reasoningEfforts: false`（**静默关闭推理**） | 三态：显式 `disabled: true` → `false`；有非 off 档 → 写档位表；**两者都没有 → 不写该字段**（沿用目录能力） |
| 3 | `getUserLayer` / `writeModels` 的 replace 通道 | 用户层缺失时回落到"已解析值"，会把平台默认值（`defaultContextWindow`/`defaultMaxTokens`/`defaultInput`/物化的 `compat`）写进 settings.yaml，并让"未配置"显示成"已配置" | 只取**用户层**；replace 只补 `api`/`apiKeyEnv`/`baseURL` 这些定位字段 |
| 4 | `saveProviderAdvanced` 的 `retryPolicy` | 整键替换会抹掉手写的 `retryableCodes` / `backoff` | 与已有用户层策略**合并**，并给出提示 |
| 5 | `catalogCache` | 按 URL 分键、永不淘汰；每个条目是一整份解析后的目录（models.dev 上万条） | LRU 裁剪到 6 份；`save-sources` 立即作废聚合快照 |
| 6 | `refresh-models` / `test-model` | 探测 `/models` 时**不带**渠道级自定义请求头，被 `X-Title` 之类网关头保护的端点永远失败 | 透传非保留头；`content-type`/`accept-encoding` 加入保留名单 |
| 7 | `test-model` 请求体 | 不读渠道/模型级 `compat`，会出现"真实会话能跑、测试页 400" | 尊重 `maxTokensField` / `supportsReasoningEffort` / `thinkingFormat` |
| 8 | `readOpenAiListing` | 只认 `{data:[…]}`，字段别名比官方少，且 lower 化 id | 对齐官方 `readListing()`：支持 `{models:{…}}`、补齐别名、保留大小写、`name` 回落 id |
| 9 | `lib/client.js` 续作 | 补全写回 / 新增模型跨 `await` 时若用户切换渠道，旧渠道结果会写到新渠道界面（下一次保存就可能覆盖新渠道的同名模型） | 新增 `providerEpochRef`，切渠道即作废；过期响应整份丢弃 |
| 10 | `lib/client.js` 单卡保存 | 保存任意一张高级设置卡片会**重置另外五张卡片的未保存输入** | 只回填被保存的那张卡（`FILLERS[scope]`） |
| 11 | `lib/client.js` 英文界面 | 34 个 `t()` 字面量与 60 条 host compat 标签/说明没有英文词条 → 英文界面掉回中文 | 补齐词条并把 compat 标签也过 `t()`；smoke 断言此后不再漏 |
| 12 | `lib/client.js` 目录源单选 | 把 LiteLLM / OpenRouter 的 URL 也列为"models.dev 源"，选中会静默解析出 0 个模型 | 只列 models.dev 形态的镜像 |
| 13 | 杂项 | `retryPolicy` 未配置时显示"默认 2 次"（与真机 `DEFAULT_MAX_RETRIES = 5` 不符）；`parseAddModels` 丢掉目录补全的视觉/思考档位；`res.warnings` 读不到目录类端点的 `sourceWarnings`/`sourceErrors`；补丁安装遇到冻结服务会整体失败 | 逐项修正，见对应断言 |
| 14 | 目录档位缺 `off` | 目录给出显式档位（如 low/medium/high）却没提"可关闭"时，不写 `off: null`，那类模型的思考菜单里就没有「关闭」项 | 改为**总是附上 `off: null`**（语义 = 支持关闭，关闭时不发该参数；`none`/`off` 也映射到它） |
| 15 | 英文词典 | 补词条后既有 62 条"删功能留下的僵尸词条"（`从剪贴板导入`、`读取系统剪贴板并识别`、旧措辞的重复词条等） | 删除，并在 smoke 里加**反向断言**防止再堆积；顺带发现 host 下发的预设名与目录源名（`关闭推理`/`通用三档`/`国内 GitHub 加速`…）没走 `t()`，一并修好 |

### 9.2 第二轮复审修正记录（高→中→低）

按严重度分三档全部修复（每项都有行为断言或源码标记断言）：

| # | 级别 | 位置 | 问题 | 修正 |
| :-- | :-- | :-- | :-- | :-- |
| B1 | 高 | `getCatalog` | 三源**全部失败**时失败的源也会 `perSource[id]=[]`，聚合快照被**空目录**接管，TTL 30 分钟内自动链路静默失效（README 承诺的"失败源不缓存"只在单源层成立） | 只有**至少一源成功**才更新快照；全源失败沿用上一次成功快照（带本次按源错误）；没有就记录失败时间戳 |
| B2 | 高 | `writeModels` 等写通道 | CAS 冲突以裸 `Error` 冒出，postRoute 兜底成 HTTP **400**——README §8 承诺的 **409** 终端状态从未兑现；`saveSuitePrefs` 的 replace 回退连冲突转换都没有 | `conflictError()` 统一挂 `statusCode=409`；replace 回退同样规范化 |
| B3 | 高 | `normalizeCreateModels` | add-models 只查长度不查字符集（delete 却查），带引号/换行的 id 能走到写盘——README §7 声称的字符集白名单两条写路径一条有一条没有 | 补 `isSafeModelId` 校验，与 delete 同口径 |
| B4 | 高 | `deleteModel` | 反向问题：官方页/手写 settings 存入的字符集之外的 id（如**中文 id**）永远无法通过本插件删除（400"含非法字符"）——id 在删除里只用于查表，该校验没必要 | **先查表、查无此条才回落到入参字符集校验**：已存在的任何条目都能删，查不到时非法入参依旧 400 |
| B5 | 高 | `normalizeCompatInput` / `saveFromEditor` / client `saveModel` | 无 api（= 无 compat 字段表）的渠道上，客户端只能产出空 compat 草稿，host 把 `{}` 当成"显式清空"——改个显示名就把该模型 compat 抹了（渠道级卡片有防护，模型级没有） | host：无字段表协议 + 空对象 = "不动该字段"；compat 校验用**真实** api 不再兜底 openai-completions；client：无字段表就不提交 compat |
| B6 | 高 | `cloneModel` 白名单 | `getRawModels` 用白名单重建整表，save/delete/add/enrich 全部**整表写回**——DSH 未来给模型条目加任何新字段，保存任意一个模型就会把同渠道所有条目的该字段**静默抹掉**（真机核对：pi-ai Config schema 对未知键宽松，会原样持久化，所以透传合法且必要） | 新增 `rawCloneModelEntry`：写回路径**原样透传**全部自有键，仅剔除 schemastery 物化的 `input:[]`/compat 空对象/空 `reasoningEfforts`（真机核对：裸条目 resolve 后恰好物化这三样） |
| B7 | 高 | `discoverModels` / client `runDiscoverModels` | "手动添加模型"面板的「获取模型」固定 `apiKey:''`——受保护网关 401，而"更新模型列表"却能过（两条路径能力不一致） | discover 带 `provider` 时复用渠道已存的 baseURL/api/凭据/自定义请求头 |
| M1 | 中 | `normalizeHeadersInput` | `{X-Foo, x-foo}` 大小写不同不去重（客户端防了，host 没防），Node 会把两个头都发出去 | 大小写不敏感去重，与客户端 `seen[lower]` 同口径 |
| M2 | 中 | `getCatalogBounded` | 拉取持续**慢失败**（超时/挂起类）时，每次 `resolveModelInfo`/保存都重新赛跑 3 秒 | **慢失败**（单次 ≥3s）后 60s 冷却：有旧快照用旧快照、没有就空目录；快失败（404/DNS 立即失败）不冷却，重试开销极低 |
| M3 | 中 | `readJsonBody` | body 超限时 `req.destroy()` 可能抢在 400 响应刷出之前断开 socket，客户端看到连接重置 | 排干剩余数据（`resume`）而非销毁连接；补 done 标志防重复 settle |
| M4 | 中 | `testModel` | 固定 `temperature: 0`——o1/o3 等"仅默认温度"端点因该字段直接 400（正是要避免的"真实会话能跑、测试失败"假故障类别） | 移除该字段，交给服务端默认值 |
| M5 | 中 | `checkUpdate` | `latest !== local` 无版本比较，降级（dist-tag 回退/本地预发布）也报"发现新版本" | `compareVersion` 按数字段比较（0.10.0 > 0.9.9），仅 `latest > local` 才报更新 |
| M6 | 中 | client `EN_MSG_PATTERNS` | 模式串与 host 现行消息不匹配：'已保存 X 的渠道设置'被翻成中英混排、'已删除…（via…）'不匹配回退中文；另有多条模式对应的消息早已不存在 | 逐条对齐（具体模式在前），删除僵尸模式，补 preset/发现/获取等消息的翻译 |
| M7 | 中 | `json()` | API 响应无缓存头，设置类数据可能被中间层/启发式缓存 | 所有响应加 `cache-control: no-store` |
| O1 | 低 | `CATALOG_CACHE_MAX_ENTRIES` | 目录 LRU 上限 6 份 × 全量解析对象（models.dev 单份数 MB）≈ 几十 MB 常驻 | 收紧到 3（三源各一份 + 换一次地址的余量） |
| O2 | 低 | `paramSource` / 链路三 | `listModels` 逐模型 `readAuto()→settings.get`；链路三每次 resolve 读两次 `providerProfile` | auto 配置/profile 各读一次复用 |
| O3 | 低 | client `switchProvider` | `fillAdvancedFromProvider` 之后又重复 `setCompatDraft` 一遍 | 删除冗余填充 |
| O4 | 低 | `httpRequestText` 代理 | `urlMod.parse`（废弃 API）+ 默认端口臆造 8080 | `new URL` 解析，默认端口按协议推断（443/80）；解析失败按直连 |
| O5 | 低 | `build.mjs` | 硬编码版本 `'0.1.0'`——升版本要同步改 3 处 | host 导出 `VERSION`，build 比对 package.json 与之同步 |
| O6/O7/O8 | 低 | client | fetch 无超时（bootstrap 挂死=页面卡死）；数字输入不校验（`Number('abc')=NaN` 被 host 静默按未填处理）；`data.npmUrl` 死代码 | 默认 120s 超时（test-model 11 分钟）；`/^\d+$/` 就地校验报错；删除死分支 |

DSH 升级后的维护点：

1. `lib/catalog-routes.js` 的内置 route 名单（40 个）；`apply()` 会 best-effort 用实测名单覆盖，取不到就沿用静态名单。
2. `lib/compat-fields.js` 的 compat 字段表（对照 `dsh-llm-pi-ai/lib/types/catalog.d.ts` 的四个 gate）；`build.mjs` 会断言 19/4/7/1。
3. 重新枚举 route 名单：

```sh
node -e "import('@earendil-works/pi-ai/providers/all').then(m=>console.log(JSON.stringify(m.builtinProviders().map(p=>p.id))))"
```

---

## 10. 许可证

MIT
