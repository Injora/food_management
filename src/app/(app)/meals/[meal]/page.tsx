import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getDb } from "@/db";
import { isMealType, MEAL_LABELS } from "@/lib/meals";
import { requireActor } from "@/server/auth/current";
import { listMealDistribution } from "@/server/services/distribution";
import { MealBoard } from "./meal-board";

export async function generateMetadata({ params }: PageProps<"/meals/[meal]">): Promise<Metadata> {
  const { meal } = await params;
  return { title: isMealType(meal) ? MEAL_LABELS[meal] : "Meal" };
}

export default async function MealPage({ params }: PageProps<"/meals/[meal]">) {
  const { meal } = await params;
  if (!isMealType(meal)) notFound();
  const actor = await requireActor();
  const rows = await listMealDistribution(getDb(), actor, meal);
  // Keyed by meal so switching meals resets search and selection.
  return <MealBoard key={meal} meal={meal} initialRows={rows} />;
}
