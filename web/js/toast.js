// Inline, non-blocking toasts for load errors and notices.
import { esc } from './util.js';

export function toast(message, kind = 'error', ms = 9000) {
  const host = document.getElementById('toasts');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  el.innerHTML = `<span class="toast-dot" aria-hidden="true"></span><span>${esc(message)}</span><button type="button" class="toast-x" aria-label="×">×</button>`;
  el.querySelector('button').addEventListener('click', () => el.remove());
  host.appendChild(el);
  if (ms) setTimeout(() => el.remove(), ms);
}
