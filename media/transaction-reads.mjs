/** Explicit independent reads. A null slot preserves an optional undefined
 * result without issuing a read. Dependent lookups stay with their caller. */
export async function readTransactionRecords(tx, keys) {
  const requested = keys.filter(key => key !== null);
  const rows = typeof tx.getAll === 'function'
    ? await tx.getAll(requested) : await Promise.all(requested.map(key => tx.get(key)));
  let index = 0;
  return keys.map(key => key === null ? undefined : rows[index++]);
}
