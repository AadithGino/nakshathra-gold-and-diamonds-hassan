import { Router } from 'express';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { authenticate, authorize } from '../../middlewares/auth.middleware.js';
import { getDashboard } from '../../controllers/admin/dashboard.controller.js';
import { customerAdminRouter } from './customer-admin.routes.js';
import { financeAdminRouter } from './finance-admin.routes.js';
import { schemeAdminRouter } from './scheme-admin.routes.js';
import { reportAdminRouter } from './report-admin.routes.js';
import { settingsAdminRouter } from './settings-admin.routes.js';
import { staffAdminRouter } from './staff-admin.routes.js';

const adminRouter = Router();

adminRouter.use(authenticate, authorize('ADMIN'));
adminRouter.get('/dashboard', asyncHandler(getDashboard));
adminRouter.use(customerAdminRouter);
adminRouter.use(schemeAdminRouter);
adminRouter.use(financeAdminRouter);
adminRouter.use(reportAdminRouter);
adminRouter.use(staffAdminRouter);
adminRouter.use(settingsAdminRouter);

export default adminRouter;
