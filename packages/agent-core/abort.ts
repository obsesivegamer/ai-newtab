/**
 * A signal that aborts when any of `signals` does. Uses `AbortSignal.any` where it
 * exists; Safari before 17.4 (iPhone) has no such method, so a controller is wired
 * to each signal instead and every listener is removed as soon as one of them fires.
 * Every caller includes an `AbortSignal.timeout`, which fires on its own schedule,
 * so a listener is never held longer than that timeout.
 */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const controller = new AbortController();
  const detach: Array<() => void> = [];
  const fire = (reason: unknown) => {
    for (const off of detach) off();
    controller.abort(reason);
  };
  for (const signal of signals) {
    if (signal.aborted) {
      fire(signal.reason);
      break;
    }
    const onAbort = () => fire(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    detach.push(() => signal.removeEventListener("abort", onAbort));
  }
  return controller.signal;
}
