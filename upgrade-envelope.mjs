// Compact JWE, using the fixed protected profile below. Only the signed
// activation payload is inside; no feed, identity or entitlements in headers.
import {constants,createDecipheriv,privateDecrypt} from 'node:crypto';

export const envelopeMax=8192;
const signedMax=4096;
const header='eyJhbGciOiJSU0EtT0FFUC0yNTYiLCJlbmMiOiJBMjU2R0NNIiwidHlwIjoiYXBwbGljYXRpb24vZnEtdXBncmFkZS12MSJ9';
function decode(part){
  if(!part||!/^[A-Za-z0-9_-]+$/.test(part))throw Error();
  const bytes=Buffer.from(part,'base64url');
  if(bytes.toString('base64url')!==part)throw Error();
  return bytes;
}
export function unwrapUpgradeLicense(raw,key){
  if(typeof raw!=='string'||raw.length>envelopeMax||!key)throw Error();
  const [h,w,n,c,tag,...extra]=raw.trim().split('.');
  if(h!==header||extra.length)throw Error();
  const wrapped=decode(w),nonce=decode(n),ciphertext=decode(c),auth=decode(tag);
  if(wrapped.length!==key.asymmetricKeyDetails.modulusLength/8||nonce.length!==12||
    !ciphertext.length||ciphertext.length>signedMax||auth.length!==16)throw Error();
  const cek=privateDecrypt({key,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},wrapped);
  let first,last,plaintext;
  try{
    if(cek.length!==32)throw Error();
    const aes=createDecipheriv('aes-256-gcm',cek,nonce,{authTagLength:16});
    aes.setAAD(Buffer.from(h,'ascii'));aes.setAuthTag(auth);
    first=aes.update(ciphertext);last=aes.final();plaintext=Buffer.concat([first,last]);
    return new TextDecoder('utf-8',{fatal:true}).decode(plaintext);
  }finally{cek.fill(0);first?.fill(0);last?.fill(0);plaintext?.fill(0);}
}
