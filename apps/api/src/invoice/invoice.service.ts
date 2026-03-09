import { Injectable, BadRequestException, ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { AllowedEmittersService } from '../allowed-emitters/allowed-emitters.service';
import { EmailService } from '../email/email.service';
import { Invoice, InvoiceStatus } from '@votorantim-futebol/database';

@Injectable()
export class InvoiceService {
    constructor(
        private prisma: PrismaService,
        private ledger: LedgerService,
        private allowedEmitters: AllowedEmittersService,
        private emailService: EmailService,
    ) { }

    async submit(userId: string, accessKey: string): Promise<Invoice> {
        // 1. Validação básica da chave de 44 dígitos
        if (!/^\d{44}$/.test(accessKey)) {
            throw new BadRequestException('Chave de acesso inválida. Deve conter exatamente 44 dígitos numéricos.');
        }

        // 2. Validação do emitente via banco de dados (emissores autorizados do Grupo Votorantim)
        // ⚠️  TEMPORARIAMENTE DESABILITADO — descomente para reativar a validação por CNPJ
        // const cnpjEmitente = accessKey.substring(6, 20);
        // const emitterAllowed = await this.allowedEmitters.isAllowed(cnpjEmitente);
        // if (!emitterAllowed) {
        //     throw new UnprocessableEntityException(
        //         `Esta Nota Fiscal não pôde ser contabilizada pois foi emitida por um fornecedor fora do Grupo Votorantim Cimentos. ` +
        //         `Apenas notas fiscais de compras realizadas com empresas do Grupo Votorantim Cimentos geram Votorantim Coins. ` +
        //         `Verifique a chave informada ou entre em contato com seu representante comercial.`
        //     );
        // }

        // 3. Verifica duplicata
        const existing = await this.prisma.invoice.findUnique({ where: { accessKey } });
        if (existing) {
            throw new ConflictException('Esta nota fiscal já foi enviada anteriormente.');
        }

        const totalCoins = 100; // MVP: 100 coins fixo por NF

        // 3. Verifica o estado do vínculo do vendedor com sua empresa
        const pendingLink = await this.prisma.employeeLink.findFirst({
            where: { sellerId: userId, status: 'PENDING' },
        });

        const approvedLink = await this.prisma.employeeLink.findFirst({
            where: { sellerId: userId, status: 'APPROVED' },
            include: { store: true },
        });

        // 4. Determina se deve ir para STANDBY
        const hasActiveButUnconfiguredLink = approvedLink && approvedLink.coinPercentage === 0;
        const hasPendingLink = !!pendingLink;
        const shouldStandby = hasPendingLink || hasActiveButUnconfiguredLink;

        if (shouldStandby) {
            // Cria NF em STANDBY — nenhum coin é creditado ainda
            const standbyMessage = hasPendingLink
                ? `NF em espera: vínculo com a empresa ainda não foi aprovado.`
                : `NF em espera: empresa ainda não definiu a porcentagem de coins.`;

            const invoice = await this.prisma.invoice.create({
                data: {
                    accessKey,
                    userId,
                    coinsIssued: totalCoins,
                    status: 'STANDBY' as InvoiceStatus,
                    processedAt: null, // Será preenchido quando processada
                },
            });

            return invoice;
        }

        // 5. Cria a Invoice como APPROVED para processamento imediato
        const invoice = await this.prisma.invoice.create({
            data: {
                accessKey,
                userId,
                coinsIssued: totalCoins,
                status: InvoiceStatus.APPROVED,
                processedAt: new Date(),
            },
        });

        // 6. Distribuição dos coins
        if (approvedLink && approvedLink.coinPercentage > 0) {
            // Vínculo ativo com porcentagem → dividir entre vendedor e empresa
            const sellerCoins = Math.floor(totalCoins * approvedLink.coinPercentage / 100);
            const companyCoins = totalCoins - sellerCoins;

            if (sellerCoins > 0) {
                await this.ledger.createEntry(
                    userId, sellerCoins, 'INVOICE_REWARD',
                    `Crédito de ${approvedLink.coinPercentage}% via NF: ${accessKey} (vinculado a ${approvedLink.store.name})`,
                    invoice.id
                );
            }
            if (companyCoins > 0) {
                await this.ledger.createEntry(
                    approvedLink.storeId, companyCoins, 'INVOICE_REWARD_COMPANY',
                    `Crédito de ${100 - approvedLink.coinPercentage}% via NF do vendedor: ${accessKey}`,
                    invoice.id
                );
            }
        } else {
            // Sem vínculo algum → 100% para o vendedor
            await this.ledger.createEntry(
                userId, totalCoins, 'INVOICE_REWARD',
                `Crédito de coins via Nota Fiscal: ${accessKey}`,
                invoice.id
            );
        }

        // 7. Notificar usuário por e-mail
        const user = await this.prisma.user.findUnique({ where: { id: userId } });
        if (user) {
            await this.emailService.notifyInvoiceUploaded(user.email, user.name);
        }

        return invoice;
    }

    /**
     * Processa todas as NFs em STANDBY de um vendedor.
     * Chamado automaticamente quando:
     * - A empresa aprova o vínculo E a porcentagem já foi configurada
     * - A empresa define a porcentagem de um vínculo já aprovado
     */
    async processStandbyInvoices(sellerId: string, storeId: string, coinPercentage: number): Promise<void> {
        if (coinPercentage <= 0 || coinPercentage > 100) return;

        const standbyInvoices = await this.prisma.invoice.findMany({
            where: { userId: sellerId, status: 'STANDBY' as InvoiceStatus },
        });

        for (const invoice of standbyInvoices) {
            const totalCoins = invoice.coinsIssued;
            const sellerCoins = Math.floor(totalCoins * coinPercentage / 100);
            const companyCoins = totalCoins - sellerCoins;

            // Marca a invoice como aprovada
            await this.prisma.invoice.update({
                where: { id: invoice.id },
                data: { status: InvoiceStatus.APPROVED, processedAt: new Date() },
            });

            if (sellerCoins > 0) {
                await this.ledger.createEntry(
                    sellerId, sellerCoins, 'INVOICE_REWARD',
                    `Crédito retroativo de ${coinPercentage}% via NF: ${invoice.accessKey} (vínculo aprovado)`,
                    invoice.id
                );
            }
            if (companyCoins > 0) {
                await this.ledger.createEntry(
                    storeId, companyCoins, 'INVOICE_REWARD_COMPANY',
                    `Crédito retroativo de ${100 - coinPercentage}% via NF do vendedor: ${invoice.accessKey}`,
                    invoice.id
                );
            }
        }
    }

    async listByUser(userId: string): Promise<Invoice[]> {
        return this.prisma.invoice.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
        });
    }

    async countStandbyByStore(storeId: string): Promise<number> {
        // Conta NFs em standby de vendedores vinculados (pendentes ou aprovados sem %) a esta loja
        const pendingLinks = await this.prisma.employeeLink.findMany({
            where: { storeId, status: 'PENDING' },
            select: { sellerId: true },
        });
        const approvedNoPercLinks = await this.prisma.employeeLink.findMany({
            where: { storeId, status: 'APPROVED', coinPercentage: 0 },
            select: { sellerId: true },
        });
        const sellerIds = [
            ...pendingLinks.map((l: any) => l.sellerId),
            ...approvedNoPercLinks.map((l: any) => l.sellerId),
        ];
        if (sellerIds.length === 0) return 0;

        return this.prisma.invoice.count({
            where: { userId: { in: sellerIds }, status: 'STANDBY' as InvoiceStatus },
        });
    }
}
