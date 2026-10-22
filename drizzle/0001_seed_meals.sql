-- The three meals are reference data: distributions.meal_type references them.
INSERT INTO "meals" ("type", "label", "sort_order") VALUES
  ('breakfast', 'Breakfast', 1),
  ('lunch', 'Lunch', 2),
  ('dinner', 'Dinner', 3)
ON CONFLICT ("type") DO NOTHING;
