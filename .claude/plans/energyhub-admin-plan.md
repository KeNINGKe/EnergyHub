# EnergyHub 本地管理后台(npm run admin)

## Context(背景)

EnergyHub 是纯静态能源信息聚合站(GitHub Pages 大陆主入口 https://keningke.github.io/EnergyHub + Cloudflare Workers 备份),数据全部是 git 仓库里的 JSON,内容靠 GitHub Actions 每天两次跑 `build-daily-v2` 管线更新。当前四类日常运营全要手改 JSON + git 提交:

1. **信源管理** — `data/sources.json`(191 源/10 分类)手改;有 `scripts/check-sources.mjs` 巡检但结果查看不直观
2. **配置调整** — `data/enums.json`(主题关键词、热点榜配置)、`filters.json`、`source-types.json` 等手改
3. **内容运营** — `data/editorial-overrides.json` 协议已定义(DATA_PROTOCOL.md §4)但**文件从未创建**;微信种子 `feeds/wechat-articles.json`、深研区 `feeds/deep.json` 手改
4. **流量监控** — 静态站无任何访问/点击数据

**目标**:本地管理后台(形态用户已确认)——`npm run admin` 起 127.0.0.1 本地服务,浏览器操作五页:信源管理 / 内容运营 / 配置 / 流量 / 发布。改完走发布流 commit+push 触发 CI。

## 优先级调整

| 阶段 | 原名 | 实际价值 | 理由 |
|---|---|---|---|
| **第一优先** | P2→现在 P1 | 内容运营 | 强制精选、隐藏、清理 stale override，比手改 JSON 效率高最多 |
| **第二优先** | P1→现在 P2 | 信源管理 | 191 个源增删改 + 健康检查，手动改也容易出错 |
| **第三优先** | P4→现在 P3 | 发布流 | P2/P1 的改动要生效的基础设施，需要先搭 |
| **按需补** | P3→现在 P4 | 配置 | enums/filters/过滤沙箱有实用价值但频率低 |
| **延后** | P5 | 流量 | 百度统计埋点，不影响核心功能 |
| **收尾** | P6 | 文档测试 | 写完其他阶段顺手的事 |

## 关键技术事实(已核实)

- 前端读 5 个 JSON(sources/enums/featured/daily-v2/daily 兜底);事件 id = canonical URL 的确定性哈希(`evt_`+16hex),跨构建稳定 → 可作埋点归因键
- dist 组装是显式白名单拷贝(index.html/assets/data/feeds,pages.yml L32–39 与 deploy.yml L20–26)→ 根级 `admin/` 目录永不进生产
- `npm run verify` = test+validate+语法检查,每次部署门槛;其中 `validateCurrentData` 会把「overrides 引用不存在于今日 daily 的 id」判为**致命错误** → 陈旧 override id 会阻塞两条部署线,发布流必须硬闸门清理
- overrides 在**构建时**应用 → 改完需 dispatch fetch-feeds.yml 重构才生效;本地 push main 自动触发 pages.yml+deploy.yml(真实用户 push 无反循环限制)
- 本机 gh CLI 未登录;CI bot 每天两次提交 feeds/(bot 只 add feeds/,与 admin 改的 data/ 冲突面小)
- 微信种子文件被管线回写(fetched 标记/3 天清理/标题回填)→ 后台写入必须"磁盘重读→定点 splice",不能整文件覆盖内存副本
- `scripts/lib/schema.mjs` 有模块级 `_enums` 缓存(L20)→ 长驻 server 改 enums 后校验失真,需加 `resetEnumsCache()`
- 复用件:`schema.mjs`(validate*/loadEnums)、`overrides.mjs`(applyOverrides 纯函数,可直接做生效预览)、`check-sources.mjs`(探测逻辑抽核心)、`lib/filter.mjs`(classifyItem 做过滤沙箱)
- 主站 app.js 无统一外链点击处理(三处渲染各自 `<a target=_blank>`:L388 时间线/L405 热点榜/L240 信源卡)→ 用一个 document 级委托监听器统一埋点
- workers.dev 大陆被墙 → 埋点用**百度统计**(hm.baidu.com 大陆稳定、免费、零新增基础设施);用户有备用域名,自建收集端留作后续扩展位

## 实现方案

### 文件布局(全部新增,除标注外)

```
admin\                      # 后台 UI(vanilla JS 中文界面,复用主站 style.css :root 设计令牌)
  index.html                # 壳:顶部状态条 + 左侧 tab 导航(hash 路由)
  app.js                    # 五个视图逻辑 + toast/确认弹窗/api 封装
  style.css                 # 主站令牌副本 + 表格/表单样式

scripts\admin\
  server.mjs                # 入口:node:http,只绑 127.0.0.1,默认端口 4180(--port/ADMIN_PORT 可改)
  router.mjs                # method+pattern 路由、JSON body(限 2MB)、统一 {ok,data|error} 封装
  lib\jsonfile.mjs          # 读容错;写=tmp+fs.rename 原子(tmp 名带 randomUUID)+JSON.stringify(x,null,2)+'\n'
  lib\static.mjs            # admin/ 静态服务(mime 小表,path.resolve 防路径穿越)
  lib\git.mjs               # execFile('git'|'gh',args)(shell:false 防 Windows 引号问题)
  lib\validators.mjs        # sources/enums/filters/source-types/entities/regions/wechat/deep shape 校验
  lib\baidu.mjs             # 百度统计 deep-link 常量 + 片段检测
  api\status.mjs            # GET /api/status(分支/dirty/ahead-behind/ghAuthed/数据日期)
  api\sources.mjs           # 信源 CRUD + 健康检查任务(jobId 轮询)
  api\config.mjs            # data/*.json 六文件读写+校验+过滤沙箱
  api\content.mjs           # 今日事件、override 细粒度操作、微信种子、deep CRUD、覆盖预览
  api\publish.mjs           # 发布流(plan/diff/run/sync)

scripts\lib\source-check.mjs   # 【新】从 check-sources.mjs 抽出纯探测核心 runSourceCheck(items,{concurrency,timeout})
scripts\check-sources.mjs      # 【唯一改动既有脚本】改薄壳调 source-check.mjs,输出不变
scripts\lib\schema.mjs         # 【加 3 行】export resetEnumsCache(){_enums=null}

tests\admin\{validators,content-ops,publish-plan,static-guard}.test.mjs
docs\ADMIN.md                  # 使用文档
package.json                   # 加 "admin": "node scripts/admin/server.mjs"
```

### 安全模型

- 只绑 127.0.0.1;非 GET 请求须带 `X-Admin-Request: energyhub` 头(强制 CORS 预flight,防 drive-by 页面)+ Origin 校验
- 服务进程不缓存任何可变数据文件——每个写端点操作时磁盘重读(防 git pull/CI bot 在脚下改文件)
- 所有保存前过校验(schema.mjs 能复用则复用,否则 validators.mjs),errors 非空拒绝落盘并返回错误列表
- 写盘红线:可写仅 editorial-overrides.json(新建)、data/*.json 六件、feeds/wechat-articles.json、feeds/deep.json、scripts/check-results.json(gitignored);feeds/daily*.json、featured.json **只读**

### API 要点(统一封装 {ok,data}|{ok,error,errors?,warnings?})

- **status**:`GET /api/status` — branch/dirtyFiles/ahead-behind(git fetch 后 rev-list --left-right --count)/ghAuthed(gh auth status 探测,缓存 5 分钟)/dataDate
- **sources**:GET 列表(合并 check-results.json 出健康徽章)/ POST·PUT·DELETE / move / 分类增删改(url 或分类内 name 为键,url 全局查重);`POST /api/check/start`(scope: all|catId|urls,并发 10/18s 超时与现一致,结果写 check-results.json 同格式)+ job 轮询;`GET /api/sources/wechat-report` 汇总 mp.weixin 失效源+建议动作
- **config**:`name ∈ {enums,filters,source-types,entities,regions}` GET/PUT(.bak 备份+原子写;enums 保存后 resetEnumsCache())/ dry-validate;filters 沙箱 `{title}` → 用 classifyItem 显示命中 strong/combination/generic/negative 哪一路。enums 校验含 hot.keywordLabels[].pattern 必须可 new RegExp 编译
- **content**:
  - `GET today` — daily-v2+featured 只读:items(id/title/url/topic/impact/isFeatured/isHot/hasOverride)+featuredIds/hotIds/observations
  - `POST override {date,op,id?,value?}` — op ∈ forceFeature/unfeature/hide/unhide/setTopic/setImpact/setSummary/setWhy/setHotList/setObservations/addMergeGroup/pruneStale;实现=磁盘重读→变更→validateOverrides(candidate,todayDaily)→原子写
  - `GET overrides/stale` — 扫全部 byDate 列出引用失效 id 的条目(发布阻断项)
  - `POST preview {date}` — 内存克隆 daily/featured → applyOverrides → 返回前后对比(featuredIdsAfter 等),**不落盘**
  - wechat 种子:GET/POST(按 url 去重,写时重读定点插入)/DELETE
  - deep:CRUD(url 为键,自动补 addedBy:"admin")
- **publish**:`GET plan`(dirty 分组+建议提交信息+stale 阻断+behind 检查)/ `POST diff {path}` / `POST run {commits:[{message,paths[]}],push,dispatchFetchFeeds,confirmPushedToMain}` / `POST git/sync`(pull --rebase,冲突返回文件列表中止)

### 发布流(工作区即暂存区)

1. **硬闸门**(plan 阶段):behind==0(否则引导 sync)→ validateCurrentData 通过 → stale overrides 清空(prune 默认保留最近 3 天 byDate)→ 无空提交
2. **提交**:每组显式 `git add -- <paths>`(**永不 git add -A**,防止吞进 translation-cache.json 变动;该文件脏时黄字警告"由 CI 自然更新")→ commit message 约定 `admin(<area>): <摘要>`,area ∈ sources|config|content|mixed
3. **推送**:`git push origin HEAD:main`(非 fast-forward 失败→提示先 sync,绝不 force)。推送自动触发 Pages+CF 两部署
4. **dispatch fetch-feeds**(勾选时,overrides/信源/配置改动需重构才生效):gh CLI → GH_TOKEN/ADMIN_GITHUB_TOKEN 走 REST(Node22+ 内置 fetch,204 即成功)→ 都没有则返回 manual,UI 展示可复制命令块(gh workflow run / 浏览器 Actions 页手动 Run workflow)
5. 收尾刷新状态条

### 流量监控(百度统计,零新增基础设施)

- `index.html` `</head>` 前插标准异步 hm.js 片段(SITE_ID 占位;注册站点域名填 keningke.github.io,**需用户注册百度统计账号后回填 SITE_ID**)
- `assets/app.js` 四处集中改动:①顶部 `window._hmt=window._hmt||[]` 兜底;②`/* admin:analytics */` 特征注释 + trackEvent/trackVirtualPv 辅助函数;③三处链接渲染补 data-event-id/data-source-name 属性;④init() 挂 document 级委托点击监听(source 卡→trackEvent('source','open_homepage',名);文章外链→trackEvent('content','outbound_click','<evt_id>|<标题前60字>',importance×20))+activateTab 补虚拟 PV('/#featured' 等)
- evt_id 稳定哈希→跨天按篇归因;label 自带标题→后台直接可读
- admin 流量页:集成自检(片段/SITE_ID/特征注释检测)+事件 schema 说明+三枚百度统计 deep-link 按钮+注意事项(数据小时级延迟、localhost 不计入、广告拦截会低估)

### UI 五页

1. **信源管理**:分类树+搜索+主表(健康徽章绿/黄/红/灰)+行内编辑模态+移动/删除;问题筛选 chips(404/parked/wechat-invalid…);子 tab「微信公众号失效」快捷删除/换链/标记已失效;「运行健康检查」进度条轮询
2. **内容运营**(核心):事件卡列表(topic/impact 过滤+搜索),每卡 强制精选/取消、隐藏/取消、主题下拉、影响下拉、改摘要/推荐理由弹窗、合并模式;右侧面板:今日观察 textarea(≤5 条)、热点榜有序列表(上移下移移除)、清理历史残留;顶部「覆盖预览」开关显示 applyOverrides 前后对比;子 tab 微信种子表格、深度阅读表格
3. **配置**:enums 结构化编辑器(topic 卡片+keywords 芯片编辑、hot 区块表单、坏正则拒收);其余文件 JSON 编辑器(textarea+格式化+校验不保存+保存);底部过滤沙箱
4. **流量**:如上
5. **发布**:状态卡(领先/落后警示+同步按钮)、待提交文件按功能区分组勾选、每组 message 预填、推送确认框("将自动触发两部署")+dispatch 勾选框、执行日志区、手动命令回退块

## 实施阶段(每阶段独立可验收)

- **P0 脚手架**(✅已完成):server/router/static/jsonfile/git + UI 壳 + status API + npm script。验收:npm run admin 起服务,五 tab 切换,状态条正确,curl /api/status 通,非 GET 缺头 403
- **P1 内容运营**(🔴最高优先):today 视图+override 操作+preview+stale 清理+wechat 种子+deep。验收:强制精选某条→preview 显示变化→validate 通过(overrides 文件首次诞生)→build:v2 --replay 回归不受损
- **P2 信源管理**:先抽 source-check.mjs(check-sources.mjs 改薄壳,npm run check 输出比对一致)→ CRUD API+UI+检查任务+微信子页。验收:增删改后 git diff 最小化;小范围检查任务跑通
- **P3 发布流**:plan/diff/run/sync+手动回退块。验收:**先在 %TEMP% 克隆+本地 bare origin 演练场跑全流程到 push 成功**(含人为制造 behind 验证拦截)→ 再对真库做一次只提交 docs/ADMIN.md 的真实发布
- **P4 配置**:六文件读写+enums 结构化编辑器+沙箱+resetEnumsCache。验收:改 keyword 后服务器内校验用新枚举;坏正则被拒;verify 绿
- **P5 流量**:index.html 片段+app.js 四处插桩+流量 tab。验收:node --check app.js;本地 serve 点外链无 JS 错误(_hmt 队列增长);SITE_ID 回填部署次日见数据
- **P6 文档测试**:docs/ADMIN.md+四个测试文件并入 npm test+README 一行入口

## 验证方式

1. **只读红线**:daily-v2/featured/daily 三文件在 server 代码中只有 read 路径(grep 断言)
2. **构建侧 dry-run**:overrides 生效验证用 `npm run build:v2 -- --dry-run`(产物进 gitignored feeds/dry-run/)对比 forcedFeaturedIds;日常用 preview 接口(内存 applyOverrides)
3. **三层校验闸门**:保存时 endpoint 内联 → 发布时 validateCurrentData+stale 扫描 → CI verify 兜底;每阶段收尾跑 npm run verify
4. **单元测试**(node --test):validators 恶意输入、override reducer、wechat 合并写入(模拟磁盘外部修改)、git 参数构造(fake execFile 断言无 shell 注入)、静态服务路径穿越
5. **Windows 冒烟**:PowerShell 与 Git Bash 双启动;中文路径读写;--port 换端口与 EADDRINUSE 提示

## 主要风险与对策

- **陈旧 override id 阻塞部署**:stale 扫描为发布硬闸门+内容页常驻清理入口+prune 保 3 天
- **wechat-articles.json 双写者**(管线回写 vs 后台):写前磁盘重读、定点 splice、保持外壳与格式;北京时间 05:00/12:00 构建窗口 UI 提示缓推
- **translation-cache.json churn**:发布默认不勾选+黄字警告
- **CI bot 并发**:behind==0 闸门+pull --rebase(bot 动 feeds/、admin 动 data/,冲突面小);绝不 force-push
- **生产泄露**:admin 只放根级 admin/,严禁放 assets/(整目录拷贝);P6 文档提醒
- **gh 未认证是常态**:所有 gh 路径有无凭据降级;docs/ADMIN.md 写明 gh auth login 步骤

## 用户侧前置动作(实现中或完成后需要用户做)

- 注册百度统计(tongji.baidu.com)添加站点(域名填 keningke.github.io),把 SITE_ID 回填 index.html —— P5 需要
- (可选)`gh auth login` 让发布流能自动 dispatch 构建;不配也能用,UI 给手动命令
