import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Standard shadcn `cn` helper — merges class lists and resolves Tailwind
 * conflicts (later utility wins). Used by every shadcn primitive added in
 * (GlassCard, Avatar, Popover, Command, etc.).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
