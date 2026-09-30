import { chartDataFile, chartDataUnavailableReason, downloadChartData } from './chart-data.js';
import { capturePaneTarget } from './pane-target.js';
import { el, openOverlay, closeOverlay, toast } from './ui.js';

let closeCurrent = null;

function visibleBounds(chart) {
  const view = chart.getVisibleLogicalRange(), axis = chart.dataLayer;
  const first = Math.max(0, Math.ceil(view.from)), last = Math.min(axis.length - 1, Math.floor(view.to));
  const tail = chart.primaryBars().at(-1)?.time;
  if (first > last || tail === undefined) return null;
  const from = axis.indexToTime(first), to = Math.min(axis.indexToTime(last), tail);
  return Number.isFinite(from) && Number.isFinite(to) && from <= to ? { from, to } : null;
}

/** The dialog retains its chart, study IDs and visible bounds until it closes. */
export function openChartDataControls(app, target = capturePaneTarget(app)) {
  const reason = chartDataUnavailableReason(app, target);
  if (reason) { el('status').textContent = reason; toast('error', reason); return false; }
  closeCurrent?.();
  const modal = el('chartdatamodal');
  const primary = target.chart.primarySeries();
  const context = target.chart.getDataContext();
  const renderer = target.chart.primarySeriesInfo()?.type;
  const type = target.pane === 2 ? app.p2.chartType : app.chartType;
  const bounds = visibleBounds(target.chart);
  let closed = false;
  const listeners = [];
  const listen = (node, type, handler) => {
    node.addEventListener(type, handler); listeners.push(() => node.removeEventListener(type, handler));
  };
  const close = () => {
    if (closed) return;
    closed = true; listeners.splice(0).forEach(remove => remove());
    if (closeCurrent === close) { modal.hidden = true; closeCurrent = null; closeOverlay(modal); }
  };
  closeCurrent = close;
  const current = () => !closed && closeCurrent === close;
  const error = message => { el('csv-error').textContent = message; el('csv-error').hidden = false; };
  const clearError = () => { el('csv-error').textContent = ''; el('csv-error').hidden = true; };
  const assertCurrent = () => {
    const currentType = target.pane === 2 ? app.p2.chartType : app.chartType;
    if (!target.current() || target.chart.primarySeries() !== primary || currentType !== type
      || target.chart.getDataContext() !== context || target.chart.primarySeriesInfo()?.type !== renderer) {
      throw new Error('The chart changed; reopen the download controls');
    }
  };
  const studies = target.chart.indicators().map(study => ({ id: study.id, name: study.name }));
  if (!current()) return false;
  el('csv-source').textContent = `Chart ${target.pane}: ${target.request.symbol}, ${target.request.interval}`;
  el('csv-from').value = ''; el('csv-to').value = '';
  el('csv-alignment').value = 'source'; el('csv-comparisons').checked = true;
  clearError();
  const boxes = studies.map((study, index) => {
    const label = document.createElement('label'); label.className = 'csv-study';
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = true;
    const title = document.createElement('span'); title.textContent = `${index + 1}: ${study.name}`;
    label.appendChild(input); label.appendChild(title);
    return { id: study.id, input, label };
  });
  el('csv-studies').replaceChildren(...boxes.map(item => item.label));
  if (!boxes.length) el('csv-studies').textContent = 'No studies on this chart';
  listen(el('csv-close'), 'click', close); listen(el('csv-cancel'), 'click', close);
  listen(modal, 'pointerdown', event => event.stopPropagation());
  listen(modal, 'click', event => { if (event.target === modal) close(); });
  listen(el('csv-all-studies'), 'click', () => { boxes.forEach(item => { item.input.checked = true; }); clearError(); });
  listen(el('csv-no-studies'), 'click', () => { boxes.forEach(item => { item.input.checked = false; }); clearError(); });
  el('csv-visible').disabled = !bounds;
  listen(el('csv-visible'), 'click', () => {
    if (!bounds) return;
    el('csv-from').value = String(bounds.from); el('csv-to').value = String(bounds.to); clearError();
  });
  listen(el('csv-all-rows'), 'click', () => { el('csv-from').value = ''; el('csv-to').value = ''; clearError(); });
  listen(el('csv-download'), 'click', () => {
    if (!current()) return;
    try {
      assertCurrent();
      const range = {};
      for (const bound of ['from', 'to']) {
        const text = el(`csv-${bound}`).value.trim();
        if (text !== '') {
          const value = Number(text);
          if (!Number.isFinite(value)) throw new Error('Enter finite UTC seconds, or leave a bound empty');
          range[bound] = value;
        }
      }
      if (range.from !== undefined && range.to !== undefined && range.from > range.to) throw new Error('From must be no later than To');
      const options = { indicators: boxes.filter(item => item.input.checked).map(item => item.id),
        range, alignment: el('csv-alignment').value };
      if (!el('csv-comparisons').checked) options.comparisons = [];
      // Validation and serialization happen once, before any browser file action.
      const file = chartDataFile(app, target, options);
      if (!current()) return;
      assertCurrent();
      if (downloadChartData(app, target, options, file)) close();
      else error(el('status').textContent);
    } catch (failure) { if (current()) error(String(failure?.message || failure)); }
  });
  modal.hidden = false;
  openOverlay(modal, { initialFocus: el('csv-from'), close });
  return true;
}
