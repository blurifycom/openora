# Security Policy

This project is a real-money igaming platform. Vulnerabilities here can put
player funds, personal data, and operator compliance at risk. We take security
reports seriously and ask that you disclose them responsibly.

## Supported versions

Security fixes are applied to the latest released line. Older lines are not
patched - upgrade to a supported version before reporting.

| Version         | Supported   |
| --------------- | ----------- |
| latest (`main`) | yes         |
| previous minor  | best effort |
| older           | no          |

## Reporting a vulnerability

Please report privately. Do **not** open a public issue, pull request, or
discussion for a suspected vulnerability.

Preferred: use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
("Report a vulnerability" under the repository's Security tab).

Alternatively, email **security@oss.dev** with:

- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- affected version/commit,
- any suggested mitigation.

## Response expectations

| Stage                                | Target                                 |
| ------------------------------------ | -------------------------------------- |
| Acknowledgement of report            | within 3 business days                 |
| Initial assessment / severity triage | within 7 business days                 |
| Fix or mitigation plan               | within 30 days for high/critical       |
| Coordinated disclosure               | after a fix ships, by mutual agreement |

We will keep you informed throughout and credit you in the advisory unless you
prefer to remain anonymous.

## Scope

In scope:

- The platform core in this repository (API, modules, SDKs, adapters, plugin host).
- Authentication, session handling, tenant isolation (RLS), and admin guards.
- Money-handling paths (wallet, bonus, compliance) and event/job integrity.

Out of scope:

- Vendor adapters and downstream consumer repositories (report to their owners).
- Issues requiring a misconfigured deployment outside the documented defaults.
- Findings in third-party dependencies without a demonstrated impact here
  (report upstream; tell us if it affects this repo materially).

## Safe harbor

Good-faith research that respects this policy, avoids privacy violations and
service disruption, and does not exfiltrate data beyond what is needed to prove
the issue will not result in legal action from us.
