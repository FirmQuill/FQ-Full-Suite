# Terms and development notices

Keep the “Early Development” label, Early Development Build notice, feedback links and Terms of Service available in future releases, including after launch. Change the terms version only when issuing new terms. Review copies require publisher approval.

Assent remains on the existing server, tied to the signed-in account, approved version and SHA-256 of LF-normalized UTF-8 termsText. The additive terms_acceptance_hashes table preserves the old terms_acceptances table and timestamps. Startup migrates legacy records only when the exact known agreement matches web/legal/consent.mjs. Code-only updates do not change that hash. POST /api/terms requires both version and content hash, with the existing session, role, origin and CSRF checks. No books, account records or worker time are rewritten.

Run the HTTP, consent and browser tests in tests/. The approved text remains web/legal/terms.mjs; keep its Projects page identical. Ship the root LICENSE and THIRD-PARTY-NOTICES.md.
