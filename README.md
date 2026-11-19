# PGPlanWorkbench

Free, open-source PostgreSQL execution-plan review application. Inspect the plan. Test the change. Verify the result.

## Run locally

Download the complete source ZIP using GitHub's **Code → Download ZIP**, or clone the repository. Extract it and open a terminal in the folder containing `package.json`. Individual files are not a runnable download. Use Node.js 24 and npm.

```sh
npm ci --ignore-scripts
npm run build
npm run preview -- --host 127.0.0.1 --port 4189 --strictPort
```

Open http://127.0.0.1:4189/ and keep the terminal running. Do not open `index.html` using a `file://` URL. For development use `npm run dev -- --host 127.0.0.1` instead.

## Use

Prepare an execution plan from a disposable local database, paste it into the application, and inspect the plan and evidence-backed findings. Compare a representative after-plan to validate a proposed change. No database connection is configured by this application.

Do not commit plans, SQL captures, database identifiers, credentials, screenshots containing data, or analysis exports. Imported evidence may be sensitive. Review retention and export choices before use; browser-local storage is not an organizational security boundary.

## Evidence limits

Findings distinguish measured evidence from hypotheses and missing context. Regression checks do not establish independent diagnostic accuracy or production-wide benefit. No production accuracy percentage or security certification is claimed.

## Acceptance and local data

DBA acceptance is reported by the project owner; no independently measured accuracy percentage is published. Verify equivalent query results separately. Repeated-run thresholds are screening rules, not statistical confidence or production-wide proof.

Analysis runs in browser workers; the application does not connect to PostgreSQL or send plans to AI providers. Plans are not saved by default. Explicitly saved cases retain raw input in that browser profile for the selected period; expiry is enforced when history is opened. Exports can contain identifiers and expressions. Redaction removes evidence too and requires human review; anonymity is not guaranteed.

Use an isolated browser profile for sensitive work and follow your organization's policy. Never post plans or reports in issues. External documentation links visit third-party websites when followed. Dependency installation requires npm access. For hosting, operators must verify HTTPS, access control and security headers. Vite preview is for local inspection, not hardened production hosting.

## Package contents

Only application source, required icons/notices, build helpers and locked dependency metadata are included. No captured plans, demonstration database contents, test reports or previous Git history are included. Validation tooling is maintained outside this minimal application package. Build output is generated locally.

## License and attribution

PostgreSQL License. Existing attribution and third-party notices are retained in LICENSE and public/THIRD_PARTY_NOTICES.md.
