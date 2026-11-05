// A tiny observable store + Preact hook. Components subscribe with a selector and only
// re-render when the selected value changes (Object.is).
import { useEffect, useReducer, useRef } from 'preact/hooks';

export function createStore(initial) {
  let state = initial;
  const subs = new Set();
  return {
    get: () => state,
    set(patch) {
      const next = typeof patch === 'function' ? patch(state) : { ...state, ...patch };
      if (next === state) return;
      state = next;
      for (const fn of [...subs]) fn(state);
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export function useStore(store, selector = (s) => s) {
  const [, force] = useReducer((x) => x + 1, 0);
  const sel = useRef(selector);
  sel.current = selector;
  const value = store ? selector(store.get()) : undefined;
  const last = useRef(value);
  last.current = value;
  useEffect(() => {
    if (!store) return undefined;
    const check = (s) => {
      const v = sel.current(s);
      if (!Object.is(v, last.current)) {
        last.current = v;
        force();
      }
    };
    check(store.get());
    return store.subscribe(check);
  }, [store]);
  return value;
}

export function loadPref(key, fallback) {
  try {
    const v = localStorage.getItem(`ce.${key}`);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
export function savePref(key, value) {
  try { localStorage.setItem(`ce.${key}`, JSON.stringify(value)); } catch { /* storage unavailable */ }
}
