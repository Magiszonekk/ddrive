import { Routes, Route, Navigate } from "react-router";
import { useAuthStore } from "./stores/auth.js";
import { Login } from "./pages/Login.js";
import { Register } from "./pages/Register.js";
import { ForgotPassword } from "./pages/ForgotPassword.js";
import { ResetPassword } from "./pages/ResetPassword.js";
import { CheckEmail } from "./pages/CheckEmail.js";
import { VerifyEmail } from "./pages/VerifyEmail.js";
import { ConfirmDeleteAccount } from "./pages/ConfirmDeleteAccount.js";
import { Dashboard } from "./pages/Dashboard.js";
import { SharedFile } from "./pages/SharedFile.js";
import { AnonymousUpload } from "./pages/AnonymousUpload.js";
import { Drop } from "./pages/Drop.js";
import { AnonymousDrive } from "./pages/AnonymousDrive.js";
import { Settings } from "./pages/Settings.js";
import { HealthCheck } from "./pages/HealthCheck.js";
import { MainLayout } from "./components/layout/MainLayout.js";
import { NotificationToasts } from "./components/layout/NotificationToasts.js";

function isTokenExpired(token: string): boolean {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]!));
    return typeof payload.exp === "number" && payload.exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const token = useAuthStore((s) => s.token);
  const logout = useAuthStore((s) => s.logout);

  if (!token || isTokenExpired(token)) {
    if (token) logout();
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

export function App() {
  return (
    <>
      <NotificationToasts />
      <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/register" element={<Register />} />
      <Route path="/check-email" element={<CheckEmail />} />
      <Route path="/verify-email" element={<VerifyEmail />} />
      <Route path="/confirm-delete-account" element={<ConfirmDeleteAccount />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/share/:shareId" element={<SharedFile />} />
      <Route path="/drop" element={<Drop />} />
      <Route path="/upload" element={<Navigate to="/drop" replace />} />
      <Route path="/drive" element={<Navigate to="/drop" replace />} />
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <MainLayout>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                <Route path="/folder/:folderId" element={<Dashboard />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/health" element={<HealthCheck />} />
              </Routes>
            </MainLayout>
          </ProtectedRoute>
        }
      />
    </Routes>
    </>
  );
}
