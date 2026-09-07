import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const container = document.getElementById('root');
if (!container) throw new Error('#root 없음');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
