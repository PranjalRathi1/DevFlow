import { z } from "zod";

export const configureSourceSchema = z.object({
  path: z.string().trim().min(1, "A source path is required").max(1000),
});
export type ConfigureSourceInput = z.infer<typeof configureSourceSchema>;
