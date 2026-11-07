// From beUI (https://beui.dev), MIT licence: see src/components/ui/BEUI-LICENSE.md.
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
