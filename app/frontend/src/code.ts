import { esc } from './util';

type Seg = [string, string];

function vcls(v: string): string {
  const t = v.trim();
  if (!t) return '';
  if (/^-?\d+(\.\d+)?$/.test(t) || /^(true|false|null)$/.test(t)) return 'n';
  if (/^[\[{|>]/.test(t)) return 'p';
  if (t.startsWith('#')) return 'c';
  return 's';
}

// yamlTok splits one YAML line into key / punctuation / value segments.
export function yamlTok(l: string): Seg[] {
  if (/^\s*#/.test(l)) return [[l, 'c']];
  const m = l.match(/^(\s*)((?:- )*)([^\s"'#-][^:]*?|"[^"]*")(:)(?=\s|$)(.*)$/);
  if (m) {
    const out: Seg[] = [[m[1], ''], [m[2], 'p'], [m[3], 'k'], [m[4], 'p']];
    if (m[5]) out.push([m[5], vcls(m[5])]);
    return out;
  }
  const m2 = l.match(/^(\s*)((?:- )*)(.*)$/)!;
  const out: Seg[] = [[m2[1], ''], [m2[2], 'p']];
  if (m2[3]) out.push([m2[3], vcls(m2[3])]);
  return out;
}

// descTok colours kubectl describe output: "Key:" labels, and bad states red.
export function descTok(l: string): Seg[] {
  if (/^\s*#/.test(l)) return [[l, 'c']];
  if (/^\s*(Type|----)\s/.test(l)) return [[l, 'p']];
  const m = l.match(/^(\s*)([A-Za-z][\w .\/()-]*?:)(\s.*|)$/);
  if (m) {
    const v = m[3] || '';
    const c = /<none>|<unset>/.test(v) ? 'c' : /CrashLoop|OOMKilled|False|Waiting|Warning|BackOff|Error|Failed|Unhealthy/.test(v) ? 'e' : '';
    return [[m[1], ''], [m[2], 'k'], [v, c]];
  }
  const w = l.match(/^(\s*)(Warning)(.*)$/);
  if (w) return [[w[1], ''], [w[2], 'e'], [w[3], '']];
  return [[l, '']];
}

// logTok colours whole lines by level, for JSON (logrus/zap), logfmt, plain
// and klog (E0102 …) logs.
export function logTok(l: string): Seg[] {
  if (/"level":"(error|fatal|panic)"|\blevel=(error|fatal|panic)\b|\b(ERROR|FATAL|PANIC)\b|^[EF]\d{4} /.test(l)) return [[l, 'e']];
  if (/"level":"warn(ing)?"|\blevel=warn(ing)?\b|\bWARN(ING)?\b|^W\d{4} /.test(l)) return [[l, 'w']];
  return [[l, '']];
}

// logLineHTML renders one log line without find marks, for appending.
export function logLineHTML(n: number, l: string): string {
  return '<div class="ln"><span class="g">' + n + '</span><span>' + logTok(l).map(([t, c]) => sp(t, c)).join('') + '</span></div>';
}

function sp(t: string, c: string): string {
  return c ? '<span class="y-' + c + '">' + esc(t) + '</span>' : esc(t);
}

// codeHTML renders numbered lines, marking every case-insensitive hit of q and
// the current one (index cur) separately. Returns the total hit count.
export function codeHTML(text: string, q: string, cur: number, tk: (l: string) => Seg[], start = 1): { html: string; total: number } {
  const ql = q.toLowerCase();
  let idx = 0, html = '';
  text.replace(/\n$/, '').split('\n').forEach((ln, i) => {
    const r: [number, number, number][] = [];
    if (ql) {
      const lo = ln.toLowerCase();
      let p = 0;
      while ((p = lo.indexOf(ql, p)) > -1) { r.push([p, p + ql.length, idx++]); p += ql.length; }
    }
    let pos = 0, s = '';
    tk(ln).forEach(([txt, c]) => {
      const a = pos, b = pos + txt.length;
      let q2 = a;
      r.forEach((x) => {
        if (x[1] <= q2 || x[0] >= b) return;
        const st = Math.max(x[0], q2), en = Math.min(x[1], b);
        if (st > q2) s += sp(ln.slice(q2, st), c);
        s += '<mark class="' + (x[2] === cur ? 'mc' : '') + '">' + sp(ln.slice(st, en), c) + '</mark>';
        q2 = en;
      });
      if (q2 < b) s += sp(ln.slice(q2, b), c);
      pos = b;
    });
    const isc = r.some((x) => x[2] === cur);
    html += '<div class="ln' + (isc ? ' cur' : '') + '"><span class="g">' + (i + start) + '</span><span>' + s + '</span></div>';
  });
  return { html: '<div class="code">' + html + '</div>', total: idx };
}

export function scrollToMark(el: HTMLElement) {
  const m = el.querySelector('mark.mc');
  if (!m) return;
  const mr = m.getBoundingClientRect(), br = el.getBoundingClientRect();
  if (mr.top < br.top + 30 || mr.bottom > br.bottom - 30) el.scrollTop += mr.top - br.top - br.height / 2;
  if (mr.left < br.left + 60 || mr.right > br.right - 20) el.scrollLeft += mr.left - br.left - br.width / 2;
}
