export type View = "latest" | "library" | "today";

const TABS: Array<{ id: View; label: string }> = [
  { id: "latest", label: "Latest" },
  { id: "library", label: "Library" },
  { id: "today", label: "Today" },
];

export function ViewTabs({
  view,
  onChange,
  todayBusy,
  todayError,
}: {
  view: View;
  onChange: (view: View) => void;
  /** A homepage build is running in the background. */
  todayBusy: boolean;
  /** The last build failed and the user hasn't dismissed it. */
  todayError: boolean;
}) {
  return (
    <nav className="tabs" aria-label="View">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={`tab${view === tab.id ? " active" : ""}`}
          aria-current={view === tab.id ? "page" : undefined}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.id === "today" && todayError && (
            <span className="tab-dot error" title="The last build failed" role="img" aria-label="The last build failed" />
          )}
          {tab.id === "today" && !todayError && todayBusy && (
            <span className="tab-dot" title="Building" role="img" aria-label="Building" />
          )}
        </button>
      ))}
    </nav>
  );
}
