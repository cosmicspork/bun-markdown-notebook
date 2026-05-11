# notebook

A small SPA + Bun server that turns a flat directory of `<type>-<slug>.md` files into a live, WYSIWYG-edited notebook. One person, one machine, plain markdown on disk, no database.

## Why

Most note tools either lock your data in a proprietary store or push you toward a fixed folder structure with required metadata (YAML frontmatter, tags databases, etc.). This is the opposite: files are flat at the docs root, the only "schema" is the filename prefix, and any tool that can read a markdown file (your editor, ripgrep, an LLM agent, git) can read these too.

## Features

- **Auto-discovery.** The server scans the docs directory on boot and live-watches with chokidar. The SPA fetches one JSON index and stays in sync.
- **Live WYSIWYG.** Toast UI Editor renders markdown in WYSIWYG mode. Your mode preference (WYSIWYG vs markdown source) persists globally.
- **HTML docs in iframes.** Files like `foo.html` render in a sandboxed iframe with their own styles and scripts. Good for one-off documents that don't fit markdown.
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
