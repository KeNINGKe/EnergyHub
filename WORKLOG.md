# EnergyHub 工作日志

> 日期：2026-07-14  
> 项目：EnergyHub — 电力 / 储能 / AIDC 信息聚合站  
> 本地预览：`http://localhost:5173`

---

## 1. 项目目标

打造一个零成本静态网站，聚合国内外发电、储能、AIDC（AI 数据中心）相关信息源，包含：

- **信息源导航**：分类展示全部信息源，点击直达
- **日报**：基于 RSS 自动聚合（GitHub Actions 每日运行）
- **周报**：基于 RSS 自动聚合（GitHub Actions 每周运行）
- **深研**：人工/AI 辅助填充的深度研究内容

技术栈：纯静态 HTML/CSS/JS，无后端，无服务器租金，托管在 Cloudflare Pages / GitHub Pages。

---

## 2. 本次会话完成内容

### 2.1 前端视觉多轮迭代

从早期偏 AI 生成感的通用设计，逐步收敛到用户满意的极简科技编辑风：

| 轮次 | 改动 | 结果 |
|---|---|---|
| 初始 | 信息源导航 + 日报/周报/深研四栏布局 | 可用但设计感弱 |
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
- 41 个 RSS 源中 22 个成功抓取，生成日报 98 条、周报 147 条
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
    <button class="view-tab" data-tab="weekly">周报</button>
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

    <section id="weekly" class="tab-panel" aria-labelledby="tab-weekly">
      <div class="feed-header">
        <h2>周报</h2>
        <p id="weeklyMeta"></p>
      </div>
      <div class="feed-list" id="weeklyList">
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
│   ├── deep.json
│   └── weekly.json
├── scripts/
│   └── fetch-rss.mjs
├── index.html
├── package.json
├── README.md
└── WORKLOG.md
```

---

## 7. 下一步待办

- [ ] 用户确认当前设计是否可上线
- [ ] 推送代码到 GitHub 仓库
- [ ] 连接 Cloudflare Pages 自动部署
- [ ] 配置自定义 `xxx.pages.dev` 子域名
- [ ] 验证 GitHub Actions RSS 抓取在美国网络下的成功率
- [ ] 补充深研内容到 `feeds/deep.json`
- [ ] 设置 Cloudflare Pages 访问分析

---

## 8. 备注

- 本地预览使用 Python `http.server`（`python3 -m http.server 5173`），`serve` 包在 Windows/Git Bash 环境有 502 异常。
- 许多中文/封闭平台无 RSS，已作为导航-only 源保留，并在卡片上标注 `RSS` 标签区分可聚合源。
- 403/超时源未删除，留给 GitHub Actions 在美国 IP 下重试。
