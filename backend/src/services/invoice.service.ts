import { PrismaClient } from '@prisma/client';
import { AppError } from './auth.service';

const prisma = new PrismaClient();

export interface CreateInvoiceInput {
  customer: string;
  customerEmail?: string;
  amount: number;
  token?: string;
  description?: string;
  dueDate: string;
}

export interface InvoiceFilters {
  page?: number;
  limit?: number;
  status?: string;
}

/**
 * List invoices for a merchant
 */
export async function listInvoices(merchantId: string, filters: InvoiceFilters) {
  const page = filters.page || 1;
  const limit = filters.limit || 20;
  const skip = (page - 1) * limit;

  const where: any = { merchantId };
  if (filters.status) where.status = filters.status;

  const [invoices, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.invoice.count({ where }),
  ]);

  // Summary
  const allInvoices = await prisma.invoice.findMany({ where: { merchantId } });
  const totalPaid = allInvoices.filter(i => i.status === 'PAID').reduce((s, i) => s + i.amount, 0);
  const totalPending = allInvoices.filter(i => ['DRAFT', 'SENT'].includes(i.status)).reduce((s, i) => s + i.amount, 0);
  const totalOverdue = allInvoices.filter(i => i.status === 'OVERDUE').reduce((s, i) => s + i.amount, 0);

  return {
    data: invoices.map(inv => ({
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      customer: inv.customer,
      customerEmail: inv.customerEmail,
      amount: inv.amount,
      token: inv.token,
      description: inv.description,
      status: inv.status,
      dueDate: inv.dueDate.toISOString(),
      paidAt: inv.paidAt?.toISOString() || null,
      sentAt: inv.sentAt?.toISOString() || null,
      createdAt: inv.createdAt.toISOString(),
    })),
    meta: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
    summary: { totalPaid, totalPending, totalOverdue },
  };
}

/**
 * Create a new invoice
 */
export async function createInvoice(merchantId: string, input: CreateInvoiceInput) {
  // Generate invoice number
  const count = await prisma.invoice.count({ where: { merchantId } });
  const invoiceNumber = `INV-${String(count + 1).padStart(3, '0')}`;

  const invoice = await prisma.invoice.create({
    data: {
      merchantId,
      invoiceNumber,
      customer: input.customer,
      customerEmail: input.customerEmail,
      amount: input.amount,
      token: input.token || 'USDC',
      description: input.description,
      dueDate: new Date(input.dueDate),
    },
  });

  return {
    id: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    customer: invoice.customer,
    amount: invoice.amount,
    status: invoice.status,
    dueDate: invoice.dueDate.toISOString(),
    createdAt: invoice.createdAt.toISOString(),
  };
}

/**
 * Update invoice status
 */
export async function updateInvoiceStatus(merchantId: string, invoiceId: string, status: string) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, merchantId },
  });

  if (!invoice) throw new AppError('Invoice not found', 404);

  const updateData: any = { status };
  if (status === 'SENT') updateData.sentAt = new Date();
  if (status === 'PAID') updateData.paidAt = new Date();

  const updated = await prisma.invoice.update({
    where: { id: invoiceId },
    data: updateData,
  });

  return {
    id: updated.id,
    invoiceNumber: updated.invoiceNumber,
    status: updated.status,
  };
}

/**
 * Delete an invoice (only if DRAFT)
 */
export async function deleteInvoice(merchantId: string, invoiceId: string) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: invoiceId, merchantId },
  });

  if (!invoice) throw new AppError('Invoice not found', 404);
  if (invoice.status !== 'DRAFT') throw new AppError('Only draft invoices can be deleted', 400);

  await prisma.invoice.delete({ where: { id: invoiceId } });
}
