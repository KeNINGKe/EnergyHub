#!/usr/bin/env node
/**
 * RSS 抓取脚本 — V1 日报（保留兼容，V2 构建器用 scripts/build-daily-v2.mjs）
 * 读取 data/sources.json 中所有 rss 字段，并行抓取，生成 feeds/daily.json（V1 格式）
 * 用法:
 *   node scripts/fetch-rss.mjs
 */
import fs from 'node:fs/promises';
import {
  toISODate, withinDays, loadSources, collectFeeds, fetchAllFeeds, translateTitles
} from './lib/fetch.mjs';

// 严格主题白名单：必须与 发电/储能/AIDC/电力解决方案 相关（V1 旧版过滤器）
const ENERGY_KEYWORDS = [
  '电力', '电网', '电能', '发电', '能源', '新能源', '可再生能源', '清洁能源', '绿电', '绿证',
  '储能', '电池', '锂电池', '锂电', '动力电池', '储能电池', '固态电池', '钠离子',
  '燃料电池', '氢能', '氢', '电解槽', '绿氢', '灰氢',
  '光伏', '太阳能', '风电', '风能', '核电', '核能', '反应堆', '铀', '水电', '煤电', '气电', '火电',
  '天然气', '石油', '油气', '煤炭', '生物质',
  '双碳', '碳中和', '碳达峰', '碳市场', '碳交易', '碳排放', '气候变化', '温室气体', '甲烷', 'CCUS', '碳捕集',
  '数据中心', '算力', '智算', '超算', '服务器', 'GPU', 'AI芯片', '芯片', '半导体', '晶圆', 'DRAM', 'HBM',
  '液冷', 'PUE', 'UPS', '不间断电源', '电动车', '电动汽车', 'EV', '充电桩',
  '逆变器', '组件', '硅料', '硅片', '源网荷储', '虚拟电厂', '微电网', '特高压', '变电站', '变压器',
  '固态变压器', '电力电子变压器', '储能变流器', '储能逆变器', '构网', '柔性直流', '换流阀', '换流器',
  '直流配电', '中压直流', '中压电力电子', '功率半导体', '功率器件', '碳化硅', '氮化镓', '宽禁带',
  'IGBT', 'SiC', 'GaN', 'MVDC', 'STATCOM',
  'solid-state transformer', 'power electronic transformer', 'grid-forming', 'grid forming',
  'energy storage converter', 'power conversion system', 'battery inverter', 'wide bandgap',
  '输配电', '智能电网', '负荷', '调度', '备用电源', '电力市场', '辅助服务', '现货市场',
  '抽水蓄能', '电化学储能', '光储', '风储', '氢储', 'BESS',
  'power', 'grid', 'electricity', 'electric', 'energy', 'renewable', 'clean energy',
  'generation', 'generator', 'turbine', 'solar', 'PV', 'wind', 'nuclear', 'reactor', 'uranium', 'hydro', 'coal', 'gas', 'biomass',
  'storage', 'battery', 'batteries', 'lithium', 'solid-state', 'sodium-ion', 'sodium ion',
  'fuel cell', 'hydrogen', 'electrolyzer', 'electrolyser', 'green hydrogen',
  'data center', 'datacenter', 'compute', 'AI chip', 'GPU', 'semiconductor', 'wafer', 'DRAM', 'HBM',
  'liquid cooling', 'PUE', 'UPS', 'EV', 'charging', 'inverter', 'module', 'panel', 'cell',
  'silicon', 'virtual power plant', 'microgrid', 'HVDC', 'transformer', 'substation', 'transmission', 'distribution',
  'load', 'dispatch', 'backup power', 'electricity market', 'ancillary services', 'demand response',
  'pumped hydro', 'BESS', 'solar-plus-storage', 'solar plus storage', 'wind-storage', 'hydrogen storage',
  'carbon', 'net zero', 'carbon neutral', 'emissions', 'green certificate', 'carbon capture',
  'PPA', 'power purchase', 'power purchase agreement', 'offtake', 'energy procurement', 'carbon-free energy',
  'renewable energy procurement', 'data centre', 'datacenter', 'hyperscale', 'supercomputer', 'supercomputing',
  'cluster', 'AI infrastructure', 'AI data center', 'foundry', 'sovereign cloud', 'edge data center',
  'interconnection', 'grid interconnection', 'capacity', 'MW', 'megawatt', 'GW', 'gigawatt', 'TW', 'terawatt',
  'Stargate', 'Project Stargate', 'power plant', 'power station', 'cooling', 'liquid cooling', 'water usage',
  'water efficiency', 'energy efficiency',
  '电力需求', '算电协同', '算力中心', '智算中心', '超算中心', '购电协议', '电力采购', '绿电采购', '能源采购',
  '并网', '电力容量', '兆瓦', '万千瓦', '吉瓦', '亿千瓦', '太瓦', '星门', '液冷', '水冷', '能耗', 'PUE', '能源效率',
  '基础设施'
];

function matchesKeyword(text, k) {
  const lowerK = k.toLowerCase();
  if (/[一-鿿]/.test(lowerK)) return text.includes(lowerK);
  const words = lowerK.split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = `\\b${words.join('\\b\\s+\\b')}\\b`;
  return new RegExp(pattern, 'i').test(text);
}

function isEnergyRelevant(item) {
  const text = `${item.title || ''} ${item.summary || ''}`.toLowerCase();
  return ENERGY_KEYWORDS.some(k => matchesKeyword(text, k));
}

async function main() {
  const now = new Date();
  const data = await loadSources();
  const feeds = collectFeeds(data);
  console.log(`\n发现 ${feeds.length} 个 RSS 源\n`);

  const { items: allItems, succeeded, total } = await fetchAllFeeds(feeds);

  // 链接/标题去重
  const seenLinks = new Set();
  const uniqueItems = [];
  for (const item of allItems) {
    const key = item.link || item.title;
    if (seenLinks.has(key)) continue;
    seenLinks.add(key);
    uniqueItems.push(item);
  }

  // 严格主题过滤（V1）
  const beforeFilter = uniqueItems.length;
  const filtered = uniqueItems.filter(isEnergyRelevant);
  console.log(`\n过滤后: ${filtered.length}/${beforeFilter} 条（去除 ${beforeFilter - filtered.length} 条无关内容）`);

  // 按发布时间倒序
  filtered.sort((a, b) => {
    const ta = a.pubDate ? new Date(a.pubDate).getTime() : 0;
    const tb = b.pubDate ? new Date(b.pubDate).getTime() : 0;
    return tb - ta;
  });

  // 翻译英文标题
  await translateTitles(filtered);

  const dailyItems = filtered.filter(i => withinDays(i.pubDate, 1, now));
  const daily = {
    mode: 'daily',
    date: toISODate(now),
    generatedAt: now.toISOString(),
    totalSources: total,
    successSources: succeeded,
    count: dailyItems.length,
    items: dailyItems
  };
  await fs.writeFile('feeds/daily.json', JSON.stringify(daily, null, 2) + '\n');
  console.log(`\n✅ 日报已生成: ${dailyItems.length} 条 (来源 ${succeeded}/${total})`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
