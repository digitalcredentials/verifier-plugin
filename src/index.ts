export { VerifierCredential } from './verifier-credential.js';
export { verify, DEFAULT_REGISTRIES, type Registry, type VerifyOptions } from './verify.js';
export {
  summarise,
  listChecks,
  issuerIdentity,
  stoppedEarly,
  hasStatusList,
  type Outcome,
  type Check,
  type IssuerIdentity,
} from './outcomes.js';
export { summariseCredential, formatDate, type CredentialSummary } from './credential.js';
export type { Severity, VerificationResponse, VerificationStep } from './types.js';
