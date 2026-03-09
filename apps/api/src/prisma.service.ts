import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@votorantim-futebol/database';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
    constructor() {
        let url = process.env.DATABASE_URL || '';
        // Otimizar string de conexão para Render Free
        if (url && !url.includes('connection_limit')) {
            url += (url.includes('?') ? '&' : '?') + 'connection_limit=2&connect_timeout=30';
        }
        super({
            datasources: {
                db: { url }
            },
            log: ['query', 'info', 'warn', 'error'],
        });
    }

    async onModuleInit() {
        const url = process.env.DATABASE_URL || '';
        const maskedUrl = url.replace(/:([^:@]+)@/, ':****@');
        console.log(`[Database] Initializing connection: ${maskedUrl}`);

        // Tentativa de conexão em background para não travar a abertura da porta
        this.connectWithRetry();
    }

    private async connectWithRetry(retries = 30) {
        while (retries > 0) {
            try {
                await this.$connect();
                console.log('[Database] ✅ Successfully connected!');
                return;
            } catch (err) {
                console.error(`[Database] ❌ Connection failed. Retries left: ${retries - 1}`);
                retries--;
                if (retries > 0) {
                    await new Promise(res => setTimeout(res, 5000));
                }
            }
        }
        console.error('[Database] 🚨 Could not connect after max retries. System might be unstable.');
    }

    async onModuleDestroy() {
        await this.$disconnect();
    }
}
