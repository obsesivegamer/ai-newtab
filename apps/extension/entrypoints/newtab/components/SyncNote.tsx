import { useEffect } from "react";

/** A short, non-blocking line (it never takes a tap) that clears itself, used when the sources list was updated from another device. */
export function SyncNote({ message, onDone }: { message: string | null; onDone: () => void }) {
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(onDone, 5_000);
    return () => clearTimeout(timer);
  }, [message, onDone]);
  if (!message) return null;
  return (
    <div className="sync-note" role="status">
      {message}
    </div>
  );
}
