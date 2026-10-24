import type { Metadata } from "next";
import { Suspense } from "react";

import { CouponDesk } from "./coupon-desk";

export const metadata: Metadata = { title: "Food coupons" };

export default function CouponsPage() {
  return (
    <Suspense>
      <CouponDesk />
    </Suspense>
  );
}
