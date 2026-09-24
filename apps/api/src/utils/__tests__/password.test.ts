import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../password.js";

// Real bcrypt calls, no mocks — this is exactly the flow the phase asked
// to have actually tested, not just wired up.
describe("password hashing", () => {
  it("hashes a password to something other than the plaintext", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(hash).not.toBe("correct horse battery staple");
    expect(hash.length).toBeGreaterThan(20);
  });

  it("verifies a correct password against its hash", async () => {
    const hash = await hashPassword("correct horse battery staple");
    await expect(verifyPassword("correct horse battery staple", hash)).resolves.toBe(true);
  });

  it("rejects an incorrect password against a real hash", async () => {
    const hash = await hashPassword("correct horse battery staple");
    await expect(verifyPassword("wrong password", hash)).resolves.toBe(false);
  });

  it("produces a different hash for the same password on each call (random salt)", async () => {
    const [hashA, hashB] = await Promise.all([hashPassword("same-password"), hashPassword("same-password")]);
    expect(hashA).not.toBe(hashB);
  });
});
