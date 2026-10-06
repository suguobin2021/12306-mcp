function maskName(value) {
    if (!value)
        return '*';
    if (value.length === 1)
        return '*';
    return value[0] + '*'.repeat(Math.max(1, value.length - 1));
}
function maskId(value) {
    if (!value)
        return '***';
    if (value.length <= 4)
        return '*'.repeat(value.length);
    return value.slice(0, 2) + '*'.repeat(value.length - 4) + value.slice(-2);
}
export function passengerChoices(passengers) {
    return passengers.map((p, index) => ({
        index: index + 1,
        maskedName: maskName(p.passenger_name),
        passengerType: p.passenger_type_name ?? p.passenger_type,
        maskedId: maskId(p.passenger_id_no),
    }));
}
export async function fetchPassengers(session, repeatSubmitToken, refererPath = '/otn/confirmPassenger/initDc') {
    const response = await session.client.post('/otn/confirmPassenger/getPassengerDTOs', new URLSearchParams({
        _json_att: '',
        REPEAT_SUBMIT_TOKEN: repeatSubmitToken,
    }), {
        headers: {
            'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            referer: `https://kyfw.12306.cn${refererPath}`,
        },
    });
    if (!response.data?.status) {
        throw new Error(`PASSENGER_FETCH_FAILED:${(response.data?.messages ?? []).join('|')}`);
    }
    if (String(response.data?.data?.noLogin) === 'true') {
        throw new Error('PASSENGER_SESSION_EXPIRED');
    }
    const rows = response.data?.data?.normal_passengers;
    if (!Array.isArray(rows)) {
        throw new Error('PASSENGER_LIST_INVALID');
    }
    return rows;
}
export function selectPassengersByIndex(passengers, oneBasedIndexes) {
    if (oneBasedIndexes.length === 0) {
        throw new Error('NO_PASSENGER_SELECTED');
    }
    if (oneBasedIndexes.length > 5) {
        throw new Error('TOO_MANY_PASSENGERS');
    }
    const unique = [...new Set(oneBasedIndexes)];
    if (unique.length !== oneBasedIndexes.length) {
        throw new Error('DUPLICATE_PASSENGER_INDEX');
    }
    return unique.map((index) => {
        if (!Number.isInteger(index) || index < 1 || index > passengers.length) {
            throw new Error(`INVALID_PASSENGER_INDEX:${index}`);
        }
        return passengers[index - 1];
    });
}
export function buildPassengerStrings(passengers, submissionSeatCode) {
    if (!submissionSeatCode) {
        throw new Error('MISSING_SUBMISSION_SEAT_CODE');
    }
    const ticketParts = passengers.map((p) => {
        const ticketType = p.passenger_type || '1';
        const phone = p.mobile_no ?? p.phone_no ?? '';
        const encrypted = p.allEncStr ?? '';
        return [
            submissionSeatCode,
            '0',
            ticketType,
            p.passenger_name,
            p.passenger_id_type_code,
            p.passenger_id_no,
            phone,
            'N',
            encrypted,
        ].join(',');
    });
    const oldParts = passengers.map((p) => [
        p.passenger_name,
        p.passenger_id_type_code,
        p.passenger_id_no,
        p.passenger_type || '1',
    ].join(',') + '_');
    return {
        passengerTicketStr: ticketParts.join('_'),
        oldPassengerStr: oldParts.join(''),
    };
}
