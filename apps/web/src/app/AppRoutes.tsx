import { LoaderCircle } from 'lucide-react';
import { Route, Routes } from 'react-router';
import { HomeRedirect } from '../routes/HomeRedirect';
import { MembersPage } from '../routes/MembersPage';
import { NotFoundPage } from '../routes/NotFoundPage';
import { OverviewPage } from '../routes/OverviewPage';
import { ProjectsPage } from '../routes/ProjectsPage';
import { WorkspaceLayout } from '../routes/WorkspaceLayout';
import { useSession } from './session';
import { AppShell } from './shell/AppShell';
import { createAsyncRoute } from './AsyncRoute';

const ProjectPage = createAsyncRoute(() => import('../routes/ProjectPage').then(module => ({ default: module.ProjectPage })), 'Загрузка проекта');
const WeeklyPage = createAsyncRoute(() => import('../routes/WeeklyPage').then(module => ({ default: module.WeeklyPage })), 'Загрузка недели');
const IntegrationsPage = createAsyncRoute(() => import('../routes/IntegrationsPage').then(module => ({ default: module.IntegrationsPage })), 'Загрузка интеграций');

export function AppRoutes() {
  const { switching } = useSession();
  if (switching) return <SwitchingScreen />;

  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomeRedirect />} />
        <Route path="w/:workspaceId" element={<WorkspaceLayout />}>
          <Route index element={<OverviewPage />} />
          <Route path="members" element={<MembersPage />} />
          <Route path="integrations" element={<IntegrationsPage />} />
          <Route path="projects" element={<ProjectsPage />} />
          <Route path="projects/:projectId" element={<ProjectPage />} />
          <Route path="projects/:projectId/week" element={<WeeklyPage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

function SwitchingScreen() {
  return (
    <div role="status" className="grid min-h-dvh place-items-center px-4">
      <p className="flex items-center gap-2.5 text-sm text-muted">
        <LoaderCircle size={18} aria-hidden="true" className="text-accent motion-safe:animate-spin" />
        Переключаем тестового пользователя…
      </p>
    </div>
  );
}
