/* =============================================================================
 * REPORT — вычисление блоков A–E из сырых данных и их рендер в DOM.
 *
 * compute(input) -> model   (чистые вычисления, без DOM)
 * render(model, state)      -> рисует карточки, график, воронку, таблицу
 *
 * input = {
 *   deals, history,            // текущий период
 *   prevDeals, prevHistory,    // предыдущий аналогичный период (для тренда D)
 *   refs, converter, state
 * }
 * ===========================================================================*/
window.REPORT = (function () {
  let lastModel = null;
  let _deals = null;   // нормализованные сделки текущего периода (для пересчёта C/сегментов без перезагрузки)
  let _refs = null;

  /* --- нормализация сделок: считаем USD и применяем фильтр по сумме -------- */
  function normalizeDeals(deals, converter, state) {
    const sumFrom = state.sumFrom !== '' ? Number(state.sumFrom) : null;
    const sumTo = state.sumTo !== '' ? Number(state.sumTo) : null;
    const out = [];
    (deals || []).forEach((d) => {
      const usd = converter(d.OPPORTUNITY, d.CURRENCY_ID);
      if (sumFrom != null && usd < sumFrom) return;
      if (sumTo != null && usd > sumTo) return;
      out.push({
        id: d.ID,
        usd,
        categoryId: String(d.CATEGORY_ID),
        stageId: d.STAGE_ID,
        assignedId: String(d.ASSIGNED_BY_ID),
        sourceId: d.SOURCE_ID,
        dateField: d[state.dateType],
        project: CONFIG.ufEnabled.project ? d[CONFIG.uf.project] : null,
        agency: CONFIG.ufEnabled.agency ? d[CONFIG.uf.agency] : null,
        agent: CONFIG.ufEnabled.agent ? d[CONFIG.uf.agent] : null,
      });
    });
    return out;
  }

  /* --- A. Сводные ---------------------------------------------------------- */
  function blockA(deals) {
    const total = deals.reduce((s, d) => s + d.usd, 0);
    const count = deals.length;
    return { total, count, avg: count ? total / count : 0 };
  }

  /* --- B. Сегментация по коридорам сумм ----------------------------------- */
  function blockB(deals) {
    const t = CONFIG.thresholds; // [100k,200k,500k]
    const buckets = [
      { label: `до ${UTIL.money(t[0])}`, test: (v) => v < t[0] },
      { label: `${UTIL.money(t[0])}–${UTIL.money(t[1])}`, test: (v) => v >= t[0] && v < t[1] },
      { label: `${UTIL.money(t[1])}–${UTIL.money(t[2])}`, test: (v) => v >= t[1] && v < t[2] },
      { label: `${UTIL.money(t[2])}+`, test: (v) => v >= t[2] },
    ].map((b) => ({ label: b.label, count: 0, sum: 0, test: b.test }));
    deals.forEach((d) => {
      const b = buckets.find((x) => x.test(d.usd));
      if (b) { b.count++; b.sum += d.usd; }
    });
    return buckets.map((b) => ({ label: b.label, count: b.count, sum: b.sum }));
  }

  /* --- C. Динамика по времени с разрезом ----------------------------------
   * breakdown: projects|managers|funnels -> ключ группировки.
   */
  function breakdownKey(d, breakdown, refs) {
    if (breakdown === 'managers') return refs.users[d.assignedId] || ('ID ' + d.assignedId);
    if (breakdown === 'funnels') {
      const c = refs.categories.find((x) => String(x.id) === d.categoryId);
      return c ? c.name : ('Воронка ' + d.categoryId);
    }
    if (breakdown === 'agencies') {
      if (!CONFIG.ufEnabled.agency) return 'Все';
      return labelUf('agency', d.agency, refs) || 'Без агентства';
    }
    if (breakdown === 'agents') {
      if (!CONFIG.ufEnabled.agent) return 'Все';
      return labelUf('agent', d.agent, refs) || 'Без агента';
    }
    // projects (по умолчанию)
    if (CONFIG.ufEnabled.project) {
      return labelUf('project', d.project, refs) || 'Без проекта';
    }
    return 'Все';
  }

  function labelUf(key, value, refs) {
    if (value == null || value === '') return null;
    const vals = (refs.ufValues && refs.ufValues[key]) || [];
    const found = vals.find((v) => String(v.value) === String(value));
    return found ? found.label : String(value);
  }

  function blockC(deals, state, refs) {
    const gran = state.granularity;
    const xKeys = UTIL.bucketRange(state.from, state.to, gran);
    const xLabels = xKeys.map((k) => UTIL.bucketLabel(k, gran));
    const byKey = {}; // { seriesName: { bucketKey: {sum,cnt} } }

    deals.forEach((d) => {
      const dt = UTIL.parseDate(d.dateField);
      if (!dt) return;
      const bk = UTIL.bucketKey(dt, gran);
      const sk = breakdownKey(d, state.breakdown, refs);
      if (!byKey[sk]) byKey[sk] = {};
      if (!byKey[sk][bk]) byKey[sk][bk] = { sum: 0, cnt: 0 };
      byKey[sk][bk].sum += d.usd;
      byKey[sk][bk].cnt += 1;
    });
    return { xKeys, xLabels, byKey };
  }

  /* --- D. Воронка по выбранной категории ----------------------------------
   * Использует историю стадий: «достиг этапа» = есть запись истории с этим
   * STAGE_ID для OWNER_ID. count = число сделок, достигших этапа; sum = сумма
   * их OPPORTUNITY (USD) из текущего датасета сделок.
   */
  function buildFunnel(categoryId, stagesByCat, dealsUsdById, history) {
    const stages = (stagesByCat[categoryId] || []).slice(); // уже отсортированы по SORT
    // owners, достигшие каждого этапа
    const reached = {}; // stageId -> Set(ownerId)
    stages.forEach((s) => { reached[s.STATUS_ID] = new Set(); });
    (history || []).forEach((h) => {
      if (String(h.CATEGORY_ID) !== String(categoryId)) return;
      if (reached[h.STAGE_ID]) reached[h.STAGE_ID].add(String(h.OWNER_ID));
    });

    const rows = stages.map((s) => {
      const owners = Array.from(reached[s.STATUS_ID] || []);
      const count = owners.length;
      let sum = 0;
      owners.forEach((oid) => { sum += dealsUsdById[oid] || 0; });
      return { name: s.NAME, statusId: s.STATUS_ID, semantics: s.SEMANTICS, count, sum };
    });
    return rows;
  }

  function blockD(state, refs, deals, history, prevDeals, prevHistory) {
    // выбираем воронку: ровно одна выбранная — идеально; иначе берём первую выбранную
    const selected = state.categories;
    if (!selected || !selected.length) {
      return { warning: 'Выберите воронку для построения графика.', stages: [] };
    }
    const catId = String(selected[0]);
    const note = selected.length > 1
      ? `Показана воронка «${(refs.categories.find((c) => String(c.id) === catId) || {}).name || catId}» (выбрано несколько).`
      : '';

    const usdById = {}; deals.forEach((d) => { usdById[d.id] = d.usd; });
    const prevUsdById = {}; (prevDeals || []).forEach((d) => { prevUsdById[d.id] = d.usd; });

    const cur = buildFunnel(catId, refs.stagesByCat, usdById, history);
    const prev = buildFunnel(catId, refs.stagesByCat, prevUsdById, prevHistory);
    const prevByStage = {}; prev.forEach((r) => { prevByStage[r.statusId] = r; });

    // конверсия этапа = тек/пред этап; тренд = знак (тек - пред.период)
    const stages = cur.map((r, i) => {
      const prevStage = i > 0 ? cur[i - 1] : null;
      const convCountPct = prevStage ? (prevStage.count ? (r.count / prevStage.count) * 100 : NaN) : 100;
      const convSumPct = prevStage ? (prevStage.sum ? (r.sum / prevStage.sum) * 100 : NaN) : 100;
      const p = prevByStage[r.statusId] || { count: 0, sum: 0 };
      return Object.assign({}, r, {
        convCountPct, convSumPct,
        trendCount: Math.sign(r.count - p.count),
        trendSum: Math.sign(r.sum - p.sum),
      });
    });
    return { warning: '', note, categoryId: catId, stages };
  }

  /* --- Сегменты (карточки «ПО ПРОЕКТАМ/МЕНЕДЖЕРАМ/ВОРОНКАМ») ---------------
   * Агрегируем сделки по разрезу state.segBreakdown -> [{label, sum, count}],
   * отсортировано по текущей метрике (segMetric).
   */
  function blockSeg(deals, state, refs) {
    const breakdown = state.segBreakdown || 'projects';
    const map = {};
    deals.forEach((d) => {
      const k = breakdownKey(d, breakdown, refs);
      if (!map[k]) map[k] = { label: k, sum: 0, count: 0 };
      map[k].sum += d.usd; map[k].count += 1;
    });
    const metric = state.segMetric || 'sum';
    const items = Object.keys(map).map((k) => map[k])
      .sort((a, b) => (metric === 'sum' ? b.sum - a.sum : b.count - a.count));
    return { breakdown, metric, items };
  }

  /* --- E. Источники -------------------------------------------------------- */
  function blockE(deals, refs) {
    const map = {};
    deals.forEach((d) => {
      const key = d.sourceId || '—';
      if (!map[key]) map[key] = { count: 0, sum: 0 };
      map[key].count++; map[key].sum += d.usd;
    });
    return Object.keys(map).map((k) => ({
      source: refs.sources[k] || k,
      sum: map[k].sum,
      count: map[k].count,
      avg: map[k].count ? map[k].sum / map[k].count : 0,
    })).sort((a, b) => b.sum - a.sum);
  }

  /* --- compute ------------------------------------------------------------- */
  function compute(input) {
    const deals = normalizeDeals(input.deals, input.converter, input.state);
    const prevDeals = normalizeDeals(input.prevDeals, input.converter, input.state);
    _deals = deals; _refs = input.refs; // для пересчёта C/сегментов без перезагрузки
    const model = {
      a: blockA(deals),
      b: blockB(deals),
      c: blockC(deals, input.state, input.refs),
      d: blockD(input.state, input.refs, deals, input.history, prevDeals, input.prevHistory),
      e: blockE(deals, input.refs),
      seg: blockSeg(deals, input.state, input.refs),
      meta: { count: deals.length, state: input.state },
    };
    lastModel = model;
    return model;
  }

  /* Пересчёт блока C (динамика) без обращения к REST — по сохранённым сделкам. */
  function recomputeC(state) {
    if (!_deals || !lastModel) return;
    lastModel.meta.state = state;
    lastModel.c = blockC(_deals, state, _refs);
    renderC(lastModel.c, state);
  }
  /* Пересчёт блока сегментов без обращения к REST. */
  function recomputeSeg(state) {
    if (!_deals || !lastModel) return;
    lastModel.meta.state = state;
    lastModel.seg = blockSeg(_deals, state, _refs);
    renderSeg(lastModel.seg);
  }

  /* =========================================================================
   * РЕНДЕР
   * =======================================================================*/
  function render(model, state) {
    renderA(model.a);
    renderB(model.b);
    renderSeg(model.seg);
    renderC(model.c, state);
    renderD(model.d, state);
    renderE(model.e);
  }

  const SEG_TITLES = {
    projects: 'ПО ПРОЕКТАМ', managers: 'ПО МЕНЕДЖЕРАМ', funnels: 'ПО ВОРОНКАМ',
    agencies: 'ПО АГЕНТСТВАМ', agents: 'ПО АГЕНТАМ',
  };
  function renderSeg(seg) {
    document.getElementById('seg-title').textContent = SEG_TITLES[seg.breakdown] || 'ПО ПРОЕКТАМ';
    const el = document.getElementById('segments');
    if (!seg.items.length) { el.innerHTML = '<div class="note">Нет данных</div>'; return; }
    el.innerHTML = seg.items.map((it) => {
      const main = seg.metric === 'sum' ? UTIL.money(it.sum) : UTIL.num(it.count) + ' шт';
      const sub = seg.metric === 'sum' ? UTIL.num(it.count) + ' шт' : UTIL.money(it.sum);
      return `<div class="card seg-card" title="${UTIL.esc(it.label)}">
        <div class="seg-name">${UTIL.esc(it.label)}</div>
        <div class="seg-val">${main}</div>
        <div class="seg-sub">${sub}</div>
      </div>`;
    }).join('');
  }

  function renderA(a) {
    document.getElementById('kpi-total').textContent = UTIL.money(a.total);
    document.getElementById('kpi-count').textContent = UTIL.num(a.count) + ' шт';
    document.getElementById('kpi-avg').textContent = UTIL.money(a.avg);
  }

  function renderB(b) {
    const el = document.getElementById('corridors');
    el.innerHTML = b.map((c) => `
      <div class="card corridor">
        <div class="corridor-label">${UTIL.esc(c.label)}</div>
        <div class="corridor-sum">${UTIL.money(c.sum)}</div>
        <div class="corridor-count">${UTIL.num(c.count)} шт</div>
      </div>`).join('');
  }

  function renderC(c, state) {
    const labels = { projects: 'Проекты', managers: 'Менеджеры', funnels: 'Воронки', agencies: 'Агентства', agents: 'Агенты' };
    CHARTS.renderLine(c, labels[state.breakdown]);
  }

  function renderD(d, state) {
    const warn = document.getElementById('funnel-warning');
    const wrap = document.getElementById('funnel-wrap');
    if (d.warning) {
      warn.textContent = d.warning;
      warn.style.display = 'block';
      wrap.style.display = 'none';
      return;
    }
    // нет ни одного этапа с данными -> не строим «сломанную» воронку из нулей
    const hasData = (d.stages || []).some((s) => s.count > 0 || s.sum > 0);
    if (!hasData) {
      warn.textContent = 'Нет данных за выбранный период по этой воронке.';
      warn.style.display = 'block';
      wrap.style.display = 'none';
      return;
    }
    warn.style.display = 'none';
    wrap.style.display = 'block';
    document.getElementById('funnel-note').textContent = d.note || '';
    const metric = document.querySelector('input[name="funnelMetric"]:checked');
    CHARTS.renderFunnel(d.stages, metric ? metric.value : 'count');
    renderFunnelTable(d.stages);
  }

  function renderFunnelTable(stages) {
    const arrow = (t) => t > 0 ? '<span class="up">↑</span>' : (t < 0 ? '<span class="down">↓</span>' : '<span class="eq">=</span>');
    const rows = stages.map((s) => `
      <tr>
        <td>${UTIL.esc(s.name)}</td>
        <td class="num">${UTIL.num(s.count)} ${arrow(s.trendCount)}</td>
        <td class="num">${UTIL.money(s.sum)} ${arrow(s.trendSum)}</td>
        <td class="num">${UTIL.pct(s.convCountPct)}</td>
        <td class="num">${UTIL.pct(s.convSumPct)}</td>
      </tr>`).join('');
    document.getElementById('funnel-table-body').innerHTML = rows;
  }

  function renderE(rows) {
    const body = rows.map((r) => `
      <tr>
        <td>${UTIL.esc(r.source)}</td>
        <td class="num">${UTIL.money(r.sum)}</td>
        <td class="num">${UTIL.num(r.count)}</td>
        <td class="num">${UTIL.money(r.avg)}</td>
      </tr>`).join('');
    document.getElementById('sources-body').innerHTML = body
      || '<tr><td colspan="4" class="empty">Нет данных</td></tr>';
  }

  function getModel() { return lastModel; }

  return { compute, render, getModel, recomputeC, recomputeSeg };
})();
