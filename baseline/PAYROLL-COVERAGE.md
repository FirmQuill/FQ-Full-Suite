# U.S. payroll coverage

**0.1.0-preview.2 · tax year 2026 · reviewed sources on November 25, 2026**

**Final payroll coverage is 0 of 51 state-level jurisdictions.** The static rules module supports limited federal calculations for synthetic worksheets. Independent payroll review, full jurisdiction determination, production tax documents and bank-file validation are outstanding. A selected state, a blank locality, a manual override or an approved time entry cannot release a final payroll file. Every other tax year is blocked.

## Federal evidence and verification status

| Jurisdiction | Year | Rule or document | Implemented evidence | Final output |
|---|---|---|---|---|
| US | 2026 | Social Security and Medicare, regular covered wages | Calculates each side from distinct supplied wage bases and prior calendar-year wages of this employer. Enforces the Social Security cap. Calculates the employee-only Additional Medicare amount. Exact integer arithmetic, half-up to cents per tax. | Blocked |
| US | 2026 | W-4 from 2020 onward, Pub. 15-T Worksheet 1A | Calculates federal withholding for ordinary resident employees paid regular wages. Supports three filing statuses, both Step 2 schedules, annual Steps 3, 4(a), 4(b), and per-period 4(c). Seven pay frequencies. | Blocked |
| US | 2026 | Form 941, revision March 2026 | Actual form and instructions identified. No completed substitute form, quarterly exception processing or field-level validation. | Blocked |
| US | 2026 | W-2 and W-3 | Annual instructions identified. Wage boxes, employee copies, substitute-form acceptance and electronic file specifications lack end-to-end validation. | Blocked |
| US | 2026 | 940 and applicable Schedule A | FUTA wage treatment, employer credits, credit reductions, form revision and scenarios unverified. | Blocked |
| US | 2026 | 943, 944 and other employer-specific returns or corrections | Employer applicability and required form generation unverified. | Blocked |
| US banks | 2026 | ACH payroll credits, PPD | Public Nacha field layout identified. Originator/ODFI-specific specifications, controls, test file acceptance and file generator unverified. | Blocked |

The 2026 Social Security rate is 6.2% for each side up to $184,500. Medicare is 1.45% per side on covered wages. Only the employee pays the additional 0.9% above $200,000 paid by this employer during the year. Wage classifications, multi-employer successor scenarios, third-party sick pay, exempt categories, tips and employer-paid employee taxes need additional treatment. [IRS Form 941 instructions](https://www.irs.gov/instructions/i941), [SSA contribution and benefit base](https://www.ssa.gov/OACT/COLA/cbb.html).

Worksheet 1A inputs must be explicit, including zero-valued W-4 elections. Legacy W-4s, nonresident withholding adjustments, exemption claims, irregular and supplemental checks, and determination of which earnings and deductions enter each tax base remain open. The routine accepts a 2026 pay date through December 31 inclusive. The period-end work date alone cannot select a tax year. [IRS Publication 15-T](https://www.irs.gov/publications/p15t).

The IRS quarterly return and year-end instructions are separate verification targets. Matching one tax calculation does not validate a completed tax form. The public Nacha guide describes the record structure and notes that the originating bank may require a different Immediate Origin value. Bank approval has not been obtained. [2026 Form 941](https://www.irs.gov/pub/irs-pdf/f941.pdf), [W-2 and W-3 instructions](https://www.irs.gov/instructions/iw2w3), [employment tax return overview](https://www.irs.gov/faqs/small-business-self-employed-other-business/forms-940-941-944-and-1040-sch-h-employment-taxes), [Nacha file details](https://achdevguide.nacha.org/ach-file-details).

## State-level form and verification register

Each row records at least one employer form or electronic report identified at the issuing agency. The year is the target payroll year. Some agency pages cover multiple years. The register identifies work to verify and does not certify the complete list of obligations or the effective revision for any individual employer. Each row still needs applicable income withholding, unemployment, employer-specific rates, paid leave/disability, annual and corrected reports, local discovery, official examples and independent review. A state without a general wage income tax still needs employer-report discovery.

| Jurisdiction | Target year | Identified form or report | Final output | Evidence |
|---|---|---|---|---|
| AK | 2026 | TQ01C quarterly contribution report | Blocked | [Agency guidance](https://www.labor.alaska.gov/estax/forms/toc_forms.htm) |
| AL | 2026 | A-1 quarterly, A-3 annual reconciliation | Blocked | [Agency guidance](https://www.revenue.alabama.gov/individual-corporate/withholding-tax-2/) |
| AR | 2026 | AR941M monthly voucher, AR941A annual report | Blocked | [Agency guidance](https://www.dfa.arkansas.gov/wp-content/uploads/withholdInstructions_2026.pdf) |
| AZ | 2026 | A1-QRT quarterly withholding | Blocked | [Agency guidance](https://azdor.gov/forms/withholding-forms/arizona-quarterly-withholding-tax-return) |
| CA | 2026 | DE 9 contribution report and DE 9C employee wage detail | Blocked | [Agency guidance](https://edd.ca.gov/en/payroll_taxes/Due_Dates_Calendar/) |
| CO | 2026 | DR 1094 wage withholding | Blocked | [Agency guidance](https://tax.colorado.gov/DR1094) |
| CT | 2026 | CT-941 quarterly reconciliation, revision 12/25 | Blocked | [Agency guidance](https://portal.ct.gov/-/media/drs/forms/2025/wth/ct-941_1225.pdf?hash=8FE5CA307397293915FA8C04021C2C0A&rev=d2b7a33bd848407894ce805f9ceb5360) |
| DC | 2026 | FR-900Q quarterly return and 2026 bulk file specification | Blocked | [Agency guidance](https://otr.cfo.dc.gov/sites/default/files/dc/sites/otr/publication/attachments/2026%20FR900Q_A_NP%20Bulk%20Filing%20Specs_v2.0_Final_0.pdf) |
| DE | 2026 | WTH-REC annual reconciliation | Blocked | [Agency guidance](https://revenue.delaware.gov/business-tax-forms/) |
| FL | 2026 | RT-6 quarterly reemployment report | Blocked | [Agency guidance](https://www.floridarevenue.com/taxes/tips/Documents/TIP_2673B-01.pdf) |
| GA | 2026 | G-7 quarterly return for monthly payers | Blocked | [Agency guidance](https://dor.georgia.gov/document/form/tsdwithholdingquarterlyreturnformonthlypayersg7mpdf/download) |
| HI | 2026 | HW-14 quarterly withholding | Blocked | [Agency guidance](https://tax.hawaii.gov/geninfo/a2_b2_4empl_whhold_employee/) |
| IA | 2026 | Quarterly withholding return | Blocked | [Agency guidance](https://revenue.iowa.gov/taxes/file-my-taxes/business-taxes/filing-frequency-return-due-dates) |
| ID | 2026 | Form 910 withholding | Blocked | [Agency guidance](https://tax.idaho.gov/taxes/income-tax/withholding/withholding-filing/filing-form-910/) |
| IL | 2026 | IL-941 withholding return | Blocked | [Agency guidance](https://tax.illinois.gov/forms/withholding/currentyear.html) |
| IN | 2026 | WH-1 state and county withholding | Blocked | [Agency guidance](https://www.in.gov/dor/i-am-a/business-corp/withholding/) |
| KS | 2026 | KW-5 deposit report, KW-3 annual withholding | Blocked | [Agency guidance](https://www.ksrevenue.gov/efilingoptions.html) |
| KY | 2026 | K-1 withholding, K-3 annual reconciliation | Blocked | [Agency guidance](https://revenue.ky.gov/Forms/42A003-March%202026.pdf) |
| LA | 2026 | L-1 quarterly withholding | Blocked | [Agency guidance](https://revenue.louisiana.gov/businesses/widely-used-tax-types/withholding/) |
| MA | 2026 | M-941 withholding return | Blocked | [Agency guidance](https://www.mass.gov/info-details/form-m-941-instructions-tax-return-of-income-taxes-withheld) |
| MD | 2026 | MW506 employer withholding | Blocked | [Agency guidance](https://services.marylandcomptroller.gov/taxes/en/employer-withholding?id=kb_article_view&sys_kb_id=30050b3a1b5f1a506cba8593604bcb06) |
| ME | 2026 | 941ME quarterly withholding | Blocked | [Agency guidance](https://www.maine.gov/revenue/sites/maine.gov.revenue/files/inline-files/26_941ME_instructions.pdf) |
| MI | 2026 | 5080 periodic return, 5081 annual return | Blocked | [Agency guidance](https://www.michigan.gov/taxes/business-taxes/sales-use-tax/2026-sales-and-use-tax-forms) |
| MN | 2026 | Quarterly or annual withholding return | Blocked | [Agency guidance](https://www.revenue.state.mn.us/sites/default/files/2025-12/wh-inst-26.pdf) |
| MO | 2026 | MO-941 employer withholding | Blocked | [Agency guidance](https://dor.mo.gov/forms/MO-941.pdf) |
| MS | 2026 | 89-140 annual information return for applicable paper filers | Blocked | [Agency guidance](https://www.dor.ms.gov/sites/default/files/tax-forms/business/89700251revised1.13.2026.pdf) |
| MT | 2026 | MW-3 annual reconciliation | Blocked | [Agency guidance](https://revenue.mt.gov/taxes/withholding-tax/wage-withholding-returns-and-payments) |
| NC | 2026 | NC-5 and NC-5Q depending on filing frequency | Blocked | [Agency guidance](https://www.ncdor.gov/taxes-forms/withholding-tax/withholding-tax-forms-and-instructions) |
| ND | 2026 | Form 306 withholding | Blocked | [Agency guidance](https://www.tax.nd.gov/income-tax-withholding-deadlines) |
| NE | 2026 | 941N quarterly withholding | Blocked | [Agency guidance](https://revenue.nebraska.gov/about/tax-calendar) |
| NH | 2026 | Quarterly Tax and Wage Report | Blocked | [Agency guidance](https://www.nhes.nh.gov/forms/documents/quarterly-tax-wage-report.pdf) |
| NJ | 2026 | NJ-927 quarterly employer report, WR-30 wage report | Blocked | [Agency guidance](https://nj.gov/labor/ea/employer-services/rate-info/) |
| NM | 2026 | Wage withholding tax return, employee quarterly wage and withholding report | Blocked | [Agency guidance](https://www.tax.newmexico.gov/businesses/withholding-tax-and-workers-compensation/) |
| NV | 2026 | RPT3795 quarterly report and NEW0098 wage report | Blocked | [Agency guidance](https://ui.nv.gov/ESSHTML/Handbook/Employer_Handbook%28Published%29.pdf) |
| NY | 2026 | NYS-45 quarterly combined return | Blocked | [Agency guidance](https://www.tax.ny.gov/bus/wt/duedates.htm) |
| OH | 2026 | IT 941 annual employer withholding, SD 141 school district reconciliation | Blocked | [Agency guidance](https://tax.ohio.gov/business/employer-withholding/employer-withholding) |
| OK | 2026 | WTH10001 wage withholding | Blocked | [Agency guidance](https://oklahoma.gov/tax/helpcenter/businesses.html) |
| OR | 2026 | Form OQ combined quarterly report | Blocked | [Agency guidance](https://www.oregon.gov/dor/forms/FormsPubs/combined-payroll_211-155-2_2026.pdf) |
| PA | 2026 | W-3 quarterly withholding | Blocked | [Agency guidance](https://www.pa.gov/agencies/revenue/resources/tax-types-and-information/employer-withholding) |
| RI | 2026 | RI-941 quarterly return | Blocked | [Agency guidance](https://tax.ri.gov/forms/business-tax-forms/withholding-tax-forms) |
| SC | 2026 | WH-1605 Q1–Q3, WH-1606 Q4/annual | Blocked | [Agency guidance](https://www.dor.sc.gov/withholding) |
| SD | 2026 | Reemployment Assistance quarterly contribution and wage report | Blocked | [Agency guidance](https://dlr.sd.gov/ui/forms.aspx) |
| TN | 2026 | Quarterly unemployment wage report | Blocked | [Agency guidance](https://lwdsupport.tn.gov/hc/en-us/articles/41544930827027-Frequently-Asked-Questions-FAQ-Employers) |
| TX | 2026 | Quarterly unemployment wage and tax report | Blocked | [Agency guidance](https://www.twc.texas.gov/sites/default/files/ui/docs/txus-wage-report-and-and-payment-file-specifications-twc.pdf) |
| UT | 2026 | TC-941E withholding return | Blocked | [Agency guidance](https://tax.utah.gov/forms/current/tc-941einst.pdf) |
| VA | 2026 | VA-16 quarterly reconciliation | Blocked | [Agency guidance](https://www.business.tax.virginia.gov/eforms/eformsEntry/VA16) |
| VT | 2026 | WHT-436 quarterly reconciliation | Blocked | [Agency guidance](https://tax.vermont.gov/sites/tax/files/documents/WHT-436%20Instr.pdf) |
| WA | 2026 | Quarterly UI and paid leave / WA Cares wage reports | Blocked | [Agency guidance](https://esd.wa.gov/employer-requirements/quarterly-reports/how-file-your-quarterly-tax-and-wage-reports) |
| WI | 2026 | WT-6 deposit report and WT-7 annual reconciliation | Blocked | [Agency guidance](https://www.revenue.wi.gov/Pages/faqs/pcs-with.aspx) |
| WV | 2026 | IT-101Q quarterly withholding | Blocked | [Agency guidance](https://tax.wv.gov/business/withholding/pages/withholdingtaxforms.aspx) |
| WY | 2026 | WYUI quarterly wage report | Blocked | [Agency guidance](https://dws.wyo.gov/businesses/i-need-help-with-unemployment-insurance-for-my-business/) |

## Local jurisdiction register

These examples identify distinct local withholding and employer-tax workflows. Complete national coverage needs a worksite and residence jurisdiction inventory with stable district IDs, effective boundaries, reciprocal treatment and tax collector/form assignments. A city name or ZIP code by itself cannot establish coverage. Jurisdictions absent from this inventory remain unresolved and blocked.

| Jurisdiction | Year | Rule and document evidence | Final output |
|---|---|---|---|
| New York City, NY | 2026 | NYS-50-T-NYC withholding methods for applicable residence and NYS-45 reporting. [New York tables](https://www.tax.ny.gov/bus/wt/rate.htm), [reporting instructions](https://www.tax.ny.gov/bus/wt/filing_requirements.htm) | Blocked |
| Yonkers, NY | 2026 | Residence and nonresidence require different treatment under NYS-50-T-Y. NYS-45 handles reporting. [2026 Yonkers publication](https://www.tax.ny.gov/pdf/publications/withholding/nys50_t_y.pdf), [reporting instructions](https://www.tax.ny.gov/bus/wt/filing_requirements.htm) | Blocked |
| Philadelphia, PA | 2026 | City Wage Tax quarterly return. Resident and nonresident treatment, effective wage dates and Q4 reconciliation require validation. [Philadelphia Wage Tax](https://www.phila.gov/services/business-self-employment/business-taxes/wage-tax-employers/) | Blocked |
| PA Act 32 participating districts | 2026 | Identify political subdivision and collector, local EIT remittance CLGS-32-5, and any LST obligation, exemption or multiple-employer handling. Each district needs its own verified rule. [EIT remittance form](https://dced.pa.gov/download/act-32-employer-quarterly-local-earned-income-tax-eit-remittance-form-clgs-32-5/), [LST guidance](https://dced.pa.gov/local-government/local-income-tax-information/local-services-tax/) | Blocked |
| Ohio taxing school districts | 2026 | Resolve employee residence, district number, effective rate and applicable SD 101 / SD 141. Municipal obligations require separate determination. [Ohio employer resources](https://tax.ohio.gov/business/employer-withholding/employer-withholding), [school district information](https://tax.ohio.gov/individual/file-now/school-district-income-tax-page) | Blocked |
| TriMet district, OR | 2026 | Worksite-based employer transit payroll tax, Form OQ. District boundaries can split ZIP codes. [TriMet requirements](https://www.oregon.gov/dor/programs/businesses/Pages/TriMet-Transit.aspx) | Blocked |
| Lane Transit District, OR | 2026 | Worksite-based employer transit payroll tax, Form OQ. Validate district attribution for each work location. [2026 combined report instructions](https://www.oregon.gov/dor/forms/FormsPubs/combined-payroll_211-155-2_2026.pdf) | Blocked |
| Any unlisted district or undetermined residence/worksite | All | Collector, applicability, form and valid-through date unresolved. | Blocked |

## Reproducible component checks

Run `node --test tests/payroll-rules.test.mjs` from the extracted package root. Nine component tests passed using synthetic monetary inputs under Node 24.22.3 on Windows. The gate suite includes all 51 state-level codes, unknown codes, missing data, out-of-range years and invalid dates.

- IRS Publication 926 gives $11.16 Social Security withholding on $180 of covered pay. The fixture tests that arithmetic with the taxable-base premise supplied. [IRS Publication 926](https://www.irs.gov/publications/p926).
- Publication 15-A gives $11,439.00 of Social Security tax and $2,816.71 Medicare tax on specified wage bases. The fixture uses the example's already-determined bases. Gross-up calculations remain outside the module. [IRS Publication 15-A](https://www.irs.gov/publications/p15a).
- The IRS threshold example uses $180,000 before a $50,000 payment. The test reapplies this example to the 2026 threshold. $30,000 is subject to the additional tax, yielding $270.00. [IRS Additional Medicare Tax FAQ](https://www.irs.gov/businesses/small-businesses-self-employed/questions-and-answers-for-the-additional-medicare-tax).
- Six federal income withholding examples land exactly on published schedule rows. Additional fixtures exercise W-4 adjustments, Social Security limits, rounding, date and input validation. Source testing covers individual components. Independent end-to-end gross-to-net, stubs, posting, actual forms and ACH acceptance remain outstanding.

## Evidence needed to clear the release gate

For each payroll jurisdiction, record the form edition and authority URL, applicability, effective dates, wage bases, employer and employee taxes, local district IDs, annual and amended reports, validated example results and reviewer disposition. Reconcile individual checks to pay stubs, journal entries and period and year-end form totals. Validate bank-specific file layout and control totals with synthetic records. Until those conditions are met, use only the preview worksheet with synthetic inputs. No submission or transmission is authorized.

