export const DEFAULT_TIMEZONE = "America/Cuiaba";

/**
 * Valida se uma string é um fuso horário IANA válido suportado pelo runtime.
 */
export function validateIanaTimeZone(tz: string): boolean {
  if (!tz || typeof tz !== "string") return false;
  if (tz === "UTC" || tz === "Etc/UTC") return true;
  try {
    const isSupported = Intl.supportedValuesOf("timeZone").includes(tz);
    if (isSupported) return true;
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return /^[A-Za-z]+(\/[A-Za-z0-9_+-]+)+$/.test(tz);
  } catch {
    return false;
  }
}

/**
 * Converte data e hora local em formato ISO (YYYY-MM-DDTHH:mm ou YYYY-MM-DDTHH:mm:ss)
 * para um Date UTC determinístico, considerando o fuso horário IANA informado.
 * Trata variações de fuso horário, horário de verão (DST), horários inexistentes (gap de transição)
 * e ambíguos sem qualquer dependência do fuso do container/sistema operacional.
 */
export function parseLocalDateTimeToUtc(
  localIsoString: string,
  timeZone: string,
): Date {
  if (!validateIanaTimeZone(timeZone)) {
    throw new Error(
      `Fuso horário IANA inválido ou não suportado: '${timeZone}'.`,
    );
  }

  const match = localIsoString.match(
    /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (!match) {
    throw new Error(
      `Formato de data e hora local inválido: '${localIsoString}'. Use YYYY-MM-DDTHH:mm ou YYYY-MM-DDTHH:mm:ss.`,
    );
  }

  const [, yStr, mStr, dStr, hStr, minStr, secStr = "00"] = match;
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);
  const hour = Number(hStr);
  const minute = Number(minStr);
  const second = Number(secStr);

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    throw new Error(
      `Componentes de data e hora fora do intervalo válido: '${localIsoString}'.`,
    );
  }

  // Estimativa inicial tratando os componentes numéricos como UTC
  let guess = Date.UTC(year, month - 1, day, hour, minute, second);

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  });

  // Refinamento iterativo do deslocamento (convergência exata em 2 a 3 iterações para qualquer fuso/DST)
  for (let i = 0; i < 3; i++) {
    const parts = formatter.formatToParts(new Date(guess));
    const p: Record<string, string> = {};
    for (const part of parts) {
      p[part.type] = part.value;
    }
    const formattedHour = Number(p.hour) === 24 ? 0 : Number(p.hour);
    const localActual = Date.UTC(
      Number(p.year),
      Number(p.month) - 1,
      Number(p.day),
      formattedHour,
      Number(p.minute),
      Number(p.second),
    );
    const diff = guess - localActual;
    const targetLocal = Date.UTC(year, month - 1, day, hour, minute, second);
    guess = targetLocal + diff;
  }

  return new Date(guess);
}

/**
 * Formata um Date UTC para exibição legível no fuso local solicitado.
 */
export function formatUtcToLocal(
  utcDate: Date | string,
  timeZone: string,
  locale = "pt-BR",
): string {
  const date = typeof utcDate === "string" ? new Date(utcDate) : utcDate;
  if (isNaN(date.getTime())) return "";
  if (!validateIanaTimeZone(timeZone)) return date.toISOString();

  const formatter = new Intl.DateTimeFormat(locale, {
    timeZone,
    dateStyle: "short",
    timeStyle: "medium",
  });
  return formatter.format(date);
}

/**
 * Converte um Date UTC para o formato local YYYY-MM-DDTHH:mm:ss no fuso solicitado.
 */
export function formatUtcToIsoLocal(
  utcDate: Date | string,
  timeZone: string,
): string {
  const date = typeof utcDate === "string" ? new Date(utcDate) : utcDate;
  if (isNaN(date.getTime())) return "";
  if (!validateIanaTimeZone(timeZone)) return date.toISOString();

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const p: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    p[part.type] = part.value;
  }
  const hour = p.hour === "24" ? "00" : p.hour;
  return `${p.year}-${p.month}-${p.day}T${hour}:${p.minute}:${p.second}`;
}
