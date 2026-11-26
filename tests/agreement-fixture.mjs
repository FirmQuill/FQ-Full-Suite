import {createHash} from 'node:crypto';
import {termsVersion,termsText} from '../web/legal/terms.mjs';

export const receipt={version:termsVersion,hash:createHash('sha256').update(termsText.replace(/\r\n?/g,'\n')).digest('hex')};

export async function acceptIfRequired(page){
  await page.waitForFunction(()=>document.querySelector('.terms-sheet[open], .toolbar, #refresh') || [...document.querySelectorAll('#login .error')].some(e=>e.textContent));
  const agree=page.locator('.terms-sheet[open]').getByRole('button',{name:'I agree to the Terms of Service',exact:true});
  if(await agree.isVisible())await agree.click();
}
