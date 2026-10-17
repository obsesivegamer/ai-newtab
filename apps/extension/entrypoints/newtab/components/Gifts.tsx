import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isBlocked, type ArchiveArticleMeta, type FeedItem } from "@homepage/agent-core";
import { createArchiveBridge, type GiftCandidate } from "@/lib/archive";
import { dismissCandidate } from "@/lib/archive-save";
import { ageLabel } from "../format";
import { articleKey, entryFromCandidate, type ReaderEntry } from "../readerEntry";
import { Row } from "./StoryRow";

const HIDDEN_STATUS = new Set(["expired", "dismissed"]);

function articleUrl(gift: GiftCandidate): string {
  return gift.canonicalUrl || gift.unlockUrl;
}

/** A gift whose article is on the blocked list (or is not a public address) is not shown. */
function giftBlocked(gift: GiftCandidate, blockedSites: string[]): boolean {
  if (HIDDEN_STATUS.has(gift.status)) return true;
  const url = articleUrl(gift);
  return !url || isBlocked(url, blockedSites);
}

function asItem(gift: GiftCandidate): FeedItem {
  return {
    id: gift.id,
    title: gift.title || "Untitled",
    link: articleUrl(gift),
    source: gift.site || gift.publisher || "Gift",
    publishedAt: gift.foundAt || undefined,
    author: gift.sourceAuthor,
  };
}

function inAmber(gift: GiftCandidate, saved: Map<string, ArchiveArticleMeta>): boolean {
  if (gift.archivedId) return true;
  return [gift.canonicalUrl, gift.unlockUrl].some((url) => url !== undefined && saved.has(articleKey(url)));
}

/**
 * The live gift queue, pinned above Latest's feed. Hidden when Amber can't be
 * reached or the queue is empty: a missing section, not an error. Listing and
 * dismissing talk to the same archive bridge as everything else. Nothing here
 * saves; opening a row is the click, and the Reader saves that one gift.
 */
export function Gifts({
  archiveUrl,
  active,
  reloadToken,
  blockedSites,
  saved,
  now,
  cursorId,
  onCursor,
  onOpen,
  onEntries,
}: {
  archiveUrl: string | null;
  active: boolean;
  reloadToken: number;
  blockedSites: string[];
  saved: Map<string, ArchiveArticleMeta>;
  now: number;
  cursorId: string | null;
  onCursor: (id: string | null) => void;
  /** The clicked gift, plus the other gifts in their list order. None of them may auto-save. */
  onOpen: (entry: ReaderEntry, list: ReaderEntry[]) => void;
  /** The gift rows, so Latest's j/k can walk them. Each entry has `autoFetch: false`. */
  onEntries?: (entries: ReaderEntry[]) => void;
}) {
  const [gifts, setGifts] = useState<GiftCandidate[]>([]);
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [dismissNote, setDismissNote] = useState<string | null>(null);
  const hidden = useRef(new Set<string>());
  const giftsRef = useRef(gifts);
  giftsRef.current = gifts;
  const blockedKey = blockedSites.join("\n");
  const blockedRef = useRef(blockedSites);
  blockedRef.current = blockedSites;

  useEffect(() => {
    if (!active) return;
    if (!archiveUrl || archiveUrl.trim() === "") {
      setGifts([]);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    createArchiveBridge(archiveUrl)
      .listCandidates({ signal: controller.signal })
      .then((list) => {
        if (cancelled) return;
        setGifts(list.filter((gift) => !hidden.current.has(gift.id) && !giftBlocked(gift, blockedRef.current)));
      })
      .catch(() => {
        if (!cancelled) setGifts([]);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [archiveUrl, active, reloadToken, blockedKey]);

  const entries = useMemo(() => gifts.map(entryFromCandidate), [gifts]);
  useEffect(() => {
    onEntries?.(entries);
  }, [entries, onEntries]);
  useEffect(() => {
    return () => onEntries?.([]);
  }, [onEntries]);

  const dismiss = useCallback(
    async (id: string) => {
      if (!archiveUrl || archiveUrl.trim() === "") return;
      const previous = giftsRef.current;
      hidden.current.add(id);
      setDismissing(id);
      setGifts(previous.filter((gift) => gift.id !== id));
      try {
        await dismissCandidate(archiveUrl, id);
        setDismissNote(null);
      } catch {
        hidden.current.delete(id);
        setGifts(previous);
        setDismissNote("Couldn’t dismiss that gift.");
      } finally {
        setDismissing((current) => (current === id ? null : current));
      }
    },
    [archiveUrl],
  );

  if (gifts.length === 0) return null;

  return (
    <section className="gifts" aria-label="Gifts">
      <h2 className="day">
        <span>Gifts</span>
        <span className="day-n">{gifts.length}</span>
      </h2>
      {dismissNote && (
        <p className="gifts-note" role="status">
          {dismissNote}
        </p>
      )}
      <ul className="rows">
        {gifts.map((gift) => {
          const item = asItem(gift);
          return (
            <Row
              key={gift.id}
              item={item}
              now={now}
              timeLabel={ageLabel(gift.foundAt, now)}
              inAmber={inAmber(gift, saved)}
              cursor={item.id === cursorId}
              onFocus={() => onCursor(item.id)}
              dismissing={dismissing === gift.id}
              onDismiss={() => void dismiss(gift.id)}
              onOpen={() => {
                const entry = entries.find((candidate) => candidate.candidateId === gift.id);
                if (!entry) return;
                onCursor(item.id);
                onOpen(entry, entries);
              }}
            />
          );
        })}
      </ul>
    </section>
  );
}
