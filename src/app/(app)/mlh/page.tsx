import type { Metadata } from "next";

import { getDb } from "@/db";
import { requireActor } from "@/server/auth/current";
import { getMlhList } from "@/server/services/mlh";
import { MlhRegistrations } from "./mlh-registrations";

export const metadata: Metadata = { title: "MLH registrations" };

export default async function MlhPage() {
  const actor = await requireActor();
  return <MlhRegistrations list={await getMlhList(await getDb(), actor)} />;
}
