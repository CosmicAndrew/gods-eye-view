import * as Cesium from 'cesium';

// Layers whose records move, in the order an unqualified name is searched
// (track_entity's order).
const MOVING_LAYERS = ['flights', 'military', 'ais-live-vessels', 'satellites'];

/**
 * Find a live aircraft, ship or satellite by callsign, name or id among the
 * enabled layers, for annotation marks that follow one.
 *
 * @returns {(query: string, layerId?: string|null) =>
 *   {id: string, layerId: string, label: string|null, lat: number, lon: number, height: number}|null}
 */
export function createEntityLocator(dataManager) {
  return (query, layerId = null) => {
    const layers = layerId ? [layerId] : MOVING_LAYERS;
    for (const id of layers) {
      if (!MOVING_LAYERS.includes(id) || !dataManager.isEnabled(id)) continue;
      const found = dataManager.layers.get(id)?.module?.findByQuery?.(query);
      if (!found) continue;
      // The rendered position, so the ring sits on the icon on screen.
      const carto = found.position
        ? Cesium.Cartographic.fromCartesian(found.position)
        : null;
      const lat = carto
        ? Cesium.Math.toDegrees(carto.latitude)
        : found.latitude;
      const lon = carto
        ? Cesium.Math.toDegrees(carto.longitude)
        : found.longitude;
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      return {
        id: String(found.icao24 ?? found.mmsi ?? found.noradId ?? query),
        layerId: id,
        label: found.callsign || found.name || null,
        lat,
        lon,
        height: carto ? carto.height : found.altitudeM || 0,
      };
    }
    return null;
  };
}
