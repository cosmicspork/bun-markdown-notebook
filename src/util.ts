export type DocMeta = {
  file: string;
  type: string;
  mtime: number;
  hash: string;
  title: string;
  body?: string;
};

export type DashboardData = {
  priorities: Array<{
    text: string;
    kind: 'bullet' | 'numbered';
    number: string | null;
    checked: boolean | null;
    file: string;
  }>;
  todos: Array<{ text: string; file: string }>;
};

export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export const DASHBOARD = '__dashboard';

export const TYPE_GROUPS = [
  { type: 'note', label: 'Notes' },
  { type: 'repo', label: 'Repos' },
  { type: 'meeting', label: 'Meetings' },
  { type: 'inbox', label: 'Inbox' },
  { type: 'proposal', label: 'Proposals' },
  { type: 'plan', label: 'Plans' },
  { type: 'guide', label: 'Guides' },
  { type: 'ref', label: 'Reference' },
  { type: 'architecture', label: 'Architecture' },
  { type: 'html', label: 'HTML docs' },
  { type: 'other', label: 'Other' },
];

export function titleOf(doc: DocMeta): string {
  return doc.title || doc.file;
}

export function relativeTime(ms: number): string {
  const days = Math.round((Date.now() - ms) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return days + 'd ago';
  if (days < 30) return Math.floor(days / 7) + 'w ago';
  return Math.floor(days / 30) + 'mo ago';
}

export function shortTime(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ago';
}
