/**
 * Provably-fair crash multiplier computation.
 *
 * A real implementation uses HMAC-SHA256 over the combined seeds.
 * This stub uses a simple deterministic hash to illustrate the concept
 * without pulling in a crypto dependency.
 *
 * The formula:
 *   1. Combine serverSeed + clientSeed into one string.
 *   2. Derive a 32-bit unsigned integer via a polynomial hash.
 *   3. Map that integer into the range [1.00, 100.00].
 *
 * Players can verify fairness by hashing the seeds themselves after the
 * round ends and confirming the multiplier matches.
 */
export function computeCrashMultiplier(serverSeed: string, clientSeed: string): number {
  const combined = serverSeed + clientSeed;
  let hash = 0;
  for (let i = 0; i < combined.length; i++) {
    hash = (hash * 31 + combined.charCodeAt(i)) >>> 0;
  }
  // Map to [1.00, 100.00] with two decimal places of precision
  return Math.max(1.0, (hash % 10000) / 100);
}
