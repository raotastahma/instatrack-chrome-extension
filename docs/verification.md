# Verification

Checked on 2026-11-25 using Node.js 25.9 on macOS.

| Check | Primary baseline | Portfolio copy |
|---|---|---|
| Runtime policy and manifest checks | Pass | Pass |
| Automated tests | 244 passed | 244 passed |
| ZIP and unpacked package generation | Pass | Pass |
| Synthetic offline demo and validated backup | Not present | Pass |
| Redacted Gitleaks directory scan | Not used as publication evidence | No leaks found |

There are no npm dependencies to audit. Tests cover account isolation, input/backup validation, CSV formula handling, telemetry consent, reset/deletion races, collection progress and packaging. They use simulated DOM/browser fixtures and injected network functions. No live Instagram collection or Chrome Web Store submission was performed for this package. Real Instagram compatibility, store approval, and production telemetry deployment are outside this verification.
