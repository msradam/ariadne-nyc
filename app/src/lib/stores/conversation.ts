import { writable } from 'svelte/store';
import type { RouteStep } from '../directions';

export type MsgRole = 'user' | 'bot' | 'sys' | 'tool' | 'steps' | 'card';

export type AlsoNearbyEntry = {
  name: string;
  address: string;
  walkMin: number;
  types: string[];
};

export type RouteCard =
  | {
      kind: 'route';
      destName: string;
      destAddress: string;
      destTypes: string[];
      totalMin: number;
      distM: number;
      profile: string;
      hasTransit: boolean;
    }
  | {
      kind: 'reachable';
      destName: string;
      destAddress: string;
      destTypes: string[];
      totalMin: number;
      profile: string;
      origin: string;
      count: number;
      maxMinutes: number;
      budgetExplicit: boolean;
      alsoNearby: AlsoNearbyEntry[];
    };

export type ChatMsg =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'bot'; text: string; streaming: boolean }
  | { id: string; role: 'sys'; text: string }
  | { id: string; role: 'tool'; name: string; args: unknown; result?: unknown }
  | { id: string; role: 'steps'; steps: RouteStep[] }
  | { id: string; role: 'card'; card: RouteCard };

function uid() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function createConversationStore() {
  const { subscribe, update, set } = writable<ChatMsg[]>([]);

  function addUser(text: string): string {
    const id = uid();
    update((msgs) => [...msgs, { id, role: 'user', text }]);
    return id;
  }

  function addSys(text: string): string {
    const id = uid();
    update((msgs) => [...msgs, { id, role: 'sys', text }]);
    return id;
  }

  function addBot(initial = ''): { id: string; update: (text: string) => void } {
    const id = uid();
    update((msgs) => [...msgs, { id, role: 'bot', text: initial, streaming: true }]);
    return {
      id,
      update: (text: string) =>
        update((msgs) =>
          msgs.map((m) => (m.id === id && m.role === 'bot' ? { ...m, text } : m))
        ),
    };
  }

  function finishBot(id: string, text: string) {
    update((msgs) =>
      msgs.map((m) => (m.id === id && m.role === 'bot' ? { ...m, text, streaming: false } : m))
    );
  }

  function addTool(name: string, args: unknown): { id: string; setResult: (result: unknown) => void } {
    const id = uid();
    update((msgs) => [...msgs, { id, role: 'tool', name, args }]);
    return {
      id,
      setResult: (result: unknown) =>
        update((msgs) =>
          msgs.map((m) => (m.id === id && m.role === 'tool' ? { ...m, result } : m))
        ),
    };
  }

  function addSteps(steps: RouteStep[]): string {
    const id = uid();
    update((msgs) => [...msgs, { id, role: 'steps', steps }]);
    return id;
  }

  function addCard(card: RouteCard): string {
    const id = uid();
    update((msgs) => [...msgs, { id, role: 'card', card }]);
    return id;
  }

  function clear() {
    set([]);
  }

  return { subscribe, addUser, addSys, addBot, finishBot, addTool, addSteps, addCard, clear };
}

export const conversation = createConversationStore();
