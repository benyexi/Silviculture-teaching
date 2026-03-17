/**
 * IP 地理位置解析
 * 使用免费的 ip-api.com 服务（无需 API Key，每分钟 45 次请求）
 */

export type GeoInfo = {
  ip: string;
  city: string | null;
  region: string | null;
  country: string | null;
  lat: number | null;
  lng: number | null;
};

// 简单内存缓存，避免重复请求
const geoCache = new Map<string, { data: GeoInfo; expiry: number }>();
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 小时

export async function getGeoInfo(ip: string): Promise<GeoInfo> {
  // 本地 IP 直接返回
  if (ip === "127.0.0.1" || ip === "::1" || ip.startsWith("192.168.") || ip.startsWith("10.")) {
    return { ip, city: "本地", region: "本地", country: "CN", lat: 39.9042, lng: 116.4074 };
  }

  // 检查缓存
  const cached = geoCache.get(ip);
  if (cached && cached.expiry > Date.now()) {
    return cached.data;
  }

  try {
    const response = await fetch(`http://ip-api.com/json/${ip}?lang=zh-CN&fields=status,city,regionName,country,lat,lon`, {
      signal: AbortSignal.timeout(3000),
    });

    if (!response.ok) throw new Error("GeoIP 请求失败");

    const data = await response.json() as any;

    const geoInfo: GeoInfo = {
      ip,
      city: data.status === "success" ? data.city || null : null,
      region: data.status === "success" ? data.regionName || null : null,
      country: data.status === "success" ? data.country || null : null,
      lat: data.status === "success" ? data.lat || null : null,
      lng: data.status === "success" ? data.lon || null : null,
    };

    geoCache.set(ip, { data: geoInfo, expiry: Date.now() + CACHE_TTL });
    return geoInfo;
  } catch {
    return { ip, city: null, region: null, country: null, lat: null, lng: null };
  }
}

// 从请求头中提取真实 IP
export function extractIp(req: { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } }): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (forwarded) {
    const ips = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    return ips.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}
