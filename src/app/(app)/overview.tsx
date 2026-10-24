"use client";

import Link from "next/link";
import { CircleAlert, DoorOpen, Mic, OctagonAlert, TriangleAlert, Upload, Users } from "lucide-react";

import { AuditList } from "@/components/audit-list";
import { useBoard } from "@/components/board-context";
import { EmptyState } from "@/components/empty-state";
import { Pill } from "@/components/ops-badges";
import { PageHeader } from "@/components/page-header";
import { LEVEL_TONE, OccupancyBar } from "@/components/room-card";
import { StatTile } from "@/components/stat-tile";
import { useTeamPanel } from "@/components/team-panel";
import { Button } from "@/components/ui/button";
import { effectiveMax, isLimited, nominalRemaining, roomLevel, ROOM_LEVEL_LABELS } from "@/lib/capacity";
import { COUPON_LABELS, COUPON_TYPES, SESSION_IDS, SESSION_LABELS, type SessionId } from "@/lib/domain";
import { formatNumber, formatPercent } from "@/lib/format";
import { summarize } from "@/lib/summary";
import type { AuditRow } from "@/server/services/audit";

export function Overview({ activity, isAdmin }: { activity: AuditRow[]; isAdmin: boolean }) {
  const { board } = useBoard();
  const { openTeam } = useTeamPanel();
  const s = summarize(board);

  if (board.teams.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Overview" />
        <EmptyState icon={Users} title="No teams registered yet">
          {isAdmin ? (
            <>
              Import the registration file to get started.
              <div className="mt-4">
                <Button nativeButton={false} render={<Link href="/import" />}>
                  <Upload /> Import registrations
                </Button>
              </div>
            </>
          ) : (
            "An admin needs to import the registration file first."
          )}
        </EmptyState>
      </div>
    );
  }

  const alerts: { tone: "danger" | "warning"; text: string; href: string }[] = [];
  for (const r of board.rooms) {
    if (!isLimited(r)) continue; // talk rooms have no limit to warn about
    const level = roomLevel(r);
    const where = `${SESSION_LABELS[r.sessionId]} · Room ${r.roomNumber}`;
    if (level === "max") alerts.push({ tone: "danger", text: `${where} is FULL (${r.occupancy}/${r.nominalCapacity}, limit ${effectiveMax(r)} reached).`, href: `/rooms/${r.sessionId}` });
    else if (level === "overflow") alerts.push({ tone: "danger", text: `${where} is over nominal capacity: ${r.occupancy}/${r.nominalCapacity}.`, href: `/rooms/${r.sessionId}` });
    else if (level === "full" || level === "near") alerts.push({ tone: "warning", text: `${where} is nearly full: ${r.occupancy}/${r.nominalCapacity}, ${nominalRemaining(r)} left.`, href: `/rooms/${r.sessionId}` });
  }
  for (const id of SESSION_IDS) {
    const agg = s.rooms[id];
    if (agg.rooms > 0 && agg.nominal !== null && agg.occupancy >= agg.nominal) alerts.push({ tone: "danger", text: `${SESSION_LABELS[id]}: every room is at nominal capacity.`, href: `/rooms/${id}` });
  }
  if (s.teamsPartial > 0) alerts.push({ tone: "warning", text: `${s.teamsPartial} team${s.teamsPartial === 1 ? " is" : "s are"} partially checked in.`, href: "/teams?status=partial" });

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Overview" description="Live counts from the database; updates every few seconds." />

      <section aria-label="Registration and attendance" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <StatTile label="Registered teams" value={formatNumber(s.teams)} />
        <StatTile label="Registered participants" value={formatNumber(s.participants)} />
        <StatTile
          label="Participants checked in"
          value={
            <>
              {formatNumber(s.present)}
              <span className="text-base font-normal text-muted-foreground"> / {formatNumber(s.participants)}</span>
            </>
          }
          hint={formatPercent(s.participants ? s.present / s.participants : 0)}
        />
        <Link href="/teams?status=full" className="rounded-xl focus-visible:ring-3 focus-visible:ring-ring/50">
          <StatTile label="Teams fully checked in" value={formatNumber(s.teamsFull)} className="h-full border-success/40 hover:bg-muted/40" />
        </Link>
        <Link href="/teams?status=partial" className="rounded-xl focus-visible:ring-3 focus-visible:ring-ring/50">
          <StatTile label="Teams partially in" value={formatNumber(s.teamsPartial)} className="h-full border-warning/50 hover:bg-muted/40" />
        </Link>
        <Link href="/teams?status=none" className="rounded-xl focus-visible:ring-3 focus-visible:ring-ring/50">
          <StatTile label="Teams not checked in" value={formatNumber(s.teamsNone)} className="h-full hover:bg-muted/40" />
        </Link>
      </section>

      <section aria-label="Coupons and rooms" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        {COUPON_TYPES.map((c) => (
          <Link key={c} href={`/coupons?meal=${c}`} className="rounded-xl focus-visible:ring-3 focus-visible:ring-ring/50">
            <StatTile
              label={`${COUPON_LABELS[c]} coupons issued`}
              value={
                <>
                  {formatNumber(s.coupons[c].issued)}
                  <span className="text-base font-normal text-muted-foreground"> / {formatNumber(s.coupons[c].entitled)}</span>
                </>
              }
              hint={`${formatNumber(Math.max(0, s.coupons[c].entitled - s.coupons[c].issued))} pending`}
              className="h-full hover:bg-muted/40"
            />
          </Link>
        ))}
        {SESSION_IDS.map((id) => {
          const agg = s.rooms[id];
          const Icon = id === "talks" ? Mic : DoorOpen;
          return (
            <Link key={id} href={`/rooms/${id}`} className="rounded-xl focus-visible:ring-3 focus-visible:ring-ring/50">
              <StatTile
                label={`${id === "talks" ? "Talk" : "Hackathon"} room occupancy`}
                value={
                  <span className="flex items-center gap-2">
                    <Icon className="size-5 text-muted-foreground" aria-hidden />
                    {formatNumber(agg.occupancy)}
                    {agg.nominal !== null && <span className="text-base font-normal text-muted-foreground"> / {formatNumber(agg.nominal)}</span>}
                  </span>
                }
                hint={
                  agg.nominal === null
                    ? `${agg.teams} teams in ${agg.rooms} rooms · no capacity limit`
                    : `${agg.rooms} rooms · ${Math.max(0, agg.nominal - agg.occupancy)} slots left`
                }
                className="h-full hover:bg-muted/40"
              />
            </Link>
          );
        })}
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-6">
          <section className="rounded-xl border bg-card">
            <h2 className="flex items-center gap-2 border-b px-4 py-3 text-sm font-semibold">
              <CircleAlert className="size-4" aria-hidden /> Alerts
            </h2>
            {alerts.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">Nothing needs attention.</p>
            ) : (
              <ul className="divide-y">
                {alerts.map((a, i) => (
                  <li key={i}>
                    <Link href={a.href} className="flex items-start gap-2 px-4 py-2.5 text-sm hover:bg-muted/50">
                      {a.tone === "danger" ? (
                        <OctagonAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-label="Critical" />
                      ) : (
                        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-label="Warning" />
                      )}
                      {a.text}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {SESSION_IDS.map((id) => (
            <RoomSummary key={id} session={id} />
          ))}
        </div>
        <section className="rounded-xl border bg-card">
          <h2 className="border-b px-4 py-3 text-sm font-semibold">Recent activity</h2>
          <AuditList rows={activity} showTeam onTeamClick={(id) => openTeam(id)} />
        </section>
      </div>
    </div>
  );
}

function RoomSummary({ session }: { session: SessionId }) {
  const { board } = useBoard();
  const rooms = board.rooms.filter((r) => r.sessionId === session);
  return (
    <section className="rounded-xl border bg-card">
      <h2 className="flex items-center justify-between border-b px-4 py-3 text-sm font-semibold">
        {SESSION_LABELS[session]} rooms
        <Link href={`/rooms/${session}`} className="text-xs font-medium text-primary hover:underline">
          Manage
        </Link>
      </h2>
      <ul className="divide-y">
        {rooms.map((r) => {
          const level = roomLevel(r);
          return (
            <li key={r.id} className="grid grid-cols-[5rem_minmax(0,1fr)_auto] items-center gap-3 px-4 py-2 text-sm">
              <span className="font-semibold">Room {r.roomNumber}</span>
              {isLimited(r) && <OccupancyBar room={r} />}
              {isLimited(r) ? (
                <span className="tabular flex items-center gap-2">
                  {r.occupancy}/{r.nominalCapacity}
                  <span className="text-xs text-muted-foreground">{nominalRemaining(r)} left</span>
                  {level !== "open" && <Pill t={LEVEL_TONE[level]}>{ROOM_LEVEL_LABELS[level]}</Pill>}
                </span>
              ) : (
                <span className="tabular col-span-2 text-right">
                  {r.teams.length} teams · {r.occupancy} participants
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
