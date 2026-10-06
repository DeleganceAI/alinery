/**
 * jsdom lays nothing out: every element is 0 tall, so a chat pane never needs scrolling, always asks
 * for older rows, and a `scrollTop` write is invisible. This gives elements a scrollable size and
 * records each `scrollTop` assignment (reads return the last one). Call `restore` when done.
 */
export function stubScrollSize({ scrollHeight = 2000, clientHeight = 400 } = {}) {
  const writes: number[] = [];
  const tops = new WeakMap<Element, number>();
  const names = ["scrollHeight", "clientHeight", "scrollTop"] as const;
  const saved = names.map((name) => [name, Object.getOwnPropertyDescriptor(Element.prototype, name)] as const);
  Object.defineProperty(Element.prototype, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(Element.prototype, "clientHeight", { configurable: true, get: () => clientHeight });
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get(this: Element) {
      return tops.get(this) ?? 0;
    },
    set(this: Element, value: number) {
      writes.push(value);
      tops.set(this, value);
    },
  });
  return {
    writes,
    restore() {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(Element.prototype, name, descriptor);
        else delete (Element.prototype as unknown as Record<string, unknown>)[name];
      }
    },
  };
}
