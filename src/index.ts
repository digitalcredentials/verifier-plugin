export { VerifierCredential } from './verifier-credential.js';
export { verify, DEFAULT_REGISTRIES, type Registry, type VerifyOptions } from './verify.js';
export {
  summarise,
  listChecks,
  issuerIdentity,
  issuerMarker,
  verdictLeads,
  contentCaveat,
  stoppedEarly,
  hasStatusList,
  schemaFinding,
  type Outcome,
  type Check,
  type IssuerIdentity,
  type IssuerNameSource,
  type SchemaFinding,
} from './outcomes.js';
export { summariseCredential, formatDate, type CredentialSummary } from './credential.js';
export type { Severity, VerificationResponse, CheckResult } from './types.js';
