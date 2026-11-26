// Fictional generic mapped CSV, NOT samples of native QuickBooks, Wave or ADP headers.
export const fictionalSources={books:{id:'qb-fiction',product:'QuickBooks Online',edition:'Fictional generic mapping; native schema unverified',exportedAt:'2026-11-26',fixtureOnly:true},vendors:{id:'wave-fiction',product:'Wave',edition:'Fictional generic mapping; native schema unverified',exportedAt:'2026-11-26',fixtureOnly:true},payroll:{id:'adp-fiction',product:'ADP RUN',edition:'Fictional generic mapping; native schema unverified',exportedAt:'2026-11-26',fixtureOnly:true}};
export const fictionalBatches=[
 {source:'books',recordType:'accounts',csv:'ID,Name,Target\na-cash,Fictional cash,1000\n',mapping:{sourceId:'ID',name:'Name',targetAccount:'Target'}},
 {source:'books',recordType:'contacts',csv:'ID,Name,Kind\nc1,Fictional Buyer,Customer\n',mapping:{sourceId:'ID',name:'Name',kind:'Kind'}},
 {source:'vendors',recordType:'contacts',csv:'ID,Name,Kind\nv1,Fictional Vendor,Vendor\n',mapping:{sourceId:'ID',name:'Name',kind:'Kind'}},
 {source:'books',recordType:'invoices',csv:'ID,Contact,Date,Dollars,Description\ni1,c1,11/01/2026,100.00,Fictional service invoice\n',mapping:{sourceId:'ID',contactRef:'Contact',date:{column:'Date',transform:'MM/DD/YYYY'},amountCents:{column:'Dollars',transform:'decimalDollars'},description:'Description'}},
 {source:'vendors',recordType:'bills',csv:'ID,Contact,Date,Cents,Description\nb1,v1,2026-11-02,4000,Fictional service bill\n',mapping:{sourceId:'ID',contactRef:'Contact',date:'Date',amountCents:'Cents',description:'Description'}},
 {source:'vendors',recordType:'payments',csv:'ID,Document,Type,Date,Cents,Description\np1,qb-fiction/i1,invoices,2026-11-03,3000,Fictional receipt\np2,b1,bills,2026-11-04,1000,Fictional vendor payment\n',mapping:{sourceId:'ID',documentRef:'Document',documentType:'Type',date:'Date',amountCents:'Cents',description:'Description'}},
 {source:'books',recordType:'openingBalances',csv:'ID,Date,Account,Offset,Cents,Description\nob1,2026-10-31,1000,3000,50000,Fictional opening capital\n',mapping:{sourceId:'ID',date:'Date',account:'Account',offsetAccount:'Offset',amountCents:'Cents',description:'Description'}},
 {source:'payroll',recordType:'historicalEmployees',csv:'ID,Name,State\ne1,Fictional Archived Worker,CO\n',mapping:{sourceId:'ID',name:'Name',state:'State'}},
 {source:'payroll',recordType:'historicalPayroll',csv:'ID,Employee,Date,Gross,Tax,Net\nh1,e1,2026-10-31,200000,30000,160000\n',mapping:{sourceId:'ID',employeeRef:'Employee',date:'Date',grossCents:'Gross',taxCents:'Tax',netCents:'Net'}}
];
