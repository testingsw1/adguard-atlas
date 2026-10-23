import '@fontsource-variable/space-grotesk';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_RANGE, parseRange } from '../shared/types';
import { App } from './App';
import { readConfig, readUrl, recall } from './config';
import { createDemoSource } from './sources/demo';
import { createSseSource } from './sources/sse';
import type { EventSourceAdapter } from './sources/types';
import { AtlasStore, type Theme } from './store';

const config = readConfig();
const url = readUrl();

// Live: RAM only bridges the gap between a query arriving and the arcs drawing it.
// Demo: the generator invents the whole window, as before.
const ramWindowMs = (config.archive ? config.liveBufferMinutes : config.windowMinutes) * 60_000;

const theme: Theme = url.theme ?? (recall('theme') === 'light' ? 'light' : 'dark');
document.documentElement.dataset.theme = theme;

const store = new AtlasStore(ramWindowMs, {
  theme,
  privacy: config.privacyForced || url.privacy || recall('privacy') === 'on',
});
store.setFilters({ range: url.range ?? parseRange(recall('range') ?? DEFAULT_RANGE) });

// Only an archive answers /api/stats; without one the store derives the view itself.
if (config.archive) store.enableServerStats();

// F23: the only place that knows where events come from.
const source: EventSourceAdapter =
  config.mode === 'demo' ? createDemoSource(config.windowMinutes * 60_000) : createSseSource();

source.start({
  onSnapshot: (events, status, now) => {
    store.reset(events, now);
    store.setStatus(status);
  },
  onEvents: (events) => store.ingest(events),
  onStatus: (status) => store.setStatus(status),
  onConnection: (state) => store.setConnection(state),
});
store.start();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App store={store} config={config} initialUrl={url} />
  </StrictMode>,
);
