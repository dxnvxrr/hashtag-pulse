// Per-browser conveniences only (settings, offline progress). Every access is guarded: storage can be blocked.

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
  },
};
