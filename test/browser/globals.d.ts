declare global {
  interface Window {
    /** Set by the specs to count finished verifications. */
    __done?: number;
  }
}
export {};
