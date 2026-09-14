import { z } from "zod";
export const roles = [
  "OWNER",
  "ADMIN",
  "EDITOR",
  "APPROVER",
  "CLIENT_VIEWER",
] as const;
export const clientInput = z.strictObject({
  name: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});
export const clientUpdate = z.strictObject({ name: clientInput.shape.name });
export type Role = (typeof roles)[number];
export type Client = {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  active: boolean;
};
export type Access = {
  organizationId: string;
  clientId: string | null;
  role: Role;
  organization: { name: string };
};
export type CurrentUser = {
  user: { name: string; email: string };
  memberships: Access[];
};
export const isAdmin = (role: string) => role === "OWNER" || role === "ADMIN";

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    .transform((val) => (val === "" || val === undefined ? null : val));

export const brandInput = z.strictObject({
  name: z.string().trim().min(2).max(120),
  description: optionalText(2000),
  targetAudience: optionalText(1000),
  toneOfVoice: optionalText(1000),
});

export const brandUpdate = brandInput;

export type Brand = {
  id: string;
  organizationId: string;
  clientId: string;
  name: string;
  description: string | null;
  targetAudience: string | null;
  toneOfVoice: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
};
