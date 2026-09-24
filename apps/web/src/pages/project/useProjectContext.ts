import { useOutletContext } from "react-router-dom";
import type { Project } from "../../types/project";

/** Consumed by the three tab pages so they don't each re-fetch the project. */
export function useProjectContext(): Project {
  return useOutletContext<Project>();
}
