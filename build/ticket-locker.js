const NO_TICKET = new Set(['无', '无票', '--', '']);
const ABUNDANT = new Set(['有', '充足']);
export function hasInventory(num) {
    if (NO_TICKET.has(num))
        return false;
    if (ABUNDANT.has(num))
        return true;
    const n = Number(num);
    return Number.isFinite(n) && n > 0;
}
function parseDuration(value) {
    const m = /^(\d+):(\d+)$/.exec(value);
    if (!m)
        return Number.MAX_SAFE_INTEGER;
    return Number(m[1]) * 60 + Number(m[2]);
}
function chooseSeat(seats, seatPriority) {
    const available = seats.filter((x) => hasInventory(x.num));
    for (const preferred of seatPriority) {
        const found = available.find((x) => x.seat_name === preferred || x.short === preferred);
        if (found)
            return found;
    }
    return available.sort((a, b) => a.price - b.price)[0];
}
function planLegFromSeat(leg, seat) {
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
function legFromTicket(leg, seatPriority) {
    const seat = chooseSeat(leg.prices ?? [], seatPriority);
    return seat ? planLegFromSeat(leg, seat) : undefined;
}
function chooseCommonInterlineSeats(legs, seatPriority) {
    if (legs.length < 2)
        return undefined;
    const availableByLeg = legs.map((leg) => (leg.prices ?? []).filter((seat) => hasInventory(seat.num)));
    if (availableByLeg.some((seats) => seats.length === 0)) {
        return undefined;
    }
    const commonCodes = new Set(availableByLeg[0]
        .map((seat) => seat.seat_type_code)
        .filter((code) => availableByLeg
        .slice(1)
        .every((seats) => seats.some((seat) => seat.seat_type_code === code))));
    if (commonCodes.size === 0)
        return undefined;
    let selectedCode;
    for (const preferred of seatPriority) {
        const match = availableByLeg[0].find((seat) => commonCodes.has(seat.seat_type_code) &&
            (seat.seat_name === preferred || seat.short === preferred));
        if (match) {
            selectedCode = match.seat_type_code;
            break;
        }
    }
    if (!selectedCode) {
        selectedCode = [...commonCodes]
            .map((code) => ({
            code,
            total: availableByLeg.reduce((sum, seats) => {
                const seat = seats.find((candidate) => candidate.seat_type_code === code);
                return sum + Number(seat?.price ?? Number.MAX_SAFE_INTEGER);
            }, 0),
        }))
            .sort((a, b) => a.total - b.total)[0]?.code;
    }
    if (!selectedCode)
        return undefined;
    const selected = availableByLeg.map((seats) => seats.find((seat) => seat.seat_type_code === selectedCode));
    if (selected.some((seat) => !seat))
        return undefined;
    return selected;
}
function planScore(durationMinutes, totalPrice) {
    // V1 ranking: 1 minute ~= 0.8 yuan. Explicit and deterministic, not hidden ML.
    return durationMinutes * 0.8 + totalPrice;
}
export function buildDirectPlans(rows, seatPriority) {
    return rows
        .map((row) => {
        const leg = legFromTicket(row, seatPriority);
        if (!leg)
            return undefined;
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
        .filter((x) => x !== undefined);
}
export function buildInterlinePlans(rows, seatPriority) {
    return rows
        .map((row) => {
        const commonSeats = chooseCommonInterlineSeats(row.ticketList, seatPriority);
        if (!commonSeats)
            return undefined;
        const legs = row.ticketList.map((leg, index) => planLegFromSeat(leg, commonSeats[index]));
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
        .filter((x) => x !== undefined);
}
export function rankPlans(plans, count) {
    const dedup = new Map();
    for (const p of plans) {
        const key = p.legs
            .map((x) => `${x.trainCode}:${x.seatName}`)
            .join('>');
        const previous = dedup.get(key);
        if (!previous || p.score < previous.score)
            dedup.set(key, p);
    }
    return [...dedup.values()]
        .sort((a, b) => a.score - b.score ||
        a.durationMinutes - b.durationMinutes ||
        a.totalPrice - b.totalPrice)
        .slice(0, count)
        .map((p, i) => ({ ...p, id: `P${i + 1}` }));
}
export function armPlans(manifest, orderedPlanIds) {
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
        if (!plan)
            throw new Error(`Unknown plan ID: ${id}`);
        if (!plan.executable)
            throw new Error(`Plan ${id} is not executable.`);
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
export function assertSubmitAuthorized(armed, planId) {
    const index = armed.authorizedPlanIds.indexOf(planId);
    if (index < 0) {
        throw new Error(`BLOCKED_UNAUTHORIZED_PLAN:${planId}`);
    }
    const plan = armed.plans.find((p) => p.id === planId);
    if (!plan)
        throw new Error(`ARM_MANIFEST_CORRUPT:${planId}`);
    return plan;
}
export function authorizedExecutionOrder(armed) {
    return armed.authorizedPlanIds.map((id) => assertSubmitAuthorized(armed, id));
}
