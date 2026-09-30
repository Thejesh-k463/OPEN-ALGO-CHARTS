import { EventDetailsPopup } from '/dist/openalgo-charts.widget.mjs';
import { popupMenu } from './menus.js';
import { capturePaneTarget } from './pane-target.js';
import { el } from './ui.js';

const attachments = new WeakMap();
const GROUPS = [
  { id: 'company', label: 'Company' },
  { id: 'results', label: 'Results', parentId: 'company' },
  { id: 'news', label: 'News' },
];

export function sampleTimelineEvents(bars) {
  if (!bars.length) return [];
  const at = fraction => bars[Math.min(bars.length - 1, Math.floor(bars.length * fraction))].time;
  return [
    { id: 'sample-results', time: at(0.65), type: 'earnings', label: 'E', group: 'results',
      title: 'Sample results announcement', details: { summary: 'Demonstration data, not a real company announcement.',
        fields: [{ label: 'Source', value: 'Reference host sample' }] } },
    { id: 'sample-call', time: at(0.65) + 1, type: 'news', label: 'N', group: 'news',
      title: 'Sample investor call', details: 'Two nearby events share a marker when clustering is enabled.' },
    { id: 'sample-dividend', time: at(0.82), type: 'dividend', label: 'D', group: 'company',
      title: 'Sample dividend date', details: 'This marker demonstrates group filtering and details. It is not financial event data.' },
  ];
}

export function attachTimeline(app, pane, bars) {
  const target = capturePaneTarget(app, pane);
  if (!target || attachments.has(target.chart)) return;
  const container = el(pane === 2 ? 'chart2' : 'chart');
  const popup = new EventDetailsPopup(container, { formatTime: time => new Intl.DateTimeFormat(undefined, {
    timeZone: target.chart.timezone(), dateStyle: 'medium', timeStyle: 'short',
  }).format(new Date(time * 1000)) });
  const entry = { popup, bars, app, pane };
  attachments.set(target.chart, entry);
  target.chart.setEventMarkerOptions({ clustering: true });
  target.chart.setEventGroups(GROUPS);
  target.chart.on('event:click', details => popup.open(details, details.point));
  target.chart.on('data:context', () => popup.close());
  target.chart.on('events:change', () => popup.close());
  target.chart.on('destroy', () => { popup.destroy(); attachments.delete(target.chart); });
  refreshTimeline(target.chart, entry);
}

function refreshTimeline(chart, entry) {
  chart.setEvents(entry.app.sampleEvents ? sampleTimelineEvents(entry.bars) : []);
}

export function openTimelineMenu(app, anchor) {
  const target = capturePaneTarget(app);
  if (!target) return;
  const markers = target.chart.eventMarkers();
  popupMenu(anchor, [
    { group: 'Timeline events (sample data)' },
    { label: 'Show sample events', check: true, on: app.sampleEvents === true, onSelect: () => {
      app.sampleEvents = !app.sampleEvents;
      for (const chart of [app.chart, app.chart2]) {
        const entry = chart && attachments.get(chart);
        if (entry) refreshTimeline(chart, entry);
      }
    } },
    { label: 'Cluster nearby events', check: true, on: markers?.options().clustering, onSelect: () => {
      if (target.current()) target.chart.setEventMarkerOptions({ clustering: !markers.options().clustering });
    } },
    ...GROUPS.map(group => ({ label: group.label, check: true, on: markers?.isGroupVisible(group.id),
      onSelect: () => {
        if (target.current()) target.chart.setEventGroupVisible(group.id, !markers.isGroupVisible(group.id));
      } })),
  ]);
}
