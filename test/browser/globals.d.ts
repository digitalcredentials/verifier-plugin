declare global {
  interface Window {
    /** Set by the specs to count finished verifications. */
    __done?: number;
    /** The library's result from the last finished verification. */
    __response?: unknown;
    /** Set by the specs to count writes to the live region. */
    __announced?: number;
  }
}
export {};
