export { default } from "@novnc/novnc";

declare module "@novnc/novnc" {
  export default class RFB extends EventTarget {
    scaleViewport: boolean;
    resizeSession: boolean;
    qualityLevel: number;
    compressionLevel: number;
    constructor(target: HTMLElement, url: string, options?: { credentials?: { username?: string; password?: string } });
    disconnect(): void;
    sendCredentials(credentials: { username?: string; password?: string }): void;
  }
}
