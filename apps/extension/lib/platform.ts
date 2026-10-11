/**
 * Which build of the UI this is. The extension is the full product; `apps/web`
 * swaps this module (a Vite alias) for one that says `IS_WEB = true`, so the
 * shared new-tab code can leave out what needs the extension's own browser:
 * "Capture with my browser", and the Reader's bottom prev/next dock is phone-only.
 */
export const IS_WEB = false;
