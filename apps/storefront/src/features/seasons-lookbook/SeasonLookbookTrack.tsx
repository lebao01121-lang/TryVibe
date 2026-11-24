'use client';

import type { SeasonalCollectionDto } from '@atelier/contracts';
import { SeasonalFlagshipVitrine } from './SeasonalFlagshipVitrine';

export interface SeasonLookbookTrackProps {
  seasons: SeasonalCollectionDto[];
}

export function SeasonLookbookTrack({ seasons }: SeasonLookbookTrackProps) {
  if (!seasons || seasons.length === 0) {
    return null;
  }

  return <SeasonalFlagshipVitrine seasons={seasons} />;
}
