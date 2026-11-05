/**
 * Sandpack's frame calls `crypto.subtle.digest`. That API exists only in a
 * secure context, so a page served over plain HTTP mounts a blank frame.
 */
export function canShowHomepagePreview(
  scope: { isSecureContext?: boolean; crypto?: { subtle?: unknown } } = window,
): boolean {
  return scope.isSecureContext === true && scope.crypto?.subtle != null;
}
