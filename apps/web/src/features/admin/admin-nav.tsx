"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, LayoutDashboard } from "lucide-react";
import { cn } from "@/lib/utils";

/** Sections of the admin dashboard. Add new platform tools here. */
const ITEMS = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard },
  { href: "/admin/clinics", label: "Clinics", icon: Building2 },
] as const;

export function AdminNav() {
  const path = usePathname();
  const active = (href: string) => (href === "/admin" ? path === "/admin" : path === href || path.startsWith(`${href}/`));
  return (
    <nav aria-label="Admin" className="flex gap-1 overflow-x-auto lg:grid lg:content-start lg:gap-0.5">
      {ITEMS.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          aria-current={active(href) ? "page" : undefined}
          className={cn(
            "flex shrink-0 items-center gap-2.5 rounded-md px-3 py-2 text-small font-medium transition-colors",
            active(href) ? "bg-secondary text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
          )}
        >
          <Icon className="size-4" aria-hidden />
          {label}
        </Link>
      ))}
    </nav>
  );
}
