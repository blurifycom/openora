export interface GeoIpPort {
  lookup(ipAddress: string): Promise<{ countryCode: string | null }>;
}

export const GEO_IP_PORT = Symbol('GEO_IP_PORT');
