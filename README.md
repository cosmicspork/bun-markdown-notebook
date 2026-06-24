# notebook

A small SPA + Bun server that turns a flat directory of `<type>-<slug>.md` files into a live, WYSIWYG-edited notebook. One person, one machine, plain markdown on disk, no database.

## Why

Most note tools either lock your data in a proprietary store or push you toward a fixed folder structure with required metadata (YAML frontmatter, tags databases, etc.). This is the opposite: files are flat at the docs root, the only "schema" is the filename prefix, and any tool that can read a markdown file (your editor, ripgrep, an LLM agent, git) can read these too.

## Features

- **Auto-discovery.** The server scans the docs directory on boot and live-watches with chokidar. The SPA fetches one JSON index and stays in sync.
- **Live-preview editor.** A CodeMirror 6 editor edits the markdown source in place, with live decorations — headings styled inline, inline code/bold/italic rendered, task checkboxes interactive, and link URLs folded away until the caret enters them. The UI is built as Lit web components.
- **HTML docs in a Shadow DOM.** Files like `foo.html` render in an open shadow root — style-isolated from the app in both directions, no iframe. There is one authoring gotcha; see [Authoring HTML docs](#authoring-html-docs). Good for one-off documents that don't fit markdown.
- **Auto-save with conflict detection.** Edits debounce-save with `If-Match: <hash>`. If another process rewrites a file between load and save, the SPA shows a conflict banner instead of silently clobbering.
- **Live updates over SSE.** Edit a file from the CLI, the SPA picks it up within a second and surfaces the change for review.
- **URL-shareable state.** Active doc, tab filter, and search query live in the URL hash. Back/forward and refresh work.
- **Dashboard.** Auto-scans `- [ ]` lines from working-note types into an "Open todos" view, plus renders any list items in `note-priorities.md` as a Priorities panel.

## Recognized type prefixes

The server groups docs into these categories based on filename prefix:

| Prefix | Group |
|---|---|
| `note-` | Notes (personal, todos) |
| `repo-` | Repo-scoped working notes |
| `meeting-` | Meeting agendas / minutes |
| `inbox-` | Un-triaged thoughts |
| `proposal-` | Proposals |
| `plan-` | Migration / project plans |
| `guide-` | How-to guides |
| `ref-` | Reference docs |
| `architecture-` | Architecture docs |
| (`.html`) | Self-contained HTML docs |

Working-note types (`note`, `repo`, `meeting`, `inbox`) are the only ones scanned for the dashboard's open-todos list. Files with unrecognized prefixes appear under `other`.

## Authoring HTML docs

An `.html` doc renders inside an **open Shadow DOM** (`host.attachShadow({ mode: 'open' })`, then `shadowRoot.innerHTML = <your file>`), not an iframe. This isolates styles in both directions — the doc's CSS can't leak into the app and the app's CSS can't reach the doc — while keeping the doc in the same document, so find-in-page, same-origin anchors, and scroll behave normally.

**The one gotcha: `<html>`, `<head>`, and `<body>` are stripped.** Assigning to `shadowRoot.innerHTML` parses the markup as a *fragment*, and the parser discards the `<html>`/`<head>`/`<body>` wrapper elements. Their children survive — `<meta>`, `<title>`, `<link rel="stylesheet">`, `<style>`, and everything that was inside `<body>` — but the wrapper elements themselves are gone. So:

- **Don't theme through `body` or `html`.** Rules like `body { background: … }`, `html { … }`, and `body::before` / `body::after` match nothing in the shadow root, and a doc that paints its canvas or overlays on `body` renders bare. **Wrap your content in a top-level element** (e.g. `<div class="page">`) and put the background, base text color, and any full-bleed overlays on *that*.
- **Don't define custom properties on `:root`.** `:root` is just `<html>`, which doesn't exist in the shadow tree, so a `:root { --ink: …; --accent: … }` palette never applies — every `var(--…)` then resolves to nothing, the declaration is invalid at computed-value time, and colors silently collapse to inherited values (the most common way this section's lesson actually bites). Define the variables on **`:host, :root`** instead: `:host` matches the shadow host from inside the shadow tree, and `:root` keeps it working when the file is opened directly. Custom properties inherit, so they cascade into the whole doc from either selector.
- **Avoid `position: fixed` for decoration.** A fixed element inside the shadow tree is positioned against the app viewport, not your doc, so it will cover the app chrome. Use a `position: relative` wrapper with `position: absolute; inset: 0` overlays instead.
- **`<style>` and `<link>` work** inside the shadow root — scoped styles apply and web fonts load. **`<script>` does _not_ run**, though: markup assigned via `innerHTML` has its scripts disabled by the HTML parser. The SPA renders HTML docs **statically**. Make a doc useful without JS, and treat interactivity as progressive enhancement that only activates when the file is opened directly — e.g. keep JS-only controls hidden by default and have the script reveal them, so they don't sit dead in the SPA.
- **Keep it a valid standalone file too.** Author so it also renders correctly opened directly in a browser: a real `<body>` *plus* a `.page` wrapper that paints the same canvas satisfies both contexts.

The host element imposes no styling beyond sizing (it does **not** set a background), so the doc owns its entire look.

## Development

```bash
bun install
DOCS_DIR=~/path/to/your/docs bun start
# open http://localhost:3000
```

`DOCS_DIR` defaults to `./docs` relative to the working directory. `PORT` defaults to `3000`.

For iterating on the server itself, use the hot-reload mode — it restarts the Bun process on file changes:

```bash
bun run dev
```

## API

The server exposes a small HTTP surface so other tools (scripts, agents, editors) can read or write docs without going through the SPA.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/index` | List of doc metadata (no bodies): `{file, type, mtime, hash, title}[]`. |
| `GET` | `/api/doc/:file` | Raw body. Response sets `ETag: <hash>`. |
| `PUT` | `/api/doc/:file` | Write body (`text/markdown`). Send `If-Match: <hash>`; on mismatch, `412` returns `{hash, body}` for conflict resolution. |
| `POST` | `/api/doc` | Create. JSON `{file, body}`; `409` if the file already exists. |
| `DELETE` | `/api/doc/:file` | Copies to `archive/` then unlinks. |
| `GET` | `/api/dashboard` | `{priorities, todos}` derived from working-note docs server-side. |
| `GET` | `/api/search?q=foo` | Case-insensitive match across title, filename, and body. Returns `[{file}]`. |
| `GET` | `/api/events` | Server-Sent Events stream of `add` / `change` / `remove` events. |

## License

MIT. See [LICENSE](LICENSE).
