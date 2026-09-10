const modules = import.meta.glob("./assets/empty-states/*.webp", {
  eager: true,
  import: "default",
}) as Record<string, string>;

export const EMPTY_STATE_ART: readonly string[] = Object.keys(modules)
  .sort()
  .map((key) => modules[key]);

let lastPicked: string | undefined;

/** Test isolation for the last-shown plate remembered across remounts. */
export function resetEmptyStateArtPick() {
  lastPicked = undefined;
}

/** Uniform pick from the bundled catalog. When `previous` is given and there is
 *  more than one plate, the previous URL is excluded so a remount does not
 *  repeat the image still on screen. With no argument, the last pick is treated
 *  as previous so tabbing away and back is less likely to repeat. */
export function pickEmptyStateArt(previous?: string, catalog: readonly string[] = EMPTY_STATE_ART): string {
  if (catalog.length === 0) {
    throw new Error("empty-state art catalog is empty");
  }
  const avoid = previous !== undefined ? previous : lastPicked;
  const pool = avoid && catalog.length > 1 ? catalog.filter((url) => url !== avoid) : catalog;
  const next = pool[Math.floor(Math.random() * pool.length)];
  lastPicked = next;
  return next;
}
