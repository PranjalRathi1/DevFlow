import { randomUUID } from "node:crypto";
import type { Express } from "express";
import request from "supertest";

export interface RegisteredTestUser {
  email: string;
  password: string;
  displayName: string;
  cookie: string;
  userId: string;
}

// A per-process counter + Date.now() collided across the separate worker
// processes Vitest runs different test *files* in (each starts its own
// counter at 0) — two files registering their "first" user in the same
// millisecond could generate the identical email, and the second
// registration would fail with 409, surfacing as a confusing
// "registerTestUser failed" error unrelated to whatever the test was
// actually checking. A UUID has no shared counter to collide on.
function uniqueEmail(): string {
  return `phase3-test-${randomUUID()}@example.com`;
}

export function extractCookie(res: request.Response): string {
  const setCookie: unknown = res.headers["set-cookie"];
  if (!Array.isArray(setCookie) || setCookie.length === 0) {
    throw new Error("Expected a Set-Cookie header in the response but found none");
  }
  return (setCookie[0] as string).split(";")[0] as string;
}

export async function registerTestUser(
  app: Express,
  overrides: Partial<{ email: string; password: string; displayName: string }> = {},
): Promise<RegisteredTestUser> {
  const email = overrides.email ?? uniqueEmail();
  const password = overrides.password ?? "correct horse battery staple";
  const displayName = overrides.displayName ?? "Test User";

  const res = await request(app).post("/api/auth/register").send({ email, password, displayName });
  if (res.status !== 201) {
    throw new Error(`registerTestUser failed: ${res.status} ${JSON.stringify(res.body)}`);
  }

  return {
    email,
    password,
    displayName,
    cookie: extractCookie(res),
    userId: res.body.user._id as string,
  };
}

export async function createTestProject(
  app: Express,
  cookie: string,
  overrides: Partial<{ name: string; description: string }> = {},
): Promise<string> {
  const res = await request(app)
    .post("/api/projects")
    .set("Cookie", cookie)
    .send({ name: overrides.name ?? "Test Project", description: overrides.description ?? "" });
  if (res.status !== 201) {
    throw new Error(`createTestProject failed: ${res.status} ${JSON.stringify(res.body)}`);
  }
  return res.body.project._id as string;
}
