import { RailSession } from './booking-session.js';
import {
    LiveLegMatch,
    queryLiveLeg,
} from './booking-query.js';
import {
    PassengerDTO,
    buildPassengerStrings,
    fetchPassengers,
    selectPassengersByIndex,
} from './booking-passenger.js';
import {
    ArmedManifest,
    CandidatePlan,
    PlanLeg,
    assertSubmitAuthorized,
} from './ticket-locker.js';
import {
    BookingAdapter,
    SubmitResult,
} from './ticket-locker-executor.js';
import { TicketData } from './types.js';

export type DirectInitContext = {
    repeatSubmitToken: string;
    keyCheckIsChange: string;
    leftTicketStr: string;
    trainLocation: string;
    purposeCodes: string;
};

export type PreparedDirectOrder = {
    planId: string;
    plan: CandidatePlan;
    leg: PlanLeg;
    live: LiveLegMatch;
    init: DirectInitContext;
    passengers: PassengerDTO[];
    passengerTicketStr: string;
    oldPassengerStr: string;
    submissionSeatCode: string;
};

export type DirectBookingOptions = {
    passengerIndexes: number[];
    permit: 'ARMED_USER_APPROVED';
    queuePollIntervalMs?: number;
    queueTimeoutMs?: number;
};

type QueueWaitData = {
    waitTime?: number;
    errorcode?: string;
    msg?: string;
    orderId?: string | null;
};

function pick(html: string, patterns: RegExp[], name: string): string {
    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match?.[1] !== undefined) return match[1];
    }
    throw new Error(`INIT_DC_FIELD_MISSING:${name}`);
}

export function parseInitDc(html: string): DirectInitContext {
    return {
        repeatSubmitToken: pick(
            html,
            [
                /var\s+globalRepeatSubmitToken\s*=\s*'([^']+)'/,
                /"globalRepeatSubmitToken"\s*:\s*"([^"]+)"/,
            ],
            'repeatSubmitToken'
        ),
        keyCheckIsChange: pick(
            html,
            [
                /['"]key_check_isChange['"]\s*:\s*['"]([^'"]+)['"]/,
            ],
            'keyCheckIsChange'
        ),
        leftTicketStr: pick(
            html,
            [
                /['"]leftTicketStr['"]\s*:\s*['"]([^'"]*)['"]/,
                /['"]left_ticket_str['"]\s*:\s*['"]([^'"]*)['"]/,
            ],
            'leftTicketStr'
        ),
        trainLocation: pick(
            html,
            [
                /['"]train_location['"]\s*:\s*['"]([^'"]*)['"]/,
            ],
            'trainLocation'
        ),
        purposeCodes: pick(
            html,
            [
                /['"]purpose_codes['"]\s*:\s*['"]([^'"]+)['"]/,
            ],
            'purposeCodes'
        ),
    };
}

export function decodeSecretStr(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

function isVerificationMessage(value: string): boolean {
    return /验证码|核验|验证|人证|滑块|二维码|身份核验|手机核验/.test(value);
}

function messageFromResponse(data: any): string {
    const parts: string[] = [];
    if (typeof data?.data?.errMsg === 'string') parts.push(data.data.errMsg);
    if (typeof data?.data?.msg === 'string') parts.push(data.data.msg);
    if (Array.isArray(data?.messages)) parts.push(...data.messages.map(String));
    return parts.filter(Boolean).join(' | ');
}

export function resolveSubmissionSeatCode(
    ticket: TicketData,
    requestedSeatCode: string
): string {
    if (!['W', 'WZ'].includes(requestedSeatCode)) {
        return requestedSeatCode;
    }
    if (
        ticket.yz_num !== '--' &&
        ticket.yz_num !== '' &&
        ticket.yz_num !== '无'
    ) {
        return '1';
    }
    if (
        ticket.ze_num !== '--' &&
        ticket.ze_num !== '' &&
        ticket.ze_num !== '无'
    ) {
        return 'O';
    }
    return requestedSeatCode;
}

function formatChinaTrainDate(yyyyMmDd: string): string {
    const [year, month, day] = yyyyMmDd.split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = [
        'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ];
    return `${weekdays[date.getUTCDay()]} ${months[month - 1]} ${String(
        day
    ).padStart(2, '0')} ${year} 00:00:00 GMT+0800 (China Standard Time)`;
}

async function submitOrderRequest(
    session: RailSession,
    leg: PlanLeg,
    live: LiveLegMatch
): Promise<DirectInitContext> {
    if (!(await session.checkUser())) {
        throw new Error('SESSION_NOT_LOGGED_IN');
    }

    const body = new URLSearchParams({
        secretStr: decodeSecretStr(live.ticket.secret_Sstr),
        train_date: leg.departDate,
        back_train_date: leg.departDate,
        tour_flag: 'dc',
        purpose_codes: 'ADULT',
        query_from_station_name: leg.from,
        query_to_station_name: leg.to,
        bed_level_info: live.ticket.bed_level_info ?? '',
        seat_discount_info: live.ticket.seat_discount_info ?? '',
        undefined: '',
    });

    const response = await session.client.post(
        '/otn/leftTicket/submitOrderRequest',
        body,
        {
            headers: {
                'content-type':
                    'application/x-www-form-urlencoded; charset=UTF-8',
                referer: 'https://kyfw.12306.cn/otn/leftTicket/init',
            },
        }
    );
    if (!response.data?.status) {
        throw new Error(
            `SUBMIT_ORDER_REQUEST_FAILED:${messageFromResponse(response.data)}`
        );
    }

    const initResponse = await session.client.post<string>(
        '/otn/confirmPassenger/initDc',
        new URLSearchParams({ _json_att: '' }),
        {
            headers: {
                'content-type':
                    'application/x-www-form-urlencoded; charset=UTF-8',
                referer: 'https://kyfw.12306.cn/otn/leftTicket/init',
            },
        }
    );
    if (typeof initResponse.data !== 'string') {
        throw new Error('INIT_DC_INVALID_RESPONSE');
    }
    return parseInitDc(initResponse.data);
}

export async function prepareDirectOrder(
    session: RailSession,
    armed: ArmedManifest,
    planId: string,
    passengerIndexes: number[]
): Promise<PreparedDirectOrder> {
    const plan = assertSubmitAuthorized(armed, planId);
    if (plan.kind !== 'DIRECT' || plan.legs.length !== 1) {
        throw new Error(`DIRECT_ADAPTER_REJECTS_INTERLINE:${planId}`);
    }

    const leg = plan.legs[0];
    const live = await queryLiveLeg(session, leg);
    if (!live.available) {
        throw new Error(
            `LIVE_PRECHECK_NO_INVENTORY:${leg.trainCode}:${leg.seatName}:${live.seatRaw}`
        );
    }

    const init = await submitOrderRequest(session, leg, live);
    const allPassengers = await fetchPassengers(
        session,
        init.repeatSubmitToken
    );
    const passengers = selectPassengersByIndex(
        allPassengers,
        passengerIndexes
    );
    const submissionSeatCode = resolveSubmissionSeatCode(
        live.ticket,
        leg.seatCode
    );
    const strings = buildPassengerStrings(
        passengers,
        submissionSeatCode
    );

    return {
        planId,
        plan,
        leg,
        live,
        init,
        passengers,
        passengerTicketStr: strings.passengerTicketStr,
        oldPassengerStr: strings.oldPassengerStr,
        submissionSeatCode,
    };
}

export async function checkDirectOrderInfo(
    session: RailSession,
    prepared: PreparedDirectOrder
): Promise<SubmitResult | null> {
    const response = await session.client.post(
        '/otn/confirmPassenger/checkOrderInfo',
        new URLSearchParams({
            cancel_flag: '2',
            bed_level_order_num: '000000000000000000000000000000',
            passengerTicketStr: prepared.passengerTicketStr,
            oldPassengerStr: prepared.oldPassengerStr,
            tour_flag: 'dc',
            randCode: '',
            whatsSelect: '1',
            sessionId: '',
            sig: '',
            scene: 'nc_login',
            _json_att: '',
            REPEAT_SUBMIT_TOKEN:
                prepared.init.repeatSubmitToken,
        }),
        {
            headers: {
                'content-type':
                    'application/x-www-form-urlencoded; charset=UTF-8',
                referer:
                    'https://kyfw.12306.cn/otn/confirmPassenger/initDc',
            },
        }
    );

    const message = messageFromResponse(response.data);
    if (!response.data?.status || response.data?.data?.submitStatus === false) {
        if (isVerificationMessage(message)) {
            return { status: 'NEED_HUMAN', detail: message };
        }
        return {
            status: 'HARD_FAIL',
            detail: message || 'checkOrderInfo rejected the order',
        };
    }

    const showPassCode =
        response.data?.data?.ifShowPassCode ??
        response.data?.data?.if_show_pass_code;
    if (showPassCode === 'Y' || showPassCode === true) {
        return {
            status: 'NEED_HUMAN',
            detail: '12306 requested human verification',
        };
    }
    return null;
}

export async function checkDirectQueueCapacity(
    session: RailSession,
    prepared: PreparedDirectOrder
): Promise<SubmitResult | null> {
    const ticket = prepared.live.ticket;
    const response = await session.client.post(
        '/otn/confirmPassenger/getQueueCountAsync',
        new URLSearchParams({
            train_date: formatChinaTrainDate(prepared.leg.departDate),
            train_no: ticket.train_no,
            stationTrainCode: ticket.station_train_code,
            seatType: prepared.submissionSeatCode,
            fromStationTelecode: ticket.from_station_telecode,
            toStationTelecode: ticket.to_station_telecode,
            leftTicket: prepared.init.leftTicketStr,
            purpose_codes: prepared.init.purposeCodes,
            isCheckOrderInfo: '',
            _json_att: '',
            REPEAT_SUBMIT_TOKEN:
                prepared.init.repeatSubmitToken,
        }),
        {
            headers: {
                'content-type':
                    'application/x-www-form-urlencoded; charset=UTF-8',
                referer:
                    'https://kyfw.12306.cn/otn/confirmPassenger/initDc',
            },
        }
    );

    const message = messageFromResponse(response.data);
    if (!response.data?.status) {
        return {
            status: 'RETRYABLE_FAIL',
            detail: message || 'getQueueCountAsync failed',
        };
    }
    if (response.data?.data?.isRelogin === 'Y') {
        return {
            status: 'NEED_HUMAN',
            detail: '12306 session requires re-login',
        };
    }
    if (String(response.data?.data?.op_2) === 'true') {
        return {
            status: 'HARD_FAIL',
            detail: '12306 queue already exceeds available inventory',
        };
    }
    return null;
}

export async function enqueueDirectOrder(
    session: RailSession,
    prepared: PreparedDirectOrder
): Promise<SubmitResult> {
    const response = await session.client.post(
        '/otn/confirmPassenger/confirmSingleForQueueAsys',
        new URLSearchParams({
            passengerTicketStr: prepared.passengerTicketStr,
            oldPassengerStr: prepared.oldPassengerStr,
            randCode: '',
            purpose_codes: prepared.init.purposeCodes,
            key_check_isChange: prepared.init.keyCheckIsChange,
            leftTicketStr: prepared.init.leftTicketStr,
            train_location: prepared.init.trainLocation,
            choose_seats: '',
            seatDetailType: '000',
            _json_att: '',
            REPEAT_SUBMIT_TOKEN:
                prepared.init.repeatSubmitToken,
        }),
        {
            headers: {
                'content-type':
                    'application/x-www-form-urlencoded; charset=UTF-8',
                referer:
                    'https://kyfw.12306.cn/otn/confirmPassenger/initDc',
            },
        }
    );

    const message = messageFromResponse(response.data);
    if (!response.data?.status || !response.data?.data?.submitStatus) {
        if (isVerificationMessage(message)) {
            return { status: 'NEED_HUMAN', detail: message };
        }
        return {
            status: 'HARD_FAIL',
            detail: message || '12306 rejected queue submission',
        };
    }
    return {
        status: 'QUEUED',
        detail: '12306 accepted queue submission',
    };
}

export function classifyQueueWait(data: QueueWaitData): {
    state: 'WAIT' | 'ORDER_ID' | 'FAIL';
    orderId?: string;
    detail?: string;
} {
    if (data.orderId && (data.waitTime === -1 || data.waitTime === -100)) {
        return { state: 'ORDER_ID', orderId: data.orderId };
    }
    if (
        data.waitTime === -2 ||
        (typeof data.errorcode === 'string' && data.errorcode !== '')
    ) {
        return {
            state: 'FAIL',
            detail: data.msg || data.errorcode || 'queue failed',
        };
    }
    return {
        state: 'WAIT',
        detail:
            typeof data.waitTime === 'number'
                ? `waitTime=${data.waitTime}`
                : 'waiting',
    };
}

const sleep = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms));

export async function waitForDirectLock(
    session: RailSession,
    prepared: PreparedDirectOrder,
    intervalMs = 1000,
    timeoutMs = 120000
): Promise<SubmitResult> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        const response = await session.client.get(
            '/otn/confirmPassenger/queryOrderWaitTime',
            {
                params: {
                    random: Date.now(),
                    tourFlag: 'dc',
                    _json_att: '',
                    REPEAT_SUBMIT_TOKEN:
                        prepared.init.repeatSubmitToken,
                },
                headers: {
                    referer:
                        'https://kyfw.12306.cn/otn/confirmPassenger/initDc',
                },
            }
        );

        const data = response.data?.data as QueueWaitData | undefined;
        const message = messageFromResponse(response.data);
        if (!response.data?.status || !data) {
            if (isVerificationMessage(message)) {
                return { status: 'NEED_HUMAN', detail: message };
            }
            await sleep(intervalMs);
            continue;
        }

        const classified = classifyQueueWait(data);
        if (classified.state === 'FAIL') {
            return {
                status: 'HARD_FAIL',
                detail: classified.detail,
            };
        }

        if (classified.state === 'ORDER_ID' && classified.orderId) {
            const result = await session.client.post(
                '/otn/confirmPassenger/resultOrderForDcQueue',
                new URLSearchParams({
                    orderSequence_no: classified.orderId,
                    _json_att: '',
                    REPEAT_SUBMIT_TOKEN:
                        prepared.init.repeatSubmitToken,
                }),
                {
                    headers: {
                        'content-type':
                            'application/x-www-form-urlencoded; charset=UTF-8',
                        referer:
                            'https://kyfw.12306.cn/otn/confirmPassenger/initDc',
                    },
                }
            );

            if (result.data?.status && result.data?.data?.submitStatus) {
                return {
                    status: 'LOCKED',
                    orderId: classified.orderId,
                    detail: 'Pending-payment order created',
                };
            }

            const resultMessage = messageFromResponse(result.data);
            if (isVerificationMessage(resultMessage)) {
                return {
                    status: 'NEED_HUMAN',
                    detail: resultMessage,
                };
            }
            return {
                status: 'HARD_FAIL',
                detail:
                    resultMessage ||
                    'resultOrderForDcQueue did not confirm the order',
            };
        }
        await sleep(intervalMs);
    }

    return {
        status: 'RETRYABLE_FAIL',
        detail: 'Queue polling timed out without an order id',
    };
}

export class Direct12306BookingAdapter implements BookingAdapter {
    constructor(
        private readonly session: RailSession,
        private readonly armed: ArmedManifest,
        private readonly options: DirectBookingOptions
    ) {
        if (options.permit !== 'ARMED_USER_APPROVED') {
            throw new Error('MISSING_EXECUTION_PERMIT');
        }
    }

    async submit(plan: CandidatePlan): Promise<SubmitResult> {
        assertSubmitAuthorized(this.armed, plan.id);
        if (plan.kind !== 'DIRECT') {
            return {
                status: 'HARD_FAIL',
                detail: `INTERLINE_REQUIRES_INTERLINE_ADAPTER:${plan.id}`,
            };
        }

        let prepared: PreparedDirectOrder;
        try {
            prepared = await prepareDirectOrder(
                this.session,
                this.armed,
                plan.id,
                this.options.passengerIndexes
            );
        } catch (error) {
            const detail =
                error instanceof Error ? error.message : String(error);
            if (isVerificationMessage(detail) || /SESSION_/.test(detail)) {
                return { status: 'NEED_HUMAN', detail };
            }
            if (/LIVE_PRECHECK_NO_INVENTORY/.test(detail)) {
                return { status: 'HARD_FAIL', detail };
            }
            return { status: 'RETRYABLE_FAIL', detail };
        }

        const orderCheck = await checkDirectOrderInfo(
            this.session,
            prepared
        );
        if (orderCheck) return orderCheck;

        const queueCheck = await checkDirectQueueCapacity(
            this.session,
            prepared
        );
        if (queueCheck) return queueCheck;

        const queued = await enqueueDirectOrder(
            this.session,
            prepared
        );
        if (queued.status !== 'QUEUED') return queued;

        return waitForDirectLock(
            this.session,
            prepared,
            this.options.queuePollIntervalMs ?? 1000,
            this.options.queueTimeoutMs ?? 120000
        );
    }
}
