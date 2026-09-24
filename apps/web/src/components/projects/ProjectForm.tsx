import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { FormField } from "../forms/FormField";
import { TextareaField } from "../forms/TextareaField";
import { SelectField } from "../forms/SelectField";
import { Button } from "../ui/Button";
import { PROJECT_STATUS_META } from "../../lib/statusMeta";
import { PROJECT_STATUSES, type Project } from "../../types/project";
import { projectFormSchema, type ProjectFormValues } from "../../validators/projectSchemas";

const statusOptions = PROJECT_STATUSES.map((value) => ({ value, label: PROJECT_STATUS_META[value].label }));

interface ProjectFormProps {
  defaultValues?: Pick<Project, "name" | "description" | "status"> | undefined;
  submitLabel: string;
  submittingLabel: string;
  serverError?: string | null | undefined;
  onSubmit: (values: ProjectFormValues) => Promise<void>;
  onCancel?: (() => void) | undefined;
}

export function ProjectForm({
  defaultValues,
  submitLabel,
  submittingLabel,
  serverError,
  onSubmit,
  onCancel,
}: ProjectFormProps) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ProjectFormValues>({
    resolver: zodResolver(projectFormSchema),
    defaultValues: defaultValues ?? { status: "planning" },
  });

  const handleFormSubmit = handleSubmit(async (values) => {
    await onSubmit(values);
  });

  return (
    <form onSubmit={handleFormSubmit} noValidate className="flex flex-col gap-4">
      <FormField label="Name" type="text" error={errors.name?.message} {...register("name")} />
      <TextareaField label="Description" error={errors.description?.message} {...register("description")} />
      <SelectField
        label="Status"
        options={statusOptions}
        error={errors.status?.message}
        {...register("status")}
      />

      {serverError && (
        <p role="alert" className="text-sm text-red-600">
          {serverError}
        </p>
      )}

      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? submittingLabel : submitLabel}
        </Button>
      </div>
    </form>
  );
}
