import type { DashboardData, DocMeta } from './util.ts';

export async function getIndex(): Promise<DocMeta[]> {
  const res = await fetch('/api/index');
  if (!res.ok) throw new Error('index failed: ' + res.status);
  return (await res.json()) as DocMeta[];
}

export async function getDoc(file: string): Promise<string> {
  const res = await fetch('/api/doc/' + encodeURIComponent(file));
  if (!res.ok) throw new Error('load failed: ' + res.status);
  return await res.text();
}

export type PutResult =
  | { ok: true; hash: string; mtime: number; title: string }
  | { ok: false; conflict: true; hash: string; body: string };

export async function putDoc(file: string, body: string, hash: string): Promise<PutResult> {
  const res = await fetch('/api/doc/' + encodeURIComponent(file), {
    method: 'PUT',
    headers: { 'Content-Type': 'text/markdown', 'If-Match': hash },
    body,
  });
  if (res.status === 412) {
    const payload = await res.json();
    return { ok: false, conflict: true, hash: payload.hash, body: payload.body };
  }
  if (!res.ok) throw new Error('save failed: ' + res.status);
  const payload = await res.json();
  return { ok: true, hash: payload.hash, mtime: payload.mtime, title: payload.title };
}

export async function getDashboard(): Promise<DashboardData> {
  const res = await fetch('/api/dashboard');
  if (!res.ok) throw new Error('dashboard failed: ' + res.status);
  return (await res.json()) as DashboardData;
}

export async function search(q: string): Promise<Array<{ file: string }>> {
  const res = await fetch('/api/search?q=' + encodeURIComponent(q));
  if (!res.ok) return [];
  return (await res.json()) as Array<{ file: string }>;
}

export async function toggleTodo(file: string, text: string, checked: boolean): Promise<void> {
  const res = await fetch('/api/toggle-todo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ file, text, checked }),
  });
  if (!res.ok) throw new Error('toggle failed: ' + res.status);
}
