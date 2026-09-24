import { User, type UserDocument } from "../models/User.js";
import { getDummyHashForTimingSafety, hashPassword, verifyPassword } from "../utils/password.js";
import { signAccessToken } from "../utils/jwt.js";
import { AppError } from "../utils/AppError.js";
import type { LoginInput, RegisterInput } from "../validators/auth.validators.js";

export interface AuthResult {
  user: UserDocument;
  token: string;
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;
}

export async function registerUser(input: RegisterInput): Promise<AuthResult> {
  const passwordHash = await hashPassword(input.password);

  let user: UserDocument;
  try {
    // The DB's unique index on email (not this check) is what's actually
    // authoritative — a pre-check-then-insert here would leave a race
    // window between two concurrent registrations with the same email.
    // Instead, attempt the insert directly and translate the resulting
    // duplicate-key error.
    user = await User.create({
      email: input.email,
      passwordHash,
      displayName: input.displayName,
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      throw new AppError("An account with this email already exists", 409);
    }
    throw err;
  }

  const token = signAccessToken({ sub: user._id.toString(), role: user.role });
  return { user, token };
}

export async function loginUser(input: LoginInput): Promise<AuthResult> {
  const user = await User.findOne({ email: input.email }).select("+passwordHash");

  // Always run a bcrypt compare — even when no user was found — against a
  // fixed dummy hash, so a nonexistent-account response takes the same time
  // as a wrong-password response. Otherwise the nonexistent-account path
  // would skip bcrypt entirely and return measurably faster, letting an
  // attacker infer which emails are registered purely from response timing
  // even though the response body itself is identical either way.
  const hashToCompare = user?.passwordHash ?? (await getDummyHashForTimingSafety());
  const passwordMatches = await verifyPassword(input.password, hashToCompare);

  if (!user || !passwordMatches) {
    throw new AppError("Invalid email or password", 401);
  }

  const token = signAccessToken({ sub: user._id.toString(), role: user.role });
  return { user, token };
}

export async function getUserById(id: string): Promise<UserDocument> {
  const user = await User.findById(id);
  if (!user) {
    // The token verified successfully but the user it points to is gone
    // (e.g. deleted after the token was issued) — treat as an invalid
    // session rather than a generic not-found.
    throw new AppError("Invalid or expired session", 401);
  }
  return user;
}
