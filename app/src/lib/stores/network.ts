// Browser network-connectivity status.
//
// Backed by `navigator.onLine`, which the OS toggles based on whether any
// network interface is up. Caveats:
//   - `true` means *some* interface is up. Does NOT prove internet reachability.
//   - `false` is reliable: when offline, definitely no internet.
//
// We deliberately do NOT actively probe a remote endpoint. The privacy pitch
// is "nothing leaves the browser". Issuing our own connectivity check would
// contradict that. The user toggling Wi-Fi off + this store flipping to false
// is the demonstration; the only thing we have to defend is "the app keeps
// routing while offline", which the rest of the system already does.

import { readable } from 'svelte/store';

const initial = typeof navigator !== 'undefined' ? navigator.onLine : true;

export const online = readable(initial, (set) => {
  if (typeof window === 'undefined') return;
  const on  = () => set(true);
  const off = () => set(false);
  window.addEventListener('online', on);
  window.addEventListener('offline', off);
  set(navigator.onLine);
  return () => {
    window.removeEventListener('online', on);
    window.removeEventListener('offline', off);
  };
});
