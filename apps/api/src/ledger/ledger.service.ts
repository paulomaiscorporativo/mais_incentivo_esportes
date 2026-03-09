import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

@Injectable()
export class LedgerService {
    constructor(private prisma: PrismaService) { }

    async createEntry(userId: string, amount: number, type: string, description: string, relatedEntityId?: string) {
        return this.prisma.$transaction(async (tx: any) => {
            // 1. Create Ledger entry
            const entry = await tx.ledger.create({
                data: {
                    userId,
                    amount,
                    type,
                    description,
                    relatedEntityId,
                },
            });

            // 2. Update User cached balance
            await tx.user.update({
                where: { id: userId },
                data: {
                    coinBalance: {
                        increment: amount,
                    },
                },
            });

            return entry;
        });
    }

    async getHistory(userId: string) {
        return this.prisma.ledger.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
        });
    }
}
