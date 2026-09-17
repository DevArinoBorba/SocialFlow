import {
  MAX_CSV_DATA_ROWS,
  MAX_CSV_SIZE_BYTES,
  type ImportError,
} from "@socialflow/contracts";

export const KNOWN_POST_COLUMNS = [
  "title",
  "caption",
  "hashtags",
  "callToAction",
  "firstComment",
  "suggestedDate",
] as const;

export type KnownPostColumn = (typeof KNOWN_POST_COLUMNS)[number];

export type ValidPostRow = {
  title: string | null;
  caption: string;
  hashtags: string | null;
  callToAction: string | null;
  firstComment: string | null;
  suggestedDate: string | null;
};

export type CsvImportResult = {
  totalRows: number;
  validCount: number;
  invalidCount: number;
  validRows: ValidPostRow[];
  errors: ImportError[];
};

export class CsvMalformedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvMalformedError";
  }
}

export class CsvSizeLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvSizeLimitError";
  }
}

export class CsvRowLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvRowLimitError";
  }
}

export class CsvHeaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvHeaderError";
  }
}

/**
 * Neutraliza valores de células que possam ser interpretados como fórmulas por
 * aplicativos de planilhas (Excel, Calc, Sheets).
 * Caracteres perigosos no início: '=', '+', '-', '@', '\t', '\r'.
 */
export function sanitizeFormulaCell(value: string): string {
  if (value.length === 0) return value;
  const firstChar = value.charAt(0);
  if (
    firstChar === "=" ||
    firstChar === "+" ||
    firstChar === "-" ||
    firstChar === "@" ||
    firstChar === "\t" ||
    firstChar === "\r"
  ) {
    return `'${value}`;
  }
  return value;
}

/**
 * Parser RFC-4180 determinístico com suporte a aspas duplas, quebras de linha
 * e codificação UTF-8 com emojis.
 */
export function parseRawCsv(content: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentField = "";
  let insideQuotes = false;
  let i = 0;
  const len = content.length;

  while (i < len) {
    const char = content[i]!;

    if (insideQuotes) {
      if (char === '"') {
        if (i + 1 < len && content[i + 1] === '"') {
          currentField += '"';
          i += 2;
          continue;
        } else {
          insideQuotes = false;
          i++;
          continue;
        }
      } else {
        currentField += char;
        i++;
        continue;
      }
    } else {
      if (char === '"') {
        if (currentField.length > 0) {
          throw new CsvMalformedError(
            `Unexpected quote inside unquoted field at character ${i}`,
          );
        }
        insideQuotes = true;
        i++;
        continue;
      } else if (char === ",") {
        currentRow.push(currentField);
        currentField = "";
        i++;
        continue;
      } else if (char === "\r") {
        if (i + 1 < len && content[i + 1] === "\n") {
          i++;
        }
        currentRow.push(currentField);
        currentField = "";
        rows.push(currentRow);
        currentRow = [];
        i++;
        continue;
      } else if (char === "\n") {
        currentRow.push(currentField);
        currentField = "";
        rows.push(currentRow);
        currentRow = [];
        i++;
        continue;
      } else {
        currentField += char;
        i++;
        continue;
      }
    }
  }

  if (insideQuotes) {
    throw new CsvMalformedError("Unclosed quote in CSV input");
  }

  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    rows.push(currentRow);
  }

  return rows;
}

/**
 * Validador e normalizador de colunas individuais de post.
 */
function validateAndNormalizeField(
  column: KnownPostColumn,
  rawValue: string,
  rowNum: number,
  errors: ImportError[],
): string | null {
  const sanitized = sanitizeFormulaCell(rawValue.trim());

  switch (column) {
    case "caption": {
      if (sanitized.length === 0) {
        errors.push({
          row: rowNum,
          column: "caption",
          message: "Caption is required and cannot be empty",
          rawValue,
        });
        return "";
      }
      if (sanitized.length > 5000) {
        errors.push({
          row: rowNum,
          column: "caption",
          message: "Caption exceeds maximum length of 5000 characters",
          rawValue: rawValue.slice(0, 50) + "...",
        });
        return "";
      }
      return sanitized;
    }
    case "title": {
      if (sanitized.length === 0) return null;
      if (sanitized.length > 120) {
        errors.push({
          row: rowNum,
          column: "title",
          message: "Title exceeds maximum length of 120 characters",
          rawValue,
        });
        return null;
      }
      return sanitized;
    }
    case "hashtags": {
      if (sanitized.length === 0) return null;
      if (sanitized.length > 1000) {
        errors.push({
          row: rowNum,
          column: "hashtags",
          message: "Hashtags exceeds maximum length of 1000 characters",
          rawValue: rawValue.slice(0, 50) + "...",
        });
        return null;
      }
      return sanitized;
    }
    case "callToAction": {
      if (sanitized.length === 0) return null;
      if (sanitized.length > 500) {
        errors.push({
          row: rowNum,
          column: "callToAction",
          message: "Call to action exceeds maximum length of 500 characters",
          rawValue,
        });
        return null;
      }
      return sanitized;
    }
    case "firstComment": {
      if (sanitized.length === 0) return null;
      if (sanitized.length > 2200) {
        errors.push({
          row: rowNum,
          column: "firstComment",
          message: "First comment exceeds maximum length of 2200 characters",
          rawValue: rawValue.slice(0, 50) + "...",
        });
        return null;
      }
      return sanitized;
    }
    case "suggestedDate": {
      if (sanitized.length === 0) return null;
      const parsed = Date.parse(rawValue.trim());
      if (Number.isNaN(parsed)) {
        errors.push({
          row: rowNum,
          column: "suggestedDate",
          message:
            "Suggested date is not a valid date format (expected ISO 8601)",
          rawValue,
        });
        return null;
      }
      return new Date(parsed).toISOString();
    }
  }
}

/**
 * Importador principal de CSV para ContentBatch e Posts.
 */
export function importPostsFromCsv(
  csvContent: string | Buffer,
): CsvImportResult {
  const byteSize = Buffer.isBuffer(csvContent)
    ? csvContent.byteLength
    : Buffer.byteLength(csvContent, "utf-8");

  if (byteSize > MAX_CSV_SIZE_BYTES) {
    throw new CsvSizeLimitError(
      `CSV file size (${byteSize} bytes) exceeds maximum allowed of ${MAX_CSV_SIZE_BYTES} bytes (2 MiB)`,
    );
  }

  const text = Buffer.isBuffer(csvContent)
    ? csvContent.toString("utf-8")
    : csvContent;

  if (text.trim().length === 0) {
    throw new CsvHeaderError("CSV file is empty");
  }

  const rawRows = parseRawCsv(text);

  // Filtrar linhas completamente vazias do final ou início
  const nonEmptyRows = rawRows.filter((r) =>
    r.some((c) => c.trim().length > 0),
  );

  if (nonEmptyRows.length === 0) {
    throw new CsvHeaderError("CSV file contains no data or header");
  }

  const headerRow = nonEmptyRows[0]!;
  const dataRows = nonEmptyRows.slice(1);

  if (dataRows.length > MAX_CSV_DATA_ROWS) {
    throw new CsvRowLimitError(
      `CSV rows count (${dataRows.length}) exceeds maximum limit of ${MAX_CSV_DATA_ROWS} data rows`,
    );
  }

  // Normalizar e validar o cabeçalho
  const headerMap = new Map<string, number>();
  for (let i = 0; i < headerRow.length; i++) {
    const rawHeader = headerRow[i]!.trim();
    if (!rawHeader) continue;

    if (
      !KNOWN_POST_COLUMNS.includes(
        rawHeader as (typeof KNOWN_POST_COLUMNS)[number],
      )
    ) {
      throw new CsvHeaderError(
        `Unknown column in CSV header: "${rawHeader}". Expected one of: ${KNOWN_POST_COLUMNS.join(", ")}`,
      );
    }

    if (headerMap.has(rawHeader)) {
      throw new CsvHeaderError(
        `Duplicate column in CSV header: "${rawHeader}"`,
      );
    }

    headerMap.set(rawHeader, i);
  }

  if (!headerMap.has("caption")) {
    throw new CsvHeaderError(
      'CSV header is missing mandatory "caption" column',
    );
  }

  const validRows: ValidPostRow[] = [];
  const errors: ImportError[] = [];

  for (let idx = 0; idx < dataRows.length; idx++) {
    const row = dataRows[idx]!;
    const rowNum = idx + 2; // Linha 1 é o cabeçalho
    const rowErrors: ImportError[] = [];

    // Checar discrepância grosseira de colunas
    if (row.length > headerRow.length) {
      rowErrors.push({
        row: rowNum,
        column: "general",
        message: `Row has ${row.length} columns, expected at most ${headerRow.length}`,
      });
    }

    const getVal = (col: KnownPostColumn): string => {
      const colIdx = headerMap.get(col);
      if (colIdx === undefined || colIdx >= row.length) return "";
      return row[colIdx] ?? "";
    };

    const caption = validateAndNormalizeField(
      "caption",
      getVal("caption"),
      rowNum,
      rowErrors,
    );

    const title = validateAndNormalizeField(
      "title",
      getVal("title"),
      rowNum,
      rowErrors,
    );

    const hashtags = validateAndNormalizeField(
      "hashtags",
      getVal("hashtags"),
      rowNum,
      rowErrors,
    );

    const callToAction = validateAndNormalizeField(
      "callToAction",
      getVal("callToAction"),
      rowNum,
      rowErrors,
    );

    const firstComment = validateAndNormalizeField(
      "firstComment",
      getVal("firstComment"),
      rowNum,
      rowErrors,
    );

    const suggestedDate = validateAndNormalizeField(
      "suggestedDate",
      getVal("suggestedDate"),
      rowNum,
      rowErrors,
    );

    if (rowErrors.length > 0) {
      errors.push(...rowErrors);
    } else {
      validRows.push({
        caption: caption!,
        title,
        hashtags,
        callToAction,
        firstComment,
        suggestedDate,
      });
    }
  }

  return {
    totalRows: dataRows.length,
    validCount: validRows.length,
    invalidCount: dataRows.length - validRows.length,
    validRows,
    errors,
  };
}
