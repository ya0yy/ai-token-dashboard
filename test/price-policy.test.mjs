import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCost } from '../src/pricing.mjs';

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
