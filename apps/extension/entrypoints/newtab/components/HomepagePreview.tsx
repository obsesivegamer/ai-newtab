import { Component, type ReactNode } from "react";
import { SandpackLayout, SandpackPreview, SandpackProvider } from "@codesandbox/sandpack-react";
import { canShowHomepagePreview } from "./homepagePreviewGate";

const INDEX_JS = `import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);`;

const INDEX_HTML = `<!DOCTYPE html>
<html><head><title>My Personalized Homepage</title>
<style>html,body{margin:0;padding:0}</style></head>
<body><div id="root"></div></body></html>`;

/**
 * Sandpack calls `crypto.subtle` inside its frame, which only exists in a secure
 * context. Callers still check before mounting this; this refuses too, so a plain
 * HTTP page cannot mount a blank frame.
 */
export class HomepagePreviewBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render() {
    if (this.state.failed) {
      return (
        <div className="gate" role="alert">
          <p className="gate-body">The preview hit an error on this page.</p>
        </div>
      );
    }
    return this.props.children;
  }
}

/**
 * Renders the agent's component in a Sandpack iframe. The code is
 * model-generated, so it runs sandboxed rather than in the extension's own page.
 */
export function HomepagePreview({ code }: { code: string }) {
  if (!canShowHomepagePreview()) return null;

  const files = {
    "/App.js": { code },
    "/index.js": { code: INDEX_JS },
    "/public/index.html": { code: INDEX_HTML },
  };

  return (
    <HomepagePreviewBoundary>
      <SandpackProvider files={files} template="react" options={{ autorun: true }}>
        <SandpackLayout style={{ height: "100vh", width: "100vw", border: 0, borderRadius: 0 }}>
          <SandpackPreview style={{ height: "100%" }} showOpenInCodeSandbox={false} showRefreshButton={false} />
        </SandpackLayout>
      </SandpackProvider>
    </HomepagePreviewBoundary>
  );
}
