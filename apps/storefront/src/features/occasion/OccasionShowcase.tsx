'use client';

import { useGSAP } from '@gsap/react';
import { useLenis } from 'lenis/react';
import Link from 'next/link';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  TryOnGarmentCategory,
  TryOnMode,
  type OccasionLookbookDto,
} from '@atelier/contracts';
import {
  triggerParticleBurst,
  useMotionState,
  usePrefersReducedMotion,
} from '@atelier/motion-kit';
import { MagneticButton } from '@/components/motion/MagneticButton';
import { SplitShimmerText } from '@/components/motion/SplitShimmerText';
import { FORMAT_VND } from '@/lib/catalog-data';
import { ensureGsapRegistered, gsap, ScrollTrigger } from '@/lib/gsap-setup';
import {
  openVirtualTryOnModal,
  type OpenTryOnOptions,
} from '@/lib/storefront-actions';
import { CircularFabricLens } from './CircularFabricLens';
import { OccasionSetThumbnails } from './OccasionSetThumbnails';
import styles from './occasion.module.css';

export interface OccasionShowcaseProps {
  occasions: OccasionLookbookDto[];
}

interface NormalizedOccasionSet {
  id: string;
  slug: string;
  name: string;
  priceVnd: number;
  imageUrl: string;
  heroCutoutUrl: string;
  macroImageUrl: string | null;
  slotLabel: string;
  isTryonEnabled: boolean;
  tryonGarmentCategory?: TryOnGarmentCategory;
}

type OptionalOccasionMediaFields = {
  macroImageUrl?: string | null;
  heroCutoutUrl?: string | null;
};

const CANONICAL_OCCASION_BADGES: Record<string, string> = {
  'du-tiec-toi': 'EVENING COUTURE',
  'cong-so-hien-dai': 'MODERN TAILORING',
  'cuoi-tuan-thu-thai': 'WEEKEND EASE',
  'nghi-duong-bien': 'RESORT CAPSULE',
  'trien-lam-nghe-thuat': 'GALLERY EDIT',
  'le-cuoi-thanh-lich': 'BRIDAL GUEST',
};

function resolveOccasionBadgeTag(occ: OccasionLookbookDto): string | null {
  const canonical = CANONICAL_OCCASION_BADGES[occ.slug];
  if (canonical) return canonical;
  return occ.badgeTag ? occ.badgeTag.toUpperCase() : null;
}

function createOccasionFallbackSvg(
  title: string,
  bgHex: string,
  accentHex: string,
  inkHex: string,
): string {
  const safeTitle = title.replace(/[<>&"']/g, '').slice(0, 28);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="720" viewBox="0 0 480 720">
    <rect width="480" height="720" rx="220" fill="${bgHex}" fill-opacity="0.22"/>
    <path d="M168 152 L212 126 L268 126 L312 152 L352 276 L306 296 L288 228 L302 584 L178 584 L192 228 L174 296 L128 276 Z" fill="${accentHex}" fill-opacity="0.82" stroke="${inkHex}" stroke-opacity="0.35" stroke-width="2"/>
    <text x="240" y="640" text-anchor="middle" fill="${inkHex}" font-size="18" font-family="Georgia, serif">${safeTitle}</text>
  </svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function resolveOccasionSets(occ: OccasionLookbookDto): NormalizedOccasionSet[] {
  const occMedia = occ as OccasionLookbookDto & OptionalOccasionMediaFields;
  const occasionMacro = occMedia.macroImageUrl ?? null;

  if (occ.items && occ.items.length > 0) {
    const featuredBySlug = new Map(
      (occ.featuredProducts ?? []).map((prod) => [prod.slug, prod]),
    );
    return occ.items.slice(0, 4).map((item, idx) => {
      const matchedProd = featuredBySlug.get(item.slug);
      const itemMacro = item.macroImageUrl ?? occasionMacro;
      const heroCutoutUrl =
        item.heroCutoutUrl || `/occasion-cutouts/${item.slug}-cutout-3x4.webp`;

      return {
        id: item.productId || `${occ.id}-item-${idx}`,
        slug: item.slug,
        name: item.name,
        priceVnd: item.minPriceVnd,
        imageUrl:
          item.lookbookMainUrl ||
          item.tryonFlatPreviewUrl ||
          createOccasionFallbackSvg(
            item.name,
            occ.themeBg,
            occ.themeAccent,
            occ.themeInk,
          ),
        heroCutoutUrl,
        macroImageUrl: itemMacro,
        slotLabel: item.slotLabel,
        isTryonEnabled: item.isTryonEnabled,
        tryonGarmentCategory: matchedProd?.tryonGarmentCategory,
      };
    });
  }

  if (occ.featuredProducts && occ.featuredProducts.length > 0) {
    return occ.featuredProducts.slice(0, 4).map((prod, idx) => {
      const firstVariant = prod.variants[0];
      const prodMedia = prod as typeof prod & OptionalOccasionMediaFields;
      const prodMacro = prodMedia.macroImageUrl ?? occasionMacro;
      const heroCutoutUrl =
        prodMedia.heroCutoutUrl ||
        `/occasion-cutouts/${prod.slug}-cutout-3x4.webp`;

      return {
        id: prod.id || `${occ.id}-prod-${idx}`,
        slug: prod.slug,
        name: prod.name,
        priceVnd: prod.minPriceVnd,
        imageUrl:
          firstVariant?.lookbookMainUrl ||
          firstVariant?.rackFrontUrl ||
          firstVariant?.tryonFlatPreviewUrl ||
          prod.tryonFlatAssetUrl ||
          createOccasionFallbackSvg(
            prod.name,
            occ.themeBg,
            occ.themeAccent,
            occ.themeInk,
          ),
        heroCutoutUrl,
        macroImageUrl: prodMacro,
        slotLabel: prod.categoryName || `Thiết kế 0${idx + 1}`,
        isTryonEnabled: prod.isTryonEnabled,
        tryonGarmentCategory: prod.tryonGarmentCategory,
      };
    });
  }

  const slugs =
    occ.productSlugs.length > 0 ? occ.productSlugs.slice(0, 4) : [occ.slug];
  return slugs.map((slug, idx) => ({
    id: `${occ.id}-slug-${idx}`,
    slug,
    name: `${occ.name} · Look 0${idx + 1}`,
    priceVnd: 2450000 + idx * 350000,
    imageUrl: createOccasionFallbackSvg(
      `${occ.name} 0${idx + 1}`,
      occ.themeBg,
      occ.themeAccent,
      occ.themeInk,
    ),
    heroCutoutUrl: `/occasion-cutouts/${slug}-cutout-3x4.webp`,
    macroImageUrl: occasionMacro,
    slotLabel: `Gợi ý 0${idx + 1}`,
    isTryonEnabled: true,
  }));
}

function buildTryOnOptionsForItem(
  item: NormalizedOccasionSet,
): OpenTryOnOptions {
  const garmentRef = {
    productId: item.id,
    slug: item.slug,
  };

  if (item.tryonGarmentCategory === TryOnGarmentCategory.OVERALL) {
    return { mode: TryOnMode.SINGLE, onePiece: garmentRef };
  }
  if (item.tryonGarmentCategory === TryOnGarmentCategory.LOWER) {
    return { mode: TryOnMode.SINGLE, lower: garmentRef };
  }
  if (item.tryonGarmentCategory === TryOnGarmentCategory.UPPER) {
    return { mode: TryOnMode.SINGLE, upper: garmentRef };
  }

  const probe = `${item.slug} ${item.slotLabel} ${item.name}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase();

  const isSkirtOrTrouser =
    /(chan[\s-]?vay|quan[\s-]?|culotte|trouser|skirt|pant|bottom|lower)/i.test(
      probe,
    );
  const isOnePieceDress =
    !isSkirtOrTrouser &&
    /(^|[\s-])(dam|dress|one[\s_-]?piece|overall|jumpsuit|gown)($|[\s-])/i.test(
      probe,
    );

  if (isOnePieceDress) {
    return { mode: TryOnMode.SINGLE, onePiece: garmentRef };
  }
  if (isSkirtOrTrouser) {
    return { mode: TryOnMode.SINGLE, lower: garmentRef };
  }
  return { mode: TryOnMode.SINGLE, upper: garmentRef };
}

function decodeImageAsset(url: string | null | undefined): Promise<boolean> {
  if (!url || typeof window === 'undefined') {
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolve) => {
    const preloader = new Image();
    preloader.decoding = 'async';
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    preloader.onload = () => {
      if (typeof preloader.decode === 'function') {
        preloader
          .decode()
          .then(() => finish(true))
          .catch(() => finish(true));
      } else {
        finish(true);
      }
    };
    preloader.onerror = () => finish(false);
    preloader.src = url;

    if (preloader.complete && preloader.naturalWidth > 0) {
      if (typeof preloader.decode === 'function') {
        preloader
          .decode()
          .then(() => finish(true))
          .catch(() => finish(true));
      } else {
        finish(true);
      }
    }
  });
}

function withSoftTimeout<T>(
  promise: Promise<T>,
  ms: number,
  fallbackValue: T,
): Promise<T> {
  return new Promise<T>((resolve) => {
    let done = false;
    const timer = window.setTimeout(() => {
      if (!done) {
        done = true;
        resolve(fallbackValue);
      }
    }, ms);
    promise.then((val) => {
      if (!done) {
        done = true;
        window.clearTimeout(timer);
        resolve(val);
      }
    });
  });
}

export function OccasionShowcase({ occasions }: OccasionShowcaseProps) {
  const sectionRef = useRef<HTMLElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const bgRef = useRef<HTMLDivElement | null>(null);
  const wipeRef = useRef<HTMLDivElement | null>(null);
  const ringCRef = useRef<SVGCircleElement | null>(null);
  const ringGRef = useRef<SVGCircleElement | null>(null);
  const auraRef = useRef<HTMLDivElement | null>(null);
  const wireHaloRef = useRef<SVGSVGElement | null>(null);
  const bouquetRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const scrollTriggerRef = useRef<ScrollTrigger | null>(null);
  const prevOccIdxRef = useRef<number | null>(null);
  const prevRenderedKeyRef = useRef<string | null>(null);
  const decodeSeqRef = useRef(0);
  const decodedUrlsRef = useRef<Set<string>>(new Set());
  const failedCutoutsRef = useRef<Set<string>>(new Set());

  const lenis = useLenis();
  const { cameraActive } = useMotionState();
  const reducedMotion = usePrefersReducedMotion();

  const [activeIdx, setActiveIdx] = useState(0);
  const [selectedSetIdx, setSelectedSetIdx] = useState(0);
  const [renderedIdx, setRenderedIdx] = useState({ occIdx: 0, setIdx: 0 });
  const [cutoutFallbackUrls, setCutoutFallbackUrls] = useState<
    Record<string, true>
  >({});

  const normalizedOccasions = useMemo(
    () =>
      occasions.map((occ) => ({
        occ,
        sets: resolveOccasionSets(occ),
      })),
    [occasions],
  );

  const safeOccIdx =
    normalizedOccasions.length > 0
      ? Math.max(0, Math.min(activeIdx, normalizedOccasions.length - 1))
      : 0;
  const activeEntry = normalizedOccasions[safeOccIdx];
  const activeOcc = activeEntry?.occ;
  const lookSets = activeEntry?.sets ?? [];
  const safeSetIdx =
    lookSets.length > 0
      ? Math.max(0, Math.min(selectedSetIdx, lookSets.length - 1))
      : 0;
  const featuredLook = lookSets[safeSetIdx] ?? lookSets[0];

  const safeRenderedOccIdx =
    normalizedOccasions.length > 0
      ? Math.max(
          0,
          Math.min(renderedIdx.occIdx, normalizedOccasions.length - 1),
        )
      : 0;
  const renderedEntry = normalizedOccasions[safeRenderedOccIdx];
  const renderedSets = renderedEntry?.sets ?? [];
  const safeRenderedSetIdx =
    renderedSets.length > 0
      ? Math.max(0, Math.min(renderedIdx.setIdx, renderedSets.length - 1))
      : 0;
  const displayedLook =
    renderedSets[safeRenderedSetIdx] ?? renderedSets[0] ?? featuredLook;
  const displayedOcc = renderedEntry?.occ ?? activeOcc;

  const renderedTransitionKey = displayedOcc
    ? `${displayedOcc.slug}:${displayedLook?.id ?? safeRenderedSetIdx}`
    : '';

  const displayedSubjectSrc = displayedLook
    ? cutoutFallbackUrls[displayedLook.heroCutoutUrl]
      ? displayedLook.imageUrl
      : displayedLook.heroCutoutUrl
    : '';

  // Live theme sync with SiteHeader whenever active occasion changes while pinned/in-view
  useEffect(() => {
    const sectionEl = sectionRef.current;
    if (!sectionEl || !activeOcc || typeof window === 'undefined') return;

    const nextTheme = activeOcc.isDark ? 'dark' : 'light';
    sectionEl.setAttribute('data-nav-theme', nextTheme);

    const rect = sectionEl.getBoundingClientRect();
    if (rect.top <= 64 && rect.bottom > 64) {
      window.dispatchEvent(
        new CustomEvent('atelier:nav-theme', { detail: { theme: nextTheme } }),
      );
    }
  }, [activeOcc]);

  // Background pre-decode of current & adjacent occasions (`heroCutoutUrl`, `imageUrl`, `macroImageUrl`)
  useEffect(() => {
    if (typeof window === 'undefined' || normalizedOccasions.length === 0) return;

    const indicesToPreload = [safeOccIdx - 1, safeOccIdx, safeOccIdx + 1].filter(
      (idx) => idx >= 0 && idx < normalizedOccasions.length,
    );

    const warmUrl = (url: string | null | undefined, isCutout = false) => {
      if (
        !url ||
        decodedUrlsRef.current.has(url) ||
        (isCutout && failedCutoutsRef.current.has(url))
      ) {
        return;
      }
      void decodeImageAsset(url).then((ok) => {
        if (ok) {
          decodedUrlsRef.current.add(url);
        } else if (isCutout) {
          failedCutoutsRef.current.add(url);
        }
      });
    };

    for (const idx of indicesToPreload) {
      const sets = normalizedOccasions[idx]?.sets ?? [];
      for (const setItem of sets) {
        warmUrl(setItem.heroCutoutUrl, true);
        warmUrl(setItem.imageUrl);
        warmUrl(setItem.macroImageUrl);
      }
    }
  }, [normalizedOccasions, safeOccIdx]);

  // Pre-decode target `heroCutoutUrl` + `macroImageUrl` before committing visual swap
  useEffect(() => {
    if (typeof window === 'undefined' || !featuredLook) return;
    if (
      renderedIdx.occIdx === safeOccIdx &&
      renderedIdx.setIdx === safeSetIdx
    ) {
      return;
    }

    const seq = ++decodeSeqRef.current;
    let cancelled = false;

    const ensureDecoded = async (
      url: string | null | undefined,
      isCutout = false,
    ): Promise<boolean> => {
      if (!url) return false;
      if (decodedUrlsRef.current.has(url)) return true;
      if (isCutout && failedCutoutsRef.current.has(url)) return false;

      const ok = await withSoftTimeout(decodeImageAsset(url), 350, true);
      if (ok) {
        decodedUrlsRef.current.add(url);
      } else if (isCutout) {
        failedCutoutsRef.current.add(url);
      }
      return ok;
    };

    void (async () => {
      const [cutoutOk] = await Promise.all([
        ensureDecoded(featuredLook.heroCutoutUrl, true),
        ensureDecoded(featuredLook.macroImageUrl),
      ]);

      if (!cutoutOk) {
        await ensureDecoded(featuredLook.imageUrl);
      }

      if (cancelled || seq !== decodeSeqRef.current) return;

      if (!cutoutOk) {
        setCutoutFallbackUrls((prev) =>
          prev[featuredLook.heroCutoutUrl]
            ? prev
            : { ...prev, [featuredLook.heroCutoutUrl]: true },
        );
      }

      setRenderedIdx({ occIdx: safeOccIdx, setIdx: safeSetIdx });
    })();

    return () => {
      cancelled = true;
    };
  }, [featuredLook, renderedIdx.occIdx, renderedIdx.setIdx, safeOccIdx, safeSetIdx]);

  // Pinned desktop ScrollTrigger across all occasions inside useGSAP
  useGSAP(
    () => {
      ensureGsapRegistered();
      scrollTriggerRef.current = null;

      const sectionEl = sectionRef.current;
      if (!sectionEl || normalizedOccasions.length <= 1 || reducedMotion) {
        return;
      }

      const mm = gsap.matchMedia();
      mm.add('(min-width: 1024px)', () => {
        const count = normalizedOccasions.length;
        const st = ScrollTrigger.create({
          trigger: sectionEl,
          start: 'top top',
          end: () =>
            `+=${Math.round(window.innerHeight * Math.max(1, count - 1) * 0.7)}`,
          pin: true,
          anticipatePin: 1,
          invalidateOnRefresh: true,
          onUpdate: (self) => {
            const next = Math.min(
              count - 1,
              Math.floor(self.progress * count * 0.999),
            );
            setActiveIdx((prev) => {
              if (prev === next) return prev;
              setSelectedSetIdx(0);
              return next;
            });
          },
        });
        scrollTriggerRef.current = st;

        return () => {
          scrollTriggerRef.current = null;
        };
      });

      return () => {
        mm.revert();
        scrollTriggerRef.current = null;
      };
    },
    {
      scope: sectionRef,
      dependencies: [normalizedOccasions.length, reducedMotion],
    },
  );

  // Circular radial wipe (#occWipe), expanding SVG rings (#occRingC & #occRingG),
  // Layer 1 aura/gold-wire breath pulse, NFC word shimmer reveal & left copy fade-in
  useGSAP(
    () => {
      ensureGsapRegistered();
      const stageEl = stageRef.current;
      const bgEl = bgRef.current;
      const wipeEl = wipeRef.current;
      const ringC = ringCRef.current;
      const ringG = ringGRef.current;
      const bouquetEl = bouquetRef.current;
      const auraEl = auraRef.current;
      const haloEl = wireHaloRef.current;

      if (!activeOcc || !stageEl || !bgEl) return;

      const isInitial = prevOccIdxRef.current === null;
      const prevIdx = prevOccIdxRef.current;
      prevOccIdxRef.current = safeOccIdx;

      stageEl.style.setProperty('--ink', activeOcc.themeInk);
      stageEl.style.setProperty('--accent', activeOcc.themeAccent);

      if (isInitial || prevIdx === safeOccIdx || reducedMotion) {
        bgEl.style.background = activeOcc.themeBg;
        if (wipeEl) {
          gsap.set(wipeEl, { clipPath: 'circle(0% at 50% 50%)' });
        }
        return;
      }

      // Compute radial origin from central subject stage (defaults to 50% 50%)
      const stageRect = stageEl.getBoundingClientRect();
      let originPct = '50% 50%';
      let cx = stageRect.width * 0.5;
      let cy = stageRect.height * 0.5;
      if (bouquetEl && stageRect.width > 0 && stageRect.height > 0) {
        const bRect = bouquetEl.getBoundingClientRect();
        cx = bRect.left + bRect.width / 2 - stageRect.left;
        cy = bRect.top + bRect.height / 2 - stageRect.top;
        originPct = `${((cx / stageRect.width) * 100).toFixed(1)}% ${((cy / stageRect.height) * 100).toFixed(1)}%`;
      }

      if (ringC && ringG) {
        ringC.setAttribute('cx', String(cx));
        ringC.setAttribute('cy', String(cy));
        ringG.setAttribute('cx', String(cx));
        ringG.setAttribute('cy', String(cy));
      }

      const tl = gsap.timeline();

      // 1. Circular radial wipe #occWipe (circle(0% at 50% 50%) -> circle(150% at 50% 50%))
      if (wipeEl) {
        wipeEl.style.background = activeOcc.themeBg;
        tl.fromTo(
          wipeEl,
          { clipPath: `circle(0% at ${originPct})` },
          {
            clipPath: `circle(150% at ${originPct})`,
            duration: 1.0,
            ease: 'expo.inOut',
          },
          0,
        );
      }

      // 2. Dual golden SVG expanding radial burst (#occRingC 1.5px + #occRingG 14px glow)
      if (ringC && ringG) {
        tl.fromTo(
          [ringC, ringG],
          { attr: { r: 5 }, opacity: 1 },
          {
            attr: { r: Math.max(stageRect.width, stageRect.height) * 1.2 },
            opacity: 0,
            duration: 1.15,
            ease: 'expo.out',
          },
          0,
        );
      }

      // 2b. Subtle breath pulse on Layer 1 atmospheric aura & open-bottom gold wire halo
      const opticalBackdrop = [auraEl, haloEl].filter(Boolean);
      if (opticalBackdrop.length > 0) {
        tl.fromTo(
          opticalBackdrop,
          { scale: 0.95, opacity: 0.45 },
          {
            scale: 1,
            opacity: 1,
            duration: 0.95,
            stagger: 0.06,
            ease: 'power3.out',
          },
          0.1,
        );
      }

      // 3. NFC Vietnamese grapheme reveal for .occ__word
      const wordChars = stageEl.querySelectorAll('.occ__word .ch');
      if (wordChars.length > 0) {
        tl.fromTo(
          wordChars,
          { yPercent: 48, opacity: 0, filter: 'blur(10px)' },
          {
            yPercent: 0,
            opacity: 1,
            filter: 'blur(0px)',
            duration: 0.85,
            stagger: 0.028,
            ease: 'expo.out',
          },
          0.16,
        );
      }

      // 4. Copy fade-in
      tl.fromTo(
        ['#occLine', '#occMeta', '#occPrice'],
        { opacity: 0, y: 14 },
        { opacity: 1, y: 0, duration: 0.6, stagger: 0.06, ease: 'power3.out' },
        0.22,
      );

      if (!cameraActive && stageRect.width > 0) {
        triggerParticleBurst(stageRect.left + cx, stageRect.top + cy, 22);
      }

      tl.add(() => {
        bgEl.style.background = activeOcc.themeBg;
        if (wipeEl) {
          gsap.set(wipeEl, { clipPath: 'circle(0% at 50% 50%)' });
        }
      });
    },
    { scope: sectionRef, dependencies: [safeOccIdx, reducedMotion] },
  );

  // 60fps "Rise From Mist" entrance on every decoded occasion/look switch
  useGSAP(
    () => {
      ensureGsapRegistered();
      if (!renderedTransitionKey) return;

      const isInitial = prevRenderedKeyRef.current === null;
      const unchanged = prevRenderedKeyRef.current === renderedTransitionKey;
      prevRenderedKeyRef.current = renderedTransitionKey;

      const imgEl = imgRef.current;
      if (!imgEl || isInitial || unchanged) return;

      if (reducedMotion) {
        gsap.set(imgEl, {
          opacity: 1,
          y: 0,
          scale: 1,
          filter: 'blur(0px)',
          clearProps: 'filter',
        });
        return;
      }

      gsap.fromTo(
        imgEl,
        {
          opacity: 0,
          y: 28,
          scale: 0.965,
          filter: 'blur(6px)',
        },
        {
          opacity: 1,
          y: 0,
          scale: 1,
          filter: 'blur(0px)',
          duration: 0.72,
          ease: 'power3.out',
          overwrite: 'auto',
          clearProps: 'filter',
        },
      );
    },
    {
      scope: sectionRef,
      dependencies: [renderedTransitionKey, reducedMotion],
    },
  );

  const handleSelectOccasion = useCallback(
    (targetIdx: number) => {
      const count = normalizedOccasions.length;
      if (count === 0) return;
      const clamped = Math.max(0, Math.min(targetIdx, count - 1));
      const st = scrollTriggerRef.current;

      if (st && !reducedMotion && count > 1) {
        const targetScroll =
          st.start + ((clamped + 0.5) / count) * (st.end - st.start);
        if (lenis) {
          lenis.scrollTo(targetScroll, { duration: 0.65 });
        } else {
          window.scrollTo({ top: targetScroll, behavior: 'smooth' });
        }
      } else {
        setActiveIdx(clamped);
        setSelectedSetIdx(0);
      }
    },
    [lenis, normalizedOccasions.length, reducedMotion],
  );

  const handleOpenTryOn = useCallback(() => {
    if (!featuredLook) return;
    openVirtualTryOnModal(buildTryOnOptionsForItem(featuredLook));
  }, [featuredLook]);

  const handleSubjectImgError = useCallback(() => {
    if (!displayedLook) return;
    if (cutoutFallbackUrls[displayedLook.heroCutoutUrl]) return;
    failedCutoutsRef.current.add(displayedLook.heroCutoutUrl);
    setCutoutFallbackUrls((prev) => ({
      ...prev,
      [displayedLook.heroCutoutUrl]: true,
    }));
  }, [cutoutFallbackUrls, displayedLook]);

  if (!activeOcc) {
    return null;
  }

  const stageStyle = {
    '--ink': activeOcc.themeInk,
    '--accent': activeOcc.themeAccent,
    color: 'var(--ink)',
  } as CSSProperties;

  return (
    <section
      ref={sectionRef}
      className="occ relative min-h-[100svh] overflow-hidden"
      id="occasion"
      data-nav-theme={activeOcc.isDark ? 'dark' : 'light'}
    >
      <div
        ref={stageRef}
        className={`occ__stage ${styles.stage}`}
        style={stageStyle}
      >
        {/* Base palette backdrop */}
        <div
          ref={bgRef}
          className={`occ__bg absolute inset-0 ${styles.bgLayer}`}
          id="occBg"
          style={{ background: activeOcc.themeBg }}
          aria-hidden="true"
        />

        {/* Circular radial wipe overlay (#occWipe) */}
        <div
          ref={wipeRef}
          className={`occ__wipe pointer-events-none absolute inset-0 ${styles.wipeLayer}`}
          id="occWipe"
          style={{ clipPath: 'circle(0% at 50% 50%)' }}
          aria-hidden="true"
        />

        {/* Expanding dual golden SVG rings (#occRingG 14px + #occRingC 1.5px) */}
        <svg
          className={`occ__ring pointer-events-none absolute inset-0 h-full w-full overflow-visible ${styles.burstRingLayer}`}
          aria-hidden="true"
        >
          <circle
            ref={ringGRef}
            id="occRingG"
            r={0}
            fill="none"
            stroke="var(--gold-hi, #EBCF8F)"
            strokeWidth={14}
            strokeOpacity={0.22}
            opacity={0}
          />
          <circle
            ref={ringCRef}
            id="occRingC"
            r={0}
            fill="none"
            stroke="var(--gold-hi, #EBCF8F)"
            strokeWidth={1.5}
            opacity={0}
          />
        </svg>

        {/* Region 1: Top-Center Editorial Occasion Heading (.occ__word via NFC-safe SplitShimmerText, z-index: 18) */}
        <div className={styles.headingWrap}>
          <SplitShimmerText
            key={activeOcc.slug}
            text={activeOcc.name}
            as="h2"
            id="occWord"
            className={`occ__word ${styles.heading} ${
              activeOcc.isDark ? 'shimmer' : ''
            }`}
            glint={activeOcc.isDark}
          />
        </div>

        {/* Regions 2–5: Left Copy | Frameless 3-Layer Optical Stage | Right Menu + 4-Card Gallery */}
        <div className={styles.mainGrid}>
          {/* Region 4: Left Copy (.occ__copy) */}
          <div className={`occ__copy ${styles.leftColumn}`}>
            <p className={styles.eyebrow}>
              Chọn trang phục theo dịp · Dress Code
            </p>
            <p className={`occ__line ${styles.tagline}`} id="occLine">
              {activeOcc.tagline}
            </p>
            {featuredLook ? (
              <>
                <p className={`occ__meta ${styles.meta}`} id="occMeta">
                  {featuredLook.name} · {featuredLook.slotLabel}
                </p>
                <div className={`occ__buy ${styles.buyRow}`}>
                  <span className={`occ__price ${styles.price}`} id="occPrice">
                    {FORMAT_VND(featuredLook.priceVnd)}
                  </span>
                  <MagneticButton
                    href={`/san-pham/${featuredLook.slug}`}
                    className={styles.detailPill}
                  >
                    Xem thiết kế này
                  </MagneticButton>
                </div>
              </>
            ) : null}

            <Link
              href={`/bo-suu-tap/${encodeURIComponent(activeOcc.slug)}`}
              className={styles.collectionLink}
            >
              Khám phá bộ sưu tập {activeOcc.name} →
            </Link>
          </div>

          {/* Region 2: 3 Unclipped Optical Layers — Aura + Open-Bottom Gold Wire Halo | Alpha Subject | CircularFabricLens + Pill */}
          <div className={styles.centerColumn}>
            <div
              className={`${styles.subjectStage} ${
                activeOcc.isDark ? styles.subjectStageDark : ''
              }`}
            >
              {/* Layer 1 (z-index: 10): Atmospheric Silk Aura + Open-Bottom Concentric Gold Wire Circle */}
              <div
                ref={auraRef}
                className={`occ__aura ${styles.aura} ${
                  activeOcc.isDark ? styles.auraDark : ''
                }`}
                aria-hidden="true"
              />

              <svg
                ref={wireHaloRef}
                className={`occ__halo ${styles.wireHalo} ${
                  activeOcc.isDark ? styles.wireHaloDark : ''
                }`}
                viewBox="0 0 400 400"
                fill="none"
                aria-hidden="true"
              >
                <circle
                  cx="200"
                  cy="200"
                  r="192"
                  stroke="currentColor"
                  strokeWidth="0.85"
                  strokeOpacity="0.36"
                  vectorEffect="non-scaling-stroke"
                />
                <circle
                  cx="200"
                  cy="200"
                  r="180"
                  stroke="currentColor"
                  strokeWidth="0.55"
                  strokeOpacity="0.16"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>

              {/* Layer 2 (z-index: 24): Enlarged Pure-Alpha Subject Overlapping Title + CSS Mist Dissolve Mask */}
              <div
                ref={bouquetRef}
                id="occBouquet"
                data-testid="occasion-subject-stage"
                className={`occ__bouquet ${styles.subjectFrame}`}
              >
                {displayedLook ? (
                  <Link
                    href={`/san-pham/${displayedLook.slug}`}
                    className={styles.subjectLink}
                    aria-label={`Xem chi tiết ${displayedLook.name}`}
                  >
                    <img
                      ref={imgRef}
                      id="occImg"
                      src={displayedSubjectSrc}
                      alt={`${displayedLook.name} — ${activeOcc.name}`}
                      loading="eager"
                      decoding="async"
                      onError={handleSubjectImgError}
                      className={styles.subjectImg}
                    />
                  </Link>
                ) : null}
              </div>

              {/* Layer 3 (z-index: 30): CircularFabricLens + Gold Hairline Pointer */}
              {displayedLook ? (
                <CircularFabricLens
                  macroImageUrl={displayedLook.macroImageUrl}
                  fallbackImageUrl={displayedLook.imageUrl}
                  alt={`Cận cảnh chất liệu ${displayedLook.name}`}
                  isDark={activeOcc.isDark}
                  transitionKey={renderedTransitionKey}
                  reducedMotion={reducedMotion}
                />
              ) : null}

              {/* Layer 3 (z-index: 30): Floating AI Try-On Frosted Glass Pill */}
              {featuredLook ? (
                <button
                  type="button"
                  data-testid="occasion-tryon-pill"
                  onClick={handleOpenTryOn}
                  className={`${styles.tryOnPill} ${
                    activeOcc.isDark ? styles.tryOnPillDark : ''
                  }`}
                >
                  ✦ THỬ ĐỒ AI
                </button>
              ) : null}
            </div>
          </div>

          {/* Regions 3 & 5: Right 6-Occasion Menu + Rectangular 3:4 4-Card Gallery */}
          <div className={styles.rightColumn}>
            <ul className={`occ__tabs ${styles.tabs}`} id="occTabs">
              {normalizedOccasions.map(({ occ }, idx) => {
                const isSelected = idx === safeOccIdx;
                const badgeLabel = resolveOccasionBadgeTag(occ);
                return (
                  <li key={occ.slug}>
                    <button
                      type="button"
                      onClick={() => handleSelectOccasion(idx)}
                      aria-pressed={isSelected}
                      className={`${styles.tabBtn} ${
                        isSelected ? `on ${styles.tabBtnActive}` : ''
                      }`}
                    >
                      {badgeLabel ? (
                        <em className={styles.tabBadge}>{badgeLabel}</em>
                      ) : null}
                      <span className={styles.tabName}>{occ.name}</span>
                      <span
                        className={styles.tabRule}
                        style={{ width: isSelected ? '44px' : '18px' }}
                        aria-hidden="true"
                      />
                    </button>
                  </li>
                );
              })}
            </ul>

            <OccasionSetThumbnails
              occasionName={activeOcc.name}
              items={lookSets}
              activeIndex={safeSetIdx}
              isDark={activeOcc.isDark}
              onSelect={setSelectedSetIdx}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
