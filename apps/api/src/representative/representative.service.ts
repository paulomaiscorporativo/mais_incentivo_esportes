import { Injectable, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { User } from '@votorantim-futebol/database';

@Injectable()
export class RepresentativeService {
    constructor(private prisma: PrismaService) { }

    async getDashboard(repId: string) {
        // 1. Get all stores associated with this representative
        const stores = await this.prisma.user.findMany({
            where: { representativeId: repId, role: 'CNPJ_MASTER' },
            include: {
                sellers: {
                    select: {
                        id: true,
                        coinBalance: true,
                    }
                },
                invoices: {
                    select: {
                        coinsIssued: true,
                    }
                }
            }
        });

        // 2. Aggregate metrics
        const totalStores = stores.length;
        let totalSellers = 0;
        let totalCoinsGenerated = 0;
        let totalBalanceInNetwork = 0;

        stores.forEach((store: any) => {
            totalSellers += store.sellers.length;
            totalBalanceInNetwork += store.coinBalance;
            store.sellers.forEach((s: any) => totalBalanceInNetwork += s.coinBalance);
            store.invoices.forEach((i: any) => totalCoinsGenerated += i.coinsIssued);
        });

        const mappedStores = await Promise.all(stores.map(async (u: any) => {
            const sellersCount = u.sellers?.length || 0;

            // Buscar pacotes da região da loja para ver o "Próximo Resgate"
            const nextEvent = await (this.prisma.eventPackage as any).findFirst({
                where: { region: u.region },
                orderBy: { priceCoins: 'asc' }
            });

            const balance = u.coinBalance || 0;
            const nextPrice = nextEvent?.priceCoins || 5000;
            const diff = nextPrice - balance;
            const isNear = diff > 0 && diff <= (nextPrice * 0.25); // Falta menos de 25%

            let suggestion = null;
            if (isNear) {
                suggestion = `Oferecer Booster de 5x para compras acima de R$ 5.000,00 para bater a meta de ${nextEvent?.teamMatch}`;
            }

            return {
                id: u.id,
                name: u.name,
                document: u.document,
                balance: balance,
                sellersCount: sellersCount,
                nextRedemption: nextEvent?.teamMatch || 'N/A',
                isNearRedemption: isNear,
                suggestion: suggestion
            };
        }));

        return {
            metrics: {
                totalStores,
                totalSellers,
                totalCoinsGenerated,
                totalBalanceInNetwork,
            },
            stores: mappedStores
        };
    }

    async getStoreDetail(repId: string, storeId: string): Promise<User> {
        const store = await this.prisma.user.findFirst({
            where: { id: storeId, representativeId: repId },
            include: {
                sellers: true,
                invoices: {
                    orderBy: { createdAt: 'desc' },
                    take: 10
                }
            }
        });

        if (!store) throw new ForbiddenException('Loja não encontrada ou não vinculada a este representante');

        return store;
    }

    async linkStore(repId: string, storeCnpj: string) {
        const store = await this.prisma.user.findUnique({ where: { document: storeCnpj } });
        if (!store) throw new Error('Loja não encontrada.');
        if (store.role !== 'CNPJ_MASTER') throw new Error('O documento informado não pertence a uma empresa.');

        return this.prisma.user.update({
            where: { document: storeCnpj },
            data: { representativeId: repId }
        });
    }
}
