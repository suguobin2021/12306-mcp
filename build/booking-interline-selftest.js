import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { buildLcChooseSeats, buildLcOldPassengerStr, buildLcPassengerTicketStr, buildLcQueueDataStr, decodeLcSecretLegs, parseInitLc, } from './booking-interline.js';
import { buildInterlinePlans, } from './ticket-locker.js';
const init = parseInitLc(`
<script>
var globalRepeatSubmitToken='TOKLC';
var x={'key_check_isChange':'KEYLC','purpose_codes':'00'};
</script>
`);
assert.equal(init.repeatSubmitToken, 'TOKLC');
assert.equal(init.keyCheckIsChange, 'KEYLC');
assert.equal(init.purposeCodes, '00');
function secretChunk(date, code, no, fromCode, toCode, fromName, toName, left, location) {
    const fields = Array(15).fill('');
    fields[0] = date;
    fields[2] = code;
    fields[5] = no;
    fields[6] = fromCode;
    fields[7] = toCode;
    fields[9] = fromName;
    fields[10] = toName;
    fields[13] = left;
    fields[14] = location;
    return fields.join('#');
}
const decodedSource = [
    secretChunk('2026-10-07', 'G100', 'NO100', 'AAA', 'BBB', '甲站', '乙站', 'LEFT1', 'L1'),
    secretChunk('2026-10-07', 'G200', 'NO200', 'BBB', 'CCC', '乙站', '丙站', 'LEFT2', 'L2'),
].join('#:::');
const encoded = encodeURIComponent(Buffer.from(decodedSource, 'utf8').toString('base64').replace(/=+$/, ''));
const legs = decodeLcSecretLegs(encoded);
assert.equal(legs.length, 2);
assert.equal(legs[0].trainCode, 'G100');
assert.equal(legs[1].leftTicketStr, 'LEFT2');
assert.equal(buildLcOldPassengerStr(legs, 'O', '二等座'), 'G100,O,二等座,20261007,AAA,BBB#G200,O,二等座,20261007,BBB,CCC#');
assert.equal(buildLcQueueDataStr(legs, 'O', '二等座', '00'), '20261007|NO100|G100|O|AAA|BBB|LEFT1|00|二等座|L1#20261007|NO200|G200|O|BBB|CCC|LEFT2|00|二等座|L2');
assert.equal(buildLcChooseSeats(legs), 'G100_*#G200_*#');
const passengers = [
    {
        passenger_name: '张三',
        passenger_id_type_code: '1',
        passenger_id_no: '123456789012345678',
        passenger_type: '1',
        mobile_no: '13800000000',
        allEncStr: 'ENC',
    },
];
assert.equal(buildLcPassengerTicketStr(passengers), ',0,1,张三,1,123456789012345678,13800000000,N,ENC');
const raw = {
    lishi: '03:00',
    start_time: '08:00',
    start_date: '2026-10-07',
    arrive_date: '2026-10-07',
    arrive_time: '11:00',
    from_station_name: '甲站',
    middle_station_name: '乙站',
    end_station_name: '丙站',
    same_station: true,
    wait_time: '40分钟',
    ticketList: [
        {
            train_no: 'NO100',
            start_train_code: 'G100',
            start_date: '2026-10-07',
            arrive_date: '2026-10-07',
            start_time: '08:00',
            arrive_time: '09:00',
            lishi: '01:00',
            from_station: '甲站',
            to_station: '乙站',
            from_station_telecode: 'AAA',
            to_station_telecode: 'BBB',
            prices: [
                {
                    seat_name: '二等座',
                    short: 'ze',
                    seat_type_code: 'O',
                    num: '有',
                    price: 100,
                },
                {
                    seat_name: '无座',
                    short: 'wz',
                    seat_type_code: 'W',
                    num: '有',
                    price: 80,
                },
            ],
        },
        {
            train_no: 'NO200',
            start_train_code: 'G200',
            start_date: '2026-10-07',
            arrive_date: '2026-10-07',
            start_time: '09:40',
            arrive_time: '11:00',
            lishi: '01:20',
            from_station: '乙站',
            to_station: '丙站',
            from_station_telecode: 'BBB',
            to_station_telecode: 'CCC',
            prices: [
                {
                    seat_name: '二等座',
                    short: 'ze',
                    seat_type_code: 'O',
                    num: '无',
                    price: 120,
                },
                {
                    seat_name: '无座',
                    short: 'wz',
                    seat_type_code: 'W',
                    num: '3',
                    price: 90,
                },
            ],
        },
    ],
};
const plans = buildInterlinePlans([raw], ['二等座', '无座']);
assert.equal(plans.length, 1);
assert.ok(plans[0].legs.every((leg) => leg.seatCode === 'W'));
assert.equal(plans[0].totalPrice, 170);
const noCommon = structuredClone(raw);
noCommon.ticketList[1].prices = [
    {
        seat_name: '一等座',
        short: 'zy',
        seat_type_code: 'M',
        num: '有',
        price: 220,
    },
];
assert.equal(buildInterlinePlans([noCommon], ['二等座', '无座', '一等座']).length, 0);
console.log('LC_INIT_PARSE PASS');
console.log('LC_SECRET_DECODE PASS');
console.log('LC_PAYLOAD_BUILD PASS');
console.log('LC_COMMON_SEAT_ONLY PASS');
