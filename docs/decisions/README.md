# Architecture Decision Records

Numbered, immutable-once-accepted records of significant decisions. To change a decision, add a
new ADR that supersedes the old one (and mark the old one `Superseded by ADR-NNNN`).

| #                                                            | Title                                                            | Status            |
| ------------------------------------------------------------ | ---------------------------------------------------------------- | ----------------- |
| [0001](0001-technology-stack-and-versions.md)                | Technology stack and pinned versions                             | Accepted          |
| [0002](0002-monorepo-layout-and-tooling.md)                  | Monorepo layout and workspace tooling                            | Accepted          |
| [0003](0003-prd-relocation-and-agent-instructions.md)        | Relocate the PRD; concise AGENTS.md                              | Accepted          |
| [0004](0004-i18n-and-rtl.md)                                 | Internationalisation and RTL/LTR                                 | Accepted (stub)   |
| [0005](0005-auth-and-admin-identity-separation.md)           | Customer auth and separate admin identity                        | Accepted (design) |
| [0006](0006-modular-monolith-and-data-conventions.md)        | Modular monolith boundaries and data conventions                 | Accepted          |
| [0007](0007-testing-strategy.md)                             | Testing strategy and tools                                       | Accepted          |
| [0008](0008-branching-ci-and-review.md)                      | Branching, CI gates and review                                   | Accepted          |
| [0009](0009-api-conventions-validation-errors-pagination.md) | API conventions: zod validation, errors, pagination, request ids | Accepted          |
| [0010](0010-structured-logging-and-redaction.md)             | Structured logging and redaction                                 | Accepted          |
| [0011](0011-security-headers-cors-and-rate-limiting.md)      | Security headers, CORS and rate limiting                         | Accepted          |

New ADRs: copy [`TEMPLATE.md`](TEMPLATE.md), use the next number, open it in the same PR as the change.
