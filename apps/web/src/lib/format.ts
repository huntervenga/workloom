const pluralRules = new Intl.PluralRules('ru-RU');

export function pluralizeRu(count: number, forms: { one: string; few: string; many: string }): string {
  const rule = pluralRules.select(count);
  const word = rule === 'one' ? forms.one : rule === 'few' ? forms.few : forms.many;
  return `${count} ${word}`;
}

export function formatMemberCount(count: number): string {
  return pluralizeRu(count, { one: 'участник', few: 'участника', many: 'участников' });
}

export function formatProjectCount(count: number): string {
  return pluralizeRu(count, { one: 'проект', few: 'проекта', many: 'проектов' });
}

/** "GMT+3" style offset for an IANA zone, or null if the zone is unknown to the browser. */
export function formatUtcOffset(timeZone: string, at: Date = new Date()): string | null {
  try {
    const parts = new Intl.DateTimeFormat('ru-RU', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(at);
    return parts.find((part) => part.type === 'timeZoneName')?.value ?? null;
  } catch {
    return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID.test(value);
}
