import { describe, expect, it } from "vitest";
import {
  pinTranscriptToBottom,
  shouldFollowTranscript,
  transcriptContentKey,
  updateFollowIntentOnScroll,
  watchTranscriptFollow,
  type TranscriptFollowObservers,
  type TranscriptFollowTarget,
} from "../src/webview/transcript-scroll";
import type { ChatMessage } from "../src/shared/chat-state";

describe("transcript content tracking", () => {
  it("preserves an older-history reading position but still forces new tail updates", () => {
    expect(shouldFollowTranscript({ forced: false, wasFollowing: false, loadingOlder: false })).toBe(false);
    expect(shouldFollowTranscript({ forced: false, wasFollowing: true, loadingOlder: false })).toBe(true);
    expect(shouldFollowTranscript({ forced: true, wasFollowing: false, loadingOlder: false })).toBe(true);
    expect(shouldFollowTranscript({ forced: true, wasFollowing: true, loadingOlder: true })).toBe(false);
  });
  it("changes for session selection, appended messages, and same-message streamed parts", () => {
    const message: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      text: "working",
      parts: [{ id: "text-1", type: "text", text: "working" }],
    };
    const initial = transcriptContentKey("session-a", [message]);

    expect(transcriptContentKey("session-b", [message])).not.toBe(initial);
    expect(transcriptContentKey("session-a", [message, { id: "user-1", role: "user", text: "next" }])).not.toBe(initial);
    expect(transcriptContentKey("session-a", [{ ...message, parts: [{ id: "text-1", type: "text", text: "working now" }] }])).not.toBe(initial);
  });

  it("does not change when older history is prepended ahead of the visible tail", () => {
    const tail: ChatMessage = { id: "tail", role: "assistant", text: "latest" };
    const key = transcriptContentKey("session-a", [tail]);
    expect(transcriptContentKey("session-a", [
      { id: "older", role: "user", text: "previous" },
      tail,
    ])).toBe(key);
  });
});

describe("follow intent from scroll events", () => {
  it("keeps following when streaming growth leaves a transient gap without a user scroll", () => {
    // Recorded streaming failure (.tools/ui-preview/final-t6-result.json):
    // pinned at scrollTop 4940 (scrollHeight 5367, clientHeight 427), then
    // same-ID streaming grew the content to 5376 before the next follow
    // frame, leaving a 9px gap. That transient gap alone must not end the
    // pinned follow; the queued observer follow must still scroll.
    const pinned = { following: true, lastScrollTop: 4940 };
    const transient = updateFollowIntentOnScroll(pinned, {
      scrollTop: 4940,
      scrollHeight: 5376,
      clientHeight: 427,
    });
    expect(transient.following).toBe(true);
    expect(
      shouldFollowTranscript({
        forced: false,
        wasFollowing: transient.following,
        loadingOlder: false,
      }),
    ).toBe(true);
  });

  it("stops following only on a genuine upward user scroll away from the bottom", () => {
    const pinned = { following: true, lastScrollTop: 4940 };
    const scrolledUp = updateFollowIntentOnScroll(pinned, {
      scrollTop: 3000,
      scrollHeight: 5376,
      clientHeight: 427,
    });
    expect(scrolledUp.following).toBe(false);
    expect(
      shouldFollowTranscript({
        forced: false,
        wasFollowing: scrolledUp.following,
        loadingOlder: false,
      }),
    ).toBe(false);
  });

  it("re-pins at the bottom and keeps pinning through bottom clamps from region resizes", () => {
    const scrolledUp = { following: false, lastScrollTop: 3000 };
    const repinned = updateFollowIntentOnScroll(scrolledUp, {
      scrollTop: 4949,
      scrollHeight: 5376,
      clientHeight: 427,
    });
    expect(repinned.following).toBe(true);

    // A region resize (composer/toolbar) clamps scrollTop down to the new
    // bottom; the reader is still at the bottom, so following must hold.
    const clamped = updateFollowIntentOnScroll(repinned, {
      scrollTop: 4940,
      scrollHeight: 5376,
      clientHeight: 436,
    });
    expect(clamped.following).toBe(true);
  });
});

describe("transcript follow observer wiring", () => {
  class FakeRegion implements TranscriptFollowTarget {
    scrollHeight: number;
    clientHeight: number;
    lastElementChild: Element | null;
    private readonly listeners = new Set<() => void>();
    private currentScrollTop: number;

    constructor(metrics: {
      scrollTop: number;
      scrollHeight: number;
      clientHeight: number;
    }) {
      this.scrollHeight = metrics.scrollHeight;
      this.clientHeight = metrics.clientHeight;
      this.currentScrollTop = metrics.scrollTop;
      this.lastElementChild = { tag: "tail-1" } as unknown as Element;
    }

    // Mirrors the DOM: assigning beyond the maximum clamps to maxScroll.
    get scrollTop(): number {
      return this.currentScrollTop;
    }

    set scrollTop(value: number) {
      this.currentScrollTop = Math.max(
        0,
        Math.min(value, this.scrollHeight - this.clientHeight),
      );
    }

    addEventListener(_type: "scroll", listener: () => void): void {
      this.listeners.add(listener);
    }

    removeEventListener(_type: "scroll", listener: () => void): void {
      this.listeners.delete(listener);
    }

    dispatchScroll(): void {
      this.listeners.forEach((listener) => listener());
    }

    grow(by: number): void {
      this.scrollHeight += by;
      this.scrollTop = this.scrollTop;
    }

    appendTail(): void {
      this.lastElementChild = {
        tag: `tail-${Math.random()}`,
      } as unknown as Element;
    }
  }

  function makeHost() {
    const callbacks = new Map<number, () => void>();
    let nextHandle = 1;
    const observedTails = new Set<Element>();
    let regionNotify: (() => void) | null = null;
    let contentNotify: (() => void) | null = null;
    const host: TranscriptFollowObservers = {
      requestFrame(callback) {
        const handle = nextHandle++;
        callbacks.set(handle, callback);
        return handle;
      },
      cancelFrame(handle) {
        callbacks.delete(handle as number);
      },
      observeRegion(notify) {
        regionNotify = notify;
      },
      observeTail(tail) {
        observedTails.add(tail);
      },
      unobserveTail(tail) {
        observedTails.delete(tail);
      },
      observeContent(notify) {
        contentNotify = notify;
        return () => {
          contentNotify = null;
        };
      },
    };
    return {
      host,
      observedTails,
      runRegionResize: () => regionNotify?.(),
      runContentMutation: () => contentNotify?.(),
      runFrame: (handle: unknown) => {
        const callback = callbacks.get(handle as number);
        callbacks.delete(handle as number);
        callback?.();
      },
      pendingHandles: () => Array.from(callbacks.keys()),
      pendingCount: () => callbacks.size,
    };
  }

  it("pins new session/tail content synchronously before any queued frame, respecting the older-loading guard", () => {
    // Snapshot race from the recorded failure: a forced follow queued from a
    // passive effect lands one frame after a two-rAF snapshot, leaving the
    // 9px gap. New tail content must pin synchronously in the layout phase.
    const region = new FakeRegion({
      scrollTop: 0,
      scrollHeight: 5376,
      clientHeight: 427,
    });
    const following = { current: false };
    pinTranscriptToBottom(region, following, { current: false });
    expect(region.scrollTop).toBe(region.scrollHeight - region.clientHeight);
    expect(following.current).toBe(true);

    // Older history is being read: the layout pin must not yank the reader.
    const reading = new FakeRegion({
      scrollTop: 0,
      scrollHeight: 5376,
      clientHeight: 427,
    });
    const readingFollowing = { current: true };
    pinTranscriptToBottom(reading, readingFollowing, { current: true });
    expect(reading.scrollTop).toBe(0);
    expect(readingFollowing.current).toBe(false);
  });

  it("restores the pinned bottom when region/tail resize observers report streaming growth after the layout pin", () => {
    // Recorded failure (.tools/ui-preview/corrected-final-t6-result.json):
    // pinned at scrollTop 4940, then streaming growth left 5376-427-4940 =
    // 9px. ResizeObserver coverage of the tail must catch the growth and
    // finish the follow because the direction-aware intent is still pinned.
    const region = new FakeRegion({
      scrollTop: 0,
      scrollHeight: 5367,
      clientHeight: 427,
    });
    const following = { current: false };
    const loadingOlder = { current: false };
    pinTranscriptToBottom(region, following, loadingOlder);
    expect(region.scrollTop).toBe(region.scrollHeight - region.clientHeight);

    const tool = makeHost();
    const stop = watchTranscriptFollow(region, following, loadingOlder, tool.host);
    // The watcher no longer queues its own initial forced frame; the layout
    // pin already owns new-tail pinning.
    expect(tool.pendingCount()).toBe(0);

    // Same-ID streaming grows the tail 9px after the synchronous pin.
    region.grow(9);
    tool.runRegionResize();
    expect(tool.pendingCount()).toBe(1);
    tool.runFrame(tool.pendingHandles()[0]);
    expect(region.scrollTop).toBe(region.scrollHeight - region.clientHeight);
    expect(following.current).toBe(true);
    stop();
  });

  it("retargets the bounded tail observation, unobserving the previous tail", () => {
    const region = new FakeRegion({
      scrollTop: 0,
      scrollHeight: 500,
      clientHeight: 427,
    });
    const tool = makeHost();
    const stop = watchTranscriptFollow(region, { current: false }, { current: false }, tool.host);

    const previousTail = region.lastElementChild as Element;
    expect(tool.observedTails.has(previousTail)).toBe(true);

    region.appendTail();
    tool.runContentMutation();
    expect(tool.observedTails.has(previousTail)).toBe(false);
    expect(tool.observedTails.has(region.lastElementChild as Element)).toBe(true);

    stop();
    expect(tool.observedTails.size).toBe(0);
  });

  it("does not follow a genuine upward user scroll but keeps following pinned growth", () => {
    const region = new FakeRegion({
      scrollTop: 0,
      scrollHeight: 5367,
      clientHeight: 427,
    });
    const following = { current: false };
    const loadingOlder = { current: false };
    pinTranscriptToBottom(region, following, loadingOlder);
    expect(region.scrollTop).toBe(4940);

    const tool = makeHost();
    const stop = watchTranscriptFollow(region, following, loadingOlder, tool.host);

    // Reader scrolls up to read older history.
    region.scrollTop = 3000;
    region.dispatchScroll();
    expect(following.current).toBe(false);

    // Non-tail late layout reports through the region/content observers.
    region.grow(100);
    tool.runContentMutation();
    tool.runFrame(tool.pendingHandles()[0]);
    expect(region.scrollTop).toBe(3000);
    expect(following.current).toBe(false);
    stop();
  });

  it("skips follow while older history loads, unpins, and cleans up pending frames and listeners", () => {
    const region = new FakeRegion({
      scrollTop: 0,
      scrollHeight: 5367,
      clientHeight: 427,
    });
    const following = { current: false };
    const loadingOlder = { current: true };
    pinTranscriptToBottom(region, following, loadingOlder);
    expect(region.scrollTop).toBe(0);
    expect(following.current).toBe(false);

    const tool = makeHost();
    const stop = watchTranscriptFollow(region, following, loadingOlder, tool.host);

    // Observer notifications while older history loads skip and unpin.
    tool.runContentMutation();
    tool.runFrame(tool.pendingHandles()[0]);
    expect(region.scrollTop).toBe(0);
    expect(following.current).toBe(false);

    // A pending non-forced frame queued by observers is dropped on cleanup.
    tool.runContentMutation();
    expect(tool.pendingCount()).toBe(1);
    stop();
    expect(tool.pendingCount()).toBe(0);
    expect(tool.observedTails.size).toBe(0);

    // Scroll listeners are removed: a scroll event no longer updates intent.
    following.current = false;
    region.dispatchScroll();
    expect(following.current).toBe(false);
  });
});
