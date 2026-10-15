import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { AppRoutes } from './AppRoutes';
import { ProtectedNavigationGuard } from './ProtectedNavigationGuard';
import { SessionProvider } from './session';

function Root() {
  return (
    <SessionProvider>
      <ProtectedNavigationGuard />
      <AppRoutes />
    </SessionProvider>
  );
}

// A data router only so that departures can be blocked; the routes themselves stay in AppRoutes.
// Created once, outside render, as React Router expects.
const router = createBrowserRouter([{ path: '*', element: <Root /> }]);

export function App({ queryClient }: { queryClient: QueryClient }) {
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
