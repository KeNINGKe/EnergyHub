import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadEnums, validateDailyV2, validateFeatured } from '../scripts/lib/schema.mjs';
import { loadFilters } from '../scripts/lib/filter.mjs';
import { loadSourceTypes, loadSourceMap } from '../scripts/lib/source.mjs';
import {
  processItems, selectFeatured, selectHot, atomicWrite, resolveReplayNow, ensureNonEmptyBuild
} from '../scripts/build-daily-v2.mjs';

const enums = await loadEnums();
const filters = await loadFilters();
const sourceTypes = await loadSourceTypes();
const { byName: sourceMap } = await loadSourceMap();
const NOW = new Date('2026-08-05T04:00:00Z');

function raw(over = {}) {
  return {
    title: '', link: '', guid: null, pubDate: '2026-08-05T01:00:00Z',
    summary: '', source: 'pv magazine', translatedTitle: null, ...over
  };
}

/* selectFeatured 用例统一：事件带新鲜发布时间，now 显式传入保证确定性 */
const FNOW = '2026-08-10T04:00:00Z';
const FPUB = '2026-08-09T12:00:00Z'; // now 前 16h，远在 72h 窗口内
const FSELECT = { now: FNOW };

test('resolveReplayNow：优先使用样本生成时间，缺失时回退到当日末尾', () => {
  assert.equal(resolveReplayNow('2026-08-05', '2026-08-05T06:30:00Z').toISOString(), '2026-08-05T06:30:00.000Z');
  assert.equal(resolveReplayNow('2026-08-05', null).toISOString(), '2026-08-05T15:59:59.000Z');
});

test('ensureNonEmptyBuild：正式构建零事件失败，dry-run 允许空结果', () => {
  assert.throws(() => ensureNonEmptyBuild({ raw: 20, events: 0 }), /0 个事件/);
  assert.doesNotThrow(() => ensureNonEmptyBuild({ raw: 20, events: 0 }, { dryRun: true }));
  assert.doesNotThrow(() => ensureNonEmptyBuild({ raw: 20, events: 1 }));
});

test('selectFeatured：门槛与多样性', () => {
  const mk = (id, importance, topic, source) => ({ id, importance, topic, source: { name: source }, publishedAt: FPUB });
  const events = [
    mk('evt_a', 4, 'grid', 'S1'),
    mk('evt_b', 3.5, 'grid', 'S2'),
    mk('evt_c', 3.5, 'solar-wind', 'S3'),
    mk('evt_d', 2, 'grid', 'S4') // 低于门槛 2.5
  ];
  const { featuredEventIds } = selectFeatured(events, enums, FSELECT);
  assert.ok(!featuredEventIds.includes('evt_d'), '低门槛事件不入精选');
  assert.ok(featuredEventIds.includes('evt_a') && featuredEventIds.includes('evt_c'));
});

test('selectFeatured：同主题最多 2 条', () => {
  const mk = (id, importance, topic) => ({ id, importance, topic, source: { name: 'S' + id }, publishedAt: FPUB });
  const events = [
    mk('evt_a', 4, 'grid', 'S1'), mk('evt_b', 4, 'grid', 'S2'), mk('evt_c', 4, 'grid', 'S3'),
    mk('evt_d', 4, 'solar-wind', 'S4')
  ];
  const { featuredEventIds } = selectFeatured(events, enums, FSELECT);
  assert.equal(featuredEventIds.filter(id => events.find(e => e.id === id).topic === 'grid').length, 2);
});

test('selectFeatured：同来源最多 2 条', () => {
  const mk = (id, importance, topic) => ({ id, importance, topic, source: { name: 'SameSrc' }, publishedAt: FPUB });
  const events = [
    mk('evt_a', 4, 'grid'), mk('evt_b', 4, 'solar-wind'), mk('evt_c', 4, 'energy-storage'),
    mk('evt_d', 4, 'aidc-project')
  ];
  const { featuredEventIds } = selectFeatured(events, enums, FSELECT);
  assert.equal(featuredEventIds.length, 2, '同来源第 3 条被配额挡掉');
});

test('selectFeatured：72h 时效窗口，旧文章不进精选', () => {
  const mk = (id, importance, topic, publishedAt) => ({ id, importance, topic, source: { name: 'S' + id }, publishedAt });
  const events = [
    mk('evt_old', 4.5, 'grid', '2026-06-30T12:00:00Z'),      // 40 天前，分再高也不进
    mk('evt_edge', 4, 'solar-wind', '2026-08-07T04:00:01Z'), // 恰好在 72h 内
    mk('evt_out', 4, 'energy-storage', '2026-08-07T03:59:00Z'), // 刚好超出 72h
    mk('evt_nodate', 4, 'aidc-project', null)                // 无日期不进精选
  ];
  const { featuredEventIds } = selectFeatured(events, enums, FSELECT);
  assert.ok(!featuredEventIds.includes('evt_old'), '超过时效窗口的旧文章被排除');
  assert.ok(!featuredEventIds.includes('evt_out'), '刚好超出 72h 的被排除');
  assert.ok(!featuredEventIds.includes('evt_nodate'), '无日期事件不进精选');
  assert.ok(featuredEventIds.includes('evt_edge'), '窗口内的正常入选');
});

test('selectFeatured：微信文章保底 1 条，跨过主题/来源配额', () => {
  const mk = (id, importance, topic, source, wechat) => ({ id, importance, topic, source: { name: source }, wechat: wechat || false, publishedAt: FPUB });
  // energy-storage 主题已满 2 条（a/b），微信事件 w 同主题且同来源仍应保底入选
  const events = [
    mk('evt_a', 4, 'energy-storage', 'S1'),
    mk('evt_b', 4, 'energy-storage', 'S2'),
    mk('evt_w', 3, 'energy-storage', '微信源', true)
  ];
  const { featuredEventIds } = selectFeatured(events, enums, FSELECT);
  assert.ok(featuredEventIds.includes('evt_w'), '微信事件跨过主题配额保底入选');
});

test('selectFeatured：微信保底也受时效窗口约束', () => {
  const mk = (id, importance, topic, source, wechat, publishedAt) => ({ id, importance, topic, source: { name: source }, wechat: wechat || false, publishedAt });
  const events = [
    mk('evt_a', 4, 'grid', 'S1', false, FPUB),
    mk('evt_w', 3, 'energy-storage', '微信源', true, '2026-07-01T00:00:00Z') // 旧文章
  ];
  const { featuredEventIds } = selectFeatured(events, enums, FSELECT);
  assert.ok(!featuredEventIds.includes('evt_w'), '旧微信文章不因保底破例进精选');
});

test('selectFeatured：微信保底超配额后回归常规规则', () => {
  const mk = (id, importance, topic, source, wechat) => ({ id, importance, topic, source: { name: source }, wechat: wechat || false, publishedAt: FPUB });
  // 主题已满 2 条（a/b），wechatQuota 用尽（0），第三条同主题 wechat 不再保底
  const events = [
    mk('evt_a', 4, 'grid', 'S1'),
    mk('evt_b', 4, 'grid', 'S2'),
    mk('evt_w', 3, 'grid', '微信源', true)
  ];
  const { featuredEventIds } = selectFeatured(events, enums, { ...FSELECT, wechatQuota: 0 });
  assert.ok(!featuredEventIds.includes('evt_w'), 'wechatQuota=0 时微信事件受主题配额约束');
});

test('selectFeatured：微信事件排名靠后仍被预选保底（不受 maxFeatured 截断影响）', () => {
  const mk = (id, importance, topic, source, wechat) => ({ id, importance, topic, source: { name: source }, wechat: wechat || false, publishedAt: FPUB });
  // 10 个高重要性非微信事件足以填满 maxFeatured；微信事件重要性仅 3 排最后，仍应保底入选
  const events = [];
  for (let i = 0; i < 10; i++) events.push(mk('evt_a' + i, 4, i < 5 ? 'grid' : 'solar-wind', 'S' + i));
  events.push(mk('evt_w', 3, 'energy-storage', '微信源', true));
  const { featuredEventIds } = selectFeatured(events, enums, FSELECT);
  assert.ok(featuredEventIds.includes('evt_w'), '微信事件排名靠后也被预选保底');
});

test('selectFeatured：优先主题（SST/PCS）保底，跨过高分事件挤占', () => {
  const mk = (id, importance, topic, source, publishedAt) => ({ id, importance, topic, source: { name: source }, publishedAt });
  // 10 个高分 grid 事件足以挤满 featured；sst/pcs 各 1 条 ≥门槛 且 72h 内仍应保底入选
  const events = [];
  for (let i = 0; i < 10; i++) events.push(mk('evt_a' + i, 4, 'grid', 'S' + i, FPUB));
  events.push(mk('evt_sst', 3.5, 'sst', 'SST源', FPUB));
  events.push(mk('evt_pcs', 3.5, 'pcs', 'PCS源', FPUB));
  const { featuredEventIds } = selectFeatured(events, enums, FSELECT);
  assert.ok(featuredEventIds.includes('evt_sst'), 'sst 优先主题保底入选');
  assert.ok(featuredEventIds.includes('evt_pcs'), 'pcs 优先主题保底入选');
});

test('selectFeatured：今日观察取最终入选集的重要性前 3，而非选择过程的遇到顺序', () => {
  const mk = (id, importance, topic, source, wechat) => ({ id, importance, topic, source: { name: source }, wechat: wechat || false, publishedAt: FPUB });
  // 微信保底项（importance 3）最先被选入；两条 4 分大事件随后主选入选。
  // 观察位必须给 4 分事件，而不是按遇到顺序给微信保底项。
  const events = [
    mk('evt_w', 3, 'energy-storage', '微信源', true),
    mk('evt_hi1', 4, 'grid', 'S1'),
    mk('evt_hi2', 4, 'solar-wind', 'S2')
  ];
  const { observations } = selectFeatured(events, enums, FSELECT);
  assert.equal(observations.length, 3);
  assert.ok(observations.every(o => o.startsWith('【')), '观察条目带主题标签');
  assert.ok(!observations.some(o => o.includes('微信')), '低分保底项不占观察位');
  assert.equal(observations.filter(o => o.includes('电网与并网') || o.includes('光伏与风电')).length, 2, '高分事件进观察位');
});

test('selectFeatured：默认收紧到 12 条、门槛 3', () => {
  const mk = (id, importance, topic, source) => ({ id, importance, topic, source: { name: source }, publishedAt: FPUB });
  const events = [];
  for (let i = 0; i < 20; i++) events.push(mk('evt_a' + i, 4, i % 2 ? 'grid' : 'solar-wind', 'S' + i));
  events.push(mk('evt_low', 2.9, 'grid', 'SLow'));
  const { featuredEventIds } = selectFeatured(events, enums, FSELECT);
  assert.ok(featuredEventIds.length <= 12, `实际 ${featuredEventIds.length} 条`);
  assert.ok(!featuredEventIds.includes('evt_low'), '低于门槛 3 不入选');
});

test('selectHot：储能/AIDC 入榜、北美软加分、核电排除、上限生效', () => {
  const mk = (id, importance, topic, region, over = {}) => ({
    id, importance, topic, region,
    title: '', originalTitle: '', summary: '', entities: [],
    source: { name: 'S' + id }, publishedAt: FPUB, ...over
  });
  const events = [
    mk('evt_cn', 5, 'energy-storage', '中国'),                                 // 内容分最高 → 榜首
    mk('evt_us', 4, 'energy-storage', '美国'),                                 // 4 + 0.5 软加分
    mk('evt_eu', 4, 'energy-storage', '德国'),                                 // 4，同基础分输给北美
    mk('evt_nuke', 5, 'energy-storage', '美国', { title: '核电储能混合项目 nuclear' }),
    mk('evt_aidc', 3, 'aidc-project', '中国'),
    mk('evt_grid', 9, 'grid', '美国') // 非热点主题，不入榜
  ];
  const ids = selectHot(events, enums);
  assert.equal(ids[0], 'evt_cn', '高分中国事件压过低分北美事件（内容为主）');
  assert.equal(ids[1], 'evt_us', '同基础分时北美软加分靠前');
  assert.equal(ids[2], 'evt_eu');
  assert.ok(ids.includes('evt_aidc'));
  assert.ok(!ids.includes('evt_nuke'), '核电关键词排除');
  assert.ok(!ids.includes('evt_grid'), '非热点主题不入榜');
  assert.ok(ids.length <= (enums.hot?.maxItems ?? 5));
});

test('selectFeatured：优先主题保底仍要求 ≥threshold 与时效，低于门槛不入', () => {
  const mk = (id, importance, topic, source, publishedAt) => ({ id, importance, topic, source: { name: source }, publishedAt });
  const events = [
    mk('evt_old', 4, 'sst', 'S1', '2026-07-01T00:00:00Z'),   // 超时效，保底也不入
    mk('evt_low', 2, 'pcs', 'S2', FPUB),                       // 低于门槛，不入
    mk('evt_ok', 3, 'sst', 'S3', FPUB)                         // 合格，保底入
  ];
  const { featuredEventIds } = selectFeatured(events, enums, FSELECT);
  assert.ok(!featuredEventIds.includes('evt_old'), '超时效的优先主题事件不入精选');
  assert.ok(!featuredEventIds.includes('evt_low'), '低于门槛的优先主题事件不入精选');
  assert.ok(featuredEventIds.includes('evt_ok'), '合格的优先主题事件保底入选');
});

test('processItems：产出合法 daily + featured', async () => {
  const items = [
    raw({ title: '1GWh BESS 储能电站并网投运', link: 'https://a.com/1', summary: '某地 1GWh 电池储能并网', source: 'Energy Storage News' }),
    raw({ title: 'GPU 数据中心液冷系统发布', link: 'https://a.com/2', summary: 'AI 数据中心液冷 PUE 0.9', source: 'Data Center Dynamics' }),
    raw({ title: '某地 1GWh BESS 储能电站并网投运（重复标题）', link: 'https://a.com/3', summary: '重复报道', source: 'Electrek' }),
    raw({ title: '最新手机评测：折叠屏体验', link: 'https://a.com/4', summary: '消费电子评测', source: 'Electrek' })
  ];
  const { daily, featured, stats } = await processItems(items, {
    date: '2026-08-05', now: NOW, filters, enums, sourceTypes, sourceMap, overridesForDate: null
  });
  assert.equal(stats.filteredOut, 1, '手机评测被过滤');
  const v1 = await validateDailyV2(daily, enums);
  assert.equal(v1.valid, true, v1.errors.join('; '));
  const vf = await validateFeatured(featured, daily, enums);
  assert.equal(vf.valid, true, vf.errors.join('; '));
  assert.ok(daily.items.every(e => /^evt_[a-z0-9]{8,}$/.test(e.id)), '事件 ID 格式');
  assert.ok(daily.items.every(e => e.topic && enums.topicIds.has(e.topic)), '主题枚举合法');
});

test('processItems：来源类型参与评分，isPrimary 只标记一手来源', async () => {
  const items = [
    raw({
      title: '1 MW battery station alpha', link: 'https://a.com/primary',
      summary: 'battery project', source: 'NVIDIA Blog'
    }),
    raw({
      title: '900 GWh electrochemical facility omega', link: 'https://a.com/media',
      summary: 'energy storage system', source: 'Electrek'
    })
  ];
  const { daily } = await processItems(items, {
    date: '2026-08-05', now: NOW, filters, enums, sourceTypes, sourceMap, overridesForDate: null
  });
  const primary = daily.items.find(e => e.source.name === 'NVIDIA Blog');
  const media = daily.items.find(e => e.source.name === 'Electrek');
  assert.ok(primary && media, '两种来源均应保留为独立事件');
  assert.equal(primary.source.type, 'primary');
  assert.equal(primary.source.isPrimary, true);
  assert.equal(media.source.type, 'media');
  assert.equal(media.source.isPrimary, false);
  assert.equal(primary.importance - media.importance, 1, '一手来源应比同等媒体来源高 1 分');
});

test('processItems：全部动态排除 7 天前及未来文章', async () => {
  const items = [
    raw({ title: 'fresh battery storage project', link: 'https://a.com/fresh', pubDate: '2026-08-04T01:00:00Z' }),
    raw({ title: 'old solar power project', link: 'https://a.com/old', pubDate: '2026-07-20T01:00:00Z' }),
    raw({ title: 'future grid power project', link: 'https://a.com/future', pubDate: '2026-08-06T01:00:00Z' })
  ];
  const { daily, stats } = await processItems(items, {
    date: '2026-08-05', now: NOW, filters, enums, sourceTypes, sourceMap, overridesForDate: null
  });
  assert.deepEqual(daily.items.map(e => e.url), ['https://a.com/fresh']);
  assert.equal(stats.staleFiltered, 2);
});

test('processItems：确定性（同输入两次结果一致）', async () => {
  const items = [raw({ title: 'solar PPA signed', link: 'https://a.com/1', summary: 'renewable energy procurement deal' })];
  const ctx = { date: '2026-08-05', now: NOW, filters, enums, sourceTypes, sourceMap, overridesForDate: null };
  const r1 = await processItems(items, ctx);
  const r2 = await processItems(items, ctx);
  assert.deepEqual(r1.daily.items.map(e => e.id), r2.daily.items.map(e => e.id));
  assert.deepEqual(r1.daily.items[0], r2.daily.items[0]);
});

test('atomicWrite：校验失败不覆盖现有文件', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eih-'));
  const file = path.join(dir, 'x.json');
  await fs.writeFile(file, '{"old":true}');
  const bad = { schemaVersion: 2, items: 123 }; // 非法
  await assert.rejects(() => atomicWrite(file, bad, (d) => validateDailyV2(d, enums)));
  const after = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(after, { old: true }, '失败时旧文件保持不变');
  // 清理
  await fs.rm(dir, { recursive: true, force: true });
});

test('atomicWrite：校验通过则原子替换', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'eih-'));
  const file = path.join(dir, 'x.json');
  await fs.writeFile(file, '{"old":true}');
  const good = {
    schemaVersion: 2, date: '2026-08-05', generatedAt: '2026-08-05T04:00:00Z', status: 'ok',
    stats: { sourcesTotal: 0, sourcesSucceeded: 0, articlesFetched: 0, eventsPublished: 0 },
    items: []
  };
  await atomicWrite(file, good, (d) => validateDailyV2(d, enums));
  const after = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(after, good);
  await fs.rm(dir, { recursive: true, force: true });
});
