import type { ChatMessage } from "../shared/chat-state";

/** Tracks the selected session and current tail without serializing the full history. */
export function transcriptContentKey(
  sessionID: string | null,
  messages: ChatMessage[],
): string {
  const tail = messages.at(-1);
  return JSON.stringify([
    sessionID,
    tail?.id ?? null,
    tail?.role ?? null,
    tail?.text ?? null,
    tail?.parts ?? null,
  ]);
}

export function shouldFollowTranscript(intent: {
  forced: boolean;
  wasFollowing: boolean;
  loadingOlder: boolean;
}): boolean {
  return !intent.loadingOlder && (intent.forced || intent.wasFollowing);
}

/** Gap in pixels under which a scroll position still counts as pinned to the bottom. */
export const FOLLOW_GAP_THRESHOLD = 2;

export interface TranscriptScrollIntent {
  following: boolean;
  lastScrollTop: number;
}

/**
 * Updates follow intent from one scroll event of the transcript region.
 *
 * Content growth during streaming leaves transient gaps after a pinned
 * scroll, and region resizes clamp scrollTop downward; neither is a user
 * scroll, so only a genuine upward scroll while content remains below the
 * viewport ends the pinned follow. Reaching the bottom always re-pins.
 */
export function updateFollowIntentOnScroll(
  intent: TranscriptScrollIntent,
  metrics: {
    scrollTop: number;
    clientHeight: number;
    scrollHeight: number;
  },
): TranscriptScrollIntent {
  const gap =
    metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop;
  if (gap <= FOLLOW_GAP_THRESHOLD) {
    return { following: true, lastScrollTop: metrics.scrollTop };
  }
  if (metrics.scrollTop < intent.lastScrollTop) {
    return { following: false, lastScrollTop: metrics.scrollTop };
  }
  return { following: intent.following, lastScrollTop: metrics.scrollTop };
}

export interface TranscriptFollowTarget {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  lastElementChild: Element | null;
  addEventListener(
    type: "scroll",
    listener: () => void,
    options?: { passive?: boolean },
  ): void;
  removeEventListener(type: "scroll", listener: () => void): void;
}

/**
 * Browser-provided observation seams for the transcript follow loop. The
 * region resize, current-tail resize, and descendant content notifications
 * all resolve to the same non-forced follow; concrete observer construction
 * and teardown stay with the caller so the wiring stays testable.
 */
export interface TranscriptFollowObservers {
  requestFrame(callback: () => void): unknown;
  cancelFrame(handle: unknown): void;
  /**
   * Registers region-box resize delivery. May return a disposer that
   * disconnects the caller-owned observer covering the region; the watcher
   * invokes it exactly once during cleanup so a shared observer owner is
   * never left attached after disposal.
   */
  observeRegion(notify: () => void): void | (() => void);
  observeTail(tail: Element, notify: () => void): void;
  unobserveTail(tail: Element): void;
  observeContent(notify: () => void): () => void;
}

/**
 * Synchronously pins the transcript bottom for new session/tail content.
 * Called from the layout phase so the scroll lands before paint and before
 * any snapshot frame; respects the older-loading guard so explicit older
 * history reading is never yanked down.
 */
export function pinTranscriptToBottom(
  region: TranscriptFollowTarget,
  following: { current: boolean },
  loadingOlder: { current: boolean },
): void {
  if (loadingOlder.current) {
    following.current = false;
    return;
  }
  region.scrollTop = region.scrollHeight;
  following.current = true;
}

/**
 * Owns the transcript follow loop: a single queued frame (forced work is
 * never downgraded by non-forced notifications), direction-aware scroll
 * intent, a loadingOlder recheck inside the queued frame, and bounded tail
 * observation that always retargets (and unobserves) the current tail.
 * New-tail pinning is owned by the synchronous layout pin, so this watcher
 * queues no initial forced frame. Returns an idempotent disposer that marks
 * the watcher disposed (late observer deliveries and already-captured frame
 * callbacks become inert), cancels pending frames, and disconnects every
 * observer owner including the caller-owned region observer.
 */
export function watchTranscriptFollow(
  region: TranscriptFollowTarget,
  following: { current: boolean },
  loadingOlder: { current: boolean },
  observers: TranscriptFollowObservers,
): () => void {
  let frame: { handle: unknown } | null = null;
  let frameForced = false;
  let lastScrollTop = region.scrollTop;
  let observedTail: Element | null = null;
  let disposed = false;

  const follow = (forced = false): void => {
    if (disposed) return;
    if (frameForced && !forced) return;
    if (frame) observers.cancelFrame(frame.handle);
    frameForced = forced;
    frame = {
      handle: observers.requestFrame(() => {
        frame = null;
        // A frame captured before disposal must reject queued host delivery.
        if (disposed) return;
        const shouldFollow = shouldFollowTranscript({
          forced: frameForced,
          wasFollowing: following.current,
          loadingOlder: loadingOlder.current,
        });
        frameForced = false;
        if (!shouldFollow) {
          if (loadingOlder.current) {
            // Older history is being loaded for explicit reading; the
            // previously pinned bottom must not yank the reader down.
            following.current = false;
          }
          return;
        }
        region.scrollTop = region.scrollHeight;
        following.current = true;
        lastScrollTop = region.scrollTop;
      }),
    };
  };

  // Follow intent changes only on genuine user scrolls: content growth
  // during streaming and bottom clamps from region resizes leave transient
  // gaps without a user scroll and must never end the pinned follow.
  const onScroll = (): void => {
    if (disposed) return;
    const intent = updateFollowIntentOnScroll(
      { following: following.current, lastScrollTop },
      {
        scrollTop: region.scrollTop,
        clientHeight: region.clientHeight,
        scrollHeight: region.scrollHeight,
      },
    );
    following.current = intent.following;
    lastScrollTop = intent.lastScrollTop;
  };
  region.addEventListener("scroll", onScroll, { passive: true });

  const retargetTail = (): void => {
    const tail = region.lastElementChild;
    if (tail === observedTail) return;
    if (observedTail) observers.unobserveTail(observedTail);
    observedTail = tail;
    if (tail) observers.observeTail(tail, () => follow());
  };

  const stopRegion = observers.observeRegion(() => follow());
  retargetTail();
  const stopContent = observers.observeContent(() => {
    if (disposed) return;
    retargetTail();
    follow();
  });

  return () => {
    // Idempotent: late or repeated disposer calls are inert.
    if (disposed) return;
    disposed = true;
    if (frame) observers.cancelFrame(frame.handle);
    frame = null;
    region.removeEventListener("scroll", onScroll);
    if (observedTail) observers.unobserveTail(observedTail);
    observedTail = null;
    stopContent();
    stopRegion?.();
  };
}

export function scrollTranscriptToBottom(element: HTMLElement): void {
  element.scrollTop = element.scrollHeight;
}
