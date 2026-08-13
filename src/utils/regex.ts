/** Escape user-controlled text before using it in a MongoDB/JavaScript RegExp. */
export function escapeRegex(input: string) {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
