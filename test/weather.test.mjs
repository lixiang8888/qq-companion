// 天气：Open-Meteo 的解析与那行长什么样。
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PLACE, PLACES, fetchWeather, isStale, placeOf, weatherLine, weatherText, weatherUrl } from '../src/weather.js';

const NOW = Date.UTC(2026, 10, 7, 15, 45, 0);
const BODY = {
  current: {
    time: '2026-11-07T23:45', temperature_2m: 15.3, apparent_temperature: 14.5,
    relative_humidity_2m: 77, weather_code: 53, wind_speed_10m: 8.5,
  },
  daily: { temperature_2m_max: [18.2], temperature_2m_min: [11.9] },
};
const ok = (body) => async () => ({ ok: true, status: 200, json: async () => body });

test('地点：认识的用坐标，不认识的退回默认', () => {
  assert.equal(placeOf({ place: 'zhuji' }).label, PLACES.zhuji.label);
  assert.equal(placeOf({ place: '火星' }).id, DEFAULT_PLACE);
  assert.equal(placeOf().id, DEFAULT_PLACE);
});

test('请求：带坐标、当天最高最低、上海时区', () => {
  const u = weatherUrl(PLACES.huzhou);
  assert.match(u, /latitude=30\.8943/);
  assert.match(u, /longitude=120\.0875/);
  assert.match(u, /temperature_2m_max/);
  assert.match(u, /timezone=Asia/);
});

test('解析：取实测值，四舍五入，缺的字段留 null 不编', async () => {
  const w = await fetchWeather({ place: placeOf({}), fetchImpl: ok(BODY), now: () => NOW });
  assert.equal(w.temp, 15);
  assert.equal(w.feels, 15); // 14.5 四舍五入
  assert.equal(w.humid, 77);
  assert.equal(w.text, '毛毛雨');
  assert.equal(w.high, 18);
  assert.equal(w.low, 12);
  assert.equal(w.at, NOW);
  assert.equal(w.place, 'huzhou');
});

test('接口坏了要报错，不能返回半条天气', async () => {
  await assert.rejects(fetchWeather({ place: placeOf({}), fetchImpl: async () => ({ ok: false, status: 503 }) }), /503/);
  await assert.rejects(fetchWeather({ place: placeOf({}), fetchImpl: ok({ current: {} }) }), /没给温度/);
});

test('那一行：说清是实测、缺项就不提', () => {
  const line = weatherLine({ label: '湖州师范大学', temp: 15, feels: 15, high: 18, low: 12, humid: 77, text: '毛毛雨' });
  assert.match(line, /湖州师范大学/);
  assert.match(line, /实测/);
  assert.match(line, /毛毛雨15°C/);
  assert.match(line, /今天 12~18°C/);
  assert.equal(weatherLine({}), '');
  assert.equal(weatherLine({ temp: 12 }), '外面（她那边，实测）：12°C');
});

test('认不出的天气代码就留空，不猜', () => {
  assert.equal(weatherText(53), '毛毛雨');
  assert.equal(weatherText(1234), '');
});

test('缓存：半小时内算新', () => {
  assert.equal(isStale({ at: NOW - 10 * 60e3 }, NOW), false);
  assert.equal(isStale({ at: NOW - 40 * 60e3 }, NOW), true);
  assert.equal(isStale({}, NOW), true);
});
