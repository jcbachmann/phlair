/**
 * A map of what was worked out before, of a limited size: past its capacity,
 * the entry used longest ago goes (a Map keeps the order entries were set in,
 * so an entry that is read is set again).
 */
export class LruCache<K, V> {
  private readonly entries = new Map<K, V>();

  constructor(
    /** How many entries it keeps; a smaller one takes effect with the next entry. */
    public capacity: number,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  has(key: K): boolean {
    return this.entries.has(key);
  }

  get(key: K): V | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  delete(key: K): void {
    this.entries.delete(key);
  }
}
