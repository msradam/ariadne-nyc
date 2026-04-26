export type MobilityProfileId = 'wheelchair' | 'stroller' | 'slow_walker' | 'low_vision';
export type RouterProfileId = 'manual_wheelchair' | 'generic_pedestrian' | 'low_vision';

export const PROFILE_MAP: Record<string, RouterProfileId> = {
  wheelchair:         'manual_wheelchair',
  manual_wheelchair:  'manual_wheelchair',
  slow_walker:        'generic_pedestrian',
  stroller:           'generic_pedestrian',
  low_vision:         'low_vision',
  generic_pedestrian: 'generic_pedestrian',
};

export const PROFILE_COLORS: Record<RouterProfileId, string> = {
  manual_wheelchair:  '#d29922',
  generic_pedestrian: '#58a6ff',
  low_vision:         '#a371f7',
};

export const ROUTER_PROFILE_FILES: Record<RouterProfileId, string> = {
  manual_wheelchair:  'profile-manual_wheelchair.json',
  generic_pedestrian: 'profile-generic_pedestrian.json',
  low_vision:         'profile-low_vision.json',
};
