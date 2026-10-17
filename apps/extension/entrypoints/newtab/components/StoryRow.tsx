import type { FeedItem } from "@homepage/agent-core";
import { relativeTime } from "../format";

/**
 * One story in Latest: a feed row, and the same row for a gift. `timeLabel`
 * overrides the clock (gifts show their age). `onDismiss` sits beside the row,
 * not inside it, so dismissing a gift does not open it.
 */
export function Row({
  item,
  now,
  inAmber,
  cursor,
  onFocus,
  onOpen,
  timeLabel,
  onDismiss,
  dismissing,
}: {
  item: FeedItem;
  now: number;
  inAmber: boolean;
  cursor: boolean;
  onFocus: () => void;
  onOpen: () => void;
  /** Shown in place of the feed's relative time. */
  timeLabel?: string;
  onDismiss?: () => void;
  dismissing?: boolean;
}) {
  const when = timeLabel ?? relativeTime(item.publishedAt, now);
  return (
    <li className={onDismiss ? "gift-item" : undefined}>
      <button
        id={`lrow-${item.id}`}
        type="button"
        className={`row${cursor ? " cursor" : ""}`}
        onFocus={onFocus}
        onClick={onOpen}
      >
        <span className="row-main">
          <span className="row-title">{item.title}</span>
          {item.summary && <span className="latest-blurb">{item.summary}</span>}
          <span className="row-meta">
            <span className="row-site">{item.source}</span>
            {item.author && <span>{item.author}</span>}
            {inAmber && (
              <span className="row-amber">
                <span className="row-amber-dot" aria-hidden="true" />
                In Amber
              </span>
            )}
          </span>
        </span>
        <span className="row-time" title={item.publishedAt ? new Date(item.publishedAt).toLocaleString() : undefined}>
          {when}
        </span>
      </button>
      {onDismiss && (
        <button
          type="button"
          className="ghost-btn small gift-dismiss"
          aria-label={`Dismiss ${item.title}`}
          disabled={dismissing}
          onClick={onDismiss}
        >
          Dismiss
        </button>
      )}
    </li>
  );
}
