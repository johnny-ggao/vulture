export type BrandedId<T extends string> = string & { readonly __brand: T };

export function brandId<T extends BrandedId<string>>(value: string): T {
  if (value.length === 0) {
    throw new Error("id must not be empty");
  }
  return value as T;
}
