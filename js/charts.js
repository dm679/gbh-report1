/* =============================================================================
 * CHARTS — обёртки над ECharts: линейный график динамики (C) и funnel (D).
 * ===========================================================================*/
window.CHARTS = (function () {
  let lineChart = null;
  let funnelChart = null;

  function ensure(id, ref) {
    const el = document.getElementById(id);
    if (!ref) ref = echarts.init(el);
    return ref;
  }

  /* --- C. Динамика: ось X — бакеты времени; две оси Y (Сумма, Количество).
   * series: { byKey: { seriesName: { sum:[], cnt:[] } }, xLabels:[] }
   * breakdownLabel — подпись разреза (Проекты/Менеджеры/Воронки).
   */
  function renderLine(model, breakdownLabel) {
    lineChart = ensure('chart-line', lineChart);
    const x = model.xLabels;

    // Строим серии: для каждого значения разреза — линия суммы и линия количества.
    // Чтобы не перегружать, при одном разрезе ("Все") показываем 2 линии.
    const series = [];
    const legend = [];
    const keys = Object.keys(model.byKey);

    keys.forEach((k) => {
      const sumData = model.xKeys.map((xk) => Math.round(model.byKey[k][xk] ? model.byKey[k][xk].sum : 0));
      const cntData = model.xKeys.map((xk) => (model.byKey[k][xk] ? model.byKey[k][xk].cnt : 0));
      const sumName = keys.length > 1 ? `${k} · Сумма` : 'Сумма, $';
      const cntName = keys.length > 1 ? `${k} · Кол-во` : 'Количество, шт';
      legend.push(sumName, cntName);
      series.push({
        name: sumName, type: 'line', smooth: true, yAxisIndex: 0,
        data: sumData, symbolSize: 6,
      });
      series.push({
        name: cntName, type: 'line', smooth: true, yAxisIndex: 1,
        lineStyle: { type: 'dashed' }, data: cntData, symbolSize: 6,
      });
    });

    lineChart.setOption({
      tooltip: { trigger: 'axis' },
      // легенда внизу со скроллом — не пересекается с осями/графиком
      legend: { data: legend, type: 'scroll', bottom: 0, left: 'center', itemGap: 14 },
      grid: { left: 58, right: 52, top: 28, bottom: 56 },
      xAxis: { type: 'category', data: x, boundaryGap: false },
      yAxis: [
        { type: 'value', name: 'Сумма, $', nameGap: 14, position: 'left',
          axisLabel: { formatter: (v) => '$' + (v / 1000) + 'k' } },
        { type: 'value', name: 'Кол-во', nameGap: 14, position: 'right', splitLine: { show: false } },
      ],
      series,
    }, true);
    lineChart.resize();
  }

  /* --- D. Воронка: funnel-пирамида (широкое основание = входящие). --------
   * stages: [{ name, count, sum, convCountPct, convSumPct, trendCount, trendSum }]
   * metric: 'count' | 'sum' — что показывать размером пирамиды.
   */
  function renderFunnel(stages, metric) {
    // высота подстраивается под число этапов, чтобы подписи не накладывались
    const el = document.getElementById('chart-funnel');
    const h = Math.min(1600, Math.max(320, stages.length * 30 + 30));
    el.style.height = h + 'px';
    funnelChart = ensure('chart-funnel', funnelChart);
    funnelChart.resize();
    const valOf = (s) => metric === 'sum' ? Math.round(s.sum) : s.count;
    const data = stages.map((s) => ({
      value: valOf(s),
      name: s.name,
      _stage: s,
    }));

    // минимальная ширина сегмента и ширина подписи — чтобы текст не выезжал.
    // даже у нулевых этапов сегмент будет достаточно широким для подписи.
    const w = el.clientWidth || 520;
    const minFrac = 0.55;
    const labelW = Math.max(90, Math.round(w * 0.96 * minFrac) - 18);

    funnelChart.setOption({
      tooltip: {
        trigger: 'item',
        formatter: function (p) {
          const s = p.data._stage;
          const arrow = (t) => t > 0 ? '↑' : (t < 0 ? '↓' : '=');
          return `<b>${UTIL.esc(s.name)}</b><br/>`
            + `Кол-во: ${UTIL.num(s.count)} шт ${arrow(s.trendCount)}<br/>`
            + `Сумма: ${UTIL.money(s.sum)} ${arrow(s.trendSum)}<br/>`
            + `Конверсия (кол-во): ${UTIL.pct(s.convCountPct)}<br/>`
            + `Конверсия (сумма): ${UTIL.pct(s.convSumPct)}`;
        },
      },
      series: [{
        type: 'funnel',
        sort: 'ascending',          // пирамида: узкий верх, широкое основание снизу
        funnelAlign: 'center',
        gap: 2,
        top: 10, bottom: 10, left: '2%', right: '2%',
        minSize: (minFrac * 100) + '%', maxSize: '100%',
        label: {
          position: 'inside',
          formatter: function (p) {
            const s = p.data._stage;
            const main = metric === 'sum' ? UTIL.money(s.sum) : UTIL.num(s.count) + ' шт';
            return `${s.name} · ${main}`;
          },
          fontSize: 12, overflow: 'truncate', width: labelW,
        },
        labelLine: { show: false },
        data,
      }],
    }, true);
    funnelChart.resize();
  }

  function resize() {
    if (lineChart) lineChart.resize();
    if (funnelChart) funnelChart.resize();
  }

  return { renderLine, renderFunnel, resize };
})();
