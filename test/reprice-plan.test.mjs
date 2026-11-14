import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planReprice } from '../src/reprice-plan.mjs';

const details = {
  device: 'laptop', source: 'Codex CLI', usageDate: '2026-11-10', model: 'test-model',
  inputTokens: 2, outputTokens: 3, reasoningOutputTokens: 1,
  cacheReadTokens: 0, cacheCreationTokens: 0, totalTokens: 5
};
const first = { ...details, eventKey: 'first', eventTime: '2026-11-10T02:00:00Z',
  projectPath: '/app', costUSD: 2, costBasis: 'estimated', pricingVersion: 'old' };
const recorded = { ...first, eventKey: 'second', costUSD: 0, costBasis: 'recorded', pricingVersion: null };
const day = { ...details, inputTokens: 4, outputTokens: 6, reasoningOutputTokens: 2,
  totalTokens: 10, costUSD: 2, costBasis: 'mixed', pricingVersion: null };
const session = { ...day, projectPath: '/app', sessionId: 'local:codex:/app:test-model' };
const pricing = { version: 'new', litellm: {
  'test-model': { input_cost_per_token: 0.25, output_cost_per_token: 0.25 }
} };

test('重算完整日桶，保留记录的零费用且不重复计入 Codex reasoning', () => {
  const plan = planReprice({ daily: [day], time: [first, recorded], sessions: [session] }, pricing);
  assert.deepEqual(plan.next.time.map(row => [row.eventKey, row.costUSD, row.pricingVersion]), [['first', 1.25, 'new']]);
  assert.equal(plan.next.daily[0].costUSD, 1.25);
  assert.equal(plan.next.sessions[0].costUSD, 1.25);
});

test('跳过缺少明细、金额不符和无法验证原始费用来源的日桶', () => {
  for (const [daily, time, reason] of [
    [[day], [first], 'incompleteDetail'],
    [[{ ...day, costUSD: 5 }], [first, recorded], 'costMismatch'],
    [[day], [{ ...first, costBasis: 'legacy_unknown' }, recorded], 'noEligibleEvents']
  ]) {
    const plan = planReprice({ daily, time, sessions: [] }, pricing);
    assert.deepEqual(plan.next, { daily: [], time: [], sessions: [] });
    assert.equal(plan.skipped[reason], 1);
  }
});

test('按同一日内每条调用的渠道和时间分别重算', () => {
  const rule = {
    provider: 'vertex', model: 'test-model', enabled: true, offPeakStart: '00:00', offPeakEnd: '06:00',
    peak: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
    offPeak: { input: 500_000, output: 0, cacheRead: 0, cacheWrite: 0 }
  };
  const times = [
    { ...first, provider: 'vertex', eventTime: '2026-11-10T01:00:00Z', pricingTime: '2026-11-09T17:00:00Z' },
    { ...first, eventKey: 'second', provider: 'vertex', eventTime: '2026-11-10T01:00:00Z' }
  ];
  const plan = planReprice({ daily: [{ ...day, costUSD: 4 }], time: times, sessions: [] },
    { ...pricing, policy: { timeZone: 'Asia/Shanghai', defaults: [], rules: [rule] } });
  assert.deepEqual(plan.next.time.map(row => row.costUSD), [1, 2]);
  assert.equal(plan.next.daily[0].costUSD, 3);
});
