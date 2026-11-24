'use client';

import { useEffect, useRef, useState } from 'react';
import {
  isCameraGpuPaused,
  subscribeCameraGpuGuard,
  useCameraGpuGuard,
  usePrefersReducedMotion,
} from '@atelier/motion-kit';

export function CameraGpuGuardDemo() {
  const [cameraActive, setCameraActive] = useState(false);
  const [bodyDatasetValue, setBodyDatasetValue] = useState<string>('unset');
  const [renderedFrames, setRenderedFrames] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const gpuPaused = useCameraGpuGuard(cameraActive);
  const prefersReducedMotion = usePrefersReducedMotion();

  useEffect(() => {
    const syncDataset = () => {
      const value = document.body.dataset.cameraActive;
      setBodyDatasetValue(value ?? 'unset');
    };

    syncDataset();
    return subscribeCameraGpuGuard(() => {
      syncDataset();
    });
  }, [cameraActive]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let rafId = 0;
    let phase = 0;
    let localTicks = 0;

    const drawShowcaseFrame = () => {
      if (isCameraGpuPaused() || document.body.dataset.cameraActive === 'true') {
        return;
      }

      const width = canvas.width;
      const height = canvas.height;
      phase += prefersReducedMotion ? 0 : 0.02;
      localTicks += 1;

      if (localTicks % 12 === 0) {
        setRenderedFrames((prev) => prev + 12);
      }

      const bgGrad = ctx.createRadialGradient(
        width * 0.5,
        height * 0.2,
        24,
        width * 0.5,
        height * 0.5,
        width * 0.65,
      );
      bgGrad.addColorStop(0, '#3B2B20');
      bgGrad.addColorStop(0.55, '#241913');
      bgGrad.addColorStop(1, '#1C1410');
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, width, height);

      // Brass hanging rail
      const railY = height * 0.2;
      const railGrad = ctx.createLinearGradient(0, railY - 4, 0, railY + 5);
      railGrad.addColorStop(0, '#8A672C');
      railGrad.addColorStop(0.45, '#F3DFAE');
      railGrad.addColorStop(1, '#7D5B24');
      ctx.fillStyle = railGrad;
      ctx.fillRect(width * 0.08, railY, width * 0.84, 7);

      const silhouettes = [
        { x: 0.22, fill: '#EFE7DA', w: 54, h: 112 },
        { x: 0.36, fill: '#EBD9B4', w: 58, h: 126 },
        { x: 0.5, fill: '#FBF7EF', w: 72, h: 148 },
        { x: 0.64, fill: '#C8A776', w: 58, h: 126 },
        { x: 0.78, fill: '#9A7D56', w: 54, h: 112 },
      ];

      silhouettes.forEach((item, index) => {
        const anchorX = width * item.x;
        const sway =
          Math.sin(phase + index * 0.75) * (index === 2 ? 0.065 : 0.045);

        ctx.save();
        ctx.translate(anchorX, railY + 4);
        ctx.rotate(sway);

        ctx.strokeStyle = '#EBCF8F';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, 6, 0, Math.PI * 2);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(0, 6);
        ctx.lineTo(0, 20);
        ctx.moveTo(-item.w * 0.42, 34);
        ctx.lineTo(0, 20);
        ctx.lineTo(item.w * 0.42, 34);
        ctx.stroke();

        ctx.fillStyle = item.fill;
        ctx.globalAlpha = index === 2 ? 0.96 : 0.62;
        ctx.beginPath();
        ctx.moveTo(-item.w * 0.36, 34);
        ctx.lineTo(item.w * 0.36, 34);
        ctx.lineTo(item.w * 0.5, 34 + item.h);
        ctx.lineTo(-item.w * 0.5, 34 + item.h);
        ctx.closePath();
        ctx.fill();

        if (index === 2) {
          ctx.strokeStyle = 'rgba(235, 207, 143, 0.75)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        ctx.restore();
      });

      for (let i = 0; i < 16; i += 1) {
        const px =
          ((width * ((i * 73) % 100)) / 100 + Math.sin(phase * 0.7 + i) * 18) %
          width;
        const py =
          ((height * ((i * 41) % 100)) / 100 +
            Math.cos(phase * 0.5 + i) * 14) %
          height;
        ctx.fillStyle = 'rgba(235, 207, 143, 0.42)';
        ctx.beginPath();
        ctx.arc(px, py, (i % 2) + 1.2, 0, Math.PI * 2);
        ctx.fill();
      }

      if (!prefersReducedMotion) {
        rafId = window.requestAnimationFrame(drawShowcaseFrame);
      }
    };

    if (!gpuPaused) {
      rafId = window.requestAnimationFrame(drawShowcaseFrame);
    }

    return () => {
      if (rafId) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, [gpuPaused, prefersReducedMotion]);

  return (
    <section className="rounded-3xl border border-[#B08A4A]/30 bg-[#1C1410] p-6 text-[#FBF7EF] shadow-2xl lg:p-8">
      <div className="flex flex-col justify-between gap-4 border-b border-[#B08A4A]/20 pb-5 md:flex-row md:items-end">
        <div>
          <p className="atelier-eyebrow text-[#EBCF8F]">
            Khung Giá Treo 3D WebGL · Bảo Vệ Hiệu Năng GPU
          </p>
          <h2 className="font-editorial mt-2 text-3xl font-light text-[#FBF7EF] lg:text-4xl">
            Tự động tạm dừng WebGL khi mở Camera Thử Đồ AI
          </h2>
        </div>

        <button
          type="button"
          onClick={() => setCameraActive((prev) => !prev)}
          className={`rounded-full px-6 py-3 text-xs font-medium uppercase tracking-[0.18em] transition-all ${
            gpuPaused
              ? 'border border-[#EBCF8F] bg-[#EBCF8F] text-[#1C1410]'
              : 'border border-[#EBCF8F]/60 bg-transparent text-[#EBCF8F] hover:bg-[#B08A4A]/25'
          }`}
        >
          {gpuPaused
            ? 'Tắt Camera · Khôi phục 3D WebGL'
            : 'Bật Camera Thử Đồ AI (Pause GPU)'}
        </button>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.45fr_1fr]">
        <div className="relative overflow-hidden rounded-2xl border border-[#EBCF8F]/25 bg-[#160F0C]">
          <canvas
            ref={canvasRef}
            width={720}
            height={360}
            className="h-64 w-full object-cover sm:h-72"
            aria-label="Mô phỏng giá treo đồng thau 3D"
          />

          {gpuPaused ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center bg-[#1C1410]/85 px-6 text-center backdrop-blur-sm">
              <span className="rounded-full border border-[#EBCF8F]/50 bg-[#2A1E17] px-4 py-1.5 text-[11px] uppercase tracking-[0.22em] text-[#EBCF8F]">
                WebGL / Canvas Đang Tạm Dừng
              </span>
              <p className="font-editorial mt-4 text-2xl text-[#FBF7EF]">
                Đã giải phóng luồng render cho Camera &amp; AI Try-On
              </p>
              <p className="mt-2 max-w-md text-xs leading-relaxed text-[#FBF7EF]/75">
                Hook <code className="text-[#EBCF8F]">useCameraGpuGuard</code> đã
                gắn{' '}
                <code className="text-[#EBCF8F]">
                  data-camera-active=&quot;true&quot;
                </code>{' '}
                lên thẻ body để tránh xung đột bộ nhớ GPU trên thiết bị di động.
              </p>
            </div>
          ) : null}
        </div>

        <div className="flex flex-col justify-between rounded-2xl border border-[#B08A4A]/20 bg-[#241A14]/75 p-5">
          <div className="space-y-4">
            <div>
              <p className="text-[11px] uppercase tracking-[0.22em] text-[#EBCF8F]/80">
                Trạng thái DOM Guard
              </p>
              <p className="mt-1 font-mono text-sm text-[#FBF7EF]">
                document.body.dataset.cameraActive ={' '}
                <span
                  className={
                    bodyDatasetValue === 'true'
                      ? 'font-semibold text-[#EBCF8F]'
                      : 'text-[#FBF7EF]/65'
                  }
                >
                  &quot;{bodyDatasetValue}&quot;
                </span>
              </p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-[#B08A4A]/20 bg-[#1C1410] p-3.5">
                <p className="text-[10px] uppercase tracking-[0.2em] text-[#FBF7EF]/60">
                  Vòng lặp WebGL
                </p>
                <p className="mt-1.5 text-sm font-medium text-[#EBCF8F]">
                  {gpuPaused ? 'PAUSED (0 FPS)' : 'RUNNING (60 FPS)'}
                </p>
              </div>
              <div className="rounded-xl border border-[#B08A4A]/20 bg-[#1C1410] p-3.5">
                <p className="text-[10px] uppercase tracking-[0.2em] text-[#FBF7EF]/60">
                  Khung hình đã vẽ
                </p>
                <p className="mt-1.5 font-mono text-sm text-[#FBF7EF]">
                  {renderedFrames} frames
                </p>
              </div>
            </div>
          </div>

          <p className="mt-5 text-xs leading-relaxed text-[#FBF7EF]/70">
            Cơ chế ref-count trong <code>@atelier/motion-kit</code> bảo đảm khi
            khách mở camera tại trang <strong>/thu-do-ai</strong>, toàn bộ
            hiệu ứng nền của giá treo 3D được đóng băng an toàn và khôi phục
            tức thì khi đóng camera.
          </p>
        </div>
      </div>
    </section>
  );
}
