/**
 * Pulling the few fields we display out of a credential.
 *
 * A credential's shape isn't known until you open it, so this stays minimal
 * and falls back rather than throwing. requirements.md §8.
 */

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim().length > 0 ? v : undefined;

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

const first = <T>(v: T | T[] | undefined): T | undefined =>
  Array.isArray(v) ? v[0] : v;

export interface CredentialSummary {
  title: string;
  recipient?: string;
  issuerName?: string;
  issuedOn?: string;
}

export const summariseCredential = (
  credential: Record<string, unknown> | undefined,
): CredentialSummary => {
  if (!credential) return { title: 'Credential' };

  const subject = asRecord(first(credential['credentialSubject'] as never));
  const achievement = asRecord(first(subject?.['achievement'] as never));
  const issuer = credential['issuer'];

  // Deliberately not falling back to the subject's name: that's the
  // recipient, and using it as the title renders the same name twice.
  const title = str(achievement?.['name']) ?? str(credential['name']) ?? 'Credential';

  return {
    title,
    recipient: str(subject?.['name']),
    issuerName:
      typeof issuer === 'string' ? issuer : str(asRecord(issuer)?.['name']),
    issuedOn: str(credential['validFrom']) ?? str(credential['issuanceDate']),
  };
};

/** "12 March 2026", or the raw value if it isn't a date we can read. */
export const formatDate = (value: string | undefined): string | undefined => {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
};
