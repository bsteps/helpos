// From beUI (https://beui.dev), MIT licence: see src/components/ui/BEUI-LICENSE.md.
// beui.dev/components/motion/loader — trimmed to the "spinner" variant, the only one used here.

import { motion, useReducedMotion } from "motion/react";
import { EASE_IN_OUT } from "@/lib/ease";
import { cn } from "@/lib/utils";

export interface LoaderProps {
  /** Base square size in px. Everything scales from this. */
  size?: number;
  /** Seconds per animation cycle. */
  speed?: number;
  /** Accessible label announced to screen readers. */
  label?: string;
  className?: string;
}

// Reduced motion keeps a calm opacity pulse and drops every transform.
const REDUCED = {
  animate: { opacity: [1, 0.4, 1] },
  transition: { duration: 1.4, ease: EASE_IN_OUT, repeat: Infinity },
};

export function Loader({ size = 32, speed = 1, label = "Loading", className }: LoaderProps) {
  const reduce = useReducedMotion() ?? false;
  const stroke = Math.max(2, size * 0.09);
  const r = (size - stroke) / 2;

  return (
    <span
      role="status"
      aria-label={label}
      className={cn("inline-flex items-center justify-center text-foreground", className)}
    >
      <motion.svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden
        animate={reduce ? REDUCED.animate : { rotate: 360 }}
        transition={
          reduce ? REDUCED.transition : { duration: speed, ease: "linear", repeat: Infinity }
        }
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.2}
          strokeWidth={stroke}
        />
        <path
          d={`M ${size / 2} ${size / 2 - r} A ${r} ${r} 0 0 1 ${size / 2 + r} ${size / 2}`}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
        />
      </motion.svg>
      <span className="sr-only">{label}</span>
    </span>
  );
}
