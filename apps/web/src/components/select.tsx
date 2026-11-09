import { type SelectHTMLAttributes, useId } from "react";
import { cn } from "@/lib/utils";

/**
 * Native select. beUI has no select, so this one follows its Input: the same label, height,
 * border, focus ring and disabled look, with the browser's own option list.
 */
export interface SelectProps<T extends string>
  extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "value" | "onChange"> {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}

export function Select<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
  id: idProp,
  ...rest
}: SelectProps<T>) {
  const reactId = useId();
  const id = idProp ?? reactId;
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="px-1 font-medium text-foreground text-sm">
        {label}
      </label>
      <select
        {...rest}
        id={id}
        value={value}
        onChange={(e) => {
          const picked = options.find((o) => o.value === e.target.value);
          if (picked) onChange(picked.value);
        }}
        className={cn(
          "h-11 rounded-full border border-border bg-transparent px-3.5 text-base text-foreground outline-none transition-colors duration-200",
          "focus:border-foreground/40 focus:ring-2 focus:ring-ring/40",
          "disabled:cursor-not-allowed disabled:opacity-60",
        )}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
