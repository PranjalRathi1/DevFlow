import { Navigate, Route, Routes } from "react-router-dom";
import { ProtectedRoute } from "./routes/ProtectedRoute";
import { PublicOnlyRoute } from "./routes/PublicOnlyRoute";
import { AppLayout } from "./components/layout/AppLayout";
import LoginPage from "./pages/LoginPage";
import RegisterPage from "./pages/RegisterPage";
import DashboardPage from "./pages/DashboardPage";
import ProjectsPage from "./pages/ProjectsPage";
import NewProjectPage from "./pages/NewProjectPage";
import { ProjectDetailLayout } from "./pages/project/ProjectDetailLayout";
import ProjectOverviewTab from "./pages/project/ProjectOverviewTab";
import ProjectRequirementsTab from "./pages/project/ProjectRequirementsTab";
import ProjectTasksTab from "./pages/project/ProjectTasksTab";
import ProjectPlansTab from "./pages/project/ProjectPlansTab";
import ProjectScanTab from "./pages/project/ProjectScanTab";
import ProjectGraphTab from "./pages/project/ProjectGraphTab";
import NotFoundPage from "./pages/NotFoundPage";

export default function App() {
  return (
    <Routes>
      <Route element={<PublicOnlyRoute />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
      </Route>

      <Route element={<ProtectedRoute />}>
        <Route path="/app" element={<AppLayout />}>
          <Route index element={<Navigate to="dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="projects/new" element={<NewProjectPage />} />
          <Route path="projects/:projectId" element={<ProjectDetailLayout />}>
            <Route index element={<Navigate to="overview" replace />} />
            <Route path="overview" element={<ProjectOverviewTab />} />
            <Route path="requirements" element={<ProjectRequirementsTab />} />
            <Route path="tasks" element={<ProjectTasksTab />} />
            <Route path="plans" element={<ProjectPlansTab />} />
            <Route path="scan" element={<ProjectScanTab />} />
            <Route path="graph" element={<ProjectGraphTab />} />
          </Route>
        </Route>
      </Route>

      <Route path="/" element={<Navigate to="/app/dashboard" replace />} />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
