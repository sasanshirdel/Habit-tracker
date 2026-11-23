MASTER PRODUCT & ENGINEERING PROPOSAL

Personal Productivity & Performance Intelligence Platform

Document Type: Product Requirements Document (PRD) + Technical Architecture + Engineering Execution Plan
Status: Final Baseline Specification
Product Name: TBD
Development Model: AI-Agent-Assisted, GitHub-Centered, Iterative Development
Architecture: Scalable Modular Monolith
Product Type: Bilingual SaaS + Installable Progressive Web Application (PWA)

---

1. PRODUCT VISION

1.1. Vision

Build a premium, intelligent, bilingual personal productivity and performance platform that helps individuals build better habits, achieve meaningful goals, organize their lives, improve focus, and understand their personal performance.

The product must go significantly beyond a traditional habit tracker.

It should combine:

- Habit Tracking
- Goal Management
- Task Management
- Daily and Weekly Planning
- Focus Management
- Journaling and Quick Capture
- Personal Analytics
- Performance Intelligence
- AI Coaching
- Accountability
- Notifications
- SaaS Subscription Management

The long-term objective is to create a reliable, intelligent personal performance ecosystem that becomes an essential tool in users' daily lives.

1.2. Core Product Philosophy

The product must be built around the following principles:

1. Simplicity: Everyday actions must be fast and intuitive.
2. Consistency: Help users develop sustainable routines.
3. Intelligence: Convert collected data into useful insights.
4. Personalization: Adapt recommendations to individual behavior.
5. Accountability: Help users understand and improve their performance.
6. Privacy: Users must control their personal information.
7. Reliability: Data integrity and system availability are critical.
8. Scalability: Architecture must support future growth without unnecessary rewrites.
9. Accessibility: Support keyboard navigation, assistive technologies, and responsive layouts.
10. Continuous Improvement: Build an extensible platform that can evolve over time.

1.3. Target Platforms

- Desktop browsers
- Mobile browsers
- Installable PWA
- Android PWA experience
- iOS PWA experience where supported

The initial product must be a responsive web application and installable PWA, not a native Android or iOS application.

Native applications may be introduced later if platform limitations make them necessary.

---

2. PRODUCT DESIGN AND USER EXPERIENCE

2.1. Design Direction

Use APEX Habit (https://apexhabit.app/) as a visual and interaction reference for the habit-tracking experience.

The goal is to reproduce the general design quality, simplicity, and useful interaction patterns, not copy proprietary assets, branding, source code, or exact visual compositions.

The product should feel:

- Premium
- Minimal
- Modern
- Calm
- Elegant
- Highly usable
- Data-oriented without feeling overwhelming

Avoid unnecessary visual complexity.

2.2. Design System

Dark Theme

Suggested initial tokens:

- Main background: #101010
- Primary surface: #181818
- Secondary surface: #222222
- Elevated surface: #292929
- Primary text: #F5F2EA
- Secondary text: muted neutral tones
- Accent: #D6B45B
- Borders: #303030

Light Theme

Suggested initial tokens:

- Main background: #FBF9F4
- Primary surface: #FFFFFF
- Secondary surface: #F3F0E9
- Primary text: #28251F
- Accent: #A9802C

All colors must be centralized in design tokens.

Do not hardcode colors across individual components.

Typography

- English: Inter
- Persian: Vazirmatn

Interface Requirements

- Full RTL and LTR support.
- Theme switching.
- Consistent spacing and typography.
- Responsive components.
- Accessible contrast.
- Proper loading, empty, error, success, and disabled states.
- Skeleton loading where appropriate.
- Subtle transitions and animations.
- Touch-friendly mobile controls.
- Consistent iconography.

2.3. Main Application Navigation

Suggested desktop navigation:

- Overview
- Habits
- Goals
- Tasks
- Planner
- Focus
- Journal
- Insights
- AI Coach
- Settings

On mobile, use an optimized navigation system with a bottom navigation bar or another suitable compact pattern.

The exact information architecture should be validated during implementation.

---

3. CORE PRODUCT MODULES

3.1. HABIT TRACKING

This is the primary product module.

Habit Management

Users must be able to:

- Create habits.
- Edit habits.
- Archive habits.
- Restore archived habits.
- Delete habits.
- Reorder habits.
- Categorize habits.
- Add descriptions.
- Select icons and colors.
- Set start and end dates.
- Define targets.
- Define preferred times.
- Configure reminders.
- Link habits to goals.

Habit Types

Support:

1. Binary habits: completed or not completed.
2. Numeric habits: water intake, pages read, repetitions.
3. Duration habits: meditation minutes, workout duration.
4. Frequency habits: several occurrences per week.
5. Negative habits: avoiding an undesirable behavior.
6. Custom measurable habits.

Each habit type must have appropriate input controls and completion logic.

Scheduling

Support:

- Daily schedules.
- Selected weekdays.
- Weekly frequency targets.
- Monthly schedules.
- Custom intervals.
- Flexible recurring schedules.
- Start and end dates.
- Temporary pauses.
- Vacation periods.
- Grace-day configurations.

Habit Occurrence Status

Each scheduled occurrence must support:

- Completed
- Missed
- Due
- Skipped
- Paused
- Not Scheduled

The backend must distinguish between an uncompleted occurrence and an occurrence that was never scheduled.

Historical Integrity

Schedule changes must never silently rewrite historical records.

Implement schedule versioning.

When users modify a habit schedule, create a new schedule version with an effective date.

Historical occurrences must retain the schedule rules that applied at the time.

Support authorized historical corrections and record them appropriately.

Streaks and Consistency

Implement:

- Current streak.
- Longest streak.
- Completion rate.
- Weekly consistency.
- Monthly consistency.
- Historical streaks.
- Optional grace-day logic.
- Paused-period handling.

Streak calculation must be deterministic and thoroughly tested.

3.1.1. PRIMARY HABIT INTERFACE: WEEKLY MATRIX

The main habit page must provide a weekly tracking matrix inspired by the interaction model of APEX Habit.

Structure:

- Rows represent active habits.
- Columns represent weekdays.
- Each cell represents one habit occurrence.

Example:

Habit| Mon| Tue| Wed| Thu| Fri| Sat| Sun
Wake up early| ✓| ✓| ✓| ✕| ✓| ✓| ○
Read 10 pages| ✓| ✓| ○| ✓| ✓| ✕| ○
Workout| ✓| ✕| ✓| ✓| ✓| ○| ○

Required interactions:

- One-tap completion.
- Quick status changes.
- Numeric input for measurable habits.
- Duration input for time-based habits.
- Weekly navigation.
- Current-week shortcut.
- Per-habit streak display.
- Per-habit completion percentage.
- Weekly summary.
- Habit detail access.
- Historical editing with permission.
- Filtering and category selection.

The interface must not rely on a cramped desktop-style table on mobile.

Mobile experience should use an appropriate combination of:

- Compact week strips.
- Horizontal scrolling where appropriate.
- Habit cards.
- Optimized touch targets.

The weekly matrix must remain fast and accessible.

Habit History and Details

Each habit must have a dedicated detail page containing:

- Description.
- Schedule.
- Current streak.
- Longest streak.
- Completion percentage.
- Historical calendar.
- Heatmap.
- Trends.
- Notes.
- Related goal.
- Recent activity.

Habit Templates

Provide a template library with categories such as:

- Health
- Fitness
- Learning
- Productivity
- Mindfulness
- Finance
- Personal Development
- Relationships

Users must be able to customize templates before adding them.

Guided Onboarding

Provide an optional onboarding questionnaire that helps users select initial habits and create a realistic starting routine.

Do not overwhelm new users with excessive setup steps.

---

3.2. GOAL MANAGEMENT

Users must be able to create and manage meaningful goals.

Goal Types

- Personal
- Professional
- Financial
- Health
- Learning
- Outcome-based
- Process-based
- Numeric
- Custom

Features

- Goal creation and editing.
- Goal descriptions.
- Start dates.
- Target dates.
- Priority.
- Status.
- Measurable success criteria.
- Milestones.
- Progress tracking.
- Historical progress.
- Goal categories.
- Goal archiving.
- Habit connections.
- Task connections.
- Progress visualizations.

AI Goal Breakdown

AI may help users:

- Break large goals into smaller milestones.
- Identify required habits.
- Create actionable tasks.
- Suggest realistic deadlines.
- Identify potential conflicts.
- Generate weekly action plans.

Any changes to user data require confirmation.

---

3.3. TASK MANAGEMENT

Implement a complete task management module.

Features:

- Create, edit, complete, archive, and delete tasks.
- Subtasks.
- Checklists.
- Due dates.
- Start dates.
- Priority levels.
- Categories.
- Tags.
- Recurring tasks.
- Estimated duration.
- Actual duration.
- Notes.
- Reminders.
- Goal relationships.
- Habit relationships.
- Search and filtering.

Views:

- List
- Calendar
- Kanban

Task status:

- Todo
- In Progress
- Completed
- Cancelled
- Archived

---

3.4. PLANNING SYSTEM

Build a planning environment for daily and weekly execution.

Features:

- Daily planning.
- Weekly planning.
- Eisenhower Matrix.
- Time blocking.
- Calendar views.
- Drag-and-drop scheduling.
- Task scheduling.
- Priority management.
- Estimated duration.
- Available-time awareness.
- Buffer time.
- Schedule conflict detection.
- Daily review.
- Weekly review.
- Planned versus actual performance.

The system should help users distinguish important work from urgent work.

Smart Planning

The system may recommend a daily schedule based on:

- User priorities.
- Task deadlines.
- Available time.
- Estimated task duration.
- Existing calendar events.
- User preferences.
- Historical completion behavior.

Recommendations must remain editable and must not automatically create unrealistic schedules.

---

3.5. FOCUS MANAGEMENT

Implement:

- Pomodoro timer.
- Custom focus durations.
- Break durations.
- Long breaks.
- Distraction-free mode.
- Daily focus targets.
- Focus sessions.
- Session history.
- Task-linked focus sessions.
- Goal-linked focus sessions.
- Focus analytics.

Track:

- Total focus time.
- Number of sessions.
- Average session duration.
- Daily and weekly focus trends.
- Planned versus completed sessions.

---

3.6. JOURNAL AND QUICK CAPTURE

Users need a fast way to capture thoughts and information.

Features:

- Quick notes.
- Daily journal.
- Voice-to-text.
- Tags.
- Search.
- Reminders.
- Calendar-based journal history.
- Mood tracking (optional).
- Energy tracking (optional).
- Stress tracking (optional).
- Journal summaries.
- AI-assisted reflection when explicitly enabled.

Journal content must remain private by default.

AI must not access journal content unless the user has enabled the relevant feature and permissions.

---

3.7. PERFORMANCE INTELLIGENCE

This is one of the product's main differentiators.

Build an analytics engine that converts actual user activity into useful insights.

Dashboard Metrics

Include:

- Overall habit completion.
- Weekly consistency.
- Monthly consistency.
- Active habits.
- Completed occurrences.
- Missed occurrences.
- Skipped occurrences.
- Current streaks.
- Longest streaks.
- Goal completion.
- Task completion.
- Focus time.
- Productivity trends.

Visualizations

- Weekly charts.
- Monthly charts.
- Annual trends.
- Habit heatmaps.
- Category performance.
- Completion trends.
- Goal progress.
- Focus trends.
- Weekday comparisons.
- Time-of-day analysis when timestamps support it.

Intelligence Engine

Identify:

- Strong habits.
- Weak or inconsistent habits.
- Improving trends.
- Declining trends.
- Recurring missed patterns.
- Possible scheduling problems.
- Overloaded schedules.
- Differences between planned and actual work.
- Areas that may benefit from experimentation.

Evidence-Based Insights

Every generated insight should include:

- Description.
- Relevant metric.
- Evidence.
- Time range.
- Confidence level.
- Suggested action.
- Expected measurement of success.

Use confidence levels:

- Low
- Medium
- High

Do not generate high-confidence conclusions from insufficient data.

Do not assign moral judgments or personality labels.

Do not present correlation as causation.

Recommendations

Support recommendation lifecycle:

1. Detected.
2. Presented.
3. Accepted or rejected.
4. Experiment started.
5. Experiment evaluated.
6. Archived.

Users must be able to provide feedback.

Improvement Experiments

Allow users to test behavioral changes.

Each experiment should include:

- Hypothesis.
- Baseline.
- Proposed change.
- Start date.
- End date.
- Success metric.
- Results.
- Conclusion.

Weekly and Monthly Reviews

Generate structured reviews covering:

- Achievements.
- Consistency.
- Improvements.
- Challenges.
- Missed commitments.
- Goal progress.
- Suggested next actions.

Numerical metrics must be calculated by deterministic backend logic, not invented or estimated by the LLM.

---

3.8. AI COACH

Create an intelligent assistant that can understand the user's productivity context.

Capabilities

The AI Coach should be able to:

- Analyze the last 7, 30, or 90 days.
- Explain relevant performance trends.
- Identify strengths and weaknesses.
- Suggest habit adjustments.
- Break down goals.
- Create task suggestions.
- Help with daily planning.
- Generate weekly plans.
- Review completed work.
- Suggest improvement experiments.
- Explain analytics.
- Answer questions about user activity.

Example questions:

- Why has my consistency declined?
- Analyze my last 30 days.
- What are my strongest habits?
- Which habits need attention?
- Help me plan next week.
- Am I allocating enough time to my priorities?
- What should I improve first?

Context Management

AI may access:

- Habits.
- Habit occurrences.
- Goals.
- Tasks.
- Schedules.
- Focus sessions.
- Analytics.
- User preferences.

Journal and other sensitive content must require explicit user permission.

Tool Calling

Implement controlled AI tools for:

- Reading analytics.
- Reading habits.
- Reading goals.
- Reading tasks.
- Suggesting new habits.
- Suggesting tasks.
- Suggesting schedule changes.
- Generating plans.
- Creating experiments.

All tools must enforce authorization and validation.

Any data-changing operation must require user confirmation unless the user has explicitly configured a limited automation permission.

AI Provider Abstraction

Do not tightly couple the application to one AI provider.

Implement a provider abstraction that supports interchangeable compatible providers.

The system should support:

- Model configuration.
- Provider configuration.
- Structured output.
- Tool calling.
- Token tracking.
- Cost tracking.
- Usage limits.
- Rate limiting.
- Retry policies.
- Timeouts.
- Error handling.
- Prompt versioning.
- Conversation history.
- Privacy controls.

Do not expose provider API keys to clients.

---

3.9. NOTIFICATIONS

Support:

- Habit reminders.
- Task reminders.
- Goal reminders.
- Focus reminders.
- Milestone notifications.
- Inactivity reminders.
- Weekly reports.
- Monthly reports.

Channels:

- In-app notifications.
- Web Push.
- Email.

Preferences:

- Quiet hours.
- Timezone.
- Frequency.
- Notification categories.
- Enable/disable individual channels.

Document browser and operating-system limitations, especially iOS PWA push requirements.

---

3.10. ACCOUNTABILITY

Optional accountability functionality.

Features:

- Invite trusted partners.
- Accept or reject invitations.
- Share selected habits.
- Share selected progress information.
- Send encouragement.
- Revoke access.
- Manage relationship permissions.

Never share journal entries or private goals by default.

No public leaderboard should be enabled by default.

---

3.11. USER ACCOUNT AND PERSONALIZATION

Implement:

- Email registration.
- Secure password authentication.
- Email verification.
- Password recovery.
- Google authentication.
- Profile editing.
- Avatar.
- Language preference.
- Timezone.
- Theme preference.
- Notification settings.
- Privacy settings.
- Connected integrations.
- Data export.
- Account deletion.

Use appropriate authentication standards and secure session management.

---

3.12. INTERNATIONALIZATION

The product must support:

- English.
- Persian.

Requirements:

- Full RTL support.
- Full LTR support.
- Localized dates.
- Localized numbers.
- Localized currency.
- Localized validation messages.
- Localized notifications.
- Localized email templates.
- Language-aware navigation.
- Proper Persian typography.
- Correct bidirectional text handling.

Do not implement Persian as a superficial translation layer.

The entire interface must work correctly in both directions.

All user-facing text should use translation dictionaries.

Avoid hardcoded interface strings.

---

3.13. PWA AND OFFLINE EXPERIENCE

Implement a high-quality Progressive Web Application.

Requirements:

- Web App Manifest.
- Service Worker.
- Installability.
- Responsive layouts.
- Offline fallback.
- IndexedDB for appropriate local data.
- Offline habit check-ins.
- Offline task updates.
- Synchronization when connectivity returns.
- Conflict resolution.
- Background synchronization where supported.
- Push notifications where supported.

Data Synchronization

Use an explicit synchronization architecture.

Consider:

- Local operation queue.
- Operation identifiers.
- Idempotent writes.
- Server timestamps.
- Version numbers.
- Conflict detection.
- Conflict resolution rules.
- Retry handling.

Never silently discard user changes.

Document what works offline and what requires an active internet connection.

---

3.14. SAAS SUBSCRIPTION AND BILLING

The application must be designed as a commercial SaaS from the beginning.

Subscription Plans

Initial plan structure:

Free

A useful introductory experience with defined limits.

Pro Monthly

Advanced productivity and intelligence capabilities.

Pro Annual

Annual subscription with configurable pricing.

Optional Lifetime

Can be introduced later if commercially appropriate.

Plan names, prices, limits, and entitlements must be configurable.

Do not hardcode commercial rules throughout the application.

Entitlement System

Implement a centralized entitlement service.

Every protected feature must be checked server-side.

Example entitlement categories:

- Maximum active habits.
- Maximum active goals.
- Advanced analytics.
- AI Coach usage.
- AI monthly quota.
- Journal features.
- Advanced planning.
- Integrations.
- Export capabilities.
- Accountability features.

The frontend must never be the authority for subscription permissions.

Dual Payment Architecture

Support two independent payment channels from the beginning:

1. Iranian payment providers for supported local transactions.
2. International payment providers for supported international transactions.

Use a provider adapter architecture.

Do not couple subscription business logic to a specific gateway.

A payment adapter should implement the appropriate operations supported by its provider, such as:

- Payment initiation.
- Payment verification.
- Transaction lookup.
- Refund.
- Webhook handling.
- Subscription renewal when supported.

Provider capabilities must be explicitly modeled.

Do not assume every provider supports automatic recurring billing.

Currency Handling

Support separate localized price configurations.

Potential currencies:

- IRR / Toman presentation for Iranian customers.
- USD for international customers.

Use integer minor units or an appropriate exact decimal representation.

Never use floating-point arithmetic for financial calculations.

Store:

- Original transaction amount.
- Currency.
- Exchange information if applicable.
- Provider transaction reference.
- Payment status.
- Payment timestamps.

Never silently convert or mix currencies.

Payment Security

- Verify payment status server-side.
- Verify webhook signatures.
- Implement webhook idempotency.
- Prevent duplicate payment processing.
- Never trust success redirects from the frontend.
- Record transaction history.
- Use secure refund workflows.
- Reconcile provider events with internal records.
- Protect payment credentials.

Subscription Lifecycle

Support:

- Trial where applicable.
- Active.
- Past Due.
- Cancelled.
- Expired.
- Suspended.
- Refunded.
- Grace Period.

Handle renewals, cancellations, failures, and entitlement changes.

Customer Billing Portal

Customers should be able to:

- View their plan.
- View subscription status.
- View invoices or payment receipts where available.
- Cancel eligible subscriptions.
- Review billing history.
- Access provider-managed billing functionality when available.

Provider Eligibility

Before activating a payment provider, verify:

- Business-country eligibility.
- Merchant requirements.
- Legal and tax obligations.
- Currency support.
- Settlement capabilities.
- Recurring billing support.
- Refund capabilities.
- Webhook availability.

Never bypass provider restrictions.

---

3.15. SUPER ADMIN DASHBOARD

Create a separate administrative application or securely isolated administrative area.

The owner must have a dedicated administrative identity.

Do not grant administrative privileges to the owner's ordinary customer account.

Owner Dashboard

Overview:

- Total users.
- Active users.
- New registrations.
- Paying customers.
- Active subscriptions.
- Monthly recurring revenue where applicable.
- Annual recurring revenue where applicable.
- Churn.
- Conversion rate.
- Payment success rate.
- AI usage and costs.
- System health.

All financial metrics must use clearly defined calculation rules.

User Management

- Search users.
- Filter users.
- View account status.
- View subscription status.
- Suspend accounts.
- Restore accounts.
- Review support information.
- Manage roles.
- Review appropriate account activity.

Sensitive user content must not be casually exposed to administrators.

Use purpose-based, audited access for any exceptional support access.

Subscription Management

- View subscriptions.
- Search by user.
- Change eligible subscription states.
- Review renewal dates.
- Review payment history.
- Process authorized refunds.
- Handle manual administrative adjustments with an audit trail.

Plan Management

- Create plans.
- Edit plans.
- Activate/deactivate plans.
- Configure prices.
- Configure currencies.
- Configure features.
- Configure quotas.
- Configure plan limits.
- Configure trial rules.

Use versioned configuration where changing a plan could affect existing customers.

Payment Management

- Payment provider status.
- Provider availability.
- Transaction history.
- Failed payments.
- Refund history.
- Webhook processing status.
- Payment reconciliation.
- Payment settings.

Sensitive provider secrets must never be displayed in plaintext.

AI Management

- Configure AI providers.
- Configure available models.
- Configure default model.
- Configure usage limits.
- Configure plan quotas.
- View usage.
- View token consumption.
- View estimated costs.
- View errors.
- Disable an unavailable provider.
- Configure fallback models.

API keys must be stored in a secure secret-management system.

Content and Templates

- Habit templates.
- Categories.
- Translations.
- Help center.
- FAQ.
- Notification templates.
- Email templates.

Support Management

- Support tickets.
- Ticket status.
- Priority.
- Internal notes.
- Responses.
- Issue tracking.

System Management

- Health status.
- Background job status.
- Error logs.
- Audit logs.
- Integration status.
- Configuration.
- Maintenance mode.
- Feature flags.

Administrative actions must be permission-controlled and logged.

---

4. ADMINISTRATIVE SECURITY ARCHITECTURE

Security is a first-class requirement.

4.1. Separate Administrative Identity

Implement separate customer and administrative identities.

The owner should use a dedicated administrative email/account.

The owner account must not automatically be a customer account with an elevated frontend flag.

Use a secure, dedicated administrative authentication flow.

4.2. Multi-Factor Authentication

Require MFA for:

- Owner.
- Super Admins.
- Administrative users with sensitive permissions.

Support secure MFA options such as:

- Passkeys/WebAuthn.
- Authenticator-based TOTP.
- Recovery codes.

Prefer phishing-resistant authentication for the owner.

4.3. Role-Based Access Control

Implement RBAC.

Initial roles:

- Owner.
- Super Admin.
- Billing Admin.
- Support Admin.
- Content Admin.
- Read-Only Analyst.

The Owner has full administrative authority.

Other roles must have only the permissions necessary for their responsibilities.

Do not assume that every future employee should have Super Admin access.

4.4. Backend Authorization

Every administrative API endpoint must verify:

- Authenticated identity.
- Administrative status.
- Required permission.
- Session validity.
- Relevant resource ownership or scope.

Frontend route protection alone is insufficient.

4.5. Sensitive Operations

Require step-up authentication or additional confirmation for high-risk operations:

- Changing owner identity.
- Changing MFA settings.
- Changing payment credentials.
- Changing security settings.
- Creating or promoting privileged administrators.
- Deleting critical data.
- Executing high-value refunds.
- Changing critical billing configurations.

4.6. Secrets Management

Store secrets in a secure server-side secret manager or protected deployment environment.

Never:

- Commit secrets to Git.
- Expose private keys to browser code.
- Return secrets in API responses.
- Log credentials.
- Store secrets in plaintext application tables without appropriate protection.

4.7. Audit Logging

Log security-sensitive administrative events.

Each record should include appropriate information:

- Actor.
- Action.
- Target.
- Timestamp.
- Relevant before/after metadata.
- Request context.
- Outcome.

Protect audit records from ordinary administrative modification.

4.8. Additional Security Controls

Implement:

- Secure cookies.
- CSRF protection where applicable.
- Rate limiting.
- Brute-force protection.
- Input validation.
- Output encoding.
- SQL injection protection.
- XSS protection.
- Secure file handling.
- Dependency scanning.
- Security headers.
- Encryption in transit.
- Appropriate encryption at rest.
- Backups.
- Recovery procedures.
- Session revocation.
- Security monitoring.

Follow OWASP guidance and use secure development practices.

---

5. TECHNICAL ARCHITECTURE

5.1. Architecture Philosophy

Start with a modular monolith.

Do not prematurely introduce microservices.

Maintain clear module boundaries and interfaces so individual modules can be extracted later if justified by scale or operational requirements.

5.2. Recommended Technology Stack

Frontend

- Next.js App Router.
- React.
- TypeScript.
- Tailwind CSS.
- shadcn/ui.
- TanStack Query.
- React Hook Form.
- Zod.
- Recharts or an equivalent visualization library.
- next-intl or a suitable internationalization solution.

Backend

- NestJS.
- TypeScript.
- REST API.
- Prisma ORM.
- PostgreSQL.

Infrastructure

- Redis.
- BullMQ.
- Docker.
- S3-compatible object storage.
- Secure environment configuration.
- CI/CD through GitHub Actions.

Testing

- Vitest or Jest.
- React Testing Library.
- Supertest.
- Playwright.
- Database integration tests.

Use stable, maintained dependencies and document version decisions.

Do not select a library solely because it appears in this proposal. Verify compatibility and current maintenance before adoption.

5.3. Repository Structure

Use a monorepo unless a strong technical reason justifies otherwise.

Suggested structure:

product-platform/
│
├── apps/
│   ├── web/
│   │   ├── app/
│   │   ├── components/
│   │   ├── features/
│   │   ├── hooks/
│   │   ├── lib/
│   │   └── public/
│   │
│   ├── api/
│   │   ├── src/
│   │   │   ├── modules/
│   │   │   ├── common/
│   │   │   ├── config/
│   │   │   └── main.ts
│   │   └── test/
│   │
│   └── worker/
│
├── packages/
│   ├── shared-types/
│   ├── shared-validation/
│   ├── ui/
│   ├── config/
│   └── localization/
│
├── infrastructure/
│   ├── docker/
│   ├── deployment/
│   └── scripts/
│
├── docs/
│   ├── product/
│   ├── architecture/
│   ├── database/
│   ├── api/
│   ├── security/
│   ├── billing/
│   ├── ai/
│   ├── deployment/
│   └── decisions/
│
├── .github/
│   ├── workflows/
│   ├── ISSUE_TEMPLATE/
│   └── pull_request_template.md
│
├── docker-compose.yml
├── README.md
└── package.json

Adjust the structure when implementation evidence justifies doing so.

5.4. Backend Modules

Create well-separated modules:

- Auth
- Users
- Profiles
- Preferences
- Habits
- Habit Schedules
- Habit Occurrences
- Habit Templates
- Goals
- Tasks
- Planning
- Focus
- Journal
- Analytics
- Insights
- Recommendations
- Experiments
- AI Coach
- AI Providers
- Notifications
- Accountability
- Integrations
- Billing
- Payments
- Subscriptions
- Entitlements
- Admin
- Support
- Audit Logs
- System Health

Each module should have clear responsibilities and defined interfaces.

---

6. DATABASE DESIGN

Design a normalized relational schema using PostgreSQL.

Suggested core entities:

Identity and Account

- User
- UserProfile
- UserPreference
- UserSession
- UserRole
- Role
- Permission
- RolePermission
- UserMFA
- RecoveryCode

Habits

- Habit
- HabitCategory
- HabitScheduleVersion
- HabitOccurrence
- HabitCompletion
- HabitNote
- HabitTemplate

Goals

- Goal
- GoalMilestone
- GoalProgress

Tasks and Planning

- Task
- TaskSubtask
- TaskChecklistItem
- TaskCategory
- PlannerBlock
- CalendarEventReference

Focus

- FocusSession
- FocusSettings

Journal

- JournalEntry
- JournalTag
- JournalEntryTag
- MoodRecord

Intelligence

- PerformanceMetric
- AnalyticsSnapshot
- Insight
- Recommendation
- RecommendationFeedback
- ImprovementExperiment
- ExperimentResult

AI

- AIConversation
- AIMessage
- AIUsageRecord
- AIProviderConfiguration
- AIPromptVersion

Notifications

- Notification
- NotificationPreference
- PushSubscription
- EmailDeliveryRecord

Accountability

- AccountabilityInvitation
- AccountabilityRelationship
- SharedProgressPermission

SaaS

- Plan
- PlanVersion
- PlanPrice
- PlanEntitlement
- UserSubscription
- Payment
- PaymentEvent
- PaymentProviderConfiguration
- Coupon
- CouponRedemption
- Invoice
- Refund
- Entitlement

Administration

- AdminIdentity
- AdminAuditLog
- FeatureFlag
- SystemConfiguration
- SupportTicket
- SupportMessage

Integrations

- IntegrationConnection
- IntegrationSyncLog

This is a conceptual entity list, not a requirement to create every table immediately.

The engineering agent must design the actual schema, relationships, indexes, constraints, retention rules, and migrations.

Data Integrity Requirements

- Use proper foreign keys.
- Use database transactions.
- Add appropriate unique constraints.
- Index common queries.
- Prevent duplicate occurrences.
- Preserve historical records.
- Use soft deletion where appropriate.
- Define retention policies.
- Handle timezone conversions correctly.
- Use precise financial data types.
- Avoid storing derived values as the only source of truth.

All schema changes must use version-controlled migrations.

---

7. API DESIGN

Use versioned REST APIs.

Suggested base path:

"/api/v1"

Requirements:

- Consistent response formats.
- Centralized validation.
- Proper HTTP status codes.
- Pagination.
- Filtering.
- Sorting.
- Authentication.
- Authorization.
- Rate limiting.
- Error handling.
- API documentation.
- OpenAPI/Swagger.

All endpoints must enforce server-side authorization.

Do not expose internal database entities indiscriminately.

Use DTOs and validation schemas.

---

8. OFFLINE DATA AND SYNCHRONIZATION ARCHITECTURE

Offline support must be engineered deliberately.

Implement:

- Local IndexedDB persistence.
- Operation queue.
- Client-generated operation identifiers.
- Server-side idempotency.
- Synchronization checkpoints.
- Conflict detection.
- Retry mechanisms.
- Clear synchronization states.

Define explicit conflict rules for:

- Habit completion.
- Task updates.
- Journal edits.
- Schedule modifications.

Do not allow a stale offline client to silently overwrite newer server data.

Sensitive operations, payment actions, and administrative operations must require a trusted online connection.

---

9. INTEGRATIONS

Design integrations as independent adapters.

Potential integrations:

- Google Calendar.
- Google Tasks.
- Google Authentication.
- Email providers.
- AI providers.
- Speech-to-text providers.
- S3-compatible storage.
- Payment providers.
- Health Connect in a compatible future integration.
- Apple Health through an appropriate supported native or bridge architecture.

Each integration should have:

- Connection lifecycle.
- Authorization.
- Token protection.
- Refresh handling.
- Revocation.
- Error handling.
- Sync history.
- Retry strategy.

Do not request excessive OAuth scopes.

---

10. OBSERVABILITY AND OPERATIONS

Implement production-oriented operational tooling.

Requirements:

- Structured logging.
- Error tracking.
- Application monitoring.
- API latency monitoring.
- Database health.
- Background job monitoring.
- Queue monitoring.
- Payment event monitoring.
- AI usage monitoring.
- Uptime monitoring.
- Alerting.
- Backup verification.

Do not log sensitive user content, passwords, access tokens, or payment secrets.

Create documented backup and restoration procedures.

Test restoration, not just backup creation.

---

11. DEVELOPMENT ROADMAP

All product capabilities must be represented in the roadmap.

Development must happen in controlled phases.

Do not attempt to implement the entire product in one giant operation.

Each phase must produce a working, testable, documented increment.

PHASE 0 — PRODUCT DEFINITION AND REPOSITORY FOUNDATION

Deliverables:

- Final architecture document.
- Product requirements.
- Initial information architecture.
- Repository creation.
- Monorepo setup.
- Development environment.
- Docker development setup.
- Environment variable documentation.
- GitHub Actions baseline.
- Coding standards.
- Branch strategy.
- Pull request template.
- Issue templates.
- Initial technical decision records.

Acceptance criteria:

- Repository builds.
- Development environment starts.
- CI runs.
- Documentation is available.
- No secrets are committed.

PHASE 1 — APPLICATION FOUNDATION

Implement:

- Next.js frontend.
- NestJS backend.
- PostgreSQL.
- Prisma.
- Redis.
- Background worker.
- Shared packages.
- Design system.
- Dark and Light themes.
- Responsive layouts.
- Persian and English localization.
- RTL/LTR support.
- API documentation.

Acceptance criteria:

- Both applications run.
- Database migrations work.
- Shared packages compile.
- Both languages render correctly.
- Responsive layout works.
- CI passes.

PHASE 2 — AUTHENTICATION AND USER MANAGEMENT

Implement:

- Registration.
- Login.
- Email verification.
- Password recovery.
- Google authentication.
- User profiles.
- User preferences.
- Session management.
- User account settings.

Security requirements must be implemented before building protected functionality.

PHASE 3 — HABIT TRACKING CORE

Implement:

- Habit CRUD.
- Habit categories.
- Habit types.
- Schedule engine.
- Schedule versioning.
- Habit occurrences.
- Completion logic.
- Streak calculations.
- Weekly matrix.
- Habit details.
- History.
- Templates.
- Mobile experience.

This phase must receive extensive unit and integration testing.

PHASE 4 — GOALS, TASKS, AND PLANNING

Implement:

- Goals.
- Milestones.
- Tasks.
- Subtasks.
- Task views.
- Eisenhower Matrix.
- Daily planner.
- Weekly planner.
- Calendar.
- Time blocking.
- Habit and goal relationships.

PHASE 5 — FOCUS AND JOURNAL

Implement:

- Pomodoro.
- Focus sessions.
- Focus analytics.
- Quick capture.
- Journal.
- Tags.
- Voice-to-text integration.
- Optional mood and energy records.

PHASE 6 — ANALYTICS AND PERFORMANCE INTELLIGENCE

Implement:

- Deterministic metrics engine.
- Performance dashboard.
- Habit trends.
- Goal analytics.
- Task analytics.
- Focus analytics.
- Heatmaps.
- Comparative analytics.
- Insight detection.
- Recommendation lifecycle.
- Improvement experiments.
- Weekly and monthly reviews.

PHASE 7 — AI COACH

Implement:

- AI provider abstraction.
- Model configuration.
- Conversation management.
- Context retrieval.
- Structured outputs.
- Tool calling.
- Analytics queries.
- Goal breakdown.
- Habit recommendations.
- Planning assistance.
- Confirmation workflows.
- Usage tracking.
- Cost controls.
- Privacy settings.

PHASE 8 — PWA AND NOTIFICATIONS

Implement:

- Manifest.
- Service Worker.
- Install experience.
- Offline storage.
- Offline check-ins.
- Sync queue.
- Conflict resolution.
- Push notifications.
- In-app notifications.
- Email notifications.
- Notification preferences.

PHASE 9 — SAAS, BILLING, AND PAYMENTS

Implement:

- Plans.
- Prices.
- Entitlements.
- Subscription lifecycle.
- Iranian payment adapter.
- International payment adapter.
- Webhook verification.
- Payment reconciliation.
- Customer billing portal.
- Coupons.
- Refund workflows.
- Billing history.
- Subscription administration.

Payment provider integration must remain configurable.

Do not hardcode one provider into the business logic.

PHASE 10 — SUPER ADMIN AND SECURITY HARDENING

Implement:

- Dedicated owner identity.
- Separate admin authentication.
- MFA.
- RBAC.
- Admin dashboard.
- User management.
- Subscription management.
- Payment administration.
- AI management.
- Content management.
- Support management.
- System health.
- Audit logs.
- Security monitoring.

Conduct an explicit authorization review before production.

PHASE 11 — ACCOUNTABILITY AND ADVANCED INTEGRATIONS

Implement:

- Accountability invitations.
- Shared progress permissions.
- Trusted partner functionality.
- Google Calendar integration.
- Google Tasks integration.
- Additional supported integrations.
- Advanced reporting.

PHASE 12 — QUALITY ASSURANCE AND PRODUCTION LAUNCH

Perform:

- Functional testing.
- Integration testing.
- End-to-end testing.
- Security testing.
- Performance testing.
- Accessibility testing.
- Localization testing.
- Mobile testing.
- Offline testing.
- Payment sandbox testing.
- Backup restoration testing.
- Deployment rehearsal.

Do not launch until critical acceptance criteria pass.

---

12. TESTING REQUIREMENTS

Every module must have tests appropriate to its risk.

Unit Tests

Especially important for:

- Habit scheduling.
- Occurrence generation.
- Streak calculations.
- Completion rates.
- Timezone handling.
- Entitlement calculations.
- Subscription state transitions.
- Payment calculations.
- AI tool authorization.
- Recommendation lifecycle.

Integration Tests

Test:

- Database interactions.
- Authentication.
- Authorization.
- Payment provider adapters.
- Webhook processing.
- Background jobs.
- Notifications.
- Integration synchronization.

End-to-End Tests

Critical user journeys:

1. Register.
2. Complete onboarding.
3. Create a habit.
4. Record daily completion.
5. Navigate to previous weeks.
6. Create a goal.
7. Link a habit to the goal.
8. Create and complete a task.
9. Use focus timer.
10. View performance analytics.
11. Ask AI Coach a question.
12. Subscribe to Pro in a sandbox.
13. Verify subscription entitlements.
14. Cancel a subscription.
15. Access the admin dashboard using the dedicated owner account.

Quality Gates

A phase is not complete merely because the UI looks correct.

It must include:

- Working frontend.
- Working backend.
- Database persistence.
- Validation.
- Authorization.
- Error handling.
- Loading states.
- Empty states.
- Responsive behavior.
- Tests.
- Documentation.

---

13. GITHUB AND AI AGENT DEVELOPMENT WORKFLOW

This is a critical part of the project.

The product must be developed through a GitHub-centered workflow that is compatible with different AI coding agents.

The system must not depend on one specific AI vendor.

13.1. Agent Compatibility

The repository must contain enough documentation and explicit instructions for a compatible coding agent to understand the project.

Create:

- "AGENTS.md"
- "README.md"
- "docs/architecture/"
- "docs/product/"
- "docs/development/"
- "docs/decisions/"
- "docs/roadmap/"
- "docs/operations/"

If using Claude Code, also provide compatible Claude-specific project instructions.

If using GitHub Copilot, provide compatible repository instructions.

Do not duplicate contradictory instructions across agent-specific files.

The canonical project specification must remain in version-controlled documentation.

13.2. GitHub Repository

Create a private repository initially.

Suggested repository name:

"personal-performance-platform"

The exact name may be changed later.

Set up:

- Main branch.
- Development branch if justified.
- Feature branches.
- Pull request templates.
- Issue templates.
- CI workflows.
- Branch protection.
- Required checks.
- Code review rules.

13.3. Branch Strategy

Never allow an AI agent to make uncontrolled direct changes to production or the protected main branch.

Use branches such as:

- "main"
- "develop" when needed
- "feature/habit-weekly-matrix"
- "feature/ai-coach"
- "fix/subscription-renewal"

The agent should work on a dedicated branch and create a pull request.

13.4. Agent Responsibilities

The AI coding agent must:

1. Read the project instructions.
2. Inspect the current repository.
3. Understand existing architecture.
4. Review relevant documentation.
5. Identify the next incomplete roadmap item.
6. Create or update a GitHub Issue.
7. Break work into manageable tasks.
8. Implement the feature.
9. Add tests.
10. Run relevant checks.
11. Fix failures.
12. Update documentation.
13. Commit changes.
14. Open or update a pull request.
15. Report completed work and remaining tasks.

Do not claim that work is complete if tests have not been executed.

13.5. Human Approval

Require human approval for:

- Merging significant pull requests.
- Production deployment.
- Database migrations with destructive effects.
- Payment provider activation.
- Changes to security-critical settings.
- Changes to owner identity or permissions.
- Deleting production data.

13.6. GitHub Secrets

Use GitHub Actions Secrets or an appropriate external secret manager.

Never commit:

- ".env" files containing real credentials.
- API keys.
- Database passwords.
- Payment secrets.
- Private keys.
- Authentication secrets.

Provide ".env.example" with placeholder values only.

Do not grant the coding agent unnecessary access to production credentials.

Prefer sandbox credentials and isolated development environments.

---

14. CONTINUOUS DEVELOPMENT COMMANDS

The project must support a persistent development workflow.

The owner should be able to provide instructions such as:

Continue Development

"Continue development according to the project roadmap. Inspect the repository, review completed phases, identify the next incomplete task, implement it, test it, update documentation, and create a pull request. Do not skip quality gates."

Fix Current Issues

"Inspect open issues, failed CI workflows, and outstanding pull request feedback. Prioritize the most important blockers, fix them, run tests, and report the results."

Review Architecture

"Review the existing architecture against the master specification. Identify architectural inconsistencies, security risks, technical debt, and missing capabilities. Do not make large changes without proposing a plan first."

Implement a Specific Feature

"Implement the specified feature using existing architecture and coding standards. Update backend, frontend, database, tests, localization, documentation, and any relevant integration."

Prepare for Production

"Review deployment readiness, security, migrations, observability, backups, payment configuration, and production environment requirements. Produce a checklist and do not deploy without approval."

The agent must always inspect repository state before deciding what to do next.

Never blindly repeat previously completed work.

---

15. RELEASE MANAGEMENT

Use controlled releases.

Suggested environments:

- Local development.
- Testing.
- Staging.
- Production.

Deploy to staging before production.

Use database migrations with backup and rollback planning.

Do not deploy untested changes directly to production.

Use feature flags for major functionality where appropriate.

Monitor errors and application health after releases.

---

16. ANALYTICS AND BUSINESS METRICS

The administrative dashboard must eventually support:

Acquisition

- Registrations.
- Registration sources when available.
- Conversion by acquisition channel.

Activation

- Onboarding completion.
- First habit creation.
- First habit completion.
- First meaningful product interaction.

Engagement

- Daily active users.
- Weekly active users.
- Monthly active users.
- Habit activity.
- Feature usage.
- Retention.

Revenue

- Paying customers.
- Monthly recurring revenue.
- Annual recurring revenue.
- Average revenue per paying customer.
- Churn.
- Refunds.
- Payment failure rate.
- Conversion from Free to Pro.

AI Economics

- Requests.
- Tokens.
- Cost per request.
- Cost per active user.
- Cost per plan.
- Provider errors.

Define every metric explicitly.

Do not display illustrative or fabricated financial metrics as real business data.

---

17. PRIVACY, DATA OWNERSHIP, AND COMPLIANCE

The platform handles personal productivity information that may be sensitive.

Implement:

- Privacy-conscious data collection.
- Data minimization.
- User-controlled sharing.
- Consent management where applicable.
- Data export.
- Account deletion.
- Retention policies.
- Secure authentication.
- Appropriate encryption.
- Access logging.
- Secure backups.

Do not collect data merely because it might be useful someday.

AI features must explain what user information they use.

Users must be able to control optional AI access to journal and other private data.

Before commercial launch, assess applicable privacy, consumer protection, payment, tax, and data-protection requirements for the actual operating jurisdictions.

---

18. PERFORMANCE AND SCALABILITY

The application should be designed to scale without premature complexity.

Requirements:

- Efficient database queries.
- Pagination.
- Appropriate indexing.
- Background processing for expensive tasks.
- Caching where beneficial.
- Efficient frontend rendering.
- Lazy loading.
- Optimized assets.
- Rate limiting.
- Queue-based processing.
- Monitoring.

Avoid unnecessary microservices.

Separate services only when operational, scaling, reliability, or team requirements justify the added complexity.

---

19. DEFINITION OF DONE

A feature is complete only when:

1. The user-facing experience works.
2. Backend functionality is implemented.
3. Data persists correctly.
4. Input validation exists.
5. Authorization is enforced.
6. Error states are handled.
7. Loading states exist.
8. Empty states exist.
9. Responsive behavior works.
10. Persian and English support is implemented where relevant.
11. RTL/LTR behavior is tested.
12. Appropriate tests pass.
13. Documentation is updated.
14. No secrets are exposed.
15. CI passes.
16. Changes are reviewed through a pull request.

---

20. IMPORTANT ENGINEERING RULES

The coding agent must follow these rules throughout the project:

- Do not build the entire product in one unreviewed operation.
- Do not skip architecture or planning.
- Do not replace working systems without justification.
- Do not create duplicate functionality.
- Do not invent APIs or provider capabilities.
- Do not hardcode business rules that should be configurable.
- Do not trust frontend authorization.
- Do not expose secrets.
- Do not silently change historical user data.
- Do not fabricate analytics.
- Do not allow AI to make unauthorized changes.
- Do not implement payment logic without server-side verification.
- Do not claim tests passed without executing them.
- Do not mark incomplete features as completed.
- Do not introduce unnecessary dependencies.
- Do not introduce microservices prematurely.
- Do not sacrifice data integrity for convenience.
- Do not perform destructive production operations without approval.

When requirements are ambiguous, inspect existing decisions and documentation first. If ambiguity materially affects security, money, user data, or architecture, ask for clarification before proceeding.

---

21. INITIAL EXECUTION PRIORITIES

The first assignment is NOT to implement every product feature.

The first assignment is to establish a reliable foundation.

The coding agent must:

1. Inspect the repository.
2. Determine whether it is empty or contains existing work.
3. Read this master specification.
4. Create "AGENTS.md".
5. Create a detailed "README.md".
6. Create "docs/PRODUCT_REQUIREMENTS.md".
7. Create "docs/ARCHITECTURE.md".
8. Create "docs/ROADMAP.md".
9. Create "docs/SECURITY.md".
10. Create "docs/DEVELOPMENT_WORKFLOW.md".
11. Create architecture decision records for important technical decisions.
12. Create a complete implementation backlog in GitHub Issues.
13. Establish the monorepo structure.
14. Configure development tooling.
15. Configure baseline CI.
16. Verify the development environment.
17. Create a pull request for the initial foundation.

Before implementation, identify technical assumptions and risks.

Do not begin large-scale feature development until the foundation and roadmap are reviewed.

---

22. FINAL PRODUCT EXPECTATION

The final product should be a premium, commercially viable SaaS platform with:

- A polished habit-tracking experience.
- A powerful weekly habit matrix.
- Complete goal and task management.
- Daily and weekly planning.
- Focus tools.
- Journal and quick capture.
- Meaningful performance analytics.
- Evidence-based personal insights.
- An intelligent AI Coach.
- Notifications.
- Optional accountability.
- A fully bilingual Persian/English interface.
- An installable PWA.
- Reliable offline functionality.
- Dual payment architecture.
- Configurable subscription plans.
- A secure, independent Super Admin dashboard.
- Owner-level security.
- Operational monitoring.
- Scalable technical foundations.
- Complete documentation and automated testing.

The project should be engineered as a long-term business, not as a disposable prototype.

The priority is to build a stable, maintainable, secure, and extensible foundation, then progressively deliver the complete product.

End of Master Product & Engineering Proposal.
