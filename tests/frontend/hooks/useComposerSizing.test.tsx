import { afterEach, describe, expect, mock, test } from "bun:test";
import { render } from "@testing-library/react";
import { useComposerSizing } from "@/components/common/composer-rows";

function ComposerSizingHarness({ value }: { value: string }) {
  const { composerRef, composerRows } = useComposerSizing(value);

  return (
    <textarea
      aria-label="Composer"
      readOnly
      ref={composerRef}
      rows={composerRows}
      value={value}
    />
  );
}

afterEach(() => {
  window.ResizeObserver = originalResizeObserver;
  window.addEventListener = originalAddEventListener;
  window.removeEventListener = originalRemoveEventListener;
  window.getComputedStyle = originalGetComputedStyle;
});

const originalResizeObserver = window.ResizeObserver;
const originalAddEventListener = window.addEventListener;
const originalRemoveEventListener = window.removeEventListener;
const originalGetComputedStyle = window.getComputedStyle;

describe("useComposerSizing", () => {
  test("keeps resize subscriptions stable across value changes", () => {
    const resizeObservers: Array<{
      observe: ReturnType<typeof mock>;
      disconnect: ReturnType<typeof mock>;
    }> = [];

    class TrackingResizeObserver {
      observe = mock((_element: Element) => {});
      disconnect = mock(() => {});

      constructor(_callback: ResizeObserverCallback) {
        resizeObservers.push({
          observe: this.observe,
          disconnect: this.disconnect,
        });
      }
    }

    let resizeAddCalls = 0;
    let resizeRemoveCalls = 0;

    window.ResizeObserver = TrackingResizeObserver as unknown as typeof ResizeObserver;
    window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      if (type === "resize") {
        resizeAddCalls += 1;
      }
      originalAddEventListener.call(window, type, listener, options);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      if (type === "resize") {
        resizeRemoveCalls += 1;
      }
      originalRemoveEventListener.call(window, type, listener, options);
    }) as typeof window.removeEventListener;

    const { rerender, unmount } = render(<ComposerSizingHarness value="First value" />);
    rerender(<ComposerSizingHarness value="Second value" />);
    rerender(<ComposerSizingHarness value="Third value that keeps typing" />);

    expect(resizeObservers).toHaveLength(1);
    expect(resizeObservers[0]?.observe).toHaveBeenCalledTimes(1);
    expect(resizeObservers[0]?.disconnect).not.toHaveBeenCalled();
    expect(resizeAddCalls).toBe(1);
    expect(resizeRemoveCalls).toBe(0);

    unmount();

    expect(resizeObservers[0]?.disconnect).toHaveBeenCalledTimes(1);
    expect(resizeRemoveCalls).toBe(1);
  });

  test("skips textarea measurement when the value already contains a line break", () => {
    const getComputedStyleSpy = mock((element: Element) =>
      originalGetComputedStyle.call(window, element),
    );
    window.getComputedStyle = getComputedStyleSpy as typeof window.getComputedStyle;

    const { getByLabelText } = render(<ComposerSizingHarness value={"Line 1\nLine 2"} />);

    expect((getByLabelText("Composer") as HTMLTextAreaElement).getAttribute("rows")).toBe("2");
    expect(getComputedStyleSpy).not.toHaveBeenCalled();
  });
});
