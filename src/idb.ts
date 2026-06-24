// IndexedDB draft buffer — keeps unsaved editor text per file so an in-flight
// edit survives a page reload (keyed to the doc's base hash so a stale draft
// against a changed file is discarded rather than restored).
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

export type Draft = { file: string; body: string; baseHash: string; savedAt: number };

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

export async function persistDraft(file: string, body: string, baseHash: string) {
  try {
    await dbOp('readwrite', (s) => s.put({ file, body, baseHash, savedAt: Date.now() } as Draft));
  } catch {}
}

export async function clearDraft(file: string) {
  try {
    await dbOp('readwrite', (s) => s.delete(file));
  } catch {}
}

export async function loadDraft(file: string): Promise<Draft | null> {
  try {
    return ((await dbOp<Draft>('readonly', (s) => s.get(file))) ?? null) as Draft | null;
  } catch {
    return null;
  }
}
