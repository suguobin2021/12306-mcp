import assert from 'node:assert/strict';
import { classifyQueueWait, decodeSecretStr, parseInitDc, resolveSubmissionSeatCode, } from './booking-direct.js';
import { buildPassengerStrings, passengerChoices, selectPassengersByIndex, } from './booking-passenger.js';
function fakeTicket() {
    return {
        secret_Sstr: 'abc',
        button_text_info: '预订',
        train_no: '240000G00100',
        station_train_code: 'G1',
        start_station_telecode: 'AAA',
        end_station_telecode: 'BBB',
        from_station_telecode: 'AAA',
        to_station_telecode: 'BBB',
        start_time: '10:00',
        arrive_time: '12:00',
        lishi: '02:00',
        canWebBuy: 'Y',
        yp_info: '',
        start_train_date: '20261007',
        train_seat_feature: '',
        location_code: 'P2',
        from_station_no: '01',
        to_station_no: '02',
        is_support_card: '1',
        controlled_train_flag: '0',
        gg_num: '--',
        gr_num: '--',
        qt_num: '--',
        rw_num: '--',
        rz_num: '--',
        tz_num: '--',
        wz_num: '有',
        yb_num: '--',
        yw_num: '--',
        yz_num: '--',
        ze_num: '有',
        zy_num: '--',
        swz_num: '--',
        srrb_num: '--',
        yp_ex: '',
        seat_types: 'OW',
        exchange_train_flag: '0',
        houbu_train_flag: '1',
        houbu_seat_limit: '',
        yp_info_new: '',
        '40': '',
        '41': '',
        '42': '',
        '43': '',
        '44': '',
        '45': '',
        dw_flag: '',
        '47': '',
        stopcheckTime: '',
        country_flag: '',
        local_arrive_time: '',
        local_start_time: '',
        '52': '',
        bed_level_info: '',
        seat_discount_info: '',
        sale_time: '1000',
        '56': '',
    };
}
const init = parseInitDc(`
<script>
var globalRepeatSubmitToken = 'TOKEN123';
var ticketInfoForPassengerForm = {
  'key_check_isChange':'KEY123',
  'leftTicketStr':'LEFT123',
  'train_location':'P2',
  'purpose_codes':'00'
};
</script>
`);
assert.equal(init.repeatSubmitToken, 'TOKEN123');
assert.equal(init.keyCheckIsChange, 'KEY123');
assert.equal(init.leftTicketStr, 'LEFT123');
assert.equal(init.trainLocation, 'P2');
assert.equal(init.purposeCodes, '00');
assert.equal(decodeSecretStr('a%2Bb%2Fc'), 'a+b/c');
assert.equal(resolveSubmissionSeatCode(fakeTicket(), 'W'), 'O');
assert.equal(resolveSubmissionSeatCode(fakeTicket(), 'O'), 'O');
const passengers = [
    {
        passenger_name: '张三',
        passenger_id_type_code: '1',
        passenger_id_no: '123456789012345678',
        passenger_type: '1',
        passenger_type_name: '成人',
        mobile_no: '13800000000',
        allEncStr: 'ENC1',
    },
    {
        passenger_name: '李四',
        passenger_id_type_code: '1',
        passenger_id_no: '987654321098765432',
        passenger_type: '1',
        passenger_type_name: '成人',
        mobile_no: '13900000000',
        allEncStr: 'ENC2',
    },
];
const choices = passengerChoices(passengers);
assert.equal(choices[0].index, 1);
assert.ok(!choices[0].maskedId.includes('123456789012345678'));
assert.deepEqual(selectPassengersByIndex(passengers, [2, 1]).map((x) => x.passenger_name), ['李四', '张三']);
assert.throws(() => selectPassengersByIndex(passengers, [1, 1]), /DUPLICATE_PASSENGER_INDEX/);
const strings = buildPassengerStrings([passengers[0]], 'O');
assert.equal(strings.passengerTicketStr, 'O,0,1,张三,1,123456789012345678,13800000000,N,ENC1');
assert.equal(strings.oldPassengerStr, '张三,1,123456789012345678,1_');
assert.deepEqual(classifyQueueWait({
    waitTime: 4,
    orderId: null,
}), { state: 'WAIT', detail: 'waitTime=4' });
assert.deepEqual(classifyQueueWait({
    waitTime: -1,
    orderId: 'E123',
}), { state: 'ORDER_ID', orderId: 'E123' });
assert.equal(classifyQueueWait({
    waitTime: -2,
    errorcode: '0',
    msg: '没有足够的票!',
    orderId: null,
}).state, 'FAIL');
console.log('DIRECT_INIT_PARSE PASS');
console.log('PASSENGER_BUILD PASS');
console.log('NO_SEAT_RESOLUTION PASS');
console.log('QUEUE_CLASSIFICATION PASS');
