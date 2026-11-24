import { AppShell } from "@/features/shell/app-shell";
import { isPlatformAdmin } from "@vetrix/db/runtime";
import { getMessagingMode } from "@/lib/env";
import { trace } from "@vetrix/domain";
import { getSession, requireShell } from "@/lib/session";
import { tenancy } from "@/lib/tenancy";

export const dynamic = "force-dynamic";

// Signed-in staff area. Every page below this layout requires an active staff
// record in the chosen organization and a location they can open.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  trace("page", "app/(app)/layout.tsx › AppLayout", "staff layout starts: who is signed in, which clinic and location?");
  // The admin check needs only the signed-in user, so it runs alongside the
  // staff checks instead of after them (one less wait per page).
  const session = await getSession();
  const [shell, platformAdmin] = await Promise.all([
    requireShell(),
    session ? isPlatformAdmin(tenancy().registry, session.user.id) : false,
  ]);
  return (
    <AppShell
      user={{ name: shell.access.displayName, email: session?.user.email ?? "" }}
      organization={{ id: shell.organization.organization_id, name: shell.organization.organization_name }}
      organizationCount={shell.memberships.length}
      location={{ id: shell.location.id, name: shell.location.name }}
      locations={shell.locations.map((l) => ({ id: l.id, name: l.name }))}
      permissions={[...shell.permissions]}
      sandbox={getMessagingMode() === "sandbox"}
      platformAdmin={platformAdmin}
    >
      {children}
    </AppShell>
  );
}
