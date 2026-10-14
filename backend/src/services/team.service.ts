import { PrismaClient } from '@prisma/client';
import { AppError } from './auth.service';

const prisma = new PrismaClient();

export interface InviteMemberInput {
  email: string;
  role?: 'ADMIN' | 'DEVELOPER';
}

/**
 * List team members for a merchant
 */
export async function listTeamMembers(merchantId: string) {
  // Get the merchant (owner)
  const merchant = await prisma.merchant.findUnique({
    where: { id: merchantId },
  });

  if (!merchant) throw new AppError('Merchant not found', 404);

  // Get team members
  const members = await prisma.teamMember.findMany({
    where: { merchantId, status: { not: 'REMOVED' } },
    orderBy: { createdAt: 'asc' },
  });

  // Build the list starting with the owner
  const ownerEntry = {
    id: merchant.id,
    name: merchant.businessName,
    email: merchant.email,
    role: 'OWNER' as const,
    status: 'ACTIVE' as const,
    createdAt: merchant.createdAt.toISOString(),
  };

  const memberEntries = members.map(m => ({
    id: m.id,
    name: m.name,
    email: m.email,
    role: m.role,
    status: m.status,
    createdAt: m.createdAt.toISOString(),
  }));

  return {
    data: [ownerEntry, ...memberEntries],
    total: 1 + members.length,
  };
}

/**
 * Invite a new team member
 */
export async function inviteMember(merchantId: string, input: InviteMemberInput) {
  // Check if already invited
  const existing = await prisma.teamMember.findUnique({
    where: { merchantId_email: { merchantId, email: input.email } },
  });

  if (existing && existing.status !== 'REMOVED') {
    throw new AppError('This email has already been invited', 409);
  }

  // Check if this is the merchant's own email
  const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
  if (merchant && merchant.email === input.email) {
    throw new AppError('Cannot invite yourself', 400);
  }

  const member = existing
    ? await prisma.teamMember.update({
        where: { id: existing.id },
        data: {
          role: input.role || 'DEVELOPER',
          status: 'PENDING',
          name: input.email.split('@')[0],
        },
      })
    : await prisma.teamMember.create({
        data: {
          merchantId,
          email: input.email,
          name: input.email.split('@')[0],
          role: input.role || 'DEVELOPER',
          status: 'PENDING',
        },
      });

  return {
    id: member.id,
    email: member.email,
    role: member.role,
    status: member.status,
  };
}

/**
 * Remove a team member
 */
export async function removeMember(merchantId: string, memberId: string) {
  const member = await prisma.teamMember.findFirst({
    where: { id: memberId, merchantId },
  });

  if (!member) throw new AppError('Team member not found', 404);

  await prisma.teamMember.update({
    where: { id: memberId },
    data: { status: 'REMOVED' },
  });
}

/**
 * Update a team member's role
 */
export async function updateMemberRole(merchantId: string, memberId: string, role: 'ADMIN' | 'DEVELOPER') {
  const member = await prisma.teamMember.findFirst({
    where: { id: memberId, merchantId },
  });

  if (!member) throw new AppError('Team member not found', 404);

  const updated = await prisma.teamMember.update({
    where: { id: memberId },
    data: { role },
  });

  return {
    id: updated.id,
    role: updated.role,
  };
}
