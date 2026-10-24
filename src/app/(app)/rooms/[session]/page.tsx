import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { isSessionId, SESSION_LABELS } from "@/lib/domain";
import { RoomDesk } from "./room-desk";

export async function generateMetadata({ params }: PageProps<"/rooms/[session]">): Promise<Metadata> {
  const { session } = await params;
  return { title: isSessionId(session) ? `${SESSION_LABELS[session]} rooms` : "Rooms" };
}

export default async function RoomsPage({ params }: PageProps<"/rooms/[session]">) {
  const { session } = await params;
  if (!isSessionId(session)) notFound();
  // Keyed so switching tabs resets the selected team.
  return <RoomDesk key={session} session={session} />;
}
