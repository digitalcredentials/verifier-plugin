/**
 * <verifier-credential> — shows a credential and whether it still holds up.
 *
 * A web component, provisionally. See requirements.md §2: the wallet is meant
 * to be swappable, and this is cheap to turn into a React component later if
 * the plugin interface lands somewhere else.
 *
 * It sits behind a shadow root, so it cannot use the surrounding app's router
 * or dialogs. Everything it offers has to work inside the component — which is
 * why the three views are switched in place here rather than opened in a modal.
 *
 * Attributes
 *   (none required; set `credential` as a property)
 *
 * Properties
 *   credential             the credential object to show and check
 *   registries             optional override of the registries to consult
 *   registriesUnavailable  set when the host couldn't get its registries: the
 *                          issuer isn't looked up, and the card says the list
 *                          didn't load, rather than checking a default list
 *                          and calling a listed issuer unlisted. Use this, not
 *                          `registries = []`: an empty list is one that names
 *                          nobody, so the issuer reads as not on it
 *
 * Events
 *   verification-started   { credential }
 *   verification-complete  { outcome, checks, response }
 *   verification-failed    { error }
 */
import { type Registry } from './verify.js';
export declare class VerifierCredential extends HTMLElement {
    #private;
    constructor();
    set credential(value: Record<string, unknown> | undefined);
    get credential(): Record<string, unknown> | undefined;
    set registries(value: Registry[] | undefined);
    get registries(): Registry[] | undefined;
    set registriesUnavailable(value: boolean);
    get registriesUnavailable(): boolean;
    connectedCallback(): void;
}
