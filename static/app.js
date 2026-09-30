const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const fmt = n => Number(n).toLocaleString();
const pct = v => (v * 100).toFixed(2) + '%';
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const badge = (t, cls) => `<span class="badge b-${String(cls).toLowerCase()}">${esc(t)}</span>`;
const JSONH = {'Content-Type': 'application/json'};
const post = (url, body) => api(url, { method: 'POST', headers: JSONH, body: JSON.stringify(body || {}) });
let M = null, lastBatch = [];

/* ---------- toasts & api ---------- */
function toast(msg, type = 'info', sticky = false) {
  const t = document.createElement('div');
  t.className = 'toast ' + type; t.setAttribute('role', type === 'error' ? 'alert' : 'status');
  t.innerHTML = `<span>${esc(msg)}</span><button type="button" aria-label="Dismiss">×</button>`;
  t.querySelector('button').onclick = () => t.remove();
  $('#toasts').appendChild(t);
  if (!sticky) setTimeout(() => t.remove(), 5000);
}
async function api(url, opts) {
  try {
    const r = await fetch(url, opts);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || 'Request failed');
    return d;
  } catch (e) { toast(e.message || 'Request failed', 'error'); throw e; }
}
const busy = (btn, on, label) => { if (on) { btn.dataset.l = btn.innerHTML; btn.innerHTML = label; } else if (btn.dataset.l) btn.innerHTML = btn.dataset.l; btn.disabled = on; };

/* ---------- routing ---------- */
const TITLES = { dashboard: 'Dashboard', predict: 'Fraud Prediction', batch: 'Batch CSV Analysis', history: 'Transaction History', queue: 'Review Queue', performance: 'Model Performance' };
const HERO = {
  dashboard:   { eye: 'Fraud intelligence', h: 'Every transaction,<br>under watch', d: 'A live view of scored payments, risk levels and model health.', a: [['Run a prediction', 'predict'], ['Analyze a CSV', 'batch', 1]] },
  predict:     { eye: 'Single transaction', h: 'Score a payment<br>in seconds', d: 'Run the trained XGBoost model on one transaction and see exactly why it was flagged.' },
  batch:       { eye: 'Batch analysis', h: 'Analyze a whole<br>file at once', d: 'Upload a CSV, get fraud and normal counts, and download every scored row.' },
  history:     { eye: 'Audit trail', h: 'Every decision,<br>on record', d: 'Search, sort and filter all predictions. Mark results to teach the model.' },
  queue:       { eye: 'Analyst review', h: 'Review what<br>matters first', d: 'Flagged transactions ranked by expected loss, ready for a quick decision.' },
  performance: { eye: 'Model health', h: 'Measured,<br>not assumed', d: 'Every number here is computed from real held-out test predictions.' }
};
function renderHero(page) {
  const h = HERO[page];
  $('#hero-eyebrow').textContent = h.eye; $('#page-title').innerHTML = h.h; $('#hero-desc').textContent = h.d;
  $('#hero-actions').innerHTML = (h.a || []).map(([l, g, alt]) => `<button type="button" class="btn ${alt ? 'ghost' : 'arrow'}" data-go="${g}">${l}</button>`).join('');
  const box = $('.hero-in'); box.style.animation = 'none'; void box.offsetWidth; box.style.animation = '';
  $$('.hero-in>*').forEach(el => { el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; });
}
function go(page) {
  if (!TITLES[page]) page = 'dashboard';
  $$('.nav').forEach(n => { const on = n.dataset.page === page; n.classList.toggle('active', on); on ? n.setAttribute('aria-current', 'page') : n.removeAttribute('aria-current'); });
  $$('.navgroup').forEach(g => g.querySelector('.grp').classList.toggle('active', !!g.querySelector('.nav.active')));
  $$('.page').forEach(p => p.classList.toggle('active', p.id === page));
  $$('#dots button').forEach(b => b.classList.toggle('on', b.dataset.page === page));
  renderHero(page);
  document.title = TITLES[page] + ' · FraudGuard';
  closeMenu(); closeGroups();
  if (location.hash !== '#' + page) history.replaceState(null, '', '#' + page);
  ({ dashboard: loadDashboard, history: loadHistory, queue: loadQueue, performance: loadMetrics })[page]?.();
  window.scrollTo(0, 0);
}
$$('.nav').forEach(n => n.onclick = () => go(n.dataset.page));
$('#dots').innerHTML = Object.entries(TITLES).map(([k, v]) => `<button type="button" data-page="${k}" title="${v}" aria-label="${v}"></button>`).join('');
$$('#dots button').forEach(b => b.onclick = () => go(b.dataset.page));
window.addEventListener('hashchange', () => go(location.hash.slice(1)));
document.addEventListener('click', e => { const g = e.target.closest('[data-go]'); if (g) go(g.dataset.go); });
$('#s-open').onclick = () => go('queue');
/* dropdown menus: hover on desktop, tap anywhere, Esc / outside click closes */
function closeGroups(except) { $$('.navgroup').forEach(g => { if (g !== except) { g.classList.remove('open'); g.querySelector('.grp').setAttribute('aria-expanded', 'false'); } }); }
$$('.navgroup').forEach(g => {
  const btn = g.querySelector('.grp');
  btn.onclick = e => { e.stopPropagation(); const on = !g.classList.contains('open'); closeGroups(g); g.classList.toggle('open', on); btn.setAttribute('aria-expanded', on); };
  g.addEventListener('mouseenter', () => { if (mq('(min-width:861px) and (hover:hover)')) { closeGroups(g); g.classList.add('open'); btn.setAttribute('aria-expanded', 'true'); } });
  g.addEventListener('mouseleave', () => { if (mq('(min-width:861px) and (hover:hover)')) { g.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); } });
});
document.addEventListener('click', e => { if (!e.target.closest('.navgroup')) closeGroups(); });
function openMenu() { $('#navwrap').classList.add('open'); $('#menu-btn').setAttribute('aria-expanded', 'true'); }
function closeMenu() { $('#navwrap').classList.remove('open'); $('#menu-btn').setAttribute('aria-expanded', 'false'); if ($('#drawer').classList.contains('hidden')) $('#overlay').classList.add('hidden'); }
$('#menu-btn').onclick = () => $('#navwrap').classList.contains('open') ? closeMenu() : openMenu();

/* ---------- states, count-up ---------- */
const ICONS = {
  inbox: '<svg viewBox="0 0 24 24"><path d="M3 13l3-8h12l3 8v6H3v-6Zm0 0h5l1 3h6l1-3h5"/></svg>',
  alert: '<svg viewBox="0 0 24 24"><path d="M12 3 2 21h20L12 3Zm0 6v5m0 3v.5"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m5 12 4 4 10-10"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>'
};
const stateHtml = (icon, title, text, action = '', err = false) => `<div class="state${err ? ' err' : ''}"><div class="state-ic">${ICONS[icon]}</div><b>${title}</b><p>${text}</p>${action}</div>`;
const emptyRow = (cols, html) => `<tr><td colspan="${cols}">${html}</td></tr>`;
const skelRows = (n = 4) => Array.from({ length: n }, () => '<tr><td colspan="8"><div class="sk-line"></div></td></tr>').join('');
const loadingIfEmpty = (el, n) => { if (!el.innerHTML.trim()) el.innerHTML = skelRows(n); };
const errorRow = (el, cols, retry) => { el.innerHTML = emptyRow(cols, stateHtml('alert', 'Couldn’t load this data', 'Check that the server is running, then try again.', '<button type="button" class="btn light sm" data-retry>Retry</button>', true)); el.querySelector('[data-retry]').onclick = retry; };
const mq = q => !!(window.matchMedia && window.matchMedia(q).matches);
const reduceMotion = mq('(prefers-reduced-motion: reduce)');
function countUp(el, to, render = fmt) {
  el.classList.remove('sk');
  if (reduceMotion || !isFinite(to)) { el.textContent = render(to); return; }
  const t0 = performance.now(), dur = 700;
  const tick = t => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = render(to * e); if (k < 1) requestAnimationFrame(tick); else el.textContent = render(to); };
  requestAnimationFrame(tick);
}

/* ---------- shared renderers ---------- */
function txTable(el, rows, fb) {
  if (!rows.length) { el.innerHTML = emptyRow(7, stateHtml('inbox', 'No transactions yet', 'Run a prediction or analyze a CSV to see activity here.', '<button type="button" class="btn arrow sm" data-go="predict">Run a prediction</button>')); return; }
  el.innerHTML = '<thead><tr><th>Transaction ID</th><th>Amount</th><th>Prediction</th><th>Risk</th><th>Fraud %</th><th>Timestamp</th>' + (fb ? '<th>Feedback</th>' : '') + '</tr></thead><tbody>' +
    rows.map(r => `<tr class="clickable" data-id="${esc(r.id)}"><td>${esc(r.id)}</td><td>$${Number(r.amount).toFixed(2)}</td><td>${badge(r.prediction, r.prediction)}</td><td>${badge(r.risk, r.risk)}</td><td>${r.probability}%</td><td>${esc(r.timestamp)}</td>` +
      (fb ? `<td class="fb" data-id="${esc(r.id)}"><button type="button" data-v="correct" class="${r.feedback === 'correct' ? 'on-correct' : ''}" title="Prediction was correct" aria-label="Mark correct">✓</button> <button type="button" data-v="wrong" class="${r.feedback === 'wrong' ? 'on-wrong' : ''}" title="Prediction was wrong" aria-label="Mark wrong">✗</button></td>` : '') + '</tr>').join('') + '</tbody>';
}
const cardsHtml = arr => arr.map(([k, v]) => `<div class="card stat"><span>${k}</span><b>${v}</b></div>`).join('');
function costNote(r) {
  const cost = Math.max(0, Number($('#review-cost').value) || 0), loss = r.amount * r.probability / 100;
  return loss >= cost
    ? `<div class="note warn"><b>Cost decision: review / block.</b> Expected loss $${loss.toFixed(2)} ≥ review cost $${cost.toFixed(2)}.</div>`
    : `<div class="note"><b>Cost decision: not worth a manual review.</b> Expected loss $${loss.toFixed(2)} &lt; review cost $${cost.toFixed(2)}.</div>`;
}
function anomNote(r) {
  if (r.anomaly === undefined || r.anomaly === null) return '';
  return `<div class="note ${r.unusual ? 'warn' : ''}">Anomaly score <b>${r.anomaly}</b>/100 (more unusual than ${r.anomaly}% of training transactions).${r.unusual && r.prediction === 'NORMAL' ? ' Unusual pattern despite a NORMAL result: consider a manual look.' : ''}</div>`;
}
function explainHtml(ex) {
  if (!ex || !ex.length) return '';
  const max = Math.max(...ex.map(e => Math.abs(e.impact)), 0.01);
  return '<div class="explain"><b>Why this result</b><div class="muted">Top features pushing the score: red toward fraud, green toward normal</div>' +
    ex.map(e => { const w = 50 * Math.abs(e.impact) / max, up = e.impact > 0;
      return `<div class="exrow"><span title="${esc(e.feature)} = ${e.value}">${esc(e.feature)}=${e.value}</span><div class="exbar"><i style="${up ? 'left:50%' : 'right:50%'};width:${w}%;background:${up ? '#e11d48' : '#10b981'}"></i></div><span>${e.impact > 0 ? '+' : ''}${e.impact}</span></div>`; }).join('') + '</div>';
}
function meter(p, thr) {
  const col = p >= 70 ? '#e11d48' : p >= 30 ? '#f59e0b' : '#10b981';
  return `<div class="meter" title="Fraud probability ${p}%"><i style="width:${Math.max(p, 1)}%;background:${col}"></i><b style="left:${thr * 100}%" title="Decision threshold ${thr}"></b></div>
    <div class="scale"><span>0%</span><span>threshold ${thr}</span><span>100%</span></div>`;
}

/* ---------- charts (inline SVG with native tooltips) ---------- */
function donut(fraud, normal) {
  const total = fraud + normal;
  if (!total) return '<span class="muted">No data yet.</span>';
  const r = 60, c = 2 * Math.PI * r, f = c * fraud / total;
  return `<svg width="180" height="180" viewBox="0 0 180 180" role="img" aria-label="Fraud versus normal"><g transform="translate(90,90) rotate(-90)">
    <circle r="${r}" fill="none" stroke="#10b981" stroke-width="26"><title>Normal: ${fmt(normal)}</title></circle>
    <circle r="${r}" fill="none" stroke="#e11d48" stroke-width="26" stroke-dasharray="${f} ${c}"><title>Fraud: ${fmt(fraud)}</title></circle></g>
    <text x="90" y="96" text-anchor="middle" font-size="20" font-weight="700" fill="#1b1626">${(100 * fraud / total).toFixed(1)}%</text></svg>
    <div><div class="legend"><span><i style="background:#e11d48"></i>Fraud ${fmt(fraud)}</span></div><div class="legend"><span><i style="background:#10b981"></i>Normal ${fmt(normal)}</span></div></div>`;
}
function bars(trend) {
  if (!trend.length) return '<span class="muted">No data yet.</span>';
  const w = 440, h = 180, pad = 24, max = Math.max(...trend.map(t => t.n), 1), step = (w - pad * 2) / trend.length, bw = Math.min(40, step - 6);
  let s = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="Daily transactions">`;
  trend.forEach((t, i) => {
    const x = pad + i * step + (step - bw) / 2, hn = (h - 50) * (t.n - t.f) / max, hf = (h - 50) * t.f / max;
    s += `<g><title>${esc(t.d)}: ${t.n} transactions, ${t.f} fraud</title><rect x="${x}" y="${h-30-hn}" width="${bw}" height="${hn}" fill="#a78bfa" rx="3"/><rect x="${x}" y="${h-30-hn-hf}" width="${bw}" height="${hf}" fill="#e11d48" rx="3"/>
      <text x="${x+bw/2}" y="${h-14}" text-anchor="middle" font-size="9" fill="#6f6879">${esc(t.d.slice(5))}</text></g>`;
  });
  return s + `</svg><div class="legend"><span><i style="background:#a78bfa"></i>Normal</span><span><i style="background:#e11d48"></i>Fraud</span></div>`;
}
function rocSvg(fpr, tpr) {
  const S = 300, p = 30, pt = (x, y) => `${p + x * (S - 2 * p)},${S - p - y * (S - 2 * p)}`;
  return `<svg width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" role="img" aria-label="ROC curve"><rect x="${p}" y="${p}" width="${S-2*p}" height="${S-2*p}" fill="none" stroke="#eee6f1"/>
    <line x1="${p}" y1="${S-p}" x2="${S-p}" y2="${p}" stroke="#9ca3af" stroke-dasharray="4"/>
    <polyline points="${fpr.map((x, i) => pt(x, tpr[i])).join(' ')}" fill="none" stroke="#b3129b" stroke-width="2"/>
    <text x="${S/2}" y="${S-6}" text-anchor="middle" font-size="11" fill="#6f6879">False Positive Rate</text>
    <text x="10" y="${S/2}" font-size="11" fill="#6f6879" transform="rotate(-90 10 ${S/2})" text-anchor="middle">True Positive Rate</text></svg>`;
}

/* ---------- model info (sidebar / topbar) ---------- */
async function loadModelInfo() {
  M = await api('/api/metrics');
  $('#top-pill').textContent = 'Threshold ' + M.threshold;
  $('#side-ver').textContent = M.version || '';
}

/* ---------- dashboard ---------- */
function setBadge(n) { ['#q-badge', '#q-badge-g'].forEach(id => { const b = $(id); b.textContent = n; b.classList.toggle('hidden', !n); }); }
function ringSvg(p, col) {
  const r = 34, c = 2 * Math.PI * r;
  return `<svg class="ring" viewBox="0 0 84 84" role="img" aria-label="F1 score ${(p * 100).toFixed(1)}%"><circle cx="42" cy="42" r="${r}" fill="none" stroke="#f3edf5" stroke-width="9"/>
    <circle cx="42" cy="42" r="${r}" fill="none" stroke="${col}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${c * p} ${c}" transform="rotate(-90 42 42)" style="transition:stroke-dasharray 1s cubic-bezier(.2,.7,.2,1)"><title>F1 ${(p * 100).toFixed(1)}%</title></circle>
    <text x="42" y="47" text-anchor="middle" font-size="16" font-weight="800" fill="#1b1626">${(p * 100).toFixed(0)}%</text></svg>`;
}
function riskBars(low, med, high) {
  const tot = low + med + high;
  if (!tot) return '<span class="muted" style="text-align:center">No data yet.</span>';
  return [['Low', low, '#10b981'], ['Medium', med, '#f59e0b'], ['High', high, '#e11d48']].map(([l, n, c]) =>
    `<div class="rk" title="${l}: ${fmt(n)} transactions"><span>${l}</span><div class="bar"><i style="width:${(100 * n / tot).toFixed(1)}%;background:${c}"></i></div><b>${fmt(n)}</b></div>`).join('');
}
async function loadDashboard() {
  ['#t-recent', '#t-top'].forEach(id => loadingIfEmpty($(id), 3));
  try {
    const cnt = r => api('/api/history?size=5&page=1&risk=' + r).then(x => x.total);
    const [d, low, med, high] = await Promise.all([api('/api/stats'), cnt('Low'), cnt('Medium'), cnt('High')]);
    if (!M) await loadModelInfo();
    countUp($('#s-total'), d.total); countUp($('#s-normal'), d.normal); countUp($('#s-fraud'), d.fraud);
    countUp($('#s-high'), high); countUp($('#s-rate'), d.rate, v => v.toFixed(2).replace(/\.?0+$/, '') + '%');
    $('#s-openq').textContent = fmt(d.open_queue); setBadge(d.open_queue);
    $('#s-model').innerHTML = M ? `${ringSvg(M.f1, '#b3129b')}<div class="ringtxt"><b>F1 ${pct(M.f1)}</b><br>Recall ${pct(M.recall)}<br>Precision ${pct(M.precision)}<br>ROC-AUC ${M.roc_auc.toFixed(4)}</div>` : '';
    $('#dash-empty').classList.toggle('hidden', d.total > 0);
    $('#chart-split').innerHTML = donut(d.fraud, d.normal);
    $('#chart-trend').innerHTML = bars(d.trend);
    $('#risk-dist').innerHTML = riskBars(low, med, high);
    txTable($('#t-recent'), d.recent); txTable($('#t-top'), d.top);
  } catch (_) { ['#t-recent', '#t-top'].forEach(id => errorRow($(id), 7, loadDashboard)); }
}

/* ---------- prediction ---------- */
const inputs = () => $$('[data-f]');
const NAMES = ['Time', ...Array.from({ length: 28 }, (_, i) => 'V' + (i + 1)), 'Amount'];
function updateCount() { const n = inputs().filter(i => i.value.trim() !== '').length; $('#fill-count').textContent = `${n} / 30 fields filled`; }
function fill(obj) { inputs().forEach(i => { i.value = obj[i.dataset.f] ?? ''; i.classList.remove('bad'); }); updateCount(); }
inputs().forEach(i => i.addEventListener('input', () => { i.classList.remove('bad'); updateCount(); }));
$('#load-normal').onclick = async () => fill((await api('/api/samples')).normal);
$('#load-fraud').onclick = async () => fill((await api('/api/samples')).fraud);
$('#clear-form').onclick = () => fill({});
$('#paste-btn').onclick = () => {
  const txt = $('#paste').value.trim(); if (!txt) return toast('Paste a row first.', 'error');
  let obj;
  try { obj = JSON.parse(txt); } catch (_) {
    const nums = txt.split(/[\s,;]+/).filter(Boolean).map(Number);
    if (nums.length < 30 || nums.some(n => !isFinite(n))) return toast('Expected 30 numbers in the order Time, V1…V28, Amount.', 'error');
    obj = Object.fromEntries(NAMES.map((k, i) => [k, nums[i]]));
  }
  if (typeof obj !== 'object' || obj === null) return toast('Could not read the pasted data.', 'error');
  fill(obj); toast('Form filled from pasted data.', 'success');
};
$('#predict-btn').onclick = async () => {
  const body = {}; let firstBad = null;
  inputs().forEach(i => {
    const ok = i.value.trim() !== '' && isFinite(Number(i.value));
    i.classList.toggle('bad', !ok); if (ok) body[i.dataset.f] = Number(i.value); else firstBad = firstBad || i;
  });
  if (firstBad) { $('#pca-box').open = true; firstBad.focus(); return toast('Fill every field with a valid number (highlighted in red).', 'error'); }
  const btn = $('#predict-btn'); busy(btn, true, 'Scoring…');
  try {
    const r = await post('/api/predict', body), fraud = r.prediction === 'FRAUD';
    $('#result').className = '';
    $('#result').innerHTML = `<div class="verdict ${fraud ? 'fraud' : 'normal'}"><div class="big ${fraud ? 'red' : 'green'}">${r.prediction}</div>
      <div>Fraud probability <b>${r.probability}%</b> · Risk ${badge(r.risk, r.risk)}</div></div>${meter(r.probability, r.threshold)}
      ${costNote(r)}${anomNote(r)}${explainHtml(r.explanation)}
      <p class="muted">ID ${esc(r.id)} · Amount $${r.amount.toFixed(2)} · ${esc(r.timestamp)}</p>`;
    if (r.risk === 'High') toast('High-risk fraud alert: transaction ' + r.id, 'error', true);
  } finally { busy(btn, false); }
};
document.addEventListener('keydown', e => { if (e.ctrlKey && e.key === 'Enter' && $('#predict').classList.contains('active')) $('#predict-btn').click(); });

/* batch CSV */
const drop = $('#drop'), fileIn = $('#csv-file');
fileIn.onchange = () => { $('#csv-name').textContent = fileIn.files[0] ? fileIn.files[0].name : 'Needs columns Time, V1–V28, Amount · max 10 MB / 20,000 rows'; };
['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', e => { if (e.dataTransfer.files.length) { fileIn.files = e.dataTransfer.files; fileIn.onchange(); } });
$('#csv-btn').onclick = async () => {
  const f = fileIn.files[0]; if (!f) return toast('Choose a CSV file first.', 'error');
  const fd = new FormData(); fd.append('file', f);
  const btn = $('#csv-btn'); busy(btn, true, 'Scoring…');
  try {
    const r = await api('/api/predict_csv', { method: 'POST', body: fd });
    lastBatch = r.results;
    $('#b-total').textContent = fmt(r.total); $('#b-fraud').textContent = fmt(r.fraud);
    $('#b-normal').textContent = fmt(r.normal); $('#b-pct').textContent = r.fraud_pct + '%';
    $('#b-skipped').textContent = r.skipped ? `${r.skipped} row(s) skipped (missing or invalid values).` : '';
    txTable($('#b-top'), [...r.results].sort((a, b) => b.probability - a.probability).slice(0, 5));
    $('#batch-out').classList.remove('hidden'); $('#batch-empty').classList.add('hidden');
    toast(`Scored ${fmt(r.total)} transactions: ${r.fraud} flagged as fraud.`, 'success');
    if (r.results.some(x => x.risk === 'High')) toast('High-risk fraud detected in this batch.', 'error', true);
  } finally { busy(btn, false); }
};
$('#download-btn').onclick = () => {
  if (!lastBatch.length) return;
  const head = ['id', 'amount', 'prediction', 'probability', 'risk', 'anomaly', 'timestamp'];
  const csv = [head.join(',')].concat(lastBatch.map(r => head.map(h => r[h] ?? '').join(','))).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'fraud_predictions.csv'; a.click(); URL.revokeObjectURL(a.href);
};

/* ---------- history (server-side paging & sorting) ---------- */
const H = { page: 1, size: 10, sort: 'timestamp', dir: 'desc', total: 0 };
const COLSH = [['id', 'Transaction ID'], ['amount', 'Amount'], ['prediction', 'Prediction'], ['risk', 'Risk'], ['probability', 'Fraud %'], ['timestamp', 'Timestamp']];
async function loadHistory() {
  loadingIfEmpty($('#t-history'), 5);
  try { await loadHistoryInner(); } catch (_) { errorRow($('#t-history'), 7, loadHistory); }
}
async function loadHistoryInner() {
  const p = new URLSearchParams({ q: $('#h-q').value, prediction: $('#h-pred').value, risk: $('#h-risk').value, page: H.page, size: H.size, sort: H.sort, dir: H.dir });
  const d = await api('/api/history?' + p);
  H.total = d.total;
  const pages = Math.max(1, Math.ceil(d.total / H.size));
  if (H.page > pages) { H.page = pages; return loadHistoryInner(); }
  const el = $('#t-history');
  if (!d.items.length) el.innerHTML = emptyRow(7, ($('#h-q').value || $('#h-pred').value || $('#h-risk').value)
    ? stateHtml('search', 'No matching transactions', 'Try clearing a filter or searching for something else.')
    : stateHtml('inbox', 'No history yet', 'Predictions you run are stored here.', '<button type="button" class="btn arrow sm" data-go="predict">Run a prediction</button>'));
  else {
    txTable(el, d.items, true);
    el.querySelector('thead tr').innerHTML = COLSH.map(([k, l]) => `<th data-sort="${k}" aria-sort="${H.sort === k ? (H.dir === 'asc' ? 'ascending' : 'descending') : 'none'}">${l}${H.sort === k ? (H.dir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`).join('') + '<th>Feedback</th>';
  }
  $('#h-info').textContent = `${fmt(d.total)} transaction${d.total === 1 ? '' : 's'}`;
  $('#h-page').textContent = `Page ${H.page} of ${pages}`;
  $('#h-prev').disabled = H.page <= 1; $('#h-next').disabled = H.page >= pages;
}
$('#h-prev').onclick = () => { H.page--; loadHistory(); };
$('#h-next').onclick = () => { H.page++; loadHistory(); };
let ht; $('#h-q').oninput = () => { clearTimeout(ht); ht = setTimeout(() => { H.page = 1; loadHistory(); }, 250); };
['#h-pred', '#h-risk'].forEach(s => $(s).onchange = () => { H.page = 1; loadHistory(); });
$('#h-size').onchange = e => { H.size = Number(e.target.value); H.page = 1; loadHistory(); };
$('#t-history').addEventListener('click', async e => {
  const th = e.target.closest('th[data-sort]');
  if (th) { H.dir = H.sort === th.dataset.sort && H.dir === 'desc' ? 'asc' : 'desc'; H.sort = th.dataset.sort; H.page = 1; return loadHistory(); }
  const b = e.target.closest('.fb button'); if (!b) return;
  const on = b.classList.contains('on-' + b.dataset.v);
  await post('/api/feedback', { id: b.parentElement.dataset.id, value: on ? 'none' : b.dataset.v });
  loadHistory();
});
$('#h-clear').onclick = async () => {
  if (!confirm('Delete all stored prediction history?')) return;
  await post('/api/history/clear'); toast('History cleared.', 'success'); H.page = 1; loadHistory();
};

/* ---------- review queue + drawer ---------- */
const outcome = r => r.feedback == null ? 'Open' : (r.prediction === 'FRAUD') === (r.feedback === 'correct') ? 'Confirmed fraud' : 'False alarm / normal';
const fbValue = (pred, fraud) => (fraud === (pred === 'FRAUD')) ? 'correct' : 'wrong';
let qStatus = 'open';
async function loadQueue() {
  loadingIfEmpty($('#t-queue'), 4);
  let d;
  try { d = await api('/api/queue?status=' + qStatus); } catch (_) { return errorRow($('#t-queue'), 7, loadQueue); }
  setBadge(d.open);
  $('#q-count').textContent = `${d.open} open · ${d.reviewed} reviewed`;
  $('#q-open').className = 'btn' + (qStatus === 'open' ? '' : ' light'); $('#q-rev').className = 'btn' + (qStatus === 'reviewed' ? '' : ' light');
  const el = $('#t-queue');
  if (!d.items.length) { el.innerHTML = emptyRow(7, qStatus === 'open' ? stateHtml('check', 'You’re all caught up', 'Flagged transactions will appear here after predictions.', '<button type="button" class="btn arrow sm" data-go="predict">Run a prediction</button>') : stateHtml('inbox', 'Nothing reviewed yet', 'Decisions you make in the Open tab show up here.')); return; }
  el.innerHTML = '<thead><tr><th>Transaction ID</th><th>Amount</th><th>Fraud %</th><th>Risk</th><th>Expected loss</th><th>Timestamp</th><th>' + (qStatus === 'open' ? 'Decision' : 'Outcome') + '</th></tr></thead><tbody>' +
    d.items.map(r => `<tr class="clickable" data-id="${esc(r.id)}" data-pred="${esc(r.prediction)}"><td>${esc(r.id)}</td><td>$${r.amount.toFixed(2)}</td><td>${r.probability}%</td><td>${badge(r.risk, r.risk)}</td><td>$${r.expected_loss.toFixed(2)}</td><td>${esc(r.timestamp)}</td>` +
      (qStatus === 'open' ? `<td class="qa"><button type="button" class="btn sm danger" data-a="fraud">Confirm fraud</button> <button type="button" class="btn sm light" data-a="normal">False alarm</button></td>`
        : `<td class="qa">${esc(outcome(r))} <button type="button" class="btn sm light" data-a="undo">Undo</button></td>`) + '</tr>').join('') + '</tbody>';
}
$('#q-open').onclick = () => { qStatus = 'open'; loadQueue(); };
$('#q-rev').onclick = () => { qStatus = 'reviewed'; loadQueue(); };
$('#t-queue').addEventListener('click', async e => {
  const b = e.target.closest('.qa button'); if (!b) return;
  const tr = b.closest('tr'), a = b.dataset.a;
  await post('/api/feedback', { id: tr.dataset.id, value: a === 'undo' ? 'none' : fbValue(tr.dataset.pred, a === 'fraud') });
  toast(a === 'undo' ? 'Decision cleared.' : 'Decision saved.', 'success'); loadQueue();
});

const drawer = $('#drawer'); let lastFocus = null;
function closeDrawer() { drawer.classList.add('hidden'); $('#overlay').classList.add('hidden'); lastFocus?.focus(); }
$('#drawer-close').onclick = closeDrawer;
$('#overlay').onclick = () => { closeDrawer(); closeMenu(); };
document.addEventListener('keydown', e => { if (e.key === 'Escape') { if (!drawer.classList.contains('hidden')) closeDrawer(); closeMenu(); } });
document.addEventListener('click', async e => {
  const tr = e.target.closest('tr.clickable'); if (!tr || e.target.closest('button')) return;
  lastFocus = document.activeElement;
  try {
    const r = await api('/api/transaction/' + encodeURIComponent(tr.dataset.id)), fraud = r.prediction === 'FRAUD';
    $('#drawer-body').innerHTML = `<h3>Transaction ${esc(r.id)}</h3>
      <div class="verdict ${fraud ? 'fraud' : 'normal'}"><div class="big ${fraud ? 'red' : 'green'}">${r.prediction}</div><div>Fraud probability <b>${r.probability}%</b> · Risk ${badge(r.risk, r.risk)}</div></div>
      <div class="kv"><span>Amount</span><span>$${r.amount.toFixed(2)}</span><span>Timestamp</span><span>${esc(r.timestamp)}</span><span>Review status</span><span>${esc(outcome(r))}</span></div>
      ${costNote(r)}${anomNote(r)}${explainHtml(r.explanation) || '<p class="muted">No stored features for this transaction, so no explanation is available.</p>'}
      <h3>Analyst decision</h3>
      <div class="row"><button type="button" class="btn danger" data-a="fraud">Confirm fraud</button><button type="button" class="btn light" data-a="normal">False alarm</button><button type="button" class="btn ghost" data-a="undo">Clear</button></div>`;
    $('#drawer-body').onclick = async ev => {
      const b = ev.target.closest('button[data-a]'); if (!b) return;
      await post('/api/feedback', { id: r.id, value: b.dataset.a === 'undo' ? 'none' : fbValue(r.prediction, b.dataset.a === 'fraud') });
      toast('Decision saved.', 'success'); closeDrawer();
      const act = document.querySelector('.page.active').id; ({ queue: loadQueue, history: loadHistory, dashboard: loadDashboard })[act]?.();
    };
    drawer.classList.remove('hidden'); $('#overlay').classList.remove('hidden'); $('#drawer-close').focus();
  } catch (_) {}
});

/* ---------- performance ---------- */
$$('.subtab').forEach(b => b.onclick = () => {
  $$('.subtab').forEach(x => x.classList.toggle('active', x === b));
  $$('.sub').forEach(s => s.classList.toggle('active', s.id === b.dataset.sub));
});
async function loadMetrics() {
  await loadModelInfo();
  const m = M;
  $('#m-size').textContent = `Test set: ${fmt(m.test_size)} transactions (${m.test_fraud} fraud).`;
  $('#m-thr').textContent = `(threshold ${m.threshold})`;
  $('#m-cards').innerHTML = cardsHtml([['Accuracy', pct(m.accuracy)], ['Precision', pct(m.precision)], ['Recall', pct(m.recall)], ['F1 Score', pct(m.f1)], ['ROC-AUC', m.roc_auc.toFixed(4)]]);
  const c = m.confusion_matrix;
  $('#m-cm').innerHTML = `<div class="cm"><div></div><div class="h">Pred. Normal</div><div class="h">Pred. Fraud</div>
    <div class="h">Actual Normal</div><div class="ok"><b>${fmt(c.tn)}</b>True Negative</div><div class="bad"><b>${fmt(c.fp)}</b>False Positive</div>
    <div class="h">Actual Fraud</div><div class="bad"><b>${fmt(c.fn)}</b>False Negative</div><div class="ok"><b>${fmt(c.tp)}</b>True Positive</div></div>`;
  $('#m-roc').innerHTML = rocSvg(m.roc_curve.fpr, m.roc_curve.tpr);
  const tf = m.top_features || [], mx = Math.max(...tf.map(f => f.importance), 1e-9);
  $('#m-feat').innerHTML = tf.map(f => `<div class="exrow"><span>${esc(f.feature)}</span><div class="exbar"><i style="left:0;width:${100 * f.importance / mx}%;background:#a78bfa"></i></div><span>${(f.importance * 100).toFixed(1)}%</span></div>`).join('');
  // improvement table
  const cv = m.cv, cb = m.cv_baseline, names = { precision: 'Precision', recall: 'Recall', f1: 'F1', roc_auc: 'ROC-AUC', pr_auc: 'PR-AUC' };
  $('#t-improve').innerHTML = cv && cb ? '<tr><th>Metric</th><th>Notebook baseline</th><th>Improved</th><th>Change</th></tr>' + Object.keys(names).map(k => {
    const d = cv[k].mean - cb[k].mean;
    return `<tr><td>${names[k]}</td><td>${cb[k].mean.toFixed(4)} ±${cb[k].std.toFixed(4)}</td><td>${cv[k].mean.toFixed(4)} ±${cv[k].std.toFixed(4)}</td><td class="${d >= 0 ? 'green' : 'red'}">${d >= 0 ? '+' : ''}${d.toFixed(4)}</td></tr>`; }).join('') : '<tr><td class="muted">Run train.py to generate.</td></tr>';
  $('#improve-note').textContent = `Changes: larger tuned XGBoost, engineered features (${(m.engineered_features || []).join(', ')}), and a decision threshold (${m.recommended_threshold}) chosen from out-of-fold training predictions. Changes at threshold 0.5 are small; the threshold change mostly shifts the precision/recall balance.`;
  // models tab
  const cmp = m.comparison || [];
  $('#t-compare').innerHTML = cmp.length ? '<tr><th>Model</th><th>Precision</th><th>Recall</th><th>F1</th><th>ROC-AUC</th><th>PR-AUC</th></tr>' +
    cmp.map(r => `<tr class="${r.model.includes('primary') ? 'best' : ''}"><td>${esc(r.model)}</td><td>${pct(r.precision)}</td><td>${pct(r.recall)}</td><td>${pct(r.f1)}</td><td>${r.roc_auc.toFixed(4)}</td><td>${r.pr_auc.toFixed(4)}</td></tr>`).join('') : '<tr><td class="muted">Run train.py to generate.</td></tr>';
  $('#cv-note').textContent = `The test split has only ${m.test_fraud} frauds, so one missed fraud moves recall by about ${(100 / m.test_fraud).toFixed(1)} points. Prefer the cross-validation numbers when comparing models.`;
  const t = m.temporal, xr = cmp.find(c => c.model.includes('primary')) || cmp[0];
  $('#m-temporal').innerHTML = t && xr ? `<p class="muted">Train on the earliest 80% of transactions, test on the latest 20% (${t.test_fraud} frauds). Closer to real deployment than a random split.</p>
    <div class="tablewrap"><table><tr><th>Split</th><th>Precision</th><th>Recall</th><th>F1</th><th>PR-AUC</th></tr>
    <tr><td>Random 80/20</td><td>${pct(xr.precision)}</td><td>${pct(xr.recall)}</td><td>${pct(xr.f1)}</td><td>${xr.pr_auc.toFixed(4)}</td></tr>
    <tr><td>Time-based</td><td>${pct(t.precision)}</td><td>${pct(t.recall)}</td><td>${pct(t.f1)}</td><td>${t.pr_auc.toFixed(4)}</td></tr></table></div><p class="muted">Both at threshold 0.5.</p>` : '<span class="muted">Run train.py to generate.</span>';
  const a = m.anomaly;
  $('#m-anom').innerHTML = a ? `<p class="muted">Unsupervised second opinion shown next to each prediction. XGBoost stays primary. Flag = score ≥ 99.</p>
    <p>ROC-AUC (score alone): <b>${a.roc_auc.toFixed(3)}</b><br>Frauds missed by XGBoost that it flags: <b>${a.missed_caught} of ${a.missed_frauds}</b><br>Normal transactions it flags: <b>${pct(a.normal_flag_rate)}</b><br>As an override (XGBoost OR anomaly): recall ${pct(a.combined_recall)}, precision ${pct(a.combined_precision)}</p>
    <p class="muted">Precision collapses as an override, so it is advisory only.</p>` : '<span class="muted">Not available.</span>';
  // reliability
  const cal = m.calibration;
  if (cal) {
    const bins = cal.used ? cal.bins_cal : cal.bins_raw;
    $('#m-cal').innerHTML = `<p class="muted">Does “90% fraud” mean 90 in 100? Predicted vs observed fraud rate on the test set. Platt scaling is fitted on out-of-fold training predictions and applied only if it lowers the Brier score.</p>
      <p>Brier: raw <b>${cal.brier_raw.toFixed(6)}</b> vs calibrated <b>${cal.brier_cal.toFixed(6)}</b> · ECE: raw <b>${cal.ece_raw.toFixed(5)}</b> vs calibrated <b>${cal.ece_cal.toFixed(5)}</b><br>Calibration applied: <b>${cal.used ? 'yes' : 'no (raw probabilities were already well calibrated)'}</b></p>
      <div class="tablewrap"><table><tr><th>Score range</th><th>Count</th><th>Avg predicted</th><th>Observed fraud rate</th></tr>${bins.map(b => `<tr><td>${(b.lo * 100).toFixed(0)}–${(b.hi * 100).toFixed(0)}%</td><td>${fmt(b.n)}</td><td>${pct(b.pred)}</td><td>${pct(b.obs)}</td></tr>`).join('')}</table></div>`;
  }
  $('#th-slider').value = m.threshold;
  renderThreshold(); loadStatus(); loadVersions();
}

/* threshold & cost */
const curveRow = t => M.threshold_curve.find(r => Math.abs(r.t - t) < 1e-6);
const costOf = r => r.fn_amount + (Number($('#th-cost').value) || 0) * r.flagged;
function renderThreshold() {
  if (!M) return;
  const t = Number($('#th-slider').value), r = curveRow(t); if (!r) return;
  $('#th-val').textContent = t.toFixed(2);
  $('#th-cards').innerHTML = cardsHtml([['Precision', pct(r.precision)], ['Recall', pct(r.recall)], ['Missed frauds', `${r.fn} / ${r.tp + r.fn}`], ['False alarms', fmt(r.fp)], ['Total cost', '$' + fmt(Math.round(costOf(r)))]]);
  const W = 520, H2 = 200, p = 30, n = M.threshold_curve.length, X = i => p + i * (W - 2 * p) / (n - 1), Y = v => H2 - p - v * (H2 - 2 * p);
  const line = (k, col) => `<polyline fill="none" stroke="${col}" stroke-width="2" points="${M.threshold_curve.map((q, i) => X(i) + ',' + Y(q[k])).join(' ')}"/>`;
  const cur = M.threshold_curve.findIndex(q => Math.abs(q.t - t) < 1e-6);
  $('#th-chart').innerHTML = `<svg width="${W}" height="${H2}" viewBox="0 0 ${W} ${H2}" role="img" aria-label="Precision and recall by threshold"><rect x="${p}" y="${p}" width="${W-2*p}" height="${H2-2*p}" fill="none" stroke="#eee6f1"/>
    ${line('precision', '#b3129b')}${line('recall', '#e11d48')}<line x1="${X(cur)}" x2="${X(cur)}" y1="${p}" y2="${H2-p}" stroke="#9ca3af" stroke-dasharray="4"/>
    <text x="${p}" y="${H2-10}" font-size="10" fill="#6f6879">0.05</text><text x="${W-p}" y="${H2-10}" font-size="10" text-anchor="end" fill="#6f6879">0.95</text>
    <text x="${W-p}" y="16" font-size="11" text-anchor="end"><tspan fill="#b3129b">● Precision</tspan> <tspan fill="#e11d48">● Recall</tspan></text></svg>`;
  const best = M.threshold_curve.reduce((a, b) => costOf(b) < costOf(a) ? b : a);
  $('#th-best').dataset.t = best.t;
  $('#th-note').textContent = `System threshold: ${M.threshold} · recommended (best F1 on training out-of-fold predictions): ${M.recommended_threshold} · lowest total cost for this review cost: ${best.t.toFixed(2)} ($${fmt(Math.round(costOf(best)))}).`;
}
$('#th-slider').oninput = renderThreshold; $('#th-cost').oninput = renderThreshold;
$('#th-best').onclick = e => { $('#th-slider').value = e.target.dataset.t; renderThreshold(); };
$('#th-rec').onclick = () => { $('#th-slider').value = M.recommended_threshold; renderThreshold(); };
$('#th-apply').onclick = async () => {
  const t = Number($('#th-slider').value);
  await post('/api/threshold', { threshold: t });
  toast('System threshold set to ' + t.toFixed(2) + '. New predictions use it.', 'success'); loadMetrics();
};

/* maintenance */
async function loadStatus() {
  const s = await api('/api/status');
  $('#mt-status').textContent = `Model ${s.version || ''} trained ${s.trained_at || 'n/a'} · feedback rows used in last training: ${s.feedback_rows_used} · pending analyst feedback: ${s.correct} correct, ${s.wrong} wrong.`;
}
$('#drift-btn').onclick = async () => {
  const d = await api('/api/drift');
  if (!d.enough) return $('#drift-out').innerHTML = `<div class="note">${esc(d.reason || `Need at least ${d.need} stored predictions (have ${d.n}). Upload a CSV batch to get there.`)}</div>`;
  const cls = d.status === 'Stable' ? 'ok' : 'warn';
  $('#drift-out').innerHTML = `<div class="note ${cls}"><b>${esc(d.status)}</b> · last ${d.n} predictions · ${d.features_over_0_1} feature(s) with PSI &gt; 0.1, ${d.features_over_0_25} with PSI &gt; 0.25 · fraud rate ${d.recent_fraud_pct}% recent vs ${d.baseline_fraud_pct}% in test data.</div>
    <div class="tablewrap"><table><tr><th>Most shifted feature</th><th>PSI</th></tr>${d.top.map(t => `<tr><td>${esc(t.feature)}</td><td>${t.psi}</td></tr>`).join('')}</table></div>
    <p class="muted">Batches with unusual fraud mixes will look drifted; this is a monitoring signal, not proof of a problem.</p>`;
};
async function loadVersions() {
  const d = await api('/api/versions');
  $('#t-versions').innerHTML = '<tr><th>Version</th><th>Trained</th><th>Precision</th><th>Recall</th><th>PR-AUC</th><th>Feedback rows</th><th></th></tr>' +
    `<tr class="best"><td>${esc(d.current || 'current')}</td><td>${esc(M.trained_at || '')}</td><td>${pct(M.precision)}</td><td>${pct(M.recall)}</td><td>${M.pr_auc.toFixed(4)}</td><td>${M.feedback_rows_used || 0}</td><td><b>Live</b></td></tr>` +
    d.versions.map(v => `<tr><td>${esc(v.id)}</td><td>${esc(v.trained_at || '')}</td><td>${pct(v.precision)}</td><td>${pct(v.recall)}</td><td>${v.pr_auc.toFixed(4)}</td><td>${v.feedback_rows_used}</td><td><button type="button" class="btn sm light" data-id="${esc(v.id)}">Roll back</button></td></tr>`).join('');
}
$('#t-versions').onclick = async e => {
  const b = e.target.closest('button[data-id]'); if (!b || !confirm('Roll back to ' + b.dataset.id + '? The current model is kept as a version too.')) return;
  await post('/api/rollback', { id: b.dataset.id }); toast('Rolled back to ' + b.dataset.id, 'success'); loadMetrics();
};
$('#retrain-btn').onclick = async () => {
  if (!confirm('Train a candidate model with analyst feedback? It goes live only if it passes the quality gate. This can take a few minutes.')) return;
  const btn = $('#retrain-btn'); busy(btn, true, 'Training candidate…');
  try {
    const r = await post('/api/retrain');
    $('#retrain-out').innerHTML = `<div class="note ${r.promoted ? 'ok' : 'warn'}"><b>${r.promoted ? 'Candidate passed the gate and is now live.' : 'Candidate did NOT pass the gate. The live model was kept.'}</b>
      Used ${r.used} feedback row(s). Gate: not worse than live by more than 0.01 PR-AUC / 0.005 ROC-AUC on the same test set.
      <table><tr><th>Check</th><th>Live</th><th>Candidate</th><th>Pass</th></tr>${r.checks.map(c => `<tr><td>${c.name}</td><td>${c.live}</td><td>${c.candidate}</td><td>${c.ok ? '✓' : '✗'}</td></tr>`).join('')}</table>
      ${r.promoted ? '' : '<div class="row"><button class="btn sm" id="promote-btn" type="button">Promote anyway</button></div>'}</div>`;
    const pb = $('#promote-btn');
    if (pb) pb.onclick = async () => { await post('/api/promote_candidate'); toast('Candidate promoted.', 'success'); $('#retrain-out').innerHTML = ''; loadMetrics(); };
    if (r.promoted) loadMetrics();
  } finally { busy(btn, false); }
};

/* ---------- init ---------- */
updateCount();
go(location.hash.slice(1) || 'dashboard');
loadModelInfo();
