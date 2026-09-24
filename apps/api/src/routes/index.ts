import { Router } from "express";
import { healthRouter } from "./health.routes.js";
import { authRouter } from "./auth.routes.js";
import { projectRouter } from "./project.routes.js";
import { requirementByIdRouter, requirementCollectionRouter } from "./requirement.routes.js";
import { taskByIdRouter, taskCollectionRouter } from "./task.routes.js";
import { planByIdRouter, planCollectionRouter } from "./plan.routes.js";
import { aiRouter } from "./ai.routes.js";
import { sourceRouter, scanRouter, scanByIdRouter } from "./scan.routes.js";

export const apiRouter = Router();

apiRouter.use(healthRouter);
apiRouter.use("/auth", authRouter);
apiRouter.use("/projects", projectRouter);
// Nested collection routes — mounted with the :projectId param in the path
// itself (Express supports params in a mount path), each scoped explicitly
// so no unrelated request ever enters these routers. See project.routes.ts
// / auth.routes.ts comments (Phase 3) for why unscoped mounting is unsafe.
apiRouter.use("/projects/:projectId/requirements", requirementCollectionRouter);
apiRouter.use("/projects/:projectId/tasks", taskCollectionRouter);
apiRouter.use("/projects/:projectId/plans", planCollectionRouter);
apiRouter.use("/projects/:projectId/source", sourceRouter);
apiRouter.use("/projects/:projectId/scans", scanRouter);
apiRouter.use("/requirements", requirementByIdRouter);
apiRouter.use("/tasks", taskByIdRouter);
apiRouter.use("/plans", planByIdRouter);
apiRouter.use("/scans", scanByIdRouter);
apiRouter.use("/ai", aiRouter);
