import type { Request, Response } from "express";
import { getUserById, loginUser, registerUser } from "../services/auth.service.js";
import { clearAuthCookie, setAuthCookie } from "../utils/authCookie.js";
import { AppError } from "../utils/AppError.js";

// Note: the raw token is never included in any JSON response body — only
// set via Set-Cookie (httpOnly). Putting it in the body too would defeat
// the point of an httpOnly cookie, since any script could then read it
// straight out of the fetch response. See docs/DECISIONS.md ADR-007.

export async function register(req: Request, res: Response): Promise<void> {
  const { user, token } = await registerUser(req.body);
  setAuthCookie(res, token);
  res.status(201).json({ user });
}

export async function login(req: Request, res: Response): Promise<void> {
  const { user, token } = await loginUser(req.body);
  setAuthCookie(res, token);
  res.status(200).json({ user });
}

export async function logout(_req: Request, res: Response): Promise<void> {
  clearAuthCookie(res);
  res.status(200).json({ message: "Logged out" });
}

export async function me(req: Request, res: Response): Promise<void> {
  if (!req.user) {
    throw new AppError("Authentication required", 401);
  }
  const user = await getUserById(req.user.id);
  res.status(200).json({ user });
}
