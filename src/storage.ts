// Choices remembered per browser (and site), like whether the editor is on.

/**
 * A choice kept in localStorage, read each time, so a change in another tab
 * counts too. Without storage, or without a key, it lasts until the page is left.
 */
export function storedChoice<T extends string>(key: string | null, fallback: T, allowed: readonly T[]) {
  let current: T = fallback;
  return {
    get(): T {
      if (key === null) {
        return current;
      }
      try {
        const stored = localStorage.getItem(key) as T | null;
        if (stored !== null && allowed.includes(stored)) {
          current = stored;
        }
      } catch {
        // Storage may be blocked; the last choice of this page applies.
      }
      return current;
    },
    set(value: T): void {
      current = value;
      if (key === null) {
        return;
      }
      try {
        localStorage.setItem(key, value);
      } catch {
        // The choice lasts until the page is left.
      }
    },
  };
}
