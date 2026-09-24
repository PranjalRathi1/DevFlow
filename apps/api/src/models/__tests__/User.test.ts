import { describe, expect, it } from "vitest";
import { User } from "../User.js";

// These run against an in-memory document (validateSync), not a live
// database, so they cover schema-level rules only — not the `unique`
// index, which MongoDB enforces at write time (see database.integration.test.ts).
describe("User schema", () => {
  it("passes validation with valid fields", () => {
    const user = new User({
      email: "dev@example.com",
      passwordHash: "hashed-value",
      displayName: "Dev User",
    });

    expect(user.validateSync()).toBeUndefined();
  });

  it("requires email, passwordHash, and displayName", () => {
    const user = new User({});
    const error = user.validateSync();

    expect(error?.errors.email).toBeDefined();
    expect(error?.errors.passwordHash).toBeDefined();
    expect(error?.errors.displayName).toBeDefined();
  });

  it("rejects a malformed email", () => {
    const user = new User({
      email: "not-an-email",
      passwordHash: "hashed-value",
      displayName: "Dev User",
    });

    expect(user.validateSync()?.errors.email).toBeDefined();
  });

  it("lowercases and trims email", () => {
    const user = new User({
      email: "  Dev@Example.com  ",
      passwordHash: "hashed-value",
      displayName: "Dev User",
    });

    expect(user.email).toBe("dev@example.com");
  });

  it("defaults role to member", () => {
    const user = new User({
      email: "dev@example.com",
      passwordHash: "hashed-value",
      displayName: "Dev User",
    });

    expect(user.role).toBe("member");
  });

  it("rejects an unrecognized role", () => {
    const user = new User({
      email: "dev@example.com",
      passwordHash: "hashed-value",
      displayName: "Dev User",
      role: "superadmin",
    });

    expect(user.validateSync()?.errors.role).toBeDefined();
  });
});
