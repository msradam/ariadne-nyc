import { writable, get } from 'svelte/store';

export type PrivacyZone = 'Z1' | 'Z2' | 'Z3';

export type PrivacyEntry = {
  id: string;
  zone: PrivacyZone;
  url: string;
  description: string;
  timestamp: string;
};

function createPrivacyLog() {
  const { subscribe, update } = writable<PrivacyEntry[]>([]);

  function add(zone: PrivacyZone, url: string, description: string) {
    // Z1 is internal. A Z1 entry is a bug, but we record it so it's visible.
    const entry: PrivacyEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      zone,
      url,
      description,
      timestamp: new Date().toISOString(),
    };
    update((entries) => [...entries, entry]);
  }

  function z2(url: string, description: string) {
    add('Z2', url, description);
  }

  function z3(url: string, description: string) {
    add('Z3', url, description);
  }

  function getAll(): PrivacyEntry[] {
    return get({ subscribe });
  }

  return { subscribe, z2, z3, getAll };
}

export const privacyLog = createPrivacyLog();
