import { z } from "zod";

// Client-side validation for immediate feedback only — the backend
// (apps/api/src/validators/auth.validators.ts) remains the authoritative
// check and re-validates everything regardless of what the client sends.
export const registerFormSchema = z.object({
  email: z.string().trim().min(1, "Email is required").email("Invalid email address"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(72, "Password must be at most 72 characters"),
  displayName: z.string().trim().min(1, "Display name is required").max(100),
});
export type RegisterFormValues = z.infer<typeof registerFormSchema>;

export const loginFormSchema = z.object({
  email: z.string().trim().min(1, "Email is required").email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});
export type LoginFormValues = z.infer<typeof loginFormSchema>;
