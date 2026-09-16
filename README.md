# dsh-model-suite

English | [简体中文](README.zh.md)

> A DSH Web plugin: **Model Suite** — one settings page for the whole model-configuration surface: per-model editing (including the **reasoning levels** and **compat switches** the official page cannot touch), route-level advanced settings, three-source catalog sync, and **automatic parameter completion** for custom gateways.

> Built upon [cinob/dsh-plugin-custom-provider-enhancer](https://github.com/cinob/dsh-plugin-custom-provider-enhancer) and [kingsunb/dsh-model-plus](https://github.com/kingsunb/dsh-model-plus) — many thanks to the authors of both predecessors.

- Package `dsh-model-suite`, cordis plugin name `model-suite`, HTTP prefix `/api/suite`
- Reads/writes the `llm-pi-ai` namespace; plugin preferences live at `llm-pi-ai.__modelSuite`
- **No build step**: `lib/*.js` is the shipped artifact (`scripts/build.mjs` only validates shape)
- Target DSH: `0.1.5-rc.2`

---

## 1. Why

The official DSH “Models” page covers providers and the basic model-entry fields, but not:

| Capability | Official page | This plugin |
| :-- | :-- | :-- |
| Provider create/edit/delete | ✅ | ❌ (deliberately removed — use the official page) |
| `contextWindow` / `maxTokens` | ✅ | ✅ |
| `input` (vision) | partial | ✅ chips editor |
| `reasoningEfforts` (thinking levels) | ❌ none | ✅ 7 levels + wire values |
| `compat` switches | ❌ | ✅ route-level **and** model-level (19/4/7/1) |
| `headers` / route defaults / `retryPolicy` | ❌ | ✅ Advanced settings |
| Model testing / catalog sync / auto-completion | ❌ | ✅ |

Typical case: an OpenAI-compatible gateway rejects the `developer` role and chat fails with 400. Previously you had to hand-edit `settings.yaml`; now set **Advanced settings → Compat → developer role** to `false`.

---

## 2. Install

As a standard DSH Profile Bundle, install from GitHub in one command (auto-mounted):

```sh
dsh plugin --profile web add github:pyooyq/dsh-model-suite
dsh web
```

Or from npm (once published):

```sh
dsh plugin --profile web add dsh-model-suite
dsh web
```

For local development, link works too (the repo root is the package directory holding `package.json`):

```sh
dsh plugin --profile web add link:<absolute-path>/dsh-model-suite
dsh web
```

---

## 3. Migrating from the two predecessor plugins (required)

This plugin replaces `@kingsunb/dsh-model-plus` and `dsh-plugin-custom-provider-enhancer`. All three intercept settings writes and `llm.resolveModelInfo`; **running them together double-enriches and overwrites each other’s configuration.**

```sh
dsh plugin --profile web remove @kingsunb/dsh-model-plus
dsh plugin --profile web remove dsh-plugin-custom-provider-enhancer
dsh plugin --profile web add link:<absolute-path>/dsh-model-suite
dsh web
```

- Model configuration already written to `llm-pi-ai` is **not rolled back** (it is kernel config, not plugin data).
- Preferences migrate once: `__modelPlus`’s catalog URL is copied into `__modelSuite` (the old key is **not** deleted).
- UI language is stored as `localStorage['ms.lang']`, falling back to the legacy `mp.lang` on first read.

Uninstall with `dsh plugin --profile web remove dsh-model-suite`. It removes all 14 routes and **restores every patch cleanly** (a method that was not an own property is `delete`d rather than replaced with a forwarding shell), so the original behaviour returns without a restart.

---

## 4. Layout

Page header (title + zh/EN toggle) → a compact provider toolbar (read-only provider picker, semantic capability badges — reasoning/vision/compat/retry/built-in-or-custom — plus “Sync now” and “Refresh model list”; baseURL and protocol collapse into one meta line) → a slim global feedback strip → an underline-style tab nav.

Five tabs: **Models**, **Channel settings**, **Model testing**, **Catalog & automation**, **About**. See `README.zh.md` for the full Chinese walkthrough (the plugin UI itself is Chinese-first with an in-page English dictionary).

- **Models** is a compact read-only table (id, badges, context, output cap); click **Edit** to expand an editor with labelled sections — display name, input modalities, effort (7 levels + quick presets), capacity, wire mapping, model-level compat switches — and a sticky footer action bar (**Save this model / Delete**) with the per-model error shown inline.
- **Channel settings** holds the four independent cards (compat / retry / route defaults / custom headers). Each card header carries an **Unsaved changes** badge and a save button that only highlights once the draft differs from the server snapshot. The compat list is grouped by topic (reasoning & thinking / tool calls / streaming & transport / cache & storage / request fields), with search and a “configured only” filter — both at channel level and model level.
- **Model testing** keeps parallel testing and SVG previews; the test prompt is folded into a collapsible block.

Two behaviours worth knowing on the Models tab:

- Effort is **tri-state**: ticking any non-off level writes the level map; ticking “reasoning off” (leaving every level empty) writes `reasoningEfforts: false`; ticking **nothing** omits the field, so an *unset* model keeps the catalog/detected capability instead of being silently disabled.
- Model ids **keep their original case** (`Llama-3.1-8B` is never lowercased), and writing one model never rewrites the other entries’ ids.

---

## 5. Automatic configuration (three patch chains)

After install, custom routes (a route id outside pi-ai’s 40 built-in catalog ids) get their model parameters filled in automatically — **only missing fields are ever filled; nothing you typed is overwritten**.

| Chain | Trigger | Writable fields |
| :-- | :-- | :-- |
| 1 · discovery | official page → “Fetch available models” | `contextWindow`, `maxTokens` |
| 2 · save | any settings write to `llm-pi-ai` | `contextWindow`, `maxTokens`, `input`, `reasoningEfforts` |
| 3 · runtime | chat / model-catalog resolution | `context`, `defaultMaxTokens`, `inputModalities`, `reasoning` |

Switches (Catalog & automation tab, **hot-reloaded**, no restart): `auto.enabled`, `auto.persistOnSave`, `auto.fields.{contextWindow,maxTokens,input,reasoningEfforts}`, `auto.includeCatalogRoutes`.

Invariants guarded by regression tests:

- A field that already has a value is never rewritten — `262144 / 256000 / 32768 / 32000 / 4096` are **no longer** treated as “unset”.
- With no catalog hit, **nothing at all** is written (no misleading “unknown model ⇒ 128K/4096” fallback).
- Built-in catalog routes are skipped by default (name custom gateways with a custom route id such as `hub-gm`).
- Automatic enrichment never blocks a save on the network (it waits at most 3 s for the catalog, then proceeds and keeps fetching in the background).

---

## 6. Three-source catalog

`models.dev` (priority 1) → LiteLLM (2) → OpenRouter (3), all enabled by default.

- **Layered fill**: a higher-priority source supplies any field it knows; lower sources only fill fields that are still empty (a lower source can never downgrade a resolved value to `undefined`).
- **On-demand fetching**: when models.dev covers every queried id, the other two sources are not fetched at all.
- **Caching**: keyed per URL, 30 min TTL, in-flight de-duplication; **failing sources are not cached** and are retried on the next call.
- **Matching**: two levels (normalised equality → separator-equivalent loose equality). **No prefix/substring matching** — `o1-mini` will not match `o1`.

The repo-root `api.json` is the models.dev snapshot served through the China acceleration URL. Release runs must refresh it:

```sh
curl -fsSL https://models.dev/api.json -o api.json
```

---

## 7. Security model

- **Host header fence (every endpoint, read + write)**: `Host` must be a loopback literal (`localhost` / `127.0.0.0/8` / `::1`), otherwise `403 untrusted host header`. This blocks DNS rebinding — the platform webServer never validates Host, and under rebinding `Origin` and `Host` are both the attacker's domain (the Origin≈Host check passes), while `GET /bootstrap` and `GET /list-models` return baseURLs and custom-header plaintext with no other check. **Deployment constraint: the plugin's endpoints are loopback-only** (the DSH web default bind `127.0.0.1` satisfies this; `0.0.0.0` LAN access is not supported).
- **Write trust fence**: a request with `Origin` must be same-origin with `Host` (scheme + hostname + port compared component-wise, never by suffix); without `Origin` only loopback peers are accepted, otherwise `403 unauthenticated write denied`.
- **Outbound policy**: http/https only; rejects embedded credentials, cloud-metadata/link-local hosts, and cleartext HTTP to non-loopback; catalog fetches require HTTPS.
- **Redirects**: at most 5 hops, absolute per-chain deadline, no cross-origin redirect carrying **any non-default header** (credentials or custom gateway headers alike), no HTTPS→HTTP downgrade.
- **Input validation**: model id / display name length and charset whitelists; header names must match the RFC 7230 token grammar, values must not contain newlines, total ≤ 8 KB (UTF-8 byte semantics on both sides); compat accepts only fields whose gate is `offer` for the current protocol with a matching value type (unsupported ⇒ `400`, never silently dropped).
- **Output scrubbing**: credentials in diagnostics → `[redacted]`, `sk-*` → `[redacted-key]`; URLs in public errors → `[remote-url]`, paths → `[path]`, truncated to 512; SVG rejects `<script` / `on*=` / `javascript:`.
- ⚠️ This is not full session authentication: any local process can still POST without `Origin` (a deliberate trade-off, same as `dsh-model-plus`).

---

## 8. HTTP API (`/api/suite`, 14 endpoints)

| Method | Path | Purpose |
| :-- | :-- | :-- |
| GET | `/bootstrap` | page bootstrap |
| GET | `/list-models?provider=` | one route’s model view |
| POST | `/save-model` | save one model (incl. name/compat) |
| POST | `/apply-preset` | apply a quick preset |
| POST | `/discover-models` | probe `/models` |
| POST | `/refresh-models` | list candidates for a configured route |
| POST | `/add-models` | append picked/hand-typed models |
| POST | `/delete-model` | delete one model entry |
| POST | `/enrich-models` | three-source completion (preview or apply) |
| POST | `/save-sources` | save the three catalog sources |
| POST | `/save-provider-advanced` | save route-level whitelisted fields |
| POST | `/save-auto-config` | save the automatic-configuration switches |
| POST | `/test-model` | one real model API call |
| GET | `/check-update` | latest npm version |

Status codes: `400` validation · `403` fence rejection (Host fence / write fence) · `404` unknown route/model · `405` method · `409` CAS conflict (**terminal, never auto-retried**) · `500` internal (scrubbed).

---

## 9. Development and verification

```sh
node scripts/build.mjs             # shape + field-count validation (runs on publish; deliberately NOT prepare — prepare gets blocked by pnpm's build allowlist on git installs)
node scripts/security-smoke.mjs    # security and invariant regression (real behaviour)
node scripts/integration-smoke.mjs # drives apply(ctx): 14 endpoints + all three chains
node scripts/ui-smoke.mjs          # headless render of the browser half (mini React + tree clicks)
npm run verify                     # all four, in order
```

`integration-smoke.mjs` fakes the settings service (with CAS and the three-step fallback semantics) and validates **every write against the real `dsh-llm-pi-ai` `Config` schema**, fakes `webServer` with real HTTP semantics, fakes `llm` with prototype-owned methods (to prove `delete`-based restore), and serves the three catalogs from a local HTTP server.

`security-smoke.mjs` also asserts that **every literal `t('…')` key and every host-supplied compat label/description has an English entry**, so the EN UI cannot silently fall back to Chinese.

`ui-smoke.mjs` mounts the settings page with a miniature React runtime (`useState`/`useRef`/`useEffect`/`useMemo`/`useCallback`/`createElement`, function-component evaluation, effect→setState re-render loop), walks all five tabs, expands a model card, clicks **Save**, and asserts the request body matches the host contract; it then switches to English and checks the translation of both the UI and the host compat labels. It does not replace real click-through (no CSS, no real scheduler) but catches render-time crashes, contract drift and missing dictionary entries.

### 9.1 Code-review fixes (post-0.1.0)

A full review pass produced behavioural fixes, each covered by assertions. The most important:

1. **Model ids keep their case** — reading *and* rewriting the models table used to lowercase every id, silently breaking gateways with case-sensitive ids (`Llama-3.1-8B`) on any save. Lookups now use a case-insensitive compare; length/charset validation applies only to input paths.
2. **Reasoning efforts are tri-state** — saving an unrelated edit on a model whose `reasoningEfforts` was *unset* used to write `reasoningEfforts: false`, silently disabling reasoning. Now: explicit disable → `false`; any non-off level → the level map; neither → the key is left untouched.
3. **`replace` no longer materializes platform defaults** — with no user layer, the fallback used the *resolved* profile and wrote `defaultContextWindow` / `defaultMaxTokens` / `defaultInput` / an empty `compat` into `settings.yaml`, and made "unconfigured" look configured.
4. **Hand-written `retryPolicy.retryableCodes` / `backoff` survive a UI save** (the advanced card only manages `mode` / `maxRetries`).
5. **The catalog cache is bounded** (LRU, 6 entries — each is a full parsed catalog) and `save-sources` invalidates the aggregate snapshot immediately.
6. **Discovery reuses the route's custom headers**, and reserved names (`content-type`, `accept-encoding`, …) can no longer mislabel a probe request.
7. **The test tab honours route/model `compat`** (`maxTokensField`, `supportsReasoningEffort`, `thinkingFormat`) instead of always sending `max_tokens` + `reasoning_effort`.
8. **`readOpenAiListing` matches the official `readListing`** (`{models:{…}}` form, extra field aliases, no case folding, `name` falling back to the id).
9. **The browser half discards stale continuations** — enrich/add responses that land after a provider switch are dropped (`providerEpochRef`), and saving one advanced card no longer resets the other five cards' unsaved input.
10. **The EN UI is actually English** — 34 `t()` literals and all 60 host compat labels/descriptions were missing from the dictionary.
11. **The catalog-source radios only list models.dev-shaped mirrors** (picking the LiteLLM/OpenRouter URL as the models.dev source silently produced zero models).
12. Misc: the retry default shown for an unconfigured provider is now the real `DEFAULT_MAX_RETRIES = 5`; `parseAddModels` keeps catalog-filled vision/effort; per-source failures (`sourceWarnings`/`sourceErrors`) reach the UI; patch installation degrades to a warning on a frozen service instead of failing the whole plugin.

### 9.2 Second review round (high → medium → low)

A second full review produced 7 high, 7 medium and 8 low-priority fixes, each covered by behaviour or source-marker assertions:

1. **B1** — a total catalog failure no longer poisons the aggregate snapshot for 30 min (the failed sources used to produce an empty "fresh" snapshot; now the snapshot only updates when ≥1 source succeeds, falls back to the last good one, and records the failure).
2. **B2** — CAS conflicts now return **HTTP 409** as documented (they surfaced as plain 400 before), including the `saveSuitePrefs` replace fallback.
3. **B3/B4** — `add-models` gained the id-charset whitelist `delete-model` always had; conversely, `delete-model` now looks the entry up **first**, so ids stored by the official page outside the plugin charset (e.g. Chinese) can still be deleted — the charset error only fires on a lookup miss.
4. **B5** — saving a model on a provider without a field table (no `api`) no longer wipes its `compat`: an empty compat draft means "cannot manage" (leave alone), host and client both; compat validation uses the real `api` instead of guessing `openai-completions`.
5. **B6** — write-back paths now pass model entries through verbatim (`rawCloneModelEntry`): unknown/future fields survive any save/delete/add/enrich (the whitelist rebuild used to erase them schema-loose fields DSH may add); only schemastery-materialized artifacts (`input: []`, empty compat objects, empty `reasoningEfforts`) are scrubbed.
6. **B7** — the add-panel「获取模型」probe reuses the provider's stored baseURL/credentials/custom headers (it always sent an empty key before and 401'd on protected gateways).
7. Medium: case-variant duplicate header names rejected (M1); slow-failure cooldown so an offline catalog cannot stall every resolution 3 s — a stale snapshot is served during the cooldown (M2); oversized bodies drained instead of socket-destroyed so the 400 is deliverable (M3); no hardcoded temperature in the test request — o1-style endpoints 400 on it (M4); semver compare so downgrades are not "updates" (M5); EN message patterns realigned with the actual host messages (M6); `cache-control: no-store` on API responses (M7).
8. Low: catalog LRU 6→3 full parsed snapshots (O1); hot-path settings reads hoisted (O2); redundant client re-fill removed (O3); proxy parsed with `new URL` + protocol-default port (O4); `build.mjs` compares the exported `VERSION` with package.json instead of hardcoding (O5); client fetch timeout 120 s / 11 min for tests (O6); dead `npmUrl` branch removed (O7); numeric editor inputs validated client-side (O8).

### 9.3 Third review round (high → medium → low)

A third full pass over the post-fix code (including the platform `dsh-host-webserver` source) produced 1 high, 4 medium and 6 low-priority fixes:

1. **H1 (high) — DNS-rebinding bypass closed**: the write fence only proved `Origin ≈ Host`, which a rebinding page satisfies with both headers under its own domain (and the no-Origin branch sees a loopback remote — the victim's own browser). Worse, `GET /bootstrap` / `GET /list-models` had **no** trust check at all while returning baseURLs and custom-header plaintext. Every `/api/suite/*` route (GET and POST) now requires a loopback `Host` literal or answers `403 untrusted host header`. Documented constraint: loopback-only deployment.
2. **M1 — cross-protocol compat fields survive edits**: the B6 carry-over classified "known" fields with the union of *all* protocols' tables, so a hand-written cross-protocol compat field (e.g. `supportsTemperature` on an openai-completions model) was silently dropped by any unrelated edit; classification now uses the **current protocol's** offer table.
3. **M2 — switching providers resets the manual-add panel** (`resetAddForm()`), which used to keep the previous provider's discovery candidates pre-checked and could add them to the wrong provider.
4. **M3 — switching providers no longer wipes unsaved edits** in the global catalog-sources / auto-config cards (they are provider-independent and are now filled only on mount).
5. **M4 — O2 completed**: `add-models` / `enrich-models` / `delete-model` responses build model views with one shared `readAuto()` instead of one settings resolve per model.
6. Low: **L1** the test request now encodes the effort per pi-ai's `thinkingFormat` wire table (qwen→`enable_thinking`, zai/together/deepseek/string-thinking/qwen-chat-template each mapped, chat-template/baseten skipped) and reports `effortApplied`, so the UI no longer claims an effort was "used" when it was not injected; **L2** an empty-string `api` no longer overrides the provider's real protocol in `discover-models`; **L3** cross-origin redirects reject every non-default header (custom gateway headers included, not just reserved names); **L4** the client header-size check counts UTF-8 bytes like the host and the reserved-name lists are aligned; **L5** `delete-model` reports "missing provider" correctly and the local `applyNow` no longer shadows the exported `apply()`; **L6** digit strings overflowing Number range (`Infinity`) are rejected client-side and host-side instead of silently keeping the old value.

Upgrade checkpoints after a DSH bump:

1. `lib/catalog-routes.js` — the 40 built-in route ids (`apply()` best-effort replaces them with the live list when pi-ai is resolvable).
2. `lib/compat-fields.js` — the compat field table (mirror the four gates in `dsh-llm-pi-ai/lib/types/catalog.d.ts`); `build.mjs` asserts 19/4/7/1.

---

## 10. License

MIT
