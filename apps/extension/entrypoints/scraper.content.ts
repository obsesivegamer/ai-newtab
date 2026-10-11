/**
 * Injected on demand by lib/scraper.ts and lib/browser-capture.ts (never
 * auto-registered). Scrolls the page to trigger lazy-loaded content, then returns
 * its title and body HTML. When lib/browser-capture.ts has set `__rawDocument` in
 * this isolated world first, it returns the document's untouched outerHTML instead
 * (attributes, scripts and all), which is what Amber's extractor needs; that copy
 * is capped at 12 MB and never truncated: a larger page comes back with
 * `tooBig` and no html.
 */
const MAX_RAW_CHARS = 12 * 1024 * 1024;
export default defineContentScript({
  registration: "runtime",
  main() {
    // Function to scroll the page
    const scrollPage = async () => {
      const scrollHeight = document.documentElement.scrollHeight;
      const viewportHeight = window.innerHeight;
      const scrollDistance = viewportHeight * 0.8; // Scroll 80% of viewport height each time
      let currentPosition = 0;

      // Scroll down the page in increments
      while (currentPosition < scrollHeight) {
        window.scrollTo(0, currentPosition);
        currentPosition += scrollDistance;

        // Wait for content to load (adjust delay as needed)
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      // Scroll to the very bottom
      window.scrollTo(0, scrollHeight);
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Back to the top
      window.scrollTo(0, 0);
      await new Promise((resolve) => setTimeout(resolve, 200));
    };

    const convertPageToHTML = async () => {
      // Scroll the page first to trigger lazy-loaded content
      await scrollPage();

      if ((globalThis as { __rawDocument?: boolean }).__rawDocument) {
        const html = document.documentElement.outerHTML;
        const tooBig = html.length > MAX_RAW_CHARS;
        return { url: location.href, title: document.title, html: tooBig ? "" : html, tooBig };
      }

      // Return raw HTML and title after scrolling
      return {
        url: location.href,
        title: document.title,
        html: document.body.innerHTML,
      };
    };

    // executeScript resolves with this value
    return convertPageToHTML();
  },
});
