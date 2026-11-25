export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function terms(q: string): string[] {
  return q.toLowerCase().split(/\s+/).filter(Boolean);
}

export function hit(hay: string, ts: string[]): boolean {
  hay = hay.toLowerCase();
  return ts.every((t) => hay.includes(t));
}

// hl wraps every occurrence of every term in <mark>, merging overlaps.
export function hl(text: string, ts: string[]): string {
  if (!ts.length) return esc(text);
  const lo = text.toLowerCase();
  const r: [number, number][] = [];
  ts.forEach((t) => {
    let p = 0;
    while ((p = lo.indexOf(t, p)) > -1) { r.push([p, p + t.length]); p += t.length; }
  });
  if (!r.length) return esc(text);
  r.sort((a, b) => a[0] - b[0]);
  const m = [r[0].slice() as [number, number]];
  r.slice(1).forEach((x) => {
    const l = m[m.length - 1];
    if (x[0] <= l[1]) l[1] = Math.max(l[1], x[1]); else m.push([x[0], x[1]]);
  });
  let o = '', p = 0;
  m.forEach((x) => { o += esc(text.slice(p, x[0])) + '<mark>' + esc(text.slice(x[0], x[1])) + '</mark>'; p = x[1]; });
  return o + esc(text.slice(p));
}

// sc maps a status string to a dot colour.
export function sc(s: string): string {
  if (!s) return '';
  const m = s.match(/^(\d+)\/(\d+)$/);
  if (m) return m[1] === m[2] ? 'ok' : 'warn';
  if (/CrashLoop|Error|Failed|Degraded|NotReady|Warning|not ready|OOMKilled|ImagePull|ErrImage|Unknown|Lost|OutOfSync|Init:Err/.test(s)) return 'err';
  if (/Pending|Progressing|Scheduling|Drifted|Terminating|ContainerCreating|Init:|Suspended|Released/.test(s)) return 'warn';
  return 'ok';
}

export function age(created: number): string {
  if (!created) return '';
  let s = Math.max(0, Math.floor(Date.now() / 1000 - created));
  if (s < 120) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 120) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h';
  const d = Math.floor(h / 24);
  return d < 730 ? d + 'd' : Math.floor(d / 365) + 'y';
}

export const IC = {
  search: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/></svg>',
  x: '<svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" stroke-width="1.5"><path d="M2 2l6 6M8 2 2 8"/></svg>',
  split: '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M8 2.5v11"/></svg>',
  copy: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="5" y="5" width="9" height="9" rx="1.5"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5"/></svg>',
  lock: '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>',
  up: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M10 3 5 8l5 5"/></svg>',
  down: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6"><path d="m6 3 5 5-5 5"/></svg>',
  refresh: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3"/></svg>',
  chevD: '<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="m2 3.5 3 3 3-3"/></svg>',
  pin: '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M10 1.5 14.5 6l-2 .8-2.7 2.7.4 3-1.2 1.2-3-3L2 14.7l-.7-.7L5.2 10l-3-3 1.2-1.2 3 .4 2.7-2.7z"/></svg>',
  wheel: '<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="var(--accent)" stroke-width="1.6"><circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="2"/><path d="M10 3v5M10 12v5M3 10h5M12 10h5"/></svg>',
  cluster: '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M8 1.5 14 5v6l-6 3.5L2 11V5z"/><path d="M8 8.5V14.5M8 8.5 14 5M8 8.5 2 5"/></svg>',
};
