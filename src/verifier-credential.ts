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
import { summarise, listChecks, type Check, type Outcome } from './outcomes.js';
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
  .check { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0;
           font-size: .9rem; border-bottom: 1px solid var(--vp-rule, #d9dee7); }
  .check:last-child { border-bottom: 0; }
  .check .v { display: inline-flex; gap: 6px; align-items: flex-start; text-align: right; font-weight: 500; }
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
  #checks: Check[] = [];
  #detailsOpen = false;
  /** A credential is waiting for a run that hasn’t happened yet. */
  #pending = false;
  /** Identifies the newest run, so a slow earlier one cannot overwrite it. */
  #runId = 0;

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
    this.#outcome = undefined;
    this.#checks = [];
    this.#detailsOpen = false;

    if (!value) {
      // Clearing the credential clears the verdict with it. Leaving the last
      // one on screen would attach a verdict to a credential that is gone.
      this.#pending = false;
      this.#state = 'empty';
      this.#runId++;
      this.#render();
      return;
    }

    this.#pending = true;
    if (this.isConnected) void this.#run();
  }

  get credential(): Record<string, unknown> | undefined {
    return this.#credential;
  }

  set registries(value: Registry[] | undefined) {
    this.#registries = value;
    if (!this.#credential) return;
    // The registries decide whether we can confirm the issuer, so changing
    // them changes the answer. Re-check rather than keep a stale verdict.
    this.#pending = true;
    if (this.isConnected) void this.#run();
  }

  get registries(): Registry[] | undefined {
    return this.#registries;
  }

  connectedCallback(): void {
    // A credential can be set while the element is detached — React does
    // exactly that on remount — so the work waits here, not in the setter.
    if (this.#pending && this.#credential) void this.#run();
    else this.#render();
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
    const meta = [summary.issuerName, issued].filter(Boolean).join(' · ');

    this.#card.innerHTML = `
      <p class="title">${esc(summary.title)}</p>
      ${summary.recipient ? `<p class="who">${esc(summary.recipient)}</p>` : ''}
      ${meta ? `<p class="meta">${esc(meta)}</p>` : ''}
      ${this.#verdictHtml()}
    `;

    if (shouldAnnounce) this.#say(this.#spokenResult());

    const toggle = this.#card.querySelector<HTMLButtonElement>('#toggle');
    toggle?.addEventListener('click', () => {
      this.#detailsOpen = !this.#detailsOpen;
      // Opening the details is not a new result, so it must not re-announce.
      this.#render({ announce: false });
      this.#card.querySelector<HTMLButtonElement>('#toggle')?.focus();
    });
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

  #verdictHtml(): string {
    if (this.#state === 'checking') {
      return `
        <div class="verdict">
          <span class="glyph s-unchecked" aria-hidden="true">↻</span>
          <div><p class="headline">Checking…</p></div>
        </div>`;
    }

    if (this.#state === 'failed' || !this.#outcome) {
      return `
        <div class="verdict">
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
      <div class="verdict">
        <span class="glyph s-${o.severity}" aria-hidden="true">${GLYPH[o.severity]}</span>
        <div>
          <p class="headline">${spoken}${esc(o.headline)}</p>
          <p class="detail">${esc(o.detail)}</p>
          ${o.action ? `<p class="action">${esc(o.action)}</p>` : ''}
        </div>
      </div>
      ${this.#checks.length ? this.#footHtml() : ''}`;
  }

  #footHtml(): string {
    return `
      <div class="foot">
        <span>Checked just now</span>
        <button id="toggle" type="button" aria-expanded="${this.#detailsOpen}" aria-controls="checks">
          ${this.#detailsOpen ? 'Hide details' : 'Show details'}
        </button>
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
    <span>${esc(c.label)}</span>
    <span class="v">
      <span class="mark s-${c.severity}" aria-hidden="true">${GLYPH[c.severity]}</span>
      <span><span class="sr-only">${SEVERITY_LABEL[c.severity]}: </span>${esc(c.value)}</span>
    </span>
  </div>`;

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );

if (!customElements.get('verifier-credential')) {
  customElements.define('verifier-credential', VerifierCredential);
}
