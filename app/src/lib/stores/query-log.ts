import { writable } from 'svelte/store';
import type { RouteCard } from './conversation';
import type { RouteStep } from '../directions';

export type QueryRecord = {
  botText: string;
  streaming: boolean;
  card: RouteCard | null;
  steps: RouteStep[];
  toolSummary: string | null;
};

export type QueryEntry = {
  id: string;
  num: number;
  time: string;
  text: string;
  status: 'pending' | 'active' | 'answered' | 'error';
  record: QueryRecord;
};

function uid() { return `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }

function createQueryLog() {
  const { subscribe, update } = writable<QueryEntry[]>([]);

  function addEntry(text: string): string {
    const id = uid();
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    update(entries => {
      // Mark previous active as answered
      const updated = entries.map(e => e.status === 'active' ? { ...e, status: 'answered' as const } : e);
      const num = entries.length + 1;
      return [...updated, { id, num, time, text, status: 'active', record: { botText: '', streaming: false, card: null, steps: [], toolSummary: null } }];
    });
    return id;
  }

  function updateRecord(id: string, patch: Partial<QueryRecord>) {
    update(entries => entries.map(e => e.id === id ? { ...e, record: { ...e.record, ...patch } } : e));
  }

  function finishEntry(id: string) {
    update(entries => entries.map(e => e.id === id ? { ...e, status: 'answered' as const } : e));
  }

  function errorEntry(id: string) {
    update(entries => entries.map(e => e.id === id ? { ...e, status: 'error' as const } : e));
  }

  function clear() { update(() => []); }

  return { subscribe, addEntry, updateRecord, finishEntry, errorEntry, clear };
}

export const queryLog = createQueryLog();

// Shared query input value, written by SearchBar and read by the page submit handler.
export const queryInput = writable('');
// The submit handler. Set by +page.svelte
export const querySubmitFn = writable<((q: string) => Promise<void>) | null>(null);
export const queryBusy = writable(false);
