// Employee and owner portals share only inert rendering, not service permissions.
export const escapeKnowledge=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
export function knowledgeMeta(r){return escapeKnowledge([r.category,...r.tags].filter(Boolean).join(' · '));}
export function knowledgeText(body){return body.split(/\r?\n\r?\n/).map(para=>'<p>'+escapeKnowledge(para).replace(/\r?\n/g,'<br>')+'</p>').join('');}
export function employeeKnowledgeContent(data){
 const e=escapeKnowledge;
 if(!data)return '<section class="card"><h2>Company knowledge</h2><p>Loading published company articles…</p></section>';
 if(data.error)return '<section class="card"><h2>Company knowledge</h2><p role="alert">'+e(data.error)+'</p></section>';
 if(data.article){const r=data.article;return '<section class="card"><button data-knowledge-article="">Back to articles</button><h2>'+e(r.title)+'</h2><p class="muted">'+knowledgeMeta(r)+'</p>'+knowledgeText(r.body)+'</section>';}
 return '<section class="card"><h2>Company knowledge</h2><p>Published articles written by your company.</p><form id="company-knowledge-search"><label>Search articles<input name="query" type="search" maxlength="160" value="'+e(data.query||'')+'"></label><p class="error" role="alert"></p><button>Search</button></form>'+
  (data.articles?.map(r=>'<article class="shift"><h3>'+e(r.title)+'</h3><p class="muted">'+knowledgeMeta(r)+'</p><button data-knowledge-article="'+e(r.id)+'">Read article</button></article>').join('')||'<p>No published articles match.</p>')+
  (data.more?'<p>Showing 60 results. Search to narrow the list.</p>':'')+'</section>';
}
