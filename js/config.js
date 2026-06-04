/* =============================================================================
 * CONFIG — единая точка настройки приложения.
 * Все значения, специфичные для портала, собраны здесь. По тексту кода ничего
 * не хардкодим — берём из CONFIG.
 *
 * ВАЖНО про UF-поля: реальные коды UF_CRM_* нужно получить на конкретном портале
 * методом crm.deal.userfield.list (см. README и UF-MAPPING-QUESTIONS.md).
 * Пока они не подставлены, соответствующие фильтры (Направление/Проект/Агентство)
 * автоматически отключаются — приложение продолжит работать.
 * ===========================================================================*/
window.CONFIG = {
  /* --- Авторизация / транспорт --------------------------------------------
   * Режим 'bx24'  — приложение работает внутри iframe Битрикс24 (BX24.js).
   * Режим 'webhook' — локальная разработка через входящий вебхук (без iframe).
   * На проде используется 'bx24' (OAuth локального приложения).
   */
  auth: {
    // Авто-режим: на localhost — вебхук (разработка), на боевом домене внутри
    // iframe Битрикс24 — bx24 (OAuth установленного приложения, секрет не нужен).
    mode: (typeof location !== 'undefined'
      && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) ? 'webhook' : 'bx24',
    // Секрет вебхука НЕ хранится в коде (репозиторий публичный). Для локальной
    // разработки задать один раз в консоли браузера:
    //   localStorage.setItem('rep1:webhook', 'https://ВАШ-ПОРТАЛ/rest/ID/КОД/')
    // В проде (bx24) вебхук не используется.
    webhookUrl: (typeof localStorage !== 'undefined'
      && localStorage.getItem('rep1:webhook')) || '',
  },

  /* --- Маппинг UF-полей сделки (globalbalihome.bitrix24.eu) ----------------
   * Названия берём из formLabel (crm.deal.fields).
   *   project — строка («Project», напр. «Serenity Village»).
   *   agency  — привязка к Компании (crm), значение = ID компании.
   *   agent   — привязка к Контакту (crm), значение = ID контакта.
   * Направление продаж = Воронка (CATEGORY_ID) — отдельное UF не используем.
   * Поставьте код в '' чтобы отключить соответствующий фильтр/разрез.
   */
  uf: {
    project: 'UF_CRM_6993017AC1684',   // Проект (строка)
    agency:  'UF_CRM_6986145D2F3DD',   // Агентство (crm -> Компания)
    agent:   'UF_CRM_6986145D3987E',   // Агент (crm -> Контакт)
  },

  /* Тип привязки crm-полей -> какой сущности резолвить ID в название. */
  ufBind: {
    agency: 'company',   // crm.company.list
    agent:  'contact',   // crm.contact.list
  },

  /* --- Пороги коридоров по сумме (USD), блок B ----------------------------
   * Карточки: до thresholds[0] / [0]-[1] / [1]-[2] / [2]+
   */
  thresholds: [100000, 200000, 500000],

  /* --- Целевая валюта отчёта ----------------------------------------------- */
  targetCurrency: 'USD',

  /* --- Логика «Дата завершения» -------------------------------------------
   * Если выбран тип даты CLOSEDATE и флаг включён — добавляем фильтр CLOSED=Y
   * (только завершённые сделки).
   */
  closeDateOnlyClosed: true,

  /* --- Пагинация REST ------------------------------------------------------ */
  pageSize: 50,    // элементов на страницу (ограничение Битрикс24)
  batchSize: 50,   // команд в одной callBatch-пачке (ограничение Битрикс24)

  /* --- Кэш справочников ---------------------------------------------------- */
  cacheTtlMs: 30 * 60 * 1000, // 30 минут

  /* --- entityTypeId сделки (для category/stagehistory) --------------------- */
  dealEntityTypeId: 2,

  /* --- placement: где регистрировать вкладку (опционально) ----------------
   * Основной интерфейс — страница приложения в левом меню. Дополнительно можно
   * привязать раздел внутри CRM через placement.bind (см. install.js).
   */
  placement: {
    enabled: false,            // true -> при инсталляции вызвать placement.bind
    PLACEMENT: 'CRM_DEAL_LIST_MENU', // напр. место в меню списка сделок
    TITLE: 'Отчёт 1: Воронка',
    handlerPath: '/index.html', // путь до точки входа приложения
  },

  /* --- Поля сделки, которые тянем из crm.deal.list ------------------------ */
  dealSelectBase: [
    'ID', 'TITLE', 'CATEGORY_ID', 'STAGE_ID', 'STAGE_SEMANTIC_ID',
    'OPPORTUNITY', 'CURRENCY_ID', 'ASSIGNED_BY_ID', 'SOURCE_ID',
    'DATE_CREATE', 'DATE_MODIFY', 'CLOSEDATE', 'CLOSED',
  ],

  /* --- Дефолты фильтров ---------------------------------------------------- */
  defaults: {
    dateType: 'DATE_CREATE',   // DATE_CREATE | DATE_MODIFY | CLOSEDATE
    granularity: 'month',      // day | week | month | year
    breakdown: 'projects',     // projects | managers | funnels (блок C)
  },
};

/* Ключи UF-измерений, которыми оперирует отчёт (фильтры/разрезы). */
window.CONFIG.ufKeys = ['project', 'agency', 'agent'];

/* Какие UF-измерения реально доступны (код поля задан непустым). */
window.CONFIG.ufEnabled = (function () {
  const out = {};
  CONFIG.ufKeys.forEach((k) => { out[k] = !!(CONFIG.uf[k] && /^UF_CRM_/.test(CONFIG.uf[k])); });
  return out;
})();

/* select-список для сделок = базовые поля + заданные UF-поля. */
window.CONFIG.dealSelect = (function () {
  const sel = CONFIG.dealSelectBase.slice();
  CONFIG.ufKeys.forEach((k) => { if (CONFIG.ufEnabled[k]) sel.push(CONFIG.uf[k]); });
  return sel;
})();
