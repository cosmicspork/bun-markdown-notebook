import { syntaxTree } from '@codemirror/language';
import type { Extension, Range } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from '@codemirror/view';

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(other: CheckboxWidget) {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView): HTMLElement {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = this.checked;
    input.className = 'cm-task-checkbox';
    input.addEventListener('mousedown', (e) => e.preventDefault());
    input.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const pos = view.posAtDOM(input);
      const current = view.state.sliceDoc(pos, pos + 3);
      let next: string | null = null;
      if (current === '[ ]') next = '[x]';
      else if (current === '[x]' || current === '[X]') next = '[ ]';
      if (next == null) return;
      view.dispatch({ changes: { from: pos, to: pos + 3, insert: next } });
    });
    return input;
  }
  ignoreEvent() {
    return false;
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const selection = view.state.selection;
  const overlapsSelection = (from: number, to: number) =>
    selection.ranges.some((r) => r.from <= to && r.to >= from);

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(view.state).iterate({
      from,
      to,
      enter(node) {
        const name = node.name;

        if (name.startsWith('ATXHeading')) {
          const level = Number(name.slice(-1));
          ranges.push(
            Decoration.line({
              attributes: { class: `cm-heading cm-heading-${level}` },
            }).range(node.from),
          );
          return;
        }

        if (name === 'StrongEmphasis') {
          ranges.push(Decoration.mark({ class: 'cm-md-bold' }).range(node.from, node.to));
          return;
        }
        if (name === 'Emphasis') {
          ranges.push(Decoration.mark({ class: 'cm-md-italic' }).range(node.from, node.to));
          return;
        }
        if (name === 'Strikethrough') {
          ranges.push(Decoration.mark({ class: 'cm-md-strike' }).range(node.from, node.to));
          return;
        }
        if (name === 'InlineCode') {
          ranges.push(Decoration.mark({ class: 'cm-md-code' }).range(node.from, node.to));
          return;
        }

        if (name === 'Link') {
          // Children, in order: LinkMark "[", text, LinkMark "]", LinkMark "(", URL, LinkMark ")".
          // Some children (the URL parens, the text) may be absent in malformed forms — guard.
          let textFrom = -1;
          let textTo = -1;
          let urlOpenStart = -1;
          const cursor = node.node.cursor();
          if (cursor.firstChild()) {
            do {
              const cName = cursor.name;
              if (cName === 'LinkMark') {
                // The `](` mark — first LinkMark that comes after the text.
                if (textTo !== -1 && urlOpenStart === -1) urlOpenStart = cursor.from;
                continue;
              }
              if (cName === 'URL') continue;
              // Anything else inside a Link is the text (could be plain text or inline markup).
              if (textFrom === -1) {
                textFrom = cursor.from;
                textTo = cursor.to;
              } else {
                textTo = cursor.to;
              }
            } while (cursor.nextSibling());
          }
          if (textFrom !== -1) {
            ranges.push(
              Decoration.mark({ class: 'cm-md-link-text' }).range(textFrom, textTo),
            );
          }
          // Hide the `](url)` portion when the caret isn't inside this link.
          if (!overlapsSelection(node.from, node.to) && urlOpenStart !== -1) {
            ranges.push(Decoration.replace({}).range(urlOpenStart, node.to));
          }
          return;
        }

        if (name === 'TaskMarker') {
          const text = view.state.sliceDoc(node.from, node.to);
          const checked = text === '[x]' || text === '[X]';
          ranges.push(
            Decoration.replace({ widget: new CheckboxWidget(checked) }).range(node.from, node.to),
          );
          return;
        }
      },
    });
  }

  return Decoration.set(ranges, true);
}

export function livePreview(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = buildDecorations(view);
      }
      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged
        ) {
          this.decorations = buildDecorations(update.view);
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    },
  );
}
