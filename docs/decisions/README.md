# Architecture Decision Records

Numbered, immutable-once-accepted records of significant decisions. To change a decision, add a
new ADR that supersedes the old one (and mark the old one `Superseded by ADR-NNNN`).

| #                                                             | Title                                                            | Status            |
| ------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------- |
| [0001](0001-technology-stack-and-versions.md)                 | Technology stack and pinned versions                             | Accepted          |
| [0002](0002-monorepo-layout-and-tooling.md)                   | Monorepo layout and workspace tooling                            | Accepted          |
| [0003](0003-prd-relocation-and-agent-instructions.md)         | Relocate the PRD; concise AGENTS.md                              | Accepted          |
| [0004](0004-i18n-and-rtl.md)                                  | Internationalisation and RTL/LTR                                 | Accepted          |
| [0005](0005-auth-and-admin-identity-separation.md)            | Customer auth and separate admin identity                        | Accepted (design) |
| [0006](0006-modular-monolith-and-data-conventions.md)         | Modular monolith boundaries and data conventions                 | Accepted          |
| [0007](0007-testing-strategy.md)                              | Testing strategy and tools                                       | Accepted          |
| [0008](0008-branching-ci-and-review.md)                       | Branching, CI gates and review                                   | Accepted          |
| [0009](0009-api-conventions-validation-errors-pagination.md)  | API conventions: zod validation, errors, pagination, request ids | Accepted          |
| [0010](0010-structured-logging-and-redaction.md)              | Structured logging and redaction                                 | Accepted          |
| [0011](0011-security-headers-cors-and-rate-limiting.md)       | Security headers, CORS and rate limiting                         | Accepted          |
| [0012](0012-openapi-from-zod.md)                              | OpenAPI generated from zod                                       | Accepted          |
| [0013](0013-design-system.md)                                 | Design system: shadcn/ui primitives on Radix, themes, fonts      | Accepted          |
| [0014](0014-frontend-data-layer.md)                           | Frontend data layer: fetch client, TanStack Query, error codes   | Accepted          |
| [0015](0015-browser-end-to-end-tests.md)                      | Browser end-to-end tests with Playwright                         | Accepted          |
| [0016](0016-architecture-boundary-check.md)                   | Architecture boundary check                                      | Accepted          |
| [0017](0017-identity-data-model.md)                           | Identity data model                                              | Accepted          |
| [0018](0018-email-password-authentication.md)                 | Email/password registration and sign-in                          | Accepted          |
| [0019](0019-csrf-and-deny-by-default-authentication.md)       | CSRF protection and deny-by-default authentication               | Accepted          |
| [0020](0020-web-authentication-pages-and-route-protection.md) | Web authentication pages and client-side route protection        | Accepted          |
| [0021](0021-email-verification-and-transactional-email.md)    | Email verification and the transactional email foundation        | Accepted          |

New ADRs: copy [`TEMPLATE.md`](TEMPLATE.md), use the next number, open it in the same PR as the change.
