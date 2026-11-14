import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startServer, event, usage } from '../test/helpers/server.mjs';

// A real built frontend and isolated backend; no personal database, credentials
// or vendor quota calls. Fixed time crosses the UTC/Shanghai month boundary.
const app = await startServer({}, { staticDir: 'dist' });
let browser;
try {
  const time = Array.from({ length: 51 }, (_, index) => event({ usageDate: '2026-10-01', eventKey: `browser-${index}`,
    eventTime: new Date(Date.parse('2026-09-30T17:00:00Z') + index * 60_000).toISOString() }));
  assert.equal((await app.ingest({ time, daily: [
    usage({ usageDate: '2026-10-01', inputTokens: 5100, outputTokens: 510, totalTokens: 5610, costUSD: 51 }),
    usage({ usageDate: '2026-09-30' }), usage({ usageDate: '2026-09-20', inputTokens: 200, outputTokens: 20, totalTokens: 220 })
  ] })).status, 200);
  browser = await chromium.launch();
  const context = await browser.newContext({ timezoneId: 'UTC', viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  // External fonts are irrelevant to behavior and should not make CI depend on Google.
  await context.route('https://fonts.**', route => route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  // Keep time advancing: resize debouncers rely on elapsed Date.now().
  await page.clock.install({ time: new Date('2026-09-30T18:00:00Z') });
  const pageErrors = [], requests = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => requests.push(request.url()));
  let configFailure = true;
  await page.route('**/api/config', route => configFailure ? (configFailure = false, route.fulfill({ status: 503, body: '{}' })) : route.continue());
  await page.goto(app.base);
  await page.getByRole('alert').filter({ hasText: '展示配置加载失败' }).waitFor();
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.getByRole('heading', { name: 'Token Studio', exact: true }).waitFor();
  await page.getByText('时间（Asia/Shanghai）', { exact: true }).waitFor();
  assert.match(await page.locator('.dt-range-trigger').innerText(), /2026-10-01/);
  assert.ok(!requests.some(url => /\/ReviewApp-.*\.js/.test(url)), 'dashboard must not load the review bundle');

  const total = page.locator('.kpi').first().locator('.visually-hidden');
  const expectTotal = value => page.waitForFunction(value => document.querySelector('.kpi .visually-hidden')?.textContent === value, value);
  // 用量固定显示为M，校验原始5940个token对应的百万单位值。
  await expectTotal('0.00594 M');
  // Deliver an older request after a newer range is already rendered.
  let releaseOld, oldStarted;
  const started = new Promise(resolve => { oldStarted = resolve; });
  const held = new Promise(resolve => { releaseOld = resolve; });
  const delayed = async route => {
    if (new URL(route.request().url()).searchParams.get('startDate') === '2026-09-18') {
      const response = await route.fetch(); oldStarted(); await held;
      await route.fulfill({ response }).catch(() => {});
    } else await route.continue();
  };
  await page.route('**/api/data?**', delayed);
  await page.getByRole('button', { name: '7 天', exact: true }).click();
  await started;
  const cancelledOld = page.waitForEvent('requestfailed', { predicate: request => request.url().includes('/api/data?') && new URL(request.url()).searchParams.get('startDate') === '2026-09-18' });
  const newerResponse = page.waitForResponse(response => response.url().includes('/api/data?') && new URL(response.url()).searchParams.get('startDate') === '2026-09-04');
  await page.getByRole('button', { name: '14 天', exact: true }).click();
  await Promise.all([newerResponse, cancelledOld]);
  await expectTotal('0.00594 M'); releaseOld();
  await page.unroute('**/api/data?**', delayed);
  assert.equal(await total.textContent(), '0.00594 M');

  await page.getByRole('button', { name: '今天', exact: true }).click();
  await expectTotal('0.00561 M');
  let summaryFailure = true;
  await page.route('**/api/time/summary?**', route => summaryFailure ? (summaryFailure = false, route.fulfill({ status: 503, body: '{}' })) : route.continue());
  await page.locator('.dt-range-trigger').click();
  if (!(await page.locator('.dt-title').innerText()).includes('2026年10月')) await page.locator('.dt-nav').last().click();
  assert.equal(await page.locator('.dt-title').innerText(), '2026年10月');
  const day = page.locator('.dt-day:not(.muted)').filter({ hasText: /^1$/ });
  await day.click(); await day.click();
  await page.getByRole('button', { name: '重试统计' }).click();
  await expectTotal('0.00561 M');
  const summaryUrl = new URL(requests.filter(url => url.includes('/api/time/summary?')).at(-1));
  assert.equal(summaryUrl.searchParams.get('start'), '2026-09-30T16:00:00.000Z');
  assert.equal(summaryUrl.searchParams.get('end'), '2026-10-01T15:59:00.000Z');

  await page.locator('.table-panel tbody tr').first().click();
  const details = page.getByRole('region', { name: '事件明细' });
  await details.getByText('第 1 页 · 本页 50 条').waitFor();
  assert.equal(await details.locator('tbody tr').count(), 50);
  assert.equal(await details.locator('tbody tr').first().locator('td').first().innerText(), '2026-10-01 01:00');
  let detailFailure = true;
  await page.route('**/api/time?**', route => detailFailure ? (detailFailure = false, route.fulfill({ status: 503, body: '{}' })) : route.continue());
  await details.getByRole('button', { name: '下一页' }).click();
  await details.getByRole('button', { name: '重试明细' }).click();
  await details.getByText('第 2 页 · 本页 1 条').waitFor();
  assert.equal(await details.locator('tbody tr').count(), 1);
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.locator('.export-menu summary').click();
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('button', { name: '用量明细', exact: true }).click();
  const download = await downloadReady;
  const csv = await readFile(await download.path(), 'utf8');
  assert.equal(csv.trim().split('\n').length, 52);
  assert.equal(new URL(download.url()).searchParams.get('start'), summaryUrl.searchParams.get('start'));

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.filterbar').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth).catch(async error => {
    console.error(await page.evaluate(() => [...document.querySelectorAll('body *')].filter(node => node.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 15).map(node => ({ tag: node.tagName, class: node.className, width: node.getBoundingClientRect().width, right: node.getBoundingClientRect().right }))));
    throw error;
  });
  await page.getByRole('link', { name: '复盘', exact: true }).click();
  await page.locator('.period-current').filter({ hasText: '2026 年 10 月 · Asia/Shanghai' }).waitFor();
  await page.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth).catch(async error => {
    console.error(await page.evaluate(() => [...document.querySelectorAll('body *')].filter(node => node.getBoundingClientRect().right > innerWidth + 1)
      .slice(0, 12).map(node => ({ tag: node.tagName, class: node.className, width: node.getBoundingClientRect().width, right: node.getBoundingClientRect().right }))));
    throw error;
  });
  assert.deepEqual(pageErrors, []);
  await context.close();

  // A failed optional chart chunk must leave controls usable and offer recovery.
  const chartPage = await browser.newPage({ reducedMotion: 'reduce' });
  chartPage.setDefaultTimeout(15_000);
  await chartPage.clock.install({ time: new Date('2026-09-30T18:00:00Z') });
  await chartPage.route('https://fonts.**', route => route.abort());
  await chartPage.route('**/chart-runtime-*.js', route => route.abort());
  await chartPage.goto(app.base + '/review');
  await chartPage.locator('.donut-wrap').scrollIntoViewIfNeeded();
  const retryChart = chartPage.getByRole('button', { name: '图表加载失败，重新加载页面' }).first();
  await retryChart.waitFor();
  await chartPage.unroute('**/chart-runtime-*.js');
  await Promise.all([chartPage.waitForEvent('load'), retryChart.click()]);
  await chartPage.locator('.donut-wrap').scrollIntoViewIfNeeded();
  await chartPage.locator('canvas').first().waitFor();
  await chartPage.close();

  const legacy = usage({ source: 'Pi Agent', usageDate: '2026-10-27', model: 'deepseek-v4.1-flash-1017',
    costBasis: 'recorded', costUSD: 0 });
  assert.equal((await app.ingest({ daily: [legacy], time: [event({ ...legacy, eventTime: '2026-10-27T12:00:00Z' })] })).status, 200);
  const saved = await fetch(app.base + '/api/pricing', { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ timeZone: 'Asia/Shanghai', rules: [],
      defaults: [{ model: legacy.model, rates: { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 } }] }),
    signal: AbortSignal.timeout(5000) });
  assert.equal(saved.status, 200);
  const pricing = await browser.newPage();
  pricing.setDefaultTimeout(15_000);
  await pricing.route('https://fonts.**', route => route.abort());
  await pricing.goto(app.base + '/pricing');
  await pricing.getByLabel('开始日期').fill(legacy.usageDate);
  await pricing.getByLabel('结束日期').fill(legacy.usageDate);
  await pricing.getByLabel('仅补算旧版 Pi Agent 的零金额').check();
  assert.equal(await pricing.getByRole('button', { name: '预览差额' }).isDisabled(), true);
  await pricing.getByLabel('模型 ID', { exact: true }).last().fill(legacy.model);
  await pricing.getByRole('button', { name: '预览差额' }).click();
  await pricing.getByText('+$0.10', { exact: true }).waitFor();
  await pricing.getByRole('button', { name: '确认重算' }).click();
  await pricing.getByRole('status').filter({ hasText: '重算完成' }).waitFor();

  const official = { ...legacy, usageDate: '2026-10-28' };
  assert.equal((await app.ingest({ daily: [official], time: [event({ ...official, eventKey: 'off-peak',
    eventTime: '2026-10-28T04:00:00Z' })] })).status, 200);
  await pricing.getByRole('button', { name: '添加渠道规则' }).click();
  const editor = pricing.getByRole('region', { name: '渠道峰谷价' });
  await editor.getByLabel('Provider', { exact: true }).fill('official-reference');
  await editor.getByLabel('模型 ID', { exact: true }).fill(`deepseek/${official.model}`);
  await editor.getByLabel('启用峰谷价').check();
  await editor.getByRole('button', { name: '套用 DeepSeek 官方时段' }).click();
  const officialRule = editor.locator('.pricing-entry').filter({ has: pricing.locator('input[value="official-reference"]') });
  assert.equal(await officialRule.getByLabel('计价时区').inputValue(), 'Asia/Shanghai');
  assert.equal(await officialRule.getByLabel('峰时开始').count(), 2);
  await officialRule.getByLabel('峰时开始').nth(1).fill('13:30');

  await editor.getByRole('button', { name: '添加渠道规则' }).click();
  const customRule = editor.locator('.pricing-entry').last();
  await customRule.getByLabel('Provider', { exact: true }).fill('aliyun-token-plan');
  await customRule.getByLabel('模型 ID', { exact: true }).fill(official.model);
  await customRule.getByLabel('启用峰谷价').check();
  await customRule.getByLabel('计价时区').fill('UTC');
  await customRule.getByRole('button', { name: '添加峰时时段' }).click();
  await customRule.getByLabel('峰时开始').fill('08:00');
  await customRule.getByLabel('峰时结束').fill('22:00');
  for (const title of ['峰价', '谷价']) {
    const prices = customRule.getByRole('group', { name: title, exact: true });
    for (const label of ['输入', '输出', '缓存读取', '缓存写入']) await prices.getByLabel(label, { exact: true }).fill('0.5');
  }
  await pricing.getByRole('button', { name: '保存价格规则' }).click();
  await pricing.getByText('价格规则已保存。', { exact: true }).waitFor();
  await pricing.reload();
  assert.equal(await officialRule.getByLabel('峰时开始').nth(1).inputValue(), '13:30');
  assert.equal(await customRule.getByLabel('计价时区').inputValue(), 'UTC');
  const preview = pricing.getByRole('region', { name: '历史费用重算' });
  await preview.getByLabel('开始日期').fill(official.usageDate);
  await preview.getByLabel('结束日期').fill(official.usageDate);
  await preview.getByLabel('模型 ID').fill(official.model);
  const repriceRoute = '**/api/pricing/reprice';
  const failPreview = route => route.fulfill({ status: 502, contentType: 'text/html', body: '<html>Bad Gateway</html>' });
  await pricing.route(repriceRoute, failPreview);
  await preview.getByRole('button', { name: '预览差额' }).click();
  await preview.getByRole('alert').filter({ hasText: '重算请求失败（HTTP 502）' }).waitFor();
  await pricing.unroute(repriceRoute, failPreview);
  await preview.getByLabel('仅补算旧版 Pi Agent 的零金额').check();
  await preview.getByLabel('缺少 Provider 时使用的参考价').selectOption('official-reference');
  await preview.getByRole('button', { name: '预览差额' }).click();
  await preview.getByText('+$0.000021', { exact: true }).waitFor();
  await pricing.close();
  console.log('Browser smoke passed: timezone, config retry, stale response, precise summary, detail pagination/retry, CSV, mobile, review, chart recovery, pricing preview and apply.');
} finally {
  await browser?.close();
  await app.close();
}
