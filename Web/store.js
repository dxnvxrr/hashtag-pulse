// Per-browser conveniences only (settings, offline progress). Every access is guarded: storage can be blocked.

let mirror = null;

export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem('omt.' + key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem('omt.' + key, JSON.stringify(value));
    } catch {
      /* storage blocked: the game still works, it just forgets */
    }
    mirror?.('omt.' + key, JSON.stringify(value));
  },
  /** The app keeps a native copy of every write (iOS may clear web storage; see native.js). */
  mirrorTo(fn) {
    mirror = fn;
  },
};
