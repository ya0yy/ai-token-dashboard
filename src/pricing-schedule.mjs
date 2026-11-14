import { deepSeekApiSchedule, deepSeekSchedulePreset } from './deepseek-schedule.mjs';

export const allDays = [0, 1, 2, 3, 4, 5, 6];

export function editableSchedule(rule, timeZone) {
  if (rule.peakPeriods) return {
    timeZone: rule.timeZone, peakPeriods: rule.peakPeriods, offPeakDates: rule.offPeakDates ?? []
  };
  if (rule.schedule === deepSeekApiSchedule) return deepSeekSchedulePreset;
  // 单段谷时的补集是一段峰时，反转端点即可保留原有计费行为。
  return { timeZone, peakPeriods: [{ days: allDays, start: rule.offPeakEnd, end: rule.offPeakStart }], offPeakDates: [] };
}

export function isPeakTime({ peakPeriods, offPeakDates = [] }, local) {
  if (offPeakDates.some(range => {
    const [start, end = start] = range.split('..');
    return start <= local.date && local.date <= end;
  })) return false;

  const day = new Date(local.date).getUTCDay();
  const minute = local.hour * 60 + local.minute;
  return peakPeriods.some(period => {
    const start = clockMinute(period.start);
    const end = clockMinute(period.end);
    if (start < end) return period.days.includes(day) && start <= minute && minute < end;
    // 跨午夜时，星期指时段开始的那天。
    return (minute >= start && period.days.includes(day))
      || (minute < end && period.days.includes((day + 6) % 7));
  });
}

function clockMinute(time) {
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
}
