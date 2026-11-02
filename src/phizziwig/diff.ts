/** The smallest single change that turns one text into another. */
export function minimalChange(old: string, next: string): { from: number; to: number; insert: string } {
  let start = 0;
  while (start < old.length && start < next.length && old[start] === next[start]) {
    start++;
  }
  let end = 0;
  while (
    end < old.length - start &&
    end < next.length - start &&
    old[old.length - 1 - end] === next[next.length - 1 - end]
  ) {
    end++;
  }
  return { from: start, to: old.length - end, insert: next.slice(start, next.length - end) };
}
