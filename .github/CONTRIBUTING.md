# Contributing to Difflens

Thank you for contributing! Please follow these guidelines to keep the project consistent and secure.

## Development Setup
1. Clone the repository: 
2. Install dependencies: 
up to date, audited 74 packages in 1s

18 packages are looking for funding
  run `npm fund` for details

1 low severity vulnerability

To address all issues (including breaking changes), run:
  npm audit fix --force

Run `npm audit` for details.
3. Install Chromium: 
> difflens@1.0.0 setup:browser
> node scripts/install-browser.js

Chromium is already installed:
  /Users/PM0/Library/Caches/ms-playwright/chromium-1254/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing
4. Start the server: 

## Making Changes
1. Create a new branch: 
2. Make your changes
3. Run the smoke test: 
> difflens@1.0.0 smoke
> node scripts/smoke.js


DiffLens smoke test

  ✓ Server responds — Chromium ready
  ✓ Viewport is 1920×1080 — 1920×1080
  ✓ Comparison completed — 4701ms
  ✓ Result has an id — 20261112061600-yfz0dy
  ✓ Differences detected
  ✓ Pixel diff found changes — 21.15% pixels
  ✓ Content diff has hunks — +11 −0 ~18
  ✓ Markup diff found changes — +4 −0 ~23
  ✓ Artifact local.png
  ✓ Artifact staging.png
  ✓ Artifact diff.png
  ✓ Artifact result.json
  ✓ HTML report renders — 1403 KB
  ✓ JSON export downloads
  ✓ Invalid URL is rejected
  ✓ A failing side is reported on its own — Could not load http://127.0.0.1:1/ — page.goto: net::ERR_UNSAFE_PORT at http://127.0.0.1:1/
  ✓ Live session starts — 20261112061606-mztsjl
  ✓ Live layout is 1920×1080 in two 960 px panes
  ✓ Screencast frames stream — 20 KB
  ✓ Clicks mirror across both panes — local → staging
  ✓ Basic Auth stays on its own origin
  ✓ Live session ends on request — requested
  ✓ Ended session is no longer listed

23/23 checks passed
4. Commit your changes: On branch feature/your-feature-name
Untracked files:
  (use "git add <file>..." to include in what will be committed)
	.github/
	difflens/

nothing added to commit but untracked files present (use "git add" to track)
5. Push to your branch: 
6. Open a Pull Request following the template

## Code Style
- Use Prettier for code formatting: 
- Lint:  (if configured)
- Follow the existing code patterns in the repository

## Testing
- All smoke tests must pass before submitting a PR
- Test both static comparison and live session modes
- Verify Basic Auth isolation between sides

## Reporting Issues
Use the issue template above. Include:
- DiffLens version
- OS and browser information
- Steps to reproduce
- Expected vs actual behavior

## Pull Request Process
1. Ensure all tests pass
2. Fill in the PR template
3. Address any review comments
4. Wait for maintainer approval

## License
By contributing, you agree that your contributions will be under the MIT license.
