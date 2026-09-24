import { AuthCardLayout } from "../components/auth/AuthCardLayout";
import { LoginForm } from "../components/auth/LoginForm";

export default function LoginPage() {
  return (
    <AuthCardLayout title="Log in to your account">
      <LoginForm />
    </AuthCardLayout>
  );
}
