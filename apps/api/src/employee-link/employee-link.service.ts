import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Inject, forwardRef } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { InvoiceService } from '../invoice/invoice.service';
import { EmailService } from '../email/email.service';

@Injectable()
export class EmployeeLinkService {
    constructor(
        private prisma: PrismaService,
        @Inject(forwardRef(() => InvoiceService))
        private invoiceService: InvoiceService,
        private emailService: EmailService,
    ) { }

    /**
     * Chamado pelo CPF_SELLER após o cadastro.
     * Busca a empresa pelo CNPJ e cria um EmployeeLink com status PENDING.
     */
    async requestLink(sellerId: string, storeCnpj: string) {
        const store = await this.prisma.user.findUnique({
            where: { document: storeCnpj },
        });

        if (!store) {
            throw new NotFoundException(`Empresa com CNPJ ${storeCnpj} não encontrada.`);
        }

        if (store.role !== 'CNPJ_MASTER') {
            throw new BadRequestException('O CNPJ informado não pertence a uma empresa cadastrada.');
        }

        const existingLink = await this.prisma.employeeLink.findUnique({
            where: { sellerId_storeId: { sellerId, storeId: store.id } },
        });

        if (existingLink) {
            throw new BadRequestException(`Você já possui um vínculo ${existingLink.status} com esta empresa.`);
        }

        return this.prisma.employeeLink.create({
            data: { sellerId, storeId: store.id },
            include: { store: { select: { name: true, document: true } } },
        });
    }

    async getPendingLinks(storeId: string) {
        return this.prisma.employeeLink.findMany({
            where: { storeId, status: 'PENDING' },
            include: {
                seller: { select: { id: true, name: true, email: true, document: true, createdAt: true } },
            },
            orderBy: { createdAt: 'desc' },
        });
    }

    /**
     * Retorna todos os vínculos com contagem de NFs em standby por vendedor.
     */
    async getAllLinks(storeId: string) {
        const links = await this.prisma.employeeLink.findMany({
            where: { storeId },
            include: {
                seller: { select: { id: true, name: true, email: true, document: true, coinBalance: true } },
            },
            orderBy: { createdAt: 'desc' },
        });

        // Enriquecer com contagem de standby invoices de cada vendedor
        const enriched = await Promise.all(links.map(async (link: any) => {
            const standbyCount = await this.prisma.invoice.count({
                where: { userId: link.sellerId, status: 'STANDBY' as any },
            });
            return { ...link, standbyInvoiceCount: standbyCount };
        }));

        return enriched;
    }

    async getMyLinks(sellerId: string) {
        const links = await this.prisma.employeeLink.findMany({
            where: { sellerId },
            include: {
                store: { select: { id: true, name: true, document: true } },
            },
        });

        const enriched = await Promise.all(links.map(async (link) => {
            const standbyCount = await this.prisma.invoice.count({
                where: { userId: sellerId, status: 'STANDBY' as any },
            });
            return { ...link, standbyInvoiceCount: standbyCount };
        }));

        return enriched;
    }

    /**
     * Aprova ou recusa um vínculo.
     * Se aprovado com coinPercentage já > 0, triggers standby invoice processing.
     */
    async respondToLink(linkId: string, storeId: string, approve: boolean) {
        const link = await this.prisma.employeeLink.findUnique({ where: { id: linkId } });

        if (!link) throw new NotFoundException('Vínculo não encontrado.');
        if (link.storeId !== storeId) throw new ForbiddenException('Sem permissão.');
        if (link.status !== 'PENDING') throw new BadRequestException('Este vínculo já foi respondido.');

        if (approve) {
            const [updatedLink] = await this.prisma.$transaction([
                this.prisma.employeeLink.update({
                    where: { id: linkId },
                    data: { status: 'APPROVED' },
                    include: { seller: { select: { name: true } } },
                }),
                this.prisma.user.update({
                    where: { id: link.sellerId },
                    data: { storeId: link.storeId },
                }),
            ]);

            // Se já tem porcentagem configurada (não é 0), processa standby imediatamente
            if (link.coinPercentage > 0) {
                await this.invoiceService.processStandbyInvoices(link.sellerId, link.storeId, link.coinPercentage);
            }

            // 2. Notificar o vendedor por e-mail
            const seller = await this.prisma.user.findUnique({ where: { id: link.sellerId }, include: { store: true } });
            if (seller && seller.store) {
                await this.emailService.notifyLinkApproval(seller.email, seller.store.name);
            }

            return updatedLink;
        } else {
            return this.prisma.employeeLink.update({
                where: { id: linkId },
                data: { status: 'REJECTED' },
            });
        }
    }

    /**
     * Atualiza a porcentagem de coins de um vendedor.
     * Se o vínculo estava aprovado e havia standby invoices, processa automaticamente.
     */
    async updatePercentage(linkId: string, storeId: string, percentage: number) {
        if (percentage < 0 || percentage > 100) {
            throw new BadRequestException('A porcentagem deve ser entre 0 e 100.');
        }

        const link = await this.prisma.employeeLink.findUnique({ where: { id: linkId } });
        if (!link) throw new NotFoundException('Vínculo não encontrado.');
        if (link.storeId !== storeId) throw new ForbiddenException('Sem permissão.');
        if (link.status !== 'APPROVED') throw new BadRequestException('Só é possível configurar a porcentagem de vínculos aprovados.');

        const wasZero = link.coinPercentage === 0;

        const updated = await this.prisma.employeeLink.update({
            where: { id: linkId },
            data: { coinPercentage: percentage },
        });

        // Se a porcentagem era 0 e agora está sendo definida, processa standby invoices
        if (wasZero && percentage > 0) {
            await this.invoiceService.processStandbyInvoices(link.sellerId, link.storeId, percentage);
        }

        return updated;
    }

    async getApprovedLink(sellerId: string) {
        return this.prisma.employeeLink.findFirst({
            where: { sellerId, status: 'APPROVED' },
            include: { store: true },
        });
    }

    async countPendingLinks(storeId: string): Promise<number> {
        return this.prisma.employeeLink.count({ where: { storeId, status: 'PENDING' } });
    }
}
