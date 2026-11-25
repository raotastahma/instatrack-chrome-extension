# InstaTrack Extension

A Chrome Manifest V3 extension for comparing manually collected Instagram follower and following lists. I built the extension with AI assistance, including the dashboard, local data model, collection workflow and automated tests.

The source includes the complete extension runtime, test suite, packaging scripts, an optional telemetry relay and an entirely fictional offline demo. Account histories remain in browser-local storage. Manual synchronization depends on Instagram's current page structure and an authenticated user session; this repository does not claim official Instagram support or guarantee future compatibility.

## Try the offline demo

Requires Node.js 20 or later. There are no npm dependencies.

```sh
node demo/offline.mjs
```

The demo compares two synthetic account lists using the same analytics code as the extension, checks the detected changes, validates an importable backup and writes a CSV report. No Instagram account, browser login or network connection is needed. All handles beginning with `demo.` are fictional. The generated [backup](demo/synthetic-backup.json) can be imported from the dashboard to explore the UI without syncing.

## Run the extension

```sh
cd extension
npm run check
npm test
npm run package
```

Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select `extension/dist/followers-tracker-pro`. Click the extension action to open the dashboard. Use **Import backup** with the fictional demo backup first. Sync is a separate manual action that opens Instagram and reads the currently signed-in account's relationship lists.

`npm run package` also creates a release ZIP in `extension/dist`. The unpacked development artifact is labeled `dev`; the ZIP retains its release label. Packaging requires `/usr/bin/zip`.

## Structure

- `extension/src/content`: Instagram page collection and progress handling.
- `extension/src/background`: account isolation, local persistence, sync coordination and telemetry consent.
- `extension/src/domain`: normalization, relationship deltas, history, report and backup validation.
- `extension/src/dashboard`: accessible dashboard and local import/export controls.
- `extension/test`: Node-based unit, simulated browser, packaging and relay tests.
- `site/api/events.mjs`: optional strict telemetry relay with credentials supplied only through environment variables.
- `demo`: synthetic input lists, importable backup and report.

## Portfolio configuration

The primary runtime and all 244 existing tests are retained. Private account lists, operational logs, browser state, screenshots, the superseded command-line tool and deployment credentials are excluded. Test handles and contact details were made fictional. The telemetry endpoint and privacy-site URLs use reserved `.invalid` domains so this copy cannot send events to the original service. Optional telemetry remains opt-in; deployment requires deliberately configuring your own endpoint and reviewing the privacy copy. Public Chrome Web Store links refer to the existing product, not a publishing instruction for this copy.

No open-source license has been selected. Dependency-free application code and bundled original extension icons are included; Instagram and Chrome names remain their owners' trademarks.

See [verification](docs/verification.md) for tested scope and limits.
