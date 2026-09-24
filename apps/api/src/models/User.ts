import { Schema, model, type HydratedDocument, type InferSchemaType } from "mongoose";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Minimal initial role model — enough to gate future admin-only endpoints
// without inventing a permissions system before auth (Phase 3) exists.
export const USER_ROLES = ["member", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      match: [EMAIL_PATTERN, "Invalid email address"],
    },
    // Never store or log a plaintext password — hashed with bcryptjs before
    // save (see utils/password.ts and auth.service.ts). `select: false`
    // keeps it out of query results by default; the toJSON transform below
    // is a second, independent guard against it leaking through
    // `res.json(userDoc)` even if a query explicitly re-selects it.
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },
    displayName: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 100,
    },
    role: {
      type: String,
      enum: USER_ROLES,
      default: "member",
    },
  },
  { timestamps: true },
);

// Defense in depth: strip passwordHash and __v from any JSON serialization
// of a User document, regardless of how it was queried.
userSchema.set("toJSON", {
  transform: (_doc, ret: Record<string, unknown>) => {
    delete ret.passwordHash;
    delete ret.__v;
    return ret;
  },
});

export type UserSchemaType = InferSchemaType<typeof userSchema>;
export type UserDocument = HydratedDocument<UserSchemaType>;

export const User = model("User", userSchema);
