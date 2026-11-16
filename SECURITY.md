# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately through [GitHub Security Advisories](https://github.com/rzbdz/better-boardlab/security/advisories/new).
Do not open a public issue containing an unpatched vulnerability, credentials, private infrastructure details, or an
exploit against a live lab.

Include the affected version or revision, the security impact, reproduction steps, and any suggested mitigation.
Remove secrets and sensitive host information from logs and screenshots. Reports are handled on a best-effort basis;
no response or remediation time is guaranteed.

## Deployment boundaries

boardd is designed for trusted lab networks. It does not provide built-in user authentication, and clients with access
can perform board operations and configured host-side actions. Keep its default loopback binding unless you have an
appropriate access-control layer, and protect remote HTTP(S) access with an authenticating reverse proxy.

Board locks coordinate users and automation; they are not an authorization boundary. Treat slot scripts, SDK recipes,
board-host credentials, and release sources as privileged configuration. The detailed threat model and credential
handling notes are in [docs/security.md](docs/security.md).
