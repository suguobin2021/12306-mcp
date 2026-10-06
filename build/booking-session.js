import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import { chmod, readFile, writeFile } from 'node:fs/promises';
export class RailSession {
    jar;
    client;
    constructor(jar) {
        this.jar = jar ?? new CookieJar();
        this.client = wrapper(axios.create({
            baseURL: 'https://kyfw.12306.cn',
            timeout: 15000,
            withCredentials: true,
            maxRedirects: 5,
            headers: {
                'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36',
                accept: 'application/json, text/javascript, */*; q=0.01',
                'accept-language': 'zh-CN,zh;q=0.9',
                referer: 'https://kyfw.12306.cn/otn/resources/login.html',
                origin: 'https://kyfw.12306.cn',
                'x-requested-with': 'XMLHttpRequest',
            },
            jar: this.jar,
        }));
    }
    static async load(path) {
        const raw = JSON.parse(await readFile(path, 'utf8'));
        return new RailSession(CookieJar.deserializeSync(raw));
    }
    async save(path) {
        await writeFile(path, JSON.stringify(this.jar.serializeSync(), null, 2) + '\n', { mode: 0o600 });
        await chmod(path, 0o600);
    }
    async warmup() {
        await this.client.get('/otn/resources/login.html');
    }
    async createQr() {
        await this.warmup();
        const body = new URLSearchParams({ appid: 'otn' });
        const response = await this.client.post('/passport/web/create-qr64', body, {
            headers: {
                'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            },
        });
        if (String(response.data?.result_code) !== '0') {
            throw new Error(`QR_CREATE_FAILED:${response.data?.result_message ?? 'unknown'}`);
        }
        return response.data;
    }
    async optionalDeviceFields() {
        const cookies = await this.jar.getCookies('https://kyfw.12306.cn/');
        const map = new Map(cookies.map((c) => [c.key, c.value]));
        const result = {};
        const deviceId = map.get('RAIL_DEVICEID');
        const expiration = map.get('RAIL_EXPIRATION');
        if (deviceId)
            result.RAIL_DEVICEID = deviceId;
        if (expiration)
            result.RAIL_EXPIRATION = expiration;
        return result;
    }
    async checkQr(uuid) {
        const fields = await this.optionalDeviceFields();
        const body = new URLSearchParams({
            ...fields,
            uuid,
            appid: 'otn',
        });
        const response = await this.client.post('/passport/web/checkqr', body, {
            headers: {
                'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            },
        });
        return response.data;
    }
    async finalizeUnifiedAuth() {
        const tkBody = new URLSearchParams({ appid: 'otn' });
        const tkResponse = await this.client.post('/passport/web/auth/uamtk', tkBody, {
            headers: {
                'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            },
        });
        if (Number(tkResponse.data?.result_code) !== 0) {
            throw new Error(`UAMTK_FAILED:${tkResponse.data?.result_message ?? tkResponse.data?.result_code}`);
        }
        const tk = tkResponse.data.newapptk ?? tkResponse.data.apptk ?? '';
        if (!tk)
            throw new Error('UAMTK_MISSING_TOKEN');
        const authBody = new URLSearchParams({ tk });
        const authResponse = await this.client.post('/otn/uamauthclient', authBody, {
            headers: {
                'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
            },
        });
        if (Number(authResponse.data?.result_code) !== 0) {
            throw new Error(`UAMAUTHCLIENT_FAILED:${authResponse.data?.result_message ?? authResponse.data?.result_code}`);
        }
        return authResponse.data;
    }
    async checkUser() {
        const response = await this.client.post('/otn/login/checkUser', new URLSearchParams(), {
            headers: {
                'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'if-modified-since': '0',
                'cache-control': 'no-cache',
            },
        });
        return Boolean(response.data?.data?.flag);
    }
}
