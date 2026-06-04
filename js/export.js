/* =============================================================================
 * EXPORT — выгрузка разрезов в CSV (открывается в Excel) и в XLS (HTML-таблица).
 * PDF — опционально (печать страницы средствами браузера, кнопка «Печать»).
 * ===========================================================================*/
window.EXPORT = (function () {
  function download(filename, content, mime) {
    const blob = new Blob(['﻿' + content], { type: mime + ';charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(rows) {
    return rows.map((r) => r.map(csvCell).join(';')).join('\r\n');
  }

  // Excel через HTML-таблицу (.xls открывается в Excel напрямую)
  function toXls(title, rows) {
    const body = rows.map((r, i) => {
      const tag = i === 0 ? 'th' : 'td';
      return '<tr>' + r.map((c) => `<${tag}>${UTIL.esc(c)}</${tag}>`).join('') + '</tr>';
    }).join('');
    return `<html><head><meta charset="utf-8"></head><body>`
      + `<table border="1">${body}</table></body></html>`;
  }

  /* Преобразуем блок модели в массив строк (первая строка — заголовки). */
  function rowsFor(block, model, state) {
    switch (block) {
      case 'a':
        return [['Показатель', 'Значение'],
          ['Общая сумма (USD)', Math.round(model.a.total)],
          ['Количество сделок', model.a.count],
          ['Средний чек (USD)', Math.round(model.a.avg)]];
      case 'b':
        return [['Коридор', 'Количество', 'Сумма (USD)']]
          .concat(model.b.map((c) => [c.label, c.count, Math.round(c.sum)]));
      case 'c': {
        const head = ['Период'];
        const keys = Object.keys(model.c.byKey);
        keys.forEach((k) => head.push(k + ' · Сумма', k + ' · Кол-во'));
        const rows = [head];
        model.c.xKeys.forEach((xk, i) => {
          const r = [model.c.xLabels[i]];
          keys.forEach((k) => {
            const cell = model.c.byKey[k][xk];
            r.push(cell ? Math.round(cell.sum) : 0, cell ? cell.cnt : 0);
          });
          rows.push(r);
        });
        return rows;
      }
      case 'd':
        return [['Этап', 'Кол-во', 'Сумма (USD)', 'Конв. кол-во %', 'Конв. сумма %']]
          .concat((model.d.stages || []).map((s) => [
            s.name, s.count, Math.round(s.sum),
            isFinite(s.convCountPct) ? Math.round(s.convCountPct * 10) / 10 : '',
            isFinite(s.convSumPct) ? Math.round(s.convSumPct * 10) / 10 : '',
          ]));
      case 'e':
        return [['Источник', 'Сумма (USD)', 'Кол-во', 'Средний чек (USD)']]
          .concat(model.e.map((r) => [r.source, Math.round(r.sum), r.count, Math.round(r.avg)]));
      default:
        return [['Нет данных']];
    }
  }

  const NAMES = { a: 'svodka', b: 'koridory', c: 'dinamika', d: 'voronka', e: 'istochniki' };

  function exportBlock(block, format) {
    const model = REPORT.getModel();
    if (!model) { alert('Сначала постройте отчёт.'); return; }
    const rows = rowsFor(block, model, model.meta.state);
    const base = 'otchet1_' + (NAMES[block] || block);
    if (format === 'xls') download(base + '.xls', toXls(base, rows), 'application/vnd.ms-excel');
    else download(base + '.csv', toCsv(rows), 'text/csv');
  }

  function printPdf() { window.print(); }

  return { exportBlock, printPdf };
})();
