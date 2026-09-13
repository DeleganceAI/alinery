/** Hosted `price` is a 0–5 UI band. Anything else hides the ticks. */
export function costBand(price: unknown): number | null {
  return typeof price === "number" && Number.isInteger(price) && price >= 0 && price <= 5 ? price : null;
}
