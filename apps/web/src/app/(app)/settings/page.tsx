import type { Metadata } from "next";
import { formatPhone } from "@vetrix/domain";
import { loadSettings } from "@vetrix/db/runtime";
import { PageHeader } from "@/components/patterns/page-header";
import { requirePage } from "@/features/clients/access";
import { getEnv } from "@/lib/env";
import {
  DetailsForm,
  FrontDeskForm,
  HolidaysPanel,
  HoursForm,
  MessagingForm,
  PoliciesForm,
  RemindersCard,
  ServicesCard,
  SettingsNav,
  WidgetForm,
} from "@/features/settings/settings-forms";

export const metadata: Metadata = { title: "Settings · Vetrix" };

const CATEGORY: Record<string, string> = { exam: "Exams", tech: "Technician visits", surgery: "Surgery and dental", diagnostics: "Diagnostics", other: "Other" };

/** Shows saved numbers as (555) 010-1000; older values may not be in +1 form. */
function showPhone(v: string | null): string | null {
  if (!v) return null;
  const digits = v.replace(/\D/g, "");
  const e164 = v.startsWith("+") ? v : digits.length === 10 ? `+1${digits}` : digits.length === 11 && digits.startsWith("1") ? `+${digits}` : null;
  try {
    return e164 ? formatPhone(e164) : v;
  } catch {
    return v;
  }
}

function usTimeZones(current: string): string[] {
  const all = Intl.supportedValuesOf("timeZone").filter((tz) => tz.startsWith("America/") || tz === "Pacific/Honolulu");
  const common = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"];
  return [...new Set([current, ...common, ...all])];
}

export default async function SettingsPage() {
  const shell = await requirePage("settings.manage");
  const s = await loadSettings(shell.clinic, shell.location.id);
  const appUrl = getEnv().APP_URL.replace(/\/$/, "");
  const slug = shell.organization.organization_slug;
  const groups = [...new Set(s.services.map((x) => x.category))].map((c) => ({
    label: CATEGORY[c] ?? c.replace(/_/g, " "),
    services: s.services.filter((x) => x.category === c),
  }));

  return (
    <>
      <PageHeader title="Settings" description={`How ${s.details.name} runs: hours, how Riley answers, policies and reminders.`} />
      <div className="grid gap-6 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-8">
        <SettingsNav />
        <div className="grid max-w-4xl gap-6">
          <DetailsForm saved={{ ...s.details, mainPhone: showPhone(s.details.mainPhone) }} timezones={usTimeZones(s.details.timezone)} />
          <HoursForm saved={s.hours} />
          <HolidaysPanel holidays={s.holidays} />
          <FrontDeskForm
            saved={{ ...s.frontDesk, emergencyTransferNumber: showPhone(s.frontDesk.emergencyTransferNumber), erPhone: showPhone(s.frontDesk.erPhone) }}
          />
          <PoliciesForm saved={s.policies} />
          <MessagingForm saved={s.messaging} timezone={s.details.timezone} />
          <RemindersCard rules={s.reminderRules} paused={s.remindersPaused} schedules={s.reminderSchedules} clinicName={s.details.name} aiName={s.frontDesk.aiName} />
          <ServicesCard groups={groups} />
          <WidgetForm saved={s.widget} slug={slug} hostedUrl={`${appUrl}/w/${slug}`} scriptUrl={`${appUrl}/widget.js`} />
        </div>
      </div>
    </>
  );
}
