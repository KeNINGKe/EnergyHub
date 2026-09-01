# 能源 / 储能 / AIDC 信息聚合导航站

一个纯静态网站，零服务器成本：
- **综合导航页**：分类展示国内外发电、储能、AIDC 信息源，点击直达。
- **日报**：由 GitHub Actions 定时抓取各源 RSS，自动生成 JSON 静态数据。
- **深研**：预留手动/AI 辅助填充的精选长文区。

## 技术栈
- 前端：原生 HTML + CSS + JS，无框架，无构建。
- 数据：`data/sources.json` 驱动导航；`feeds/*.json` 由脚本生成。
- 自动化：`scripts/fetch-rss.mjs` + GitHub Actions cron。
- 托管：Cloudflare Pages（免费），绑定 GitHub 仓库自动部署。

## 本地预览

```bash
cd energy-info-hub
npm install
npm run preview
# 浏览器打开 http://localhost:5173
```

> 注：因为页面用 `fetch()` 读取本地 JSON，必须通过本地 http 服务访问，不能直接用 `file://` 打开。

## 本地测试 RSS 抓取

```bash
# 抓取日报
npm run fetch
```

抓取结果会写入 `feeds/daily.json`。

## 部署上线

1. **创建 GitHub 仓库**
   - 手动在 GitHub 创建空仓库；或执行 `gh repo create energy-info-hub --public --source=.`
   - 提交代码：`git push -u origin main`

2. **Cloudflare Pages 托管**
   - 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/) → Pages → "Create a project"
   - 连接 GitHub 仓库 `energy-info-hub`
   - Build settings：
     - Framework preset：None
     - Build command：`echo "static"`
     - Build output directory：`/`
   - 保存，首次部署后得到 `https://<project>.pages.dev`

3. **（可选）绑定独立域名**
   - 在 Cloudflare Pages 项目 → Custom domains 中添加域名，按提示改 DNS。

## GitHub Actions 定时任务

仓库 `.github/workflows/fetch-feeds.yml` 配置：
- **动态更新**：北京时间每天 05:00 和 12:00 各运行一次。

任务会抓取 `data/sources.json` 中配置的 RSS 与显式页面型信源，生成 `feeds/daily-v2.json` 和 `feeds/featured.json`，并提交回仓库触发静态站点重新部署。部署前会运行测试与数据校验。

## 钉钉每日热点推送

构建成功后，可把当天「热点榜 + 今日观察」自动推送到钉钉群（自定义机器人，加签）。默认只在**北京 12:00** 那个构建窗口推，每天最多一次；推送失败不阻塞抓取/部署。

**配置步骤**

1. 钉钉群 → 群设置 → 智能群助手 → 添加机器人 → **自定义（通过 Webhook 接入）**，安全设置选**加签**，记下 **webhook 地址**和**加签 secret**。
2. 仓库 Settings → Secrets and variables → Actions 新建 2 个 secret：
   - `DINGTALK_WEBHOOK`：完整 webhook URL（含 access_token）
   - `DINGTALK_WEBHOOK_SECRET`：加签 secret（用关键词/白名单模式可留空）
3. （可选）站点链接默认 `https://keningke.github.io/EnergyHub`，可用环境变量 `ENERGYHUB_URL` 覆盖。

**本地调试**

```bash
npm run notify:dry   # 只打印将发送的 markdown，不发送、无需凭据
npm run notify       # 真实发送（需先在环境变量里给 DINGTALK_WEBHOOK 等）
```

改推送时间窗口（如改成早上）或推送内容，见 `.github/workflows/fetch-feeds.yml` 的 `Push daily hot list to DingTalk` 步骤与 `scripts/notify-dingtalk.mjs`。

## 目录结构

```
energy-info-hub/
├── index.html              # 主页
├── assets/                 # 前端（样式 + 渲染逻辑）
│   ├── style.css
│   └── app.js
├── data/                   # 数据配置
│   ├── sources.json        # 信息源数据（导航用）
│   ├── enums.json          # 主题/来源类型/影响/地区枚举
│   ├── filters.json        # 相关性过滤关键词（强/组合/通用/负面）
│   ├── source-types.json   # 来源类型规则
│   ├── entities.json       # 实体表
│   └── regions.json        # 地区别名表
├── feeds/                  # 生成的动态数据
│   ├── daily.json          # 兼容文件（可由 --activate 更新为 V2）
│   ├── daily-v2.json       # 前端优先读取的 V2 事件级数据
│   ├── featured.json       # 今日观察 + 精选编排（V2）
│   └── dry-run/            # V2 回放 dry-run 产物
├── scripts/                # 抓取 / 构建 / 评估脚本
│   ├── lib/                # 共享逻辑库（过滤/合并/校验/兼容层等）
│   ├── fetch-rss.mjs       # V1 RSS 抓取
│   ├── build-daily-v2.mjs  # V2 生成器
│   └── eval-filter.mjs     # 过滤评估
├── tests/                  # Node 测试（npm test）
├── samples/                # 标注样本 / 基线 / 回放夹具
├── docs/                   # 项目文档
│   ├── DATA_PROTOCOL.md    # V2 数据协议
│   ├── V1.1_PRD.md         # 产品需求
│   ├── V1.1_DEVELOPMENT_TASKS.md  # 开发任务清单
│   ├── PRODUCT_PLAN.md     # 产品规划
│   ├── WORKLOG.md          # 工作日志
│   └── worklogs/           # 会话工作日报（gitignore）
├── .github/workflows/      # CI（部署 + 定时抓取）
├── package.json
└── README.md
```

## 内容来源与版权说明

- 自动抓取只保存**标题、链接、简短摘要**，点击后跳转原文，不存储全文。
- 微信公众号、财新、BNEF 等封闭/付费源暂无官方 RSS，第一期只做导航；第二期可接 RSSHub 抓取公共实例。
- 深研区内容为人工或 AI 辅助整理的摘要，引用均附原文链接。

## 后续增强（可选）

- [ ] 接入 RSSHub 抓取微信公众号、知乎等中文封闭源
- [ ] 深研区接入 AI 自动摘要
- [ ] 增加搜索、标签筛选、收藏功能
- [ ] 国内 CDN 加速（如访问慢）
