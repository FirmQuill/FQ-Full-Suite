// Presentation only: callers provide the existing authorized routes.
export const groups=Object.freeze([
 ['workspace','Workspace',['Overview','Directory','Departments','History'],'Open your company overview and shared directory.'],
 ['sales','Sales & purchasing',['Sales','Purchasing','Purchase requests'],'Manage customers, vendors, and purchasing.'],
 ['finance','Finance & reporting',['Accounting','Banking','Reports','Report builder','Month-end close'],'Work with your permitted books, reports, and close tasks.'],
 ['operations','Operations',['Jobs & time','Warehouse','Assembly','Fixed assets','Planning','Assets & pallets','Inventory audit','Project tracker'],'Track projects, stock, assets, and operations.'],
 ['hr','HR',['Employee records','Benefits administration','Payroll','Time off review','Time clock kiosk'],'Access available employee, time, benefits, and payroll tools.'],
 ['collaboration','Collaboration',['Messages','Collaboration groups','Company knowledge','Drives'],'Work with colleagues and authorized shared information.'],
 ['administration','Administration',['Approvals','User access','Identity connectors','Audit trail','Company setup','Portable transfers','Managed backups','Version Upgrade','Packages','Migration workspace'],'Manage authorized settings, access, and maintenance.'],
 ['help','Help',['Setup help'],'Read the public setup guide or available help.']
]);
const derivedWorkflow=Object.freeze({'Purchase requests':'Purchasing','Month-end close':'Accounting','Report builder':'Reports'});
export function workflowOnSidebar(page,featured,businessModules){
 const required=Object.hasOwn(derivedWorkflow,page)?derivedWorkflow[page]:businessModules.includes(page)?page:null;
 return !required||Array.isArray(featured)&&featured.includes(required);
}
export function visibleNavigation(routes,{canCreateCompany=false}={}){
 const available=new Set(routes),categorized=new Set(groups.flatMap(([, ,pages])=>pages)),fallback=[...available].filter(p=>!categorized.has(p));
 return groups.map(([id,title,pages,description])=>({id,title,description,links:[...pages,...(id==='administration'?fallback:[])].filter(p=>available.has(p)),canCreateCompany:id==='administration'&&canCreateCompany})).filter(g=>g.links.length||g.canCreateCompany);
}

const esc=s=>String(s).replace(/[&<>"']/g,x=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[x]));
export function navigationGroupMarkup(g,{open=true,active=false,links='',create='' }={}){
 return `<div class="navgroup"><div class="navgroup-head"><button type="button" data-act="nav-section" data-key="${esc(g.id)}"${active?' aria-current="page" class="active"':''}>${esc(g.title)}</button><button type="button" class="nav-chevron" data-act="nav-fold" data-key="${esc(g.id)}" aria-label="${open?'Collapse':'Expand'} ${esc(g.title)}" aria-expanded="${open}" aria-controls="nav-${esc(g.id)}">${open?'▾':'▸'}</button></div><div id="nav-${esc(g.id)}" class="navgroup-links"${open?'':' hidden'}>${links}${create}</div></div>`;
}
