import { useState } from "react";

export function ApiKeySetup({ onSave }: { onSave: (key: string) => void }) {
  const [value, setValue] = useState("");
  const valid = value.trim().startsWith("sk-ant-");

  return (
    <form
      className="gate"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSave(value.trim());
      }}
    >
      <div className="meta gate-eyebrow">Setup</div>
      <h1 className="gate-title">Connect your Anthropic API key</h1>
      <p className="gate-body">
        The agent runs inside this extension and talks to the Anthropic API directly. Your key is
        stored in <code>chrome.storage.local</code> on this machine and is never sent anywhere
        else.
      </p>
      <input
        type="password"
        className="field mono"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="sk-ant-..."
        aria-label="Anthropic API key"
        autoComplete="off"
        spellCheck={false}
      />
      <div className="gate-actions">
        <button type="submit" className="solid-btn" disabled={!valid}>
          Save key
        </button>
      </div>
    </form>
  );
}
