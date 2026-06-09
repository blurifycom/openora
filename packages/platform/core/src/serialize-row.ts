/**
 * SerializedRow - `T` with the `StringifiedK` keys widened to `string` (the
 * shape after Date/Decimal fields are converted for the wire).
 */
export type SerializedRow<
  T extends Record<string, unknown>,
  StringifiedK extends keyof T = never,
> = Omit<T, StringifiedK> & { [P in StringifiedK]: string };

export interface SerializeRowOptions<
  T extends Record<string, unknown>,
  DK extends keyof T,
  CK extends keyof T,
> {
  dateFields?: readonly DK[];
  decimalFields?: readonly CK[];
}

/**
 * serializeRow - shallow-clones a DB row, converting Date fields via
 * `.toISOString()` and Decimal/numeric object fields via `String(...)`. Pure;
 * never mutates the original row. The `dateFields`/`decimalFields` keys are
 * inferred from the passed arrays, so the return type widens exactly those keys
 * to `string` - no cast needed at the call site:
 *
 *   serializeRow(row, { dateFields: ['createdAt'], decimalFields: ['amount'] })
 *   // -> Omit<Row,'createdAt'|'amount'> & { createdAt: string; amount: string }
 */
export function serializeRow<
  T extends Record<string, unknown>,
  DK extends keyof T = never,
  CK extends keyof T = never,
>(row: T, opts: SerializeRowOptions<T, DK, CK> = {}): SerializedRow<T, DK | CK> {
  const { dateFields = [], decimalFields = [] } = opts;
  const result: Record<string, unknown> = { ...row };

  for (const key of dateFields) {
    const val = result[key as string];
    if (val instanceof Date) result[key as string] = val.toISOString();
  }

  for (const key of decimalFields) {
    const val = result[key as string];
    if (val !== null && val !== undefined) result[key as string] = String(val);
  }

  return result as SerializedRow<T, DK | CK>;
}
