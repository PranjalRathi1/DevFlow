import { forwardRef, type TextareaHTMLAttributes } from "react";

interface TextareaFieldProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  name: string;
  error?: string | undefined;
}

export const TextareaField = forwardRef<HTMLTextAreaElement, TextareaFieldProps>(function TextareaField(
  { label, name, error, className = "", ...textareaProps },
  ref,
) {
  const errorId = `${name}-error`;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={name} className="text-sm font-medium text-slate-700">
        {label}
      </label>
      <textarea
        ref={ref}
        id={name}
        name={name}
        rows={4}
        aria-invalid={error ? "true" : "false"}
        aria-describedby={error ? errorId : undefined}
        className={`rounded-md border px-3 py-2 text-sm shadow-sm outline-none transition-colors focus:ring-2 focus:ring-brand-500 ${
          error ? "border-red-400 focus:border-red-400" : "border-slate-300 focus:border-brand-500"
        } ${className}`}
        {...textareaProps}
      />
      {error && (
        <p id={errorId} role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
});
