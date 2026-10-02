/**
 * The developer view: every check verifier-core ran, in the library's own
 * groups and the library's own words.
 *
 * Nothing here decides what anything means. outcomes.ts turns the result into
 * what a person reads; this only sorts it, so a developer or an issuer can see
 * exactly what the library said. Reviewed with the team on 29–30 September
 * 2026: show every check, including passes and skips, and use the library's
 * summary sentence for each group rather than one of ours.
 */

import type { CheckResult, SuiteSummary, VerificationResponse } from './types.js';

export interface CheckGroup {
  /**
   * The library's rollup for this group. Absent only on the last group, which
   * holds checks that no suite claimed — shown rather than dropped, because
   * the point of this view is that nothing the library returned goes missing.
   */
  suite?: SuiteSummary;
  checks: CheckResult[];
}

/** A check belongs to a suite when its id is the suite's, or starts with it. */
export const belongsTo = (checkId: string, suiteId: string): boolean =>
  checkId === suiteId || checkId.startsWith(`${suiteId}.`);

/**
 * The checks, grouped by suite, in the order the library listed its suites.
 *
 * A check goes to the longest suite id that claims it, so if one suite's id
 * ever sits inside another's the check is shown once, under the nearer one.
 */
export const groupChecks = (r: VerificationResponse): CheckGroup[] => {
  const groups: CheckGroup[] = (r.summary ?? []).map((suite) => ({ suite, checks: [] }));
  const unclaimed: CheckResult[] = [];

  for (const check of r.results ?? []) {
    let home: CheckGroup | undefined;
    for (const group of groups) {
      const id = group.suite!.id;
      if (check.id && belongsTo(check.id, id) && (!home || id.length > home.suite!.id.length)) {
        home = group;
      }
    }
    (home?.checks ?? unclaimed).push(check);
  }

  return unclaimed.length ? [...groups, { checks: unclaimed }] : groups;
};

/**
 * What to call a check inside its group: the part of its id after the suite's,
 * so `cryptographic.core.proof-exists` reads `proof-exists` under
 * `cryptographic.core`. Outside a group it keeps its whole id — or, for a
 * hand-built result with no id, the deprecated `suite` and `check` it carries.
 */
export const checkName = (check: CheckResult, suiteId?: string): string => {
  const id = check.id ?? [check.suite, check.check].filter(Boolean).join('.');
  if (!suiteId || id === suiteId || !belongsTo(id, suiteId)) return id;
  return id.slice(suiteId.length + 1);
};
