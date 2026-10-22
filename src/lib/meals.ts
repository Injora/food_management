export const MEAL_TYPES = ["breakfast", "lunch", "dinner"] as const;
export type MealType = (typeof MEAL_TYPES)[number];

export const MEAL_LABELS: Record<MealType, string> = {
  breakfast: "Breakfast",
  lunch: "Lunch",
  dinner: "Dinner",
};

export function isMealType(value: unknown): value is MealType {
  return typeof value === "string" && (MEAL_TYPES as readonly string[]).includes(value);
}

export const DISTRIBUTION_STATUSES = ["pending", "issued"] as const;
export type DistributionStatus = (typeof DISTRIBUTION_STATUSES)[number];

export const ROLES = ["admin", "organizer"] as const;
export type Role = (typeof ROLES)[number];
