import { LitElement, html, nothing } from 'lit';
import { customElement, state } from 'lit/decorators.js';
import * as api from './api.ts';
import {
  DASHBOARD,
  TYPE_GROUPS,
  type DashboardData,
  type DocMeta,
  type SaveState,
  relativeTime,
  shortTime,
  titleOf,
} from './util.ts';

type Mode = 'auto' | 'light' | 'dark';
const MODES: Mode[] = ['light', 'dark', 'auto'];
const SEARCH_DEBOUNCE_MS = 120;

interface NotebookThemeConfig {
  themes: Array<{ id: string; name: string }>;
  buildThemeVars: (theme: unknown) => void;
  MODE_KEY: string;
  THEME_KEY: string;
  mql: MediaQueryList;
}
declare global {
  interface Window {
    __notebookTheme?: NotebookThemeConfig;
  }
}

type SseEvent =
  | { kind: 'add' | 'change'; file: string; type: string; hash: string; mtime: number; title: string }
  | { kind: 'remove'; file: string };

@customElement('notebook-app')
export class NotebookApp extends LitElement {
  @state() private docs: DocMeta[] = [];
  @state() private activeFile = DASHBOARD;
  @state() private activeTab = 'all';
  @state() private query = '';
  @state() private searchHits: Set<string> | null = null;
  @state() private mode: Mode = 'auto';
  @state() private themeId = '';
  @state() private scheme: 'light' | 'dark' = 'dark';
  @state() private saveStatus: SaveState = 'idle';
  @state() private settingsOpen = false;
  @state() private dashboard: DashboardData | null = null;
  @state() private editorConflict: { body: string; hash: string } | null = null;

  private readonly theme = window.__notebookTheme!;
  private es?: EventSource;
  private searchTimer?: ReturnType<typeof setTimeout>;
  private savedTimer?: ReturnType<typeof setInterval>;
  private mtimeTimer?: ReturnType<typeof setInterval>;
  private lastSavedAt: number | null = null;

  createRenderRoot() {
    return this;
  }

  connectedCallback(): void {
    super.connectedCallback();
    try {
      const m = localStorage.getItem(this.theme.MODE_KEY);
      if (m === 'auto' || m === 'light' || m === 'dark') this.mode = m;
    } catch {}
    const fallback = this.theme.themes[0]?.id ?? '';
    try {
      const id = localStorage.getItem(this.theme.THEME_KEY);
      this.themeId = this.theme.themes.some((t) => t.id === id) ? (id as string) : fallback;
    } catch {
      this.themeId = fallback;
    }
    this.applyMode();
    this.theme.mql.addEventListener('change', this.onMql);
    window.addEventListener('popstate', this.onPopState);
    this.savedTimer = setInterval(() => {
      if (this.saveStatus === 'saved') this.requestUpdate();
    }, 5000);
    this.mtimeTimer = setInterval(() => this.requestUpdate(), 60000);
    void this.boot();
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.theme.mql.removeEventListener('change', this.onMql);
    window.removeEventListener('popstate', this.onPopState);
    this.es?.close();
    clearInterval(this.savedTimer);
    clearInterval(this.mtimeTimer);
  }

  // ---- theme / mode ----
  private applyMode(): void {
    const resolved = this.mode === 'auto' ? (this.theme.mql.matches ? 'dark' : 'light') : this.mode;
    document.documentElement.dataset.theme = resolved;
    this.scheme = resolved;
  }
  private onMql = (): void => {
    if (this.mode === 'auto') this.applyMode();
  };
  private setMode(m: Mode): void {
    this.mode = m;
    try {
      localStorage.setItem(this.theme.MODE_KEY, m);
    } catch {}
    this.applyMode();
  }
  private setTheme(id: string): void {
    this.themeId = id;
    try {
      localStorage.setItem(this.theme.THEME_KEY, id);
    } catch {}
    const theme = this.theme.themes.find((t) => t.id === id);
    if (theme) this.theme.buildThemeVars(theme);
  }

  // ---- routing ----
  private readHash() {
    const params = new URLSearchParams(location.hash.slice(1));
    return {
      doc: params.get('doc'),
      tab: params.get('tab') || 'all',
      search: params.get('search') || '',
    };
  }
  private writeHash(push: boolean): void {
    const params = new URLSearchParams();
    if (this.activeFile !== DASHBOARD) params.set('doc', this.activeFile);
    if (this.activeTab !== 'all') params.set('tab', this.activeTab);
    if (this.query) params.set('search', this.query);
    const newHash = '#' + params.toString();
    if (newHash === location.hash || (newHash === '#' && !location.hash)) return;
    if (push) history.pushState(null, '', newHash);
    else history.replaceState(null, '', newHash);
  }
  private onPopState = (): void => {
    const s = this.readHash();
    this.activeTab = s.tab;
    this.query = s.search;
    void this.runSearch();
    if (s.doc && this.docs.some((d) => d.file === s.doc)) void this.openDoc(s.doc, false);
    else void this.openDashboard(false);
  };

  // ---- boot / data ----
  private async boot(): Promise<void> {
    try {
      this.docs = await api.getIndex();
    } catch (e) {
      console.error(e);
      return;
    }
    const initial = this.readHash();
    this.activeTab = initial.tab;
    this.query = initial.search;
    if (initial.search) void this.runSearch();
    if (initial.doc && this.docs.some((d) => d.file === initial.doc)) await this.openDoc(initial.doc, false);
    else await this.openDashboard(false);
    this.connectSse();
  }

  private connectSse(): void {
    this.es = new EventSource('/api/events');
    this.es.onmessage = (e) => {
      try {
        void this.handleSse(JSON.parse(e.data) as SseEvent);
      } catch {}
    };
  }

  private upsertDoc(meta: DocMeta): void {
    const i = this.docs.findIndex((d) => d.file === meta.file);
    this.docs = i === -1 ? [...this.docs, meta] : this.docs.map((d) => (d.file === meta.file ? meta : d));
  }

  private async handleSse(ev: SseEvent): Promise<void> {
    if (ev.kind === 'remove') {
      this.docs = this.docs.filter((d) => d.file !== ev.file);
      if (this.activeFile === ev.file) void this.openDashboard(false);
      return;
    }
    const { file, type, hash, mtime, title } = ev;
    const prev = this.docs.find((d) => d.file === file);
    if (prev && prev.hash === hash) return;

    if (this.activeFile !== file || !prev) {
      this.upsertDoc({ file, type, hash, mtime, title });
      if (this.activeFile === DASHBOARD) void this.loadDashboard();
      return;
    }

    // The active doc changed on disk.
    let body: string;
    try {
      body = await api.getDoc(file);
    } catch (e) {
      console.error('SSE body fetch failed', e);
      return;
    }
    this.upsertDoc({ file, type, hash, mtime, title, body });
    if (type === 'html') return; // editor remounts via the hash change
    this.editorConflict = { body, hash };
  }

  private async loadDashboard(): Promise<void> {
    try {
      this.dashboard = await api.getDashboard();
    } catch (e) {
      console.error(e);
    }
  }

  // ---- navigation ----
  private select = (e: CustomEvent): void => {
    const file = e.detail.file as string;
    if (file === DASHBOARD) void this.openDashboard(true);
    else void this.openDoc(file, true);
  };

  private async openDashboard(push: boolean): Promise<void> {
    this.activeFile = DASHBOARD;
    this.editorConflict = null;
    this.saveStatus = 'idle';
    this.writeHash(push);
    await this.loadDashboard();
  }

  private async openDoc(file: string, push: boolean): Promise<void> {
    const entry = this.docs.find((d) => d.file === file);
    if (!entry) {
      await this.openDashboard(push);
      return;
    }
    this.activeFile = file;
    this.editorConflict = null;
    this.saveStatus = 'idle';
    if (entry.body == null) {
      try {
        const body = await api.getDoc(file);
        this.upsertDoc({ ...entry, body });
      } catch (e) {
        console.error(e);
      }
    }
    this.writeHash(push);
  }

  // ---- search ----
  private onSearch(value: string): void {
    this.query = value;
    this.writeHash(false);
    clearTimeout(this.searchTimer);
    if (!value.trim()) {
      this.searchHits = null;
      return;
    }
    this.searchTimer = setTimeout(() => void this.runSearch(), SEARCH_DEBOUNCE_MS);
  }
  private async runSearch(): Promise<void> {
    const q = this.query.trim();
    if (!q) {
      this.searchHits = null;
      return;
    }
    const hits = await api.search(q);
    if (this.query.trim() !== q) return;
    this.searchHits = new Set(hits.map((h) => h.file));
  }

  // ---- child events ----
  private onStatus = (e: CustomEvent): void => {
    this.saveStatus = e.detail.state as SaveState;
    if (this.saveStatus === 'saved') this.lastSavedAt = Date.now();
  };
  private onMetaUpdate = (e: CustomEvent): void => {
    const { file, hash, mtime, title, body } = e.detail as {
      file: string;
      hash: string;
      mtime: number;
      title: string;
      body: string;
    };
    this.docs = this.docs.map((d) => (d.file === file ? { ...d, hash, mtime, title, body } : d));
  };
  private onNavigate = (e: CustomEvent): void => {
    void this.openDoc(e.detail.file as string, true);
  };
  private onToggleTodo = async (e: CustomEvent): Promise<void> => {
    const { file, text, checked } = e.detail as { file: string; text: string; checked: boolean };
    try {
      await api.toggleTodo(file, text, checked);
    } catch (err) {
      console.error(err);
    }
  };

  // ---- render helpers ----
  private tabItems() {
    const counts = new Map<string, number>();
    for (const d of this.docs) counts.set(d.type, (counts.get(d.type) || 0) + 1);
    const items = [{ key: 'all', label: 'all', count: this.docs.length }];
    for (const g of TYPE_GROUPS) {
      const c = counts.get(g.type) || 0;
      if (c) items.push({ key: g.type, label: g.label.toLowerCase(), count: c });
    }
    return items;
  }

  private statusText(): string {
    switch (this.saveStatus) {
      case 'dirty':
        return 'unsaved';
      case 'saving':
        return 'saving…';
      case 'saved':
        return this.lastSavedAt ? 'saved ' + shortTime(this.lastSavedAt) : 'saved';
      case 'error':
        return 'save failed';
      default:
        return '';
    }
  }

  render() {
    const themes = this.theme.themes;
    const activeDoc = this.docs.find((d) => d.file === this.activeFile);
    const isDash = this.activeFile === DASHBOARD;
    const metaText = isDash
      ? 'auto-discovered from working notes'
      : activeDoc
        ? `${activeDoc.file} · updated ${relativeTime(activeDoc.mtime)}`
        : '';

    return html`
      <div class="app">
        <aside class="sidebar">
          <div class="sidebar-header">
            <div class="eyebrow">Docs</div>
            <h1 class="logotype">note<em>book</em></h1>
            <input
              type="text"
              placeholder="search…"
              autocomplete="off"
              .value=${this.query}
              @input=${(e: Event) => this.onSearch((e.target as HTMLInputElement).value)}
            />
            <div class="count-line">
              <b>${this.docs.length}</b> document${this.docs.length === 1 ? '' : 's'}
            </div>
          </div>
          <div class="sidebar-tabs">
            ${this.tabItems().map(
              (it) => html`
                <button class="tab ${it.key === this.activeTab ? 'active' : ''}" @click=${() => {
                  this.activeTab = it.key;
                  this.writeHash(true);
                }}>
                  <span>${it.label}</span><span class="tab-count">${it.count}</span>
                </button>
              `,
            )}
          </div>
          <notebook-doc-list
            class="sidebar-list"
            .docs=${this.docs}
            .activeFile=${this.activeFile}
            .activeTab=${this.activeTab}
            .searchHits=${this.searchHits}
            @select=${this.select}
          ></notebook-doc-list>
          <div class="side-foot">
            <button
              class="foot-toggle"
              aria-expanded=${this.settingsOpen}
              @click=${() => (this.settingsOpen = !this.settingsOpen)}
            >
              <span class="foot-label">Settings</span>
              <span class="cog">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="12" r="3"></circle>
                  <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                </svg>
              </span>
            </button>
            <div class="foot-tray ${this.settingsOpen ? 'open' : ''}">
              ${themes.length > 1
                ? html`<div class="foot-row">
                    <span class="foot-label">Theme</span>
                    <select
                      class="theme-select"
                      @change=${(e: Event) => this.setTheme((e.target as HTMLSelectElement).value)}
                    >
                      ${themes.map(
                        (t) => html`<option value=${t.id} ?selected=${t.id === this.themeId}>${t.name}</option>`,
                      )}
                    </select>
                  </div>`
                : nothing}
              <div class="foot-row">
                <span class="foot-label">Mode</span>
                <div class="seg">
                  ${MODES.map(
                    (m) => html`<button
                      data-mode=${m}
                      aria-pressed=${this.mode === m}
                      @click=${() => this.setMode(m)}
                    >
                      ${m[0].toUpperCase()}${m.slice(1)}
                    </button>`,
                  )}
                </div>
              </div>
            </div>
          </div>
        </aside>
        <main class="main">
          <header class="main-header">
            <div class="main-title">${isDash ? 'Dashboard' : activeDoc ? titleOf(activeDoc) : ''}</div>
            <div class="main-meta">
              <span id="mainMeta">${metaText}</span>
              <span class="save-status ${this.saveStatus}">${this.statusText()}</span>
            </div>
          </header>
          <div class="main-body">
            ${isDash
              ? html`<notebook-dashboard
                  .priorities=${this.dashboard?.priorities ?? []}
                  .todos=${this.dashboard?.todos ?? []}
                  @navigate=${this.onNavigate}
                  @toggle-todo=${this.onToggleTodo}
                ></notebook-dashboard>`
              : activeDoc && activeDoc.body != null
                ? html`<notebook-editor
                    .doc=${{ ...activeDoc, body: activeDoc.body }}
                    .scheme=${this.scheme}
                    .conflict=${this.editorConflict}
                    @statuschange=${this.onStatus}
                    @metaupdate=${this.onMetaUpdate}
                  ></notebook-editor>`
                : html`<div class="empty-state">Loading…</div>`}
          </div>
        </main>
      </div>
    `;
  }
}
