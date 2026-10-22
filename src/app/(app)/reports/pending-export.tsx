"use client";

import { useState } from "react";
import { Download } from "lucide-react";

import { NativeSelect } from "@/components/native-select";
import { Button } from "@/components/ui/button";
import { MEAL_LABELS, MEAL_TYPES, type MealType } from "@/lib/meals";

export function PendingExport() {
  const [meal, setMeal] = useState<MealType>("lunch");
  return (
    <div className="flex gap-1.5">
      <NativeSelect aria-label="Meal for pending export" className="flex-1 [&_select]:h-8" value={meal} onChange={(e) => setMeal(e.target.value as MealType)}>
        {MEAL_TYPES.map((m) => (
          <option key={m} value={m}>
            Pending: {MEAL_LABELS[m]}
          </option>
        ))}
      </NativeSelect>
      <Button variant="outline" size="sm" nativeButton={false} render={<a href={`/api/export/pending?meal=${meal}`} download />}>
        <Download /> Export
      </Button>
    </div>
  );
}
