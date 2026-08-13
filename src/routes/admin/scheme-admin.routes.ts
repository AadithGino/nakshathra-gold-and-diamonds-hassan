import { Router } from "express";
import { asyncHandler } from "../../utils/asyncHandler.js";
import { requireGoldWeightEnabled } from "../../middlewares/auth.middleware.js";
import { validateBody } from "../../middlewares/validate.middleware.js";
import {
  cancelEnrollmentSchema,
  createEnrollmentSchema,
  createGoldRateSchema,
  createSchemePlanSchema,
  prematureCloseSchema,
  updateEnrollmentStatusSchema,
  updateGoldRateSchema,
  updateSchemePlanSchema,
} from "../../validators/scheme.validators.js";
import {
  cancelEnrollmentHandler,
  createEnrollmentHandler,
  createGoldRateHandler,
  createSchemePlanHandler,
  getEnrollmentHandler,
  getGoldRateHandler,
  getSchemePlanHandler,
  listDueEnrollmentsHandler,
  listEnrollmentsHandler,
  listGoldRatesHandler,
  listOverdueEnrollmentsHandler,
  listRedemptionReadyHandler,
  listSchemePlansHandler,
  prematureCloseHandler,
  prematureClosurePreviewHandler,
  redemptionPreviewHandler,
  updateGoldRateHandler,
  updateEnrollmentStatusHandler,
  updateSchemePlanHandler,
} from "../../controllers/admin/scheme-admin.controller.js";

export const schemeAdminRouter = Router();

schemeAdminRouter.post(
  "/scheme-plans",
  validateBody(createSchemePlanSchema),
  asyncHandler(createSchemePlanHandler),
);
schemeAdminRouter.get("/scheme-plans", asyncHandler(listSchemePlansHandler));
schemeAdminRouter.get("/scheme-plans/:id", asyncHandler(getSchemePlanHandler));
schemeAdminRouter.patch(
  "/scheme-plans/:id",
  validateBody(updateSchemePlanSchema),
  asyncHandler(updateSchemePlanHandler),
);
schemeAdminRouter.post(
  "/enrollments",
  validateBody(createEnrollmentSchema),
  asyncHandler(createEnrollmentHandler),
);
schemeAdminRouter.get("/enrollments", asyncHandler(listEnrollmentsHandler));
schemeAdminRouter.get("/enrollments/overdue", asyncHandler(listOverdueEnrollmentsHandler));
schemeAdminRouter.get("/enrollments/due", asyncHandler(listDueEnrollmentsHandler));
schemeAdminRouter.get(
  "/enrollments/redemption-ready",
  asyncHandler(listRedemptionReadyHandler),
);
schemeAdminRouter.get(
  "/enrollments/:id/premature-closure-preview",
  asyncHandler(prematureClosurePreviewHandler),
);
schemeAdminRouter.get(
  "/enrollments/:id/redemption-preview",
  asyncHandler(redemptionPreviewHandler),
);
schemeAdminRouter.post(
  "/enrollments/:id/premature-close",
  validateBody(prematureCloseSchema),
  asyncHandler(prematureCloseHandler),
);
schemeAdminRouter.post(
  "/enrollments/:id/cancel",
  validateBody(cancelEnrollmentSchema),
  asyncHandler(cancelEnrollmentHandler),
);
schemeAdminRouter.get("/enrollments/:id", asyncHandler(getEnrollmentHandler));
schemeAdminRouter.patch(
  "/enrollments/:id/status",
  validateBody(updateEnrollmentStatusSchema),
  asyncHandler(updateEnrollmentStatusHandler),
);
schemeAdminRouter.post(
  "/gold-rates",
  requireGoldWeightEnabled,
  validateBody(createGoldRateSchema),
  asyncHandler(createGoldRateHandler),
);
schemeAdminRouter.get("/gold-rates", requireGoldWeightEnabled, asyncHandler(listGoldRatesHandler));
schemeAdminRouter.get("/gold-rates/:id", requireGoldWeightEnabled, asyncHandler(getGoldRateHandler));
schemeAdminRouter.patch(
  "/gold-rates/:id",
  requireGoldWeightEnabled,
  validateBody(updateGoldRateSchema),
  asyncHandler(updateGoldRateHandler),
);
