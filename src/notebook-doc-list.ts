import { LitElement, html } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { repeat } from 'lit/directives/repeat.js';
import { DASHBOARD, TYPE_GROUPS, relativeTime, titleOf, type DocMeta } from './util.ts';

type Item = { k: 'sec'; label: string } | { k: 'doc'; doc: DocMeta };

@customElement('notebook-doc-list')
export class NotebookDocList extends LitElement {
  @property({ attribute: false }) docs: DocMeta[] = [];
  @property() activeFile = DASHBOARD;
  @property() activeTab = 'all';
  @property({ attribute: false }) searchHits: Set<string> | null = null;

  createRenderRoot() {
    return this;
  }

  private select(file: string): void {
    this.dispatchEvent(new CustomEvent('select', { detail: { file }, bubbles: true, composed: true }));
  }

  render() {
    const searching = this.searchHits !== null;
    const showHeaders = this.activeTab === 'all' || searching;
    const allDocs = [...this.docs].sort((a, b) => b.mtime - a.mtime);

    const items: Item[] = [];
    for (const group of TYPE_GROUPS) {
      if (!searching && this.activeTab !== 'all' && this.activeTab !== group.type) continue;
      const matches = allDocs
        .filter((d) => d.type === group.type)
        .filter((d) => !searching || this.searchHits!.has(d.file));
      if (!matches.length) continue;
      if (showHeaders) items.push({ k: 'sec', label: group.label });
      for (const doc of matches) items.push({ k: 'doc', doc });
    }

    let i = 0;
    return html`
      <div
        class="doc-card type-dashboard ${this.activeFile === DASHBOARD ? 'active' : ''}"
        @click=${() => this.select(DASHBOARD)}
      >
        <div class="doc-title">Dashboard</div>
        <div class="doc-meta">overview</div>
      </div>
      ${repeat(
        items,
        (it) => (it.k === 'sec' ? 'sec:' + it.label : 'doc:' + it.doc.file),
        (it) => {
          if (it.k === 'sec') return html`<div class="sidebar-section">${it.label}</div>`;
          const doc = it.doc;
          return html`
            <div
              class="doc-card type-${doc.type} ${this.activeFile === doc.file ? 'active' : ''}"
              style="animation-delay:${i++ * 40}ms"
              @click=${() => this.select(doc.file)}
            >
              <div class="doc-title">${titleOf(doc)}</div>
              <div class="doc-meta">${doc.file} · ${relativeTime(doc.mtime)}</div>
            </div>
          `;
        },
      )}
    `;
  }
}
