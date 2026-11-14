import { zonedParts } from './timezone.mjs';

export const deepSeekApiSchedule = 'deepseek-api';

// 中国政府网公布的 2026、2027 年放假日期。DeepSeek 的周末全天为谷时。
// https://www.gov.cn/gongbao/2025/issue_12406/material/gwygb202532.pdf
// https://www.gov.cn/zhengce/content/202611/content_7085101.htm
const holidays = [
  ['2026-01-01', '2026-01-03'], ['2026-02-15', '2026-02-23'],
  ['2026-04-04', '2026-04-06'], ['2026-05-01', '2026-05-05'],
  ['2026-06-19', '2026-06-21'], ['2026-09-25', '2026-09-27'],
  ['2026-10-01', '2026-10-07'], ['2027-01-01', '2027-01-03'],
  ['2027-02-05', '2027-02-13'], ['2027-04-03', '2027-04-05'],
  ['2027-05-01', '2027-05-05'], ['2027-06-09', '2027-06-09'],
  ['2027-09-15', '2027-09-15'], ['2027-10-01', '2027-10-07']
];

export function deepSeekApiRates(rule, eventTime) {
  const local = zonedParts(eventTime, 'Asia/Shanghai');
  if (!local || (rule.effectiveFrom && local.date < rule.effectiveFrom)) return null;
  const weekday = new Date(local.date).getUTCDay();
  const inPeakHours = (local.hour >= 9 && local.hour < 12) || (local.hour >= 14 && local.hour < 18);
  const isHoliday = holidays.some(([start, end]) => start <= local.date && local.date <= end);
  return weekday >= 1 && weekday <= 5 && inPeakHours && !isHoliday ? rule.peak : rule.offPeak;
}
