export function mockComposerSoftWrap(
  textarea: HTMLTextAreaElement,
  shouldWrap: (value: string) => boolean,
): void {
  textarea.style.lineHeight = "20px";
  textarea.style.paddingTop = "4px";
  textarea.style.paddingBottom = "4px";

  Object.defineProperty(textarea, "scrollHeight", {
    configurable: true,
    get() {
      return shouldWrap(textarea.value) ? 48 : 28;
    },
  });
}
