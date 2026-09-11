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
