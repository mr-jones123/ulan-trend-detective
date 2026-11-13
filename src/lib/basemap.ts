import type { ExpressionSpecification, LayerSpecification, StyleSpecification } from '@maplibre/maplibre-gl-style-spec';

export const STYLE_URL = 'https://tiles.openfreemap.org/styles/positron';
export const STYLE_TIMEOUT_MS = 8000;

/** No generic `name` fallback, which can carry non-Latin scripts. */
export const LATIN_NAME: ExpressionSpecification = ['coalesce', ['get', 'name:en'], ['get', 'name_en'], ['get', 'name:latin']];

function isNameLabel(field: unknown): boolean {
  return field !== undefined && /"name/.test(JSON.stringify(field));
}

export function transformPositron(style: StyleSpecification): StyleSpecification {
  const layers: LayerSpecification[] = style.layers
    .filter((layer) => !('source-layer' in layer && layer['source-layer'] === 'water_name'))
    .map((layer) => {
      if (layer.type !== 'symbol') return layer;
      const field = layer.layout?.['text-field'];
      if (!isNameLabel(field)) return layer;
      return { ...layer, layout: { ...layer.layout, 'text-field': LATIN_NAME } };
    });
  return { ...style, layers };
}

export function fallbackStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [{ id: 'paper', type: 'background', paint: { 'background-color': '#e9eeec' } }],
  };
}

export function firstSymbolLayer(style: StyleSpecification): string | undefined {
  return style.layers.find((layer) => layer.type === 'symbol')?.id;
}
