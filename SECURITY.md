# Security Policy

## Supported Versions

| Version | Supported          |
|---------|--------------------|
| 2.x.x   | :white_check_mark: |
| < 2.0   | :x:                |

## Reporting a Vulnerability

If you discover a security vulnerability in pi-research, please report it to us responsibly.

**Do not** open a public issue for security vulnerabilities.

### How to Report

Please send an email to the project maintainer with details about the vulnerability:

1. Describe the vulnerability clearly
2. Provide steps to reproduce (if applicable)
3. Include any relevant code snippets or logs
4. Suggest a fix if you have one

We will:
- Acknowledge receipt of your report within 48 hours
- Investigate the issue promptly
- Provide regular updates on our progress
- Notify you when we release a fix

### Security Best Practices

When using pi-research:

- Never commit API keys, secrets, or sensitive data to version control
- Use environment variables for configuration (see `.env.example`)
- Keep dependencies updated by running `npm audit` regularly
- Review the code before loading the extension
- Be cautious when using Tor or proxy features

### Dependency Security

This project uses npm for dependency management. To check for known vulnerabilities:

```bash
npm audit
npm audit fix
```

### Code of Conduct

Security researchers who follow responsible disclosure will not face legal action for their findings. We appreciate your help in keeping pi-research secure.
