'use client';

import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

let registered = false;

export function ensureGsapRegistered(): void {
  if (registered || typeof window === 'undefined') {
    return;
  }
  gsap.registerPlugin(ScrollTrigger, useGSAP);
  ScrollTrigger.config({ ignoreMobileResize: true });
  registered = true;
}

if (typeof window !== 'undefined') {
  ensureGsapRegistered();
}

export { gsap, ScrollTrigger, useGSAP };
