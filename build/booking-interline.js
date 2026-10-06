import { Buffer } from 'node:buffer';
import { assertSubmitAuthorized, } from './ticket-locker.js';
import { fetchPassengers, selectPassengersByIndex, } from './booking-passenger.js';
const SEAT_FIELD_BY_CODE = {
    '9': 'swz_num',
    P: 'tz_num',
    D: 'gg_num',
    M: 'zy_num',
    O: 'ze_num',
    '6': 'gr_num',
    '4': 'rw_num',
    F: 'srrb_num',
    '3': 'yw_num',
    '2': 'rz_num',
    '1': 'yz_num',
    W: 'wz_num',
    WZ: 'wz_num',
};
function seatAvailable(value) {
    const text = String(value ?? '');
    if (!text || ['无', '--', '0', '*'].includes(text))
        return false;
    if (['有', '充足'].includes(text))
        return true;
    const n = Number(text);
    return Number.isFinite(n) && n > 0;
}
function messageFromResponse(data) {
    const parts = [];
    if (typeof data?.data?.errMsg === 'string')
        parts.push(data.data.errMsg);
    if (typeof data?.data?.msg === 'string')
        parts.push(data.data.msg);
    if (Array.isArray(data?.messages))
        parts.push(...data.messages.map(String));
    return parts.filter(Boolean).join(' | ');
}
function isVerificationMessage(value) {
    return /验证码|核验|验证|人证|滑块|二维码|身份核验|手机核验/.test(value);
}
function pick(html, patterns, name) {
    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match?.[1] !== undefined) {
            return match[1].trim().replace(/^['"]|['"]$/g, '');
        }
    }
    throw new Error(`INIT_LC_FIELD_MISSING:${name}`);
}
export function parseInitLc(html) {
    const repeatSubmitToken = pick(html, [
        /globalRepeatSubmitToken\s*=\s*'([^']+)'/,
        /globalRepeatSubmitToken\s*=\s*"([^"]+)"/,
        /globalRepeatSubmitToken\s*=\s*([^;\s]+)/,
    ], 'repeatSubmitToken');
    const keyCheckIsChange = pick(html, [
        /['"]key_check_isChange['"]\s*:\s*['"]([^'"]+)['"]/,
        /key_check_isChange\s*=\s*'([^']+)'/,
        /key_check_isChange\s*=\s*([^;\s]+)/,
    ], 'keyCheckIsChange');
    let purposeCodes = '00';
    for (const pattern of [
        /['"]purpose_codes['"]\s*:\s*['"]([^'"]+)['"]/,
        /purpose_codes\s*=\s*'([^']+)'/,
    ]) {
        const match = html.match(pattern);
        if (match?.[1]) {
            purposeCodes = match[1];
            break;
        }
    }
    if (repeatSubmitToken.toLowerCase() === 'null') {
        throw new Error('INIT_LC_NULL_REPEAT_TOKEN');
    }
    if (keyCheckIsChange.toLowerCase() === 'null') {
        throw new Error('INIT_LC_NULL_KEY_CHECK');
    }
    return { repeatSubmitToken, keyCheckIsChange, purposeCodes };
}
export function decodeLcSecretLegs(secret) {
    const encoded = decodeURIComponent(String(secret ?? '').trim());
    if (!encoded)
        throw new Error('LC_SECRET_EMPTY');
    const padded = encoded + '='.repeat((4 - (encoded.length % 4)) % 4);
    const decoded = Buffer.from(padded, 'base64').toString('utf8');
    const legs = [];
    for (const chunk of decoded.split('#:::')) {
        const fields = chunk.split('#');
        if (fields.length < 15)
            continue;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(fields[0]))
            continue;
        if (!fields[5])
            continue;
        legs.push({
            trainDate: fields[0].replaceAll('-', ''),
            trainCode: String(fields[2] ?? '').trim(),
            trainNo: String(fields[5] ?? '').trim(),
            fromCode: String(fields[6] ?? '').trim(),
            toCode: String(fields[7] ?? '').trim(),
            fromName: String(fields[9] ?? '').trim(),
            toName: String(fields[10] ?? '').trim(),
            leftTicketStr: String(fields[13] ?? '').trim(),
            trainLocation: String(fields[14] ?? '').trim(),
        });
    }
    if (legs.length < 2)
        throw new Error('LC_SECRET_LEGS_INVALID');
    return legs;
}
export function buildLcPassengerTicketStr(passengers) {
    return passengers
        .map((p) => [
        '',
        '0',
        p.passenger_type || '1',
        p.passenger_name,
        p.passenger_id_type_code,
        p.passenger_id_no,
        p.mobile_no ?? p.phone_no ?? '',
        'N',
        p.allEncStr ?? '',
    ].join(','))
        .join('_');
}
export function buildLcOldPassengerStr(legs, seatCode, seatName) {
    return legs
        .map((leg) => `${leg.trainCode},${seatCode},${seatName},${leg.trainDate},${leg.fromCode},${leg.toCode}#`)
        .join('');
}
export function buildLcQueueDataStr(legs, seatCode, seatName, purposeCodes) {
    return legs
        .map((leg) => [
        leg.trainDate,
        leg.trainNo,
        leg.trainCode,
        seatCode,
        leg.fromCode,
        leg.toCode,
        leg.leftTicketStr,
        purposeCodes,
        seatName,
        leg.trainLocation,
    ].join('|'))
        .join('#');
}
export function buildLcChooseSeats(legs) {
    return legs.map((leg) => `${leg.trainCode}_*#`).join('');
}
async function discoverLcQueryPath(session) {
    const response = await session.client.get('/otn/lcQuery/init');
    const match = response.data.match(/ var lc_search_url = '(.+?)'/);
    if (!match)
        throw new Error('LC_QUERY_PATH_NOT_FOUND');
    return match[1];
}
function rowMatchesPlan(row, plan) {
    const full = Array.isArray(row.fullList) ? row.fullList : [];
    if (full.length !== plan.legs.length)
        return false;
    return plan.legs.every((leg, i) => {
        const raw = full[i] ?? {};
        return (raw.station_train_code === leg.trainCode &&
            raw.from_station_telecode === leg.fromCode &&
            raw.to_station_telecode === leg.toCode);
    });
}
function rowHasSeat(row, plan) {
    const code = plan.legs[0]?.seatCode;
    if (!code)
        return false;
    if (!plan.legs.every((leg) => leg.seatCode === code))
        return false;
    const field = SEAT_FIELD_BY_CODE[code];
    if (!field)
        return false;
    const full = Array.isArray(row.fullList) ? row.fullList : [];
    return full.length === plan.legs.length &&
        full.every((leg) => seatAvailable(leg[field]));
}
async function queryLiveLcRow(session, plan) {
    const queryPath = await discoverLcQueryPath(session);
    let resultIndex = 0;
    let canQuery = 'Y';
    for (let page = 0; page < 8; page++) {
        const response = await session.client.get(queryPath, {
            params: {
                train_date: plan.legs[0].departDate,
                from_station_telecode: plan.legs[0].fromCode,
                to_station_telecode: plan.legs.at(-1)?.toCode ?? '',
                middle_station: '',
                result_index: String(resultIndex),
                can_query: canQuery,
                isShowWZ: 'Y',
                purpose_codes: '00',
                channel: 'E',
            },
            headers: {
                referer: 'https://kyfw.12306.cn/otn/lcQuery/init',
                'if-modified-since': '0',
                'cache-control': 'no-cache',
            },
        });
        const data = response.data?.data;
        const rows = Array.isArray(data?.middleList)
            ? data.middleList
            : [];
        const matched = rows.find((row) => rowMatchesPlan(row, plan) && rowHasSeat(row, plan));
        if (matched)
            return matched;
        if (String(data?.can_query) === 'N')
            break;
        const next = Number(data?.result_index);
        if (!Number.isFinite(next) || next === resultIndex)
            break;
        resultIndex = next;
        canQuery = String(data?.can_query ?? 'Y');
    }
    throw new Error(`LIVE_LC_PLAN_NOT_AVAILABLE:${plan.id}`);
}
async function submitLcRequest(session, plan, raw) {
    if (!(await session.checkUser())) {
        throw new Error('SESSION_NOT_LOGGED_IN');
    }
    const secretStr = String(raw.scretstr ?? raw.secretStr ?? '').trim();
    if (!secretStr)
        throw new Error('LC_SECRET_MISSING');
    const response = await session.client.post('/otn/lcQuery/submitOrderRequest', new URLSearchParams({
        secretStr: decodeURIComponent(secretStr),
        train_date: 'undefined',
        back_train_date: 'undefined',
        tour_flag: 'lc',
        purpose_codes: 'ADULT',
        query_from_station_name: String(raw.from_station_name ?? plan.legs[0].from),
        query_to_station_name: String(raw.end_station_name ?? plan.legs.at(-1)?.to ?? ''),
    }), {
        headers: {
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            referer: 'https://kyfw.12306.cn/otn/lcQuery/init',
        },
    });
    if (!response.data?.status) {
        throw new Error(`LC_SUBMIT_REQUEST_FAILED:${messageFromResponse(response.data)}`);
    }
    const initResponse = await session.client.post('/otn/lcConfirmPassenger/initLc', new URLSearchParams({ _json_att: '' }), {
        headers: {
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            referer: 'https://kyfw.12306.cn/otn/lcQuery/init',
        },
    });
    if (typeof initResponse.data !== 'string') {
        throw new Error('INIT_LC_INVALID_RESPONSE');
    }
    return { secretStr, init: parseInitLc(initResponse.data) };
}
export async function prepareInterlineOrder(session, armed, planId, passengerIndexes) {
    const plan = assertSubmitAuthorized(armed, planId);
    if (plan.kind !== 'INTERLINE' || plan.legs.length < 2) {
        throw new Error(`INTERLINE_ADAPTER_REJECTS_DIRECT:${planId}`);
    }
    const seatCode = plan.legs[0].seatCode;
    const seatName = plan.legs[0].seatName;
    if (!plan.legs.every((leg) => leg.seatCode === seatCode)) {
        throw new Error(`INTERLINE_MIXED_SEAT_BLOCKED:${planId}`);
    }
    const raw = await queryLiveLcRow(session, plan);
    const { secretStr, init } = await submitLcRequest(session, plan, raw);
    const secretLegs = decodeLcSecretLegs(secretStr);
    const allPassengers = await fetchPassengers(session, init.repeatSubmitToken, '/otn/lcConfirmPassenger/initLc');
    const passengers = selectPassengersByIndex(allPassengers, passengerIndexes);
    return {
        planId,
        plan,
        raw,
        secretStr,
        secretLegs,
        init,
        passengers,
        passengerTicketStr: buildLcPassengerTicketStr(passengers),
        oldPassengerStr: buildLcOldPassengerStr(secretLegs, seatCode, seatName),
        queueDataStr: buildLcQueueDataStr(secretLegs, seatCode, seatName, init.purposeCodes),
        chooseSeats: buildLcChooseSeats(secretLegs),
        seatCode,
        seatName,
    };
}
async function checkLcOrder(session, prepared) {
    const response = await session.client.post('/otn/lcConfirmPassenger/checkOrderInfo', new URLSearchParams({
        cancel_flag: '2',
        bed_level_order_num: '000000000000000000000000000000',
        passengerTicketStr: prepared.passengerTicketStr,
        oldPassengerStr: prepared.oldPassengerStr,
        tour_flag: 'lc',
        sessionId: '',
        sig: '',
        scene: 'nc_login',
        _json_att: '',
        REPEAT_SUBMIT_TOKEN: prepared.init.repeatSubmitToken,
    }), {
        headers: {
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            referer: 'https://kyfw.12306.cn/otn/lcConfirmPassenger/initLc',
        },
    });
    const message = messageFromResponse(response.data);
    if (!response.data?.status || response.data?.data?.submitStatus === false) {
        if (isVerificationMessage(message)) {
            return { status: 'NEED_HUMAN', detail: message };
        }
        return {
            status: 'HARD_FAIL',
            detail: message || 'lc checkOrderInfo rejected the order',
        };
    }
    return null;
}
async function checkLcQueue(session, prepared) {
    const response = await session.client.post('/otn/lcConfirmPassenger/getQueueCount', new URLSearchParams({
        dataStr: prepared.queueDataStr,
        _json_att: '',
        REPEAT_SUBMIT_TOKEN: prepared.init.repeatSubmitToken,
    }), {
        headers: {
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            referer: 'https://kyfw.12306.cn/otn/lcConfirmPassenger/initLc',
        },
    });
    if (!response.data?.status) {
        return {
            status: 'RETRYABLE_FAIL',
            detail: messageFromResponse(response.data) ||
                'lc getQueueCount failed',
        };
    }
    return null;
}
async function enqueueLc(session, prepared) {
    const first = prepared.secretLegs[0];
    const response = await session.client.post('/otn/lcConfirmPassenger/confirmLCForQueue', new URLSearchParams({
        passengerTicketStr: prepared.passengerTicketStr,
        oldPassengerStr: prepared.oldPassengerStr,
        purpose_codes: prepared.init.purposeCodes,
        key_check_isChange: prepared.init.keyCheckIsChange,
        leftTicketStr: first.leftTicketStr,
        train_location: first.trainLocation,
        choose_seats: prepared.chooseSeats,
        is_jy: 'N',
        is_cj: 'N',
        encryptedData: '',
        seatDetailType: prepared.chooseSeats,
        roomType: '00',
        _json_att: '',
        REPEAT_SUBMIT_TOKEN: prepared.init.repeatSubmitToken,
    }), {
        headers: {
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            referer: 'https://kyfw.12306.cn/otn/lcConfirmPassenger/initLc',
        },
    });
    const message = messageFromResponse(response.data);
    if (!response.data?.status || !response.data?.data?.submitStatus) {
        if (isVerificationMessage(message)) {
            return { status: 'NEED_HUMAN', detail: message };
        }
        return {
            status: 'HARD_FAIL',
            detail: message || '12306 rejected interline queue submission',
        };
    }
    return { status: 'QUEUED', detail: '12306 accepted interline queue' };
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForLcLock(session, prepared, intervalMs, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const response = await session.client.get('/otn/confirmPassenger/queryOrderWaitTime', {
            params: {
                random: Date.now(),
                tourFlag: 'lc',
                _json_att: '',
                REPEAT_SUBMIT_TOKEN: prepared.init.repeatSubmitToken,
            },
            headers: {
                referer: 'https://kyfw.12306.cn/otn/lcConfirmPassenger/initLc',
            },
        });
        const message = messageFromResponse(response.data);
        const data = response.data?.data;
        if (!response.data?.status || !data) {
            if (isVerificationMessage(message)) {
                return { status: 'NEED_HUMAN', detail: message };
            }
            await sleep(intervalMs);
            continue;
        }
        if (data.msg) {
            return { status: 'HARD_FAIL', detail: String(data.msg) };
        }
        const orderId = String(data.orderId ?? data.order_id ?? '').trim();
        if (orderId) {
            return {
                status: 'LOCKED',
                orderId,
                detail: 'Interline pending-payment order created',
            };
        }
        await sleep(intervalMs);
    }
    return {
        status: 'RETRYABLE_FAIL',
        detail: 'Interline queue timed out without an order id',
    };
}
export class Interline12306BookingAdapter {
    session;
    armed;
    options;
    constructor(session, armed, options) {
        this.session = session;
        this.armed = armed;
        this.options = options;
        if (options.permit !== 'ARMED_USER_APPROVED') {
            throw new Error('MISSING_EXECUTION_PERMIT');
        }
    }
    async submit(plan) {
        assertSubmitAuthorized(this.armed, plan.id);
        if (plan.kind !== 'INTERLINE') {
            return {
                status: 'HARD_FAIL',
                detail: `DIRECT_REQUIRES_DIRECT_ADAPTER:${plan.id}`,
            };
        }
        let prepared;
        try {
            prepared = await prepareInterlineOrder(this.session, this.armed, plan.id, this.options.passengerIndexes);
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            if (isVerificationMessage(detail) || /SESSION_/.test(detail)) {
                return { status: 'NEED_HUMAN', detail };
            }
            if (/LIVE_LC_PLAN_NOT_AVAILABLE|INTERLINE_MIXED_SEAT_BLOCKED/.test(detail)) {
                return { status: 'HARD_FAIL', detail };
            }
            return { status: 'RETRYABLE_FAIL', detail };
        }
        const checked = await checkLcOrder(this.session, prepared);
        if (checked)
            return checked;
        const queue = await checkLcQueue(this.session, prepared);
        if (queue)
            return queue;
        const queued = await enqueueLc(this.session, prepared);
        if (queued.status !== 'QUEUED')
            return queued;
        return waitForLcLock(this.session, prepared, this.options.queuePollIntervalMs ?? 1000, this.options.queueTimeoutMs ?? 120000);
    }
}
