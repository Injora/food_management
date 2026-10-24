import { redirect } from "next/navigation";

/** Old team links open the team panel on the Teams page. */
export default async function TeamRedirect({ params }: PageProps<"/teams/[id]">) {
  const { id } = await params;
  redirect(`/teams?team=${encodeURIComponent(id)}`);
}
