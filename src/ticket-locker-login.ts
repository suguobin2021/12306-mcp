#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RailSession } from './booking-session.js';

type Args = Record<string, string>;

function parseArgs(argv: string[]): Args {
    const args: Args = {};
    for (let i = 0; i < argv.length; i++) {
        const token = argv[i];
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const value =
            argv[i + 1] && !argv[i + 1].startsWith('--')
                ? argv[++i]
                : 'true';
        args[key] = value;
    }
    return args;
}

const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const root = args.root ?? '.ticket-locker';
    const sessionPath = args.session ?? `${root}/session.json`;
    const qrPath = args.qr ?? `${root}/login-qr.jpg`;
    const timeoutSeconds = Number(args.timeout ?? '120');

    await mkdir(dirname(sessionPath), { recursive: true });
    await mkdir(dirname(qrPath), { recursive: true });

    const session = new RailSession();
    const qr = await session.createQr();
    await writeFile(qrPath, Buffer.from(qr.image, 'base64'), {
        mode: 0o600,
    });

    console.log(`QR_READY ${qrPath}`);
    console.log(`QR_UUID ${qr.uuid}`);
    console.log('WAITING_FOR_SCAN');

    const deadline = Date.now() + timeoutSeconds * 1000;
    let previous = '';

    while (Date.now() < deadline) {
        const result = await session.checkQr(qr.uuid);
        const code = String(result.result_code);
        if (code !== previous) {
            console.log(
                `QR_STATUS ${code} ${result.result_message ?? ''}`.trim()
            );
            previous = code;
        }
        if (code === '2') {
            const auth = await session.finalizeUnifiedAuth();
            const ok = await session.checkUser();
            if (!ok) throw new Error('LOGIN_FINALIZED_BUT_CHECKUSER_FALSE');
            await session.save(sessionPath);
            console.log(
                `LOGIN_OK ${auth.username ?? ''}`.trim()
            );
            console.log(`SESSION_FILE ${sessionPath}`);
            return;
        }
        if (code === '3') throw new Error('QR_EXPIRED');
        if (code === '5') {
            throw new Error(
                `QR_SYSTEM_ERROR:${result.result_message ?? ''}`
            );
        }
        await sleep(1000);
    }

    throw new Error('QR_LOGIN_TIMEOUT');
}

main().catch((error) => {
    console.error(
        'LOGIN_ERROR',
        error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
});
