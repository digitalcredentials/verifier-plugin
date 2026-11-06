/**
 * Pulling the few fields we display out of a credential.
 *
 * A credential's shape isn't known until you open it, so this stays minimal
 * and falls back rather than throwing. requirements.md §8.
 */
export interface CredentialSummary {
    title: string;
    recipient?: string;
    issuerName?: string;
    issuedOn?: string;
}
export declare const summariseCredential: (credential: Record<string, unknown> | undefined) => CredentialSummary;
/** "12 March 2026", or the raw value if it isn't a date we can read. */
export declare const formatDate: (value: string | undefined) => string | undefined;
