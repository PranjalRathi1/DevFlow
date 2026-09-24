export interface AuthUser {
  _id: string;
  email: string;
  displayName: string;
  role: "member" | "admin";
  createdAt: string;
  updatedAt: string;
}

export interface RegisterPayload {
  email: string;
  password: string;
  displayName: string;
}

export interface LoginPayload {
  email: string;
  password: string;
}
