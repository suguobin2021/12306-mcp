import { TicketDataKeys, } from './types.js';
const SEAT_FIELD_BY_CODE = {
    '9': 'swz_num',
    P: 'tz_num',
    M: 'zy_num',
    D: 'zy_num',
    O: 'ze_num',
    S: 'ze_num',
    '6': 'gr_num',
    A: 'gr_num',
    '4': 'rw_num',
    I: 'rw_num',
    F: 'rw_num',
    '3': 'yw_num',
    J: 'yw_num',
    '2': 'rz_num',
    '1': 'yz_num',
    W: 'wz_num',
    WZ: 'wz_num',
};
export function rawSeatAvailable(value) {
    if (!value)
        return false;
    if (['无', '--', '0', '*'].includes(value))
        return false;
    if (['有', '充足'].includes(value))
        return true;
    const n = Number(value);
    return Number.isFinite(n) && n > 0;
}
export function parseRawTicketRows(rows) {
    return rows.map((row) => {
        const values = row.split('|');
        const entry = {};
        TicketDataKeys.forEach((key, index) => {
            entry[key] = values[index] ?? '';
        });
        return entry;
    });
}
export async function discoverTicketQueryPath(session) {
    const response = await session.client.get('/otn/leftTicket/init');
    const match = response.data.match(/ var CLeftTicketUrl = '(.+?)'/);
    if (!match)
        throw new Error('LEFT_TICKET_QUERY_PATH_NOT_FOUND');
    return match[1];
}
export async function queryLiveLeg(session, leg) {
    const queryPath = await discoverTicketQueryPath(session);
    const response = await session.client.get(`/otn/${queryPath}`, {
        params: {
            'leftTicketDTO.train_date': leg.departDate,
            'leftTicketDTO.from_station': leg.fromCode,
            'leftTicketDTO.to_station': leg.toCode,
            purpose_codes: 'ADULT',
        },
        headers: {
            referer: 'https://kyfw.12306.cn/otn/leftTicket/init',
            'if-modified-since': '0',
            'cache-control': 'no-cache',
        },
    });
    const rows = response.data?.data?.result;
    if (!Array.isArray(rows)) {
        throw new Error('LEFT_TICKET_RESULT_INVALID');
    }
    const parsed = parseRawTicketRows(rows);
    const ticket = parsed.find((x) => x.station_train_code === leg.trainCode &&
        x.from_station_telecode === leg.fromCode &&
        x.to_station_telecode === leg.toCode);
    if (!ticket) {
        throw new Error(`TRAIN_NOT_FOUND_LIVE:${leg.trainCode}:${leg.fromCode}->${leg.toCode}`);
    }
    const field = SEAT_FIELD_BY_CODE[leg.seatCode];
    if (!field) {
        throw new Error(`UNSUPPORTED_SEAT_CODE:${leg.seatCode}`);
    }
    const seatRaw = String(ticket[field] ?? '');
    return {
        ticket,
        queryPath,
        seatRaw,
        available: ticket.canWebBuy === 'Y' && rawSeatAvailable(seatRaw),
    };
}
