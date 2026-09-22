/**
 * <verifier-credential> — shows a credential and whether it still holds up.
 *
 * A web component, provisionally. See requirements.md §2: the wallet is meant
 * to be swappable, and this is cheap to turn into a React component later if
 * the plugin interface lands somewhere else.
 *
 * It sits behind a shadow root, so it cannot use the surrounding app's router
 * or dialogs. Everything it offers has to work inside the component — which is
 * why the details are a disclosure here rather than a modal.
 *
 * Attributes
 *   (none required; set `credential` as a property)
 *
 * Properties
 *   credential  the credential object to show and check
 *   registries  optional override of the registries to consult
 *
 * Events
 *   verification-started   { credential }
 *   verification-complete  { outcome, checks, response }
 *   verification-failed    { error }
 */

import { verify, type Registry } from './verify.js';
import {
  summarise,
  listChecks,
  issuerIdentity,
  issuerMarker,
  verdictLeads,
  contentCaveat,
  type Check,
  type IssuerIdentity,
  type Outcome,
} from './outcomes.js';
import { summariseCredential, formatDate } from './credential.js';
import type { VerificationResponse } from './types.js';

const GLYPH: Record<string, string> = {
  success: '✓',
  warning: '!',
  error: '✕',
  unchecked: 'ⓘ',
};

/** Words as well as colour, always. requirements.md §4. */
const SEVERITY_LABEL: Record<string, string> = {
  success: 'Verified',
  warning: 'Warning',
  error: 'Problem',
  unchecked: "Couldn't check",
};

/**
 * The same severities, said aloud on a detail row.
 *
 * "Verified" is right for the card's verdict and wrong for one line of a
 * breakdown, where a screen reader would otherwise read "Verified: none".
 */
const CHECK_LABEL: Record<string, string> = {
  success: 'Passed',
  warning: 'Warning',
  error: 'Problem',
  unchecked: "Couldn't check",
};

const styles = `
  :host { display: block; container-type: inline-size; }
  * { box-sizing: border-box; }
  .card {
    background: var(--vp-surface, #fff);
    color: var(--vp-ink, #16202e);
    border: 1px solid var(--vp-rule, #d9dee7);
    border-radius: 12px;
    padding: 22px;
    font: 16px/1.55 var(--vp-font, system-ui, -apple-system, "Segoe UI", sans-serif);
  }
  .title { font-size: 1.15rem; font-weight: 600; margin: 0 0 4px; }
  .who { margin: 0; color: var(--vp-ink-2, #47536a); }
  .meta { margin: 3px 0 0; font-size: .87rem; color: var(--vp-ink-3, #6e7a8f); }
  .verdict { border-top: 1px solid var(--vp-rule, #d9dee7); margin-top: 18px; padding-top: 16px; display: flex; gap: 10px; align-items: flex-start; }
  .glyph { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center;
           font-size: 13px; font-weight: 700; color: #fff; flex: 0 0 auto; margin-top: 1px; }
  .s-success { background: var(--vp-ok, #1b6e46); }
  .s-warning { background: var(--vp-warn, #8a5a05); }
  .s-error   { background: var(--vp-bad, #9e2a2a); }
  .s-unchecked { background: var(--vp-unk, #5e6a7c); }
  .verdict.bare { border-top: 0; margin-top: 0; padding-top: 0; }
  .caveat { margin: 14px 0 0; font-size: .87rem; color: var(--vp-ink-3, #6e7a8f); }
  .quiet { margin-top: 6px; }
  .quiet .title { font-size: 1rem; font-weight: 600; color: var(--vp-ink-2, #47536a); }
  .quiet .who, .quiet .meta { color: var(--vp-ink-3, #6e7a8f); }
  .headline { font-weight: 700; margin: 0 0 3px; }
  .detail { margin: 0; font-size: .94rem; color: var(--vp-ink-2, #47536a); }
  .action { margin: 8px 0 0; font-size: .94rem; font-style: italic; color: var(--vp-ink-2, #47536a); }
  .foot { display: flex; justify-content: space-between; align-items: center; gap: 12px;
          margin-top: 16px; padding-top: 13px; border-top: 1px solid var(--vp-rule, #d9dee7);
          font-size: .85rem; color: var(--vp-ink-3, #6e7a8f); }
  button { font: inherit; font-size: .85rem; font-weight: 600; color: var(--vp-accent, #24476f);
           background: none; border: 0; cursor: pointer; padding: 4px 0; }
  button:hover { text-decoration: underline; }
  :focus-visible { outline: 2px solid var(--vp-accent, #24476f); outline-offset: 2px; border-radius: 3px; }
  .checks { margin-top: 14px; padding-top: 13px; border-top: 1px dashed var(--vp-rule-strong, #bfc8d6); }
  .check { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 16px;
           padding: 7px 0; font-size: .9rem; border-bottom: 1px solid var(--vp-rule, #d9dee7); }
  @container (max-width: 380px) { .check { grid-template-columns: 1fr; } }
  .check:last-child { border-bottom: 0; }
  .check .k { color: var(--vp-ink-2, #47536a); }
  .check .v { display: inline-flex; gap: 6px; align-items: flex-start; justify-content: flex-end;
              text-align: right; font-weight: 500; }
  .mark { width: 15px; height: 15px; border-radius: 50%; display: grid; place-items: center;
          font-size: 10px; font-weight: 700; color: #fff; flex: 0 0 auto; margin-top: 3px; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
             overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

export class VerifierCredential extends HTMLElement {
  #root: ShadowRoot;
  #card: HTMLDivElement;
  /**
   * Built once and only ever written to, never replaced. A screen reader
   * announces a live region that *changes*; one that arrives already full of
   * text, as it would from an innerHTML rebuild, may never be read out.
   */
  #live: HTMLParagraphElement;
  #credential?: Record<string, unknown>;
  #registries?: Registry[];
  #state: 'empty' | 'checking' | 'done' | 'failed' = 'empty';
  #outcome?: Outcome;
  #issuer?: IssuerIdentity;
  /** Set when the finding should precede the credential. */
  #verdictFirst = false;
  #caveat?: string;
  #checks: Check[] = [];
  #detailsOpen = false;
  /** A credential is waiting for a run that hasn’t happened yet. */
  #pending = false;
  /** Identifies the newest run, so a slow earlier one cannot overwrite it. */
  #runId = 0;
  /** A run is already queued for the end of this tick. */
  #scheduled = false;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = styles;
    this.#card = document.createElement('div');
    this.#card.className = 'card';
    this.#live = document.createElement('p');
    this.#live.className = 'sr-only';
    this.#live.setAttribute('role', 'status');
    this.#root.append(style, this.#card, this.#live);
  }

  set credential(value: Record<string, unknown> | undefined) {
    this.#credential = value;
    this.#clearResult();

    if (!value) {
      // Clearing the credential clears the verdict with it. Leaving the last
      // one on screen would attach a verdict to a credential that is gone.
      this.#pending = false;
      this.#state = 'empty';
      this.#runId++;
      this.#render();
      return;
    }

    this.#schedule();
  }

  get credential(): Record<string, unknown> | undefined {
    return this.#credential;
  }

  /** Forgets the last result, so none of it outlives what it described. */
  #clearResult(): void {
    this.#outcome = undefined;
    this.#issuer = undefined;
    this.#verdictFirst = false;
    this.#caveat = undefined;
    this.#checks = [];
    this.#detailsOpen = false;
  }

  set registries(value: Registry[] | undefined) {
    this.#registries = value;
    if (!this.#credential) return;
    // The registries decide whether we can confirm the issuer, so changing
    // them changes the answer. Clear the old one rather than leave its
    // details and caveat on screen beside a new check.
    this.#clearResult();
    this.#schedule();
  }

  get registries(): Registry[] | undefined {
    return this.#registries;
  }

  connectedCallback(): void {
    // A credential can be set while the element is detached — React does
    // exactly that on remount — so the work waits here, not in the setter.
    if (this.#pending && this.#credential) this.#schedule();
    else this.#render();
  }

  /**
   * Verifies once at the end of the current tick.
   *
   * A host normally sets several properties in a row — registries, then the
   * credential. Running on each one would verify the old credential against
   * the new registries and throw the result away, doubling every registry and
   * status-list fetch for an answer nobody sees. Waiting for the tick to
   * finish means one set of properties produces one check.
   */
  #schedule(): void {
    this.#pending = true;
    if (!this.isConnected || this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      // Re-checked, because the element can be detached between scheduling
      // and running. The work waits for the next connectedCallback instead.
      if (this.isConnected && this.#pending && this.#credential) void this.#run();
    });
  }

  async #run(): Promise<void> {
    const credential = this.#credential;
    if (!credential) return;

    const runId = ++this.#runId;
    const superseded = () => runId !== this.#runId;

    this.#pending = false;
    this.#state = 'checking';
    this.#render();
    this.dispatchEvent(
      new CustomEvent('verification-started', { detail: { credential }, bubbles: true, composed: true }),
    );

    try {
      const response: VerificationResponse = await verify(
        credential,
        this.#registries ? { registries: this.#registries } : {},
      );
      // A newer credential arrived while this was running. Its result is the
      // one being waited for; ours would label it with the wrong verdict.
      if (superseded()) return;
      this.#outcome = summarise(response);
      this.#issuer = issuerIdentity(response);
      this.#verdictFirst = verdictLeads(response);
      this.#caveat = contentCaveat(response);
      this.#checks = listChecks(response);
      this.#state = 'done';
      this.#render();
      this.dispatchEvent(
        new CustomEvent('verification-complete', {
          detail: { outcome: this.#outcome, checks: this.#checks, response },
          bubbles: true,
          composed: true,
        }),
      );
    } catch (error) {
      if (superseded()) return;
      this.#state = 'failed';
      this.#render();
      this.dispatchEvent(
        new CustomEvent('verification-failed', { detail: { error }, bubbles: true, composed: true }),
      );
    }
  }

  #render(options: { announce?: boolean } = {}): void {
    const { announce: shouldAnnounce = true } = options;

    if (this.#state === 'empty' || !this.#credential) {
      this.#card.replaceChildren();
      this.#say('');
      return;
    }

    const summary = summariseCredential(this.#credential);
    const issued = formatDate(summary.issuedOn);
    // The issuer's name carries where it came from, right where the name is.
    // People scan and read the first thing they meet, so a caveat that only
    // appears further down is a caveat many people never see.
    const marker = this.#issuer ? issuerMarker(this.#issuer.source) : undefined;
    const issuerName = this.#issuer?.name ?? summary.issuerName;
    const named = issuerName ? `${issuerName}${marker ? ` (${marker})` : ''}` : undefined;
    const meta = [named, issued].filter(Boolean).join(' · ');

    const content = `
      <p class="title">${esc(summary.title)}</p>
      ${summary.recipient ? `<p class="who">${esc(summary.recipient)}</p>` : ''}
      ${meta ? `<p class="meta">${esc(meta)}</p>` : ''}`;

    // The finding comes first only when the credential itself is what is in
    // question. Everywhere else the credential leads, per §4.
    this.#card.innerHTML = this.#verdictFirst
      ? `<div class="lead">${this.#verdictHtml({ divider: false })}</div>
         ${this.#caveat ? `<p class="caveat">${esc(this.#caveat)}</p>` : ''}
         <div class="quiet">${content}</div>
         ${this.#foot()}`
      : `${content}${this.#verdictHtml()}${this.#foot()}`;

    if (shouldAnnounce) this.#say(this.#spokenResult());

    const toggle = this.#card.querySelector<HTMLButtonElement>('#toggle');
    toggle?.addEventListener('click', () => {
      this.#detailsOpen = !this.#detailsOpen;
      // Opening the details is not a new result, so it must not re-announce.
      this.#render({ announce: false });
      this.#card.querySelector<HTMLButtonElement>('#toggle')?.focus();
    });
  }

  /**
   * The footer says when we checked, so it only belongs on a finished check.
   * While one is running, or after one failed outright, there is no "just
   * now" to report.
   */
  #foot(): string {
    return this.#state === 'done' ? this.#footHtml() : '';
  }

  /** Writes the live region, leaving the element itself in place. */
  #say(message: string): void {
    if (this.#live.textContent !== message) this.#live.textContent = message;
  }

  #spokenResult(): string {
    if (this.#state === 'checking') return 'Checking this credential.';
    if (this.#state === 'failed' || !this.#outcome) {
      return 'We couldn’t finish checking this credential.';
    }
    const o = this.#outcome;
    return `${announce(o.severity, o.headline)} ${o.detail}`;
  }

  #verdictHtml(options: { divider?: boolean } = {}): string {
    const cls = options.divider === false ? 'verdict bare' : 'verdict';
    if (this.#state === 'checking') {
      return `
        <div class="${cls}">
          <span class="glyph s-unchecked" aria-hidden="true">↻</span>
          <div><p class="headline">Checking…</p></div>
        </div>`;
    }

    if (this.#state === 'failed' || !this.#outcome) {
      return `
        <div class="${cls}">
          <span class="glyph s-unchecked" aria-hidden="true">${GLYPH['unchecked']}</span>
          <div>
            <p class="headline">We couldn’t finish checking this</p>
            <p class="detail">Something went wrong at our end, not with your credential.</p>
            <p class="action">Try again in a moment.</p>
          </div>
        </div>`;
    }

    const o = this.#outcome;
    // The severity is announced because colour alone must not carry it. When
    // the headline already says the same word, saying it twice is noise.
    const spoken = severityPrefix(o.severity, o.headline);
    return `
      <div class="${cls}">
        <span class="glyph s-${o.severity}" aria-hidden="true">${GLYPH[o.severity]}</span>
        <div>
          <p class="headline">${spoken}${esc(o.headline)}</p>
          <p class="detail">${esc(o.detail)}</p>
          ${o.action ? `<p class="action">${esc(o.action)}</p>` : ''}
        </div>
      </div>
      `;
  }

  #footHtml(): string {
    // Verification that stopped early has no per-check list to open, but it
    // was still checked, and the card should say so.
    const toggle = this.#checks.length
      ? `<button id="toggle" type="button" aria-expanded="${this.#detailsOpen}" aria-controls="checks">
           ${this.#detailsOpen ? 'Hide details' : 'Show details'}
         </button>`
      : '';
    return `
      <div class="foot">
        <span>Checked just now</span>
        ${toggle}
      </div>
      ${this.#detailsOpen ? `<div class="checks" id="checks">${this.#checks.map(checkHtml).join('')}</div>` : ''}`;
  }
}

/**
 * The severity, said out loud, unless the headline already says it. Colour
 * never carries the message alone — but neither should a screen reader user
 * hear "Verified. Verified."
 */
const severityPrefix = (severity: string, headline: string): string => {
  const label = SEVERITY_LABEL[severity] ?? '';
  if (!label || headline.toLowerCase().startsWith(label.toLowerCase())) return '';
  return `<span class="sr-only">${label}: </span>`;
};

const announce = (severity: string, headline: string): string => {
  const label = SEVERITY_LABEL[severity] ?? '';
  const prefix = headline.toLowerCase().startsWith(label.toLowerCase()) ? '' : `${label}. `;
  return `${prefix}${esc(headline)}.`;
};

const checkHtml = (c: Check): string => `
  <div class="check">
    <span class="k">${esc(c.label)}</span>
    <span class="v">
      <span class="mark s-${c.severity}" aria-hidden="true">${GLYPH[c.severity]}</span>
      <span><span class="sr-only">${CHECK_LABEL[c.severity]}: </span>${esc(c.value)}</span>
    </span>
  </div>`;

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );

if (!customElements.get('verifier-credential')) {
  customElements.define('verifier-credential', VerifierCredential);
}
