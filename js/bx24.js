/* =============================================================================
 * BX24 — тонкая обёртка над REST Битрикс24.
 *
 * Поддерживает два транспорта (по CONFIG.auth.mode):
 *   - 'bx24'    : вызовы через BX24.callMethod / BX24.callBatch (внутри iframe);
 *   - 'webhook' : прямые fetch-запросы на входящий вебхук (локальная разработка).
 *
 * Публичный API одинаков для обоих режимов:
 *   BX.callMethod(method, params)        -> Promise<{ items, total, raw }>
 *   BX.callBatch(cmds, halt)             -> Promise<{ result, errors }>
 *   BX.fetchAll(method, params, opts)    -> Promise<Array>   // вся пагинация
 * ===========================================================================*/
window.BX = (function () {
  const isWebhook = () => CONFIG.auth.mode === 'webhook';

  /* --- Инициализация SDK (только для режима bx24) ------------------------- */
  function init() {
    return new Promise((resolve, reject) => {
      if (isWebhook()) return resolve();
      if (typeof BX24 === 'undefined') {
        return reject(new Error('BX24.js не загружен. Откройте приложение внутри Битрикс24 '
          + 'или переключите CONFIG.auth.mode = "webhook".'));
      }
      BX24.init(() => resolve());
    });
  }

  /* --- webhook: один вызов метода ----------------------------------------- */
  async function webhookCall(method, params) {
    const base = CONFIG.auth.webhookUrl.replace(/\/+$/, '');
    if (!base) throw new Error('CONFIG.auth.webhookUrl не задан для режима webhook.');
    // form-urlencoded — «простой» content-type: браузер не шлёт CORS-preflight,
    // который входящий вебхук Битрикс не обрабатывает.
    const res = await fetch(`${base}/${method}.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: toQuery(params || {}),
    });
    const json = await res.json();
    if (json.error) throw new Error(`${method}: ${json.error} ${json.error_description || ''}`);
    return json; // { result, total, next, time }
  }

  /* --- единичный вызов метода (любой транспорт) --------------------------- */
  function callMethod(method, params) {
    if (isWebhook()) {
      return webhookCall(method, params).then((json) => ({
        items: json.result,
        total: typeof json.total === 'number' ? json.total : null,
        next: typeof json.next === 'number' ? json.next : null,
        raw: json,
      }));
    }
    return new Promise((resolve, reject) => {
      BX24.callMethod(method, params || {}, (result) => {
        if (result.error()) {
          return reject(new Error(`${method}: ${result.error()} ${result.error_description() || ''}`));
        }
        resolve({
          items: result.data(),
          total: result.total(),
          next: result.more() ? result.answer.next : null,
          raw: result.answer,
        });
      });
    });
  }

  /* --- batch: массив или объект команд ------------------------------------
   * cmds: { key: { method, params } } | [{ method, params }]
   * Возвращает { result: { key: data }, errors: { key: err } }
   */
  function callBatch(cmds, halt) {
    // нормализуем в объект { key: 'method?querystring' } для bx24,
    // и в массив для webhook.
    if (isWebhook()) return webhookBatch(cmds, halt);

    const obj = {};
    const isArray = Array.isArray(cmds);
    (isArray ? cmds : Object.keys(cmds)).forEach((c, i) => {
      const key = isArray ? i : c;
      const def = isArray ? cmds[i] : cmds[c];
      obj[key] = [def.method, def.params || {}];
    });

    return new Promise((resolve) => {
      BX24.callBatch(obj, (results) => {
        const out = { result: {}, errors: {} };
        Object.keys(results).forEach((key) => {
          const r = results[key];
          if (r.error && r.error()) out.errors[key] = r.error();
          else out.result[key] = r.data();
        });
        resolve(out);
      }, !!halt);
    });
  }

  async function webhookBatch(cmds, halt) {
    // эмуляция callBatch через batch-метод вебхука
    const cmd = {};
    const isArray = Array.isArray(cmds);
    // ВАЖНО: ключи должны совпадать с режимом BX24 (для массива — числовой
    // индекс), иначе вызывающий код, читающий result[i], получит undefined.
    (isArray ? cmds : Object.keys(cmds)).forEach((c, i) => {
      const key = isArray ? i : c;
      const def = isArray ? cmds[i] : cmds[c];
      const qs = toQuery(def.params || {});
      cmd[key] = `${def.method}?${qs}`;
    });
    const base = CONFIG.auth.webhookUrl.replace(/\/+$/, '');
    const res = await fetch(`${base}/batch.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: toQuery({ halt: halt ? 1 : 0, cmd }),
    });
    const json = await res.json();
    const out = { result: {}, errors: {} };
    const r = (json.result && json.result.result) || {};
    const e = (json.result && json.result.result_error) || {};
    Object.keys(r).forEach((k) => { out.result[k] = r[k]; });
    Object.keys(e).forEach((k) => { out.errors[k] = e[k]; });
    return out;
  }

  function toQuery(obj, prefix) {
    const parts = [];
    Object.keys(obj).forEach((key) => {
      const val = obj[key];
      const name = prefix ? `${prefix}[${key}]` : key;
      if (val !== null && typeof val === 'object') {
        parts.push(toQuery(val, name));
      } else {
        parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(val)}`);
      }
    });
    return parts.filter(Boolean).join('&');
  }

  /* --- fetchAll: выгрузка всех страниц списочного метода -------------------
   * Алгоритм:
   *   1) Первый вызов (start: 0) -> данные + total.
   *   2) Если total > pageSize, генерируем оставшиеся start (50,100,...),
   *      бьём на пачки <= batchSize и вытягиваем через callBatch.
   * Для тяжёлых выгрузок рекомендуется отключать счётчик подсчёта на стороне
   * Битрикс (start: -1) — но total нужен для генерации страниц, поэтому
   * считаем один раз на первой странице.
   */
  // некоторые методы (crm.stagehistory.list) кладут массив в .items
  function asArray(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.items)) return data.items;
    return [];
  }

  async function fetchAll(method, params, opts) {
    opts = opts || {};
    const pageSize = CONFIG.pageSize;
    const first = await callMethod(method, Object.assign({}, params, { start: 0 }));
    let items = asArray(first.items).slice();
    const total = first.total;

    if (typeof total !== 'number' || total <= pageSize) {
      return items;
    }

    // генерируем стартовые смещения для остальных страниц
    const starts = [];
    for (let s = pageSize; s < total; s += pageSize) starts.push(s);

    // бьём на пачки по batchSize
    for (let i = 0; i < starts.length; i += CONFIG.batchSize) {
      const chunk = starts.slice(i, i + CONFIG.batchSize);
      const cmds = chunk.map((s) => ({
        method,
        params: Object.assign({}, params, { start: s }),
      }));
      const { result } = await callBatch(cmds, false);
      Object.keys(result).forEach((k) => {
        items = items.concat(asArray(result[k]));
      });
      if (typeof opts.onProgress === 'function') {
        opts.onProgress(Math.min(items.length, total), total);
      }
    }
    return items;
  }

  return { init, callMethod, callBatch, fetchAll, isWebhook };
})();
