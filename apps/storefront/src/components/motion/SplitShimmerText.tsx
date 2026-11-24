import { Fragment, type ElementType } from 'react';

export interface SplitShimmerTextProps {
  text: string;
  as?: ElementType;
  className?: string;
  id?: string;
  glint?: boolean;
}

function segmentVietnameseGraphemes(word: string): string[] {
  const normalized = word.normalize('NFC');
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const segmenter = new Intl.Segmenter('vi', { granularity: 'grapheme' });
    return Array.from(segmenter.segment(normalized), (part) => part.segment);
  }
  return Array.from(normalized);
}

export function SplitShimmerText({
  text,
  as: Tag = 'h1',
  className = 'shimmer',
  id,
  glint = true,
}: SplitShimmerTextProps) {
  const normalized = text.normalize('NFC').trim();
  const words = normalized.length > 0 ? normalized.split(/\s+/) : [];

  return (
    <Tag id={id} className={className} aria-label={normalized}>
      {words.map((word, wordIndex) => {
        const graphemes = segmentVietnameseGraphemes(word);
        return (
          <Fragment key={`${word}-${wordIndex}`}>
            {wordIndex > 0 ? ' ' : null}
            <span className="word" aria-hidden="true">
              {graphemes.map((grapheme, charIndex) => (
                <span
                  key={`${wordIndex}-${charIndex}`}
                  className="ch"
                  {...(glint ? { 'data-glint': '' } : {})}
                >
                  {grapheme}
                </span>
              ))}
            </span>
          </Fragment>
        );
      })}
    </Tag>
  );
}
