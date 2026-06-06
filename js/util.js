/* =============================================================================
 * UTIL — даты, группировка по гранулярности, форматирование, экранирование.
 * ===========================================================================*/
window.UTIL = (function () {
  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function toYMD(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /* Парсим дату Битрикс ('2024-05-01T10:00:00+03:00' или 'YYYY-MM-DD ...') */
  function parseDate(s) {
    if (!s) return null;
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  /* Начало ISO-недели (понедельник) */
  function startOfWeek(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const day = (x.getDay() + 6) % 7; // 0 = понедельник
    x.setDate(x.getDate() - day);
    return x;
  }

  /* Ключ бакета по гранулярности: day|week|month|year */
  function bucketKey(d, gran) {
    switch (gran) {
      case 'day':   return toYMD(d);
      case 'week':  return toYMD(startOfWeek(d));
      case 'month': return d.getFullYear() + '-' + pad(d.getMonth() + 1);
      case 'year':  return '' + d.getFullYear();
      default:      return toYMD(d);
    }
  }

  /* Человекочитаемая подпись бакета */
  function bucketLabel(key, gran) {
    if (gran === 'month') {
      const [y, m] = key.split('-');
      const names = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
      return names[Number(m) - 1] + ' ' + y;
    }
    if (gran === 'week') return 'нед. ' + key;
    return key;
  }

  /* Список всех бакетов между from и to (включительно) — чтобы ось X была
   * непрерывной даже при пропусках. */
  function bucketRange(from, to, gran) {
    const keys = [];
    if (!from || !to) return keys;
    let cur = new Date(from + 'T00:00:00');
    const end = new Date(to + 'T00:00:00');
    let guard = 0;
    while (cur <= end && guard++ < 5000) {
      keys.push(bucketKey(cur, gran));
      if (gran === 'day') cur.setDate(cur.getDate() + 1);
      else if (gran === 'week') cur.setDate(cur.getDate() + 7);
      else if (gran === 'month') cur.setMonth(cur.getMonth() + 1);
      else if (gran === 'year') cur.setFullYear(cur.getFullYear() + 1);
      else break;
    }
    // уникализируем (week/month могут повторить ключ)
    return keys.filter((k, i) => keys.indexOf(k) === i);
  }

  /* Авто-гранулярность оси X по длине периода (день/неделя/месяц/год). */
  function autoGranularity(from, to) {
    if (!from || !to) return 'month';
    const days = Math.round((new Date(to + 'T00:00:00') - new Date(from + 'T00:00:00')) / 86400000) + 1;
    if (days <= 31) return 'day';
    if (days <= 120) return 'week';
    if (days <= 1095) return 'month'; // ~3 года
    return 'year';
  }

  /* Предыдущий период ТОЙ ЖЕ длины, идущий встык перед [from..to]. */
  function previousRange(from, to) {
    const f = new Date(from + 'T00:00:00');
    const t = new Date(to + 'T00:00:00');
    const days = Math.round((t - f) / 86400000) + 1;
    const prevTo = new Date(f); prevTo.setDate(prevTo.getDate() - 1);
    const prevFrom = new Date(prevTo); prevFrom.setDate(prevFrom.getDate() - (days - 1));
    return { from: toYMD(prevFrom), to: toYMD(prevTo) };
  }

  /* Предыдущий аналогичный период (для тренда воронки). Возвращает {from,to}. */
  function previousPeriod(from, to, gran) {
    const f = new Date(from + 'T00:00:00');
    const t = new Date(to + 'T00:00:00');
    const shift = function (d) {
      const x = new Date(d);
      if (gran === 'day') x.setDate(x.getDate() - 1);
      else if (gran === 'week') x.setDate(x.getDate() - 7);
      else if (gran === 'month') x.setMonth(x.getMonth() - 1);
      else if (gran === 'year') x.setFullYear(x.getFullYear() - 1);
      else {
        // по длине диапазона
        const days = Math.round((t - f) / 86400000) + 1;
        x.setDate(x.getDate() - days);
      }
      return x;
    };
    return { from: toYMD(shift(f)), to: toYMD(shift(t)) };
  }

  /* Форматирование денег в USD */
  function money(n) {
    const v = Math.round(Number(n) || 0);
    return '$' + v.toLocaleString('ru-RU');
  }
  /* Компактный формат для осей/подписей: $0 / $300k / $1.2M */
  function moneyShort(n) {
    const v = Number(n) || 0;
    const a = Math.abs(v);
    if (a >= 1e6) return '$' + (Math.round(v / 1e5) / 10) + 'M';
    if (a >= 1e3) return '$' + Math.round(v / 1e3) + 'k';
    return '$' + Math.round(v);
  }
  function num(n) {
    return (Number(n) || 0).toLocaleString('ru-RU');
  }
  function pct(n) {
    if (!isFinite(n)) return '—';
    return (Math.round(n * 10) / 10).toLocaleString('ru-RU') + '%';
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  return {
    pad, toYMD, parseDate, startOfWeek, bucketKey, bucketLabel, bucketRange,
    autoGranularity, previousRange, previousPeriod, money, moneyShort, num, pct, esc,
  };
})();
