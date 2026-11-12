# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.0.0   | :white_check_mark: |

## Reporting Vulnerabilities

Please report security vulnerabilities via GitHub Security Advisories or by emailing security@praveen.dev.

### What to Include

- DiffLens version number
- Steps to reproduce the vulnerability
- Platform (OS, browser version)
- Any credentials or tokens involved (remove actual secrets before reporting)

### Our Process

1. All security vulnerabilities will be acknowledged within 48 hours.
2. A full fix will be released within 2 weeks.
3. Security fixes will be released as patch versions (e.g., 1.0.1).

## Code of Conduct

This project follows the [Contributor Convenant](https://www.contributor-covenant.org/version/2/1/code-of-conduct/). Please review the full text before contributing.

## Security Best Practices

### For Users
- Always use per-side Basic Auth credentials that match your server
- Never share auth credentials in public issues or discussions
- Keep DiffLens updated to the latest version
- Use the default  binding for local development

### For Contributors
- Never commit credentials, API keys, or secrets to the repository
- Use environment variables for sensitive configuration
- Review the  handler in  for proper auth handling
- Ensure Basic Auth credentials are not leaked between the local and staging sides
- Run 
> difflens@1.0.0 smoke
> node scripts/smoke.js


DiffLens smoke test

  ✓ Server responds — Chromium ready
  ✓ Viewport is 1920×1080 — 1920×1080
  ✓ Comparison completed — 4612ms
  ✓ Result has an id — 20261112061625-hriho8
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
  ✓ Live session starts — 20261112061632-xgh2al
  ✓ Live layout is 1920×1080 in two 960 px panes
  ✓ Screencast frames stream — 20 KB
  ✓ Clicks mirror across both panes — local → staging
  ✓ Basic Auth stays on its own origin
  ✓ Live session ends on request — requested
  ✓ Ended session is no longer listed

23/23 checks passed to verify all functionality after changes

## Vulnerability Categories

- **Critical**: Remote code execution, credential leakage, arbitrary file access
- **High**: Improper input validation, DOM-based XSS in live session
- **Medium**: Information disclosure, session fixation
- **Low**: Minor cosmetic issues, documentation gaps

Security issues will be prioritized based on the above categories.

