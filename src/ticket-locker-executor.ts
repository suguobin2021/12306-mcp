import {
    ArmedManifest,
    CandidatePlan,
    assertSubmitAuthorized,
} from './ticket-locker.js';

export type SubmitStatus =
    | 'HARD_FAIL'
    | 'RETRYABLE_FAIL'
    | 'QUEUED'
    | 'LOCKED'
    | 'NEED_HUMAN';

export type SubmitResult = {
    status: SubmitStatus;
    detail?: string;
    orderId?: string;
};

export interface BookingAdapter {
    submit(plan: CandidatePlan): Promise<SubmitResult>;
}

export type ExecutionEvent = {
    at: string;
    planId: string;
    attempt: number;
    status: SubmitStatus;
    detail?: string;
};

export type ExecutionResult = {
    terminal:
        | 'LOCKED'
        | 'QUEUED'
        | 'NEED_HUMAN'
        | 'EXHAUSTED';
    lockedPlanId?: string;
    orderId?: string;
    events: ExecutionEvent[];
};

export async function executeAuthorizedPlans(
    armed: ArmedManifest,
    adapter: BookingAdapter,
    maxRetryPerPlan = 1
): Promise<ExecutionResult> {
    const events: ExecutionEvent[] = [];

    for (const planId of armed.authorizedPlanIds) {
        const plan = assertSubmitAuthorized(armed, planId);

        for (let attempt = 1; attempt <= maxRetryPerPlan + 1; attempt++) {
            const result = await adapter.submit(plan);
            events.push({
                at: new Date().toISOString(),
                planId,
                attempt,
                status: result.status,
                detail: result.detail,
            });

            if (result.status === 'LOCKED') {
                return {
                    terminal: 'LOCKED',
                    lockedPlanId: planId,
                    orderId: result.orderId,
                    events,
                };
            }

            // Entering the 12306 queue is already a submission state.
            // Never race a lower-priority plan while the higher-priority
            // plan may still obtain a seat.
            if (result.status === 'QUEUED') {
                return {
                    terminal: 'QUEUED',
                    lockedPlanId: planId,
                    events,
                };
            }

            if (result.status === 'NEED_HUMAN') {
                return {
                    terminal: 'NEED_HUMAN',
                    lockedPlanId: planId,
                    events,
                };
            }

            if (result.status === 'HARD_FAIL') break;
            if (attempt > maxRetryPerPlan) break;
        }
    }

    return { terminal: 'EXHAUSTED', events };
}
