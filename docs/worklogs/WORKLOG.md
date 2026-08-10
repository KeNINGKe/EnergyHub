# EnergyHub 工作日志

> 日期：2026-07-14 / 2026-07-15  
> 项目：EnergyHub — 电力 / 储能 / AIDC 信息聚合站  
> 本地预览：`http://localhost:5173`  
> 当前版本：V1.0（信息源导航 + 日报 + 深研；周报功能已移除）

---

## 1. 项目目标

打造一个零成本静态网站，聚合国内外发电、储能、AIDC（AI 数据中心）相关信息源，包含：

- **信息源导航**：分类展示全部信息源，点击直达
- **日报**：基于 RSS 自动聚合（GitHub Actions 每日运行）
- **深研**：人工/AI 辅助填充的深度研究内容

> 注：早期版本曾包含周报，V1.0 已移除，聚焦日报 + 深研。

技术栈：纯静态 HTML/CSS/JS，无后端，无服务器租金，托管在 Cloudflare Pages / GitHub Pages。

---

## 2. 本次会话完成内容

### 2.1 前端视觉多轮迭代

从早期偏 AI 生成感的通用设计，逐步收敛到用户满意的极简科技编辑风：

| 轮次 | 改动 | 结果 |
|---|---|---|
| 初始 | 信息源导航 + 日报/周报/深研四栏布局（周报后续移除） | 可用但设计感弱 |
| 第 1 轮 | 深色科幻仪表盘（波形 hero、信号灯、暗色背景） | 用户不喜欢科幻风 |
| 第 2 轮 | Anthropic 式极简：浅色、大量留白、纤细排版 | 方向对，但太空 |
| 第 3 轮 | 加宽布局（1280px）、减少两侧留白、注入橙色强调 | 更接近目标 |
| 第 4 轮 | 圆角卡片、柔和阴影、Plus Jakarta Sans、现代编辑感 | 用户认可 |
| 第 5 轮 | 加深 hero 橙色光晕、简化分类名括号、修复 tab 对齐 | 细节打磨 |
| 第 6 轮 | 换标题字体：Sansation → Fraunces → Anta | 最终定稿 Anta |
| 第 7 轮 | 标题改为 `EnergyHub`、去掉副标题 | 最终 hero 形态 |

### 2.2 信息源整理

- 将分类名简化，去掉括号及括号内说明：
  - `发电（分技术路线）` → `发电`
  - `储能（含电力市场/辅助服务）` → `储能`
  - `AIDC – 数据中心行业本身` → `AIDC`
- 删除 5 个指向官网首页而非具体社区/账号的无效源：
  - 知识星球（储能/电力现货/AIDC）
  - 微信公众号矩阵
  - B站/视频号
  - 雪球新能源
  - Twitter/X KOL 清单

### 2.3 Tab 对齐修复

用户反馈「信息源」三个字视觉上后两字偏上。修复手段：

- `.view-tab` 改为 `inline-flex` + `align-items: center` + `justify-content: center`
- `line-height: 1` 消除中文字符上下多余行距
- `min-height: 38px` + 水平 padding，靠 flex 真正居中
- 字号改为 14px 整像素，加 `-webkit-font-smoothing: antialiased` 优化渲染
- 使用系统中文字体回退栈

### 2.4 RSS 抓取验证

- 本地运行 `npm run fetch` 验证脚本可用
- 41 个 RSS 源中 22 个成功抓取，生成日报 98 条
- 403/超时源保留给 GitHub Actions 在美国网络环境下重试

---

## 3. 最终设计状态

### 3.1 字体

- **标题字体**：`Anta`（Google Fonts，400 regular），几何科技感
- **正文字体**：`Inter`（Google Fonts，400/500/600）
- **等宽字体**：系统默认等宽字体（用于日期、标签、RSS 标记）
- **中文回退**：PingFang SC / Hiragino Sans GB / Microsoft YaHei

### 3.2 色彩

| Token | 值 | 用途 |
|---|---|---|
| `--bg` | `#FFFFFF` | 页面背景 |
| `--bg-soft` | `#FAFAF8` | 侧栏、hover 背景 |
| `--text` | `#18181B` | 主文字 |
| `--text-muted` | `#52525B` | 次要文字 |
| `--accent` | `#F97316` | 强调色、链接、RSS、hover 边框 |
| `--accent-hover` | `#EA580C` | 强调色 hover |
| `--accent-soft` | `#FFF7ED` | RSS 标签背景 |

### 3.3 布局

- 最大宽度：`1280px`
- 信息源页：左侧分类 sticky 侧栏（240px）+ 右侧卡片网格
- 卡片：16px 圆角、柔和阴影、hover 上浮 + 橙色边框
- 视图切换：顶部 pill 形 tab
- Hero：仅保留 `EnergyHub` 大标题 + 右上角淡橙色径向光晕

---

## 4. 关键文件快照

### 4.1 `index.html`（当前）

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EnergyHub · 能源 / 储能 / AIDC</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Anta:wght@400&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="assets/style.css">
</head>
<body>
  <header class="site-header">
    <div class="header-inner">
      <h1>EnergyHub</h1>
    </div>
  </header>

  <nav class="view-tabs" aria-label="视图切换">
    <button class="view-tab active" data-tab="nav">信息源</button>
    <button class="view-tab" data-tab="daily">日报</button>
    <button class="view-tab" data-tab="deep">深研</button>
  </nav>

  <main class="container">
    <section id="nav" class="tab-panel active" aria-labelledby="tab-nav">
      <div class="browse-layout">
        <aside class="category-sidebar" id="categoryList">
          <div class="loading-state">加载中…</div>
        </aside>
        <div class="sources-stage" id="sourcesArea">
          <div class="loading-state">加载中…</div>
        </div>
      </div>
    </section>

    <section id="daily" class="tab-panel" aria-labelledby="tab-daily">
      <div class="feed-header">
        <h2>日报</h2>
        <p id="dailyMeta"></p>
      </div>
      <div class="feed-list" id="dailyList">
        <div class="loading-state">加载中…</div>
      </div>
    </section>

    <section id="deep" class="tab-panel" aria-labelledby="tab-deep">
      <div class="feed-header">
        <h2>深研</h2>
        <p id="deepMeta"></p>
      </div>
      <div class="feed-list" id="deepList">
        <div class="loading-state">加载中…</div>
      </div>
    </section>
  </main>

  <footer class="site-footer">
    <span id="updatedAt">-</span>
  </footer>

  <script src="assets/app.js"></script>
</body>
</html>
```

### 4.2 `assets/style.css` 关键片段

```css
:root {
  --bg: #FFFFFF;
  --bg-soft: #FAFAF8;
  --bg-warm: #FFF7ED;
  --bg-hover: #F5F5F0;
  --text: #18181B;
  --text-muted: #52525B;
  --text-faint: #A1A1AA;
  --border: #E4E4E7;
  --border-light: #F4F4F5;
  --accent: #F97316;
  --accent-soft: #FFF7ED;
  --accent-hover: #EA580C;
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.04);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.06);
  --shadow-lg: 0 12px 32px rgba(0, 0, 0, 0.08);
  --radius-sm: 10px;
  --radius-md: 16px;
  --radius-lg: 20px;
  --max-width: 1280px;
  --font-display: "Anta", "PingFang SC", "Microsoft YaHei", sans-serif;
  --font-body: "Inter", "PingFang SC", "Microsoft YaHei", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

.site-header h1 {
  font-family: var(--font-display);
  font-size: clamp(1.9rem, 4vw, 2.7rem);
  font-weight: 400;
  letter-spacing: 0.02em;
  line-height: 1.1;
  margin: 0 0 14px;
  color: var(--text);
}

.view-tab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  appearance: none;
  margin: 0;
  background: transparent;
  border: 1px solid transparent;
  color: var(--text-muted);
  min-height: 38px;
  padding: 0 18px;
  border-radius: 99px;
  font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  font-size: 14px;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  transition: all 0.2s;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}
```

---

## 5. Git 提交记录（本次会话）

```
e764c1b fix: update page title to EnergyHub
9665a95 docs: add WORKLOG.md session summary
9fcb1fb style: remove subtitle
888ff79 style: use Anta for headings, revert accent to bright orange, rename to EnergyHub
cc98adf style: switch to Fraunces serif + warm coral accent
bd180c0 style: use Sansation 400 for all display headings
e4a2868 style: switch display font to Schibsted Grotesk, reduce heading sizes
4038233 fix: tighten tab vertical alignment with line-height 1 and fixed height
fb75164 fix: tab text alignment, rename AIDC category, remove invalid community sources
01fc849 tune: deepen hero orange glow, remove parenthetical text from category names
4fedc18 redesign: clean-but-rich style with Plus Jakarta Sans, rounded cards, soft shadows, orange accents
2595a58 tune: wider layout (1200px), less side padding, orange accent for tabs/category/rss/links
0a8c621 redesign: Anthropic-style light, airy, content-first frontend
3fe90f9 redesign: energy intelligence dashboard with waveform hero and signal lamps
6963ee1 init: energy info hub with navigation and RSS feeds
```

---

## 6. 当前文件清单

```
energy-info-hub/
├── .github/workflows/fetch-feeds.yml
├── assets/
│   ├── app.js
│   └── style.css
├── data/
│   └── sources.json
├── feeds/
│   ├── daily.json
│   └── deep.json
├── scripts/
│   └── fetch-rss.mjs
├── index.html
├── package.json
├── README.md
└── WORKLOG.md
```

---

## 7. 下一步待办

### 7.1 基础待办（V1 早期）

- [x] 推送代码到 GitHub 仓库
- [x] 连接 Cloudflare Pages 自动部署（改用 Workers：`energyhub.jereh.workers.dev`）
- [ ] 配置自定义 `xxx.pages.dev` 子域名
- [ ] 验证 GitHub Actions RSS 抓取在美国网络下的成功率
- [ ] 补充深研内容到 `feeds/deep.json`
- [ ] 设置 Cloudflare Pages 访问分析

### 7.2 微信管线待办（2026-08-07 记录）

- [x] **V2 构建接入 CI（隐患，优先）**：`fetch-feeds.yml` 由 `npm run fetch`（V1，只写 `daily.json`）改为 `npm run build:v2`（`node scripts/build-daily-v2.mjs`），定时任务每天重新生成 `daily-v2.json`/`featured.json`/微信数据。⚠️ **未用 `--activate`**：前端 `app.js` 优先读 `daily-v2.json`（`v2 || v1`），`--activate` 只覆盖 `daily.json` 会让前端继续读到冻结的旧 `daily-v2.json`。（2026-08-10 修复）
- [x] **种子文件一次性问题（隐患）**：`fetchWechatSeeds` 现会回填保留期（3 天）内已抓取的种子进 items 流，并在抓取时存 `summary`/`author` 供回填；重建不再丢公众号文章。（2026-08-10 修复）
- [x] **V2 构建空结果保护**：`build-daily-v2.mjs` 已加 `stats.events===0` 时跳过写入（保留既有 feeds），防止全源失败时线上被空日报覆盖。回放/dry-run 路径不受影响。（2026-08-10 实现）
- [ ] **查透 pipeline 吞微信文章**：手动复现 17/22 条 mp.weixin 能过过滤，但 build 后进日报仅个位数。定位是过滤时机/内容差异还是去重合并环节，可能需让微信种子跳过相关性过滤或走独立通道。
- [ ] **公众号最新文章日常维护**：各公众号无官网，当日最新文章需人工把 mp.weixin 链接填入 `feeds/wechat-articles.json`（丢链接 → `npm run build:v2` → 内容进日报）。
- [ ] **4 个号待补链接**：阳光电源 / 创客能源 / SST渗透率 / 蓝海经研，本轮未找到可抓取文章，留空模板。

### 7.3 国内可达迁移（2026-08-10 决定）

**背景**：同事反映 `energyhub.jereh.workers.dev` 打不开。原因是 `.workers.dev` 域名在大陆被 DNS 污染/封锁（多年已知问题），同事需挂梯子。用户决定迁移到**香港轻量服务器**（免备案、大陆可直连）。

**方案**（仓库公开，免 SSH 凭证）：
- `scripts/server-setup.sh`：Ubuntu 22.04 一键装 nginx + `git clone` 公开仓库到 `/opt/energyhub` + nginx 只放行 `index.html/assets/data/feeds`（其余 404）+ 每 15 分钟 `git pull` 定时同步。
- GitHub Actions 每天提交新日报 → 服务器 15 分钟内自动同步，**无需改现有 Cloudflare 部署**（继续保留）。
- 无域名，暂用 `http://IP` 直访；后续可买域名配 Let's Encrypt 上 HTTPS。
- 待办：服务器放行 80 端口（腾讯云轻量控制台防火墙需手动加规则）、Google Fonts 在大陆被墙（会退化系统字体，可自托管优化）。

---

## 8. 备注

- 本地预览使用 Python `http.server`（`python3 -m http.server 5173`），`serve` 包在 Windows/Git Bash 环境有 502 异常。
- 许多中文/封闭平台无 RSS，已作为导航-only 源保留，并在卡片上标注 `RSS` 标签区分可聚合源。
- 403/超时源未删除，留给 GitHub Actions 在美国 IP 下重试。

---

## 9. 2026-07-15 会话：信息源健康巡检 + 低相关清理 + 副标题回归

### 9.1 信息源健康巡检

新增可复用巡检脚本 `scripts/check-sources.mjs`（`npm run check`），批量探测所有源 URL：HTTP 状态、重定向终址、页面标题、停放/404/微信失效页检测。对存疑源二次复核（重试 + www 变体），对死链探测候选新地址。

首轮结果（163 源）：91 正常、72 异常。逐项甄别后，72 中约 27 个是 Cloudflare/WAF 反爬误报（真人浏览器正常），其余为真坏链。

### 9.2 坏链清理（163 → 132 源）

- **删除死链/被出售/被劫持 18 个**：EESA（域名过期）、无所不能、电联新媒、能见、香橙会、中国氢能联盟（h2cn.org 被赌博站劫持）、中电联电力市场分会、半导体行业观察、芯东西、Redefining Energy、北京电力交易中心（bjpes 被开云赌博劫持）、CDCC、电老虎网、势银、氢云链（被 Mission Hydrogen 占用）、全国碳市场、高工锂电（证书过期）、能源杂志。
- **删除冗余失效深链 4 个**：科智咨询、Utility Dive-DC、NEA 数据栏目、北极星招标（主站均已收录）。
- **删除低价值被墙源 8 个**：Reddit ×5、LinkedIn ×3（跳 linkedin.cn 看不到内容）。
- **删除 1 个**：广州电力交易中心（gzpec.com 实为域名出售页，撤回误更新）。
- **更新 URL 6 个**：生物质 → beipa.org.cn、GEM → global-coal-plant-tracker、DOE GDO → energy.gov/oe（改名 DOE Office of Electricity）、Volta → 去 www、煤炭工业协会 → https、鑫椤 → http（https 证书坏）。
- **微信 5 个转说明型卡片**：储能与电力市场、储能头条、储能100人、兰木达电力现货、蓝海经研（去链接，标"微信公众号·搜索访问"）。
- **加"翻墙"标记 4 个**：Reuters、Bloomberg、Baxtel、Chip Letter（琥珀色警示标签）。

### 9.3 前端配套

- `app.js`：支持 `url` 为空的静态卡片（微信）+ 微信提示；"翻墙"标签加 `tag--gfw` 类。
- `style.css`：新增 `.source-card--static`、`.wechat-note`、`.tag--gfw` 样式。

### 9.4 低相关性梳理（132 → 124 源）

按"电力/储能/AIDC"核心定位，移除相关性弱的源：

- **煤炭 4 个**：中国煤炭工业协会、中国煤炭资源网、S&P Global Coal/LNG（亦与 S&P Global Commodity Insights 重复）、GEM Global Coal Plant Tracker。
- **生物质 2 个**：中国产业发展促进会生物质能产业分会、IEA Bioenergy（小众发电路线，远离储能/AIDC）。
- **泛门户 2 个**：虎嗅·妙投能源、36氪·出海/碳中和（URL 指向通用首页，非能源专区）。

保留但属可进一步商榷：水电（抽水蓄能与储能相关）、招投标通用平台、碳市场（上海环交所）、金融终端（Wind/iFinD/CEIC）。

### 9.5 副标题回归

`index.html` hero 重新加入副标题 `<p class="subtitle">电力 · 储能 · AIDC 信息聚合</p>`（9fcb1fb 曾移除），并补回 `.subtitle` 样式（等宽字体、字距、muted 色）。

### 9.6 巡检终态（124 源）

| 状态 | 数量 | 说明 |
|---|---|---|
| 正常 | 90 | 可正常访问 |
| 无外链 | 5 | 微信公众号说明型卡片（设计如此） |
| 反爬误报 | 25 | 403/412/429，真人浏览器正常 |
| 被墙 | 4 | Reuters、Bloomberg、Baxtel、Chip Letter（已标翻墙） |

唯一存疑：中国核能行业协会 `china-nea.cn`（403/110字节，建议人工确认）。
