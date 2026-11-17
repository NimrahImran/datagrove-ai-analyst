/* Datagrove — Analyze page
 * Upload → stream the 5-agent pipeline → interactive dashboard,
 * AI report, chat with your data, PDF and CSV downloads.
 */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var MAX_BYTES = 4 * 1024 * 1024;
  var SAFE_BYTES = 3.8 * 1024 * 1024;
  var AGENTS = ['understand', 'clean', 'analyze', 'visualize', 'report'];
  var COLORS = ['#6B6B2E', '#6B3F25', '#B08D57', '#8A8A45', '#A0522D', '#C9C58F', '#4A2E1C', '#D4A373', '#5C5C26', '#8A6A52'];
  var SAMPLES = {
    retail: { url: '/samples/retail-sales.csv', name: 'retail-sales.csv' },
    coffee: { url: '/samples/coffee-shop.csv', name: 'coffee-shop.csv' }
  };

  var state = {
    res: null, rows: [], view: [], idx: {}, filters: {}, drill: null,
    horizon: 3, chat: [], timer: null, t0: 0, fileName: '', busy: false
  };

  /* ---------------- helpers ---------------- */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmt(v, digits) {
    if (v == null || isNaN(v)) return '–';
    var a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (a >= 1e4) return (v / 1e3).toFixed(1) + 'K';
    return Number(v).toLocaleString(undefined, { maximumFractionDigits: digits == null ? 2 : digits });
  }
  function full(v) { return v == null ? '–' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }); }
  function bytes(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function show(el, on) { el.hidden = !on; }

  /* ---------------- upload ---------------- */
  var drop = $('drop'), input = $('fileInput'), upErr = $('uploadErr');

  $('browseBtn').addEventListener('click', function (e) { e.stopPropagation(); input.click(); });
  drop.addEventListener('click', function () { input.click(); });
  drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  input.addEventListener('change', function () { if (input.files[0]) handleFile(input.files[0]); input.value = ''; });
  ['dragenter', 'dragover'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', function (e) {
    var f = e.dataTransfer && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });
  document.querySelectorAll('[data-sample]').forEach(function (b) {
    b.addEventListener('click', function () { loadSample(b.getAttribute('data-sample')); });
  });

  function loadSample(key) {
    var s = SAMPLES[key];
    if (!s || state.busy) return;
    upErr.textContent = '';
    fetch(s.url).then(function (r) {
      if (!r.ok) throw new Error();
      return r.blob();
    }).then(function (blob) {
      run(new File([blob], s.name, { type: 'text/csv' }), 'Sample dataset');
    }).catch(function () { upErr.textContent = 'Could not load the sample. Please try again.'; });
  }

  function handleFile(file) {
    upErr.textContent = '';
    if (!/\.(csv|tsv|txt)$/i.test(file.name)) { upErr.textContent = 'Please choose a .csv file.'; return; }
    if (!file.size) { upErr.textContent = 'This file is empty.'; return; }
    if (file.size <= MAX_BYTES) { run(file); return; }
    // Large file: keep the header and an even sample of rows so it fits
    file.text().then(function (text) {
      var lines = text.split(/\r?\n/).filter(Boolean);
      var header = lines.shift();
      var keepShare = SAFE_BYTES / file.size;
      var step = Math.max(1, Math.ceil(1 / keepShare));
      var kept = [header];
      for (var i = 0; i < lines.length; i += step) kept.push(lines[i]);
      var small = new File([kept.join('\n')], file.name, { type: 'text/csv' });
      run(small, 'Large file: analyzed an even sample of ' + (kept.length - 1).toLocaleString() + ' of ' + lines.length.toLocaleString() + ' rows');
    }).catch(function () { upErr.textContent = 'Could not read this file.'; });
  }

  /* ---------------- live agents ---------------- */
  function resetAgents() {
    document.querySelectorAll('.ag').forEach(function (li) {
      li.className = 'ag';
      li.querySelector('.pill').textContent = 'Waiting';
      var more = li.querySelector('.ag-more'), det = li.querySelector('.ag-detail');
      more.hidden = true; det.hidden = true; det.innerHTML = '';
      li.querySelector('.ag-msg').textContent = li.querySelector('.ag-msg').getAttribute('data-default') || li.querySelector('.ag-msg').textContent;
    });
    $('apBar').style.width = '0%';
    show($('apError'), false);
  }
  document.querySelectorAll('.ag-msg').forEach(function (p) { p.setAttribute('data-default', p.textContent); });
  document.querySelectorAll('.ag-more').forEach(function (b) {
    b.addEventListener('click', function () {
      var d = b.nextElementSibling;
      d.hidden = !d.hidden;
      b.textContent = d.hidden ? 'See details' : 'Hide details';
    });
  });

  function agentDetail(name, detail) {
    if (!detail) return '';
    if (name === 'understand' && detail.schema) {
      return '<div class="tags">' + detail.schema.map(function (c) {
        return '<span>' + esc(c.name) + '<b>' + esc(c.type) + '</b></span>';
      }).join('') + '</div>' + (detail.metric ? '<p style="margin-top:8px">Main metric: <strong>' + esc(detail.metric) + '</strong></p>' : '');
    }
    if (name === 'clean' && detail.log) {
      if (!detail.log.length) return '<p>Your data was already clean. Nothing needed fixing.</p>';
      return '<ul>' + detail.log.map(function (l) { return '<li>' + esc(l.action) + ' (' + full(l.count) + ')' + (l.detail ? ': ' + esc(l.detail) : '') + '</li>'; }).join('') + '</ul>';
    }
    if (name === 'analyze' && detail.facts) return '<ul>' + detail.facts.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>';
    if (name === 'visualize' && detail.charts) return '<ul>' + detail.charts.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>';
    return '';
  }

  function setAgent(ev) {
    var li = document.querySelector('.ag[data-agent="' + ev.agent + '"]');
    if (!li) return;
    li.className = 'ag ' + ev.status;
    li.querySelector('.pill').textContent = ev.status === 'running' ? 'Working' : 'Done';
    li.querySelector('.ag-msg').textContent = ev.message;
    var html = agentDetail(ev.agent, ev.detail);
    if (html) {
      li.querySelector('.ag-detail').innerHTML = html;
      li.querySelector('.ag-more').hidden = false;
    }
    var done = document.querySelectorAll('.ag.done').length;
    $('apBar').style.width = Math.max(done * 20, ev.status === 'running' ? done * 20 + 8 : 0) + '%';
  }

  window.addEventListener('resize', function () {
    if (!window.Plotly) return;
    clearTimeout(state.rz);
    state.rz = setTimeout(function () { document.querySelectorAll('.plot,.mini').forEach(function (p) { if (p.data) window.Plotly.Plots.resize(p); }); }, 150);
  });
  function startTimer() {
    state.t0 = performance.now();
    clearInterval(state.timer);
    state.timer = setInterval(function () { $('apTimer').textContent = ((performance.now() - state.t0) / 1000).toFixed(1) + 's'; }, 100);
  }
  function stopTimer() { clearInterval(state.timer); }

  function fail(message) {
    stopTimer();
    state.busy = false;
    document.querySelectorAll('.ag.running').forEach(function (li) { li.className = 'ag'; li.querySelector('.pill').textContent = 'Stopped'; });
    var box = $('apError');
    box.querySelector('p').textContent = message;
    show(box, true);
  }
  $('retryBtn').addEventListener('click', resetToUpload);

  function run(file, note) {
    if (state.busy) return;
    state.busy = true;
    state.fileName = file.name;
    resetAgents();
    show($('stageUpload'), false);
    show($('stageResults'), false);
    show($('stageAgents'), true);
    $('apFile').textContent = file.name;
    $('apMeta').textContent = bytes(file.size) + (note ? ' · ' + note : '');
    $('apTimer').textContent = '0.0s';
    $('stageAgents').scrollIntoView({ behavior: 'smooth', block: 'start' });
    startTimer();

    var fd = new FormData();
    fd.append('file', file, file.name);
    var queue = [], finished = false, lastRun = 0;

    var consumer = (async function () {
      while (!finished || queue.length) {
        if (!queue.length) { await sleep(60); continue; }
        var ev = queue.shift();
        if (ev.type === 'agent') {
          if (ev.status === 'running') { lastRun = performance.now(); setAgent(ev); await sleep(120); }
          else { var wait = 650 - (performance.now() - lastRun); if (wait > 0) await sleep(wait); setAgent(ev); }
        } else if (ev.type === 'result') {
          await sleep(400);
          stopTimer();
          state.elapsed = ((performance.now() - state.t0) / 1000).toFixed(1);
          state.busy = false;
          renderResults(ev);
        } else if (ev.type === 'error') {
          fail(ev.message);
        }
      }
    })();

    fetch('/api/analyze', { method: 'POST', body: fd }).then(function (resp) {
      if (!resp.ok) {
        return resp.json().catch(function () { return {}; }).then(function (j) {
          throw new Error(j.detail || 'The server could not analyze this file (error ' + resp.status + ').');
        });
      }
      var reader = resp.body.getReader(), dec = new TextDecoder(), buf = '';
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) {
            if (buf.trim()) queue.push(JSON.parse(buf));
            finished = true;
            return;
          }
          buf += dec.decode(r.value, { stream: true });
          var lines = buf.split('\n');
          buf = lines.pop();
          lines.forEach(function (l) { if (l.trim()) { try { queue.push(JSON.parse(l)); } catch (e) { /* partial line */ } } });
          return pump();
        });
      }
      return pump();
    }).catch(function (err) {
      finished = true;
      fail(err && err.message && !/Failed to fetch|NetworkError/i.test(err.message) ? err.message : 'Could not reach the analysis server. Please check your connection and try again.');
    });
    return consumer;
  }

  /* ---------------- data helpers ---------------- */
  function col(name) { return state.idx[name]; }
  function num(v) { return typeof v === 'number' ? v : (v == null || v === '' ? NaN : Number(v)); }

  function aggregate(rows, xName, yName, agg) {
    var xi = col(xName), yi = yName ? col(yName) : null, m = new Map();
    rows.forEach(function (r) {
      var k = r[xi]; if (k == null) k = 'Unknown';
      var e = m.get(k) || { s: 0, n: 0 };
      if (yi != null) { var v = num(r[yi]); if (!isNaN(v)) { e.s += v; e.n++; } } else { e.n++; }
      m.set(k, e);
    });
    var out = [];
    m.forEach(function (e, k) {
      var v = yi == null || agg === 'count' ? e.n : (agg === 'mean' ? (e.n ? e.s / e.n : 0) : e.s);
      out.push({ k: String(k), v: v });
    });
    return out;
  }

  function periodKey(dateStr, unit) {
    if (unit === 'month') return dateStr.slice(0, 7) + '-01';
    if (unit === 'week') {
      var d = new Date(dateStr + 'T00:00:00Z'); var day = (d.getUTCDay() + 6) % 7;
      d.setUTCDate(d.getUTCDate() - day); return d.toISOString().slice(0, 10);
    }
    return dateStr.slice(0, 10);
  }
  function pickUnit(rows, dateName) {
    var di = col(dateName), min = null, max = null;
    rows.forEach(function (r) { var v = r[di]; if (!v) return; if (min === null || v < min) min = v; if (max === null || v > max) max = v; });
    if (!min) return 'day';
    var span = Math.max((new Date(max) - new Date(min)) / 864e5, 1), n = rows.length;
    if (span > 540 || n / (span / 30.4) < 2) return 'month';
    if (span > 120 || n / span < 1.5) return 'week';
    return 'day';
  }
  function timeSeries(rows, dateName, yName, agg) {
    var unit = pickUnit(state.rows, dateName);
    var di = col(dateName), yi = yName ? col(yName) : null, m = new Map(), lastDate = null;
    rows.forEach(function (r) {
      var d = r[di]; if (!d) return;
      if (!lastDate || d > lastDate) lastDate = d;
      var k = periodKey(d, unit), e = m.get(k) || { s: 0, n: 0 };
      if (yi != null) { var v = num(r[yi]); if (!isNaN(v)) { e.s += v; e.n++; } } else e.n++;
      m.set(k, e);
    });
    var keys = Array.from(m.keys()).sort();
    var vals = keys.map(function (k) { var e = m.get(k); return yi == null || agg === 'count' ? e.n : (agg === 'mean' ? e.s / Math.max(e.n, 1) : e.s); });
    if (unit === 'month' && lastDate && Number(lastDate.slice(8, 10)) < 25 && keys.length > 3) { keys.pop(); vals.pop(); }
    return { x: keys, y: vals, unit: unit };
  }
  function addPeriod(dateStr, unit, n) {
    var d = new Date(dateStr + 'T00:00:00Z');
    if (unit === 'month') d.setUTCMonth(d.getUTCMonth() + n);
    else d.setUTCDate(d.getUTCDate() + n * (unit === 'week' ? 7 : 1));
    return d.toISOString().slice(0, 10);
  }
  // Holt's linear trend — same method as the analysis agent
  function holt(y, h) {
    if (y.length < 4) return null;
    var best = null;
    [0.2, 0.35, 0.5, 0.65, 0.8].forEach(function (a) {
      [0.05, 0.15, 0.3].forEach(function (b) {
        var L = y[0], T = y[1] - y[0], sse = 0, res = [];
        for (var t = 1; t < y.length; t++) {
          var p = L + T; res.push(y[t] - p); sse += (y[t] - p) * (y[t] - p);
          var nL = a * y[t] + (1 - a) * (L + T); T = b * (nL - L) + (1 - b) * T; L = nL;
        }
        if (!best || sse < best.sse) best = { sse: sse, L: L, T: T, res: res };
      });
    });
    var mean = best.res.reduce(function (s, v) { return s + v; }, 0) / best.res.length;
    var sd = Math.sqrt(best.res.reduce(function (s, v) { return s + (v - mean) * (v - mean); }, 0) / best.res.length);
    var nonNeg = Math.min.apply(null, y) >= 0, f = [], lo = [], hi = [];
    for (var i = 1; i <= h; i++) {
      var p = best.L + i * best.T; if (nonNeg) p = Math.max(p, 0);
      var band = 1.28 * sd * Math.sqrt(i);
      f.push(p); lo.push(nonNeg ? Math.max(p - band, 0) : p - band); hi.push(p + band);
    }
    return { f: f, lo: lo, hi: hi };
  }
  function pearson(a, b) {
    var n = 0, sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
    for (var i = 0; i < a.length; i++) {
      var x = a[i], y = b[i]; if (isNaN(x) || isNaN(y)) continue;
      n++; sa += x; sb += y; saa += x * x; sbb += y * y; sab += x * y;
    }
    if (n < 3) return null;
    var cov = sab - sa * sb / n, va = saa - sa * sa / n, vb = sbb - sb * sb / n;
    return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : null;
  }

  /* ---------------- Plotly theme ---------------- */
  function baseLayout(extra) {
    var l = {
      paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)',
      font: { family: 'Inter, system-ui, sans-serif', color: '#4A2E1C', size: 12 },
      margin: { l: 56, r: 16, t: 12, b: 44 },
      hoverlabel: { bgcolor: '#3E2416', bordercolor: '#3E2416', font: { color: '#F3E9C6', family: 'Inter, sans-serif' } },
      xaxis: { gridcolor: 'rgba(107,63,37,0.08)', zerolinecolor: 'rgba(107,63,37,0.15)', automargin: true, tickfont: { size: 11 } },
      yaxis: { gridcolor: 'rgba(107,63,37,0.08)', zerolinecolor: 'rgba(107,63,37,0.15)', automargin: true, tickfont: { size: 11 } },
      legend: { orientation: 'h', y: -0.18, font: { size: 11 } },
      colorway: COLORS,
      modebar: { bgcolor: 'rgba(0,0,0,0)', color: '#8A6A52', activecolor: '#6B6B2E', orientation: 'h' }
    };
    return Object.assign(l, extra || {});
  }
  var plotConfig = { responsive: true, displaylogo: false, modeBarButtonsToRemove: ['lasso2d', 'select2d', 'autoScale2d', 'toggleSpikelines'], toImageButtonOptions: { format: 'png', filename: 'datagrove-chart', scale: 2 } };
  function draw(el, traces, layout) {
    if (!window.Plotly) { el.innerHTML = '<div class="empty-chart">Charts are loading…</div>'; return; }
    var cfg = el.classList.contains('mini') ? Object.assign({}, plotConfig, { displayModeBar: false }) : plotConfig;
    window.Plotly.react(el, traces, baseLayout(layout), cfg);
  }

  /* ---------------- results ---------------- */
  function renderResults(res) {
    state.res = res;
    state.idx = {};
    res.data.columns.forEach(function (c, i) { state.idx[c] = i; });
    state.rows = res.data.rows;
    state.filters = {};
    state.drill = null;
    state.horizon = 3;
    state.chat = [];

    var r = res.report || {};
    $('resTitle').textContent = r.title || res.name + ' analysis';
    $('resMeta').textContent = res.profile.rows.toLocaleString() + ' rows · ' + res.profile.columns + ' columns · analyzed in ' + state.elapsed + 's' +
      (res.data.sampled ? ' · charts use a ' + res.data.rows.length.toLocaleString() + '-row sample' : '');

    show($('stageResults'), true);
    buildFilters();
    buildChartCards();
    renderReport();
    renderQuality();
    setupChat();
    applyFilters();

    setTimeout(function () { $('stageResults').scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 150);
  }

  /* Filters */
  function buildFilters() {
    var a = state.res.analysis, box = $('filterFields'), html = '';
    (a.categories || []).slice(0, 2).forEach(function (c, i) {
      var values = Array.from(new Set(state.rows.map(function (r) { return r[col(c)]; }))).filter(function (v) { return v != null; }).sort();
      html += '<label>' + esc(c) + '<select class="select" data-filter="' + esc(c) + '"><option value="">All</option>' +
        values.slice(0, 200).map(function (v) { return '<option>' + esc(v) + '</option>'; }).join('') + '</select></label>';
    });
    if (a.date_col) {
      var di = col(a.date_col), ds = state.rows.map(function (r) { return r[di]; }).filter(Boolean).sort();
      var min = ds[0], max = ds[ds.length - 1];
      html += '<label>From<input class="input" type="date" data-from min="' + min + '" max="' + max + '" value="' + min + '"></label>' +
        '<label>To<input class="input" type="date" data-to min="' + min + '" max="' + max + '" value="' + max + '"></label>';
      state.dateRange = [min, max];
    }
    box.innerHTML = html;
    show($('filters'), !!html);
    box.querySelectorAll('select,input').forEach(function (el) { el.addEventListener('change', applyFilters); });
  }
  $('resetFilters').addEventListener('click', function () {
    $('filterFields').querySelectorAll('select').forEach(function (s) { s.value = ''; });
    var f = $('filterFields').querySelector('[data-from]'), t = $('filterFields').querySelector('[data-to]');
    if (f) f.value = state.dateRange[0];
    if (t) t.value = state.dateRange[1];
    state.drill = null;
    applyFilters();
  });

  function applyFilters() {
    var box = $('filterFields'), conds = [];
    box.querySelectorAll('select[data-filter]').forEach(function (s) {
      if (s.value) { var i = col(s.getAttribute('data-filter')), v = s.value; conds.push(function (r) { return String(r[i]) === v; }); }
    });
    var a = state.res.analysis;
    if (a.date_col) {
      var di = col(a.date_col), from = (box.querySelector('[data-from]') || {}).value, to = (box.querySelector('[data-to]') || {}).value;
      if (from) conds.push(function (r) { return r[di] && r[di] >= from; });
      if (to) conds.push(function (r) { return r[di] && r[di] <= to; });
    }
    state.view = conds.length ? state.rows.filter(function (r) { return conds.every(function (c) { return c(r); }); }) : state.rows;
    $('filterCount').textContent = 'Showing ' + state.view.length.toLocaleString() + ' of ' + state.rows.length.toLocaleString() + ' rows';
    renderKpis();
    drawCharts();
  }

  /* KPIs */
  function renderKpis() {
    var a = state.res.analysis, m = a.metric, v = state.view, cards = [];
    cards.push({ label: 'Rows in view', value: v.length.toLocaleString(), sub: 'of ' + state.res.profile.rows.toLocaleString() + ' total' });
    if (m) {
      var mi = col(m), s = 0, n = 0;
      v.forEach(function (r) { var x = num(r[mi]); if (!isNaN(x)) { s += x; n++; } });
      if (state.res.data.sampled) s = s * state.res.data.total_rows / state.rows.length;
      var t = a.trend;
      cards.push({ label: 'Total ' + m, value: fmt(s), sub: t ? (t.overall_change_pct >= 0 ? '▲ ' : '▼ ') + Math.abs(t.overall_change_pct) + '% first to latest ' + t.unit : (state.res.data.sampled ? 'estimated from sample' : 'sum of all rows') });
      cards.push({ label: 'Average ' + m, value: fmt(n ? s / (state.res.data.sampled ? n * state.res.data.total_rows / state.rows.length : n) : 0), sub: 'per row' });
    }
    var cats = a.categories || [];
    if (cats.length && m) {
      var top = aggregate(v, cats[0], m, 'sum').sort(function (x, y) { return y.v - x.v; })[0];
      cards.push({ label: 'Top ' + cats[0], value: top ? top.k : '–', sub: top ? fmt(top.v) + ' ' + m : '' });
    } else if (a.date_col) {
      cards.push({ label: 'Time span', value: (state.dateRange || []).join(' → '), sub: '' });
    }
    var q = state.res.cleaning.quality_score;
    var html = cards.slice(0, 4).map(function (c) { return '<div class="card kpi"><span>' + esc(c.label) + '</span><strong>' + esc(c.value) + '</strong><em>' + esc(c.sub) + '</em></div>'; }).join('');
    var fixes = state.res.cleaning.log.reduce(function (s, l) { return s + l.count; }, 0);
    html += '<div class="card kpi quality-kpi"><div class="ring" style="--p:' + q + '"><b>' + q + '</b></div><div><span>Data quality score</span><strong>' + (q >= 90 ? 'Excellent' : q >= 75 ? 'Good' : q >= 60 ? 'Fair' : 'Needs care') + '</strong><span>' + fixes.toLocaleString() + ' fixes applied</span></div></div>';
    $('kpiGrid').innerHTML = html;
  }

  /* Chart cards */
  function buildChartCards() {
    var grid = $('chartGrid');
    grid.querySelectorAll('.plot').forEach(function (p) { if (window.Plotly) window.Plotly.purge(p); });
    grid.innerHTML = state.res.charts.map(function (c) {
      var extra = '';
      if (c.type === 'trend') extra = '<div class="seg" role="group" aria-label="Forecast length"><button type="button" data-h="3" class="on">3</button><button type="button" data-h="6">6</button><button type="button" data-h="12">12</button></div>';
      if (c.type === 'bar' && c.drill) extra = '<span class="crumb" id="crumb"><span id="crumbText"></span><button type="button" id="crumbBack">Back</button></span>';
      var wide = c.type === 'trend' || (c.type === 'heatmap' && state.res.charts.length % 2 === 0) ? ' wide' : '';
      return '<article class="card chart-card' + wide + '"><div class="cc-head"><div><h3>' + esc(c.title) + '</h3><p>' + esc(c.why) + '</p></div>' + extra + '</div><div class="plot" id="plot-' + c.id + '"></div></article>';
    }).join('');
    grid.querySelectorAll('.seg button').forEach(function (b) {
      b.addEventListener('click', function () {
        grid.querySelectorAll('.seg button').forEach(function (x) { x.classList.toggle('on', x === b); });
        state.horizon = Number(b.getAttribute('data-h'));
        drawCharts();
      });
    });
    var back = $('crumbBack');
    if (back) back.addEventListener('click', function () { state.drill = null; drawCharts(); });
  }

  function drawCharts() {
    if (!window.Plotly) { setTimeout(drawCharts, 200); return; }
    state.res.charts.forEach(function (c) {
      var el = $('plot-' + c.id);
      if (!el) return;
      try { CHARTS[c.type](el, c, state.view); } catch (e) { el.innerHTML = '<div class="empty-chart">Not enough data for this chart.</div>'; }
    });
  }

  var CHARTS = {
    trend: function (el, c, rows) {
      var ts = timeSeries(rows, c.x, c.y, 'sum');
      if (ts.x.length < 2) { el.innerHTML = '<div class="empty-chart">Not enough dates in this filter.</div>'; return; }
      var fc = holt(ts.y, state.horizon), traces = [{
        x: ts.x, y: ts.y, type: 'scatter', mode: 'lines+markers', name: 'Actual ' + c.y,
        line: { color: '#6B3F25', width: 2.6, shape: 'spline', smoothing: 0.6 }, marker: { size: 5, color: '#6B3F25' },
        fill: 'tozeroy', fillcolor: 'rgba(107,63,37,0.07)',
        hovertemplate: '%{x|%d %b %Y}<br><b>%{y:,.2f}</b><extra>Actual</extra>'
      }];
      if (fc) {
        var last = ts.x[ts.x.length - 1], fx = [last];
        for (var i = 1; i <= state.horizon; i++) fx.push(addPeriod(last, ts.unit, i));
        var lastY = ts.y[ts.y.length - 1];
        traces.push({ x: fx, y: [lastY].concat(fc.hi), type: 'scatter', mode: 'lines', line: { width: 0 }, hoverinfo: 'skip', showlegend: false });
        traces.push({ x: fx, y: [lastY].concat(fc.lo), type: 'scatter', mode: 'lines', line: { width: 0 }, fill: 'tonexty', fillcolor: 'rgba(107,107,46,0.18)', name: '80% range', hoverinfo: 'skip' });
        traces.push({ x: fx, y: [lastY].concat(fc.f), type: 'scatter', mode: 'lines+markers', name: 'Forecast', line: { color: '#6B6B2E', width: 2.6, dash: 'dash' }, marker: { size: 6, color: '#6B6B2E' }, hovertemplate: '%{x|%d %b %Y}<br><b>%{y:,.2f}</b><extra>Forecast</extra>' });
      }
      var buttons = ts.unit === 'day' ? [{ count: 7, label: '7d', step: 'day', stepmode: 'backward' }, { count: 1, label: '1m', step: 'month', stepmode: 'backward' }, { step: 'all', label: 'All' }]
        : [{ count: 6, label: '6m', step: 'month', stepmode: 'backward' }, { count: 1, label: '1y', step: 'year', stepmode: 'backward' }, { step: 'all', label: 'All' }];
      var narrow = el.clientWidth < 560;
      draw(el, traces, {
        hovermode: 'x unified', margin: { l: 50, r: 12, t: narrow ? 30 : 34, b: 10 },
        xaxis: { type: 'date', gridcolor: 'rgba(107,63,37,0.06)', rangeslider: { visible: true, thickness: 0.08, bgcolor: 'rgba(243,233,198,0.6)', bordercolor: 'rgba(107,63,37,0.15)' },
          rangeselector: { visible: !narrow, buttons: buttons, x: 0, y: 1.12, bgcolor: 'rgba(107,63,37,0.08)', activecolor: '#6B6B2E', font: { size: 11, color: '#3E2416' } } },
        legend: { orientation: 'h', x: narrow ? 0 : 1, xanchor: narrow ? 'left' : 'right', y: narrow ? 1.16 : 1.14, font: { size: 10.5 } }
      });
    },

    bar: function (el, c, rows) {
      var agg = c.y ? 'sum' : 'count', data, xName = c.x;
      var crumb = $('crumb');
      if (state.drill && c.drill) {
        var xi = col(c.x);
        data = aggregate(rows.filter(function (r) { return String(r[xi]) === state.drill; }), c.drill, c.y, agg);
        xName = c.drill;
        if (crumb) { crumb.classList.add('show'); $('crumbText').textContent = c.x + ' › ' + state.drill; }
      } else if (crumb) crumb.classList.remove('show');
      data = (data || aggregate(rows, c.x, c.y, agg)).sort(function (a, b) { return b.v - a.v; }).slice(0, 15);
      var tight = el.clientWidth < 560;
      var colors = data.map(function (d, i) { return i === 0 ? '#6B6B2E' : (state.drill ? '#8A8A45' : '#6B3F25'); });
      draw(el, [{
        x: data.map(function (d) { return d.k; }), y: data.map(function (d) { return d.v; }), type: 'bar',
        marker: { color: colors, line: { width: 0 } },
        text: data.map(function (d) { return fmt(d.v); }), textposition: 'outside', cliponaxis: false, textfont: { size: tight ? 9.5 : 11, color: '#4A2E1C' },
        hovertemplate: '<b>%{x}</b><br>%{y:,.2f}<extra>' + esc(c.y || 'Rows') + '</extra>'
      }], { bargap: 0.35, xaxis: { automargin: true, tickangle: (tight && data.length > 3) || data.length > 6 ? -35 : 0, title: { text: xName, font: { size: 12 } } }, margin: { l: 56, r: 16, t: 24, b: 50 } });
      el.removeAllListeners && el.removeAllListeners('plotly_click');
      if (c.drill && !state.drill) {
        el.on('plotly_click', function (ev) { state.drill = String(ev.points[0].x); CHARTS.bar(el, c, state.view); });
      }
    },

    donut: function (el, c, rows) {
      var data = aggregate(rows, c.x, c.y, c.y ? 'sum' : 'count').sort(function (a, b) { return b.v - a.v; });
      if (data.length > 7) {
        var other = data.slice(6).reduce(function (s, d) { return s + d.v; }, 0);
        data = data.slice(0, 6).concat([{ k: 'Other', v: other }]);
      }
      draw(el, [{
        labels: data.map(function (d) { return d.k; }), values: data.map(function (d) { return d.v; }), type: 'pie', hole: 0.58, sort: false,
        marker: { colors: COLORS, line: { color: '#FFF6E2', width: 2 } }, textinfo: 'percent', textfont: { color: '#FFF6E2', size: 12 },
        hovertemplate: '<b>%{label}</b><br>%{value:,.2f}<br>%{percent}<extra></extra>'
      }], { margin: { l: 10, r: 10, t: 10, b: 10 }, showlegend: true, legend: { orientation: 'v', x: 1, y: 0.5, font: { size: 12 } } });
    },

    histogram: function (el, c, rows) {
      var xi = col(c.x), vals = rows.map(function (r) { return num(r[xi]); }).filter(function (v) { return !isNaN(v); }).sort(function (a, b) { return a - b; });
      var cut = vals[Math.floor(vals.length * 0.99)] || vals[vals.length - 1];
      var shown = vals.filter(function (v) { return v <= cut; });
      var mean = shown.reduce(function (s, v) { return s + v; }, 0) / Math.max(shown.length, 1);
      draw(el, [{ x: shown, type: 'histogram', nbinsx: 30, marker: { color: 'rgba(107,107,46,0.85)', line: { color: '#FFF6E2', width: 1 } }, hovertemplate: '%{x}<br>%{y} rows<extra></extra>' }],
        { bargap: 0.04, shapes: [{ type: 'line', x0: mean, x1: mean, yref: 'paper', y0: 0, y1: 1, line: { color: '#6B3F25', width: 2, dash: 'dot' } }],
          annotations: [{ x: mean, yref: 'paper', y: 1, text: 'avg ' + fmt(mean), showarrow: false, yanchor: 'bottom', font: { size: 11, color: '#6B3F25' } }],
          xaxis: { title: { text: c.x + (vals.length > shown.length ? ' (top 1% hidden)' : ''), font: { size: 12 } } }, yaxis: { title: { text: 'Rows', font: { size: 12 } } }, margin: { l: 56, r: 16, t: 22, b: 50 } });
    },

    scatter: function (el, c, rows) {
      var xi = col(c.x), yi = col(c.y), ci = c.color ? col(c.color) : null;
      var sample = rows.length > 2500 ? rows.filter(function (_, i) { return i % Math.ceil(rows.length / 2500) === 0; }) : rows;
      var groups = new Map();
      sample.forEach(function (r) {
        var g = ci != null ? String(r[ci]) : 'All', e = groups.get(g) || { x: [], y: [] };
        e.x.push(num(r[xi])); e.y.push(num(r[yi])); groups.set(g, e);
      });
      var traces = [], i = 0;
      Array.from(groups.keys()).slice(0, 8).forEach(function (g) {
        var e = groups.get(g);
        traces.push({ x: e.x, y: e.y, name: g, type: 'scatter', mode: 'markers', marker: { size: 7, opacity: 0.6, color: COLORS[i++ % COLORS.length], line: { width: 0 } }, hovertemplate: '<b>' + esc(g) + '</b><br>' + esc(c.x) + ': %{x:,.2f}<br>' + esc(c.y) + ': %{y:,.2f}<extra></extra>' });
      });
      draw(el, traces, { xaxis: { title: { text: c.x, font: { size: 12 } } }, yaxis: { title: { text: c.y, font: { size: 12 } } }, showlegend: groups.size > 1, legend: { orientation: 'h', y: -0.32, font: { size: 11 } }, margin: { l: 56, r: 16, t: 12, b: 50 } });
    },

    heatmap: function (el, c, rows) {
      var names = c.columns, arrays = names.map(function (n) { var i = col(n); return rows.map(function (r) { return num(r[i]); }); });
      var z = names.map(function (_, a) { return names.map(function (_, b) { var r = a === b ? 1 : pearson(arrays[a], arrays[b]); return r == null ? null : Math.round(r * 100) / 100; }); });
      draw(el, [{
        z: z, x: names, y: names, type: 'heatmap', zmin: -1, zmax: 1,
        colorscale: [[0, '#6B3F25'], [0.5, '#FFF6E2'], [1, '#6B6B2E']],
        text: z.map(function (row) { return row.map(function (v) { return v == null ? '' : v.toFixed(2); }); }), texttemplate: '%{text}', textfont: { size: 11 },
        hovertemplate: '%{y} × %{x}<br><b>r = %{z}</b><extra></extra>', colorbar: { thickness: 10, outlinewidth: 0, tickfont: { size: 10 } }
      }], { margin: { l: 90, r: 10, t: 10, b: 80 }, xaxis: { tickangle: -30, automargin: true }, yaxis: { automargin: true, autorange: 'reversed' } });
    }
  };

  /* Report */
  var REC_ICONS = [
    '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
    '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>'
  ];
  function renderReport() {
    var r = state.res.report || {};
    $('sumTitle').textContent = r.title || 'Executive summary';
    $('sumText').textContent = r.summary || '';
    $('sumNote').textContent = r.data_notes || '';
    $('insightList').innerHTML = (r.insights || []).map(function (i) { return '<li><div><strong>' + esc(i.title) + '</strong><span>' + esc(i.detail) + '</span></div></li>'; }).join('');
    $('recGrid').innerHTML = (r.recommendations || []).map(function (x, i) {
      return '<div class="card rec"><span class="ico' + (i % 2 ? ' walnut' : '') + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + REC_ICONS[i % 4] + '</svg></span><strong>' + esc(x.title) + '</strong><p>' + esc(x.detail) + '</p></div>';
    }).join('');
  }

  function renderQuality() {
    var c = state.res.cleaning;
    $('cleanLog').innerHTML = c.log.length ? c.log.map(function (l) {
      return '<li><i></i><div>' + esc(l.action) + (l.detail ? '<small>' + esc(l.detail) + '</small>' : '') + '</div><b>' + full(l.count) + '</b></li>';
    }).join('') : '<li><i></i><div>Your data was already clean. Nothing needed fixing.</div><b>0</b></li>';
    var schema = state.res.profile.schema;
    $('schemaMeta').textContent = schema.length + ' columns detected';
    $('schemaTable').querySelector('tbody').innerHTML = schema.map(function (s) {
      return '<tr><td>' + esc(s.name) + '</td><td><span class="type ' + esc(s.type) + '">' + esc(s.type) + '</span></td><td>' + s.missing_pct + '%</td><td>' + s.unique.toLocaleString() + '</td></tr>';
    }).join('');
  }

  /* ---------------- chat ---------------- */
  function chatContext() {
    var res = state.res, a = res.analysis;
    return {
      name: res.name,
      schema: res.profile.schema.map(function (s) { return { name: s.name, type: s.type, unique: s.unique }; }).filter(function (s) { return s.name in state.idx; }),
      metric: a.metric, categories: a.categories, date_col: a.date_col, kpis: a.kpis, facts: a.facts,
      breakdowns: a.breakdowns, trend: a.trend, correlations: a.correlations, distributions: a.distributions
    };
  }
  function setupChat() {
    var a = state.res.analysis, m = a.metric, cats = a.categories || [], chips = [];
    if (cats[0] && m) chips.push('Which ' + cats[0] + ' has the highest ' + m + '?');
    if (a.date_col && m) chips.push('Show the ' + m + ' trend and forecast');
    if (m) chips.push('What is the average ' + m + '?');
    if (cats[1] && m) chips.push('Compare ' + m + ' by ' + cats[1]);
    if (!chips.length) chips.push('Summarize this data for me');
    $('chatChips').innerHTML = chips.map(function (c) { return '<button type="button">' + esc(c) + '</button>'; }).join('');
    $('chatChips').querySelectorAll('button').forEach(function (b) { b.addEventListener('click', function () { ask(b.textContent); }); });
    $('chatInput').placeholder = chips[0];
    var log = $('chatLog');
    log.querySelectorAll('.mini').forEach(function (p) { if (window.Plotly) window.Plotly.purge(p); });
    log.innerHTML = '<div class="msg bot">Hi! I have read <strong>' + esc(state.res.name) + '</strong>. Ask me anything about it, like which group performs best, how things change over time, or what to expect next.</div>';
  }
  $('chatForm').addEventListener('submit', function (e) { e.preventDefault(); ask($('chatInput').value); });
  $('chatInput').addEventListener('input', function () { $('chatErr').textContent = ''; });

  var chatBusy = false;
  function ask(q) {
    q = (q || '').trim();
    if (!q) { $('chatErr').textContent = 'Type a question first.'; return; }
    if (chatBusy || !state.res) return;
    chatBusy = true;
    $('chatInput').value = '';
    var log = $('chatLog');
    log.insertAdjacentHTML('beforeend', '<div class="msg user">' + esc(q) + '</div><div class="msg bot typing" id="typing"><span></span><span></span><span></span></div>');
    log.scrollTop = log.scrollHeight;
    var bubble = null, textEl = null, full = '', shown = 0, typer = null, pendingDone = null;
    function startTyper() {
      if (typer) return;
      typer = setInterval(function () {
        if (shown < full.length) {
          var step = Math.max(1, Math.ceil((full.length - shown) / 40));
          shown = Math.min(full.length, shown + step);
          textEl.textContent = full.slice(0, shown);
          log.scrollTop = log.scrollHeight;
        } else if (pendingDone) {
          clearInterval(typer); typer = null;
          var d = pendingDone; pendingDone = null; finish(d.answer, d.chart);
        }
      }, 18);
    }
    function ensureBubble() {
      if (bubble) return;
      var t = $('typing'); if (t) t.remove();
      log.insertAdjacentHTML('beforeend', '<div class="msg bot streaming"><div class="msg-text"></div></div>');
      bubble = log.lastElementChild; textEl = bubble.querySelector('.msg-text');
    }
    function finish(answer, chart) {
      ensureBubble();
      bubble.classList.remove('streaming');
      textEl.innerHTML = esc(answer || full).replace(/\n/g, '<br>');
      if (chart) {
        var id = 'mini-' + Date.now();
        bubble.insertAdjacentHTML('beforeend', '<div class="mini" id="' + id + '"></div>');
        chatChart($(id), chart);
      }
      state.chat.push({ role: 'user', text: q }, { role: 'assistant', text: answer || full });
      log.scrollTop = log.scrollHeight;
    }
    fetch('/api/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: q, context: chatContext(), history: state.chat.slice(-6) })
    }).then(function (r) {
      if (!r.ok || !r.body) throw new Error();
      var reader = r.body.getReader(), dec = new TextDecoder(), buf = '', done = false;
      function handle(line) {
        if (!line.trim()) return;
        var ev; try { ev = JSON.parse(line); } catch (e) { return; }
        if (ev.type === 'delta') {
          ensureBubble();
          full += ev.text;
          startTyper();
        } else if (ev.type === 'done') {
          done = true;
          if (typer) pendingDone = ev; else finish(ev.answer, ev.chart);
        }
      }
      function pump() {
        return reader.read().then(function (res) {
          if (res.done) { handle(buf); if (!done) { if (full) finish(full, null); else throw new Error(); } return; }
          buf += dec.decode(res.value, { stream: true });
          var lines = buf.split('\n'); buf = lines.pop();
          lines.forEach(handle);
          return pump();
        });
      }
      return pump();
    }).catch(function () {
      var t = $('typing'); if (t) t.remove();
      if (typer) { clearInterval(typer); typer = null; }
      if (bubble && full) { finish(full, null); return; }
      log.insertAdjacentHTML('beforeend', '<div class="msg bot">Sorry, I could not answer that right now. Please try again.</div>');
    }).finally(function () { chatBusy = false; });
  }

  function chatChart(el, spec) {
    var rows = state.rows, a = state.res.analysis;
    try {
      if (spec.type === 'line' && spec.x === a.date_col) {
        CHARTS.trend(el, { x: spec.x, y: spec.y || a.metric }, rows);
        return;
      }
      if (spec.type === 'scatter' && spec.y) { CHARTS.scatter(el, { x: spec.x, y: spec.y }, rows); return; }
      var data = aggregate(rows, spec.x, spec.y, spec.agg).sort(function (p, q) { return q.v - p.v; }).slice(0, spec.top || 10);
      if (spec.type === 'donut') {
        draw(el, [{ labels: data.map(function (d) { return d.k; }), values: data.map(function (d) { return d.v; }), type: 'pie', hole: 0.55, marker: { colors: COLORS, line: { color: '#FFF6E2', width: 2 } }, hovertemplate: '<b>%{label}</b><br>%{value:,.2f}<extra></extra>' }], { margin: { l: 10, r: 10, t: 10, b: 10 } });
      } else {
        draw(el, [{ x: data.map(function (d) { return d.k; }), y: data.map(function (d) { return d.v; }), type: spec.type === 'line' ? 'scatter' : 'bar', marker: { color: data.map(function (_, i) { return i === 0 ? '#6B6B2E' : '#6B3F25'; }) }, line: { color: '#6B3F25' }, hovertemplate: '<b>%{x}</b><br>%{y:,.2f}<extra></extra>' }],
          { margin: { l: 50, r: 10, t: 10, b: 40 }, xaxis: { tickangle: data.length > 6 ? -30 : 0, automargin: true } });
      }
    } catch (e) { el.remove(); }
  }

  /* ---------------- downloads ---------------- */
  function downloadBlob(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }
  function baseName() { return (state.fileName || 'data').replace(/\.[^.]+$/, ''); }

  $('csvBtn').addEventListener('click', function () {
    if (!state.res) return;
    var cols = state.res.data.columns;
    var q = function (v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var lines = [cols.map(q).join(',')].concat(state.view.map(function (r) { return r.map(q).join(','); }));
    downloadBlob(new Blob([lines.join('\n')], { type: 'text/csv' }), baseName() + '-cleaned.csv');
  });

  function pdfText(s) {
    return String(s == null ? '' : s).replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[·•]/g, '-').replace(/›/g, '>').replace(/[▲]/g, '+').replace(/[▼]/g, '-').replace(/→/g, 'to').replace(/[^\x20-\x7E\xA0-\xFF\n]/g, '');
  }

  $('pdfBtn').addEventListener('click', function () {
    if (!state.res || !window.jspdf) return;
    var btn = $('pdfBtn'), label = btn.innerHTML;
    btn.disabled = true; btn.textContent = 'Preparing PDF…';
    buildPdf().catch(function () { alertInline('Could not build the PDF. Please try again.'); }).finally(function () { btn.disabled = false; btn.innerHTML = label; });
  });
  function alertInline(msg) { $('resMeta').textContent = msg; }

  async function buildPdf() {
    var doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
    var W = 210, H = 297, M = 16, y = 0, res = state.res, r = res.report || {};
    var WALNUT = [62, 36, 22], OLIVE = [107, 107, 46], INK = [74, 46, 28], SOFT = [138, 106, 82], BUTTER = [255, 246, 226];

    function header() {
      doc.setFillColor.apply(doc, WALNUT); doc.rect(0, 0, W, 14, 'F');
      doc.setTextColor(243, 233, 198); doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text('Datagrove', M, 9);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.text('AI data analysis report', W - M, 9, { align: 'right' });
      y = 24;
    }
    function ensure(h) { if (y + h > H - 18) { doc.addPage(); header(); } }
    function h2(t) { ensure(14); doc.setTextColor.apply(doc, WALNUT); doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.text(pdfText(t), M, y); y += 3; doc.setDrawColor.apply(doc, OLIVE); doc.setLineWidth(0.6); doc.line(M, y, M + 18, y); y += 7; }
    function para(t, size, color) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(size || 10.5); doc.setTextColor.apply(doc, color || INK);
      var lines = doc.splitTextToSize(pdfText(t), W - 2 * M);
      lines.forEach(function (l) { ensure(6); doc.text(l, M, y); y += (size || 10.5) * 0.48; });
      y += 2;
    }

    // Cover block
    header();
    doc.setFillColor.apply(doc, BUTTER); doc.roundedRect(M, y, W - 2 * M, 40, 4, 4, 'F');
    doc.setTextColor.apply(doc, WALNUT); doc.setFont('helvetica', 'bold'); doc.setFontSize(20);
    doc.text(doc.splitTextToSize(pdfText(r.title || res.name + ' analysis'), W - 2 * M - 12), M + 6, y + 13);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor.apply(doc, SOFT);
    doc.text(pdfText(res.name + '  -  ' + res.profile.rows.toLocaleString() + ' rows, ' + res.profile.columns + ' columns  -  ' + new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })), M + 6, y + 32);
    y += 50;

    // KPIs
    var kpis = Array.from(document.querySelectorAll('#kpiGrid .kpi')).slice(0, 4).map(function (k) { return [k.querySelector('span').textContent, k.querySelector('strong').textContent]; });
    kpis.push(['Data quality', res.cleaning.quality_score + '/100']);
    var bw = (W - 2 * M - 4 * 4) / 5;
    kpis.slice(0, 5).forEach(function (k, i) {
      var x = M + i * (bw + 4);
      doc.setDrawColor(230, 214, 186); doc.setFillColor(255, 251, 241); doc.roundedRect(x, y, bw, 20, 3, 3, 'FD');
      doc.setFontSize(7.5); doc.setTextColor.apply(doc, SOFT); doc.text(doc.splitTextToSize(pdfText(k[0]), bw - 4)[0], x + 3, y + 6);
      doc.setFontSize(11.5); doc.setFont('helvetica', 'bold'); doc.setTextColor.apply(doc, WALNUT); doc.text(doc.splitTextToSize(pdfText(k[1]), bw - 4)[0], x + 3, y + 14); doc.setFont('helvetica', 'normal');
    });
    y += 30;

    h2('Executive summary');
    para(r.summary);
    if (r.data_notes) para(r.data_notes, 9, SOFT);

    h2('Key insights');
    (r.insights || []).forEach(function (it, i) {
      ensure(14);
      doc.setFillColor.apply(doc, OLIVE); doc.circle(M + 2.5, y - 1.3, 2.6, 'F');
      doc.setTextColor(255, 255, 255); doc.setFontSize(8); doc.setFont('helvetica', 'bold'); doc.text(String(i + 1), M + 2.5, y, { align: 'center' });
      doc.setTextColor.apply(doc, WALNUT); doc.setFontSize(11); doc.text(pdfText(it.title), M + 8, y);
      y += 5; doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor.apply(doc, INK);
      doc.splitTextToSize(pdfText(it.detail), W - 2 * M - 8).forEach(function (l) { ensure(6); doc.text(l, M + 8, y); y += 4.8; });
      y += 2.5;
    });

    h2('Recommendations');
    (r.recommendations || []).forEach(function (it) {
      var lines = doc.splitTextToSize(pdfText(it.detail), W - 2 * M - 10);
      var h = 9 + lines.length * 4.8;
      ensure(h + 3);
      doc.setFillColor(255, 251, 241); doc.setDrawColor(230, 214, 186); doc.roundedRect(M, y - 5, W - 2 * M, h, 3, 3, 'FD');
      doc.setFillColor.apply(doc, OLIVE); doc.rect(M, y - 5, 1.6, h, 'F');
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor.apply(doc, WALNUT); doc.text(pdfText(it.title), M + 6, y + 0.5);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor.apply(doc, INK);
      lines.forEach(function (l, i) { doc.text(l, M + 6, y + 6 + i * 4.8); });
      y += h + 4;
    });

    // Charts as images
    var plots = res.charts.map(function (c) { return { c: c, el: $('plot-' + c.id) }; }).filter(function (p) { return p.el && p.el.data; });
    if (plots.length) { doc.addPage(); header(); h2('Charts'); }
    for (var i = 0; i < plots.length; i++) {
      var p = plots[i];
      var url = await window.Plotly.toImage(p.el, { format: 'png', width: 1100, height: 560, scale: 1.5 });
      var iw = W - 2 * M, ih = iw * 560 / 1100;
      ensure(ih + 12);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.setTextColor.apply(doc, WALNUT); doc.text(pdfText(p.c.title), M, y); y += 3;
      doc.addImage(url, 'PNG', M, y, iw, ih); y += ih + 8;
    }

    h2('Data cleaning log');
    if (!res.cleaning.log.length) para('Your data was already clean.');
    res.cleaning.log.forEach(function (l) { para('- ' + l.action + ' (' + l.count + ')' + (l.detail ? ': ' + l.detail : ''), 9.5); });

    // Footer on every page
    var pages = doc.getNumberOfPages();
    for (var pg = 1; pg <= pages; pg++) {
      doc.setPage(pg);
      doc.setFontSize(8); doc.setTextColor.apply(doc, SOFT);
      doc.text('Built by Nimra Imran  -  Datagrove', M, H - 8);
      doc.text(pg + ' / ' + pages, W - M, H - 8, { align: 'right' });
    }
    doc.save(baseName() + '-datagrove-report.pdf');
  }

  /* ---------------- reset ---------------- */
  function resetToUpload() {
    stopTimer();
    state.busy = false;
    show($('stageAgents'), false);
    show($('stageResults'), false);
    show($('stageUpload'), true);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
  $('newBtn').addEventListener('click', resetToUpload);

  // Deep link: /analyze?sample=retail
  var params = new URLSearchParams(location.search);
  if (params.get('sample') && SAMPLES[params.get('sample')]) {
    window.addEventListener('load', function () { loadSample(params.get('sample')); });
  }
})();
