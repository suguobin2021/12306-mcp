import assert from 'node:assert/strict';
import { armPlans, assertSubmitAuthorized, hasInventory, } from './ticket-locker.js';
import { executeAuthorizedPlans, } from './ticket-locker-executor.js';
function plan(id, trainCode) {
    return {
        id,
        kind: 'DIRECT',
        legs: [
            {
                trainCode,
                from: 'A',
                to: 'B',
                fromCode: 'AAA',
                toCode: 'BBB',
                departDate: '2026-10-07',
                arriveDate: '2026-10-07',
                departTime: '10:00',
                arriveTime: '12:00',
                seatName: '二等座',
                seatCode: 'O',
                availability: '有',
                price: 100,
            },
        ],
        departAt: '2026-10-07T10:00',
        arriveAt: '2026-10-07T12:00',
        durationMinutes: 120,
        totalPrice: 100,
        executable: true,
        score: 196,
    };
}
async function main() {
    assert.equal(hasInventory('无'), false);
    assert.equal(hasInventory('0'), false);
    assert.equal(hasInventory('1'), true);
    assert.equal(hasInventory('有'), true);
    const manifest = {
        schema: 'ticket-locker.plan.v1',
        createdAt: '2026-10-06T00:00:00.000Z',
        query: {
            date: '2026-10-07',
            from: '吉安西',
            to: '昆山南',
            requestedCount: 5,
            seatPriority: ['二等座', '一等座'],
        },
        plans: [
            plan('P1', 'G1'),
            plan('P2', 'G2'),
            plan('P3', 'G3'),
            plan('P4', 'G4'),
            plan('P5', 'G5'),
        ],
    };
    const armed = armPlans(manifest, ['P1', 'P3', 'P2']);
    assert.deepEqual(armed.authorizedPlanIds, ['P1', 'P3', 'P2']);
    assert.equal(assertSubmitAuthorized(armed, 'P3').id, 'P3');
    assert.throws(() => assertSubmitAuthorized(armed, 'P4'), /BLOCKED_UNAUTHORIZED_PLAN:P4/);
    const calls = [];
    const adapter = {
        async submit(p) {
            calls.push(p.id);
            if (p.id === 'P1')
                return { status: 'HARD_FAIL' };
            if (p.id === 'P3') {
                return {
                    status: 'LOCKED',
                    orderId: 'ORDER-TEST',
                };
            }
            throw new Error('P2 must never be reached after LOCKED');
        },
    };
    const result = await executeAuthorizedPlans(armed, adapter, 0);
    assert.equal(result.terminal, 'LOCKED');
    assert.equal(result.lockedPlanId, 'P3');
    assert.equal(result.orderId, 'ORDER-TEST');
    assert.deepEqual(calls, ['P1', 'P3']);
    const queuedCalls = [];
    const queueAdapter = {
        async submit(p) {
            queuedCalls.push(p.id);
            return { status: 'QUEUED' };
        },
    };
    const queued = await executeAuthorizedPlans(armed, queueAdapter, 0);
    assert.equal(queued.terminal, 'QUEUED');
    assert.equal(queued.lockedPlanId, 'P1');
    assert.deepEqual(queuedCalls, ['P1']);
    console.log('SELFTEST PASS');
    console.log('UNAUTHORIZED BLOCK PASS');
    console.log('PRIORITY SERIALIZATION PASS');
    console.log('LOCK_STOPS_ALL PASS');
    console.log('QUEUE_STOPS_FALLBACK PASS');
}
main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
