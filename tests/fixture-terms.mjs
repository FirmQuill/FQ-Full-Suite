// Test-only explicit assent for fictional fixture accounts. Production never imports this file.
import {createHash} from 'node:crypto';
import {termsVersion,termsText} from '../web/legal/terms.mjs';
export const fixtureAgreement={version:termsVersion,hash:createHash('sha256').update(termsText.replace(/\r\n?/g,'\n')).digest('hex')};
export function seedFixtureTerms(db){
  db.prepare('INSERT OR IGNORE INTO terms_acceptance_hashes(account_id,version,content_hash,accepted_at) SELECT id,?,?,? FROM accounts').run(fixtureAgreement.version,fixtureAgreement.hash,'2026-11-26T00:00:00.000Z');
}
export async function acceptFixtureBrowser(page){
  await page.waitForFunction(()=>document.querySelector('.terms-sheet[open],.toolbar,.portal-tabs'));
  if(await page.locator('.terms-sheet[open]').isVisible())await page.getByRole('button',{name:'I agree to the Terms of Service',exact:true}).click();
}
