'use client';

import { FORMAT_VND } from '@/lib/catalog-data';
import styles from './occasion.module.css';

export interface OccasionThumbnailItem {
  id: string;
  slug: string;
  name: string;
  priceVnd: number;
  imageUrl: string;
}

export interface OccasionSetThumbnailsProps {
  occasionName: string;
  items: OccasionThumbnailItem[];
  activeIndex: number;
  isDark: boolean;
  onSelect: (index: number) => void;
}

export function OccasionSetThumbnails({
  occasionName,
  items,
  activeIndex,
  isDark,
  onSelect,
}: OccasionSetThumbnailsProps) {
  return (
    <div className={`occ__sets ${styles.setsWrap}`}>
      <p className={`occ__setslbl ${styles.setsLabel}`} id="occSetsLbl">
        {items.length} mẫu cho dịp {occasionName}
      </p>
      <ul
        className={styles.setsGrid}
        id="occSets"
        data-testid="occasion-set-thumbnails"
      >
        {items.map((item, sIdx) => {
          const isActive = sIdx === activeIndex;
          const frameClasses = [
            'occ__setimg',
            styles.thumbFrame,
            isDark ? styles.thumbFrameDark : '',
            isActive
              ? isDark
                ? styles.thumbFrameActiveDark
                : styles.thumbFrameActive
              : '',
          ]
            .filter(Boolean)
            .join(' ');

          return (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => onSelect(sIdx)}
                aria-pressed={isActive}
                className={`${styles.thumbBtn} ${
                  isActive ? `on ${styles.thumbBtnActive}` : ''
                }`}
              >
                <span className={frameClasses}>
                  <img
                    src={item.imageUrl}
                    alt={item.name}
                    loading="eager"
                    decoding="async"
                    className={styles.thumbImg}
                  />
                </span>
                <b className={styles.thumbTitle}>{item.name}</b>
                <small className={styles.thumbPrice}>
                  {FORMAT_VND(item.priceVnd)}
                </small>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
