import { t, useTranslation } from '../i18n';
import { LoaderCircle } from 'lucide-react';
import { Route, Routes, useLocation } from 'react-router';
import { useLayoutEffect } from 'react';
import { JoinInvitationPage } from '../features/team/JoinInvitationPage';
import { invitationHandoff, isJoinInvitationPath } from '../features/team/invitationHandoff';
import { HomeRedirect } from '../routes/HomeRedirect';
import { MembersPage } from '../routes/MembersPage';
import { NotFoundPage } from '../routes/NotFoundPage';
import { OverviewPage } from '../routes/OverviewPage';
import { ProjectsPage } from '../routes/ProjectsPage';
import { WorkspaceLayout } from '../routes/WorkspaceLayout';
import { useSession } from './session';
import { AppShell } from './shell/AppShell';
import { createAsyncRoute } from './AsyncRoute';

const MyTasksPage = createAsyncRoute(() => import('../routes/MyTasksPage').then(module => ({ default: module.MyTasksPage })), 'myTasks.loading');
const ProjectPage = createAsyncRoute(() => import('../routes/ProjectPage').then(module => ({ default: module.ProjectPage })), 'shell.loadingProject');
const WeeklyPage = createAsyncRoute(() => import('../routes/WeeklyPage').then(module => ({ default: module.WeeklyPage })), 'shell.loadingWeek');
const IntegrationsPage = createAsyncRoute(() => import('../routes/IntegrationsPage').then(module => ({ default: module.IntegrationsPage })), 'shell.loadingIntegrations');

export function AppRoutes() {
  useTranslation();
  const { switching, signingOut } = useSession();
  const location = useLocation();
  useLayoutEffect(() => {
    if (switching || !isJoinInvitationPath(`/app${location.pathname}`)) invitationHandoff.clear();
    else invitationHandoff.capture(window.location, window.history);
  }, [location.pathname, location.hash, switching]);
  if (switching) return <SwitchingScreen signingOut={signingOut} />;

  return (
    <Routes>
      <Route path="join" element={<JoinInvitationPage />} />
      <Route element={<AppShell />}>
        <Route index element={<HomeRedirect />} />
        <Route path="w/:workspaceId" element={<WorkspaceLayout />}>
          <Route index element={<OverviewPage />} />
          <Route path="my-tasks" element={<MyTasksPage />} />
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

/** `signingOut` marks the cleanup after a confirmed shared logout rather than a dev actor switch. */
function SwitchingScreen({ signingOut }: { signingOut: boolean }) {
  useTranslation();
  return (
    <div role="status" className="grid min-h-dvh place-items-center px-4">
      <p className="flex items-center gap-2.5 text-sm text-muted">
        <LoaderCircle size={18} aria-hidden="true" className="text-accent motion-safe:animate-spin" />

        {signingOut ? t('auth.signingOut') : t('shell.switchingActor')}
      </p>
    </div>
  );
}
