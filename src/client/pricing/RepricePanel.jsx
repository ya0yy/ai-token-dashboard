import { useState } from 'react';

const money = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 6
});
const change = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', maximumFractionDigits: 6, signDisplay: 'exceptZero'
});
const skipReasons = [
  ['incompleteDetail', '明细不齐'],
  ['costMismatch', '费用与明细对不上'],
  ['recordedDay', '已有账单金额'],
  ['noEligibleEvents', '无可更新的调用']
];

export function RepricePanel({ rules }) {
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [model, setModel] = useState('');
  const [recoverLegacyPiZero, setRecoverLegacyPiZero] = useState(false);
  const [fallbackProvider, setFallbackProvider] = useState('');
  const [result, setResult] = useState(null);
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');

  function updateFilter(setValue, value) {
    setValue(value);
    setResult(null);
    setError('');
  }

  async function submit(previewId) {
    setPending(previewId ? 'apply' : 'preview');
    setError('');
    setResult(null);
    try {
      const response = await fetch('/api/pricing/reprice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ start, end, model: model.trim() || undefined, recoverLegacyPiZero,
          fallbackProvider: recoverLegacyPiZero ? fallbackProvider || undefined : undefined, previewId }),
        signal: AbortSignal.timeout(60_000)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `请求失败（HTTP ${response.status}）`);
      setResult(data);
    } catch (err) {
      setError(err.message || '请求失败，请重新预览');
    } finally {
      setPending('');
    }
  }

  const skipped = result && skipReasons.filter(([key]) => result.skipped[key] > 0);
  const providers = [...new Set(rules.filter(rule => rule.enabled).map(rule => rule.provider))].sort();
  return (
    <section id="historical-reprice" className="pricing-panel" aria-labelledby="reprice-title">
      <h2 id="reprice-title">历史费用重算</h2>
      <p>按看板日期选择范围，使用已保存的价格规则。执行前会在服务端备份。</p>
      <form onSubmit={event => { event.preventDefault(); submit(); }}>
        <div className="reprice-dates">
          <label>开始日期
            <input type="date" required value={start} max={end || undefined} disabled={!!pending}
              onChange={event => updateFilter(setStart, event.target.value)} />
          </label>
          <label>结束日期
            <input type="date" required value={end} min={start || undefined} disabled={!!pending}
              onChange={event => updateFilter(setEnd, event.target.value)} />
          </label>
          <label>模型 ID
            <input type="text" value={model} maxLength={255} required={recoverLegacyPiZero} disabled={!!pending}
              placeholder={recoverLegacyPiZero ? '输入完整模型 ID' : '留空为全部模型'}
              onChange={event => updateFilter(setModel, event.target.value)} />
          </label>
          <button className="btn" disabled={!!pending || recoverLegacyPiZero && !model.trim()}>
            {pending === 'preview' ? '正在预览…' : '预览差额'}
          </button>
        </div>
        <label className="pricing-checkbox">
          <input type="checkbox" checked={recoverLegacyPiZero} disabled={!!pending}
            onChange={event => updateFilter(setRecoverLegacyPiZero, event.target.checked)} />
          仅补算旧版 Pi Agent 的零金额
        </label>
        {recoverLegacyPiZero && (
          <>
            <p className="muted">旧日志未区分本地估算和实际零元账单。核实为本地估算后再启用。</p>
            {providers.length > 0 && (
              <label>缺少 Provider 时使用的参考价
                <select value={fallbackProvider} disabled={!!pending}
                  onChange={event => updateFilter(setFallbackProvider, event.target.value)}>
                  <option value="">模型默认价</option>
                  {providers.map(provider => <option key={provider} value={provider}>{provider}</option>)}
                </select>
              </label>
            )}
          </>
        )}
      </form>
      {error && <p className="pricing-error" role="alert">{error}</p>}
      {pending === 'apply' && <p role="status">正在备份并重算费用…</p>}
      {result && <div className="reprice-result">
        <p role="status">
          {result.applied ? '重算完成' : result.counts.time ? '可重算' : '该范围内没有可重算的费用'}
          {result.counts.time > 0 && ` · ${result.counts.time} 条调用 · ${result.counts.daily} 条日汇总`}
        </p>
        {result.counts.time > 0 && <dl className="reprice-amounts">
          <div><dt>原金额</dt><dd>{money.format(result.costBefore)}</dd></div>
          <div><dt>重算后</dt><dd>{money.format(result.costAfter)}</dd></div>
          <div><dt>差额</dt><dd>{change.format(result.difference)}</dd></div>
        </dl>}
        {skipped.length > 0 && <p className="muted">
          跳过的日汇总 · {skipped.map(([key, label]) => `${label} ${result.skipped[key]} 条`).join(' · ')}
        </p>}
        {!result.applied && result.counts.time > 0 && (
          <button className="btn btn-primary" type="button" onClick={() => submit(result.previewId)}>确认重算</button>
        )}
        {result.backupFile && <p className="muted">服务端备份 <code>{result.backupFile}</code></p>}
      </div>}
    </section>
  );
}
