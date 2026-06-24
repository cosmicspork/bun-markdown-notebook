import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { type Ref, createRef, ref } from 'lit/directives/ref.js';
import { type EditorHandle, makeEditor } from './editor-setup.ts';
import { clearDraft, loadDraft, persistDraft } from './idb.ts';
import { putDoc } from './api.ts';
import type { DocMeta, SaveState } from './util.ts';

const SAVE_DEBOUNCE_MS = 750;
const DRAFT_DEBOUNCE_MS = 200;

@customElement('notebook-editor')
export class NotebookEditor extends LitElement {
  @property({ attribute: false }) doc!: DocMeta & { body: string };
  @property() scheme: 'light' | 'dark' = 'dark';
  // Set by the root when SSE reports the active file changed on disk.
  @property({ attribute: false }) conflict: { body: string; hash: string } | null = null;

  @state() private conflictBody: string | null = null;

  private host: Ref<HTMLDivElement> = createRef();
  private handle: EditorHandle | null = null;
  private drawnFile: string | null = null;
  private drawnHash = '';
  private drawnScheme = '';
  private prevConflict: { body: string; hash: string } | null = null;

  private currentHash = ''; // If-Match for the next save
  private serverBody = ''; // last body known to match disk (for no-op detection)
  private saveTimer?: ReturnType<typeof setTimeout>;
  private draftTimer?: ReturnType<typeof setTimeout>;

  createRenderRoot() {
    return this;
  }

  firstUpdated() {
    void this.load();
  }

  updated() {
    // Re-load on doc switch, or when an html doc changes on disk (its render is
    // static, so we just rebuild it rather than surfacing a conflict).
    if (this.doc.file !== this.drawnFile || (this.doc.type === 'html' && this.doc.hash !== this.drawnHash)) {
      void this.load();
      return;
    }
    if (this.scheme !== this.drawnScheme) {
      this.drawnScheme = this.scheme;
      this.handle?.setDark(this.scheme === 'dark');
    }
    if (this.conflict !== this.prevConflict) {
      this.prevConflict = this.conflict;
      if (this.conflict) {
        this.currentHash = this.conflict.hash;
        this.conflictBody = this.conflict.body;
      }
    }
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.teardown();
  }

  private teardown(): void {
    clearTimeout(this.saveTimer);
    clearTimeout(this.draftTimer);
    if (this.handle) {
      try {
        this.handle.view.destroy();
      } catch {}
      this.handle = null;
    }
  }

  private buildEditor(body: string): void {
    this.teardown();
    const el = this.host.value;
    if (!el) return;
    el.innerHTML = '';
    this.drawnFile = this.doc.file;
    this.drawnHash = this.doc.hash;
    this.drawnScheme = this.scheme;

    if (this.doc.type === 'html') {
      const shadowHost = document.createElement('div');
      shadowHost.className = 'shadow-host';
      el.appendChild(shadowHost);
      shadowHost.attachShadow({ mode: 'open' }).innerHTML = body;
      return;
    }

    const editorHost = document.createElement('div');
    editorHost.style.height = '100%';
    editorHost.style.overflow = 'auto';
    el.appendChild(editorHost);
    this.handle = makeEditor(editorHost, body, {
      dark: this.scheme === 'dark',
      onDocChange: () => this.scheduleSave(),
    });
  }

  // Fresh load of the current doc (boot, doc switch, html disk change).
  private async load(): Promise<void> {
    this.currentHash = this.doc.hash;
    this.serverBody = this.doc.body;
    this.conflictBody = null;
    this.prevConflict = this.conflict;
    this.emitStatus('idle');
    this.buildEditor(this.doc.body);

    if (this.doc.type === 'html' || !this.handle) return;

    const draft = await loadDraft(this.doc.file);
    if (this.drawnFile !== this.doc.file || !this.handle) return; // switched away mid-await
    if (draft && draft.baseHash === this.currentHash && draft.body !== this.doc.body) {
      this.handle.view.dispatch({
        changes: { from: 0, to: this.handle.view.state.doc.length, insert: draft.body },
      });
      this.emitStatus('dirty');
      this.scheduleSave();
    } else if (draft) {
      void clearDraft(this.doc.file);
    }
  }

  private text(): string {
    return this.handle ? this.handle.view.state.doc.toString() : '';
  }

  private emitStatus(state: SaveState): void {
    this.dispatchEvent(
      new CustomEvent('statuschange', { detail: { state }, bubbles: true, composed: true }),
    );
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    clearTimeout(this.draftTimer);
    this.emitStatus('dirty');
    const file = this.doc.file;
    this.draftTimer = setTimeout(() => void persistDraft(file, this.text(), this.currentHash), DRAFT_DEBOUNCE_MS);
    this.saveTimer = setTimeout(() => void this.save(), SAVE_DEBOUNCE_MS);
  }

  private async save(overwrite = false): Promise<void> {
    if (!this.handle) return;
    const file = this.doc.file;
    const body = this.text();
    if (!overwrite && body === this.serverBody) {
      this.emitStatus('idle');
      return;
    }
    this.emitStatus('saving');
    try {
      const res = await putDoc(file, body, this.currentHash);
      if (!res.ok) {
        this.currentHash = res.hash;
        this.conflictBody = res.body;
        this.emitStatus('error');
        return;
      }
      this.serverBody = body;
      this.currentHash = res.hash;
      this.emitStatus('saved');
      await clearDraft(file);
      this.dispatchEvent(
        new CustomEvent('metaupdate', {
          detail: { file, hash: res.hash, mtime: res.mtime, title: res.title, body },
          bubbles: true,
          composed: true,
        }),
      );
    } catch (e) {
      console.error(e);
      this.emitStatus('error');
    }
  }

  private reload(): void {
    const body = this.conflictBody;
    if (body == null) return;
    void clearDraft(this.doc.file);
    this.conflictBody = null;
    this.serverBody = body;
    // Rebuild so undo history starts fresh — otherwise Cmd+Z could revert to
    // the pre-conflict content. currentHash already points at the disk version.
    this.buildEditor(body);
    this.emitStatus('idle');
  }

  private overwrite(): void {
    this.conflictBody = null;
    void this.save(true);
  }

  render() {
    return html`
      <div class="editor-shell">
        ${this.conflictBody !== null
          ? html`<div class="conflict-banner">
              <span>This file changed on disk.</span>
              <button @click=${() => this.reload()}>Reload from disk</button>
              <button class="secondary" @click=${() => this.overwrite()}>Overwrite anyway</button>
            </div>`
          : nothing}
        <div class="ed-host" ${ref(this.host)}></div>
      </div>
    `;
  }
}
