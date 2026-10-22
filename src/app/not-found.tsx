import Link from "next/link";

import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="flex min-h-[60dvh] flex-col items-center justify-center text-center">
      <p className="text-sm font-medium text-muted-foreground">404</p>
      <h1 className="mt-1 text-xl font-semibold">Not found</h1>
      <p className="mt-1 text-sm text-muted-foreground">That team or page doesn&apos;t exist (it may have been removed).</p>
      <Button className="mt-5" nativeButton={false} render={<Link href="/" />}>
        Back to dashboard
      </Button>
    </div>
  );
}
