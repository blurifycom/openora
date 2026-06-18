export type SerializedRow<
  T extends Record<string, unknown>,
  StringifiedK extends keyof T = never,
> = Omit<T, StringifiedK> & { [P in StringifiedK]: string };

export type SerializeRowOptions<
  T extends Record<string, unknown>,
  DK extends keyof T,
  CK extends keyof T,
> = {
  dateFields?: readonly DK[];
  decimalFields?: readonly CK[];
};

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
