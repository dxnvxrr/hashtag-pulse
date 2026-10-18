import { PrismaClient } from '@prisma/client';
import { isProduction } from '../config.js';

export const prisma = new PrismaClient({
  log: isProduction ? ['error'] : ['error', 'warn'],
});

export type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
