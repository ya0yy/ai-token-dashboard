import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCost } from '../src/pricing.mjs';
import { validatePricingPolicy } from '../src/pricing-config.mjs';

const rates = input => ({ input, output: 0, cacheRead: 0, cacheWrite: 0 });
const rule = {
  provider: 'vertex', model: 'example', enabled: true,
  peak: rates(10), offPeak: rates(4), offPeakStart: '23:30', offPeakEnd: '06:15',
  effectiveFrom: '2026-11-01'
};
const pricing = {
  policy: { timeZone: 'Asia/Shanghai', defaults: [{ model: 'example', rates: rates(8) }], rules: [rule] },
  litellm: { example: { input_cost_per_token: 0.000002 } }
};
const cost = (time, provider = 'vertex', data = pricing) =>
  calculateCost('example', { input: 1_000_000 }, data, provider, { eventTime: time });

test('峰谷价按规则时区跨午夜，起点包含、终点不包含', () => {
  assert.equal(cost('2026-11-01T15:29:59Z'), 10);
  assert.equal(cost('2026-11-01T15:30:00Z'), 4);
  assert.equal(cost('2026-11-01T22:14:59Z'), 4);
  assert.equal(cost('2026-11-01T22:15:00Z'), 10);
});

test('未知渠道、缺少调用时间及停用规则使用统一价', () => {
  assert.equal(cost('2026-11-01T16:00:00Z', null), 8);
  assert.equal(cost('2026-11-01T16:00:00Z', 'anthropic'), 8);
  assert.equal(cost(null), 8);
  assert.equal(cost('2026-10-31T15:30:00Z'), 8);
  assert.equal(cost('2026-11-01T16:00:00Z', 'vertex', {
    ...pricing, policy: { ...pricing.policy, rules: [{ ...rule, enabled: false }] }
  }), 8);
});

test('同一模型按各渠道独立的时区、星期和时段计价', () => {
  const base = { model: 'example', enabled: true, peak: rates(10), offPeak: rates(4) };
  const data = { policy: validatePricingPolicy({
    timeZone: 'UTC', defaults: [{ model: 'example', rates: rates(8) }],
    rules: [
      { ...base, provider: 'deepseek-official', timeZone: 'Asia/Shanghai',
        peakPeriods: [{ days: [2], start: '09:00', end: '12:00' }, { days: [2], start: '14:00', end: '18:00' }],
        offPeakDates: ['2026-11-10'] },
      { ...base, provider: 'aliyun-token-plan', timeZone: 'America/Los_Angeles',
        peakPeriods: [{ days: [1], start: '16:00', end: '02:00' }] }
    ]
  }) };
  assert.equal(cost('2026-11-03T01:00:00Z', 'deepseek-official', data), 10);
  assert.equal(cost('2026-11-03T04:00:00Z', 'deepseek-official', data), 4);
  assert.equal(cost('2026-11-03T06:00:00Z', 'deepseek-official', data), 10);
  assert.equal(cost('2026-11-10T01:00:00Z', 'deepseek-official', data), 4);
  assert.equal(cost('2026-11-03T09:59:59Z', 'aliyun-token-plan', data), 10);
  assert.equal(cost('2026-11-03T10:00:00Z', 'aliyun-token-plan', data), 4);
  assert.equal(cost('2026-11-03T09:59:59Z', 'Aliyun-token-plan', data), 8);
});
