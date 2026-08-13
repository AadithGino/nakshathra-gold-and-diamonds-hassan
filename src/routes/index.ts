import { Router } from 'express';
import adminRoutes from './admin/index.js';
import authRoutes from './auth.routes.js';
import customerRoutes from './customer/index.js';
import gatewayRoutes from './gateway.routes.js';
import staffRoutes from './staff/index.js';
import uploadRoutes from './upload.routes.js';

const apiRouter = Router();

apiRouter.use('/auth', authRoutes);
apiRouter.use('/admin', adminRoutes);
apiRouter.use('/staff', staffRoutes);
apiRouter.use('/customer', customerRoutes);
apiRouter.use('/uploads', uploadRoutes);
apiRouter.use('/webhooks', gatewayRoutes);

export default apiRouter;
