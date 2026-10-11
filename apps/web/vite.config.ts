import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const extension = (p: string) => here(`../extension/${p}`);

/**
 * The web build of the new-tab UI. It imports the extension's own components, hooks and
 * styles (so Latest, Library, Reader look and behave the same) and swaps only what must
 * differ: `@/lib/platform` (says IS_WEB) and `@/lib/browser-capture` (no extension windows).
 * Served by Amber under /app/, hence `base`.
 */
export default defineConfig({
  base: "/app/",
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@\/lib\/platform$/, replacement: here("src/platform.ts") },
      { find: /^@\/lib\/browser-capture$/, replacement: here("src/shims/browser-capture.ts") },
      { find: /^@\//, replacement: `${extension("")}` },
      { find: /^@newtab\//, replacement: `${extension("entrypoints/newtab")}/` },
    ],
    dedupe: ["react", "react-dom"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 2500,
  },
  server: { fs: { allow: [here("../..")] } },
});
