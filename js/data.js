/* =============================================================================
 * DATA — справочники (с кэшем), конвертация валют, выгрузка сделок и истории.
 *
 * Кэш: in-memory + localStorage (TTL из CONFIG.cacheTtlMs). Справочники
 * (воронки, стадии, пользователи, источники, валюты) меняются редко, поэтому
 * кэшируются. Сами сделки/история — НЕ кэшируются (зависят от фильтров).
 * ===========================================================================*/
window.DATA = (function () {
  const mem = {};

  /* --- localStorage-кэш с TTL --------------------------------------------- */
  function cacheGet(key) {
    if (mem[key] && mem[key].exp > Date.now()) return mem[key].val;
    try {
      const raw = localStorage.getItem('rep1:' + key);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (obj.exp > Date.now()) {
        mem[key] = obj;
        return obj.val;
      }
    } catch (e) { /* ignore */ }
    return null;
  }
  function cacheSet(key, val) {
    const obj = { val, exp: Date.now() + CONFIG.cacheTtlMs };
    mem[key] = obj;
    try { localStorage.setItem('rep1:' + key, JSON.stringify(obj)); } catch (e) { /* quota */ }
  }
  function cacheClear() {
    Object.keys(mem).forEach((k) => delete mem[k]);
    try {
      Object.keys(localStorage)
        .filter((k) => k.indexOf('rep1:') === 0)
        .forEach((k) => localStorage.removeItem(k));
    } catch (e) { /* ignore */ }
  }

  /* =========================================================================
   * СПРАВОЧНИКИ
   * =======================================================================*/

  /* Воронки: crm.category.list (entityTypeId=2) -> [{id, name}] */
  async function getCategories() {
    const cached = cacheGet('categories');
    if (cached) return cached;
    const { items } = await BX.callMethod('crm.category.list', {
      entityTypeId: CONFIG.dealEntityTypeId,
    });
    // ответ: { categories: [...] }
    const list = (items && items.categories ? items.categories : items || []).map((c) => ({
      id: Number(c.id),
      name: c.name,
    }));
    // Воронка по умолчанию (id=0) может не попасть в список — добавим вручную
    if (!list.some((c) => c.id === 0)) list.unshift({ id: 0, name: 'Общая' });
    list.sort((a, b) => a.id - b.id);
    cacheSet('categories', list);
    return list;
  }

  /* Стадии: для каждой воронки свой ENTITY_ID.
   * Воронка 0 -> "DEAL_STAGE"; иначе -> "DEAL_STAGE_{CATEGORY_ID}".
   * Возвращает map { [categoryId]: [{ STATUS_ID, NAME, SORT, SEMANTICS }] }.
   */
  async function getStages(categoryIds) {
    const cats = categoryIds && categoryIds.length
      ? categoryIds
      : (await getCategories()).map((c) => c.id);

    const result = {};
    const toFetch = [];
    cats.forEach((id) => {
      const c = cacheGet('stages:' + id);
      if (c) result[id] = c;
      else toFetch.push(id);
    });

    if (toFetch.length) {
      const cmds = toFetch.map((id) => ({
        method: 'crm.status.list',
        params: {
          filter: { ENTITY_ID: id === 0 ? 'DEAL_STAGE' : `DEAL_STAGE_${id}` },
          order: { SORT: 'ASC' },
        },
      }));
      const { result: batch } = await BX.callBatch(cmds, false);
      toFetch.forEach((id, i) => {
        const rows = (batch[i] || []).map((s) => ({
          STATUS_ID: s.STATUS_ID,
          NAME: s.NAME,
          SORT: Number(s.SORT),
          SEMANTICS: s.SEMANTICS, // null | 'P' (process) | 'S' (success) | 'F' (fail)
        })).sort((a, b) => a.SORT - b.SORT);
        result[id] = rows;
        cacheSet('stages:' + id, rows);
      });
    }
    return result;
  }

  /* Источники: crm.status.list ENTITY_ID=SOURCE -> map { [id]: name } */
  async function getSources() {
    const cached = cacheGet('sources');
    if (cached) return cached;
    const { items } = await BX.callMethod('crm.status.list', {
      filter: { ENTITY_ID: 'SOURCE' }, order: { SORT: 'ASC' },
    });
    const map = {};
    (items || []).forEach((s) => { map[s.STATUS_ID] = s.NAME; });
    cacheSet('sources', map);
    return map;
  }

  /* Менеджеры: user.get (ACTIVE=Y) -> map { [id]: 'Фамилия Имя' } */
  async function getUsers() {
    const cached = cacheGet('users');
    if (cached) return cached;
    const all = await BX.fetchAll('user.get', { FILTER: { ACTIVE: 'Y' } });
    const map = {};
    (all || []).forEach((u) => {
      const fio = [u.LAST_NAME, u.NAME, u.SECOND_NAME].filter(Boolean).join(' ').trim();
      map[u.ID] = fio || u.EMAIL || ('ID ' + u.ID);
    });
    cacheSet('users', map);
    return map;
  }

  /* Резолв ID -> название для crm-привязок (Агентство=компания, Агент=контакт).
   * ids: массив ID; bind: 'company' | 'contact'. Возвращает map { id: name }.
   * Резолвим только нужные ID (пачками по filter[ID]), названия кэшируем. */
  async function resolveCrmNames(ids, bind) {
    const uniq = Array.from(new Set((ids || []).map(String).filter((x) => x && x !== '0')));
    const out = {};
    const need = [];
    uniq.forEach((id) => {
      const c = cacheGet(bind + ':' + id);
      if (c) out[id] = c; else need.push(id);
    });
    if (need.length) {
      const method = bind === 'company' ? 'crm.company.list' : 'crm.contact.list';
      // бьём на пачки и тянем; компании -> TITLE, контакты -> ФИО
      for (let i = 0; i < need.length; i += 50) {
        const chunk = need.slice(i, i + 50);
        const items = await BX.fetchAll(method, {
          filter: { ID: chunk },
          select: bind === 'company' ? ['ID', 'TITLE'] : ['ID', 'NAME', 'LAST_NAME'],
        });
        (items || []).forEach((it) => {
          const name = bind === 'company'
            ? (it.TITLE || ('Компания ' + it.ID))
            : ([it.LAST_NAME, it.NAME].filter(Boolean).join(' ').trim() || ('Контакт ' + it.ID));
          out[it.ID] = name;
          cacheSet(bind + ':' + it.ID, name);
        });
      }
    }
    return out;
  }

  /* UF-поля сделки: crm.deal.userfield.list -> список (для подсказки маппинга
   * и для значений списочных UF). Кэшируется. */
  async function getDealUserfields() {
    const cached = cacheGet('userfields');
    if (cached) return cached;
    const all = await BX.fetchAll('crm.deal.userfield.list', { order: { SORT: 'ASC' } });
    cacheSet('userfields', all || []);
    return all || [];
  }

  /* Метаданные полей сделки: crm.deal.fields. В отличие от userfield.list,
   * содержит варианты enum (items: [{ID, VALUE}]) и тип поля — используем для
   * фильтров и расшифровки значений UF в разрезах. Кэшируется. */
  async function getDealFields() {
    const cached = cacheGet('dealfields');
    if (cached) return cached;
    const { items } = await BX.callMethod('crm.deal.fields', {});
    cacheSet('dealfields', items || {});
    return items || {};
  }

  /* =========================================================================
   * ВАЛЮТЫ
   * =======================================================================*/

  /* crm.currency.list + crm.currency.base.get.
   * Возвращает { base, rates }, где rates[CURRENCY] = сколько единиц БАЗОВОЙ
   * валюты стоит 1 единица CURRENCY = EXCHANGE_RATE / AMOUNT_CNT.
   */
  async function getCurrency() {
    const cached = cacheGet('currency');
    if (cached) return cached;
    const { result } = await BX.callBatch({
      list: { method: 'crm.currency.list', params: {} },
      base: { method: 'crm.currency.base.get', params: {} },
    }, false);

    const list = result.list || [];
    const baseCur = (result.base && (result.base.CURRENCY || result.base)) || 'USD';
    const rates = {};
    // В crm.currency.list курс задаётся как AMOUNT базовой валюты за AMOUNT_CNT
    // единиц валюты. Значит 1 валюта = AMOUNT / AMOUNT_CNT базовой.
    list.forEach((c) => {
      const cnt = Number(c.AMOUNT_CNT || 1) || 1;
      const amount = Number(c.AMOUNT || 1) || 1;
      rates[c.CURRENCY] = amount / cnt;
    });
    rates[baseCur] = rates[baseCur] || 1;
    const out = { base: baseCur, rates };
    cacheSet('currency', out);
    return out;
  }

  /* Конвертация суммы из fromCurrency в целевую CONFIG.targetCurrency.
   * Историческую конвертацию по дате сделки в MVP НЕ делаем — курс на момент
   * запроса (допущение, помечено в README).
   */
  function makeConverter(currency) {
    const target = CONFIG.targetCurrency;
    const rates = currency.rates;
    const targetRate = rates[target] || 1; // базовой за 1 target
    return function toTarget(amount, fromCurrency) {
      const amt = Number(amount) || 0;
      const fromRate = rates[fromCurrency] != null ? rates[fromCurrency] : 1;
      const inBase = amt * fromRate;       // -> базовая валюта
      return inBase / targetRate;          // -> целевая (USD)
    };
  }

  /* =========================================================================
   * СДЕЛКИ
   * =======================================================================*/

  /* Строим filter для crm.deal.list из состояния фильтров (см. filters.js).
   * dateField — DATE_CREATE | DATE_MODIFY | CLOSEDATE.
   */
  function buildDealFilter(state) {
    const f = {};
    const df = state.dateType;
    if (state.from) f['>=' + df] = state.from;          // 'YYYY-MM-DD'
    if (state.to)   f['<=' + df] = state.to + ' 23:59:59';

    if (df === 'CLOSEDATE' && CONFIG.closeDateOnlyClosed) f.CLOSED = 'Y';

    if (state.categories && state.categories.length) f.CATEGORY_ID = state.categories;
    if (state.stages && state.stages.length)         f.STAGE_ID = state.stages;
    if (state.managers && state.managers.length)     f.ASSIGNED_BY_ID = state.managers;

    CONFIG.ufKeys.forEach((k) => {
      if (CONFIG.ufEnabled[k] && state[k] && state[k].length) {
        f[CONFIG.uf[k]] = state[k];
      }
    });
    // Диапазон суммы по сумме — фильтруем ПОСЛЕ конвертации в USD на клиенте
    // (в OPPORTUNITY сделки лежат в разных валютах), здесь не ограничиваем.
    return f;
  }

  /* Полная выгрузка сделок по фильтрам (с пагинацией). */
  async function fetchDeals(state, onProgress) {
    const filter = buildDealFilter(state);
    return BX.fetchAll('crm.deal.list', {
      filter,
      select: CONFIG.dealSelect,
      order: { ID: 'ASC' },
    }, { onProgress });
  }

  /* История стадий: crm.stagehistory.list (entityTypeId=2).
   * Поля: OWNER_ID, STAGE_ID, CATEGORY_ID, CREATED_TIME.
   * Фильтр по периоду — по CREATED_TIME.
   */
  async function fetchStageHistory(state, categoryIds) {
    const filter = {};
    if (state.from) filter['>=CREATED_TIME'] = state.from;
    if (state.to)   filter['<=CREATED_TIME'] = state.to + ' 23:59:59';
    if (categoryIds && categoryIds.length) filter.CATEGORY_ID = categoryIds;

    return BX.fetchAll('crm.stagehistory.list', {
      entityTypeId: CONFIG.dealEntityTypeId,
      filter,
      select: ['ID', 'OWNER_ID', 'STAGE_ID', 'CATEGORY_ID', 'CREATED_TIME'],
      order: { ID: 'ASC' },
    });
  }

  return {
    getCategories, getStages, getSources, getUsers, getDealUserfields, getDealFields,
    resolveCrmNames, getCurrency, makeConverter,
    buildDealFilter, fetchDeals, fetchStageHistory,
    cacheClear,
  };
})();
