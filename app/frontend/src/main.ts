import '@fontsource/inter/400';
import '@fontsource/inter/600';
import '@fontsource/jetbrains-mono/400';
import '@fontsource/jetbrains-mono/600';
import './tokens.css';
import './style.css';

import * as Go from '../wailsjs/go/main/App';
import { EventsOn, ClipboardSetText } from '../wailsjs/runtime/runtime';
import { buildCats, catTypes, ABBR, HELM_KEY, type Cat, type NavType, type Type } from './cats';
import { codeHTML, descTok, logLineHTML, logTok, scrollToMark, yamlTok } from './code';
import { IC, age, esc, hit, hl, sc, terms } from './util';

/* ---------- types ---------- */
interface Ctx { name: string; short: string; where: string; env: string; provider: string; cluster: string; user: string; namespace: string; server: string }
interface Row { name: string; namespace?: string; status: string; ready?: string; restarts: number; node?: string; created: number; extra?: Record<string, string> }
type TabKind = 'list' | 'desc' | 'yaml' | 'logs' | 'cluster' | 'overview';
type ResView = 'desc' | 'yaml' | 'logs';
interface Tab {
  id: string; t: TabKind; key?: string; ns?: string; name?: string; preview?: boolean;
  q: string; cur: number; scroll?: number; stick?: boolean;
  sort?: { col: string; desc: boolean }; // list tabs; unset = the server's order
  text?: string; err?: string; loading?: boolean;
  secretKeys?: string[]; revealed?: Record<string, string>;
}
interface Addon { category: string; name: string; version: string; namespace: string; workload: string; image: string }
interface ContainerInfo { name: string; kind: string; default: boolean }
// LogState is shared by every copy of a logs tab (a split shows the same id).
interface LogState {
  streamId: string; containers: ContainerInfo[] | null; container: string; previous: boolean; tail: number;
  lines: string[]; dropped: number; err: string; done: boolean;
}
interface NodeGroup { provisioner: string; pool: string; instanceType: string; capacity: string; arch: string; osImage: string; kernels: string; imageId: string; nodes: number }
interface Group { tabs: Tab[]; active: number }
interface ListState { id: string; key: string; ns: string; rows: Row[] | null; err: string }
interface WS {
  status: 'connecting' | 'ready' | 'error'; err: string;
  cats: Cat[]; all: Record<string, NavType>; namespaces: string[]; nsErr: string;
  ns: string; filter: string; counts: Record<string, number | null>; countErrs: Record<string, string>; countToken: string;
  groups: Group[]; focus: number; ratio: number; lists: Record<string, ListState>; logs: Record<string, LogState>;
  info?: any;
  details?: { addons: Addon[]; kubelets: { version: string; nodes: number }[]; nodeGroups: NodeGroup[]; errors?: string[] };
  detailsState?: 'loading' | 'done' | string;
}

/* ---------- state (in memory only) ---------- */
const St = {
  view: 'home' as 'home' | 'ctx',
  contexts: [] as Ctx[], ctxErr: '',
  open: [] as string[], // connected this session, newest first
  pins: [] as string[], // pinned to the rail and saved across restarts (names only)
  active: null as string | null,
  hq: '', hsel: 0, prov: '',
  ws: {} as Record<string, WS>,
};
const CTX = (n: string) => St.contexts.find((c) => c.name === n) || ({ name: n, short: n, where: '', env: 'other' } as Ctx);
const ws = (n = St.active!) => St.ws[n];
const root = document.getElementById('kx')!;
const $ = (s: string) => root.querySelector(s) as HTMLElement;
let seq = 0;
const uid = () => String(++seq);

/* ---------- theme: follow the OS, dark first ---------- */
const mq = window.matchMedia('(prefers-color-scheme: light)');
const setTheme = () => document.documentElement.setAttribute('data-theme', mq.matches ? 'light' : 'dark');
mq.addEventListener('change', setTheme);
setTheme();

/* ---------- shell ---------- */
root.innerHTML = '<aside class="rail" id="rail"></aside><section class="home" id="home"></section><main class="center" id="center"><header class="ctxbar" id="ctxbar"></header><div class="editor" id="editor"></div></main><aside class="nav" id="nav"><div class="navtop"><div class="lbl"><span>Namespace</span></div><div class="nsbox"><input id="ns" placeholder="Type to filter namespaces" autocomplete="off" spellcheck="false"><span class="nschev">' + IC.chevD + '</span><div class="nsdrop" id="nsdrop" hidden></div></div><div class="search">' + IC.search + '<input id="tf" placeholder="Filter types or names — po, sts, upbound…" autocomplete="off" spellcheck="false"><kbd>/</kbd></div></div><div class="navlist" id="navlist"></div></aside><div class="toast" id="toast"></div>';

function render() {
  root.classList.toggle('homeview', St.view === 'home');
  renderRail();
  if (St.view === 'home') renderHome();
  else { renderCtxbar(); renderNsSelect(); renderNav(); renderEditor(); }
}

/* ---------- rail ---------- */
// railList is the rail's order: pinned contexts first, as pinned, then other
// open ones, newest on top. ⌘1–9 follow it. Pins missing from the kubeconfig
// stay saved but aren't shown.
function railList(): string[] {
  const known = new Set(St.contexts.map((c) => c.name));
  const pins = St.pins.filter((n) => known.has(n));
  return pins.concat(St.open.filter((n) => !pins.includes(n)));
}

function renderRail() {
  let h = '<div class="brand">' + IC.wheel + '<span>Kompass</span><span class="rk">read-only</span></div>';
  h += '<button class="findctx' + (St.view === 'home' ? ' on' : '') + '" data-home>' + IC.search + '<span>Find context</span><kbd>⌘K</kbd></button><div class="sect">Contexts</div><div class="ctxs">';
  const list = railList();
  if (!list.length) h += '<div class="railempty">Contexts you open land here, newest on top. Pin one to keep it here next time.</div>';
  list.forEach((id, i) => {
    const c = CTX(id), open = !!St.ws[id], pinned = St.pins.includes(id);
    h += '<div class="ctx' + (St.view !== 'home' && St.active === id ? ' on' : '') + (open ? '' : ' off') + '" data-ctx="' + esc(id) + '" title="' + esc(c.name) + (open ? '' : ' — not connected; click to connect') + '"><span class="nm">' + esc(c.short).replace(/-/g, '-<wbr>') + '</span><span class="tail">' + (i < 9 ? '<kbd>⌘' + (i + 1) + '</kbd>' : '') +
      '<button class="pn' + (pinned ? ' on' : '') + '" data-pin="' + esc(id) + '" title="' + (pinned ? 'Unpin' : 'Pin to keep it here after a restart') + '">' + IC.pin + '</button>' +
      (open ? '<button class="x" data-x="' + esc(id) + '" title="' + (pinned ? 'Disconnect (stays pinned)' : 'Close context') + '">' + IC.x + '</button>' : '') +
      '</span><span class="meta"><span class="env ' + c.env + '">' + c.env + '</span><span class="wh">' + esc(c.where.replace(/^(EKS|GKE) · /, '')) + '</span></span></div>';
  });
  h += '</div><div class="railfoot">~/.kube/config · ' + St.contexts.length + ' contexts<br>Auth via kubeconfig exec plugins · only pinned names are saved</div>';
  $('#rail').innerHTML = h;
}

function togglePin(name: string) {
  St.pins = St.pins.includes(name) ? St.pins.filter((n) => n !== name) : St.pins.concat(name);
  Go.SetPinned(St.pins).catch((e) => toast('Couldn’t save pins: ' + e));
  renderRail();
  if (St.view === 'home') renderHomeList();
}

// goCtx is the rail and ⌘n action: switch if connected, else connect.
function goCtx(name: string) {
  if (St.ws[name]) switchCtx(name); else openCtx(name);
}

/* ---------- home ---------- */
function filteredCtx() {
  const ts = terms(St.hq);
  return St.contexts.filter((c) => (!St.prov || c.provider === St.prov) && hit(c.name + ' ' + c.short + ' ' + c.where + ' ' + c.env, ts));
}
function renderHome() {
  if (!document.getElementById('hq')) {
    $('#home').innerHTML = '<div class="wrap"><h1>Open a cluster context</h1><p class="lede" id="lede"></p><div class="bigs">' + IC.search + '<input id="hq" placeholder="Type any part of a context — e.g. prod eu, staging, 4444" autocomplete="off" spellcheck="false"></div><div class="provs" id="provs"></div><div class="hlist" id="hlist"></div><div class="hint"><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>⌘1–9</kbd> jump to an open context</span><span><kbd>Esc</kbd> back</span></div></div>';
  }
  $('#lede').innerHTML = 'Read live from <code>~/.kube/config</code> and <code>$KUBECONFIG</code> · ' + St.contexts.length + ' contexts · credentials stay with your exec plugins, and Kompass keeps no cluster data.';
  ($('#hq') as HTMLInputElement).value = St.hq;
  renderHomeList();
  setTimeout(() => $('#hq')?.focus(), 0);
}
const PROVIDERS: [string, string][] = [['aws', 'AWS'], ['gcp', 'GCP'], ['azure', 'Azure'], ['kind', 'kind']];

function renderProvs() {
  const n = (p: string) => St.contexts.filter((c) => c.provider === p).length;
  $('#provs').innerHTML = '<button class="prov' + (St.prov ? '' : ' on') + '" data-prov="">All<span>' + St.contexts.length + '</span></button>' +
    PROVIDERS.map(([p, l]) => { const c = n(p); return '<button class="prov' + (St.prov === p ? ' on' : '') + '" data-prov="' + p + '"' + (c ? '' : ' disabled') + '>' + l + '<span>' + c + '</span></button>'; }).join('');
}

function renderHomeList() {
  renderProvs();
  const ts = terms(St.hq), L = filteredCtx();
  if (St.hsel >= L.length) St.hsel = Math.max(0, L.length - 1);
  if (St.ctxErr) { $('#hlist').innerHTML = '<div class="state"><div><div class="big">Couldn’t read kubeconfig</div><pre>' + esc(St.ctxErr) + '</pre></div></div>'; return; }
  $('#hlist').innerHTML = L.length ? L.map((c, i) => '<div class="hrow' + (i === St.hsel ? ' sel' : '') + '" data-hctx="' + esc(c.name) + '"><span class="env ' + c.env + '">' + c.env + '</span><div style="min-width:0"><div class="s1">' + hl(c.short, ts) + '</div><div class="s2">' + esc(c.where) + '</div></div><span class="full" title="' + esc(c.name) + '">' + hl(c.name, ts) + '</span><span class="tag">' + (St.ws[c.name] ? 'open' : St.pins.includes(c.name) ? 'pinned' : '') + '</span></div>').join('')
    : '<div class="blank">No ' + (St.prov ? esc(PROVIDERS.find((p) => p[0] === St.prov)![1]) + ' ' : '') + 'context matches “' + esc(St.hq) + '”</div>';
  $('#hlist .hrow.sel')?.scrollIntoView({ block: 'nearest' });
}

/* ---------- context bar ---------- */
function renderCtxbar() {
  const c = CTX(St.active!);
  const col = ({ prod: 'var(--env-prod)', staging: 'var(--env-staging)', dev: 'var(--env-dev)' } as Record<string, string>)[c.env] || 'transparent';
  $('#ctxbar').style.setProperty('--envc', col);
  $('#ctxbar').innerHTML = '<span class="env ' + c.env + '">' + c.env + '</span><span class="short">' + esc(c.short) + '</span><span class="where">' + esc(c.where) + '</span><span class="full" title="' + esc(c.name) + '">' + esc(c.name) + '</span><button class="ib" data-copy title="Copy full context name">' + IC.copy + '</button><span class="ro">' + IC.lock + 'Read-only · get / list / watch</span>';
}

/* ---------- nav ---------- */
// The namespace picker is a combobox: type to filter, ↑ ↓ to move, Enter to
// pick. Enter on a name that isn't listed still uses it, for contexts that
// can't list namespaces.
const NS_ALL = 'All namespaces';
const nsPick = { open: false, q: '', sel: 0 };

function renderNsSelect() {
  const W = ws(), inp = $('#ns') as HTMLInputElement;
  if (!nsPick.open) inp.value = W.ns === 'all' ? NS_ALL : W.ns;
  inp.title = W.nsErr ? 'Can’t list namespaces: ' + W.nsErr + '. Type a namespace and press Enter.' : '';
  ($('#tf') as HTMLInputElement).value = W.filter;
}

function nsOptions(): string[] {
  const W = ws(), ts = terms(nsPick.q);
  const opts = W.namespaces.filter((n) => hit(n, ts));
  if (!ts.length || hit(NS_ALL, ts)) opts.unshift('all');
  return opts;
}

function renderNsDrop() {
  const drop = $('#nsdrop'), W = ws();
  drop.hidden = !nsPick.open;
  if (!nsPick.open) return;
  const ts = terms(nsPick.q), opts = nsOptions();
  if (nsPick.sel >= opts.length) nsPick.sel = Math.max(0, opts.length - 1);
  drop.innerHTML = opts.length
    ? opts.map((n, i) => '<div class="nsopt' + (i === nsPick.sel ? ' sel' : '') + (n === W.ns ? ' on' : '') + '" data-nsopt="' + esc(n) + '">' + (n === 'all' ? '<span class="nsall">' + hl(NS_ALL, ts) + '</span>' : hl(n, ts)) + '</div>').join('')
    : '<div class="nsnone">' + (nsPick.q.trim() ? 'Enter to use “' + esc(nsPick.q.trim()) + '”' : 'No namespaces') + '</div>';
  drop.querySelector('.nsopt.sel')?.scrollIntoView({ block: 'nearest' });
}

function openNsPick() {
  const W = ws();
  nsPick.open = true;
  nsPick.q = '';
  nsPick.sel = Math.max(0, nsOptions().indexOf(W.ns));
  const inp = $('#ns') as HTMLInputElement;
  inp.value = '';
  inp.placeholder = W.ns === 'all' ? NS_ALL : W.ns;
  renderNsDrop();
}

function closeNsPick() {
  nsPick.open = false;
  ($('#ns') as HTMLInputElement).placeholder = 'Type to filter namespaces';
  renderNsDrop();
  renderNsSelect();
}

function setNs(ns: string) {
  const W = ws();
  closeNsPick();
  ($('#ns') as HTMLInputElement).blur();
  if (!ns || ns === W.ns) return renderNsSelect();
  W.ns = ns;
  renderNsSelect();
  refreshCounts(St.active!);
  syncLists(St.active!);
  renderNav();
  renderEditor();
}

{
  const inp = $('#ns') as HTMLInputElement;
  inp.addEventListener('focus', openNsPick);
  inp.addEventListener('blur', () => { if (nsPick.open) closeNsPick(); });
  inp.addEventListener('input', () => { nsPick.q = inp.value; nsPick.sel = 0; renderNsDrop(); });
  inp.addEventListener('keydown', (e) => {
    if (!nsPick.open) { if (e.key === 'ArrowDown' || e.key === 'Enter') { e.preventDefault(); openNsPick(); } return; }
    const opts = nsOptions();
    if (e.key === 'ArrowDown') { e.preventDefault(); nsPick.sel = Math.min(opts.length - 1, nsPick.sel + 1); renderNsDrop(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); nsPick.sel = Math.max(0, nsPick.sel - 1); renderNsDrop(); }
    else if (e.key === 'Enter') { e.preventDefault(); setNs(opts[nsPick.sel] ?? nsPick.q.trim()); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeNsPick(); inp.blur(); }
  });
  // mousedown, not click, so the pick lands before the input blurs.
  $('#nsdrop').addEventListener('mousedown', (e) => {
    e.preventDefault();
    const o = (e.target as HTMLElement).closest('[data-nsopt]') as HTMLElement | null;
    if (o) setNs(o.dataset.nsopt!);
  });
}

function count(t: NavType): number | null {
  if (t.pseudo === 'overview' || t.pseudo === 'disabled') return null;
  const n = ws().counts[t.key];
  return n === undefined ? null : n;
}
function activeTabIds() {
  const o: Record<string, boolean> = {};
  ws().groups.forEach((g) => { const t = g.tabs[g.active]; if (t) o[t.id] = true; });
  return o;
}
const tmatch = (t: NavType, ts: string[]) => hit(t.label + ' ' + t.kind + ' ' + t.short.join(' ') + ' ' + t.group, ts);

function renderNav() {
  const W = ws(), el = $('#navlist');
  if (W.status !== 'ready') { el.innerHTML = ''; return; }
  const ts = terms(W.filter), act = activeTabIds();
  let h = resourceHits(ts);
  h += '<div class="row top' + (act.cluster ? ' on' : '') + '" data-cluster>' + IC.cluster + '<span class="lb">Cluster</span><span class="n" title="Kubernetes control plane">' + esc(W.info?.version || 'info') + '</span></div>';
  W.cats.forEach((c) => {
    const all = catTypes(c);
    let total = 0, known = false;
    all.forEach((t) => { const n = count(t); if (n != null) { total += n; known = true; } });
    const counted = all.filter((t) => t.pseudo !== 'overview' && t.pseudo !== 'disabled');
    const pending = counted.some((t) => W.counts[t.key] === undefined && !W.countErrs[t.key]);
    const errored = counted.some((t) => W.countErrs[t.key]);
    // Hide only when it's known to have nothing to show (forbidden counts as
    // unknown); the text filter never hides a category.
    if (!pending && !errored && total === 0) return;
    if (c.flat) { h += typeRow(all[0], ts, act, true, false); return; }
    let rows = '', shown = 0;
    c.types.forEach((t) => { const r = typeRow(t, ts, act, false, false); if (r) { rows += r; shown++; } });
    (c.sub || []).forEach((s) => {
      let sr = '';
      const gh = hit(s.name, ts);
      s.types.forEach((t) => { if (count(t) === 0 && !ts.length) return; sr += typeRow(t, ts, act, false, gh && ts.length > 0); });
      if (sr) { rows += '<div class="sub" title="' + esc(s.name) + '">' + hl(s.name, ts) + '</div>' + sr; shown++; }
    });
    h += '<div class="cat' + (shown ? '' : ' dim') + '"><span>' + esc(c.name) + '</span><span>' + (known ? total : '') + '</span></div>' + rows;
  });
  el.innerHTML = h;
}

function typeRow(t: NavType, ts: string[], act: Record<string, boolean>, flat: boolean, groupHit: boolean): string {
  const tm = !ts.length || tmatch(t, ts) || groupHit;
  if (!tm && !flat) return '';
  const W = ws(), n = count(t), dis = t.pseudo === 'disabled', err = W.countErrs[t.key];
  const on = act['l:' + t.key] || (t.pseudo === 'overview' && act.overview);
  const scope = !t.namespaced && W.ns !== 'all' && !t.pseudo ? '<span class="scope">cluster</span>' : '';
  const num = dis ? '<span class="note">' + esc(t.note || '') + '</span>' : t.pseudo === 'overview' ? '' :
    err ? '<span class="n err" title="' + esc(err) + '">–</span>' : '<span class="n">' + (n == null ? '…' : n) + '</span>';
  return '<div class="row' + (flat ? ' top' : '') + (on ? ' on' : '') + (dis ? ' dis' : '') + (tm ? '' : ' nomatch') + '" data-type="' + esc(t.key) + '" title="' + esc(t.kind + (t.group ? '.' + t.group : '')) + '"><span class="lb">' + hl(t.label, ts) + '</span>' + scope + num + '</div>';
}

// Borrowed from Option A: names typed into the nav filter jump straight to
// resources already loaded in this workspace's lists.
function resourceHits(ts: string[]): string {
  if (!ts.length) return '';
  const W = ws(), out: string[] = [];
  for (const L of Object.values(W.lists)) {
    const t = W.all[L.key];
    if (!t || !L.rows) continue;
    for (const r of L.rows) {
      if (out.length >= 8) break;
      if (hit(r.name, ts)) out.push('<div class="row" data-hit="' + esc(L.key) + '|' + esc(r.namespace || '') + '|' + esc(r.name) + '" title="' + esc((r.namespace ? r.namespace + '/' : '') + r.name) + '"><span class="kd">' + esc(ABBR[t.kind] || t.kind.toLowerCase()) + '</span><span class="dot ' + sc(r.status) + '"></span><span class="lb">' + hl(r.name, ts) + '</span>' + (r.namespace ? '<span class="ns">' + esc(r.namespace) + '</span>' : '') + '</div>');
    }
  }
  return out.length ? '<div class="nres"><div class="cat" style="padding-top:6px"><span>Resources</span><span>' + out.length + '</span></div>' + out.join('') + '</div>' : '';
}

/* ---------- editor ---------- */
function tabLabel(tab: Tab): string {
  if (tab.t === 'cluster') return '<span class="k">⎈</span><span class="t">Cluster</span>';
  if (tab.t === 'overview') return '<span class="k">wl</span><span class="t">Workloads overview</span>';
  const t = ws().all[tab.key!];
  const kind = t?.kind || tab.key!.split('/')[1];
  if (tab.t === 'list') return '<span class="k">list</span><span class="t">' + esc(t?.label || kind) + '</span>';
  return '<span class="k">' + esc(ABBR[kind] || kind.toLowerCase()) + '</span><span class="t">' + esc(tab.name) + '</span><span class="vw">' + ({ desc: 'describe', yaml: 'yaml', logs: 'logs' } as Record<string, string>)[tab.t] + '</span>';
}

function renderEditor() {
  const W = ws(), ed = $('#editor');
  ed.querySelectorAll<HTMLElement>('[data-body]').forEach((b) => {
    const g = W.groups[+b.dataset.body!]; const t = g?.tabs[g.active]; if (t) { t.scroll = b.scrollTop; t.stick = atBottom(b); }
  });
  if (W.status === 'connecting') { ed.innerHTML = '<div class="state"><div><div class="big">Connecting to ' + esc(CTX(St.active!).short) + '…</div>Running discovery. Exec plugins may take a moment to fetch a token.</div></div>'; return; }
  if (W.status === 'error') { ed.innerHTML = '<div class="state"><div><div class="big">Couldn’t connect</div><pre>' + esc(W.err) + '</pre><button class="btn" data-retry>Retry</button></div></div>'; return; }
  if (!W.groups.some((g) => g.tabs.length)) {
    ed.innerHTML = '<div class="blank"><div><div class="big">Pick a resource</div>Click a type on the right to list its resources here.<div class="keys"><kbd>/</kbd><span>filter resource types</span><kbd>⌘F</kbd><span>find in describe / YAML</span><kbd>⌘\\</kbd><span>split editor</span><kbd>⌘K</kbd><span>switch context</span></div></div></div>';
    return;
  }
  ed.innerHTML = W.groups.map((g, gi) => {
    const tab = g.tabs[g.active];
    const tabs = g.tabs.map((x, ti) => '<div class="tab' + (ti === g.active ? ' on' : '') + (x.preview ? ' pv' : '') + '" data-tab="' + gi + ',' + ti + '" title="' + esc(x.ns ? x.ns + ' / ' + x.name : x.name || '') + '">' + tabLabel(x) + '<button class="cx" data-close="' + gi + ',' + ti + '">' + IC.x + '</button></div>').join('');
    const flex = W.groups.length > 1 ? (gi === 0 ? W.ratio : 1 - W.ratio) : 1;
    return '<div class="group' + (W.focus === gi ? ' focused' : '') + '" data-g="' + gi + '" style="flex:' + flex + ' 1 0"><div class="tabs"><div class="tabscroll">' + tabs + '</div><div class="tabtools"><button class="ib' + (W.groups.length > 1 ? ' on' : '') + '" data-split title="' + (W.groups.length > 1 ? 'Join editors' : 'Split editor right') + ' (⌘\\)">' + IC.split + '</button></div></div>' + toolbar(tab, gi) + '<div class="body" data-body="' + gi + '"></div></div>';
  }).join('<div class="divider" data-div></div>');
  W.groups.forEach((_, gi) => renderBody(gi, true));
}

function viewsHTML(tab: Tab, gi: number) {
  const pod = tab.key === 'core/Pod';
  return '<div class="views"><button class="vb' + (tab.t === 'desc' ? ' on' : '') + '" data-view="' + gi + ',desc" title="kubectl describe">Describe</button><button class="vb' + (tab.t === 'yaml' ? ' on' : '') + '" data-view="' + gi + ',yaml" title="kubectl get -o yaml — opens as its own tab">YAML</button>' + (pod ? '<button class="vb' + (tab.t === 'logs' ? ' on' : '') + '" data-view="' + gi + ',logs" title="kubectl logs -f — opens as its own tab">Logs</button>' : '') + '</div>';
}

function toolbar(tab: Tab | undefined, gi: number): string {
  if (!tab) return '';
  const W = ws(), t = W.all[tab.key || ''];
  if (tab.t === 'yaml' || tab.t === 'desc') {
    return '<div class="toolbar"><div class="search">' + IC.search + '<input data-find="' + gi + '" placeholder="Find in ' + (tab.t === 'desc' ? 'describe' : 'YAML') + '  ⌘F" value="' + esc(tab.q) + '" autocomplete="off" spellcheck="false"></div><span class="cnt" data-cnt="' + gi + '"></span><button class="ib" data-prev="' + gi + '" title="Previous match (Shift+Enter)">' + IC.up + '</button><button class="ib" data-next="' + gi + '" title="Next match (Enter)">' + IC.down + '</button><span class="crumb">' + (tab.ns ? esc(tab.ns) + ' / ' : '') + esc(t?.kind || '') + ' / <b>' + esc(tab.name) + '</b></span>' + viewsHTML(tab, gi) + '<button class="ib" data-reload="' + gi + '" title="Fetch again">' + IC.refresh + '</button></div>';
  }
  if (tab.t === 'logs') {
    const L = W.logs[tab.id];
    const copts = (L?.containers || []).map((c) => '<option value="' + esc(c.name) + '"' + (c.name === L!.container ? ' selected' : '') + '>' + esc(c.name) + (c.kind ? ' (' + c.kind + ')' : '') + '</option>').join('');
    const topts = [[100, '100'], [1000, '1k'], [10000, '10k'], [0, 'all']].map(([v, l]) => '<option value="' + v + '"' + (L?.tail === v ? ' selected' : '') + '>tail ' + l + '</option>').join('');
    return '<div class="toolbar"><div class="search">' + IC.search + '<input data-find="' + gi + '" placeholder="Find in logs  ⌘F" value="' + esc(tab.q) + '" autocomplete="off" spellcheck="false"></div><span class="cnt" data-cnt="' + gi + '"></span><button class="ib" data-prev="' + gi + '" title="Previous match (Shift+Enter)">' + IC.up + '</button><button class="ib" data-next="' + gi + '" title="Next match (Enter)">' + IC.down + '</button>' +
      '<select class="tsel" data-logc="' + gi + '" title="Container">' + copts + '</select><select class="tsel" data-logtail="' + gi + '" title="Lines to start from">' + topts + '</select>' +
      '<button class="tbtn' + (L?.previous ? ' on' : '') + '" data-logprev="' + gi + '" title="Logs of the previous instance of this container: what it printed before it crashed or restarted">Previous</button>' +
      '<span class="crumb">' + esc(tab.ns) + ' / Pod / <b>' + esc(tab.name) + '</b></span>' + viewsHTML(tab, gi) + '<button class="ib" data-reload="' + gi + '" title="Reconnect">' + IC.refresh + '</button></div>';
  }
  if (tab.t === 'list') {
    return '<div class="toolbar"><div class="search">' + IC.search + '<input data-lf="' + gi + '" placeholder="Filter ' + esc((t?.label || '').toLowerCase()) + ' by name" value="' + esc(tab.q) + '" autocomplete="off" spellcheck="false"></div><span class="cnt" data-cnt="' + gi + '"></span><span class="crumb">' + esc((t?.kind || '') + (t?.group ? '.' + t.group : '')) + ' · <b>' + (W.ns === 'all' || !t?.namespaced ? (t?.namespaced ? 'all namespaces' : 'cluster') : esc(W.ns)) + '</b> · live</span></div>';
  }
  return '';
}

function renderBody(gi: number, restoreScroll = false) {
  const W = ws(), g = W.groups[gi], tab = g?.tabs[g.active];
  const el = root.querySelector('[data-body="' + gi + '"]') as HTMLElement | null;
  if (!el || !tab) return;
  const cnt = root.querySelector('[data-cnt="' + gi + '"]') as HTMLElement | null;
  if (tab.t === 'yaml' || tab.t === 'desc') {
    if (tab.loading) { el.innerHTML = '<div class="state">Loading…</div>'; return; }
    if (tab.err) { el.innerHTML = '<div class="state"><div><div class="big">Couldn’t fetch</div><pre>' + esc(tab.err) + '</pre></div></div>'; return; }
    let r = codeHTML(tab.text || '', tab.q, tab.cur, tab.t === 'desc' ? descTok : yamlTok);
    if (tab.cur >= r.total && r.total) { tab.cur = 0; r = codeHTML(tab.text || '', tab.q, 0, tab.t === 'desc' ? descTok : yamlTok); }
    el.innerHTML = secretBar(tab) + r.html;
    if (cnt) cnt.textContent = tab.q ? (r.total ? tab.cur + 1 + ' of ' + r.total : 'no results') : '';
    if (restoreScroll && tab.scroll && !tab.q) el.scrollTop = tab.scroll;
    else scrollToMark(el);
  } else if (tab.t === 'logs') {
    renderLogsBody(tab, el, cnt, restoreScroll);
  } else if (tab.t === 'list') {
    renderListBody(tab, gi, el, cnt);
    if (restoreScroll && tab.scroll) el.scrollTop = tab.scroll;
  } else if (tab.t === 'cluster') {
    if (!W.detailsState) loadDetails(St.active!);
    el.innerHTML = clusterCards();
  } else if (tab.t === 'overview') {
    el.innerHTML = overviewCards();
  }
}

function secretBar(tab: Tab): string {
  if (tab.key !== 'core/Secret' || tab.t !== 'yaml' || !tab.secretKeys?.length) return '';
  return '<div class="secretbar"><span>Values masked.</span>' + tab.secretKeys.map((k) => {
    const v = tab.revealed?.[k];
    return '<span class="sk">' + esc(k) + (v != null ? '<span class="sv">' + esc(v) + '</span><button data-hide="' + esc(k) + '">hide</button>' : '<button data-reveal="' + esc(k) + '">reveal</button>') + '</span>';
  }).join('') + '</div>';
}

const atBottom = (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 40;
const tabText = (tab: Tab) => (tab.t === 'logs' ? ws().logs[tab.id]?.lines.join('\n') ?? '' : tab.text || '');
const tokFor = (tab: Tab) => (tab.t === 'desc' ? descTok : tab.t === 'logs' ? logTok : yamlTok);

function logBanner(L: LogState): string {
  const notes: string[] = [];
  if (L.dropped) notes.push('Older lines dropped — showing the last ' + MAX_LOG_LINES.toLocaleString() + '.');
  if (L.err) notes.push(L.err);
  else if (L.done && !L.previous) notes.push('Stream ended (the container stopped or restarted). ↻ to reconnect.');
  if (L.done && !L.lines.length && !L.err) notes.push(L.previous ? 'No previous instance, or it printed nothing.' : 'No logs yet.');
  return notes.length ? '<div class="banner' + (L.err ? '' : ' info') + '" data-logbanner>' + notes.map(esc).join('<br>') + '</div>' : '';
}

function renderLogsBody(tab: Tab, el: HTMLElement, cnt: HTMLElement | null, restoreScroll: boolean) {
  const L = ws().logs[tab.id];
  if (!L || (!L.containers && !L.err)) { el.innerHTML = '<div class="state">Connecting…</div>'; if (cnt) cnt.textContent = ''; return; }
  const stick = restoreScroll ? tab.stick !== false : !el.querySelector('[data-logcode]') || atBottom(el);
  const text = L.lines.join('\n');
  let r = L.lines.length ? codeHTML(text, tab.q, tab.cur, logTok, L.dropped + 1) : { html: '<div class="code"></div>', total: 0 };
  if (tab.cur >= r.total && r.total) { tab.cur = 0; r = codeHTML(text, tab.q, 0, logTok, L.dropped + 1); }
  el.innerHTML = logBanner(L) + r.html.replace('<div class="code">', '<div class="code" data-logcode data-n="' + L.lines.length + '">');
  if (cnt) cnt.textContent = tab.q ? (r.total ? tab.cur + 1 + ' of ' + r.total : 'no results') : L.lines.length.toLocaleString() + ' lines';
  if (tab.q) scrollToMark(el);
  else if (stick) el.scrollTop = el.scrollHeight;
  else if (restoreScroll && tab.scroll) el.scrollTop = tab.scroll;
}

// appendLogs adds only the new lines, so following a busy pod stays cheap.
function appendLogs(gi: number, L: LogState): boolean {
  const el = root.querySelector('[data-body="' + gi + '"]') as HTMLElement | null;
  const code = el?.querySelector('[data-logcode]') as HTMLElement | null;
  if (!el || !code) return false;
  const n = +code.dataset.n!;
  if (n > L.lines.length) return false;
  const stick = atBottom(el);
  let h = '';
  for (let i = n; i < L.lines.length; i++) h += logLineHTML(L.dropped + i + 1, L.lines[i]);
  code.insertAdjacentHTML('beforeend', h);
  code.dataset.n = String(L.lines.length);
  const cnt = root.querySelector('[data-cnt="' + gi + '"]') as HTMLElement | null;
  if (cnt) cnt.textContent = L.lines.length.toLocaleString() + ' lines';
  if (stick) el.scrollTop = el.scrollHeight;
  return true;
}

function listFor(tab: Tab): ListState | undefined {
  return ws().lists[tab.key!];
}

// Status sorts by severity first, so one click puts the broken things on top.
const SEVERITY: Record<string, number> = { err: 0, warn: 1, ok: 2, '': 3 };
const NUMERIC = new Set(['count', 'revision']);

function sortKey(o: Row, col: string): string | number {
  switch (col) {
    case 'name': return o.name;
    case 'namespace': return o.namespace || '';
    case 'node': return o.node || '';
    case 'restarts': return o.restarts;
    case 'age': return -o.created; // ascending = youngest first
    case 'ready': { const [r, n] = (o.ready || '0/0').split('/').map(Number); return n - r; } // most not-ready last
  }
  const v = o.extra?.[col] ?? '';
  return NUMERIC.has(col) ? Number(v) || 0 : v;
}

function sortRows(rows: Row[], sort: Tab['sort']): Row[] {
  if (!sort) return rows;
  const dir = sort.desc ? -1 : 1;
  const cmp = (a: string | number, b: string | number) => (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true }));
  return rows.slice().sort((a, b) => {
    let d = 0;
    if (sort.col === 'status') d = SEVERITY[sc(a.status)] - SEVERITY[sc(b.status)] || cmp(a.status, b.status);
    else d = cmp(sortKey(a, sort.col), sortKey(b, sort.col));
    return d * dir || a.name.localeCompare(b.name);
  });
}

function renderListBody(tab: Tab, gi: number, el: HTMLElement, cnt: HTMLElement | null) {
  const W = ws(), t = W.all[tab.key!], L = listFor(tab);
  if (!L || (!L.rows && !L.err)) { el.innerHTML = '<div class="state">Listing…</div>'; if (cnt) cnt.textContent = ''; return; }
  const ts = terms(tab.q);
  const k = tab.key!, pod = k === 'core/Pod', ev = k === 'core/Event', helm = k === HELM_KEY, node = k === 'core/Node';
  const rows = sortRows((L.rows || []).filter((o) => hit(o.name, ts)), tab.sort);
  const showNs = t?.namespaced && W.ns === 'all';
  const act = activeTabIds();
  const th = (col: string, label: string) => {
    const on = tab.sort?.col === col;
    return '<th class="sortable' + (on ? ' sorted' : '') + '" data-sort="' + gi + ',' + col + '" title="Sort by ' + label.toLowerCase() + '">' + label + (on ? (tab.sort!.desc ? ' ▼' : ' ▲') : '') + '</th>';
  };
  let h = (L.err ? '<div class="banner">' + esc(L.err) + '</div>' : '') + '<table class="tbl"><thead><tr>';
  if (ev) h += th('status', 'Type') + th('reason', 'Reason') + th('object', 'Object') + th('message', 'Message') + th('count', 'Count') + th('age', 'Age') + (showNs ? th('namespace', 'Namespace') : '');
  else h += th('name', 'Name') + th('status', 'Status') + (pod ? th('ready', 'Ready') + th('restarts', 'Restarts') : '') + (helm ? th('chart', 'Chart') + th('app', 'App') + th('revision', 'Rev') : '') + (node ? th('version', 'Version') : '') + th('age', 'Age') + (showNs ? th('namespace', 'Namespace') : '') + (pod ? th('node', 'Node') : '');
  h += '</tr></thead><tbody>';
  rows.forEach((o) => {
    const id = 'r:' + k + ':' + (o.namespace || '') + ':' + o.name;
    const on = act[id + ':desc'] || act[id + ':yaml'];
    const dot = '<span class="st"><span class="dot ' + sc(o.status) + '"></span>' + esc(o.status) + '</span>';
    h += '<tr data-row="' + gi + '|' + esc(o.namespace || '') + '|' + esc(o.name) + '" class="' + (on ? 'on' : '') + '">';
    if (ev) {
      const x = o.extra || {};
      h += '<td>' + (o.status ? dot : '') + '</td><td class="m">' + esc(x.reason) + '</td><td class="m">' + esc(x.object) + '</td><td class="msg">' + esc(x.message) + '</td><td class="m mu">' + esc(x.count) + '</td><td class="m mu">' + age(o.created) + '</td>' + (showNs ? '<td class="m mu">' + esc(o.namespace) + '</td>' : '');
    } else {
      h += '<td class="m">' + hl(o.name, ts) + '</td><td>' + (o.status ? dot : '<span class="mu">—</span>') + '</td>';
      if (pod) h += '<td class="m">' + esc(o.ready) + '</td><td class="m"' + (o.restarts > 5 ? ' style="color:var(--status-err)"' : '') + '>' + o.restarts + '</td>';
      if (helm) h += '<td class="m mu">' + esc(o.extra?.chart) + '</td><td class="m mu">' + esc(o.extra?.app) + '</td><td class="m mu">' + esc(o.extra?.revision) + '</td>';
      if (node) h += '<td class="m mu">' + esc(o.extra?.version) + '</td>';
      h += '<td class="m mu">' + age(o.created) + '</td>' + (showNs ? '<td class="m mu">' + esc(o.namespace) + '</td>' : '') + (pod ? '<td class="m mu">' + esc(o.node || '—') + '</td>' : '');
    }
    h += '</tr>';
  });
  if (!rows.length) h += '<tr><td colspan="9" class="mu">Nothing here</td></tr>';
  el.innerHTML = h + '</tbody></table>';
  if (cnt) cnt.textContent = rows.length + (ts.length ? ' of ' + (L.rows || []).length : '') + ' items';
}

function clusterCards(): string {
  const c = CTX(St.active!), W = ws(), i = W.info || {}, d = W.details;
  const n = (k: string) => (W.counts[k] == null ? '…' : String(W.counts[k]));
  const kubelets = d?.kubelets.length
    ? d.kubelets.map((k) => k.nodes + ' × ' + esc(k.version)).join('<br>') + (d.kubelets.length > 1 ? '<br><span style="color:var(--status-warn)">' + d.kubelets.length + ' kubelet versions</span>' : '')
    : W.detailsState === 'loading' ? 'kubelets…' : '';
  return '<div class="cards"><div class="card wide"><h4>Context</h4><div class="v">' + esc(c.short) + ' <span class="env ' + c.env + '" style="vertical-align:2px">' + c.env + '</span></div><div class="s">' + esc(c.name) + '</div></div>' +
    '<div class="card"><h4>Kubernetes</h4><div class="v">' + esc(i.version || '…') + '</div><div class="s">control plane' + (i.platform ? ' · ' + esc(i.platform) : '') + '</div></div>' +
    '<div class="card"><h4>Nodes</h4><div class="v">' + n('core/Node') + '</div><div class="s">' + kubelets + '</div></div>' +
    '<div class="card"><h4>API server</h4><div class="s">' + esc(i.server || c.server) + '</div></div>' +
    '<div class="card"><h4>User</h4><div class="s">' + esc(c.user) + '</div></div>' +
    '<div class="card"><h4>Auth</h4><div class="s">' + esc(i.auth || '') + '<br>from kubeconfig — token kept in memory only</div></div>' +
    '<div class="card"><h4>Namespaces</h4><div class="v">' + n('core/Namespace') + '</div></div>' +
    '<div class="card"><h4>API resources discovered</h4><div class="v">' + (i.typeCount ?? '…') + '</div><div class="s">' + (i.crdCount ?? 0) + ' from CRDs · ' + (i.groupCount ?? 0) + ' API groups</div></div>' +
    nodeTypesCard() + addonsCard() + '</div>';
}

function nodeTypesCard(): string {
  const W = ws(), d = W.details;
  if (!d) return W.detailsState === 'loading' ? '<div class="card wide"><h4>Node types</h4><div class="s">Reading nodes…</div></div>' : '';
  if (!d.nodeGroups?.length) return '';
  const g0 = d.nodeGroups;
  const showImg = g0.some((g) => g.imageId), showArch = new Set(g0.map((g) => g.arch)).size > 1;
  const rows = g0.map((g) => '<tr><td class="m">' + g.nodes + '</td><td>' + esc(g.provisioner || '—') + (g.pool ? ' <span class="mu">· ' + esc(g.pool) + '</span>' : '') + '</td><td class="m">' + esc(g.instanceType || '—') + '</td><td>' + (g.capacity ? '<span class="cap ' + esc(g.capacity) + '">' + esc(g.capacity) + '</span>' : '<span class="mu">—</span>') + '</td>' + (showArch ? '<td class="m mu">' + esc(g.arch) + '</td>' : '') + '<td>' + esc(g.osImage) + '</td>' + (showImg ? '<td class="m">' + esc(g.imageId || '—') + '</td>' : '') + '<td class="m mu">' + esc(g.kernels) + '</td></tr>').join('');
  const spot = g0.filter((g) => g.capacity === 'spot').reduce((a, g) => a + g.nodes, 0), total = g0.reduce((a, g) => a + g.nodes, 0);
  return '<div class="card wide"><h4>Node types · ' + new Set(g0.map((g) => g.instanceType)).size + ' instance types' + (spot ? ' · ' + spot + ' of ' + total + ' spot' : '') + '</h4><table class="tbl"><thead><tr><th>Nodes</th><th>Provisioner · pool</th><th>Instance type</th><th>Capacity</th>' + (showArch ? '<th>Arch</th>' : '') + '<th>OS image</th>' + (showImg ? '<th>Image</th>' : '') + '<th>Kernel</th></tr></thead><tbody>' + rows + '</tbody></table>' +
    (showImg ? '' : '<div class="s" style="margin-top:8px">No image IDs on these nodes. EKS managed nodegroups and Karpenter NodeClaims expose the AMI; GKE nodes report only the OS image.</div>') + '</div>';
}

function addonsCard(): string {
  const W = ws(), d = W.details;
  const head = '<h4 style="display:flex;justify-content:space-between;align-items:center">Add-ons<button class="ib" data-details title="Check again">' + IC.refresh + '</button></h4>';
  let body: string;
  if (W.detailsState === 'loading' && !d) body = '<div class="s">Looking for known add-ons…</div>';
  else if (W.detailsState && W.detailsState !== 'done' && W.detailsState !== 'loading') body = '<div class="s" style="color:var(--status-err)">' + esc(W.detailsState) + '</div>';
  else if (!d?.addons.length) body = '<div class="s">None of the known add-ons were found.</div>';
  else body = '<table class="tbl"><thead><tr><th>Type</th><th>Add-on</th><th>Version</th><th>Workload</th></tr></thead><tbody>' +
    d.addons.map((a) => '<tr><td class="mu">' + esc(a.category) + '</td><td>' + esc(a.name) + '</td><td class="m" title="' + esc(a.image) + '">' + esc(a.version) + '</td><td class="m mu">' + esc(a.namespace + ' / ' + a.workload) + '</td></tr>').join('') + '</tbody></table>';
  const errs = d?.errors?.length ? '<div class="s" style="color:var(--status-warn);margin-top:8px">' + d.errors.map(esc).join('<br>') + '</div>' : '';
  return '<div class="card wide">' + head + body + errs + '<div class="s" style="margin-top:8px">Versions are image tags of well-known DaemonSets and Deployments.</div></div>';
}

async function loadDetails(ctx: string) {
  const W = St.ws[ctx];
  if (!W) return;
  W.detailsState = 'loading';
  if (St.active === ctx) refreshTabEverywhere('cluster');
  try { W.details = await Go.ClusterDetails(ctx); W.detailsState = 'done'; }
  catch (e) { W.detailsState = String(e); }
  if (St.active === ctx && St.view === 'ctx') refreshTabEverywhere('cluster');
}

function overviewCards(): string {
  const W = ws();
  const wl = W.cats.find((c) => c.name === 'Workloads');
  return '<div class="cards">' + (wl?.types || []).filter((t) => !t.pseudo).map((t) => '<div class="card" data-type="' + esc(t.key) + '" style="cursor:pointer"><h4>' + esc(t.label) + '</h4><div class="v">' + (W.counts[t.key] ?? '…') + '</div><div class="s">' + (W.ns === 'all' ? 'all namespaces' : esc(W.ns)) + '</div></div>').join('') + '</div>';
}

/* ---------- tabs ---------- */
function openTab(tab: Tab, gi?: number) {
  const W = ws();
  for (let a = 0; a < W.groups.length; a++) {
    const ix = W.groups[a].tabs.findIndex((x) => x.id === tab.id);
    if (ix > -1) { W.groups[a].active = ix; W.focus = a; afterTabs(); return; }
  }
  const g = W.groups[gi ?? W.focus];
  g.tabs.splice(g.active + 1, 0, tab);
  g.active = g.active + 1;
  W.focus = gi ?? W.focus;
  afterTabs();
}

function resTab(key: string, ns: string, name: string, t: ResView): Tab {
  return { id: 'r:' + key + ':' + ns + ':' + name + ':' + t, t, key, ns, name, q: '', cur: 0 };
}

// openRes follows VS Code: a single click previews (replacing the previous
// preview), a double click keeps the tab.
function openRes(key: string, ns: string, name: string, gi: number, pin: boolean, view: ResView = 'desc') {
  const W = ws(), nt = resTab(key, ns, name, view);
  for (let a = 0; a < W.groups.length; a++) {
    const b = W.groups[a].tabs.findIndex((x) => x.id === nt.id);
    if (b > -1) { W.groups[a].active = b; W.focus = a; if (pin) W.groups[a].tabs[b].preview = false; afterTabs(); return; }
  }
  const g = W.groups[gi], pi = g.tabs.findIndex((x) => x.preview);
  nt.preview = !pin;
  if (pi > -1 && !pin) { g.tabs[pi] = nt; g.active = pi; }
  else { g.tabs.splice(g.active + 1, 0, nt); g.active = g.active + 1; }
  W.focus = gi;
  fetchTab(nt);
  afterTabs();
}

async function fetchTab(tab: Tab) {
  const ctx = St.active!;
  tab.loading = true; tab.err = '';
  try {
    tab.text = tab.t === 'desc' ? await Go.Describe(ctx, tab.key!, tab.ns!, tab.name!) : await Go.YAML(ctx, tab.key!, tab.ns!, tab.name!);
    if (tab.key === 'core/Secret' && tab.t === 'yaml') tab.secretKeys = (await Go.SecretKeys(ctx, tab.ns!, tab.name!)) || [];
  } catch (e) { tab.err = String(e); }
  tab.loading = false;
  if (St.active === ctx && St.view === 'ctx') refreshTabEverywhere(tab.id);
}

function refreshTabEverywhere(id: string) {
  ws().groups.forEach((g, gi) => { if (g.tabs[g.active]?.id === id) renderBody(gi, true); });
}

function closeTab(gi: number, ti: number) {
  const W = ws(), g = W.groups[gi];
  g.tabs.splice(ti, 1);
  if (g.active >= g.tabs.length) g.active = g.tabs.length - 1;
  else if (ti < g.active) g.active--;
  if (!g.tabs.length && W.groups.length > 1) { W.groups.splice(gi, 1); W.focus = 0; }
  afterTabs();
}

function toggleSplit() {
  const W = ws();
  if (W.groups.length === 1) {
    const g = W.groups[0], t = g.tabs[g.active];
    if (!t) return;
    W.groups.push({ tabs: [{ ...t, q: '', cur: 0, preview: false }], active: 0 });
    W.focus = 1;
  } else {
    const b = W.groups.pop()!, a = W.groups[0], ids = a.tabs.map((x) => x.id);
    b.tabs.forEach((x) => { if (!ids.includes(x.id)) a.tabs.push(x); });
    W.focus = 0;
  }
  afterTabs();
}

function moveTab(from: number, ti: number, to: number) {
  const W = ws(), src = W.groups[from], dst = W.groups[to];
  const [tab] = src.tabs.splice(ti, 1);
  const dup = dst.tabs.findIndex((x) => x.id === tab.id);
  if (dup > -1) dst.active = dup;
  else { dst.tabs.splice(dst.active + 1, 0, tab); dst.active = dst.active + 1; }
  if (src.active >= src.tabs.length) src.active = src.tabs.length - 1;
  W.focus = to;
  if (!src.tabs.length) { W.groups.splice(from, 1); W.focus = 0; }
  afterTabs();
}

function afterTabs() {
  syncLists(St.active!);
  syncLogs(St.active!);
  renderEditor();
  renderNav();
}

/* ---------- log streams ---------- */
const MAX_LOG_LINES = 20000;
const logOwner: Record<string, { ctx: string; tabId: string }> = {}; // stream id → tab

// syncLogs keeps one stream per open logs tab and stops streams whose tab closed.
function syncLogs(ctx: string) {
  const W = St.ws[ctx];
  if (!W || W.status !== 'ready') return;
  const want = new Map<string, Tab>();
  W.groups.forEach((g) => g.tabs.forEach((t) => { if (t.t === 'logs') want.set(t.id, t); }));
  Object.keys(W.logs).forEach((id) => {
    if (want.has(id)) return;
    const L = W.logs[id];
    if (L.streamId) { Go.StopList(L.streamId); delete logOwner[L.streamId]; }
    delete W.logs[id];
  });
  want.forEach((tab, id) => {
    if (W.logs[id]) return;
    W.logs[id] = { streamId: '', containers: null, container: '', previous: false, tail: 1000, lines: [], dropped: 0, err: '', done: false };
    initLogs(ctx, tab);
  });
}

async function initLogs(ctx: string, tab: Tab) {
  const L = St.ws[ctx]?.logs[tab.id];
  if (!L) return;
  try {
    L.containers = (await Go.PodContainers(ctx, tab.ns!, tab.name!)) || [];
    L.container = (L.containers.find((c) => c.default) || L.containers[0])?.name || '';
  } catch (e) {
    L.err = String(e); L.done = true;
  }
  if (St.active === ctx && St.view === 'ctx') refreshLogTab(tab.id, true);
  if (!L.err) startLogStream(ctx, tab);
}

function startLogStream(ctx: string, tab: Tab) {
  const L = St.ws[ctx]?.logs[tab.id];
  if (!L) return;
  if (L.streamId) { Go.StopList(L.streamId); delete logOwner[L.streamId]; }
  Object.assign(L, { streamId: 'logs-' + uid(), lines: [], dropped: 0, err: '', done: false });
  logOwner[L.streamId] = { ctx, tabId: tab.id };
  const id = L.streamId;
  Go.StartLogs(ctx, id, tab.ns!, tab.name!, L.container, L.previous, L.tail).catch((e) => {
    if (L.streamId === id) { L.err = String(e); L.done = true; refreshLogTab(tab.id, true); }
  });
  if (St.active === ctx && St.view === 'ctx') refreshLogTab(tab.id, true);
}

// refreshLogTab redraws every visible copy of a logs tab: appending when it
// can, a full render when find is active or the stream's state changed.
function refreshLogTab(tabId: string, full: boolean) {
  const W = ws();
  W.groups.forEach((g, gi) => {
    const t = g.tabs[g.active];
    if (t?.id !== tabId) return;
    if (full || t.q || !appendLogs(gi, W.logs[tabId])) {
      // The toolbar shows the container list, so redraw it too on a full render.
      if (full) renderEditor(); else renderBody(gi);
    }
  });
}

EventsOn('logs', (ev: { id: string; lines: string[] | null; err?: string; done: boolean }) => {
  const o = logOwner[ev.id];
  const L = o && St.ws[o.ctx]?.logs[o.tabId];
  if (!L || L.streamId !== ev.id) return;
  let full = false;
  if (ev.lines?.length) {
    for (const l of ev.lines) L.lines.push(l);
    if (L.lines.length > MAX_LOG_LINES) {
      const n = L.lines.length - MAX_LOG_LINES;
      L.lines.splice(0, n); L.dropped += n; full = true;
    }
  }
  if (ev.done) { L.done = true; L.err = ev.err || ''; full = true; }
  if (St.active === o.ctx && St.view === 'ctx') refreshLogTab(o.tabId, full);
});

/* ---------- live lists ---------- */
const listOwner: Record<string, string> = {}; // list id → context

// syncLists runs exactly one informer per list type open in a workspace and
// restarts them when the namespace changes.
function syncLists(ctx: string) {
  const W = St.ws[ctx];
  if (!W || W.status !== 'ready') return;
  const want = new Set<string>();
  W.groups.forEach((g) => g.tabs.forEach((t) => { if (t.t === 'list') want.add(t.key!); }));
  const ns = W.ns === 'all' ? '' : W.ns;
  Object.values(W.lists).forEach((L) => {
    if (!want.has(L.key) || L.ns !== ns) { Go.StopList(L.id); delete listOwner[L.id]; delete W.lists[L.key]; }
  });
  want.forEach((key) => {
    if (W.lists[key]) return;
    const id = 'list-' + uid();
    W.lists[key] = { id, key, ns, rows: null, err: '' };
    listOwner[id] = ctx;
    Go.StartList(ctx, id, key, ns).catch((e) => { const L = W.lists[key]; if (L && L.id === id) { L.err = String(e); L.rows = []; rerenderList(ctx, key); } });
  });
}

EventsOn('list', (ev: { id: string; rows: Row[] | null; err?: string }) => {
  const ctx = listOwner[ev.id];
  if (!ctx) return;
  const W = St.ws[ctx];
  const L = Object.values(W?.lists || {}).find((x) => x.id === ev.id);
  if (!L) return;
  L.rows = ev.rows || [];
  L.err = ev.err || '';
  rerenderList(ctx, L.key);
});

function rerenderList(ctx: string, key: string) {
  if (St.active !== ctx || St.view !== 'ctx') return;
  const W = ws();
  W.groups.forEach((g, gi) => { const t = g.tabs[g.active]; if (t?.t === 'list' && t.key === key) renderBody(gi); });
  if (W.filter) renderNav();
}

/* ---------- counts ---------- */
function refreshCounts(ctx: string) {
  const W = St.ws[ctx];
  W.counts = {}; W.countErrs = {};
  W.countToken = uid();
  const keys = Object.values(W.all).filter((t) => !t.pseudo || t.pseudo === 'helm').map((t) => t.key);
  Go.Counts(ctx, W.ns === 'all' ? '' : W.ns, W.countToken, keys);
}

let navTimer = 0;
EventsOn('counts', (ev: { ctx: string; token: string; key: string; n: number; err?: string }) => {
  const W = St.ws[ev.ctx];
  if (!W || W.countToken !== ev.token) return;
  if (ev.err) W.countErrs[ev.key] = ev.err; else W.counts[ev.key] = ev.n;
  if (St.active === ev.ctx && St.view === 'ctx' && !navTimer) {
    navTimer = window.setTimeout(() => {
      navTimer = 0;
      if (St.view !== 'ctx') return;
      renderNav();
      ws().groups.forEach((g, gi) => { const t = g.tabs[g.active]; if (t && (t.t === 'cluster' || t.t === 'overview')) renderBody(gi); });
    }, 120);
  }
});

/* ---------- contexts ---------- */
async function loadContexts() {
  try { St.contexts = (await Go.Contexts()) || []; St.ctxErr = ''; }
  catch (e) { St.ctxErr = String(e); }
}

function newWS(c: Ctx): WS {
  return { status: 'connecting', err: '', cats: [], all: {}, namespaces: [], nsErr: '', ns: c.namespace || 'all', filter: '',
    counts: {}, countErrs: {}, countToken: '', groups: [{ tabs: [], active: -1 }], focus: 0, ratio: 0.5, lists: {}, logs: {} };
}

async function connect(name: string) {
  const W = St.ws[name];
  W.status = 'connecting';
  if (St.active === name) render();
  try {
    const r = await Go.Connect(name);
    const { cats, all } = buildCats((r.types || []) as Type[]);
    Object.assign(W, { status: 'ready', cats, all, namespaces: r.namespaces || [], nsErr: r.nsError || '' });
    // Only a namespace the context names and that exists; otherwise all.
    if (W.ns !== 'all' && W.namespaces.length && !W.namespaces.includes(W.ns)) W.ns = 'all';
    refreshCounts(name);
    Go.ClusterInfo(name).then((i) => { W.info = i; if (St.active === name && St.view === 'ctx') { renderNav(); refreshTabEverywhere('cluster'); } });
    syncLists(name);
  } catch (e) {
    W.status = 'error'; W.err = String(e);
  }
  if (St.active === name && St.view === 'ctx') render();
}

function openCtx(name: string) {
  if (!St.open.includes(name)) St.open.unshift(name);
  if (!St.ws[name]) { St.ws[name] = newWS(CTX(name)); connect(name); }
  switchCtx(name);
}

function switchCtx(name: string) {
  St.active = name;
  St.view = 'ctx';
  render();
}

function closeCtx(name: string) {
  const W = St.ws[name];
  if (W) Object.values(W.lists).forEach((L) => delete listOwner[L.id]);
  if (W) Object.values(W.logs).forEach((L) => delete logOwner[L.streamId]);
  Go.CloseContext(name);
  delete St.ws[name];
  St.open = St.open.filter((x) => x !== name);
  if (St.active === name) {
    St.active = railList().find((n) => St.ws[n]) ?? null;
    if (!St.active) St.view = 'home';
  }
  render();
}

async function goHome() {
  St.view = 'home';
  St.hq = '';
  St.hsel = 0;
  render();
  await loadContexts(); // re-read in case the kubeconfig changed
  if (St.view === 'home') { renderRail(); renderHome(); }
}

/* ---------- find ---------- */
function step(gi: number, d: number) {
  const g = ws().groups[gi], tab = g.tabs[g.active];
  if (!tab?.q) return;
  const tot = codeHTML(tabText(tab), tab.q, -1, tokFor(tab)).total;
  if (!tot) return;
  tab.cur = (tab.cur + d + tot) % tot;
  renderBody(gi);
}

let toastTimer = 0;
function toast(msg: string) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('on'), 1600);
}

/* ---------- events ---------- */
const lastClick = { k: '', t: 0 };
function isDbl(k: string) {
  const n = Date.now(), r = k === lastClick.k && n - lastClick.t < 450;
  lastClick.k = r ? '' : k; lastClick.t = n;
  return r;
}

root.addEventListener('click', (e) => {
  const el = e.target as HTMLElement, q = (s: string) => el.closest(s) as HTMLElement | null;
  let m: HTMLElement | null;
  if (q('[data-home]')) return goHome();
  if ((m = q('[data-x]'))) { e.stopPropagation(); return closeCtx(m.dataset.x!); }
  if ((m = q('[data-pin]'))) { e.stopPropagation(); return togglePin(m.dataset.pin!); }
  if ((m = q('[data-ctx]'))) return goCtx(m.dataset.ctx!);
  if ((m = q('[data-hctx]'))) return openCtx(m.dataset.hctx!);
  if ((m = q('[data-prov]'))) {
    // Clicking the active filter again clears it.
    St.prov = St.prov === m.dataset.prov ? '' : m.dataset.prov!;
    St.hsel = 0;
    renderHomeList();
    return $('#hq').focus();
  }
  if (q('[data-copy]')) { ClipboardSetText(St.active!); return toast('Copied full context name'); }
  if (q('[data-retry]')) return connect(St.active!);
  if (q('[data-split]')) return toggleSplit();
  if ((m = q('[data-close]'))) { const [g, t] = m.dataset.close!.split(',').map(Number); return closeTab(g, t); }
  if ((m = q('[data-tab]'))) {
    const [gi, ti] = m.dataset.tab!.split(',').map(Number), W = ws();
    if (isDbl('tab' + gi + ',' + ti)) W.groups[gi].tabs[ti].preview = false;
    W.groups[gi].active = ti; W.focus = gi;
    return afterTabs();
  }
  if ((m = q('[data-view]'))) {
    const [g, v] = m.dataset.view!.split(','), gi = +g, W = ws(), tab = W.groups[gi].tabs[W.groups[gi].active];
    if (tab.t === v) return;
    const nt = resTab(tab.key!, tab.ns!, tab.name!, v as ResView);
    if (v !== 'logs' && !W.groups.some((x) => x.tabs.some((y) => y.id === nt.id))) fetchTab(nt);
    return openTab(nt, gi);
  }
  if ((m = q('[data-reload]'))) {
    const g = ws().groups[+m.dataset.reload!], t = g.tabs[g.active];
    if (t.t === 'logs') return startLogStream(St.active!, t);
    fetchTab(t); return renderBody(+m.dataset.reload!);
  }
  if ((m = q('[data-logprev]'))) {
    const g = ws().groups[+m.dataset.logprev!], t = g.tabs[g.active], L = ws().logs[t.id];
    if (L) { L.previous = !L.previous; startLogStream(St.active!, t); }
    return;
  }
  if ((m = q('[data-sort]'))) {
    // ▲ then ▼ then back to the server's order.
    const [g, col] = m.dataset.sort!.split(','), gi = +g, grp = ws().groups[gi], t = grp.tabs[grp.active];
    t.sort = t.sort?.col !== col ? { col, desc: false } : !t.sort.desc ? { col, desc: true } : undefined;
    return renderBody(gi);
  }
  if ((m = q('[data-prev]'))) return step(+m.dataset.prev!, -1);
  if ((m = q('[data-next]'))) return step(+m.dataset.next!, 1);
  if ((m = q('[data-reveal]')) || (m = q('[data-hide]'))) {
    const gi = +(q('[data-body]')!.dataset.body!), g = ws().groups[gi], tab = g.tabs[g.active], key = m.dataset.reveal ?? m.dataset.hide!;
    tab.revealed ||= {};
    if (m.dataset.hide != null) { delete tab.revealed[key]; return renderBody(gi); }
    Go.RevealSecretKey(St.active!, tab.ns!, tab.name!, key).then((v) => { tab.revealed![key] = v; renderBody(gi); }).catch((err) => toast(String(err)));
    return;
  }
  if (q('[data-details]')) return loadDetails(St.active!);
  if (q('[data-cluster]')) { openTab({ id: 'cluster', t: 'cluster', q: '', cur: 0 }, 0); return; }
  if ((m = q('[data-hit]'))) {
    const [key, ns, name] = m.dataset.hit!.split('|'), W = ws();
    return openRes(key, ns, name, W.groups.length > 1 ? 1 : 0, isDbl('hit' + m.dataset.hit));
  }
  if ((m = q('[data-type]'))) {
    const key = m.dataset.type!, t = ws().all[key];
    if (!t || t.pseudo === 'disabled') return;
    if (t.pseudo === 'overview') return openTab({ id: 'overview', t: 'overview', q: '', cur: 0 }, 0);
    return openTab({ id: 'l:' + key, t: 'list', key, q: '', cur: 0 }, 0);
  }
  if ((m = q('[data-row]'))) {
    const [g, ns, name] = m.dataset.row!.split('|'), gi = +g, W = ws(), tab = W.groups[gi].tabs[W.groups[gi].active];
    // Rows open in the other editor group when split, so the list stays put.
    const target = W.groups.length > 1 ? 1 - gi : gi;
    return openRes(tab.key!, ns, name, target, isDbl(m.dataset.row!));
  }
});

root.addEventListener('dblclick', (e) => {
  // Double-click on a row/tab is handled by isDbl in click; this stops the
  // browser's word selection from flashing.
  if ((e.target as HTMLElement).closest('[data-row],[data-tab]')) window.getSelection()?.removeAllRanges();
});

root.addEventListener('input', (e) => {
  const el = e.target as HTMLInputElement;
  if (el.id === 'hq') { St.hq = el.value; St.hsel = 0; return renderHomeList(); }
  if (el.id === 'tf') { ws().filter = el.value; return renderNav(); }
  if (el.dataset.find != null) { const gi = +el.dataset.find, g = ws().groups[gi], t = g.tabs[g.active]; t.q = el.value; t.cur = 0; return renderBody(gi); }
  if (el.dataset.lf != null) { const gi = +el.dataset.lf, g = ws().groups[gi]; g.tabs[g.active].q = el.value; return renderBody(gi); }
});

root.addEventListener('change', (e) => {
  const el = e.target as HTMLSelectElement, d = el.dataset.logc ?? el.dataset.logtail;
  if (d == null) return;
  const g = ws().groups[+d], t = g.tabs[g.active], L = ws().logs[t.id];
  if (!L) return;
  if (el.dataset.logc != null) L.container = el.value; else L.tail = +el.value;
  startLogStream(St.active!, t);
});

root.addEventListener('mousedown', (e) => {
  const el = e.target as HTMLElement;
  // Divider: drag to resize the split.
  if (el.closest('[data-div]')) {
    e.preventDefault();
    const ed = $('#editor').getBoundingClientRect(), W = ws();
    const mv = (ev: MouseEvent) => {
      W.ratio = Math.min(0.85, Math.max(0.15, (ev.clientX - ed.left) / ed.width));
      const gs = root.querySelectorAll<HTMLElement>('.group');
      gs[0].style.flex = W.ratio + ' 1 0'; gs[1].style.flex = 1 - W.ratio + ' 1 0';
    };
    const up = () => { document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
    return;
  }
  // Tab: drag onto the other group to move it there.
  const tb = el.closest('[data-tab]') as HTMLElement | null;
  if (!tb || el.closest('.cx') || ws().groups.length < 2) return;
  const [gi, ti] = tb.dataset.tab!.split(',').map(Number), x0 = e.clientX, y0 = e.clientY;
  let ghost: HTMLElement | null = null, over = -1;
  const mv = (ev: MouseEvent) => {
    if (!ghost && Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < 8) return;
    if (!ghost) { ghost = document.createElement('div'); ghost.className = 'ghost'; document.body.appendChild(ghost); }
    const g = (document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement)?.closest('.group') as HTMLElement | null;
    over = g ? +g.dataset.g! : -1;
    root.querySelectorAll('.group').forEach((x) => x.classList.toggle('dropin', +(x as HTMLElement).dataset.g! === over && over !== gi));
    ghost.textContent = (tb.querySelector('.t')?.textContent || '') + (over > -1 && over !== gi ? ' — move to this editor' : '');
    ghost.style.left = ev.clientX + 12 + 'px'; ghost.style.top = ev.clientY + 8 + 'px';
  };
  const up = () => {
    document.removeEventListener('mousemove', mv); document.removeEventListener('mouseup', up);
    if (ghost) { ghost.remove(); if (over > -1 && over !== gi) moveTab(gi, ti, over); else renderEditor(); }
  };
  document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
});

document.addEventListener('keydown', (e) => {
  const el = document.activeElement as HTMLElement | null, mod = e.metaKey || e.ctrlKey;
  const inInput = !!el && /INPUT|SELECT|TEXTAREA/.test(el.tagName);
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); goHome(); return; }
  if (mod && /^[1-9]$/.test(e.key)) { const id = railList()[+e.key - 1]; if (id) { e.preventDefault(); goCtx(id); } return; }
  if (St.view === 'home') {
    const L = filteredCtx();
    if (e.key === 'ArrowDown') { e.preventDefault(); St.hsel = Math.min(L.length - 1, St.hsel + 1); renderHomeList(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); St.hsel = Math.max(0, St.hsel - 1); renderHomeList(); }
    else if (e.key === 'Enter' && L[St.hsel]) openCtx(L[St.hsel].name);
    else if (e.key === 'Escape' && St.open.length) switchCtx(St.active && St.ws[St.active] ? St.active : St.open[0]);
    return;
  }
  if (el?.dataset.find != null) {
    if (e.key === 'Enter') { e.preventDefault(); step(+el.dataset.find, e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') el.blur();
    return;
  }
  if (mod && e.key === 'f') { const f = root.querySelector('[data-find="' + ws().focus + '"]') as HTMLInputElement | null; if (f) { e.preventDefault(); f.focus(); f.select(); } return; }
  if (mod && e.key === '\\') { e.preventDefault(); toggleSplit(); return; }
  if (el?.id === 'tf' && e.key === 'Escape') { (el as HTMLInputElement).value = ''; ws().filter = ''; renderNav(); el.blur(); return; }
  if (!inInput && e.key === '/') { e.preventDefault(); $('#tf').focus(); }
});

/* ---------- boot ---------- */
Promise.all([loadContexts(), Go.Pinned().then((p) => { St.pins = p || []; }).catch((e) => toast('Couldn’t read pins: ' + e))]).then(render);
