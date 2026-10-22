import { Coffee, Moon, UtensilsCrossed, type LucideIcon } from "lucide-react";

import type { MealType } from "@/lib/meals";

export const MEAL_ICONS: Record<MealType, LucideIcon> = {
  breakfast: Coffee,
  lunch: UtensilsCrossed,
  dinner: Moon,
};
