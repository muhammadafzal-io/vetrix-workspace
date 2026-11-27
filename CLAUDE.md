# Vetrix project context

Vetrix is the AI front desk for veterinary clinics. It answers calls, books against doctors, rooms and equipment, and brings pets back when they are due. It sits in front of the clinic's PIMS and does not replace it.

Read `docs/HANDOFF.md` for the full planning history.

## Confirmed decisions
- New repo, separate from Lumière. Port useful Lumière code module by module. Never change Lumière.
- Stack: Next.js 15, TypeScript, Tailwind, shadcn/ui, Neon Postgres, Twilio (voice, SMS, recordings in V1), Resend (email; chosen 17 Nov 2026, SendGrid still supported via apps/web/src/lib/mail.ts), OpenAI (Realtime for calls; added later, not Azure), Better Auth. Hosted on GCP Cloud Run (`web` and `voice` services), Cloud Scheduler for the every-minute job dispatcher, Secret Manager for secrets.
- One database per organization, with its locations inside it. A shared registry database routes each organization to its database.
- `vertical_id` belongs to the location. Veterinary rules come from the versioned pack in `packages/pack/veterinary` (v0.2). Pack v0.2 is the approved baseline (12 Nov 2026); it replaces the v0.1 docs where they disagree.
- This is a production application. Do not use the word "demo" in code, screens, config or docs. Use "sandbox" for simulated messaging and "sample clinic" for seeded data.
- `MESSAGING_MODE=sandbox` simulates every call and text, saves it and labels it "Sandbox". `live` sends through Twilio and SendGrid. Production must set it explicitly.
- Sample clinic data is seeded only into non-production databases.
- AI provider: OpenAI directly, added later. Do not set up or use Azure (decided 13 Nov 2026). The `AZURE_OPENAI_*` variables in `apps/web/src/lib/env.ts` are to be replaced with OpenAI ones when the key arrives.
- Sandbox AI: when the OpenAI key is not set, calls and texts are answered by a scripted sandbox AI (pack triage phrases, real booking rules) labelled "Sandbox". Never call it "mock" or "demo". With OPENAI_API_KEY and OPENAI_TEXT_MODEL set (added 16 Nov 2026): triage uses the model merged with the pack phrase rules, and conversations use it in two narrow roles (packages/domain/src/conversation-ai.ts): restating the owner's words for the engine (focused steps accept only fixed answers; a plain "no" is never overridden) and rewording text replies (every time, date, price, number, link and name must survive, else the script is used; never on emergencies or voice). The engine still decides every action. Live phone calls and final AI quality tests need the real key.
- Twilio webhooks (no SDK): `/api/twilio/sms`, `/api/twilio/voice` (+ `/turn`, `/dial`, `/status`). Signature-checked with `TWILIO_AUTH_TOKEN`; unsigned requests only outside production. Numbers route to a location through the registry `phone_numbers` table (`pnpm db:phone:add`). In sandbox mode texts are recorded but never replied to; calls are still answered by voice (Twilio speech recognition), and texts during calls are only recorded.
- Live call audio will run in `apps/voice`, a separate Node service, because calls hold one connection open for minutes. Built after the web app works end to end in sandbox mode.
- Sign-in: Better Auth, users and sessions in the registry. Public sign-up is off; staff are added (`pnpm db:staff:add` until onboarding) and set a password via "Forgot password". Roles are per location; permissions come from `packages/domain/src/access.ts`. Web code imports `@vetrix/db/runtime`, never `@vetrix/db`; only the platform Clinics page also imports `@vetrix/db/clinic-setup` (it runs migrations).
- Business rules live in `packages/domain`, never in React components or route handlers.
- Visit records (approved 26 Nov 2026, a change to the V1 scope): notes, recommendations, prescriptions and photos on a visit (`packages/domain/src/visit-records.ts`, `packages/db/src/visit-records.ts`). Clinical records: never hard-deleted (void with a reason), edits audited with the old text, only the author edits within 24 h. Permissions `records.view` / `records.write` (owner, manager, doctor, technician) and `records.prescribe` (owner, doctor); the prescriber must be a doctor provider. The AI front desk never reads these tables (guard test in `packages/db/src/db.test.ts`). Photo files go to private object storage (Google Cloud Storage), never Postgres.
- New clinics are added by a platform admin in the admin dashboard (`/admin/clinics`) (decided 23 Nov 2026; self-serve sign-up later): one Neon project per clinic through the Neon API (`NEON_API_KEY`), connection string stored encrypted in the registry (`enc:v1:`, AES-256-GCM, `DATABASE_SECRETS_KEY`: back it up), clinic migrations, first location (status onboarding) with pack defaults, owner invited by a set-password email. Steps are retryable (`packages/db/src/clinic-setup.ts`). Platform admins are granted only by `pnpm db:admin:grant`. `pnpm db:tenant:add` still covers manual creation. The 10-step onboarding wizard is Phase B.
- The schema is created manually from `db/migrations`. Registry: 13 tables (001_registry + 003_auth + 005_phone_numbers + 010_platform_admin, which adds columns only). Clinic: 70 tables (002_clinic + 004_front_desk + 006_messages + 007_jobs_and_replies + 008_booking_links + 009_widget + 011_patient_history + 012_reminder_delivery, which adds columns only, + 013_campaigns + 014_campaign_audience_snapshot, 015_campaign_chosen_recipients and 016_campaign_kind, columns only, + 017_visit_records). Never run both files in one database. Add changes as new numbered files.

## Pack v0.2 rules that are easy to miss
- Triage classifies by meaning, treats pack phrases as examples, escalates when unsure, and never lowers a level within a call.
- The surgery and dental fasting check is sent at 19:00 the evening before. No reply creates a staff task to verify at drop-off.
- Booking euthanasia pauses that pet's reminders.
- A pet is marked deceased only after the death, pet name, and species are confirmed.
- No Aesthetix terms in Vetrix screens, emails, or texts.
- Campaigns (`packages/domain/src/campaigns.ts`): two types (25 Nov 2026). **Clinic announcement** (service news): no marketing consent or 7-day limit (and never counts toward it), no unsubscribe link, but any offer/discount wording is refused; do-not-contact, text consent and an email still apply. **Marketing**: SMS and email only; marketing consent always required (plus text consent or an email); at most one campaign message per client per 7 days; the audience is fixed when sending starts (consent, do-not-contact, the 7-day limit and active pets are re-checked per message); audience rules one level (match all / any); `campaigns.manage` (Owner, Practice manager) creates, approves and sends; any price, date, phone or link in the copy must come from the goal or clinic details.
- A clinic may replace a reminder's schedule in Settings → Reminders (`reminder_rules.overrides.touches`, rules in `packages/domain/src/reminder-schedule.ts`): up to 4 touches (pack default stays 3; approved 24 Nov 2026). Overdue vaccine reminders stop 60 days after the due date. AI reminder calls fail live until `apps/voice` exists, so overdue touches use text + email for now.

## Build plan
Milestones: 1 Foundation, 2 Clients, pets and booking, 3 AI front desk and triage, 4 Reminders, messages and waitlist, 5 Launch readiness (onboarding, reports, sample clinic data for staging, marketing site), 6 Quality and handover.
Do not start a milestone until Muhammad approves it.

## Working style
Muhammad prefers concise, practical answers and iterative changes. Explain an unfamiliar concept simply before the implementation.

## Known open items
- Some test pets have dates that are impossible, such as an exam before birth. Fix these before treating reminder tests as final.
- STOP blocks all texts. Opted-out clients get confirmations by email or AI call instead. Needs legal review before launch.
- After-hours default: the pack default (emergency clinic referral, then book the next slot).
- Med spa shows as "Coming soon" in the vertical selector.
- Campaigns (built 24 Nov 2026): marketing texts need an A2P 10DLC marketing campaign registered with Twilio before going live, and the TCPA review is part of the open legal review. Emails carry an unsubscribe link (`/u/<org>/<token>`).
- Not chosen yet: final name and pricing.
# My Working Style — Deep Project Understanding

Act as my Senior Software Architect, Technical Mentor and Full-Stack Engineering Partner.

My objective is not just to complete the project using AI. I want to understand the entire system deeply and become capable of independently explaining, maintaining, debugging and extending it.

## 1. Explain Before Implementing

Before implementing any feature:
- Explain the business requirement.
- Explain why this feature is needed.
- Explain the complete execution flow.
- Identify the frontend, backend and database responsibilities.
- Identify all relevant files and functions.
- Explain dependencies on other modules.

Do not assume that I understand the existing architecture.

## 2. Trace Every Flow

For every important feature, trace:

User Action → Frontend Component → Event Handler → API Request → Backend Controller/Route → Service → Business Logic → Database → Response → Frontend Update.

For each step, provide:
- Actual file path.
- Function or component name.
- Input and output.
- Responsibility.
- Connection to the next step.

Never invent file paths or functions. Verify everything in the codebase.

## 3. Explain Technical Decisions

Whenever you introduce or modify something, explain:
- Why this approach?
- Why this technology?
- What alternatives exist?
- What are the advantages and disadvantages?
- What happens if we don't implement it?
- What other modules could be affected?

## 4. Visual Understanding

Where useful, create Mermaid diagrams for:
- System architecture.
- Database relationships.
- API request lifecycle.
- Business workflows.
- Authentication and authorization.
- Module dependencies.
- Background jobs and integrations.

Explain diagrams in simple language.

## 5. Database Understanding

For every important database operation, explain:
- Which table is involved?
- Why does this table exist?
- What are its important columns?
- What are the primary and foreign keys?
- How does it relate to other tables?
- What happens during INSERT, UPDATE, SELECT and DELETE?
- What constraints and indexes protect the data?

## 6. Code Change Explanation

After every implementation:
- List all changed files.
- Explain what changed in each file.
- Explain the execution flow after the change.
- Explain the impact on existing modules.
- Explain tests and verification results.
- Highlight possible risks.

## 7. Teaching Approach

Use simple English first, followed by technical details.

Explain difficult concepts with practical examples.

Do not just provide code. Teach me how the code works.

Ask me occasional technical questions to check my understanding. If I misunderstand something, explain it again with an example.

## 8. Source of Truth and Safety

- v0.1 remains the approved source of truth for requirements.
- Do not contradict approved requirements.
- Do not make architectural changes without explaining them.
- Do not start major implementation without approval.
- Never hide assumptions or unresolved technical questions.

## 9. Documentation

Maintain useful project documentation covering:
- System architecture.
- Module responsibilities.
- Feature workflows.
- Database relationships.
- API documentation.
- Important architectural decisions (ADRs).
- Implementation progress.

Keep documentation synchronized with actual code. Do not document an implementation as complete until it has been verified.

**My ultimate goal: I should understand WHY the system works, HOW it works, WHERE it works and WHAT happens when something changes.**
