// From beUI (https://beui.dev), MIT licence: see src/components/ui/BEUI-LICENSE.md.
// beui.dev/components/motion/button

import { type HTMLMotionProps, motion, useReducedMotion } from "motion/react";
import { forwardRef, type ReactNode } from "react";
import { SPRING_PRESS } from "@/lib/ease";
import { useHoverCapable } from "@/lib/hooks/use-hover-capable";
import { cn } from "@/lib/utils";

type ButtonVariant = "primary" | "ghost" | "outline";
type ButtonSize = "sm" | "md";

export interface ButtonProps extends Omit<HTMLMotionProps<"button">, "children"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  children?: ReactNode;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: "bg-primary text-primary-foreground hover:bg-primary/90",
  ghost: "text-muted-foreground hover:text-foreground hover:bg-muted/60",
  outline: "border border-border bg-transparent text-foreground hover:bg-muted/60",
};

const SIZE_CLASS: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-xs gap-1.5 rounded-full",
  md: "h-10 px-5 text-sm gap-2 rounded-full",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", className, children, ...rest },
  ref,
) {
  const reduce = useReducedMotion();
  const canHover = useHoverCapable();
  return (
    <motion.button
      ref={ref}
      type="button"
      {...(reduce ? {} : { whileTap: { scale: 0.93 } })}
      {...(reduce || !canHover ? {} : { whileHover: { scale: 1.02 } })}
      transition={SPRING_PRESS}
      className={cn(
        "inline-flex items-center justify-center font-medium select-none",
        "transition-colors",
        "disabled:pointer-events-none disabled:opacity-50",
        VARIANT_CLASS[variant],
        SIZE_CLASS[size],
        className,
      )}
      {...rest}
    >
      {children}
    </motion.button>
  );
});
