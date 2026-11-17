// Phone numbers on public pages: "(512) 555-0142" plus a tel: link.
import { formatPhone } from "@vetrix/domain";

export function phoneLink(p: string | null): { text: string; href: string } | null {
  if (!p) return null;
  const digits = p.replace(/\D/g, "");
  const e164 = p.startsWith("+") ? p : digits.length === 10 ? `+1${digits}` : null;
  if (!e164) return { text: p, href: `tel:${digits}` };
  try {
    return { text: formatPhone(e164), href: `tel:${e164}` };
  } catch {
    return { text: p, href: `tel:${digits}` };
  }
}
