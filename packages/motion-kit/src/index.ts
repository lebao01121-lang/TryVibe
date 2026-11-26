'use client';

export {
  ensureMotionWatchers,
  applyCameraActiveState,
  getMotionState,
  getServerMotionState,
  subscribeMotionStore,
  useMotionState,
  acquireScrollLock,
  resetScrollLocks,
  useScrollLock,
  setIntroActive,
  setAutoTourActive,
  setParticleRainActive,
  triggerParticleBurst,
  subscribeParticleBurst,
  type MotionState,
  type ParticleBurstEvent,
  type MotionStoreListener,
  type ParticleBurstListener,
} from './motion-store.js';

export {
  CAMERA_GPU_GUARD_EVENT,
  isCameraGpuPaused,
  acquireCameraGpuGuard,
  subscribeCameraGpuGuard,
  useCameraGpuGuard,
  useCameraGpuPaused,
  type CameraGpuGuardEventDetail,
  type CameraGpuGuardSubscriber,
} from './camera-gpu-guard.js';

export { usePrefersReducedMotion } from './reduced-motion.js';

export {
  disposeObject3D,
  type DisposableResource,
  type DisposableMaterial,
  type DisposableObject3D,
  type DisposeObject3DResult,
} from './dispose-three.js';

export {
  LiveMotionProvider,
  useLiveMotion,
  useViewportAnimationPause,
  LiveMotionTogglePill,
  type LiveMotionContextValue,
  type LiveMotionProviderProps,
  type LiveMotionTogglePillProps,
} from './telemetry/LiveMotionProvider.js';

export {
  AnimatedTelemetryNumber,
  type TelemetryNumberFormat,
  type AnimatedTelemetryNumberProps,
} from './telemetry/AnimatedTelemetryNumber.js';

export {
  LiveKpiSparkCard,
  type KpiSparkBarsConfig,
  type KpiLaserCurveConfig,
  type KpiRadialGaugeLegend,
  type KpiRadialGaugeConfig,
  type KpiDualStreamBarItem,
  type LiveKpiSparkCardProps,
} from './telemetry/LiveKpiSparkCard.js';

export {
  LiveComboAreaBarChart,
  type LiveComboChartPoint,
  type LiveComboTimeframeOption,
  type LiveComboAreaBarChartProps,
} from './telemetry/LiveComboAreaBarChart.js';

export {
  LiveDonutBreakdownChart,
  type LiveDonutSegment,
  type LiveDonutBreakdownChartProps,
} from './telemetry/LiveDonutBreakdownChart.js';

export {
  LiveEcgIcon,
  LiveStackedHealthBar,
  LiveServiceClusterStrip,
  type LiveEcgIconProps,
  type HealthSegmentTone,
  type LiveStackedHealthSegment,
  type LiveStackedHealthBarProps,
  type LiveServiceNode,
  type LiveServiceClusterStripProps,
} from './telemetry/LiveStackedHealthBar.js';

export {
  LiveStreamProgressBar,
  LiveFunnelStageBar,
  type StreamBarTone,
  type LiveStreamProgressBarProps,
  type LiveFunnelStageItem,
  type LiveFunnelStageBarProps,
} from './telemetry/LiveStreamProgressBar.js';
