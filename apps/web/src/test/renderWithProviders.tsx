import type { ReactElement } from "react";
import { render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

export function renderWithProviders(ui: ReactElement, { route = "/" }: { route?: string } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

/**
 * Renders a project-detail tab (which reads its project via
 * useOutletContext) inside the real nested route it's mounted at in
 * App.tsx, rather than mocking the context away — exercises the actual
 * routing/outlet wiring, not just the tab component in isolation.
 */
export function renderProjectTab(tabElement: ReactElement, projectId = "proj-1") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/projects/${projectId}/tab`]}>
        <Routes>
          <Route path="/projects/:projectId" element={<ProjectContextProvider />}>
            <Route path="tab" element={tabElement} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// A minimal stand-in for ProjectDetailLayout that supplies the same Outlet
// context shape, without pulling in the real layout's header/tabs UI.
import { Outlet, useParams } from "react-router-dom";
import { useProject } from "../queries/projectQueries";

function ProjectContextProvider() {
  const { projectId } = useParams<{ projectId: string }>();
  const { data: project } = useProject(projectId ?? "");
  if (!project) return null;
  return <Outlet context={project} />;
}
