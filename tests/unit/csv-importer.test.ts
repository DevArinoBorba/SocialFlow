import { describe, expect, it } from "vitest";
import {
  CsvHeaderError,
  CsvMalformedError,
  CsvRowLimitError,
  CsvSizeLimitError,
  importPostsFromCsv,
  sanitizeFormulaCell,
} from "../../apps/api/src/parsers/csv-importer.js";
import {
  contentBatchInput,
  postInput,
  postStatusTransition,
  postUpdate,
} from "../../packages/contracts/src/index.js";

describe("CSV Importer Unit Tests", () => {
  it("processes CSV with 80 valid rows and 20 invalid rows without breaking the batch", () => {
    const lines = [
      "title,caption,hashtags,callToAction,firstComment,suggestedDate",
    ];

    // 80 linhas válidas
    for (let i = 1; i <= 80; i++) {
      lines.push(
        `"Post Válido ${i}","Legenda detalhada do post número ${i} com conteúdo relevante.","#social #flow","Confira nosso link","Comentário inicial","2026-10-15T14:30:00.000Z"`,
      );
    }

    // 20 linhas com erros de validação intencionais
    for (let j = 1; j <= 20; j++) {
      if (j % 4 === 0) {
        // Caption vazia
        lines.push(`"Post Inválido ${j}","","","#tag","",""`);
      } else if (j % 4 === 1) {
        // Data inválida
        lines.push(
          `"Post Inválido ${j}","Legenda válida","","","","data-invalida-xyz"`,
        );
      } else if (j % 4 === 2) {
        // Título excessivo (> 120 chars)
        const longTitle = "A".repeat(125);
        lines.push(`"${longTitle}","Legenda válida","","","",""`);
      } else {
        // Caption excessiva (> 5000 chars)
        const longCaption = "B".repeat(5005);
        lines.push(`"Post Inválido ${j}","${longCaption}","","","",""`);
      }
    }

    const csvData = lines.join("\n");
    const result = importPostsFromCsv(csvData);

    expect(result.totalRows).toBe(100);
    expect(result.validCount).toBe(80);
    expect(result.invalidCount).toBe(20);
    expect(result.validRows.length).toBe(80);
    expect(result.errors.length).toBe(20);

    // Verificar que as 80 válidas contêm os dados esperados
    expect(result.validRows[0]!.title).toBe("Post Válido 1");
    expect(result.validRows[79]!.title).toBe("Post Válido 80");

    // Verificar formato estruturado dos erros
    for (const err of result.errors) {
      expect(err.row).toBeGreaterThanOrEqual(82); // Linhas 82 a 101
      expect(typeof err.column).toBe("string");
      expect(typeof err.message).toBe("string");
    }
  });

  it("rejects empty CSV with CsvHeaderError", () => {
    expect(() => importPostsFromCsv("")).toThrow(CsvHeaderError);
    expect(() => importPostsFromCsv("   \n\r\n\t  ")).toThrow(CsvHeaderError);
  });

  it("rejects CSV when header is missing required caption column", () => {
    const csv = "title,hashtags,callToAction\nMeu Post,#tag,Clique";
    expect(() => importPostsFromCsv(csv)).toThrow(CsvHeaderError);
    expect(() => importPostsFromCsv(csv)).toThrow(
      'CSV header is missing mandatory "caption" column',
    );
  });

  it("rejects CSV with unknown columns in header", () => {
    const csv = "title,caption,unknownCol\nTitulo,Legenda,Invalido";
    expect(() => importPostsFromCsv(csv)).toThrow(CsvHeaderError);
    expect(() => importPostsFromCsv(csv)).toThrow(
      'Unknown column in CSV header: "unknownCol"',
    );
  });

  it("preserves line breaks inside quoted cells (RFC-4180)", () => {
    const csv = `title,caption\n"Post com quebra","Primeira linha de texto.\nSegunda linha de texto com parágrafo.\r\nTerceira linha final."`;
    const result = importPostsFromCsv(csv);

    expect(result.validCount).toBe(1);
    expect(result.validRows[0]!.caption).toBe(
      "Primeira linha de texto.\nSegunda linha de texto com parágrafo.\r\nTerceira linha final.",
    );
  });

  it("handles complex emojis and UTF-8 multibyte characters", () => {
    const csv = `title,caption\n"Lançamento 🚀✨","Oferta imperdível! 🎉🔥 Aproveite 100% de desconto 🌟 nos planos. 💡👩‍💻"`;
    const result = importPostsFromCsv(csv);

    expect(result.validCount).toBe(1);
    expect(result.validRows[0]!.title).toBe("Lançamento 🚀✨");
    expect(result.validRows[0]!.caption).toContain(
      "🎉🔥 Aproveite 100% de desconto 🌟",
    );
  });

  it("validates character limits on all fields", () => {
    const csv = [
      "title,caption,hashtags,callToAction,firstComment",
      `"${"T".repeat(121)}","Caption válida","","",""`,
      `"Titulo","${"C".repeat(5001)}","","",""`,
      `"Titulo","Caption","${"H".repeat(1001)}","",""`,
      `"Titulo","Caption","","${"A".repeat(501)}",""`,
      `"Titulo","Caption","","","${"F".repeat(2201)}"`,
    ].join("\n");

    const result = importPostsFromCsv(csv);
    expect(result.totalRows).toBe(5);
    expect(result.validCount).toBe(0);
    expect(result.invalidCount).toBe(5);
    expect(result.errors.some((e) => e.column === "title")).toBe(true);
    expect(result.errors.some((e) => e.column === "caption")).toBe(true);
    expect(result.errors.some((e) => e.column === "hashtags")).toBe(true);
    expect(result.errors.some((e) => e.column === "callToAction")).toBe(true);
    expect(result.errors.some((e) => e.column === "firstComment")).toBe(true);
  });

  it("flags invalid dates and normalizes valid dates", () => {
    const csv = [
      "caption,suggestedDate",
      `"Post com data válida","2026-11-20T10:00:00Z"`,
      `"Post com data inválida","2026-99-99"`,
      `"Post com texto na data","amanha de manha"`,
    ].join("\n");

    const result = importPostsFromCsv(csv);
    expect(result.totalRows).toBe(3);
    expect(result.validCount).toBe(1);
    expect(result.invalidCount).toBe(2);
    expect(result.validRows[0]!.suggestedDate).toBe("2026-11-20T10:00:00.000Z");
    expect(
      result.errors.filter((e) => e.column === "suggestedDate").length,
    ).toBe(2);
  });

  it("neutralizes dangerous formula injection triggers", () => {
    expect(sanitizeFormulaCell("=1+1")).toBe("'=1+1");
    expect(sanitizeFormulaCell("@SUM(A1:A10)")).toBe("'@SUM(A1:A10)");
    expect(sanitizeFormulaCell("-cmd|' /C calc'!A0")).toBe(
      "'-cmd|' /C calc'!A0",
    );
    expect(sanitizeFormulaCell("+12345")).toBe("'+12345");
    expect(sanitizeFormulaCell("\tDDE")).toBe("'\tDDE");
    expect(sanitizeFormulaCell("\rDDE")).toBe("'\rDDE");
    expect(sanitizeFormulaCell("Texto Normal")).toBe("Texto Normal");

    const csv = `title,caption\n"=cmd|calc","@alerta de novidade"`;
    const result = importPostsFromCsv(csv);
    expect(result.validCount).toBe(1);
    expect(result.validRows[0]!.title).toBe("'=cmd|calc");
    expect(result.validRows[0]!.caption).toBe("'@alerta de novidade");
  });

  it("rejects CSV exceeding 2 MiB size limit", () => {
    // 2 MiB = 2 * 1024 * 1024 = 2097152 bytes
    const largeBuffer = Buffer.alloc(2 * 1024 * 1024 + 10, "a");
    expect(() => importPostsFromCsv(largeBuffer)).toThrow(CsvSizeLimitError);
  });

  it("rejects CSV exceeding 500 data rows", () => {
    const lines = ["caption"];
    for (let i = 0; i < 501; i++) {
      lines.push(`"Post ${i}"`);
    }
    expect(() => importPostsFromCsv(lines.join("\n"))).toThrow(
      CsvRowLimitError,
    );
    expect(() => importPostsFromCsv(lines.join("\n"))).toThrow(
      "exceeds maximum limit of 500 data rows",
    );
  });

  it("rejects malformed CSV syntax with unclosed quotes or dangling quotes", () => {
    const unclosed = `caption\n"Texto sem fechar aspas`;
    expect(() => importPostsFromCsv(unclosed)).toThrow(CsvMalformedError);

    const dangling = `caption\nTexto "no meio" sem aspas externas`;
    expect(() => importPostsFromCsv(dangling)).toThrow(CsvMalformedError);
  });
});

describe("Content Contracts Unit Tests", () => {
  it("rejects mass assignment in contentBatchInput and postInput", () => {
    expect(
      contentBatchInput.safeParse({
        name: "Lote de Outubro",
        organizationId: "123e4567-e89b-12d3-a456-426614174000",
      }).success,
    ).toBe(false);

    expect(
      postInput.safeParse({
        caption: "Legenda do post",
        organizationId: "123e4567-e89b-12d3-a456-426614174000",
        clientId: "123e4567-e89b-12d3-a456-426614174001",
      }).success,
    ).toBe(false);

    expect(
      postUpdate.safeParse({
        caption: "Legenda atualizada",
        batchId: "123e4567-e89b-12d3-a456-426614174002",
      }).success,
    ).toBe(false);
  });

  it("validates post status transitions", () => {
    expect(
      postStatusTransition.safeParse({ status: "IN_REVIEW" }).success,
    ).toBe(true);
    expect(
      postStatusTransition.safeParse({
        status: "REJECTED",
        rejectionReason: "Copy precisa de mais clareza no CTA",
      }).success,
    ).toBe(true);
    expect(
      postStatusTransition.safeParse({ status: "UNKNOWN_STATUS" }).success,
    ).toBe(false);
  });
});
