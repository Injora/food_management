import { eq } from "drizzle-orm";
import { expect, it } from "vitest";

import { sessions } from "@/db/schema";
import { hashPassword } from "@/server/auth/password";
import { authenticate, createSession, validateSessionToken } from "@/server/auth/session";
import { loadBoard } from "@/server/services/board";
import { checkIn } from "@/server/services/checkin";
import { issueCoupons, revertCoupon } from "@/server/services/coupons";
import { allocateTeam, createRoom, moveTeam, updateRoom } from "@/server/services/rooms";
import { archiveTeam, createTeam, withdrawParticipant } from "@/server/services/teams";
import { createUser, updateUser } from "@/server/services/users";
import { describeDb, expectAppError, makeActor, useTestDb } from "../helpers";

describeDb("Authentication and authorization (PostgreSQL)", () => {
  const t = useTestDb();
  const id = crypto.randomUUID();

  it("rejects anonymous calls to every operational service", async () => {
    await expectAppError(loadBoard(t.db, null), "UNAUTHORIZED");
    await expectAppError(checkIn(t.db, null, { teamId: id, wholeTeam: true }), "UNAUTHORIZED");
    await expectAppError(issueCoupons(t.db, null, { teamId: id, couponType: "lunch", allPending: true, requestId: id }), "UNAUTHORIZED");
    await expectAppError(allocateTeam(t.db, null, { sessionId: "talks", teamId: id, roomId: id, participantIds: [id] }), "UNAUTHORIZED");
    await expectAppError(moveTeam(t.db, null, { sessionId: "talks", teamId: id, toRoomId: id }), "UNAUTHORIZED");
  });

  it("keeps admin-only operations away from volunteers", async () => {
    const v = await makeActor(t.db, "organizer");
    await expectAppError(revertCoupon(t.db, v, { issuanceId: id, reason: "because" }), "FORBIDDEN");
    await expectAppError(updateRoom(t.db, v, { roomId: id, nominalCapacity: 10, overflowTolerance: 3 }), "FORBIDDEN");
    await expectAppError(createRoom(t.db, v, { sessionId: "talks", roomNumber: "T1", nominalCapacity: 10, overflowTolerance: 3 }), "FORBIDDEN");
    await expectAppError(createTeam(t.db, v, { teamName: "X", members: [{ name: "A" }] }), "FORBIDDEN");
    await expectAppError(archiveTeam(t.db, v, { teamId: id, reason: "because" }), "FORBIDDEN");
    await expectAppError(withdrawParticipant(t.db, v, { participantId: id, reason: "because" }), "FORBIDDEN");
    await expectAppError(createUser(t.db, v, { email: "x@y.z", name: "X", role: "admin", password: "long-enough-pw" }), "FORBIDDEN");
  });

  it("authenticates, validates and revokes sessions", async () => {
    const admin = await makeActor(t.db);
    const { id: userId } = await createUser(t.db, admin, { email: "Asha@Example.com", name: "Asha", role: "organizer", password: "a-strong-password" });
    expect(await authenticate(t.db, "asha@example.com", "wrong-password")).toBeNull();
    expect(await authenticate(t.db, "nobody@example.com", "a-strong-password")).toBeNull();
    expect(await authenticate(t.db, " ASHA@example.com ", "a-strong-password")).toMatchObject({ id: userId, role: "organizer" });

    const { token } = await createSession(t.db, userId);
    expect(await validateSessionToken(t.db, token)).toMatchObject({ id: userId });
    expect(await validateSessionToken(t.db, "forged-token")).toBeNull();

    await updateUser(t.db, admin, { userId, active: false });
    expect(await validateSessionToken(t.db, token)).toBeNull();
    expect(await t.db.select().from(sessions).where(eq(sessions.userId, userId))).toHaveLength(0);
    expect(await authenticate(t.db, "asha@example.com", "a-strong-password")).toBeNull();
  });

  it("expires sessions and keeps at least one active admin", async () => {
    const admin = await makeActor(t.db, "admin", await hashPassword("whatever-password"));
    const { token } = await createSession(t.db, admin.id);
    await t.db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) });
    expect(await validateSessionToken(t.db, token)).toBeNull();
    await expectAppError(updateUser(t.db, admin, { userId: admin.id, role: "organizer" }), "CONFLICT");
  });
});
