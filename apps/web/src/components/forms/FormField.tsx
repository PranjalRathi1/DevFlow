import { forwardRef, type InputHTMLAttributes } from "react";

interface FormFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  name: string;
  error?: string | undefined;
}

// react-hook-form's register() returns a ref callback that must reach the
// real <input> DOM node (it reads values as an uncontrolled input) — a
// plain function component silently drops that ref, so this must forward
// it explicitly.
export const FormField = forwardRef<HTMLInputElement, FormFieldProps>(function FormField(
  { label, name, error, ...inputProps },
  ref,
) {
  const errorId = `${name}-error`;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={name} className="text-sm font-medium text-slate-700">
        {label}
      </label>
      <input
        ref={ref}
        id={name}
        name={name}
        aria-invalid={error ? "true" : "false"}
        aria-describedby={error ? errorId : undefined}
        className={`rounded-md border px-3 py-2 text-sm shadow-sm outline-none transition-colors focus:ring-2 focus:ring-brand-500 ${
          error ? "border-red-400 focus:border-red-400" : "border-slate-300 focus:border-brand-500"
        }`}
        {...inputProps}
      />
      {error && (
        <p id={errorId} role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
});
