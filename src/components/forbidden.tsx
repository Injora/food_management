import { ShieldCheck } from "lucide-react";

export function Forbidden({ what = "this page" }: { what?: string }) {
  return (
    <div className="mx-auto mt-16 max-w-md rounded-xl border bg-card p-8 text-center">
      <ShieldCheck className="mx-auto size-8 text-muted-foreground" aria-hidden />
      <h1 className="mt-3 text-lg font-semibold">Admins only</h1>
      <p className="mt-1 text-sm text-muted-foreground">You need admin access to open {what}. Ask an event admin if you need it.</p>
    </div>
  );
}
