export const legacyAgreement = {version:"1.0", hash:"e64e33190ae5ec7cc8449b5e510c374533f30903a485c27af247cda9c5db6726"};
export async function agreementHash(text) {
 const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text.replace(/\r\n?/g,'\n')));
 return Array.from(new Uint8Array(bytes), b=>b.toString(16).padStart(2,'0')).join('');
}
