/**
 * Irish Transverse Mercator (ITM, EPSG:2157) easting/northing → WGS84 lat/lng.
 *
 * eplanning's "Site Location Details" gives the site's ITM grid coordinates
 * (Grid Eastings / Northings), which are exact — far better than geocoding an
 * address. ITM is defined on GRS80 (≈ WGS84 to cm), so no datum shift is needed;
 * this is the standard Redfearn inverse transverse-Mercator series.
 */
export function itmToLatLng(easting: number, northing: number): { lat: number; lng: number } {
  const a = 6378137.0; // GRS80 semi-major
  const f = 1 / 298.257222101;
  const b = a * (1 - f);
  const e2 = (a * a - b * b) / (a * a);
  const n = (a - b) / (a + b);
  const n2 = n * n;
  const n3 = n2 * n;
  const k0 = 0.99982;
  const E0 = 600000;
  const N0 = 750000;
  const phi0 = (53.5 * Math.PI) / 180;
  const lam0 = (-8 * Math.PI) / 180;

  const arcM = (phi: number): number => {
    const dphi = phi - phi0;
    const sphi = phi + phi0;
    return (
      b *
      k0 *
      ((1 + n + (5 / 4) * n2 + (5 / 4) * n3) * dphi -
        (3 * n + 3 * n2 + (21 / 8) * n3) * Math.sin(dphi) * Math.cos(sphi) +
        ((15 / 8) * n2 + (15 / 8) * n3) * Math.sin(2 * dphi) * Math.cos(2 * sphi) -
        (35 / 24) * n3 * Math.sin(3 * dphi) * Math.cos(3 * sphi))
    );
  };

  let phi = (northing - N0) / (a * k0) + phi0;
  let M = arcM(phi);
  for (let i = 0; i < 12 && Math.abs(northing - N0 - M) >= 0.00001; i++) {
    phi += (northing - N0 - M) / (a * k0);
    M = arcM(phi);
  }

  const sinphi = Math.sin(phi);
  const nu = (a * k0) / Math.sqrt(1 - e2 * sinphi * sinphi);
  const rho = (a * k0 * (1 - e2)) / Math.pow(1 - e2 * sinphi * sinphi, 1.5);
  const eta2 = nu / rho - 1;

  const tanphi = Math.tan(phi);
  const t2 = tanphi * tanphi;
  const t4 = t2 * t2;
  const t6 = t4 * t2;
  const secphi = 1 / Math.cos(phi);
  const dE = easting - E0;

  const VII = tanphi / (2 * rho * nu);
  const VIII = (tanphi / (24 * rho * nu ** 3)) * (5 + 3 * t2 + eta2 - 9 * t2 * eta2);
  const IX = (tanphi / (720 * rho * nu ** 5)) * (61 + 90 * t2 + 45 * t4);
  const X = secphi / nu;
  const XI = (secphi / (6 * nu ** 3)) * (nu / rho + 2 * t2);
  const XII = (secphi / (120 * nu ** 5)) * (5 + 28 * t2 + 24 * t4);
  const XIIA = (secphi / (5040 * nu ** 7)) * (61 + 662 * t2 + 1320 * t4 + 720 * t6);

  const lat = phi - VII * dE ** 2 + VIII * dE ** 4 - IX * dE ** 6;
  const lng = lam0 + X * dE - XI * dE ** 3 + XII * dE ** 5 - XIIA * dE ** 7;

  return { lat: (lat * 180) / Math.PI, lng: (lng * 180) / Math.PI };
}
