import { Response, NextFunction } from 'express';
import { AuthRequest } from './authMiddleware';
import {
  EmployeePermissions,
  EmployeeNotificationSettings,
} from '../services/employeeMasterCatalog';
import {
  assertDocumentRight,
  assertGeneralRight,
  assertModuleAccess,
  assertTaskRight,
  getEffectivePermissions,
} from '../services/employeePermissionService';

export type AuthenticatedUser = NonNullable<AuthRequest['user']>;

function getPermissions(req: AuthRequest): EmployeePermissions {
  return (
    req.user?.employeePermissions ||
    getEffectivePermissions(req.user?.role, {
      moduleAccess: [],
      rights: { create: false, edit: false, delete: false, approve: false, view: false },
      taskRights: {
        createTask: false,
        assignTask: false,
        reassignTask: false,
        closeTask: false,
        escalateTask: false,
        viewTeamTasks: false,
      },
      workflowRoles: {
        preparedBy: false,
        reviewedBy: false,
        approvedBy: false,
        verifiedBy: false,
        escalation: false,
      },
      documentRights: {
        upload: false,
        edit: false,
        approve: false,
        reject: false,
        download: false,
        view: false,
      },
    })
  );
}

function forbidden(res: Response, message: string) {
  return res.status(403).json({ success: false, error: message });
}

export const requireModule = (
  module: 'Messaging' | 'Dashboard' | 'Tasks' | 'Documents'
) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user) return forbidden(res, 'Unauthorized');
      assertModuleAccess(req.user.role, getPermissions(req), module);
      next();
    } catch (e: any) {
      return forbidden(res, e.message || 'Forbidden');
    }
  };
};

export const requireTaskRight = (key: keyof EmployeePermissions['taskRights']) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user) return forbidden(res, 'Unauthorized');
      assertTaskRight(req.user.role, getPermissions(req), key);
      next();
    } catch (e: any) {
      return forbidden(res, e.message || 'Forbidden');
    }
  };
};

export const requireGeneralRight = (key: keyof EmployeePermissions['rights']) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user) return forbidden(res, 'Unauthorized');
      assertGeneralRight(req.user.role, getPermissions(req), key);
      next();
    } catch (e: any) {
      return forbidden(res, e.message || 'Forbidden');
    }
  };
};

export const requireDocumentRight = (key: keyof EmployeePermissions['documentRights']) => {
  return (req: AuthRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.user) return forbidden(res, 'Unauthorized');
      assertDocumentRight(req.user.role, getPermissions(req), key);
      next();
    } catch (e: any) {
      return forbidden(res, e.message || 'Forbidden');
    }
  };
};

/** Require closeTask when PATCH status moves toward completion. */
export const requireCloseTaskIfCompleting = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  const status = String(req.body?.status || '').toLowerCase();
  const completing = ['completed', 'pending_verification'].includes(status);
  if (!completing) return next();
  return requireTaskRight('closeTask')(req, res, next);
};

export type { EmployeePermissions, EmployeeNotificationSettings };
