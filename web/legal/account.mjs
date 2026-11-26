import {termsVersion,termsText} from './terms.mjs';
import {agreementHash} from './consent.mjs';
import {showTerms} from './terms-ui.mjs';

export async function openAccount(payload) {
  if (!payload.termsRequired) return payload;
  return showTerms(async () => {
    if (payload.termsRequired !== termsVersion) throw Error('Terms changed. Reload to read the new agreement.');
    let response;
    try {
      response = await fetch('/api/terms', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: {'Content-Type':'application/json', 'X-CSRF-Token':payload.csrf},
        body: JSON.stringify({version:termsVersion,hash:await agreementHash(termsText)})
      });
    } catch {
      throw Error('Could not confirm your agreement. Reconnect and try again.');
    }
    const result = await response.json();
    if (!response.ok || !result.user) {
      throw Error((result.error || 'Could not confirm your agreement.') + ' Reload to sign in again or retry.');
    }
    return result;
  });
}
