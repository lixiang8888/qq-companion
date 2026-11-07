// 天气：Open-Meteo，免密钥，给的是观测值。
//
// 为什么不用搜索接口查天气：那种答案是它从网页里读来的，会滞后。
// 实测过一次——同一时刻，网页答案说「19°C 阴」，Open-Meteo 说 15.3°C 毛毛雨。
// 她要说就说真的，所以这一条走实测。

export const PLACES = {
  huzhou: { label: '湖州师范学院', lat: 30.8943, lon: 120.0875 },
  zhuji: { label: '诸暨', lat: 29.7136, lon: 120.2464 },
};

export const DEFAULT_PLACE = 'huzhou';
// 半小时一次：天气半小时内基本不变，问勤了只是白花请求。
export const CACHE_MS = 30 * 60e3;

// WMO 天气代码。少了几个不认识的，认不出就留空——不猜。
const CODES = {
  0: '晴', 1: '大致晴', 2: '多云', 3: '阴',
  45: '雾', 48: '冻雾',
  51: '毛毛雨', 53: '毛毛雨', 55: '雨点很密', 56: '冻毛毛雨', 57: '冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪',
  80: '阵雨', 81: '阵雨', 82: '大阵雨', 85: '阵雪', 86: '大阵雪',
  95: '雷阵雨', 96: '雷阵雨夹冰雹', 99: '雷阵雨夹冰雹',
};

export const weatherText = (code) => CODES[Number(code)] || '';
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const round = (v) => (num(v) === null ? null : Math.round(num(v)));

export function placeOf(cfg = {}) {
  const wanted = String(cfg.place || DEFAULT_PLACE);
  // 认不出来的地名就按默认那个算：id 也要跟着归一，否则缓存比对会永远对不上。
  const id = PLACES[wanted] ? wanted : DEFAULT_PLACE;
  return { id, ...PLACES[id] };
}

export function weatherUrl({ lat, lon }) {
  const q = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m',
    daily: 'temperature_2m_max,temperature_2m_min',
    timezone: 'Asia/Shanghai',
    forecast_days: '1',
  });
  return `https://api.open-meteo.com/v1/forecast?${q}`;
}

export async function fetchWeather({ place = {}, fetchImpl = globalThis.fetch, timeoutMs = 15000, now = Date.now } = {}) {
  const res = await fetchImpl(weatherUrl(place), { signal: AbortSignal.timeout(timeoutMs) });
  if (!res?.ok) throw new Error(`天气接口 HTTP ${res?.status}`);
  const body = await res.json().catch(() => null);
  const c = body?.current || {};
  const d = body?.daily || {};
  const temp = round(c.temperature_2m);
  if (temp === null) throw new Error('天气接口没给温度');
  return {
    at: now(),
    place: place.id || '',
    label: place.label || '',
    temp,
    feels: round(c.apparent_temperature),
    humid: round(c.relative_humidity_2m),
    wind: round(c.wind_speed_10m),
    text: weatherText(c.weather_code),
    high: round(d.temperature_2m_max?.[0]),
    low: round(d.temperature_2m_min?.[0]),
  };
}

/** 拼进她上下文的那一行。缺哪项就不说哪项，不编。 */
export function weatherLine(w) {
  if (!w || round(w.temp) === null) return '';
  const parts = [`${w.text || ''}${w.temp}°C`];
  if (round(w.feels) !== null) parts.push(`体感 ${w.feels}°C`);
  if (round(w.high) !== null && round(w.low) !== null) parts.push(`今天 ${w.low}~${w.high}°C`);
  if (round(w.humid) !== null) parts.push(`湿度 ${w.humid}%`);
  return `外面（${w.label || '她那边'}，实测）：${parts.join('，')}`;
}

export const isStale = (w, now, ttl = CACHE_MS) => !w?.at || now - w.at > ttl;
