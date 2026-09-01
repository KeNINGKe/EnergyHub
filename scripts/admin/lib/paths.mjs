/**
 * 后台共享路径表。
 *
 * 写盘红线（见 docs/ADMIN.md）：本表只暴露允许后台写入的文件；
 * feeds/daily-v2.json、feeds/daily.json、feeds/featured.json 为只读，
 * 不提供写入口（只读文件不列在此处，需要时在 api 模块内以只读方式打开）。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '../../../');

export const PATHS = {
  // —— 可写：运营配置 ——
  sources: path.join(ROOT, 'data', 'sources.json'),
  enums: path.join(ROOT, 'data', 'enums.json'),
  filters: path.join(ROOT, 'data', 'filters.json'),
  sourceTypes: path.join(ROOT, 'data', 'source-types.json'),
  entities: path.join(ROOT, 'data', 'entities.json'),
  regions: path.join(ROOT, 'data', 'regions.json'),
  editorialOverrides: path.join(ROOT, 'data', 'editorial-overrides.json'),

  // —— 可写：人工内容 ——
  wechatSeeds: path.join(ROOT, 'feeds', 'wechat-articles.json'),
  deep: path.join(ROOT, 'feeds', 'deep.json'),

  // —— 可写：巡检产物（gitignored）——
  checkResults: path.join(ROOT, 'scripts', 'check-results.json'),

  // —— 只读：构建产物 ——
  dailyV2: path.join(ROOT, 'feeds', 'daily-v2.json'),
  dailyV1: path.join(ROOT, 'feeds', 'daily.json'),
  featured: path.join(ROOT, 'feeds', 'featured.json')
};

export const CONFIG_FILES = {
  enums: PATHS.enums,
  filters: PATHS.filters,
  'source-types': PATHS.sourceTypes,
  entities: PATHS.entities,
  regions: PATHS.regions,
  sources: PATHS.sources
};

/** 发布流归属的仓库（workflow dispatch 用）。 */
export const GITHUB_REPO = 'KeNINGKe/EnergyHub';
