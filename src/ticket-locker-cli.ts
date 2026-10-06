#!/usr/bin/env node
import axios from 'axios';
import { readFile, writeFile } from 'node:fs/promises';
import {
    ArmedManifest,
    PlanManifest,
    RawInterline,
    TicketLeg,
    armPlans,
    buildDirectPlans,
    buildInterlinePlans,
    rankPlans,
} from './ticket-locker.js';

type Args = Record<string, string>;

function parseArgs(argv: string[]): { command: string; args: Args } {
    const [command = '', ...rest] = argv;
    const args: Args = {};
    for (let i = 0; i < rest.length; i++) {
        const token = rest[i];
        if (!token.startsWith('--')) continue;
        const key = token.slice(2);
        const value = rest[i + 1] && !rest[i + 1].startsWith('--')
            ? rest[++i]
            : 'true';
        args[key] = value;
    }
    return { command, args };
}

async function callTool(
    mcpUrl: string,
    name: string,
    input: Record<string, unknown>
): Promise<unknown> {
    const response = await axios.post(
        mcpUrl,
        {
            jsonrpc: '2.0',
            id: Date.now(),
            method: 'tools/call',
            params: { name, arguments: input },
        },
        {
            headers: {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
            },
            timeout: 15000,
        }
    );
    const text = response.data?.result?.content?.[0]?.text;
    if (typeof text !== 'string') {
        throw new Error(`Unexpected MCP response from ${name}`);
    }
    if (text.startsWith('很抱歉')) return [];
    return JSON.parse(text);
}

function requireArg(args: Args, key: string): string {
    const value = args[key];
    if (!value) throw new Error(`Missing --${key}`);
    return value;
}

function printManifest(manifest: PlanManifest): void {
    console.log(
        `PLAN_SET ${manifest.query.from} -> ${manifest.query.to} ${manifest.query.date}`
    );
    for (const p of manifest.plans) {
        const legs = p.legs
            .map(
                (x) =>
                    `${x.trainCode} ${x.from} ${x.departTime}->${x.to} ${x.arriveTime} ${x.seatName}(${x.availability}) ¥${x.price}`
            )
            .join(' | ');
        const transfer = p.transfer
            ? ` | 换乘:${p.transfer.station} ${p.transfer.sameStation ? '同站' : '换站'} ${p.transfer.waitTime}`
            : '';
        console.log(
            `${p.id} | ¥${p.totalPrice.toFixed(1)} | ${Math.floor(
                p.durationMinutes / 60
            )}h${p.durationMinutes % 60}m | ${legs}${transfer}`
        );
    }
}

async function commandPlan(args: Args): Promise<void> {
    const mcpUrl = args.mcp ?? 'http://127.0.0.1:18083/mcp';
    const date = requireArg(args, 'date');
    const from = requireArg(args, 'from');
    const to = requireArg(args, 'to');
    const count = Number(args.count ?? '5');
    if (![3, 5].includes(count)) {
        throw new Error('--count must be 3 or 5');
    }
    const seatPriority = (args.seats ??
        '二等座,硬卧,一等座,软卧,无座,商务座,特等座,硬座')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);

    const hubs = (args.hubs ?? '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);

    const directPromise = callTool(mcpUrl, 'get-tickets', {
        date,
        fromStation: from,
        toStation: to,
        sortFlag: 'duration',
        limitedNum: 20,
        format: 'json',
    });

    const interlineRequests: Array<Promise<unknown>> = [
        callTool(mcpUrl, 'get-interline-tickets', {
            date,
            fromStation: from,
            toStation: to,
            showWZ: true,
            sortFlag: 'duration',
            limitedNum: 10,
            format: 'json',
        }),
        ...hubs.map((middleStation) =>
            callTool(mcpUrl, 'get-interline-tickets', {
                date,
                fromStation: from,
                toStation: to,
                middleStation,
                showWZ: true,
                sortFlag: 'duration',
                limitedNum: 10,
                format: 'json',
            })
        ),
    ];

    const [directRaw, interlineGroups] = await Promise.all([
        directPromise,
        Promise.all(interlineRequests),
    ]);
    const interlineRaw = interlineGroups.flat() as RawInterline[];

    const direct = buildDirectPlans(
        directRaw as TicketLeg[],
        seatPriority
    );
    const interline = buildInterlinePlans(
        interlineRaw,
        seatPriority
    );
    const plans = rankPlans([...direct, ...interline], count);
    const manifest: PlanManifest = {
        schema: 'ticket-locker.plan.v1',
        createdAt: new Date().toISOString(),
        query: { date, from, to, requestedCount: count, seatPriority },
        plans,
    };
    printManifest(manifest);
    const out = args.out;
    if (out) {
        await writeFile(out, JSON.stringify(manifest, null, 2) + '\n');
        console.log(`PLAN_FILE ${out}`);
    }
}

async function commandArm(args: Args): Promise<void> {
    const planFile = requireArg(args, 'plan-file');
    const selected = requireArg(args, 'select')
        .split(',')
        .map((x) => x.trim().toUpperCase())
        .filter(Boolean);
    const raw = JSON.parse(await readFile(planFile, 'utf8')) as PlanManifest;
    if (raw.schema !== 'ticket-locker.plan.v1') {
        throw new Error('Unsupported plan manifest');
    }
    const armed = armPlans(raw, selected);
    const out = args.out ?? planFile.replace(/\.json$/, '.armed.json');
    await writeFile(out, JSON.stringify(armed, null, 2) + '\n');
    console.log(`ARMED ${armed.authorizedPlanIds.join(' > ')}`);
    for (const p of armed.plans) {
        console.log(
            `${p.id} ${p.legs
                .map((x) => `${x.trainCode}/${x.seatName}`)
                .join(' + ')} ¥${p.totalPrice.toFixed(1)}`
        );
    }
    console.log(`ARM_FILE ${out}`);
    console.log('INVARIANT ONLY_AUTHORIZED_PLANS_MAY_SUBMIT');
}

async function commandShow(args: Args): Promise<void> {
    const armFile = requireArg(args, 'arm-file');
    const armed = JSON.parse(
        await readFile(armFile, 'utf8')
    ) as ArmedManifest;
    console.log(`AUTHORIZED_ORDER ${armed.authorizedPlanIds.join(' > ')}`);
    console.log(armed.invariant);
}

async function main(): Promise<void> {
    const { command, args } = parseArgs(process.argv.slice(2));
    if (command === 'plan') return commandPlan(args);
    if (command === 'arm') return commandArm(args);
    if (command === 'show') return commandShow(args);
    throw new Error(
        'Usage: ticket-locker <plan|arm|show> [options]'
    );
}

main().catch((error) => {
    console.error(
        'TICKET_LOCKER_ERROR',
        error instanceof Error ? error.message : error
    );
    process.exitCode = 1;
});
