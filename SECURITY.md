# Security policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it through GitHub's private vulnerability reporting instead: go to the
**Security** tab of this repository → **Report a vulnerability**. That opens a
private channel visible only to the maintainers, and it works without you
needing an email address for the project — Wyrhta Labs does not run one yet, so
this is the only supported channel.

If you cannot use that form, open a normal issue that says only *"security
report, please open a private channel"* — with **no** technical detail — and you
will be invited to a private advisory.

## What to expect

This is a one-maintainer project developed in the open, pre-1.0. There is no
on-call rotation and no service level agreement. Realistically:

- **Acknowledgement:** within a week.
- **Assessment and a plan:** within two weeks of acknowledgement.
- **Fix:** as fast as severity warrants, released as a normal tagged version.

You will be credited in the advisory unless you ask not to be.

## Scope

In scope: anything in this repository that affects the confidentiality,
integrity, or availability of a deployment — authentication and authorization
bypasses, injection, secret leakage, privilege escalation between household
members or between services, and unsafe defaults that a reasonable operator
would not notice.

Out of scope:

- Findings that require an attacker who already holds the deployment's secrets,
  database, or host.
- Missing hardening that the documentation already calls out as the operator's
  responsibility (for example `CORS_ORIGIN=*`, which every `.env.example` marks
  as development-only).
- Vulnerabilities in third-party dependencies with no exploitable path here —
  report those upstream; Dependabot already tracks them.
- Anything about the maintainer's own household deployment rather than the
  published code.

## Supported versions

Pre-1.0, only the latest tag on `main` is supported. There are no backports.

## Security model, in one paragraph

Every Wyrhta Labs service is meant to be **self-hosted on a private network**
and to hold real household data. Secrets live only in a deployment's `.env` or
its secret store, never in a repository. Services authenticate each other with
per-service credentials — never a shared secret — and the MCP surface holds no
credential of its own: it forwards the caller's own key, so an MCP tool can do
exactly what that caller could already do over HTTP, and no more. A finding that
breaks any of those statements is a finding worth reporting.
