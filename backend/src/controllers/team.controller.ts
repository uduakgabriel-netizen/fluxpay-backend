import { logger } from '../utils/logger';
import { Response } from 'express';
import { AuthRequest } from '../types/auth.types';
import * as teamService from '../services/team.service';
import { AppError } from '../services/auth.service';

function handleError(error: unknown, res: Response): void {
  if (error instanceof AppError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }
  logger.error('Team controller error:', error);
  res.status(500).json({ error: 'Internal server error' });
}

/**
 * GET /api/team
 */
export async function list(req: AuthRequest, res: Response): Promise<void> {
  try {
    const result = await teamService.listTeamMembers(req.merchant!.id);
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * POST /api/team/invite
 */
export async function invite(req: AuthRequest, res: Response): Promise<void> {
  try {
    const result = await teamService.inviteMember(req.merchant!.id, req.body);
    res.status(201).json(result);
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * DELETE /api/team/:id
 */
export async function remove(req: AuthRequest, res: Response): Promise<void> {
  try {
    await teamService.removeMember(req.merchant!.id, req.params.id);
    res.status(200).json({ message: 'Team member removed' });
  } catch (error) {
    handleError(error, res);
  }
}

/**
 * PATCH /api/team/:id/role
 */
export async function updateRole(req: AuthRequest, res: Response): Promise<void> {
  try {
    const result = await teamService.updateMemberRole(
      req.merchant!.id,
      req.params.id,
      req.body.role
    );
    res.status(200).json(result);
  } catch (error) {
    handleError(error, res);
  }
}
