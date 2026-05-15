import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware';
import { isAdminOrSuperAdmin, requireOrganization } from '../middleware/adminMiddleware';
import * as organizationStructureController from '../controllers/organizationStructureController';

const router = Router();

router.use(authenticate);

router.get('/tree', organizationStructureController.getOrganizationStructureTree);
router.get('/levels', organizationStructureController.getOrganizationStructureLevels);
router.get('/operational-options', organizationStructureController.getOrganizationStructureOperationalOptions);
router.get('/reporting/rollups', organizationStructureController.getReportingRollups);

router.put('/levels/:id', isAdminOrSuperAdmin, requireOrganization, organizationStructureController.updateOrganizationStructureLevel);
router.post('/nodes', isAdminOrSuperAdmin, requireOrganization, organizationStructureController.createOrganizationStructureNode);
router.put('/nodes/:id', isAdminOrSuperAdmin, requireOrganization, organizationStructureController.updateOrganizationStructureNode);
router.patch('/nodes/:id/archive', isAdminOrSuperAdmin, requireOrganization, organizationStructureController.archiveOrganizationStructureNode);
router.delete('/nodes/:id', isAdminOrSuperAdmin, requireOrganization, organizationStructureController.deleteOrganizationStructureNode);

export default router;
