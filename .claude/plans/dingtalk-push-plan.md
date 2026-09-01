# EnergyHub 每日热点 → 钉钉自动推送

> 状态：已实现。**只发群消息，不 @ 人**（用户确认不要 @ 功能，已移除 atMobiles）。

## Context（背景）

EnergyHub 是纯静态能源/储能/AIDC 信息聚合站，内容靠 `fetch-feeds.yml` 每天两次（北京 05:00 / 12:00）跑 `build-daily-v2` 管线生成，产出 `feeds/daily-v2.json`（98 条事件）与 `feeds/featured.json`（精选/今日观察/热点榜）。目前数据只静静躺在站点里，**没有任何主动触达**。

**需求**：每天把「今日热点榜」自动推送到钉钉群。用户确认：
1. 形态 = **钉钉群自定义机器人**（加签）。钉钉没有官方"推送 CLI"，本方案的"cli"即我们写的 Node 命令行脚本。**不 @ 人，只发群消息**。
2. 频率 = **每天最多推一次**
3. 内容 = **热点榜 + 今日观察**

预期产出：构建成功后自动把热点推到钉钉群；本地可用 `npm run notify:dry` 预览。

## 关键技术事实（已核实）

- **热点榜数据**：`build-daily-v2.mjs` 的 `selectHot()` 产出 `featured.hotEventIds`（≤5）；`selectFeatured()` 产出 `featuredEventIds`（≤12）与 `observations`（top3，格式 `【主题】标题`）。事件明细在 `daily-v2.json.items[]`。
- **缺失回退**：`hotEventIds` 缺/空 → 取 `featuredEventIds` 前 5（现网 8/22 旧数据正是这种情况）。
- **HTTP/签名**：原生 `fetch`（Node 22）+ `node:crypto` 的 `createHmac`。
- **CLI/分层/测试约定**：沿用 `scripts/lib/` 纯函数 + `scripts/` CLI + `tests/*.test.mjs`（node:test）。
- **钉钉加签**：`stringToSign = timestamp + "\n" + secret`；`sign = urlencode(base64(HmacSHA256(stringToSign, secret)))`。固定测试向量：`secret='test-secret'`、`ts=1700000000000` → base64 `BYMqUCZnSqbfPf1GCfZftO7Rg2g6P+Rp3/4+bLNtSGA=`。

## 决策（已与用户确认）

| 项 | 选择 |
|---|---|
| 推送渠道 | 钉钉群自定义机器人（加签），**只发群消息，不 @ 人** |
| 频率 | 每天最多一次（只在 **12:00 北京** 那个构建窗口推；`workflow_dispatch` 也推，便于测试） |
| 内容 | 热点榜（≤5，标题链接+来源）+ 今日观察（3 条）+ 站点链接 |
| 签名 | 加签为主；未配 secret 时退化为不签名（兼容关键词/IP 白名单模式） |

## 实现（已落地）

### 文件
```
scripts/lib/dingtalk.mjs          # 纯函数：签名 / 拼 URL / 组 markdown / 取热点条目
scripts/notify-dingtalk.mjs       # CLI：读 env+feeds → 调 lib → fetch POST；--dry-run
tests/dingtalk.test.mjs           # node:test 单测
.github/workflows/fetch-feeds.yml # 加 1 个推送 step（schedule 门控 + continue-on-error）
package.json                      # 加 "notify" / "notify:dry"
README.md                         # 加「钉钉推送配置」小节
```

### scripts/lib/dingtalk.mjs
- `dingtalkSign(secret, timestamp)` → base64（未 url 编码）
- `buildSignedUrl(webhook, secret, timestamp)` → URL 拼 timestamp+sign；secret 空则原样返回
- `resolveHotItems(featured, daily, max=5)` → 优先 `hotEventIds`，缺失回退 `featuredEventIds` 前 max，过滤陈旧 id
- `buildHotMessage(featured, daily, { siteUrl })` → `{ title, text }`（markdown：标题日期 + 今日观察引用 + 热点榜有序列表 + 站点链接；不用表格/代码块）

### scripts/notify-dingtalk.mjs
- 读 env：`DINGTALK_WEBHOOK`（必填，除 --dry-run）、`DINGTALK_WEBHOOK_SECRET`（可空）、`ENERGYHUB_URL`（默认 `https://keningke.github.io/EnergyHub`）
- `--dry-run` → 打印不发送；无 webhook → 跳过退出 0；发送成功退出 0；失败退出 1（CI `continue-on-error` 兜底）
- body：`{ msgtype:'markdown', markdown:{title,text} }`（无 `at` 字段）

### CI（fetch-feeds.yml 末尾）
```yaml
- name: Push daily hot list to DingTalk
  if: |
    github.event_name == 'workflow_dispatch' ||
    github.event.schedule == '0 4 * * *'
  continue-on-error: true
  run: node scripts/notify-dingtalk.mjs
  env:
    DINGTALK_WEBHOOK: ${{ secrets.DINGTALK_WEBHOOK }}
    DINGTALK_WEBHOOK_SECRET: ${{ secrets.DINGTALK_WEBHOOK_SECRET }}
```
改早上推：把 `'0 4 * * *'` 换成 `'0 21 * * *'`。

## 验证（已通过）

- `npm run verify` 全绿：188 测试通过（含新增 9 个钉钉测试），数据校验通过。
- `npm run notify:dry` 正确打印当日热点（走无 `hotEventIds` 的回退路径）。

## 用户侧前置动作

1. 钉钉群 → 群设置 → 智能群助手 → 添加机器人 → 自定义（Webhook）→ 安全设置选**加签**，拿到 **webhook URL** 与 **加签 secret**。
2. 仓库 Settings → Secrets and variables → Actions 新建：`DINGTALK_WEBHOOK`、`DINGTALK_WEBHOOK_SECRET`。
3. 确认站点链接 `https://keningke.github.io/EnergyHub` 是否正确（不对就说实际域名）。
