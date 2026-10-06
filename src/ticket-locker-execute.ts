#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { RailSession } from './booking-session.js';
import { Direct12306BookingAdapter } from './booking-direct.js';
import { Interline12306BookingAdapter } from './booking-interline.js';
import {
    ArmedManifest,
    CandidatePlan,
} from './ticket-locker.js';
import {
    BookingAdapter,
    SubmitResult,
    executeAuthorizedPlans,
} from './ticket-locker-executor.js';

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

function required(args: Args, key: string): string {
    const value = args[key];
    if (!value) throw new Error(`Missing --${key}`);
    return value;
}

class Composite12306BookingAdapter implements BookingAdapter {
    constructor(
        private readonly direct: Direct12306BookingAdapter,
        private readonly interline: Interline12306BookingAdapter
    ) {}

    submit(plan: CandidatePlan): Promise<SubmitResult> {
        return plan.kind === 'DIRECT'
            ? this.direct.submit(plan)
            : this.interline.submit(plan);
    }
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const armFile = required(args, 'arm-file');
    const sessionFile = required(args, 'session');
    const permit = required(args, 'permit');

    if (permit !== 'ARMED_USER_APPROVED') {
        throw new Error(
            'EXECUTION_BLOCKED: --permit must equal ARMED_USER_APPROVED'
        );
    }

    const passengerIndexes = required(args, 'passengers')
        .split(',')
        .map((x) => Number(x.trim()))
        .filter((x) => Number.isInteger(x));

    if (passengerIndexes.length === 0) {
        throw new Error('EXECUTION_BLOCKED: no passenger indexes');
    }

    const armed = JSON.parse(
        await readFile(armFile, 'utf8')
    ) as ArmedManifest;
    if (
        armed.schema !== 'ticket-locker.arm.v1' ||
        armed.invariant !== 'ONLY_AUTHORIZED_PLANS_MAY_SUBMIT'
    ) {
        throw new Error('EXECUTION_BLOCKED: invalid arm manifest');
    }

    const session = await RailSession.load(sessionFile);
    if (!(await session.checkUser())) {
        throw new Error('EXECUTION_BLOCKED: 12306 session is not logged in');
    }

    const options = {
        passengerIndexes,
        permit: 'ARMED_USER_APPROVED' as const,
        queuePollIntervalMs: Number(args['poll-ms'] ?? '1000'),
        queueTimeoutMs: Number(args['queue-timeout-ms'] ?? '120000'),
    };

    const adapter = new Composite12306BookingAdapter(
        new Direct12306BookingAdapter(session, armed, options),
        new Interline12306BookingAdapter(session, armed, options)
    );

    console.log(
        `EXECUTION_ARMED ${armed.authorizedPlanIds.join(' > ')}`
    );
    console.log(
        `PASSENGERS ${passengerIndexes.join(',')}`
    );

    const result = await executeAuthorizedPlans(
        armed,
        adapter,
        Number(args.retries ?? '0')
    );

    console.log(`TERMINAL ${result.terminal}`);
    if (result.lockedPlanId) {
        console.log(`PLAN ${result.lockedPlanId}`);
    }
    if (result.orderId) {
        console.log(`ORDER_ID ${result.orderId}`);
    }

    if (args.out) {
        await writeFile(
            args.out,
            JSON.stringify(result, null, 2) + '\n',
            { mode: 0o600 }
        );
        console.log(`RESULT_FILE ${args.out}`);
    }

    if (result.terminal === 'LOCKED') {
        console.log('ACTION PAY_MANUALLY_IN_OFFICIAL_12306');
        return;
    }
    if (result.terminal === 'NEED_HUMAN') {
        console.log('ACTION HUMAN_VERIFICATION_REQUIRED');
        return;
    }
    if (result.terminal === 'QUEUED') {
        console.log('ACTION QUEUE_ACCEPTED_NO_FALLBACK');
        return;
    }
    process.exitCode = 2;
}

main().catch((error) => {
    console.error(
        'AUTO_LOCK_ERROR',
        error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
});
