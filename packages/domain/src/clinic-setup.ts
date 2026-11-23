// Adding a clinic to the platform: what the platform admin types in, and the
// order of the setup steps. Each new clinic (organization) gets its own
// database; its first location starts in "onboarding".

import { ValidationError } from "./errors";
import { isTimeZone } from "./settings";

/** Setup steps, in order. Each is safe to run again, so a failed setup can be retried. */
export const CLINIC_SETUP_STEPS = [
  { id: "database", label: "Create the clinic database" },
  { id: "schema", label: "Create its tables" },
  { id: "clinic", label: "Add the first location and the pack defaults" },
  { id: "owner", label: "Add the owner" },
  { id: "invite", label: "Email the owner a link to set a password" },
] as const;

export type ClinicSetupStep = (typeof CLINIC_SETUP_STEPS)[number]["id"];

/** Where new clinic databases are created. Same region as the registry, so lookups stay fast. */
export const DEFAULT_CLINIC_REGION = "aws-us-east-1";

/** Slugs that would clash with app paths or look official. */
const RESERVED_SLUGS = new Set(["admin", "api", "app", "clinics", "vetrix", "www", "help", "support", "sandbox", "staging"]);

export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** "Paws & Claws Vet!" -> "paws-claws-vet". */
export function slugFromName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // drop accents: é -> e
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/** A region name such as America/Chicago (or UTC), not a short code like EST. */
function isRegionTimeZone(tz: string): boolean {
  return isTimeZone(tz) && (tz.includes("/") || tz === "UTC");
}

export interface NewClinicForm {
  clinicName: string;
  slug: string;
  locationName: string;
  timezone: string;
  ownerName: string;
  ownerEmail: string;
}

export type ValidNewClinic = NewClinicForm;

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function validateNewClinic(form: NewClinicForm): ValidNewClinic {
  const clinicName = form.clinicName.trim().replace(/\s+/g, " ");
  if (clinicName.length < 2 || clinicName.length > 80) throw new ValidationError("Enter the clinic's name (2 to 80 characters).", { field: "clinicName" });
  const slug = (form.slug.trim() || slugFromName(clinicName)).toLowerCase();
  if (!SLUG_PATTERN.test(slug) || slug.length < 3 || slug.length > 40) {
    throw new ValidationError("Use 3 to 40 lowercase letters, numbers and single hyphens, like paws-and-claws.", { field: "slug" });
  }
  if (RESERVED_SLUGS.has(slug)) throw new ValidationError(`"${slug}" is reserved. Choose another.`, { field: "slug" });
  const locationName = (form.locationName.trim() || clinicName).replace(/\s+/g, " ");
  if (locationName.length > 80) throw new ValidationError("Keep the location name under 80 characters.", { field: "locationName" });
  const timezone = form.timezone.trim();
  if (!isRegionTimeZone(timezone)) throw new ValidationError("Choose the clinic's time zone.", { field: "timezone" });
  const ownerName = form.ownerName.trim().replace(/\s+/g, " ");
  if (ownerName.length < 2 || ownerName.length > 80) throw new ValidationError("Enter the owner's name.", { field: "ownerName" });
  const ownerEmail = form.ownerEmail.trim().toLowerCase();
  if (!EMAIL.test(ownerEmail) || ownerEmail.length > 200) throw new ValidationError("Enter the owner's email address.", { field: "ownerEmail" });
  return { clinicName, slug, locationName, timezone, ownerName, ownerEmail };
}

/** The 10 onboarding steps from docs/product/04-signup-and-onboarding.md; 1, 2, 3 and 7 are mandatory. */
export const ONBOARDING_STEPS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ step: n, mandatory: [1, 2, 3, 7].includes(n) }));
