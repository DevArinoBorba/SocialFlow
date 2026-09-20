import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIMEZONE,
  validateIanaTimeZone,
  parseLocalDateTimeToUtc,
  formatUtcToLocal,
  formatUtcToIsoLocal,
} from "../../packages/contracts/src/timezone.js";

describe("Timezone Utilities Unit Tests", () => {
  describe("validateIanaTimeZone", () => {
    it("valida timezones IANA válidos", () => {
      expect(validateIanaTimeZone("America/Cuiaba")).toBe(true);
      expect(validateIanaTimeZone("America/Sao_Paulo")).toBe(true);
      expect(validateIanaTimeZone("UTC")).toBe(true);
      expect(validateIanaTimeZone("Europe/London")).toBe(true);
      expect(validateIanaTimeZone("America/New_York")).toBe(true);
    });

    it("rejeita timezones inválidos ou arbitrários", () => {
      expect(validateIanaTimeZone("")).toBe(false);
      expect(validateIanaTimeZone("Invalid/Timezone")).toBe(false);
      expect(validateIanaTimeZone("America/Nowhere")).toBe(false);
      expect(validateIanaTimeZone("GMT+5")).toBe(false);
      expect(validateIanaTimeZone(null as unknown as string)).toBe(false);
      expect(validateIanaTimeZone(undefined as unknown as string)).toBe(false);
    });

    it("utiliza America/Cuiaba como fuso horário padrão", () => {
      expect(DEFAULT_TIMEZONE).toBe("America/Cuiaba");
      expect(validateIanaTimeZone(DEFAULT_TIMEZONE)).toBe(true);
    });
  });

  describe("parseLocalDateTimeToUtc", () => {
    it("converte horário local em America/Cuiaba (UTC-4) para UTC corretamente", () => {
      // 2026-10-15T14:30:00 em America/Cuiaba (UTC-4) -> 2026-10-15T18:30:00.000Z
      const utcDate = parseLocalDateTimeToUtc(
        "2026-10-15T14:30:00",
        "America/Cuiaba",
      );
      expect(utcDate.toISOString()).toBe("2026-10-15T18:30:00.000Z");
    });

    it("converte horário local em America/Sao_Paulo (UTC-3) para UTC corretamente", () => {
      // 2026-10-15T14:30:00 em America/Sao_Paulo (UTC-3) -> 2026-10-15T17:30:00.000Z
      const utcDate = parseLocalDateTimeToUtc(
        "2026-10-15T14:30:00",
        "America/Sao_Paulo",
      );
      expect(utcDate.toISOString()).toBe("2026-10-15T17:30:00.000Z");
    });

    it("converte com segundos opcionais (YYYY-MM-DDTHH:mm)", () => {
      const utcDate = parseLocalDateTimeToUtc(
        "2026-10-15T14:30",
        "America/Cuiaba",
      );
      expect(utcDate.toISOString()).toBe("2026-10-15T18:30:00.000Z");
    });

    it("trata gap de transição de horário de verão (spring-forward)", () => {
      // Em Nova York (America/New_York), em 2026-03-08 às 02:00 os relógios adiantam para 03:00.
      // O horário 02:30:00 não existe localmente. O algoritmo deve converter determinística e suavemente.
      const utcDate = parseLocalDateTimeToUtc(
        "2026-03-08T02:30:00",
        "America/New_York",
      );
      expect(utcDate).toBeInstanceOf(Date);
      expect(isNaN(utcDate.getTime())).toBe(false);
      // Após converter para UTC e formatar de volta, deve estar próximo da transição
      const backFormatted = formatUtcToIsoLocal(utcDate, "America/New_York");
      expect(backFormatted.startsWith("2026-03-08T03:30")).toBe(true);
    });

    it("trata sobreposição de horário de verão (fall-back fold ambíguo)", () => {
      // Em Nova York (America/New_York), em 2026-11-01 às 02:00 os relógios atrasam para 01:00.
      // O horário 01:30:00 ocorre duas vezes. O algoritmo deve resolver de forma estável.
      const utcDate = parseLocalDateTimeToUtc(
        "2026-11-01T01:30:00",
        "America/New_York",
      );
      expect(utcDate).toBeInstanceOf(Date);
      expect(isNaN(utcDate.getTime())).toBe(false);
      const backFormatted = formatUtcToIsoLocal(utcDate, "America/New_York");
      expect(backFormatted.startsWith("2026-11-01T01:30")).toBe(true);
    });

    it("lança erro para formatos inválidos ou fuso desconhecido", () => {
      expect(() =>
        parseLocalDateTimeToUtc("2026-10-15T14:30:00", "Fuso/Invalido"),
      ).toThrow(/Fuso horário IANA inválido/);

      expect(() =>
        parseLocalDateTimeToUtc("15/10/2026 14:30", "America/Cuiaba"),
      ).toThrow(/Formato de data e hora local inválido/);
    });
  });

  describe("formatUtcToLocal e formatUtcToIsoLocal", () => {
    it("formata data UTC para representação local humana e ISO", () => {
      const utcDate = new Date("2026-10-15T18:30:00.000Z");
      const isoLocal = formatUtcToIsoLocal(utcDate, "America/Cuiaba");
      expect(isoLocal).toBe("2026-10-15T14:30:00");

      const humanLocal = formatUtcToLocal(utcDate, "America/Cuiaba");
      expect(humanLocal).toContain("2026");
      expect(humanLocal).toContain("14:30");
    });
  });
});
