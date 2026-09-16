/** Case-insensitive search shared by the library screens. */
export function matchesQuery(query: string, ...fields: string[]) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return fields.some((field) => field.toLowerCase().includes(needle));
}
