import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  collectFeeds, parseJinaArticle, parseJinaPage, parseWechatArticleHtml, loadSources, fetchWechatSeeds,
  isWechatArticleUrl, parseGenericPageHtml, stripSearchSuffix
} from '../scripts/lib/fetch.mjs';

const data = await loadSources();

test('collectFeeds 默认只收 rss/search，标记 fetchType 正确', () => {
  const feeds = collectFeeds(data);
  assert.ok(feeds.length >= 30, `rss 信源应 ≥30，实际 ${feeds.length}`);
  assert.ok(feeds.every(f => f.fetchType === 'rss' || f.fetchType === 'search'));
  assert.ok(feeds.every(f => f.rss), '每个都应有 rss');
  // 重点公司检索源（company-intel 分类）应被标记为 search
  const search = feeds.filter(f => f.fetchType === 'search');
  assert.ok(search.length >= 15, `检索源应 ≥15，实际 ${search.length}`);
  assert.ok(search.every(f => f.rss.includes('news.google.com')), '检索源应指向 Google News');
});

test('stripSearchSuffix：剥「 - 媒体名」尾巴，正文含连字符时只剥最后一段', () => {
  assert.equal(stripSearchSuffix('宁德时代发布新品 - 北极星储能网'), '宁德时代发布新品');
  assert.equal(stripSearchSuffix('CATL - Energy-Storage.News'), 'CATL');
  // 正文自身含「 - 」时只剥最后一段（媒体名）
  assert.equal(stripSearchSuffix('Tesla Megapack - what changed - PV Magazine'), 'Tesla Megapack - what changed');
  // 剥完为空 / 无尾巴：保留原样
  assert.equal(stripSearchSuffix(' - 北极星'), ' - 北极星');
  assert.equal(stripSearchSuffix('无尾巴标题'), '无尾巴标题');
  assert.equal(stripSearchSuffix(''), '');
});

test('collectFeeds includePages=true 只收 RSS + 显式 fetchType:page，不误扫普通 url 站', () => {
  const feeds = collectFeeds(data, { includePages: true });
  const pageFeeds = feeds.filter(f => f.fetchType === 'page');
  // 只有显式 fetchType:'page' 标记的源（电力设备/SST·PCS 分类）进入页面抓取
  assert.ok(pageFeeds.length >= 5, `页面型信源应 ≥5，实际 ${pageFeeds.length}`);
  // 普通 url 站（无 rss、无微信公众号、无 fetchType:page 标记）不应被采集
  const unmarkedPlainUrls = data.categories
    .flatMap(c => c.sources)
    .filter(s => s.url && !s.rss && !(s.tags || []).includes('微信公众号') && s.fetchType !== 'page').length;
  assert.ok(unmarkedPlainUrls > 50, `存在 ${unmarkedPlainUrls} 个普通 url 站需要被挡下`);
  // 页面型必须带显式标记（微信公众号标签 或 fetchType:page），防止误扫普通站
  for (const f of pageFeeds) {
    assert.ok((f.tags || []).includes('微信公众号') || f.fetchType === 'page', `${f.name} 必须带显式标记`);
  }
});

test('collectFeeds：公众号配 url 后进入 page 型；非公众号被挡下', () => {
  const stub = {
    categories: [{
      name: '储能',
      sources: [
        { name: '储能与电力市场', url: 'https://mp.weixin.qq.com/s/abc', tags: ['微信公众号'], rss: null },
        { name: '储能100人', url: 'https://mp.weixin.qq.com/s/def', tags: ['媒体', '微信公众号'], rss: null },
        { name: '普通行业站', url: 'https://example.com', tags: ['媒体'], rss: null },
        { name: '显式标记站', url: 'https://example.org', tags: [], rss: null, fetchType: 'page' }
      ]
    }]
  };
  const feeds = collectFeeds(stub, { includePages: true });
  const page = feeds.filter(f => f.fetchType === 'page');
  // 2 个公众号 + 1 个显式标记站 = 3；普通 url 站被挡下
  assert.equal(page.length, 3);
  assert.deepEqual(page.map(f => f.name).sort(), ['储能100人', '储能与电力市场', '显式标记站']);
  assert.ok(!feeds.some(f => f.name === '普通行业站'), '普通 url 站不应被采集');
  // fetchType:'page' 显式标记（即使非公众号）也允许
  assert.ok(feeds.some(f => f.name === '显式标记站' && f.fetchType === 'page'));
});

const WECHAT_MD = `Title: 储能电池原材料价格走势分析
URL Source: https://mp.weixin.qq.com/s/AbC123
Published Time: 2026-08-07T09:30:00+08:00
Markdown Content:
# 储能电池原材料价格走势分析

2026年8月7日，随着碳酸锂价格企稳，储能电芯价格环比小幅回落……

本文系统梳理了近期储能电池原材料的价格走势、供需格局变化以及对下游集成商成本的影响。
`;

test('parseJinaArticle：H1 标题 + 中文日期（转北京时间零点）', () => {
  const [it] = parseJinaArticle(WECHAT_MD, '兜底');
  assert.equal(it.title, '储能电池原材料价格走势分析');
  assert.equal(it.pubDate, '2026-08-06T16:00:00.000Z', '2026年8月7日 00:00+08:00 的 UTC');
  assert.equal(it.link, 'https://mp.weixin.qq.com/s/AbC123');
  assert.ok(it.summary.length >= 30, `摘要应非空，实际 ${it.summary.length}`);
});

test('parseJinaArticle：无中文日期时回退 Published Time', () => {
  const md = WECHAT_MD.replace('2026年8月7日，随着', '随着');
  const [it] = parseJinaArticle(md, '兜底');
  assert.equal(it.pubDate, '2026-08-07T01:30:00.000Z', '2026-08-07T09:30:00+08:00 的 UTC');
});

test('parseJinaArticle：标题缺失时用 fallbackTitle', () => {
  const md = `Markdown Content:\n正文内容。`.replace('正文内容。', '仅正文，无标题块。');
  const [it] = parseJinaArticle(md, '储能头条');
  assert.equal(it.title, '储能头条');
});

test('isWechatArticleUrl：识别 mp.weixin 短链与参数式，转载站为 false', () => {
  assert.equal(isWechatArticleUrl('https://mp.weixin.qq.com/s/Hr5WTdxaYIyZQmBwhrsjrA'), true, '短链 /s/ 识别');
  assert.equal(isWechatArticleUrl('https://mp.weixin.qq.com/s?__biz=MzIxMTYwNjMwMw==&mid=2247552149'), true, '参数式 /s? 识别');
  assert.equal(isWechatArticleUrl('https://chuneng.bjx.com.cn/html/20260807/135000.shtml'), false, '转载站 URL 不是微信');
  assert.equal(isWechatArticleUrl('https://mp.weixin.qq.com/mp/profile_ext?action=home'), false, '非文章页不是微信文章');
});

test('parseGenericPageHtml：转载站直连兜底解析（og:title/<title> + 正文）', () => {
  const [it] = parseGenericPageHtml(
    '<html><head><meta property="og:title" content="北极星储能网转载文章"/><title>备用标题</title></head>' +
    '<body><nav>导航链接</nav><div>正文第一段储能相关内容，足够长以便提取摘要。</div></body></html>',
    '兜底'
  );
  assert.equal(it.title, '北极星储能网转载文章', '优先 og:title');
  assert.ok(it.summary.includes('储能相关内容'), '提取正文摘要');

  const [it2] = parseGenericPageHtml('<html><head><title>仅标题页</title></head><body><p>内容略。</p></body></html>', '兜底');
  assert.equal(it2.title, '仅标题页', '无 og:title 时用 <title>');

  assert.equal(parseGenericPageHtml('<html><body>空页</body></html>', ''), null, '无标题且无正文 → null');
});

test('parseJinaPage：列表页（### 链接）', () => {
  const md = `Markdown Content:
### [项目一：某 200MW/400MWh 储能电站并网](https://example.com/a)
发布时间：2026-08-07
### [项目二：宁德时代发布新一代电池](https://example.com/b)
`;
  const items = parseJinaPage(md, '某官网');
  assert.equal(items.length, 2);
  assert.equal(items[0].title, '项目一：某 200MW/400MWh 储能电站并网');
  assert.equal(items[0].link, 'https://example.com/a');
});

test('parseJinaPage：单篇文章页（Title 块）', () => {
  const md = `Title: 公司简介
URL Source: https://example.com/about
Published Time: 2026-08-07T08:00:00+08:00
Markdown Content:
正文内容。
`;
  const [it] = parseJinaPage(md, '兜底标题');
  assert.equal(it.title, '公司简介');
  assert.equal(it.pubDate, '2026-08-07T00:00:00.000Z');
});

const WECHAT_HTML = `<!DOCTYPE html>
<html>
<head>
<meta property="og:title" content="【行业资讯】针对不同技术路线划定质量监督&quot;硬杠杠&quot;——让新型储能电站&quot;建得好、用得稳&quot;" />
<meta property="og:url" content="https://mp.weixin.qq.com/s/iOywr-9s1fWXlLcSzbLqFg" />
<meta property="og:type" content="article" />
<meta property="og:description" content="" />
</head>
<body>
<div id="js_article">
  <div id="js_name">中国化学与物理电源行业协会</div>
  <div id="publish_time"></div>
  <div id="js_content">
    <p>为落实新型储能发展要求，行业协会组织专家起草质量监督标准。</p>
    <p>该标准覆盖电芯、系统集成、并网运行等环节，将于年内发布。</p>
    <p><strong>关键数据：</strong>2026年预计新增装机 45GW。</p>
    <p>发布于 2026-05-26 14:39。</p>
  </div>
</div>
</body>
</html>`;

test('parseWechatArticleHtml：og:title + js_name + js_content + ISO 日期', () => {
  const it = parseWechatArticleHtml(WECHAT_HTML, '兜底');
  assert.ok(it);
  assert.ok(it.title.includes('让新型储能电站'), `标题含正文：${it.title}`);
  assert.equal(it.link, 'https://mp.weixin.qq.com/s/iOywr-9s1fWXlLcSzbLqFg');
  assert.equal(it.author, '中国化学与物理电源行业协会');
  assert.equal(it.pubDate, '2026-05-26T06:39:00.000Z', '2026-05-26 14:39+08:00 的 UTC');
  assert.ok(it.summary.length >= 30, `摘要应包含正文，实际 ${it.summary.length}`);
  assert.ok(it.summary.includes('45GW'), '摘要包含正文文本');
});

test('parseWechatArticleHtml：标题缺失用 fallbackTitle；js_content 处理嵌套 div', () => {
  const html = `<div id="js_name">某公众号</div>
  <div id="js_content">
    <div><p>外层段落：介绍储能系统集成的最新进展。</p><div><p>嵌套段落：内层补充说明关键数据。</p></div></div>
    <p>结束段：总结全文要点并展望后续发布计划。</p>
  </div>`;
  const it = parseWechatArticleHtml(html, '储能头条');
  assert.equal(it.title, '储能头条');
  assert.equal(it.author, '某公众号');
  assert.ok(it.summary.includes('外层段落') && it.summary.includes('嵌套段落') && it.summary.includes('结束段'),
    '嵌套 div 内的文本都保留');
});

test('parseWechatArticleHtml：空 js_content 且无标题 → null', () => {
  assert.equal(parseWechatArticleHtml('<html><body>Cloudflare 验证页</body></html>', ''), null);
});

test('fetchWechatSeeds：保留期内已抓取种子回填 items，清理 3 天前已抓取记录', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wechat-seed-'));
  const file = path.join(dir, 'wechat-articles.json');
  process.env.WECHAT_SEEDS_PATH = file;
  try {
    const oldAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const recentAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const seed = {
      version: '1.0.0', updatedAt: null,
      articles: [
        { sourceName: '旧源', url: 'https://mp.weixin.qq.com/s/old', addedAt: oldAt, fetched: true },
        {
          sourceName: '新源', url: 'https://mp.weixin.qq.com/s/recent', addedAt: recentAt, fetched: true,
          title: '某公众号文章', pubDate: '2026-08-09T00:00:00.000Z', summary: '正文摘要……'
        }
      ]
    };
    const items = await fetchWechatSeeds(seed);
    assert.equal(items.length, 1, '保留期内已抓取条目回填 items');
    assert.equal(items[0].title, '某公众号文章');
    assert.equal(items[0].link, 'https://mp.weixin.qq.com/s/recent');
    assert.equal(items[0].pubDate, '2026-08-09T00:00:00.000Z');
    assert.equal(items[0].summary, '正文摘要……');
    assert.equal(items[0].source, '新源');
    assert.equal(items[0].wechat, true, '回填条目带 wechat 标记');
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.articles.length, 1, '10 天前的已抓取记录被清理');
    assert.equal(saved.articles[0].sourceName, '新源');
    assert.ok(saved.updatedAt, '回写 updatedAt');
  } finally {
    await rm(dir, { recursive: true, force: true });
    delete process.env.WECHAT_SEEDS_PATH;
  }
});
