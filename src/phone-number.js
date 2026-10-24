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
  if (typeof jid !== "string") return null;
  const match = /^([1-9]\d{7,14})(?::\d+)?@s\.whatsapp\.net$/.exec(jid);
  return match ? `+${match[1]}` : null;
}
