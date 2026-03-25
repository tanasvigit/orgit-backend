import { Response } from 'express';
import { AuthRequest } from '../middleware/authMiddleware';
import * as masterDataService from '../services/masterDataService';

/**
 * GET /api/master/countries - list countries (for dropdown)
 */
export async function getCountries(req: AuthRequest, res: Response) {
  try {
    const countries = await masterDataService.getCountries();
    res.json({ success: true, data: countries });
  } catch (error: any) {
    console.error('Error getting countries:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get countries',
    });
  }
}

/**
 * GET /api/master/states?country_id=:id - list states for a country
 */
export async function getStates(req: AuthRequest, res: Response) {
  try {
    const countryId = req.query.country_id as string;
    if (!countryId) {
      return res.status(400).json({
        success: false,
        error: 'country_id query parameter is required',
      });
    }
    const states = await masterDataService.getStatesByCountry(countryId);
    res.json({ success: true, data: states });
  } catch (error: any) {
    console.error('Error getting states:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get states',
    });
  }
}

/**
 * GET /api/master/cities?state_id=:id - list cities for a state
 */
export async function getCities(req: AuthRequest, res: Response) {
  try {
    const stateId = req.query.state_id as string;
    if (!stateId) {
      return res.status(400).json({
        success: false,
        error: 'state_id query parameter is required',
      });
    }
    const cities = await masterDataService.getCitiesByState(stateId);
    res.json({ success: true, data: cities });
  } catch (error: any) {
    console.error('Error getting cities:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get cities',
    });
  }
}

/**
 * GET /api/master/org-constitutions - list { value, label } for Org Constitution dropdown
 */
export async function getOrgConstitutions(req: AuthRequest, res: Response) {
  try {
    const options = masterDataService.getOrgConstitutions();
    res.json({ success: true, data: options });
  } catch (error: any) {
    console.error('Error getting org constitutions:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get org constitutions',
    });
  }
}

/**
 * GET /api/master/task-services?type=recurring|one_time - list service/task master items
 */
export async function getTaskServices(req: AuthRequest, res: Response) {
  try {
    const type = (req.query.type as string | undefined)?.toLowerCase();
    const taskType =
      type === 'recurring' || type === 'one_time' ? (type as any) : undefined;

    const organizationId = req.user?.organizationId ?? null;
    const items = await masterDataService.getTaskServices({
      taskType,
      organizationId,
    });
    res.json({ success: true, data: items });
  } catch (error: any) {
    console.error('Error getting task services:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get task services',
    });
  }
}

/**
 * GET /api/master/task-frequencies - frequency dropdown options
 */
export async function getTaskFrequencies(req: AuthRequest, res: Response) {
  try {
    res.json({ success: true, data: masterDataService.TASK_FREQUENCY_OPTIONS });
  } catch (error: any) {
    console.error('Error getting task frequencies:', error);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to get task frequencies',
    });
  }
}

/**
 * POST /api/admin/task-services - create one task service for admin's organization
 */
export async function createTaskService(req: AuthRequest, res: Response) {
  try {
    const organizationId = req.user?.organizationId;
    if (!organizationId) {
      return res.status(400).json({
        success: false,
        error: 'Organization context required',
      });
    }
    const { title, task_type, frequency, rollout_rule } = req.body || {};
    const item = await masterDataService.createTaskService(organizationId, {
      title,
      task_type,
      frequency,
      rollout_rule,
    });
    res.status(201).json({ success: true, data: item });
  } catch (error: any) {
    console.error('Error creating task service:', error);
    res.status(400).json({
      success: false,
      error: error.message || 'Failed to create task service',
    });
  }
}
