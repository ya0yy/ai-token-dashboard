import { useEffect, useState } from 'react';
import { ThemeToggle } from '../shared/ThemeToggle.jsx';
import { RepricePanel } from './RepricePanel.jsx';
import '../dashboard/styles.css';
import './pricing.css';

const fields = [
  ['input', '输入'], ['output', '输出'], ['cacheRead', '缓存读取'], ['cacheWrite', '缓存写入']
];
const blankRates = { input: '', output: '', cacheRead: '', cacheWrite: '' };
const pageSize = 8;
const amount = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 12 });

async function requestPricing(options) {
  const response = await fetch('/api/pricing', { signal: AbortSignal.timeout(15_000), ...options });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new Error(data?.error || `请求失败（HTTP ${response.status}）`);
  return data;
}

function RateFields({ title, rates, onChange }) {
  return (
    <fieldset className="pricing-rate-fields">
      <legend>{title}</legend>
      <div className="pricing-rates">
        {fields.map(([key, label]) => (
          <label key={key}>
            {label}
            <input required type="number" min="0" step="any" value={rates[key]}
              onChange={event => onChange({ ...rates, [key]: event.target.value })} />
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function PriceTable({ models, onEdit, saving }) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const filtered = models.filter(row => row.model.toLowerCase().includes(query.trim().toLowerCase()));
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / pageSize) - 1));
  const start = currentPage * pageSize;
  return (
    <section className="pricing-panel" aria-labelledby="catalog-title">
      <div className="pricing-heading">
        <div>
          <h2 id="catalog-title">模型默认价</h2>
          <p>单位为美元 / 百万 token。没有匹配的渠道规则时使用这张价格表。</p>
        </div>
        <label>
          搜索模型
          <input type="search" value={query} placeholder="输入模型 ID"
            onChange={event => { setQuery(event.target.value); setPage(0); }} />
        </label>
      </div>
      <div className="pricing-table-wrap" role="region" tabIndex={0} aria-labelledby="catalog-title">
        <table>
          <thead>
            <tr>
              <th scope="col">模型</th>
              {fields.map(([key, label]) => <th key={key} scope="col">{label}</th>)}
              <th scope="col">价格来源</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(start, start + pageSize).map(row => (
              <tr key={row.model}>
                <th scope="row">{row.model}</th>
                {fields.map(([key]) => <td key={key}>{amount.format(row.rates[key])}</td>)}
                <td>{row.source}</td>
                <td>
                  <button type="button" className="btn" disabled={saving} aria-label={`编辑 ${row.model} 默认价`}
                    onClick={() => onEdit(row)}>编辑</button>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && <tr><td colSpan={7}>没有匹配的模型。</td></tr>}
          </tbody>
        </table>
      </div>
      {filtered.length > pageSize && (
        <div className="pricing-pagination">
          <button type="button" className="btn" disabled={start === 0}
            onClick={() => setPage(currentPage - 1)}>上一页</button>
          <span aria-live="polite">{start + 1}–{Math.min(start + pageSize, filtered.length)} / {filtered.length}</span>
          <button type="button" className="btn" disabled={start + pageSize >= filtered.length}
            onClick={() => setPage(currentPage + 1)}>下一页</button>
        </div>
      )}
    </section>
  );
}

function PricingEditor({ data, onSaved }) {
  const [policy, setPolicy] = useState(data.policy);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const dirty = policy !== data.policy;
  const prices = new Map(data.models.map(row => [row.model, row]));
  for (const row of policy.defaults) {
    if (row.model.trim() && fields.every(([key]) => row.rates[key] !== '')) {
      prices.set(row.model.trim(), { ...row, model: row.model.trim(), source: '自定义' });
    }
  }
  const models = [...prices.values()].sort((a, b) => a.model.localeCompare(b.model));

  function changePolicy(changes) {
    setPolicy(current => ({ ...current, ...changes }));
    setStatus('');
    setError('');
  }

  function updateRow(kind, index, changes) {
    changePolicy({ [kind]: policy[kind].map((row, i) => i === index ? { ...row, ...changes } : row) });
  }

  function removeRow(kind, index) {
    changePolicy({ [kind]: policy[kind].filter((_, i) => i !== index) });
  }

  function editPrice({ model, rates }) {
    if (!policy.defaults.some(row => row.model === model)) {
      changePolicy({ defaults: [...policy.defaults, { model, rates: { ...rates } }] });
    }
    requestAnimationFrame(() => {
      const editor = document.getElementById('default-price-editor');
      const input = [...editor.querySelectorAll('input[list="pricing-models"]')].find(node => node.value === model);
      input?.focus();
    });
  }

  async function save(event) {
    event.preventDefault();
    if (saving || !dirty) return;
    setSaving(true);
    setError('');
    setStatus('');
    try {
      const numericRates = rates => Object.fromEntries(fields.map(([key]) => [key, Number(rates[key])]));
      const saved = await requestPricing({
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          timeZone: policy.timeZone.trim(),
          defaults: policy.defaults.map(row => ({ model: row.model.trim(), rates: numericRates(row.rates) })),
          rules: policy.rules.map(row => ({
            ...row, provider: row.provider.trim(), model: row.model.trim(),
            peak: numericRates(row.peak), offPeak: numericRates(row.offPeak),
            effectiveFrom: row.effectiveFrom || null
          }))
        })
      });
      onSaved(saved);
      setPolicy(saved.policy);
      setStatus('价格规则已保存。');
    } catch (err) {
      setError(`保存失败。请核对价格规则后重试。 ${err.message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PriceTable models={models} onEdit={editPrice} saving={saving} />
      <form className="pricing-form" onSubmit={save} aria-label="模型价格配置">
        <datalist id="pricing-models">
          {models.map(row => <option key={row.model} value={row.model} />)}
        </datalist>
        <fieldset disabled={saving} className="pricing-editor">
          <section className="pricing-panel" id="default-price-editor" aria-labelledby="defaults-title">
            <div className="pricing-heading">
              <div>
                <h2 id="defaults-title">自定义模型默认价</h2>
                <p>可添加模型 ID，或覆盖目录中已有的默认价。</p>
              </div>
              <button type="button" className="btn" onClick={() =>
                changePolicy({ defaults: [...policy.defaults, { model: '', rates: { ...blankRates } }] })
              }>添加默认价</button>
            </div>
            {policy.defaults.map((row, index) => (
              <div className="pricing-entry" key={index}>
                <div className="pricing-entry-head">
                  <label>模型 ID
                    <input required list="pricing-models" maxLength={255} value={row.model}
                      onChange={event => updateRow('defaults', index, { model: event.target.value })} />
                  </label>
                  <button type="button" className="btn" onClick={() => removeRow('defaults', index)}
                    aria-label={`移除 ${row.model || '新模型'} 的默认价`}>移除</button>
                </div>
                <RateFields title="默认价" rates={row.rates}
                  onChange={rates => updateRow('defaults', index, { rates })} />
              </div>
            ))}
          </section>
          <section className="pricing-panel" aria-labelledby="rules-title">
            <div className="pricing-heading">
              <div>
                <h2 id="rules-title">渠道峰谷价</h2>
                <p>启用后按调用时间计费。谷时包含开始时间，可跨午夜，其余时间用峰价。</p>
              </div>
              <button type="button" className="btn" onClick={() => changePolicy({ rules: [...policy.rules, {
                provider: '', model: '', enabled: false,
                peak: { ...blankRates }, offPeak: { ...blankRates },
                offPeakStart: '', offPeakEnd: '', effectiveFrom: null
              }] })}>添加渠道规则</button>
            </div>
            <label className="pricing-timezone">
              计价时区
              <input required maxLength={64} value={policy.timeZone} placeholder="Asia/Shanghai"
                onChange={event => changePolicy({ timeZone: event.target.value })} />
            </label>
            {policy.rules.map((rule, index) => (
              <div className="pricing-entry" key={index}>
                <div className="pricing-entry-head">
                  <label>Provider
                    <input required maxLength={255} value={rule.provider}
                      onChange={event => updateRow('rules', index, { provider: event.target.value })} />
                  </label>
                  <label>模型 ID
                    <input required list="pricing-models" maxLength={255} value={rule.model}
                      onChange={event => updateRow('rules', index, { model: event.target.value })} />
                  </label>
                  <button type="button" className="btn" onClick={() => removeRow('rules', index)}
                    aria-label={`移除 ${rule.provider || '新渠道'} ${rule.model} 峰谷规则`}>移除</button>
                </div>
                <label className="pricing-checkbox">
                  <input type="checkbox" checked={rule.enabled}
                    onChange={event => updateRow('rules', index, { enabled: event.target.checked })} />
                  启用峰谷价
                </label>
                <div className="pricing-rates pricing-schedule">
                  <label>谷时开始
                    <input type="time" required value={rule.offPeakStart}
                      onChange={event => updateRow('rules', index, { offPeakStart: event.target.value })} />
                  </label>
                  <label>谷时结束
                    <input type="time" required value={rule.offPeakEnd}
                      onChange={event => updateRow('rules', index, { offPeakEnd: event.target.value })} />
                  </label>
                  <label>生效日期（可选）
                    <input type="date" value={rule.effectiveFrom || ''}
                      onChange={event => updateRow('rules', index, { effectiveFrom: event.target.value })} />
                  </label>
                </div>
                <RateFields title="峰价" rates={rule.peak}
                  onChange={peak => updateRow('rules', index, { peak })} />
                <RateFields title="谷价" rates={rule.offPeak}
                  onChange={offPeak => updateRow('rules', index, { offPeak })} />
              </div>
            ))}
          </section>
        </fieldset>
        <div className="pricing-actions">
          <button className="btn btn-primary" type="submit" disabled={saving || !dirty}>
            {saving ? '正在保存…' : '保存价格规则'}
          </button>
          {error && <span className="pricing-error" role="alert">{error}</span>}
          <span role="status">{status || (dirty ? '有未保存的更改' : '')}</span>
        </div>
      </form>
    </>
  );
}

export function PricingApp() {
  const [data, setData] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    requestPricing({ signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) })
      .then(setData)
      .catch(err => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [attempt]);
  return (
    <main className="pricing-page">
      <header className="pricing-header">
        <nav className="page-switch" aria-label="页面导航">
          <a href="/" className="page-chip">看板</a>
          <a href="/review" className="page-chip">复盘</a>
          <span className="page-chip active" aria-current="page">定价</span>
        </nav>
        <ThemeToggle />
      </header>
      <div className="pricing-title">
        <h1>模型定价</h1>
        {data && <p>价格版本 <code>{data.version}</code></p>}
        {data && <p><a href="#historical-reprice">历史费用重算</a></p>}
      </div>
      {error && <p className="pricing-error" role="alert">价格表加载失败。 {error} <button type="button" className="btn"
        onClick={() => setAttempt(value => value + 1)}>重试</button></p>}
      {!data && !error && <p role="status">正在加载模型价格…</p>}
      {data && <PricingEditor data={data} onSaved={setData} />}
      {data && <RepricePanel key={data.version} />}
    </main>
  );
}
