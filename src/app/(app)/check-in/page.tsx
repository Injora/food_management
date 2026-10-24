import type { Metadata } from "next";

import { CheckInDesk } from "./check-in-desk";

export const metadata: Metadata = { title: "Check-in" };

export default function CheckInPage() {
  return <CheckInDesk />;
}
