# Veterinary pack changelog

## 0.2.4 (24 Nov 2026)
- `retention.json`: new texts `vaccine_overdue_3` and `vaccine_overdue_7` for clinics that remind owners 3 and 7 days after a vaccine is overdue. The default schedule is unchanged (30 and 7 days before, AI call 7 days after).
- A clinic may set its own schedule per reminder (Settings → Reminders) with up to 4 touches; `max_touches_per_rule: 3` stays the pack default. Overdue vaccine reminders stop 60 days after the due date.

## 0.2.3 (12 Nov 2026)
- `brand.json`: colour scheme is now navy + teal (primary #0F766E, navy ink #0B1B2B, mint accent #2DD4BF, warm highlight #FBBF24 for headline underlines only). Font is Poppins. Dark mode and type scale updated to match the app.

## 0.2.2 (12 Nov 2026)
- `brand.json`: landing page button reads "Book a 20-minute walkthrough".

## 0.2.1 (12 Nov 2026)
- `services.json`: added `also_bookable_by_roles`. Nail trims can be done by an assistant, and weight checks by a technician when the clinic has no assistant.
- `retention.json`: STOP now stops all texts (`opt_out_all_sms`). Opted-out clients get confirmations by email or AI call. Added the HELP keyword and the `help_reply` template.

## 0.2.0
- Triage by meaning, fasting check at 19:00 the evening before, euthanasia pauses reminders, stricter deceased rule. See `docs/HANDOFF.md`.
