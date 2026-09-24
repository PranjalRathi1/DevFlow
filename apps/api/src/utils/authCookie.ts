import type { CookieOptions, Response } from "express";
import { env } from "../config/env.js";

export const AUTH_COOKIE_NAME = "devflow_token";

function parseTtlToMs(ttl: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(ttl);
  if (!match) return 60 * 60 * 1000; // fallback: 1h
  const [, amount, unit] = match;
  const n = Number(amount);
  const unitMs = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
    unit as "ms" | "s" | "m" | "h" | "d"
  ];
  return n * unitMs;
}

function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: parseTtlToMs(env.JWT_ACCESS_TTL),
  };
}

export function setAuthCookie(res: Response, token: string): void {
  res.cookie(AUTH_COOKIE_NAME, token, cookieOptions());
}

export function clearAuthCookie(res: Response): void {
  const { maxAge: _maxAge, ...rest } = cookieOptions();
  res.clearCookie(AUTH_COOKIE_NAME, rest);
}
