import { motion, useReducedMotion } from "motion/react";
import { type TextareaHTMLAttributes, useId, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Multi-line text field. beUI has no textarea, so this one follows its Input: the same label,
 * border, focus ring, error colour and message, with a softer radius for a tall field.
 */
export interface TextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** A message shows below the field; `true` only marks it. */
  error?: string | boolean | undefined;
}

export function Textarea({
  label,
  value,
  onChange,
  error,
  className,
  disabled,
  id: idProp,
  onFocus,
  onBlur,
  ...rest
}: TextareaProps) {
  const reactId = useId();
  const id = idProp ?? reactId;
  const reduce = useReducedMotion();
  const [focused, setFocused] = useState(false);
  const hasError = Boolean(error);
  const message = typeof error === "string" ? error : null;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="px-1 font-medium text-foreground text-sm">
        {label}
      </label>
      <div
        data-state={hasError ? "error" : focused ? "focused" : "idle"}
        className={cn(
          "rounded-2xl border border-border transition-colors duration-200",
          focused && !hasError && "border-foreground/40 ring-2 ring-ring/40",
          hasError && "border-destructive ring-2 ring-destructive/25",
          disabled && "opacity-60",
        )}
      >
        <textarea
          id={id}
          value={value}
          disabled={disabled}
          aria-invalid={hasError || undefined}
          aria-describedby={message ? `${id}-error` : undefined}
          {...rest}
          onChange={(event) => onChange(event.target.value)}
          onFocus={(event) => {
            setFocused(true);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
          className={cn(
            "block min-h-40 w-full resize-y rounded-2xl bg-transparent px-3.5 py-3",
            "text-base text-foreground leading-6 caret-foreground outline-none",
            "placeholder:text-muted-foreground/60",
            disabled && "cursor-not-allowed",
          )}
        />
      </div>
      {message ? (
        <motion.p
          id={`${id}-error`}
          role="alert"
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2 }}
          className="px-1 text-destructive text-xs"
        >
          {message}
        </motion.p>
      ) : null}
    </div>
  );
}
