import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { EmailService } from '../email/email.service';

@Injectable()
export class OrdersService {
    constructor(
        private prisma: PrismaService,
        private ledger: LedgerService,
        private emailService: EmailService
    ) { }

    async create(userId: string, dto: CreateOrderDto) {
        return this.prisma.$transaction(async (tx: any) => {
            // 1. Get and validate package
            const pkg = await tx.eventPackage.findUnique({
                where: { id: dto.packageId }
            });

            if (!pkg) throw new NotFoundException('Pacote de viagem não encontrado');
            if (!pkg.isActive) throw new BadRequestException('Este pacote não está mais disponível');
            if (pkg.stock < 1) throw new BadRequestException('Estoque esgotado para este pacote');

            // 2. Get and validate user balance
            const user = await tx.user.findUnique({
                where: { id: userId }
            });

            if (!user || user.coinBalance < pkg.priceCoins) {
                throw new BadRequestException('Saldo de coins insuficiente para este resgate');
            }

            // 3. Create Order
            const order = await tx.order.create({
                data: {
                    userId,
                    packageId: pkg.id,
                    totalCoins: pkg.priceCoins,
                    status: 'PENDING',
                    passengers: {
                        create: dto.passengers.map(p => ({
                            fullName: p.fullName,
                            document: p.document,
                            birthDate: new Date(p.birthDate),
                            email: p.email
                        }))
                    }
                }
            });

            // 4. Record in Ledger (Debit)
            await tx.ledger.create({
                data: {
                    userId,
                    amount: -pkg.priceCoins,
                    type: 'REDEMPTION',
                    description: `Resgate de prêmio: ${pkg.title}`,
                    relatedEntityId: order.id
                }
            });

            // 5. Update User Balance (Debit)
            await tx.user.update({
                where: { id: userId },
                data: {
                    coinBalance: {
                        decrement: pkg.priceCoins
                    }
                }
            });

            // 6. Update Package Stock
            await tx.eventPackage.update({
                where: { id: pkg.id },
                data: {
                    stock: {
                        decrement: 1
                    }
                }
            });

            // 7. Notificar usuário e Admin por e-mail
            await this.emailService.notifyRedemptionRequest(user.email, user.name, pkg.title);

            return order;
        });
    }

    async findAll() {
        return this.prisma.order.findMany({
            include: {
                user: {
                    select: {
                        id: true,
                        name: true,
                        email: true,
                        document: true
                    }
                },
                package: true,
                passengers: true
            },
            orderBy: { createdAt: 'desc' }
        });
    }

    async updateStatus(id: string, status: string) {
        return this.prisma.order.update({
            where: { id },
            data: { status }
        });
    }

    async findByUser(userId: string) {
        return this.prisma.order.findMany({
            where: { userId },
            include: {
                package: true,
                passengers: true
            },
            orderBy: { createdAt: 'desc' }
        });
    }
}
