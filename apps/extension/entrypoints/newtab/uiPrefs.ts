import { useCallback, useEffect, useRef, useState } from "react";

/**
 * View preferences for the new tab (theme, reader text size). They live under
 * their own keys in chrome.storage.local, apart from the build settings in
 * lib/storage.ts.
 */
const KEYS = {
  theme: "ui.theme",
  textSize: "ui.readerTextSize",
} as const;

export type Theme = "dark" | "light";

/** localStorage mirror of the theme so the first paint is already the right one. */
const THEME_MIRROR = "ui.theme";

function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
}

/** Call before React renders, so a light-theme user never sees a dark flash. */
export function applyStoredTheme() {
  let theme: Theme = "dark";
  try {
    if (localStorage.getItem(THEME_MIRROR) === "light") theme = "light";
  } catch {
    /* storage can be blocked; dark is the default */
  }
  applyTheme(theme);
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(
    () => (document.documentElement.dataset.theme === "light" ? "light" : "dark"),
  );

  useEffect(() => {
    void browser.storage.local.get(KEYS.theme).then((r) => {
      const stored = r[KEYS.theme];
      if (stored === "light" || stored === "dark") {
        setTheme(stored);
        applyTheme(stored);
      }
    });
  }, []);

  const toggle = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === "dark" ? "light" : "dark";
      applyTheme(next);
      try {
        localStorage.setItem(THEME_MIRROR, next);
      } catch {
        /* ignore */
      }
      void browser.storage.local.set({ [KEYS.theme]: next });
      return next;
    });
  }, []);

  return { theme, toggle };
}

/** Reader body sizes in px. The default sits at 20, the brief's 19-20px. */
export const TEXT_SIZES = [16, 18, 20, 22, 24, 27] as const;
const DEFAULT_SIZE_INDEX = 2;

function validSizeIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < TEXT_SIZES.length;
}

function readSizeMirror(): number | null {
  try {
    const raw = localStorage.getItem(KEYS.textSize);
    const parsed = raw === null ? NaN : Number(raw);
    return validSizeIndex(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeSizeMirror(index: number) {
  try {
    localStorage.setItem(KEYS.textSize, String(index));
  } catch {
    /* ignore */
  }
}

export function useTextSize() {
  // Read synchronously from the localStorage mirror so the Reader opens at the right size.
  const [index, setIndex] = useState(() => readSizeMirror() ?? DEFAULT_SIZE_INDEX);
  const touched = useRef(false);

  useEffect(() => {
    void browser.storage.local.get(KEYS.textSize).then((r) => {
      const stored = r[KEYS.textSize];
      // A click that landed before this read finished wins.
      if (touched.current || !validSizeIndex(stored)) return;
      setIndex(stored);
      writeSizeMirror(stored);
    });
  }, []);

  const step = useCallback((delta: number) => {
    touched.current = true;
    setIndex((current) => {
      const next = Math.min(TEXT_SIZES.length - 1, Math.max(0, current + delta));
      if (next !== current) {
        writeSizeMirror(next);
        void browser.storage.local.set({ [KEYS.textSize]: next });
      }
      return next;
    });
  }, []);

  return {
    size: TEXT_SIZES[index],
    canShrink: index > 0,
    canGrow: index < TEXT_SIZES.length - 1,
    shrink: () => step(-1),
    grow: () => step(1),
  };
}
