import { AuthCardLayout } from "../components/auth/AuthCardLayout";
import { RegisterForm } from "../components/auth/RegisterForm";

export default function RegisterPage() {
  return (
    <AuthCardLayout title="Create your account">
      <RegisterForm />
    </AuthCardLayout>
  );
}
