/* =============================================================================
 * FILTERS — состояние фильтров + рендер панели фильтров.
 * Один набор фильтров применяется КО ВСЕМ блокам отчёта одновременно.
 * При изменении вызывается onApply() (см. app.js).
 * ===========================================================================*/
window.FILTERS = (function () {
  let refs = null;    // справочники: { categories, stagesByCat, users, sources, ufValues }
  let onApply = null;

  // Состояние фильтров
  const state = {
    dateType: CONFIG.defaults.dateType,     // DATE_CREATE|DATE_MODIFY|CLOSEDATE
    granularity: CONFIG.defaults.granularity,// day|week|month|year
    from: '',
    to: '',
    categories: [],   // CATEGORY_ID[]
    stages: [],       // STAGE_ID[]
    sumFrom: '',      // USD
    sumTo: '',        // USD
    managers: [],
    project: [],
    agency: [],
    agent: [],
    breakdown: CONFIG.defaults.breakdown,    // блок C: projects|managers|funnels
    segBreakdown: 'projects',                // блок сегментов: projects|managers|funnels
    segMetric: 'sum',                        // блок сегментов: sum|count
  };

  function getState() {
    // гранулярность оси X вычисляется автоматически по длине периода
    state.granularity = UTIL.autoGranularity(state.from, state.to);
    return Object.assign({}, state);
  }

  const GRAN_RU = { day: 'по дням', week: 'по неделям', month: 'по месяцам', year: 'по годам' };
  function updateGranHint() {
    const el = document.getElementById('gran-hint');
    if (el) el.textContent = 'График: ' + (GRAN_RU[UTIL.autoGranularity(state.from, state.to)] || '');
  }

  /* --- хелперы рендера ----------------------------------------------------- */
  function optionList(el, items, selected) {
    el.innerHTML = '';
    items.forEach((it) => {
      const o = document.createElement('option');
      o.value = it.value;
      o.textContent = it.label;
      if (selected && selected.indexOf(String(it.value)) !== -1) o.selected = true;
      el.appendChild(o);
    });
  }
  function multiVals(el) {
    return Array.from(el.selectedOptions).map((o) => o.value);
  }

  /* Список этапов зависит от выбранных воронок */
  function stagesForSelected() {
    const cats = state.categories.length
      ? state.categories
      : refs.categories.map((c) => String(c.id));
    const out = [];
    const seen = {};
    cats.forEach((cid) => {
      (refs.stagesByCat[cid] || []).forEach((s) => {
        if (!seen[s.STATUS_ID]) {
          seen[s.STATUS_ID] = true;
          out.push({ value: s.STATUS_ID, label: s.NAME });
        }
      });
    });
    return out;
  }

  function rebuildStageOptions() {
    const el = document.getElementById('f-stages');
    optionList(el, stagesForSelected(), state.stages);
  }

  /* --- инициализация панели ----------------------------------------------- */
  function render(references, applyCb) {
    refs = references;
    onApply = applyCb;

    // период по умолчанию: текущий месяц
    if (!state.from || !state.to) {
      const now = new Date();
      state.from = UTIL.toYMD(new Date(now.getFullYear(), now.getMonth(), 1));
      state.to = UTIL.toYMD(now);
    }

    // 1. Тип даты (radio)
    document.querySelectorAll('input[name="dateType"]').forEach((r) => {
      r.checked = r.value === state.dateType;
      r.addEventListener('change', () => { state.dateType = r.value; });
    });

    // 2. Период: только календарь От/До (гранулярность графика — авто по длине)
    const fromEl = document.getElementById('f-from');
    const toEl = document.getElementById('f-to');
    fromEl.value = state.from; toEl.value = state.to;
    fromEl.addEventListener('change', () => { state.from = fromEl.value; updateGranHint(); });
    toEl.addEventListener('change', () => { state.to = toEl.value; updateGranHint(); });
    updateGranHint();

    // 3. Воронки (мультивыбор)
    optionList(document.getElementById('f-categories'),
      refs.categories.map((c) => ({ value: c.id, label: c.name })), state.categories);
    document.getElementById('f-categories').addEventListener('change', (e) => {
      state.categories = multiVals(e.target);
      rebuildStageOptions();
    });

    // 4. Этапы (зависят от воронок)
    rebuildStageOptions();
    document.getElementById('f-stages').addEventListener('change', (e) => {
      state.stages = multiVals(e.target);
    });

    // 5. Сумма (USD)
    const sf = document.getElementById('f-sum-from');
    const st = document.getElementById('f-sum-to');
    sf.addEventListener('change', () => { state.sumFrom = sf.value; });
    st.addEventListener('change', () => { state.sumTo = st.value; });

    // 7. Менеджеры
    optionList(document.getElementById('f-managers'),
      Object.keys(refs.users).map((id) => ({ value: id, label: refs.users[id] })),
      state.managers);
    document.getElementById('f-managers').addEventListener('change', (e) => {
      state.managers = multiVals(e.target);
    });

    // UF-фильтры: Проект / Агентство / Агент
    setupUfFilter('project', 'f-project', 'wrap-project');
    setupUfFilter('agency', 'f-agency', 'wrap-agency');
    setupUfFilter('agent', 'f-agent', 'wrap-agent');

    // Кнопки
    document.getElementById('btn-apply').addEventListener('click', () => {
      if (!state.from || !state.to) { alert('Период обязателен: укажите «От» и «До».'); return; }
      onApply(getState());
    });
    document.getElementById('btn-reset').addEventListener('click', resetFilters);
  }

  function setupUfFilter(key, selectId, wrapId) {
    const wrap = document.getElementById(wrapId);
    if (!CONFIG.ufEnabled[key]) {
      // поле не сконфигурировано — прячем фильтр и показываем подсказку
      wrap.classList.add('uf-disabled');
      wrap.title = 'UF-поле не задано в CONFIG.uf — фильтр отключён';
      return;
    }
    const el = document.getElementById(selectId);
    const vals = (refs.ufValues && refs.ufValues[key]) || [];
    optionList(el, vals, state[key]);
    el.addEventListener('change', (e) => { state[key] = multiVals(e.target); });
  }

  function resetFilters() {
    state.categories = []; state.stages = []; state.managers = [];
    state.project = []; state.agency = []; state.agent = [];
    state.sumFrom = ''; state.sumTo = '';
    document.querySelectorAll('#filters select[multiple]').forEach((s) => {
      Array.from(s.options).forEach((o) => { o.selected = false; });
    });
    document.getElementById('f-sum-from').value = '';
    document.getElementById('f-sum-to').value = '';
    rebuildStageOptions();
    onApply(getState());
  }

  /* Перенаполнить опции UF-фильтров (например, после сбора строковых значений
   * Проекта из сделок), сохранив текущий выбор. */
  function refreshUfOptions(ufValues) {
    if (refs) refs.ufValues = ufValues;
    const map = { project: 'f-project', agency: 'f-agency', agent: 'f-agent' };
    Object.keys(map).forEach((key) => {
      if (!CONFIG.ufEnabled[key]) return;
      const el = document.getElementById(map[key]);
      if (el) optionList(el, (ufValues && ufValues[key]) || [], state[key]);
    });
  }

  // переключатели разрезов без полной перезагрузки данных
  function setBreakdown(v) { state.breakdown = v; }
  function setSegBreakdown(v) { state.segBreakdown = v; }
  function setSegMetric(v) { state.segMetric = v; }

  return { render, getState, setBreakdown, setSegBreakdown, setSegMetric, refreshUfOptions };
})();
