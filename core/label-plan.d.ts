/** Etiket planı. Web testi yalnızca `createLabel` ile varsayılan sözleşmesini karşılaştırır. */
export function createLabel(
  labels: object[],
  options?: { kind?: string; text?: string },
): {
  id: string;
  kind: string;
  text: string;
  x: number;
  y: number;
  size: number;
  color: string;
  start: number | null;
  end: number | null;
};
