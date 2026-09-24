import { describe, expect, it } from "vitest";
import jsonwebtoken from "jsonwebtoken";
import { InvalidTokenError, signAccessToken, verifyAccessToken } from "../jwt.js";
import { env } from "../../config/env.js";

describe("access tokens", () => {
  it("round-trips a valid token", () => {
    const token = signAccessToken({ sub: "user-123", role: "member" });
    const payload = verifyAccessToken(token);
    expect(payload).toEqual({ sub: "user-123", role: "member" });
  });

  it("rejects a malformed token", () => {
    expect(() => verifyAccessToken("not-a-real-token")).toThrow(InvalidTokenError);
  });

  it("rejects a token signed with the wrong secret", () => {
    const forged = jsonwebtoken.sign({ sub: "user-123", role: "admin" }, "a-completely-different-secret");
    expect(() => verifyAccessToken(forged)).toThrow(InvalidTokenError);
  });

  it("rejects an expired token", () => {
    const expired = jsonwebtoken.sign(
      { sub: "user-123", role: "member", exp: Math.floor(Date.now() / 1000) - 60 },
      env.JWT_ACCESS_SECRET,
    );
    expect(() => verifyAccessToken(expired)).toThrow(InvalidTokenError);
  });

  it("never exposes the underlying jsonwebtoken error type to callers", () => {
    try {
      verifyAccessToken("garbage");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTokenError);
      expect(err).not.toBeInstanceOf(jsonwebtoken.JsonWebTokenError);
    }
  });
});
