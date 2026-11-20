# PGPlanWorkbench

Free, open-source PostgreSQL execution-plan review application. Inspect the plan. Test the change. Verify the result.

## Install and run

Application version: **1.0.0**. Source is available; a versioned GitHub Release and hosted release-gate validation are not yet published. Local validation is not a security certification.

Download the complete source ZIP using GitHub's **Code → Download ZIP**, or clone the repository. Extract it and open a terminal in the folder containing `package.json`. Individual files are not a runnable download. Use Node.js 24 and npm.

### macOS — Terminal

Install Node.js 24 with npm from [nodejs.org](https://nodejs.org/). Download and extract the complete source ZIP. Replace the path below with your extracted folder:

```sh
cd "$HOME/Downloads/PGPlanWorkbench-main"
node --version
npm --version
npm ci --ignore-scripts
npm run build
npm run preview -- --host 127.0.0.1 --port 4189 --strictPort
```

### Windows — PowerShell

Install Node.js 24 with npm from [nodejs.org](https://nodejs.org/), then open a new PowerShell window. Extract the ZIP and replace the path below with the folder containing `package.json`. Use `npm.cmd` to avoid PowerShell script-policy issues; no policy change is needed.

```powershell
Set-Location "$env:USERPROFILE\Downloads\PGPlanWorkbench-main"
node --version
npm.cmd --version
npm.cmd ci --ignore-scripts
npm.cmd run build
npm.cmd run preview -- --host 127.0.0.1 --port 4189 --strictPort
```

Open http://127.0.0.1:4189/ and keep the terminal running. Do not open `index.html` using a `file://` URL. For development use `npm run dev -- --host 127.0.0.1` instead.

Stop with Ctrl+C. If port 4189 is occupied, use `--port 4190` and open the matching address. An ENOENT/package.json error means the terminal is in the wrong folder. Node/npm are needed on the build machine; no PostgreSQL installation or database credentials are required to run the app.

## Production hosting — macOS or Windows build machine

The commands above run a local preview of a production build, not a production server. For organizational deployment:

1. Use a reviewed, versioned source revision and the same locked install/build commands above on either operating system.
2. Deploy only the contents of `dist/` to an organization-approved HTTPS static web server, at the domain root. Do not expose source directories, `.git`, dependencies or local plans. Current absolute asset/license paths are not configured for subdirectory hosting.
3. Configure JavaScript module/worker MIME types and these response headers on the real host:

```text
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
```

4. Configure authentication/access restrictions where required, prevent stale HTML caching, and verify Plan, Grid, Findings, Validate Fix and license links in supported browsers. Review worker loading and headers at the actual HTTPS origin; preview headers do not configure your web server.
5. Keep the prior reviewed `dist/` deployment to roll back atomically. Never include browser history or exported plans in deployment backups.

The web-server product and operating-system service configuration are deployment-specific and not automated by this repository. Follow your organization's security approval process. See [Vite static deployment guidance](https://vite.dev/guide/static-deploy.html); do not use `vite preview` as a production hosting service.

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

Released as free, open-source software under the [PostgreSQL License](LICENSE). Existing copyright notices are preserved.

### Thanks to PEV2 and Dalibo

PGPlanWorkbench uses **[PEV2 1.25.0](https://github.com/dalibo/pev2)**, the PostgreSQL execution-plan visualization library maintained by **Dalibo and its contributors**. Thank you for making this visualization foundation available to the PostgreSQL community.

PEV2 powers the graphical plan workspace. PGPlanWorkbench adds evidence-led findings and before/after validation around it. Our version-guarded build transform batches layout measurements and adjusts the dense-tree zoom floor; these are local integration changes, not upstream features. This project does not imply endorsement by Dalibo or the PEV2 contributors.

See [Third-Party Notices](public/THIRD_PARTY_NOTICES.md) for PEV2's license and other acknowledgements.

## Technology

React and TypeScript provide the application interface; Vue and PEV2 provide plan visualization. Zod validates imported evidence. Vite builds the app; Bootstrap, Font Awesome and IBM Plex provide supporting styles, icons and fonts. Exact resolved versions are recorded in `package-lock.json`.

## Feedback

Use [GitHub Issues](https://github.com/saisrinivase/PGPlanWorkbench/issues) for bugs and suggestions. Share steps and expected behavior, not production plans, database identifiers, credentials or unredacted screenshots. Prefer a reproduction generated from a disposable local database.
