// Online booking links in reminders: /b/<clinic slug>/<token>. Public pages.
import "server-only";
import { getEnv } from "./env";

export function bookingLinkBase(organizationSlug: string): string {
  return `${getEnv().APP_URL.replace(/\/$/, "")}/b/${organizationSlug}`;
}
