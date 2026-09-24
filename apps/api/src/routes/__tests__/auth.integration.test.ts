import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import jsonwebtoken from "jsonwebtoken";
import { connectDB, disconnectDB } from "../../config/database.js";
import { env } from "../../config/env.js";
import { createApp } from "../../app.js";
import { User } from "../../models/User.js";
import { verifyPassword } from "../../utils/password.js";
import { extractCookie, registerTestUser } from "../../__tests__/testHelpers.js";

let dbAvailable = false;
try {
  await connectDB();
  dbAvailable = true;
} catch {
  dbAvailable = false;
}

describe.skipIf(!dbAvailable)("Auth: register / login / me / logout (real MongoDB)", () => {
  const app = createApp();
  const createdEmails: string[] = [];

  afterAll(async () => {
    if (createdEmails.length > 0) {
      await User.deleteMany({ email: { $in: createdEmails } });
    }
    await disconnectDB();
  });

  describe("POST /api/auth/register", () => {
    it("creates a user, hashes the password, and never returns it", async () => {
      const email = `phase3-register-${Date.now()}@example.com`;
      createdEmails.push(email);

      const res = await request(app)
        .post("/api/auth/register")
        .send({ email, password: "a-real-password-123", displayName: "New User" });

      expect(res.status).toBe(201);
      expect(res.body.user.email).toBe(email);
      expect(res.body.user.displayName).toBe("New User");
      expect(res.body.user.role).toBe("member");
      expect(res.body.user).not.toHaveProperty("passwordHash");
      expect(res.body.user).not.toHaveProperty("password");
      expect(JSON.stringify(res.body)).not.toContain("a-real-password-123");

      // The raw token must never appear in the JSON body — only via
      // Set-Cookie (httpOnly). See docs/DECISIONS.md ADR-007.
      expect(res.body).not.toHaveProperty("token");
      expect(res.headers["set-cookie"]).toBeDefined();
      const cookieHeader = extractCookie(res);
      expect(cookieHeader.startsWith("devflow_token=")).toBe(true);

      const stored = await User.findOne({ email }).select("+passwordHash");
      expect(stored?.passwordHash).toBeDefined();
      expect(stored?.passwordHash).not.toBe("a-real-password-123");
      await expect(verifyPassword("a-real-password-123", stored!.passwordHash)).resolves.toBe(true);
    });

    it("rejects a duplicate email with 409, database unique index as authority", async () => {
      const email = `phase3-dup-${Date.now()}@example.com`;
      createdEmails.push(email);

      const first = await request(app)
        .post("/api/auth/register")
        .send({ email, password: "password-one-123", displayName: "First" });
      expect(first.status).toBe(201);

      const second = await request(app)
        .post("/api/auth/register")
        .send({ email, password: "password-two-123", displayName: "Second" });

      expect(second.status).toBe(409);
      expect(second.body.error.message).toMatch(/already exists/i);

      const count = await User.countDocuments({ email });
      expect(count).toBe(1);
    });

    it("rejects invalid input with 400 (bad email, short password, missing display name)", async () => {
      const badEmail = await request(app)
        .post("/api/auth/register")
        .send({ email: "not-an-email", password: "password-123", displayName: "X" });
      expect(badEmail.status).toBe(400);
      expect(badEmail.body.error.code).toBe("VALIDATION_ERROR");

      const shortPassword = await request(app)
        .post("/api/auth/register")
        .send({ email: "valid@example.com", password: "short", displayName: "X" });
      expect(shortPassword.status).toBe(400);

      const missingName = await request(app)
        .post("/api/auth/register")
        .send({ email: "valid2@example.com", password: "password-123" });
      expect(missingName.status).toBe(400);
    });
  });

  describe("POST /api/auth/login", () => {
    it("logs in with correct credentials and sets a fresh cookie", async () => {
      const user = await registerTestUser(app);
      createdEmails.push(user.email);

      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: user.email, password: user.password });

      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe(user.email);
      expect(res.body.user).not.toHaveProperty("passwordHash");
      expect(res.headers["set-cookie"]).toBeDefined();
    });

    it("rejects a wrong password with a generic 401", async () => {
      const user = await registerTestUser(app);
      createdEmails.push(user.email);

      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: user.email, password: "wrong-password" });

      expect(res.status).toBe(401);
      expect(res.body.error.message).toBe("Invalid email or password");
    });

    it("rejects a nonexistent email with the SAME generic 401 message (no account enumeration)", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: "definitely-not-registered@example.com", password: "whatever-password" });

      expect(res.status).toBe(401);
      expect(res.body.error.message).toBe("Invalid email or password");
    });
  });

  describe("GET /api/auth/me", () => {
    it("returns 401 with no token", async () => {
      const res = await request(app).get("/api/auth/me");
      expect(res.status).toBe(401);
    });

    it("returns 401 with a malformed token", async () => {
      const res = await request(app).get("/api/auth/me").set("Cookie", "devflow_token=not-a-real-token");
      expect(res.status).toBe(401);
    });

    it("returns 401 with an expired token", async () => {
      const expired = jsonwebtoken.sign(
        { sub: "000000000000000000000000", role: "member", exp: Math.floor(Date.now() / 1000) - 60 },
        env.JWT_ACCESS_SECRET,
      );
      const res = await request(app).get("/api/auth/me").set("Cookie", `devflow_token=${expired}`);
      expect(res.status).toBe(401);
    });

    it("returns the authenticated user for a valid session", async () => {
      const user = await registerTestUser(app);
      createdEmails.push(user.email);

      const res = await request(app).get("/api/auth/me").set("Cookie", user.cookie);

      expect(res.status).toBe(200);
      expect(res.body.user.email).toBe(user.email);
      expect(res.body.user._id).toBe(user.userId);
      expect(res.body.user).not.toHaveProperty("passwordHash");
    });
  });

  describe("POST /api/auth/logout", () => {
    it("clears the auth cookie", async () => {
      const user = await registerTestUser(app);
      createdEmails.push(user.email);

      const res = await request(app).post("/api/auth/logout").set("Cookie", user.cookie);

      expect(res.status).toBe(200);
      const setCookie = res.headers["set-cookie"];
      expect(setCookie).toBeDefined();
      expect((setCookie as unknown as string[])[0]).toMatch(/devflow_token=;/);
    });
  });
});

describe.skipIf(dbAvailable)("Auth integration (skipped)", () => {
  it("no database reachable at MONGODB_URI — run `npm run db:up` to enable this suite", () => {
    expect(dbAvailable).toBe(false);
  });
});
