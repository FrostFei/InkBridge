import { useEffect, useState } from 'react';

let ready = false;
let refresh = false;
const listeners = new Set<() => void>();
const announce = () => listeners.forEach((listener) => listener());
let registration: ServiceWorkerRegistration | undefined;
let reloadRequested = false;
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  // Other tabs keep their editor open when this tab activates an update.
  // Only the tab whose user explicitly saved and requested refresh may reload.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    ready = true;
    announce();
    if (reloadRequested) window.location.reload();
  });
  void navigator.serviceWorker
    .register('/sw.js')
    .then((reg) => {
      registration = reg;
      if (reg.waiting && navigator.serviceWorker.controller) {
        refresh = true;
        announce();
      }
      reg.addEventListener('updatefound', () => {
        const worker = reg.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            refresh = true;
            announce();
          }
        });
      });
      const check = () => {
        if (navigator.onLine) void reg.update().catch(() => {});
      };
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
      return navigator.serviceWorker.ready;
    })
    .then(() => {
      ready = true;
      announce();
    })
    .catch(() => {
      ready = false;
      announce();
    });
}

export function useAppUpdate() {
  const [state, setState] = useState({ offlineReady: ready, needRefresh: refresh });
  useEffect(() => {
    const listener = () => setState({ offlineReady: ready, needRefresh: refresh });
    listeners.add(listener);
    listener();
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return {
    ...state,
    update: async () => {
      if (!registration?.waiting) {
        window.location.reload();
        return;
      }
      reloadRequested = true;
      registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    },
  };
}
