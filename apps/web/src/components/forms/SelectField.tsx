import { forwardRef, type SelectHTMLAttributes } from "react";

interface Option {
  value: string;
  label: string;
}

interface SelectFieldProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label: string;
  name: string;
  options: Option[];
  error?: string | undefined;
}

// A native <select> rather than a custom Radix/Listbox component —
// natively accessible and keyboard-operable with zero extra code, which
// is what this actually needs (a handful of enum choices, no search, no
// multi-select, no rich option rendering).
export const SelectField = forwardRef<HTMLSelectElement, SelectFieldProps>(function SelectField(
  { label, name, options, error, className = "", ...selectProps },
  ref,
) {
  const errorId = `${name}-error`;

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={name} className="text-sm font-medium text-slate-700">
        {label}
      </label>
      <select
        ref={ref}
        id={name}
        name={name}
        aria-invalid={error ? "true" : "false"}
        aria-describedby={error ? errorId : undefined}
        className={`rounded-md border bg-white px-3 py-2 text-sm shadow-sm outline-none transition-colors focus:ring-2 focus:ring-brand-500 ${
          error ? "border-red-400 focus:border-red-400" : "border-slate-300 focus:border-brand-500"
        } ${className}`}
        {...selectProps}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error && (
        <p id={errorId} role="alert" className="text-xs text-red-600">
          {error}
        </p>
      )}
    </div>
  );
});
