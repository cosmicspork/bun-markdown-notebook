import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import {
  defaultKeymap,
  history as cmHistory,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  HighlightStyle,
  indentOnInput,
  foldKeymap,
  bracketMatching,
} from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { tags } from '@lezer/highlight';
import { livePreview } from './live-preview';

type DocMeta = {
  file: string;
  type: string;
  mtime: number;
  hash: string;
  title: string;
  body?: string;
};

type DashboardData = {
  priorities: Array<{
    text: string;
    kind: 'bullet' | 'numbered';
    number: string | null;
    checked: boolean | null;
    file: string;
  }>;
  todos: Array<{ text: string; file: string }>;
};

type SseEvent =
  | { kind: 'add' | 'change'; file: string; type: string; hash: string; mtime: number; title: string }
  | { kind: 'remove'; file: string };

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

const TYPE_GROUPS = [
  { type: 'note', label: 'Notes' },
  { type: 'repo', label: 'Repos' },
  { type: 'meeting', label: 'Meetings' },
  { type: 'inbox', label: 'Inbox' },
  { type: 'proposal', label: 'Proposals' },
  { type: 'plan', label: 'Plans' },
  { type: 'guide', label: 'Guides' },
  { type: 'ref', label: 'Reference' },
  { type: 'architecture', label: 'Architecture' },
  { type: 'html', label: 'HTML docs' },
  { type: 'other', label: 'Other' },
];
const SAVE_DEBOUNCE_MS = 750;
const DRAFT_DEBOUNCE_MS = 200;
const SEARCH_DEBOUNCE_MS = 120;

let docs = new Map<string, DocMeta>();
let active: string = '__dashboard';
let activeTab: string = 'all';
let editor: EditorView | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let draftTimer: ReturnType<typeof setTimeout> | null = null;
let saveState: SaveState = 'idle';
let conflictServerBody: string | null = null;
let searchHits: Set<string> | null = null;
let searchTimer: ReturnType<typeof setTimeout> | null = null;
let lastSavedAt: number | null = null;
const themeCompartment = new Compartment();
const darkMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');

function $<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

// ---- IndexedDB draft buffer ----
let dbPromise: Promise<IDBDatabase> | null = null;
function getDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('notebook', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('drafts', { keyPath: 'file' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}
type Draft = { file: string; body: string; baseHash: string; savedAt: number };
async function dbOp<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const db = await getDb();
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction('drafts', mode);
    const store = tx.objectStore('drafts');
    const req = fn(store);
    tx.oncomplete = () => resolve((req as IDBRequest<T> | undefined)?.result);
    tx.onerror = () => reject(tx.error);
  });
}
async function persistDraft(file: string, body: string, baseHash: string) {
  try {
    await dbOp('readwrite', (s) => s.put({ file, body, baseHash, savedAt: Date.now() } as Draft));
  } catch {}
}
async function clearDraft(file: string) {
  try {
    await dbOp('readwrite', (s) => s.delete(file));
  } catch {}
}
async function loadDraft(file: string): Promise<Draft | null> {
  try {
    return ((await dbOp<Draft>('readonly', (s) => s.get(file))) ?? null) as Draft | null;
  } catch {
    return null;
  }
}

// ---- Helpers ----
function titleOf(doc: DocMeta): string {
  return doc.title || doc.file;
}

function relativeTime(ms: number): string {
  const days = Math.round((Date.now() - ms) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return days + 'd ago';
  if (days < 30) return Math.floor(days / 7) + 'w ago';
  return Math.floor(days / 30) + 'mo ago';
}
function shortTime(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ago';
}

// ---- URL hash state ----
function readHash() {
  const params = new URLSearchParams(location.hash.slice(1));
  return {
    doc: params.get('doc'),
    tab: params.get('tab') || 'all',
    search: params.get('search') || '',
  };
}
function writeHash(opts: { push?: boolean } = { push: false }) {
  const params = new URLSearchParams();
  if (active !== '__dashboard') params.set('doc', active);
  if (activeTab !== 'all') params.set('tab', activeTab);
  const q = $<HTMLInputElement>('search').value;
  if (q) params.set('search', q);
  const newHash = '#' + params.toString();
  if (newHash === location.hash || (newHash === '#' && !location.hash)) return;
  if (opts.push) history.pushState(null, '', newHash);
  else history.replaceState(null, '', newHash);
}

// ---- Save flow ----
function setSaveStatus(state: SaveState) {
  saveState = state;
  const el = $('saveStatus');
  el.className = 'save-status ' + state;
  if (state === 'idle') el.textContent = '';
  else if (state === 'dirty') el.textContent = 'unsaved';
  else if (state === 'saving') el.textContent = 'saving…';
  else if (state === 'saved') el.textContent = lastSavedAt ? 'saved ' + shortTime(lastSavedAt) : 'saved';
  else if (state === 'error') el.textContent = 'save failed';
}

function editorMarkdown(): string {
  return editor ? editor.state.doc.toString() : '';
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  if (draftTimer) clearTimeout(draftTimer);
  setSaveStatus('dirty');
  if (active && active !== '__dashboard') {
    draftTimer = setTimeout(() => {
      const doc = docs.get(active);
      if (doc && editor) persistDraft(active, editorMarkdown(), doc.hash);
    }, DRAFT_DEBOUNCE_MS);
  }
  saveTimer = setTimeout(save, SAVE_DEBOUNCE_MS);
}

async function save({ overwrite = false }: { overwrite?: boolean } = {}) {
  if (!editor || active === '__dashboard') return;
  const doc = docs.get(active);
  if (!doc) return;
  const body = editorMarkdown();
  if (!overwrite && body === doc.body) {
    setSaveStatus('idle');
    return;
  }
  if (overwrite) hideConflict();
  setSaveStatus('saving');
  try {
    const res = await fetch('/api/doc/' + encodeURIComponent(active), {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown', 'If-Match': doc.hash },
      body,
    });
    if (res.status === 412) {
      const payload = await res.json();
      doc.hash = payload.hash;
      conflictServerBody = payload.body;
      setSaveStatus('error');
      showConflict();
      return;
    }
    if (!res.ok) throw new Error('save failed: ' + res.status);
    const payload = await res.json();
    doc.body = body;
    doc.hash = payload.hash;
    doc.mtime = payload.mtime;
    doc.title = payload.title;
    lastSavedAt = Date.now();
    setSaveStatus('saved');
    await clearDraft(active);
  } catch (e) {
    console.error(e);
    setSaveStatus('error');
  }
}

function showConflict() {
  $('conflictBanner').style.display = '';
}
function hideConflict() {
  $('conflictBanner').style.display = 'none';
  conflictServerBody = null;
}

$('reloadFromDisk').onclick = async () => {
  if (!active || active === '__dashboard') return;
  if (!docs.has(active)) return;
  await clearDraft(active);
  hideConflict();
  // Tear down + re-open so the editor's undo history starts fresh —
  // otherwise Cmd+Z could revert to the pre-conflict content.
  openDoc(active, { push: false });
};
$<HTMLButtonElement>('overwriteAnyway').onclick = () => save({ overwrite: true });

// ---- SSE: live updates from disk ----
function connectSSE() {
  const es = new EventSource('/api/events');
  es.onmessage = (e) => {
    try {
      handleSseEvent(JSON.parse(e.data) as SseEvent);
    } catch {}
  };
  es.onerror = () => {
    /* EventSource auto-reconnects */
  };
}

function refreshSidebar() {
  renderTabs();
  renderSidebar();
  if (searchHits !== null) runSearch();
}

async function handleSseEvent(event: SseEvent) {
  if (event.kind === 'remove') {
    docs.delete(event.file);
    if (active === event.file) openDashboard({ push: false });
    refreshSidebar();
    return;
  }

  const { file, type, hash, mtime, title } = event;
  const prev = docs.get(file);
  if (prev && prev.hash === hash) return;

  if (active !== file || !prev) {
    docs.set(file, { file, type, hash, mtime, title });
    refreshSidebar();
    if (active === '__dashboard') openDashboard({ push: false });
    return;
  }

  // Active-doc external change: fetch body and surface the conflict banner.
  let body: string;
  try {
    const res = await fetch('/api/doc/' + encodeURIComponent(file));
    if (!res.ok) return;
    body = await res.text();
  } catch (e) {
    console.error('SSE body fetch failed', e);
    return;
  }
  docs.set(file, { file, type, hash, mtime, title, body });
  if (type === 'html') {
    openDoc(file, { push: false });
    return;
  }
  conflictServerBody = body;
  showConflict();
  refreshSidebar();
}

// ---- Rendering ----
function renderTabs() {
  const el = $('tabs');
  el.innerHTML = '';
  const counts = new Map<string, number>();
  for (const d of docs.values()) counts.set(d.type, (counts.get(d.type) || 0) + 1);
  const items: Array<{ key: string; label: string; count: number }> = [
    { key: 'all', label: 'all', count: docs.size },
  ];
  for (const g of TYPE_GROUPS) {
    const c = counts.get(g.type) || 0;
    if (c === 0) continue;
    items.push({ key: g.type, label: g.label.toLowerCase(), count: c });
  }
  for (const item of items) {
    const btn = document.createElement('button');
    btn.className = 'tab' + (item.key === activeTab ? ' active' : '');
    btn.innerHTML = `<span></span><span class="tab-count"></span>`;
    (btn.children[0] as HTMLElement).textContent = item.label;
    (btn.children[1] as HTMLElement).textContent = String(item.count);
    btn.onclick = () => {
      activeTab = item.key;
      renderTabs();
      renderSidebar();
      writeHash({ push: true });
    };
    el.appendChild(btn);
  }
}

function renderSidebar() {
  const list = $('docList');
  list.innerHTML = '';
  const searching = searchHits !== null;

  const dash = document.createElement('div');
  dash.className = 'doc-item' + (active === '__dashboard' ? ' active' : '');
  dash.innerHTML = `<div class="doc-title">Dashboard</div><div class="doc-meta">overview</div>`;
  dash.onclick = () => openDashboard({ push: true });
  list.appendChild(dash);

  const showHeaders = activeTab === 'all' || searching;
  const allDocs = Array.from(docs.values()).sort((a, b) => b.mtime - a.mtime);

  for (const group of TYPE_GROUPS) {
    if (!searching && activeTab !== 'all' && activeTab !== group.type) continue;

    const matches = allDocs
      .filter((d) => d.type === group.type)
      .filter((d) => !searching || searchHits!.has(d.file));
    if (!matches.length) continue;

    if (showHeaders) {
      const section = document.createElement('div');
      section.className = 'sidebar-section';
      section.textContent = group.label;
      list.appendChild(section);
    }

    for (const doc of matches) {
      const item = document.createElement('div');
      item.className = 'doc-item' + (active === doc.file ? ' active' : '');
      item.innerHTML = `<div class="doc-title"></div><div class="doc-meta"></div>`;
      (item.querySelector('.doc-title') as HTMLElement).textContent = titleOf(doc);
      (item.querySelector('.doc-meta') as HTMLElement).textContent = `${doc.file} · ${relativeTime(doc.mtime)}`;
      item.onclick = () => openDoc(doc.file, { push: true });
      list.appendChild(item);
    }
  }
}

function teardownEditor() {
  if (editor) {
    try {
      editor.destroy();
    } catch {}
    editor = null;
  }
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (draftTimer) {
    clearTimeout(draftTimer);
    draftTimer = null;
  }
  hideConflict();
  setSaveStatus('idle');
}

function updateMainHeader(doc: DocMeta) {
  $('mainTitle').textContent = titleOf(doc);
  $('mainMeta').textContent = `${doc.file} · updated ${relativeTime(doc.mtime)}`;
}

async function openDashboard(opts: { push?: boolean } = { push: false }) {
  teardownEditor();
  active = '__dashboard';
  renderSidebar();
  $('mainTitle').textContent = 'Dashboard';
  $('mainMeta').textContent = 'auto-discovered from working notes';
  const body = $('mainBody');
  body.innerHTML = '<div class="empty-state">Loading…</div>';
  writeHash(opts);

  let data: DashboardData;
  try {
    const res = await fetch('/api/dashboard');
    if (!res.ok) throw new Error('dashboard failed: ' + res.status);
    data = (await res.json()) as DashboardData;
  } catch (e) {
    console.error(e);
    if (active === '__dashboard')
      body.innerHTML = '<div class="empty-state">Failed to load dashboard.</div>';
    return;
  }
  if (active !== '__dashboard') return;

  body.innerHTML = '';
  const dash = document.createElement('div');
  dash.className = 'dashboard';

  if (data.priorities.length) {
    const h = document.createElement('h2');
    h.textContent = 'Priorities';
    dash.appendChild(h);
    for (const item of data.priorities) {
      dash.appendChild(priorityRow(item, item.file));
    }
  }

  const h2 = document.createElement('h2');
  h2.textContent = 'Open todos';
  dash.appendChild(h2);
  if (data.todos.length === 0) {
    const empty = document.createElement('div');
    empty.style.color = 'var(--muted)';
    empty.style.fontSize = '13px';
    empty.style.padding = '8px 0';
    empty.textContent = 'No open todos in working notes.';
    dash.appendChild(empty);
  } else {
    for (const t of data.todos) dash.appendChild(todoRow(t.text, t.file));
  }

  body.appendChild(dash);
}

function todoRow(text: string, file: string): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'todo';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  const txt = document.createElement('div');
  txt.className = 'text';
  txt.textContent = text;
  const src = document.createElement('div');
  src.className = 'source';
  src.textContent = file;
  src.onclick = (e) => {
    e.stopPropagation();
    openDoc(file, { push: true });
  };
  cb.onchange = async () => {
    cb.disabled = true;
    try {
      const res = await fetch('/api/toggle-todo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file, text, checked: cb.checked }),
      });
      if (!res.ok) throw new Error('toggle failed: ' + res.status);
      txt.classList.add('done');
      row.style.opacity = '0.4';
    } catch (e) {
      console.error(e);
      cb.checked = !cb.checked;
      cb.disabled = false;
    }
  };
  row.appendChild(cb);
  row.appendChild(txt);
  row.appendChild(src);
  return row;
}

function priorityRow(
  item: DashboardData['priorities'][number],
  file: string,
): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'todo';
  let marker: HTMLElement;
  if (item.checked != null) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = item.checked;
    cb.disabled = true;
    marker = cb;
  } else if (item.kind === 'numbered') {
    marker = document.createElement('span');
    marker.className = 'marker-numbered';
    marker.textContent = item.number + '.';
  } else {
    marker = document.createElement('span');
    marker.className = 'marker-bullet';
    marker.textContent = '•';
  }
  const txt = document.createElement('div');
  txt.className = 'text' + (item.checked === true ? ' done' : '');
  txt.textContent = item.text;
  const src = document.createElement('div');
  src.className = 'source';
  src.textContent = file;
  src.onclick = (e) => {
    e.stopPropagation();
    openDoc(file, { push: true });
  };
  row.appendChild(marker);
  row.appendChild(txt);
  row.appendChild(src);
  return row;
}

// ---- Editor theme ----
function notebookTheme(dark: boolean) {
  // Mirror the app's CSS variables. The shell already defines them; here we
  // pull the colors through into the editor so it doesn't ship its own
  // baseline. We use color: inherit / background: transparent where possible
  // to let the host element dictate.
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        backgroundColor: 'var(--bg)',
        color: 'var(--text)',
        fontSize: '15px',
      },
      '.cm-scroller': {
        fontFamily:
          'ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        lineHeight: '1.6',
        padding: '16px 24px 40vh',
      },
      '.cm-content': {
        caretColor: 'var(--accent)',
      },
      '.cm-line': {
        padding: '0 4px',
      },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
      '&.cm-focused .cm-selectionBackground, ::selection': {
        backgroundColor: dark ? 'rgba(255,87,101,0.25)' : 'rgba(200,16,46,0.18)',
      },
      '.cm-selectionMatch': { backgroundColor: 'var(--hover)' },
      '.cm-activeLine': { backgroundColor: 'transparent' },
      '.cm-gutters': { display: 'none' },
      // Live preview class hooks.
      '.cm-heading': {
        fontWeight: '600',
        lineHeight: '1.25',
      },
      '.cm-heading-1': { fontSize: '1.8em', marginTop: '0.5em' },
      '.cm-heading-2': { fontSize: '1.5em', marginTop: '0.5em' },
      '.cm-heading-3': { fontSize: '1.25em', marginTop: '0.4em' },
      '.cm-heading-4': { fontSize: '1.1em' },
      '.cm-heading-5': { fontSize: '1em' },
      '.cm-heading-6': { fontSize: '0.9em', color: 'var(--muted)' },
      '.cm-md-bold': { fontWeight: '700' },
      '.cm-md-italic': { fontStyle: 'italic' },
      '.cm-md-strike': { textDecoration: 'line-through', color: 'var(--muted)' },
      '.cm-md-code': {
        fontFamily: 'ui-monospace, SFMono-Regular, monospace',
        fontSize: '0.92em',
        backgroundColor: 'var(--hover)',
        padding: '1px 4px',
        borderRadius: '3px',
      },
      '.cm-md-link-text': {
        color: 'var(--accent)',
        textDecoration: 'underline',
        textUnderlineOffset: '2px',
      },
      '.cm-task-checkbox': {
        verticalAlign: 'middle',
        margin: '0 4px 0 0',
        cursor: 'pointer',
      },
    },
    { dark },
  );
}

// Markdown syntax highlight: subtle markers, emphasized headings beyond the
// live-preview class hooks. Used alongside livePreview() so source markers
// (`#`, `**`, etc.) have a calmer color.
const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.heading1, fontWeight: '600' },
  { tag: tags.heading2, fontWeight: '600' },
  { tag: tags.heading3, fontWeight: '600' },
  { tag: tags.heading4, fontWeight: '600' },
  { tag: tags.heading5, fontWeight: '600' },
  { tag: tags.heading6, fontWeight: '600' },
  { tag: tags.processingInstruction, color: 'var(--muted)' },
  { tag: tags.contentSeparator, color: 'var(--muted)' },
  { tag: tags.url, color: 'var(--muted)' },
  { tag: tags.link, color: 'var(--accent)' },
  { tag: tags.monospace, fontFamily: 'ui-monospace, SFMono-Regular, monospace' },
  { tag: tags.quote, color: 'var(--muted)', fontStyle: 'italic' },
]);

function currentThemeExtension() {
  return notebookTheme(darkMediaQuery.matches);
}

darkMediaQuery.addEventListener('change', () => {
  if (!editor) return;
  editor.dispatch({ effects: themeCompartment.reconfigure(currentThemeExtension()) });
});

function makeEditor(host: HTMLElement, initialBody: string): EditorView {
  const state = EditorState.create({
    doc: initialBody,
    extensions: [
      cmHistory(),
      EditorView.lineWrapping,
      markdown({ base: markdownLanguage, codeLanguages: [] }),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      syntaxHighlighting(markdownHighlightStyle),
      indentOnInput(),
      bracketMatching(),
      highlightSelectionMatches(),
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        ...foldKeymap,
        indentWithTab,
      ]),
      livePreview(),
      themeCompartment.of(currentThemeExtension()),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) scheduleSave();
      }),
    ],
  });
  return new EditorView({ state, parent: host });
}

// ---- Open doc ----
async function openDoc(file: string, opts: { push?: boolean } = { push: false }) {
  teardownEditor();
  const doc = docs.get(file);
  if (!doc) {
    openDashboard(opts);
    return;
  }
  active = file;
  renderSidebar();
  updateMainHeader(doc);
  const bodyEl = $('mainBody');
  bodyEl.innerHTML = '<div class="empty-state">Loading…</div>';

  let body = doc.body;
  if (body == null) {
    try {
      const res = await fetch('/api/doc/' + encodeURIComponent(file));
      if (!res.ok) throw new Error('load failed: ' + res.status);
      body = await res.text();
    } catch (e) {
      console.error(e);
      if (active === file)
        bodyEl.innerHTML = '<div class="empty-state">Failed to load doc.</div>';
      return;
    }
    if (active !== file) return;
    doc.body = body;
  }

  bodyEl.innerHTML = '';

  if (doc.type === 'html') {
    const host = document.createElement('div');
    host.className = 'shadow-host';
    bodyEl.appendChild(host);
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = body;
    writeHash(opts);
    return;
  }

  const host = document.createElement('div');
  host.style.height = '100%';
  host.style.overflow = 'auto';
  bodyEl.appendChild(host);
  editor = makeEditor(host, body);

  const draft = await loadDraft(file);
  if (draft && draft.baseHash === doc.hash && draft.body !== body) {
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: draft.body },
    });
    setSaveStatus('dirty');
    scheduleSave();
  } else if (draft) {
    clearDraft(file);
  }

  writeHash(opts);
}

// ---- Boot ----
async function boot() {
  const res = await fetch('/api/index');
  const list = (await res.json()) as DocMeta[];
  docs = new Map(list.map((d) => [d.file, d]));

  const initial = readHash();
  activeTab = initial.tab;
  $<HTMLInputElement>('search').value = initial.search;

  renderTabs();
  renderSidebar();
  if (initial.search) runSearch();

  if (initial.doc && docs.has(initial.doc)) openDoc(initial.doc, { push: false });
  else openDashboard({ push: false });

  connectSSE();

  setInterval(() => {
    if (saveState === 'saved' && lastSavedAt) setSaveStatus('saved');
  }, 5000);
}

async function runSearch() {
  const q = $<HTMLInputElement>('search').value.trim();
  if (!q) {
    searchHits = null;
    renderSidebar();
    return;
  }
  try {
    const res = await fetch('/api/search?q=' + encodeURIComponent(q));
    if (!res.ok) return;
    const hits = (await res.json()) as Array<{ file: string }>;
    if ($<HTMLInputElement>('search').value.trim() !== q) return;
    searchHits = new Set(hits.map((h) => h.file));
    renderSidebar();
  } catch (e) {
    console.error('search failed', e);
  }
}

function scheduleSearch() {
  if (searchTimer) clearTimeout(searchTimer);
  if (!$<HTMLInputElement>('search').value.trim()) {
    searchHits = null;
    renderSidebar();
    return;
  }
  searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
}

$('search').addEventListener('input', () => {
  scheduleSearch();
  writeHash({ push: false });
});

window.addEventListener('popstate', () => {
  const state = readHash();
  activeTab = state.tab;
  $<HTMLInputElement>('search').value = state.search;
  renderTabs();
  runSearch();
  if (state.doc && docs.has(state.doc)) openDoc(state.doc, { push: false });
  else openDashboard({ push: false });
});

setInterval(() => {
  if (active !== '__dashboard') renderSidebar();
}, 60000);

boot().catch((e) => {
  console.error(e);
  $('mainBody').innerHTML = '<div class="empty-state">Failed to load. Is the server running?</div>';
});
