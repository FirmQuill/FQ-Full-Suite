# Full Suite team workflows

These workflows run on the company's existing Full Suite server. None calls an outside service or requires an AI provider.

## Purchase requests and three-way matching

An account with the **Purchasing** ERP area and purchasing write role can open **Purchase requests**, record a requested item or service, quantity, estimated unit cost and need-by date. Owners and assigned company managers with **Purchasing** can approve or decline. An approved request can then be linked to a visible existing purchase order. The requestor can withdraw a pending request. Reviewing and linking never create a purchase order or post anything in the books.

**Three-way purchase match** compares purchase-order, receiving and bill snapshots by their recorded relationships and line IDs. It distinguishes no receipt, no bill, partially matched quantities, fully matched quantities/values, and variances. A bill with multiple receipts without explicit allocation is a variance to review, and vendor credits/returns are not netted into the comparison. The workflow never marks a vendor bill as paid, approves payment, or changes historical ledger postings.

## Project templates, Kanban, and dependencies

Open **Project tracker → Project templates**. An owner can save a company-visible checklist of ordinary task titles, date offsets, and optional predecessor line numbers. Do not include confidential material in reusable templates. For example:

```text
Plan count | 0
Count assigned pallets | 2 | 1
Review discrepancies | 5 | 2
```

An owner or department project manager can start a project from a template in an eligible department. This creates a new project with unassigned ordinary tasks at the computed dates. It does not copy staff, private tasks, or access grants.

Open **Kanban task board** within a visible project to see Open, In progress, and Done columns. Use **Edit / move task** to change status. In the task form, predecessors must be visible ordinary tasks in the same project and department. Cycles are rejected. Linked predecessors must be done before starting or completing a successor. Permission checks apply to both the list and board.

## Employee time off

The owner enables **Time off** under the employee’s portal feature settings. It is separate from **Time**, preserving existing feature choices at upgrade. The employee can send a date-range request or withdraw it while pending. Approvals and declines are under **Time off review** in the main portal. The owner and the employee’s currently assigned direct manager (with the **Employee records** area) can review. Changing managers changes which managers can see the worker’s requests. The employee can see their request status and review note. Do not include medical details.

This is request tracking only: not accrual accounting, shifts, leave-law adjudication, payroll deductions, or payments. An approved request does not post hours. Existing encrypted Full Suite recovery protects these database records; the Lite-compatible portable books format does not transfer team-specific records, templates, or task dependencies.
