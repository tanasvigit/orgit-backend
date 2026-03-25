import { Router } from 'express';
import { authenticate } from '../middleware/authMiddleware';
import * as masterDataController from '../controllers/masterDataController';

const router = Router();

router.use(authenticate);

router.get('/countries', masterDataController.getCountries);
router.get('/states', masterDataController.getStates);
router.get('/cities', masterDataController.getCities);
router.get('/org-constitutions', masterDataController.getOrgConstitutions);
router.get('/task-services', masterDataController.getTaskServices);
router.get('/task-frequencies', masterDataController.getTaskFrequencies);

export default router;
