export type ComfortCategory =
  | 'cool_indoor'
  | 'warm_indoor'
  | 'bathroom'
  | 'quiet_indoor'
  | 'wifi_power'
  | 'shelter_24h'
  | 'pool_indoor'
  | 'seating'
  | 'linknyc'
  | 'food_pantry'
  | 'senior_center'
  | 'harm_reduction'
  | 'medical'
  | 'mental_health'
  | 'community_center';

export const SAFETY_CRITICAL: Set<ComfortCategory> = new Set([
  'cool_indoor',
  'warm_indoor',
  'shelter_24h',
  'medical',
]);

export type ComfortFeature = {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: {
    id: string;
    source: string;
    name: string;
    address: string;
    resource_types: ComfortCategory[];
    amenities: string[];
    hours_today: unknown;
    is_temporarily_closed: boolean;
    borough: string;
  };
};

export type ComfortCollection = {
  type: 'FeatureCollection';
  features: ComfortFeature[];
};
