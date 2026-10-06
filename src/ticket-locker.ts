export type SeatOption = {
    seat_name: string;
    short: string;
    seat_type_code: string;
    num: string;
    price: number;
};

export type TicketLeg = {
    train_no: string;
    start_train_code: string;
    start_date: string;
    arrive_date: string;
    start_time: string;
    arrive_time: string;
    lishi: string;
    from_station: string;
    to_station: string;
    from_station_telecode: string;
    to_station_telecode: string;
    prices: SeatOption[];
};

export type RawInterline = {
    lishi: string;
    start_time: string;
    start_date: string;
    arrive_date: string;
    arrive_time: string;
    from_station_name: string;
    middle_station_name: string;
    end_station_name: string;
    ticketList: TicketLeg[];
    same_station: boolean;
    wait_time: string;
};

export type PlanLeg = {
    trainCode: string;
    from: string;
    to: string;
    fromCode: string;
    toCode: string;
    departDate: string;
    arriveDate: string;
    departTime: string;
    arriveTime: string;
    seatName: string;
    seatCode: string;
    availability: string;
    price: number;
};

export type CandidatePlan = {
    id: string;
    kind: 'DIRECT' | 'INTERLINE';
    legs: PlanLeg[];
    departAt: string;
    arriveAt: string;
    durationMinutes: number;
    totalPrice: number;
    transfer?: {
        station: string;
        sameStation: boolean;
        waitTime: string;
    };
    executable: boolean;
    score: number;
};

export type PlanManifest = {
    schema: 'ticket-locker.plan.v1';
    createdAt: string;
    query: {
        date: string;
        from: string;
        to: string;
        requestedCount: number;
        seatPriority: string[];
    };
    plans: CandidatePlan[];
};

export type ArmedManifest = {
    schema: 'ticket-locker.arm.v1';
    createdAt: string;
    sourcePlanCreatedAt: string;
    authorizedPlanIds: string[];
    plans: CandidatePlan[];
    invariant: 'ONLY_AUTHORIZED_PLANS_MAY_SUBMIT';
};

const NO_TICKET = new Set(['无', '无票', '--', '']);
const ABUNDANT = new Set(['有', '充足']);

export function hasInventory(num: string): boolean {
    if (NO_TICKET.has(num)) return false;
    if (ABUNDANT.has(num)) return true;
    const n = Number(num);
    return Number.isFinite(n) && n > 0;
}

function parseDuration(value: string): number {
    const m = /^(\d+):(\d+)$/.exec(value);
    if (!m) return Number.MAX_SAFE_INTEGER;
    return Number(m[1]) * 60 + Number(m[2]);
}

function chooseSeat(
    seats: SeatOption[],
    seatPriority: string[]
): SeatOption | undefined {
    const available = seats.filter((x) => hasInventory(x.num));
    for (const preferred of seatPriority) {
        const found = available.find(
            (x) => x.seat_name === preferred || x.short === preferred
        );
        if (found) return found;
    }
    return available.sort((a, b) => a.price - b.price)[0];
}

function legFromTicket(
    leg: TicketLeg,
    seatPriority: string[]
): PlanLeg | undefined {
    const seat = chooseSeat(leg.prices ?? [], seatPriority);
    if (!seat) return undefined;
    return {
        trainCode: leg.start_train_code,
        from: leg.from_station,
        to: leg.to_station,
        fromCode: leg.from_station_telecode,
        toCode: leg.to_station_telecode,
        departDate: leg.start_date,
        arriveDate: leg.arrive_date,
        departTime: leg.start_time,
        arriveTime: leg.arrive_time,
        seatName: seat.seat_name,
        seatCode: seat.seat_type_code,
        availability: seat.num,
        price: Number(seat.price ?? 0),
    };
}

function planScore(durationMinutes: number, totalPrice: number): number {
    // V1 ranking: 1 minute ~= 0.8 yuan. Explicit and deterministic, not hidden ML.
    return durationMinutes * 0.8 + totalPrice;
}

export function buildDirectPlans(
    rows: TicketLeg[],
    seatPriority: string[]
): CandidatePlan[] {
    return rows
        .map<CandidatePlan | undefined>((row) => {
            const leg = legFromTicket(row, seatPriority);
            if (!leg) return undefined;
            const durationMinutes = parseDuration(row.lishi);
            const totalPrice = leg.price;
            return {
                id: '',
                kind: 'DIRECT',
                legs: [leg],
                departAt: `${leg.departDate}T${leg.departTime}`,
                arriveAt: `${leg.arriveDate}T${leg.arriveTime}`,
                durationMinutes,
                totalPrice,
                executable: true,
                score: planScore(durationMinutes, totalPrice),
            };
        })
        .filter((x): x is CandidatePlan => x !== undefined);
}

export function buildInterlinePlans(
    rows: RawInterline[],
    seatPriority: string[]
): CandidatePlan[] {
    return rows
        .map<CandidatePlan | undefined>((row) => {
            const legs = row.ticketList
                .map((leg) => legFromTicket(leg, seatPriority))
                .filter((x): x is PlanLeg => x !== undefined);
            if (legs.length !== row.ticketList.length || legs.length < 2) {
                return undefined;
            }
            const durationMinutes = parseDuration(row.lishi);
            const totalPrice = legs.reduce((sum, leg) => sum + leg.price, 0);
            return {
                id: '',
                kind: 'INTERLINE',
                legs,
                departAt: `${row.start_date}T${row.start_time}`,
                arriveAt: `${row.arrive_date}T${row.arrive_time}`,
                durationMinutes,
                totalPrice,
                transfer: {
                    station: row.middle_station_name,
                    sameStation: row.same_station,
                    waitTime: row.wait_time,
                },
                executable: true,
                score: planScore(durationMinutes, totalPrice),
            };
        })
        .filter((x): x is CandidatePlan => x !== undefined);
}

export function rankPlans(
    plans: CandidatePlan[],
    count: number
): CandidatePlan[] {
    const dedup = new Map<string, CandidatePlan>();
    for (const p of plans) {
        const key = p.legs
            .map((x) => `${x.trainCode}:${x.seatName}`)
            .join('>');
        const previous = dedup.get(key);
        if (!previous || p.score < previous.score) dedup.set(key, p);
    }
    return [...dedup.values()]
        .sort(
            (a, b) =>
                a.score - b.score ||
                a.durationMinutes - b.durationMinutes ||
                a.totalPrice - b.totalPrice
        )
        .slice(0, count)
        .map((p, i) => ({ ...p, id: `P${i + 1}` }));
}

export function armPlans(
    manifest: PlanManifest,
    orderedPlanIds: string[]
): ArmedManifest {
    if (orderedPlanIds.length === 0) {
        throw new Error('At least one plan must be explicitly authorized.');
    }
    const unique = [...new Set(orderedPlanIds)];
    if (unique.length !== orderedPlanIds.length) {
        throw new Error('Duplicate plan IDs are not allowed.');
    }
    const byId = new Map(manifest.plans.map((p) => [p.id, p]));
    const selected = unique.map((id) => {
        const plan = byId.get(id);
        if (!plan) throw new Error(`Unknown plan ID: ${id}`);
        if (!plan.executable) throw new Error(`Plan ${id} is not executable.`);
        return plan;
    });
    return {
        schema: 'ticket-locker.arm.v1',
        createdAt: new Date().toISOString(),
        sourcePlanCreatedAt: manifest.createdAt,
        authorizedPlanIds: unique,
        plans: selected,
        invariant: 'ONLY_AUTHORIZED_PLANS_MAY_SUBMIT',
    };
}

export function assertSubmitAuthorized(
    armed: ArmedManifest,
    planId: string
): CandidatePlan {
    const index = armed.authorizedPlanIds.indexOf(planId);
    if (index < 0) {
        throw new Error(`BLOCKED_UNAUTHORIZED_PLAN:${planId}`);
    }
    const plan = armed.plans.find((p) => p.id === planId);
    if (!plan) throw new Error(`ARM_MANIFEST_CORRUPT:${planId}`);
    return plan;
}

export function authorizedExecutionOrder(
    armed: ArmedManifest
): CandidatePlan[] {
    return armed.authorizedPlanIds.map((id) =>
        assertSubmitAuthorized(armed, id)
    );
}
