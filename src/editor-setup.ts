import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import {
  defaultKeymap,
  history as cmHistory,
  historyKeymap,
  indentWithTab,
} from '@codemirror/commands';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import {
  HighlightStyle,
  bracketMatching,
  defaultHighlightStyle,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { tags } from '@lezer/highlight';
import { livePreview } from './live-preview.ts';

// Mirror the app's CSS variables. The shell defines them; here we pull the
// colors through into the editor so it doesn't ship its own baseline. Heading
// hooks use the serif display font for an editorial feel while writing.
export function notebookTheme(dark: boolean) {
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        backgroundColor: 'var(--bg)',
        color: 'var(--ink)',
        fontSize: '15px',
      },
      '.cm-scroller': {
        fontFamily: 'var(--sans)',
        lineHeight: '1.6',
        padding: '20px 36px 40vh',
      },
      '.cm-content': {
        caretColor: 'var(--accent)',
      },
      '.cm-line': {
        padding: '0 4px',
      },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
      '&.cm-focused .cm-selectionBackground, ::selection': {
        backgroundColor: 'color-mix(in srgb, var(--accent) 22%, transparent)',
      },
      '.cm-selectionMatch': { backgroundColor: 'var(--surface-3)' },
      '.cm-activeLine': { backgroundColor: 'transparent' },
      '.cm-gutters': { display: 'none' },
      // Live preview class hooks.
      '.cm-heading': {
        fontFamily: 'var(--serif)',
        fontWeight: '600',
        lineHeight: '1.25',
      },
      '.cm-heading-1': { fontSize: '1.8em', paddingTop: '0.5em' },
      '.cm-heading-2': { fontSize: '1.5em', paddingTop: '0.5em' },
      '.cm-heading-3': { fontSize: '1.25em', paddingTop: '0.4em' },
      '.cm-heading-4': { fontSize: '1.1em' },
      '.cm-heading-5': { fontSize: '1em' },
      '.cm-heading-6': { fontSize: '0.9em', color: 'var(--muted)' },
      '.cm-md-bold': { fontWeight: '700' },
      '.cm-md-italic': { fontStyle: 'italic' },
      '.cm-md-strike': { textDecoration: 'line-through', color: 'var(--muted)' },
      '.cm-md-code': {
        fontFamily: 'var(--mono)',
        fontSize: '0.92em',
        backgroundColor: 'var(--surface-3)',
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

// Subtle markers, emphasized headings beyond the live-preview class hooks. Used
// alongside livePreview() so source markers (`#`, `**`, etc.) stay calm.
export const markdownHighlightStyle = HighlightStyle.define([
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
  { tag: tags.monospace, fontFamily: 'var(--mono)' },
  { tag: tags.quote, color: 'var(--muted)', fontStyle: 'italic' },
]);

export type EditorHandle = {
  view: EditorView;
  setDark: (dark: boolean) => void;
};

export function makeEditor(
  host: HTMLElement,
  initialBody: string,
  opts: { dark: boolean; onDocChange: () => void },
): EditorHandle {
  const themeCompartment = new Compartment();
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
      themeCompartment.of(notebookTheme(opts.dark)),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) opts.onDocChange();
      }),
    ],
  });
  const view = new EditorView({ state, parent: host });
  return {
    view,
    setDark: (dark: boolean) =>
      view.dispatch({ effects: themeCompartment.reconfigure(notebookTheme(dark)) }),
  };
}
