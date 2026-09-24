import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { connectDB, disconnectDB, getDbState } from "../database.js";
import { createApp } from "../../app.js";
import { User } from "../../models/User.js";

// Real integration test against the MongoDB instance from `npm run db:up`.
// Skips (rather than fails) when no database is reachable, so `npm test`
// still passes for anyone who hasn't started Docker — this suite is the
// thing that actually proves connectivity, not a substitute for it.
let dbAvailable = false;
try {
  await connectDB();
  dbAvailable = true;
} catch {
  dbAvailable = false;
}

describe.skipIf(!dbAvailable)("MongoDB integration", () => {
  const app = createApp();
  const testEmail = `phase2-integration-test-${Date.now()}@example.com`;

  afterAll(async () => {
    await User.deleteOne({ email: testEmail });
    await disconnectDB();
  });

  it("connectDB() establishes a real connection", () => {
    expect(getDbState().label).toBe("connected");
  });

  it("GET /api/health/db reports ok while connected", async () => {
    const res = await request(app).get("/api/health/db");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", db: "connected" });
  });

  it("persists a User document and enforces the unique email index", async () => {
    const created = await User.create({
      email: testEmail,
      passwordHash: "hashed-value",
      displayName: "Integration Test User",
    });
    expect(created._id).toBeDefined();

    await expect(
      User.create({
        email: testEmail,
        passwordHash: "another-hash",
        displayName: "Duplicate",
      }),
    ).rejects.toThrow(/duplicate key/i);
  });

  it("GET /api/health/db reports unavailable once disconnected", async () => {
    await mongoose.disconnect();

    const res = await request(app).get("/api/health/db");

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("error");
    expect(res.body.db).not.toBe("connected");

    // Reconnect so afterAll's cleanup (deleteOne + disconnectDB) can run.
    await connectDB();
  });
});

describe.skipIf(dbAvailable)("MongoDB integration (skipped)", () => {
  it("no database reachable at MONGODB_URI — run `npm run db:up` to enable this suite", () => {
    expect(dbAvailable).toBe(false);
  });
});
