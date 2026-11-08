// A small FIFO limiter for work that is independent but should not all run at
// once: limit(fn) runs fn as soon as fewer than `max` are running, and settles
// the way fn does. A finishing call hands its slot straight to the next one
// waiting, so a newcomer can never slip in and take the count past `max`.
export function createLimiter(max) {
  let active = 0;
  const waiting = [];
  return async function limit(fn) {
    if (active < max) active++;
    else await new Promise((resolve) => waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}
