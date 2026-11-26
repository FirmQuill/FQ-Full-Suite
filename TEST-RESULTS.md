# FirmQuill Full Suite verification

Version 0.4.0-preview.1, locally verified on Windows on November 26, 2026 using Node 24.22.3 and Microsoft Edge 158.0.4370.33.

The complete source suite passed **170 tests, 0 failures, 0 skips** on the verified operating-desks upgrade branch. This includes the original accounting, employee, identity, migration, setup, agent and recovery suites; department/project permission checks; asset/audit history and stock reconciliation; cross-edition desk conversion; and explicit external private-manual retrieval and offline checks. All test records are fictional.

Independent copied-runtime verification passed **17 tests, 0 failures, 0 skips** against the 90-file public build, including real browser flows, fresh setup/retry, shutdown with unused browser connections, completion of accepted setup writes, and a five-company existing Harborline workspace upgrade, restart and encrypted recovery. All 89 runtime manifest hashes matched before and after verification. Public help contains only the five setup articles and twelve setup screenshots. No private article or private workflow screenshot bytes are distributed.

The companion Lite source passed **56 tests, 0 failures, 0 skips**, including a real cached-shell upgrade followed by offline operation with the same vault and Terms acceptance. No production business database was opened or changed. The startup launcher, Terms text, recovery cryptography and payroll implementation remain unchanged.

Run source checks from this checkout with the installed Edge and Playwright paths, the fictional existing-workspace fixture path, and optional explicitly external private manual path configured:

    node --test --test-concurrency=2 --test-timeout=120000 tests/*.test.mjs lite-tests/core.test.mjs lite-tests/interop.test.mjs lite-tests/payroll-rules.test.mjs lite-tests/vault.test.mjs

The full customer manual, feature inventory, permission matrix, workflow instructions, screenshots and support index are maintained in the separate private knowledge-base repository. Runtime building remains an explicit allowlist through scripts/build-public-release.mjs. No merge, deployment or GitHub release is part of this upgrade.
