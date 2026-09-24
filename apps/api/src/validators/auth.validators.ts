import { z } from "zod";

// Length over complexity, per NIST 800-63B guidance — no forced
// uppercase/digit/symbol rules, just a reasonable minimum. Max 72 matches
// bcrypt's input limit (see utils/password.ts) so a longer password fails
// validation with a clear message instead of being silently truncated.
const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .max(72, "Password must be at most 72 characters");

const emailSchema = z.string().trim().toLowerCase().email("Invalid email address");

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1, "Display name is required").max(100),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, "Password is required"),
});
export type LoginInput = z.infer<typeof loginSchema>;
