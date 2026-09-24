import bcrypt from "bcryptjs";

// bcrypt silently truncates input over 72 bytes — Zod validation on the
// registration/login schemas enforces a 72-char max so this is never hit
// in practice, but the constant is named here so the two stay linked.
const SALT_ROUNDS = 12;

export async function hashPassword(plainTextPassword: string): Promise<string> {
  return bcrypt.hash(plainTextPassword, SALT_ROUNDS);
}

export async function verifyPassword(plainTextPassword: string, passwordHash: string): Promise<boolean> {
  return bcrypt.compare(plainTextPassword, passwordHash);
}

// A hash of a value nobody will ever type, used to keep login timing
// consistent whether or not the account exists (see auth.service.ts) — an
// unmatched email would otherwise skip bcrypt entirely and return faster
// than the "wrong password" path, letting an attacker time-probe for valid
// accounts even though the response body itself never reveals which case
// hit. Computed lazily and cached so it doesn't add cost to every process
// startup — only the first login attempt pays for it.
let dummyHashPromise: Promise<string> | undefined;
export function getDummyHashForTimingSafety(): Promise<string> {
  dummyHashPromise ??= hashPassword("dummy-password-for-timing-safety-only");
  return dummyHashPromise;
}
