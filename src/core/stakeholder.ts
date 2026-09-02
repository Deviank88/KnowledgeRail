import { domainToASCII } from "node:url";

export const STAKEHOLDER_AFFILIATIONS = [
  "client",
  "internal",
  "partner",
  "unknown",
] as const;

export type StakeholderAffiliation = (typeof STAKEHOLDER_AFFILIATIONS)[number];

const EMAIL_RE = /\b[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@([\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+)(?=$|[\s\p{P}\p{S}])/giu;

/** Normalize and validate an email domain without retaining a local part. */
export function normalizeEmailDomain(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().replace(/^@/, "").replace(/\.$/, "");
  if (!trimmed || trimmed.includes("@") || trimmed.length > 253) return undefined;
  const ascii = domainToASCII(trimmed).toLocaleLowerCase("en-US");
  if (!ascii || ascii.length > 253 || !ascii.includes(".")) return undefined;
  const labels = ascii.split(".");
  if (labels.some((label) =>
    !label || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label)
  )) return undefined;
  return ascii;
}

export function emailDomainFromAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return undefined;
  return normalizeEmailDomain(trimmed.slice(at + 1));
}

export function emailDomainsInText(value: string): string[] {
  const domains = new Set<string>();
  for (const match of value.matchAll(EMAIL_RE)) {
    const domain = normalizeEmailDomain(match[1]);
    if (domain) domains.add(domain);
  }
  return [...domains].sort();
}

/** Keep provenance useful while preventing full participant addresses from entering durable claims. */
export function redactEmailAddresses(value: string): string {
  return value.replace(EMAIL_RE, (_match, domain: string) => {
    const normalized = normalizeEmailDomain(domain);
    return normalized ? `[email-domain:${normalized}]` : "[email-redacted]";
  });
}

export function stakeholderAffiliation(params: {
  stakeholderEmailDomain?: string;
  userEmailDomain?: string | null;
  /** Source-declared fallback. Domain comparison still decides client/internal when possible. */
  explicitAffiliation?: StakeholderAffiliation;
}): StakeholderAffiliation {
  if (params.explicitAffiliation === "partner") return "partner";
  const stakeholderDomain = normalizeEmailDomain(params.stakeholderEmailDomain);
  const userDomain = normalizeEmailDomain(params.userEmailDomain ?? undefined);
  if (stakeholderDomain && userDomain) {
    return stakeholderDomain === userDomain ? "internal" : "client";
  }
  return params.explicitAffiliation === "client" || params.explicitAffiliation === "internal"
    ? params.explicitAffiliation
    : "unknown";
}
