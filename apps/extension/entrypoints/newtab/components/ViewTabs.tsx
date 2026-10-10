export type View = "library" | "today";

const TABS: Array<{ id: View; label: string }> = [
  { id: "library", label: "Library" },
  { id: "today", label: "Today" },
];

export function ViewTabs({
  view,
  onChange,
  todayBusy,
}: {
  view: View;
  onChange: (view: View) => void;
  /** A homepage build is running in the background. */
  todayBusy: boolean;
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
          {tab.id === "today" && todayBusy && <span className="tab-dot" title="Building" />}
        </button>
      ))}
    </nav>
  );
}
