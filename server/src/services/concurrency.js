/**
 * A tiny promise-queue concurrency limiter. Avoids pulling in an external
 * package (several popular ones are ESM-only in ways that fight CJS/ESM
 * interop) for what is a ~15 line primitive.
 *
 * Usage:
 *   const limit = createLimiter(3);
 *   await Promise.all(items.map((item) => limit(() => process(item))));
 */
export function createLimiter(concurrency) {
  const max = Math.max(1, concurrency | 0);
  let active = 0;
  const queue = [];

  const runNext = () => {
    if (active >= max || queue.length === 0) return;
    active += 1;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        runNext();
      });
  };

  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      runNext();
    });
  };
}
