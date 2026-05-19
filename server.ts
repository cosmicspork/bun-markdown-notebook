import chokidar from 'chokidar';
import { mkdir, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { Buffer } from 'node:buffer';

const DOCS_DIR = resolve(process.env.DOCS_DIR ?? './docs');
const PORT = Number(process.env.PORT ?? 3000);
const HTML_PATH = new URL('./index.html', import.meta.url).pathname;
const APP_ENTRY = new URL('./src/app.ts', import.meta.url).pathname;
const SRC_DIR = new URL('./src', import.meta.url).pathname;

const TYPE_PREFIXES = [
  'note', 'repo', 'meeting', 'inbox',
  'proposal', 'plan', 'guide', 'ref', 'architecture',
];

const VALID_EXTS = new Set(['.md', '.html', '.json']);
const ECHO_SUPPRESS_MS = 600;
const TODO_TYPES = new Set(['note', 'repo', 'meeting', 'inbox']);
const PRIORITIES_FILE = 'note-priorities.md';
const LIST_ITEM_RE = /^\s*(?:([-*])|(\d+)\.)\s+(?:\[([ xX])\]\s+)?(.+)$/;

type Doc = {
  file: string;
  type: string;
  mtime: number;
  hash: string;
  title: string;
  body: string;
};

type IndexEntry = Omit<Doc, 'body'>;

type ListItem = {
  text: string;
  kind: 'bullet' | 'numbered';
  number: string | null;
  checked: boolean | null;
};

type SseEvent =
  | { kind: 'add' | 'change'; file: string; type: string; hash: string; mtime: number; title: string }
  | { kind: 'remove'; file: string };

const index = new Map<string, Doc>();
const sseClients = new Set<(event: SseEvent) => void>();
const recentWrites = new Map<string, number>();

function deriveType(file: string): string {
  if (file.endsWith('.html')) return 'html';
  const noExt = file.replace(/\.(md|json)$/, '');
  for (const prefix of TYPE_PREFIXES) {
    if (noExt === prefix || noExt.startsWith(prefix + '-')) return prefix;
  }
  return 'other';
}

function deriveTitle(body: string, file: string): string {
  if (file.endsWith('.html')) {
    const m = body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (m) return m[1].replace(/<[^>]+>/g, '').trim();
  } else {
    const m = body.match(/^#\s+(.+)$/m);
    if (m) return m[1].trim();
  }
  return file
    .replace(/\.(md|html|json)$/, '')
    .replace(/^[a-z]+-/, '')
    .replace(/-/g, ' ');
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Buffer.from(buf).toString('hex');
}

function contentType(file: string): string {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'text/markdown; charset=utf-8';
}

function indexEntry(doc: Doc): IndexEntry {
  const { body, ...rest } = doc;
  return rest;
}

function scanListItems(body: string): ListItem[] {
  const out: ListItem[] = [];
  for (const line of body.split('\n')) {
    const m = line.match(LIST_ITEM_RE);
    if (!m) continue;
    const number = m[2];
    const mark = m[3];
    out.push({
      text: m[4],
      kind: number ? 'numbered' : 'bullet',
      number: number ?? null,
      checked: mark === 'x' || mark === 'X' ? true : mark === ' ' ? false : null,
    });
  }
  return out;
}

function buildDashboard() {
  const prioritiesDoc = index.get(PRIORITIES_FILE);
  const priorities = prioritiesDoc
    ? scanListItems(prioritiesDoc.body).map((item) => ({ ...item, file: PRIORITIES_FILE }))
    : [];
  const docs = Array.from(index.values())
    .filter((d) => TODO_TYPES.has(d.type) && d.file !== PRIORITIES_FILE)
    .sort((a, b) => b.mtime - a.mtime);
  const todos: Array<{ text: string; file: string }> = [];
  for (const doc of docs) {
    for (const item of scanListItems(doc.body)) {
      if (item.checked === false) todos.push({ text: item.text, file: doc.file });
    }
  }
  return { priorities, todos };
}

function search(q: string): Array<{ file: string }> {
  const needle = q.toLowerCase().trim();
  if (!needle) return [];
  const hits: Array<{ file: string }> = [];
  for (const doc of index.values()) {
    if (
      doc.title.toLowerCase().includes(needle) ||
      doc.file.toLowerCase().includes(needle) ||
      doc.body.toLowerCase().includes(needle)
    ) {
      hits.push({ file: doc.file });
    }
  }
  return hits;
}

function isDirectChild(absPath: string): boolean {
  const rel = relative(DOCS_DIR, absPath);
  return rel.length > 0 && !rel.includes('/') && !rel.startsWith('.');
}

async function loadFile(absPath: string): Promise<Doc | null> {
  try {
    const s = await stat(absPath);
    if (!s.isFile()) return null;
    const file = basename(absPath);
    if (file.startsWith('.')) return null;
    if (!VALID_EXTS.has(extname(file).toLowerCase())) return null;
    const body = await readFile(absPath, 'utf8');
    return {
      file,
      type: deriveType(file),
      mtime: s.mtimeMs,
      hash: await sha256(body),
      title: deriveTitle(body, file),
      body,
    };
  } catch {
    return null;
  }
}

async function buildIndex() {
  index.clear();
  await mkdir(DOCS_DIR, { recursive: true });
  const entries = await readdir(DOCS_DIR);
  const docs = await Promise.all(entries.map((e) => loadFile(join(DOCS_DIR, e))));
  for (const doc of docs) {
    if (doc) index.set(doc.file, doc);
  }
  console.log(`[notebook] indexed ${index.size} docs from ${DOCS_DIR}`);
}

function broadcast(event: SseEvent) {
  for (const send of sseClients) {
    try { send(event); } catch {}
  }
}

async function onFsEvent(absPath: string, kind: 'add' | 'change' | 'remove') {
  if (!isDirectChild(absPath)) return;
  const file = basename(absPath);

  const lastWrite = recentWrites.get(file);
  if (lastWrite && Date.now() - lastWrite < ECHO_SUPPRESS_MS) return;

  if (kind === 'remove') {
    if (index.has(file)) {
      index.delete(file);
      broadcast({ kind: 'remove', file });
    }
    return;
  }

  const doc = await loadFile(absPath);
  if (!doc) return;
  const prev = index.get(file);
  if (prev && prev.hash === doc.hash) return;
  index.set(file, doc);
  broadcast({ kind, file: doc.file, type: doc.type, hash: doc.hash, mtime: doc.mtime, title: doc.title });
}

function setupWatcher() {
  const watcher = chokidar.watch(DOCS_DIR, {
    persistent: true,
    ignoreInitial: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
    ignored: (path: string) => basename(path).startsWith('.'),
  });
  watcher.on('add', (path) => onFsEvent(path, 'add'));
  watcher.on('change', (path) => onFsEvent(path, 'change'));
  watcher.on('unlink', (path) => onFsEvent(path, 'remove'));
  watcher.on('error', (err) => console.error('[notebook] watcher error:', err));
}

function safeFile(file: string): string | null {
  if (!file) return null;
  if (file.includes('/') || file.includes('\\') || file.includes('..') || file.startsWith('.')) return null;
  if (!VALID_EXTS.has(extname(file).toLowerCase())) return null;
  return join(DOCS_DIR, file);
}

async function atomicWrite(absPath: string, content: string) {
  const tmp = `${absPath}.tmp.${crypto.randomUUID()}`;
  await Bun.write(tmp, content);
  await rename(tmp, absPath);
  const file = basename(absPath);
  recentWrites.set(file, Date.now());
  setTimeout(() => recentWrites.delete(file), ECHO_SUPPRESS_MS * 2).unref?.();
}

async function writeAndIndex(file: string, abs: string, body: string, prev?: Doc): Promise<Doc> {
  await atomicWrite(abs, body);
  const [s, hash] = await Promise.all([stat(abs), sha256(body)]);
  const doc: Doc = {
    file,
    type: prev?.type ?? deriveType(file),
    mtime: s.mtimeMs,
    hash,
    title: deriveTitle(body, file),
    body,
  };
  index.set(file, doc);
  return doc;
}

// ---- Browser-bundle build (src/app.ts → /app.js) ----
let cachedAppJs: string | null = null;
let cachedAppError: string | null = null;

async function buildAppBundle() {
  const result = await Bun.build({
    entrypoints: [APP_ENTRY],
    target: 'browser',
    minify: true,
    sourcemap: 'inline',
  });
  if (!result.success || result.outputs.length === 0) {
    cachedAppError = result.logs.map((l) => String(l)).join('\n') || 'unknown build error';
    cachedAppJs = null;
    console.error('[notebook] app bundle build failed:\n' + cachedAppError);
    return;
  }
  cachedAppJs = await result.outputs[0].text();
  cachedAppError = null;
  console.log(`[notebook] bundled src/app.ts (${cachedAppJs.length} bytes)`);
}

function setupAppWatcher() {
  let pending: ReturnType<typeof setTimeout> | null = null;
  const trigger = () => {
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      buildAppBundle().catch((e) => console.error('[notebook] rebuild failed:', e));
    }, 80);
  };
  const watcher = chokidar.watch(SRC_DIR, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 30 },
  });
  watcher.on('add', trigger);
  watcher.on('change', trigger);
  watcher.on('unlink', trigger);
  watcher.on('error', (err) => console.error('[notebook] src watcher error:', err));
}

await buildAppBundle();
setupAppWatcher();
await buildIndex();
setupWatcher();

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (req.method === 'GET' && path === '/') {
      return new Response(Bun.file(HTML_PATH), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    if (req.method === 'GET' && path === '/app.js') {
      if (cachedAppJs) {
        return new Response(cachedAppJs, {
          headers: {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-cache',
          },
        });
      }
      return new Response(
        `// notebook: app bundle failed to build\nconsole.error(${JSON.stringify(cachedAppError ?? 'unknown error')});`,
        { status: 500, headers: { 'Content-Type': 'application/javascript; charset=utf-8' } },
      );
    }

    if (req.method === 'GET' && path === '/api/index') {
      const list = Array.from(index.values())
        .sort((a, b) => b.mtime - a.mtime)
        .map(indexEntry);
      return Response.json(list);
    }

    if (req.method === 'GET' && path === '/api/dashboard') {
      return Response.json(buildDashboard());
    }

    if (req.method === 'GET' && path === '/api/search') {
      return Response.json(search(url.searchParams.get('q') ?? ''));
    }

    if (req.method === 'GET' && path === '/api/events') {
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          const send = (event: SseEvent) => {
            try {
              controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
            } catch {}
          };
          controller.enqueue(enc.encode(`: connected\n\n`));
          sseClients.add(send);

          const keepalive = setInterval(() => {
            try { controller.enqueue(enc.encode(`: ping\n\n`)); } catch {}
          }, 30000);

          req.signal.addEventListener('abort', () => {
            clearInterval(keepalive);
            sseClients.delete(send);
            try { controller.close(); } catch {}
          });
        },
      });
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      });
    }

    const docMatch = path.match(/^\/api\/doc\/(.+)$/);
    if (docMatch) {
      const file = decodeURIComponent(docMatch[1]);
      const abs = safeFile(file);
      if (!abs) return new Response('bad path', { status: 400 });

      if (req.method === 'GET') {
        const doc = index.get(file);
        if (!doc) return new Response('not found', { status: 404 });
        return new Response(doc.body, {
          headers: { 'Content-Type': contentType(file), 'ETag': doc.hash },
        });
      }

      if (req.method === 'PUT') {
        const body = await req.text();
        const ifMatch = req.headers.get('If-Match');
        const current = index.get(file);
        if (!current) return new Response('not found', { status: 404 });
        if (ifMatch && ifMatch !== current.hash) {
          return Response.json({ hash: current.hash, body: current.body }, { status: 412 });
        }
        const updated = await writeAndIndex(file, abs, body, current);
        return Response.json({ hash: updated.hash, mtime: updated.mtime, title: updated.title });
      }

      if (req.method === 'DELETE') {
        const current = index.get(file);
        if (!current) return new Response('not found', { status: 404 });
        const archiveDir = join(DOCS_DIR, 'archive');
        await mkdir(archiveDir, { recursive: true });
        await Bun.write(join(archiveDir, file), current.body);
        await unlink(abs);
        recentWrites.set(file, Date.now());
        setTimeout(() => recentWrites.delete(file), ECHO_SUPPRESS_MS * 2).unref?.();
        index.delete(file);
        broadcast({ kind: 'remove', file });
        return new Response(null, { status: 204 });
      }

      return new Response('method not allowed', { status: 405 });
    }

    if (req.method === 'POST' && path === '/api/doc') {
      const payload = (await req.json()) as { file?: string; body?: string };
      const file = payload.file ?? '';
      const body = payload.body ?? '';
      const abs = safeFile(file);
      if (!abs) return new Response('bad path', { status: 400 });
      if (index.has(file)) return new Response('exists', { status: 409 });
      const doc = await writeAndIndex(file, abs, body);
      broadcast({ kind: 'add', file, type: doc.type, hash: doc.hash, mtime: doc.mtime, title: doc.title });
      return Response.json(doc, { status: 201 });
    }

    if (req.method === 'POST' && path === '/api/toggle-todo') {
      const payload = (await req.json()) as { file?: string; text?: string; checked?: boolean };
      const file = payload.file ?? '';
      const text = payload.text ?? '';
      const checked = payload.checked === true;
      const abs = safeFile(file);
      if (!abs) return new Response('bad path', { status: 400 });
      const current = index.get(file);
      if (!current) return new Response('not found', { status: 404 });
      const lines = current.body.split('\n');
      const newMark = checked ? 'x' : ' ';
      let toggled = false;
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(LIST_ITEM_RE);
        if (!m) continue;
        const lineMark = m[3];
        if (lineMark !== ' ' && lineMark !== 'x' && lineMark !== 'X') continue;
        if (m[4] !== text) continue;
        const isCheckedNow = lineMark === 'x' || lineMark === 'X';
        if (isCheckedNow === checked) continue;
        lines[i] = lines[i].replace(/\[[ xX]\]/, `[${newMark}]`);
        toggled = true;
        break;
      }
      if (!toggled) return new Response('todo not found', { status: 404 });
      const updated = await writeAndIndex(file, abs, lines.join('\n'), current);
      broadcast({ kind: 'change', file, type: updated.type, hash: updated.hash, mtime: updated.mtime, title: updated.title });
      return Response.json({ hash: updated.hash });
    }

    return new Response('not found', { status: 404 });
  },
});

console.log(`[notebook] http://localhost:${server.port}  docs: ${DOCS_DIR}`);
