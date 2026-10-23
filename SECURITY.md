# Security Policy

## Reporting a vulnerability

Use GitHub private vulnerability reporting: **Security → Report a vulnerability** on
https://github.com/Lincoln504/pi-research/security/advisories/new. Please do not open a
public issue for a suspected vulnerability.

Include the affected version, a description of the impact, and reproduction steps. Reports
are acknowledged on a best-effort basis; this is a single-maintainer project.

## Supported versions

Only the latest published release on npm (`@lincoln504/pi-research`) receives fixes.

## Threat model

pi-research reads untrusted web content (search results, scraped pages, PDFs, video
transcripts, advisories) with an LLM that holds tools. The relevant boundaries:

- **Researcher sessions have no `bash`, `write` or `edit` tool.** They have `search`,
  `scrape`, `security_search`, `stackexchange`, `youtube_transcript` and `read`.
- **`read` is confined to the project (working) directory**, with symlinks resolved. It
  refuses well-known secret files and credential directories (`.env*`, `*.pem`, `*.key`,
  SSH/GPG keys, `.npmrc`, `.netrc`, `.git-credentials`, `.ssh/`, `.aws/`, `.git/`, …), and it
  refuses entirely when the working directory is a home directory or a filesystem root.
  To remove it altogether, set `PI_RESEARCH_DISABLED_TOOLS=read` (or `--exclude-tools read`).
- **`scrape` blocks private, loopback and link-local addresses** (SSRF), pinning the
  resolved IP at connect time. It cannot block a public attacker-controlled host, so the
  scrape tool and the file-read tool are deliberately not combined without confinement.
- **Untrusted-content framing is prompt-level.** Scraped text, search results, Stack
  Exchange, YouTube and `security_search` output carry an "untrusted data, not
  instructions" notice; researcher, router and synthesizer prompts carry the same
  directive; the final report, knowledge-store results and CLI output handed to the host
  agent are prefixed with it (and flagged `untrusted: true` in tool details / `--json`).
  This reduces, but does not eliminate, prompt-injection risk. Treat research output as
  untrusted input in the host agent.
- **Dependency audit.** `npm audit --omit=dev` runs on every push and release
  (`docs/AUDIT-GATE.md`). npm `overrides` in this package do not reach consumers, so releases before 1.7.18 needed a
  consumer-side override for a transitive `sharp` advisory; from 1.7.18 the affected dependency is
  bundled without it and nothing needs overriding (details in that document).
