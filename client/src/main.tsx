import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ApiSource } from './data/apiSource';
import { MockSource } from './data/mockSource';
import type { TrackerSource } from './data/source';
import './styles.css';

// Created once, outside React, so StrictMode's double render doesn't open two streams.
const source: TrackerSource = import.meta.env.VITE_DATA_SOURCE === 'mock'
  ? new MockSource()
  : new ApiSource(import.meta.env.VITE_API_BASE ?? '');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App source={source} />
  </StrictMode>,
);
