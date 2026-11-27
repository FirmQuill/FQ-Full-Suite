import {termsText} from './terms.mjs';
const article=document.querySelector('#agreement');
for(const [i,part] of termsText.trim().split(/\n\s*\n/).entries()){
 const node=document.createElement(i===0?'h2':'p');node.textContent=part;article.append(node);
}
