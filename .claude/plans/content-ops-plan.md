# EnergyHub 内容质量打磨：管理后台「内容运营」+ 过滤沙箱

> 承接 admin 计划（`.claude/plans/energyhub-admin-plan.md`）重排后的 P1 内容运营，外加 P4 里的过滤沙箱。
> 实现完成后本文件移入项目 `.claude/plans/` 改描述性名。

## Context（背景）

关键词过滤杀不干净低价值内容：金士顿促销文靠通用词兜底混进日报（已补词），评估集里 Jackery 便携电站促销反复误收（`deal` 一词会误杀供应链新闻，无法靠词表根治）。用户确认方案：**管理后台一键人工覆盖（editorial overrides）+ 过滤沙箱**。管理后台 P0 脚手架已就绪（server/router/静态/原子写/status API/UI 壳五占位 tab），P1 内容运营从未实现，overrides 文件也从未创建。

**必须先修的管线隐患**：`schema.mjs validateOverrides` 把"引用 id 不在当前 daily"一律判致命错误，而 `hiddenIds` 在下一次构建会把事件从 daily **删除**（`overrides.mjs L64`）→ 紧随的部署校验（`validateCurrentData` → `npm run validate` exit 1，pages.yml/deploy.yml 都跑它）必然失败，堵死发布线。同日 stale 无法靠"保 3 天"清理规避，必须改判级。

## 关键技术事实（已核实）

- **applyOverrides**（`scripts/lib/overrides.mjs`）全部操作幂等（hide 删存在才删、force 不重复 push），可安全在已应用过一次的磁盘产物上再跑（preview 场景）。配置错误只记 errors/warnings 不中断。
- **事件 id = canonical URL 稳定哈希**，同一篇文章跨构建/跨天不变 → 永久黑名单可行；文章在 RSS 存活约 7 天（DAILY_MAX_AGE_DAYS），"仅当天隐藏"会重现。
- **validateOverrides**（`schema.mjs L358`）逐 byDate 全量校验；stringIdArray/mapField 对缺失 id push error。需要：`hiddenIds`、`mergeGroups` 成员缺失 → 降级 warning（已应用/已过期），其余（forcedFeaturedIds/hotEventIds/topics/impacts/summaries/whyItMatters）保留 error。
- **admin 脚手架**：`server.mjs`（CSRF 头 + Origin 白名单 + /api 路由分发，L51 "后续阶段在此追加"）；`router.mjs`（pattern 路由 + 2MB body + jsonOk/jsonFail）；`lib/jsonfile.mjs`（readJson null 容错 + writeJson 原子 tmp+rename+bak）；`lib/paths.mjs`（PATHS 白名单，overrides/wechatSeeds/deep 可写，daily/featured 只读）；`lib/git.mjs`（execFile 封装）；`api/status.mjs`（register 模式范例）。
- **UI 壳**：`admin/app.js` 有 api()（自动带头）、toast、confirmDialog、openModal、hash 路由 VIEWS 注册表，content 视图现为占位；`style.css` 已有 card/table-wrap/chip/badge/btn/pill/modal/field/form-row 等类可直接复用。
- **enums**：15 个 topic（sst/pcs/ems/energy-storage/aidc-project…）、5 个 impact（positive/negative/neutral/watch/unknown），下拉数据源。
- **wechat 种子**（`feeds/wechat-articles.json`）：`{version, updatedAt, articles:[{category, sourceName, url, fetched?, addedAt?, title?}]}`；空 url 条目=占位账号愿望单（fetch 跳过但保留）；管线构建时**回写**该文件（fetched 标记/3 天清理/标题回填）→ 后台写必须"磁盘重读→定点 splice→保持外壳"。
- **deep.json**：`{mode:'deep', updatedAt, note, items:[{title,url,source,summary,tags[],date,addedBy}]}`，url 作键。
- **samples/daily 只到 2026-08-05**（陈旧）→ 沙箱以"今日 daily 94 条"为主要语料（误伤检查），最新样本仅作附带历史参考。
- CI 顺序：fetch-feeds verify→build→commit→dispatch pages/deploy（再 verify）——所以 overrides 语义修不好必堵发布，修好则全链路安全。

## 决策（已与用户确认）

| 项 | 决定 |
|---|---|
| 隐藏粒度 | **永久隐藏**：协议加顶层 `globalHiddenIds`（文章级黑名单，每次构建先于 byDate 应用），可一键恢复 |
| 范围 | P1 内容运营（今日事件/覆盖操作/预览/stale 清理/微信种子/深研 CRUD）+ 过滤沙箱 |
| 发布流 | 不做（P3）；改动留在工作区，由状态条"未提交 N"提示，用户让 Claude 提交或自己 git |
| validateOverrides | hiddenIds/mergeGroups 成员缺失降级 warning（管线小修，含测试） |

## 实现方案

### 1. 管线小修（先做，是其余一切的前提）

`scripts/lib/schema.mjs` validateOverrides：
- `hiddenIds`：id 缺失 → `warnings.push('hiddenIds 引用 id 已应用或已过期: x')`（不再 error）
- `mergeGroups`：成员缺失 → warning；仅保留"结构非法（<2 个 id）"为 error
- 新增顶层 `globalHiddenIds`（字符串数组校验；id 不在当前 daily → warning）
- `forcedFeaturedIds/hotEventIds/topics/impacts/summaries/whyItMatters` 维持 error（这些 id 在应用后仍留在 daily，缺失=真坏引用）

`scripts/lib/overrides.mjs` applyOverrides：
- 函数开头应用 `config` 之外新增参数级处理：读 `overrides.globalHiddenIds`（由调用方传入或 applyOverrides 增加 signature `applyOverrides(daily, featured, config, enums, globalHiddenIds)`——采用后者，改动最小）执行与 hiddenIds 相同的删除逻辑
- `build-daily-v2.mjs` 调用处传 `overrides.globalHiddenIds || []`（1 行）

`tests/overrides.test.mjs` + 新用例：已应用过的 hiddenIds 再校验 → valid 且有 warning；globalHiddenIds 生效删除 + 缺失仅警告。

### 2. 纯函数层 `scripts/admin/lib/content-ops.mjs`（新，可单测）

- `applyOverrideOp(config, op)` — op ∈ {forceFeature,unforceFeature,hide,unhide,unfeature,restoreFeatured,setTopic,setImpact,setSummary,setWhy,setObservations,setHotList,addMergeGroup,removeMergeGroup}；id 数组去重；value null 删键；返回新 config（不改入参）。hide 走 globalHiddenIds，unhide 从中移除。
- `scanStale(overrides, daily)` — 全部 byDate + globalHiddenIds 中引用缺失 id 的条目清单 `{date, field, id}[]`。
- `pruneOld(overrides, today, keepDays=3)` — 丢 date < today-3 的 byDate 与空配置，返回 {config, pruned:[dates]}。
- `buildTodayPayload(daily, featured, overrides, enums)` — 组 UI 数据：items 投影(id/title/originalTitle/url/summary/whyItMatters/topic/impact/importance/region/source/publishedAt/wechat) + isFeatured/isHot + 标记(已隐藏-global / 当日覆盖-hasOverride) + enums 下拉数据 + 今日 config + globalHiddenIds。

### 3. API `scripts/admin/api/content.mjs`（新）+ server.mjs 注册 1 行

统一"磁盘重读→纯函数变更→validateOverrides(候选, 今日daily)→错误非空拒写→writeJson 原子落盘→顺手 pruneOld"：

- `GET /api/content/today` — buildTodayPayload
- `POST /api/content/override` `{op, id?, value?, index?}` — 作用于今日 config（或 globalHiddenIds）；hide/unhide 走全局；返回 {todayConfig, globalHiddenIds, pruned}
- `POST /api/content/preview` — 深克隆 daily+featured → applyOverrides(今日config, enums, global) → 返回 {featuredBefore/After, hotBefore/After, hiddenNow[], itemCount, errors, warnings}（不落盘）
- `GET /api/content/stale` — scanStale；`POST /api/content/prune` — pruneOld 落盘
- `GET/POST /api/content/wechat` + `DELETE /api/content/wechat/:i` — 重读→splice（按 url 去重，保留他条 fetched/addedAt/title）→回写并刷 updatedAt
- `GET/POST/PUT/DELETE /api/content/deep` — url 为键，自动补 addedBy:'admin'、date=今日
- `POST /api/content/sandbox` `{words:[..]}` — 每个词用 `lib/filter.mjs keywordHit` 跑今日 daily items（title+originalTitle+summary）→ {word, killCount, killed:[{id,title,source}]前20}；附带最新 samples/daily 同样结果（标注其日期）

### 4. UI `admin/app.js` content 视图重写（替换占位）

- 顶栏：数据日期 pill、stale 徽章（>0 显示"清理"）、「覆盖预览」开关
- 子 tab：今日事件 | 微信种子 | 深度阅读 | 过滤沙箱
- **今日事件**：过滤条（搜索/主题/影响/仅看精选/仅看已隐藏）+ 表格（标题外链、主题下拉、影响下拉、重要度、来源、徽章：精选/热点/覆盖/已隐藏、操作：精选⇄取消、隐藏/恢复、改摘要/理由 modal）；右侧栏：今日观察 textarea(≤5)、热点榜有序列表(上移/下移/移除，整体替换保存)、永久隐藏列表(恢复按钮)
- **预览**开关 → 调 preview 显示差摘要（精选 a→b、热点 a→b、本次隐藏 n 条、errors/warnings）
- **微信种子/深度阅读**：简单表格 CRUD 模态
- **过滤沙箱**：textarea 输候选负面词（逗号/换行分隔）→ 跑 → 每词 killCount + 被杀标题清单（红=误伤正经内容警示）→ 提示"确认后手动加进 data/filters.json"（改 filters 文件属 P4，不在本页做）
- style.css 少量补充（sub-tab、行内 select 紧凑化）

### 5. 测试与验收

- `tests/admin/content-ops.test.mjs`（node --test，与现有风格一致）：applyOverrideOp 全 op 幂等/去重/null 删键、pruneOld 边界、scanStale、buildTodayPayload 标记正确
- `tests/overrides.test.mjs` 增改：降级 warning 用例、globalHiddenIds 用例
- 验收链：`npm run admin` → 内容运营页强制精选某条 → 预览显示 featuredIds +1 → validateOverrides 通过（overrides 文件首次诞生）→ `npm run build:v2 -- --replay` 回归不损 → 隐藏一条 → 预览 itemCount -1 → stale 扫描 0 → `npm run verify` 全绿

## 文件清单

```
scripts/lib/schema.mjs              【改】validateOverrides 判级 + globalHiddenIds 校验
scripts/lib/overrides.mjs           【改】applyOverrides 增全局黑名单参数
scripts/build-daily-v2.mjs          【改】调用处传 globalHiddenIds（1 行）
scripts/admin/lib/content-ops.mjs   【新】纯函数
scripts/admin/api/content.mjs       【新】API
scripts/admin/server.mjs            【改】注册 contentApi（1 行）
admin/app.js                        【改】content 视图重写
admin/style.css                     【改】少量样式补充
tests/overrides.test.mjs            【改】判级/全局黑名单用例
tests/admin/content-ops.test.mjs    【新】
```

## 风险与对策

- **改 validateOverrides 会不会掩盖真错误**：仅对"应用后必然消失"的引用降级；force/hot/map 字段缺失仍致命，真坏引用照样拦
- **微信种子双写者**：写前必重读 + 定点 splice；UI 提示"北京时间 05:00/12:00 构建窗口内建议缓改"
- **globalHiddenIds 无限增长**：无害（应用时忽略缺失，校验仅 warning）；UI 显示条数与恢复入口
- **preview 双重应用**：applyOverrides 幂等，已应用配置再跑结果不变
- **回滚**：全部改动 git 可回退；overrides 文件不存在时管线行为与现状完全一致

## 验证方式

1. `npm run verify`（188→~200 用例全绿）
2. `npm run build:v2 -- --replay` 回归：历史样本构建结果与现状一致（globalHiddenIds 为空时零差异）
3. 手动：`npm run admin` 走一遍验收链（上节）
4. 沙箱：输入"折扣"应 kill 金士顿那条（已在正文），输入"储能"应 kill 大量正经内容（演示误伤警示有效性）
