declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    scaleViewport: boolean;
    resizeSession: boolean;
    constructor(target: HTMLElement, url: string, options?: { credentials?: { password?: string } });
    disconnect(): void;
  }
}
