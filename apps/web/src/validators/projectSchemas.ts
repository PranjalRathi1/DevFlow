import { z } from "zod";
import { PROJECT_STATUSES } from "../types/project";

export const projectFormSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200),
  description: z.string().trim().max(2000).optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
});
export type ProjectFormValues = z.infer<typeof projectFormSchema>;
