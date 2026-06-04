/* =============================================================================
 * APP — точка входа: инициализация, загрузка справочников, оркестрация отчёта.
 * ===========================================================================*/
(function () {
  let refs = null;       // справочники
  let converter = null;  // функция конвертации в USD

  const $ = (id) => document.getElementById(id);

  function setStatus(msg, busy) {
    const el = $('status');
    el.textContent = msg || '';
    el.className = 'status' + (busy ? ' busy' : '');
    $('overlay').style.display = busy ? 'flex' : 'none';
  }

  /* --- собрать значения списочных UF-полей для фильтров --------------------
   * Источник — crm.deal.fields (содержит items для enumeration). Для строковых
   * и crm-привязок значения соберём позже из сделок (populateUfValues).
   */
  function buildUfValues(dealFields) {
    const out = {};
    CONFIG.ufKeys.forEach((key) => {
      out[key] = [];
      if (!CONFIG.ufEnabled[key]) return;
      const f = dealFields[CONFIG.uf[key]];
      if (f && f.type === 'enumeration' && Array.isArray(f.items)) {
        out[key] = f.items.map((it) => ({ value: it.ID, label: it.VALUE }));
      }
      // строковые/crm-поля — оставляем пустым: значения подставим из сделок
    });
    return out;
  }

  /* Наполняем значения UF-фильтров из загруженных сделок:
   *  - enumeration уже наполнено из crm.deal.fields;
   *  - crm-привязки (Агентство->Компания, Агент->Контакт): резолвим ID в названия;
   *  - строковые (Проект): берём уникальные значения как есть.
   * Делается ДО расчёта, чтобы разрезы показывали названия, а не ID.
   */
  async function populateUfValues(deals) {
    let changed = false;
    for (const key of CONFIG.ufKeys) {
      if (!CONFIG.ufEnabled[key]) continue;
      const code = CONFIG.uf[key];
      const f = refs.dealFields[code];
      if (f && f.type === 'enumeration') continue; // уже наполнено

      // уникальные непустые значения поля по сделкам
      const set = {};
      deals.forEach((d) => {
        const v = d[code];
        if (v !== '' && v != null && v !== false) set[String(v)] = true;
      });
      const raw = Object.keys(set);
      if (!raw.length) continue;

      const bind = CONFIG.ufBind && CONFIG.ufBind[key];
      if (bind) {
        // crm-привязка: ID -> название
        const names = await DATA.resolveCrmNames(raw, bind);
        refs.ufValues[key] = raw
          .map((id) => ({ value: id, label: names[id] || ('ID ' + id) }))
          .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
      } else {
        refs.ufValues[key] = raw.sort().map((v) => ({ value: v, label: v }));
      }
      changed = true;
    }
    if (changed) FILTERS.refreshUfOptions(refs.ufValues);
  }

  /* --- загрузка всех справочников ----------------------------------------- */
  async function loadReferences() {
    setStatus('Загрузка справочников…', true);
    const categories = await DATA.getCategories();
    const [stagesByCat, users, sources, currency, dealFields] = await Promise.all([
      DATA.getStages(categories.map((c) => c.id)),
      DATA.getUsers(),
      DATA.getSources(),
      DATA.getCurrency(),
      DATA.getDealFields(),
    ]);
    converter = DATA.makeConverter(currency);
    refs = {
      categories, stagesByCat, users, sources, currency, dealFields,
      ufValues: buildUfValues(dealFields),
    };
    return refs;
  }

  /* --- построение отчёта по текущим фильтрам ------------------------------- */
  async function buildReport(state) {
    try {
      setStatus('Загрузка сделок…', true);
      const onProgress = (cur, total) => setStatus(`Загрузка сделок… ${cur}/${total}`, true);

      // текущий период
      const deals = await DATA.fetchDeals(state, onProgress);
      await populateUfValues(deals); // наполнить фильтры/разрезы UF (Проект, Агентство, Агент)

      // история стадий нужна для воронки (только если выбрана воронка)
      const needFunnel = state.categories && state.categories.length;
      const cats = state.categories.length ? state.categories : null;
      const history = needFunnel ? await DATA.fetchStageHistory(state, cats) : [];

      // предыдущий аналогичный период — для тренда воронки
      let prevDeals = [], prevHistory = [];
      if (needFunnel) {
        setStatus('Загрузка предыдущего периода…', true);
        const prev = UTIL.previousRange(state.from, state.to);
        const prevState = Object.assign({}, state, { from: prev.from, to: prev.to });
        prevDeals = await DATA.fetchDeals(prevState);
        prevHistory = await DATA.fetchStageHistory(prevState, cats);
      }

      setStatus('Расчёт…', true);
      const model = REPORT.compute({
        deals, history, prevDeals, prevHistory, refs, converter, state,
      });
      REPORT.render(model, state);
      setStatus(`Готово. Сделок: ${model.meta.count}. Курс валют — на момент запроса.`, false);
    } catch (e) {
      console.error(e);
      setStatus('Ошибка: ' + e.message, false);
      alert('Ошибка при построении отчёта:\n' + e.message);
    }
  }

  /* --- переключатели, не требующие перезагрузки данных --------------------- */
  function wireToggles() {
    // блок C: разрез (select) — пересчёт локально, без REST
    const cSel = $('c-breakdown');
    if (cSel) cSel.addEventListener('change', () => {
      FILTERS.setBreakdown(cSel.value);
      REPORT.recomputeC(FILTERS.getState());
    });

    // блок сегментов: разрез (select) и метрика (radio) — пересчёт локально
    const segSel = $('seg-breakdown');
    if (segSel) segSel.addEventListener('change', () => {
      FILTERS.setSegBreakdown(segSel.value);
      REPORT.recomputeSeg(FILTERS.getState());
    });
    document.querySelectorAll('input[name="segMetric"]').forEach((r) => {
      r.addEventListener('change', () => {
        FILTERS.setSegMetric(r.value);
        REPORT.recomputeSeg(FILTERS.getState());
      });
    });
    // блок D: метрика воронки (кол-во/сумма) — перерисовка без перезагрузки
    document.querySelectorAll('input[name="funnelMetric"]').forEach((r) => {
      r.addEventListener('change', () => {
        const m = REPORT.getModel();
        if (m && !m.d.warning) {
          CHARTS.renderFunnel(m.d.stages, r.value);
        }
      });
    });
    // экспорт
    document.querySelectorAll('[data-export]').forEach((btn) => {
      btn.addEventListener('click', () => {
        EXPORT.exportBlock(btn.getAttribute('data-export'), btn.getAttribute('data-format') || 'csv');
      });
    });
    $('btn-print').addEventListener('click', () => EXPORT.printPdf());
    $('btn-cache-clear').addEventListener('click', () => {
      DATA.cacheClear();
      setStatus('Кэш справочников очищен. Перезагрузите страницу.', false);
    });
    window.addEventListener('resize', () => CHARTS.resize());
  }

  /* --- старт --------------------------------------------------------------- */
  async function start() {
    try {
      setStatus('Инициализация…', true);
      await BX.init();
      await loadReferences();
      FILTERS.render(refs, buildReport);
      wireToggles();
      setStatus('Справочники загружены. Задайте период и нажмите «Построить».', false);
      // автопостроение за текущий месяц
      buildReport(FILTERS.getState());
    } catch (e) {
      console.error(e);
      setStatus('Ошибка инициализации: ' + e.message, false);
    }
  }

  document.addEventListener('DOMContentLoaded', start);
})();
