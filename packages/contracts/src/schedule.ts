import { z } from "zod";
import { validateIanaTimeZone } from "./timezone.js";
import { publicationAttemptDto } from "./social-account.js";

export const publicationScheduleStatuses = [
  "SCHEDULED",
  "ENQUEUED",
  "PROCESSING",
  "PUBLISHED",
  "PARTIALLY_PUBLISHED",
  "FAILED",
  "CANCELLED",
  "DEAD_LETTER",
  "REQUIRES_RECONCILIATION",
] as const;

export type PublicationScheduleStatus =
  (typeof publicationScheduleStatuses)[number];

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((val) => (val === "" || val === undefined ? null : val));

export const createScheduleInput = z.strictObject({
  targetAccountIds: z
    .array(z.string().uuid())
    .min(1, "Selecione ao menos uma conta social para o agendamento."),
  mediaAssetId: z
    .string()
    .uuid()
    .optional()
    .nullable()
    .transform((val) => (val === "" || val === undefined ? null : val)),
  scheduledTimezone: z
    .string()
    .refine(
      (tz) => validateIanaTimeZone(tz),
      "Fuso horário IANA inválido ou não suportado.",
    ),
  scheduledLocalTime: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?$/,
      "Data e hora local devem estar no formato YYYY-MM-DDTHH:mm ou YYYY-MM-DDTHH:mm:ss.",
    ),
  confirmed: z.literal(true, {
    message: "A confirmação explícita do agendamento é obrigatória.",
  }),
});
export type CreateScheduleInput = z.infer<typeof createScheduleInput>;

export const rescheduleInput = z.strictObject({
  scheduledTimezone: z
    .string()
    .refine(
      (tz) => validateIanaTimeZone(tz),
      "Fuso horário IANA inválido ou não suportado.",
    ),
  scheduledLocalTime: z
    .string()
    .regex(
      /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?$/,
      "Data e hora local devem estar no formato YYYY-MM-DDTHH:mm ou YYYY-MM-DDTHH:mm:ss.",
    ),
  confirmed: z.literal(true, {
    message: "A confirmação explícita da reprogramação é obrigatória.",
  }),
});
export type RescheduleInput = z.infer<typeof rescheduleInput>;

export const cancelScheduleInput = z.strictObject({
  reason: optionalText(500),
});
export type CancelScheduleInput = z.infer<typeof cancelScheduleInput>;

export const publicationScheduleDto = z.strictObject({
  id: z.string().uuid(),
  organizationId: z.string(),
  clientId: z.string(),
  postId: z.string().uuid(),
  targetAccountIds: z.array(z.string().uuid()),
  mediaAssetId: z.string().uuid().nullable().optional(),
  scheduledTimezone: z.string(),
  scheduledLocalTime: z.string(),
  scheduledForUtc: z.union([z.string(), z.date()]),
  status: z.enum(publicationScheduleStatuses),
  version: z.number().int().min(1),
  jobId: z.string(),
  createdById: z.string(),
  cancellationReason: z.string().nullable().optional(),
  failureReason: z.string().nullable().optional(),
  createdAt: z.union([z.string(), z.date()]),
  updatedAt: z.union([z.string(), z.date()]),
  attempts: z.array(publicationAttemptDto).optional(),
});
export type PublicationScheduleDto = z.infer<typeof publicationScheduleDto>;

export const listSchedulesResponse = z.strictObject({
  schedules: z.array(publicationScheduleDto),
});
export type ListSchedulesResponse = z.infer<typeof listSchedulesResponse>;
