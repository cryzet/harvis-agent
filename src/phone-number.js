export function normalizeInternationalPhoneNumber(input) {
  const value = String(input ?? "").trim();
  const compact = value.replace(/[\s().-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(compact)) {
    throw new Error(
      "Usa el formato internacional E.164, por ejemplo +14155552671 (de 8 a 15 dígitos, con + y código de país).",
    );
  }
  return compact;
}

export function getInternationalPhoneNumber(jid) {
  const phoneId = normalizeWhatsAppPhoneId(jid);
  return phoneId ? `+${phoneId}` : null;
}

// Canonical WhatsApp user ID used for all phone comparisons: country code and
// subscriber number as digits, with no leading '+'. LIDs are intentionally not
// treated as phone numbers; they must be matched through their saved JID alias.
export function normalizeWhatsAppPhoneId(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  let candidate = String(value).trim();
  while (/^whatsapp:/i.test(candidate)) {
    candidate = candidate.replace(/^whatsapp:/i, "").trim();
  }
  const jidMatch = /^(\+?[1-9]\d{7,14})(?::\d+)?@(s\.whatsapp\.net|c\.us)$/i.exec(candidate);
  if (jidMatch) {
    candidate = jidMatch[1].startsWith("+") ? jidMatch[1] : `+${jidMatch[1]}`;
  } else if (/^[1-9]\d{7,14}$/.test(candidate)) {
    candidate = `+${candidate}`;
  }
  try {
    return normalizeInternationalPhoneNumber(candidate).slice(1);
  } catch {
    return null;
  }
}

export function samePhoneNumber(left, right) {
  const leftId = normalizeWhatsAppPhoneId(left);
  return leftId !== null && leftId === normalizeWhatsAppPhoneId(right);
}
