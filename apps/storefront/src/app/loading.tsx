export default function StorefrontLoading() {
  return (
    <div
      className="min-h-[100svh] bg-[#FBF7EF] text-[#2B2019]"
      aria-busy="true"
      aria-label="Đang tải không gian TryVibe Fashion Atelier"
    >
      {/* Hero viewport reservation (100svh -> zero CLS) */}
      <div className="relative flex h-[100svh] min-h-[640px] flex-col justify-end overflow-hidden bg-[#1C1410] px-6 pb-20 sm:px-14">
        <div
          className="pointer-events-none absolute inset-0 opacity-35"
          style={{
            background:
              'radial-gradient(ellipse 46% 52% at 68% 42%, rgba(235, 207, 143, 0.25), transparent 72%)',
          }}
          aria-hidden="true"
        />
        <div className="relative z-10 max-w-2xl space-y-5">
          <div className="h-3 w-48 rounded-full bg-[#F4EBDA]/20" />
          <div className="h-16 w-3/4 rounded-2xl bg-[#F4EBDA]/15 sm:h-24" />
          <div className="h-4 w-full max-w-lg rounded-full bg-[#F4EBDA]/15" />
          <div className="flex items-center gap-4 pt-2">
            <div className="h-11 w-48 rounded-full bg-[#B08A4A]/35" />
            <div className="h-3 w-40 rounded-full bg-[#F4EBDA]/15" />
          </div>
        </div>
      </div>

      {/* Warm --cream (#F4EBDA) editorial product grid skeleton (aspect-[3/4]) */}
      <div className="mx-auto max-w-7xl px-6 py-16 lg:px-10">
        <div className="mb-8 flex items-end justify-between gap-4">
          <div className="space-y-3">
            <div className="atelier-skeleton h-3 w-40 rounded-full" />
            <div className="atelier-skeleton h-10 w-72 rounded-xl" />
          </div>
          <div className="atelier-skeleton hidden h-9 w-36 rounded-full sm:block" />
        </div>

        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, idx) => (
            <div
              key={`loading-card-${idx}`}
              className="rounded-3xl border border-[#B08A4A]/20 bg-[#FBF7EF] p-3.5"
            >
              <div className="atelier-skeleton aspect-[3/4] w-full rounded-2xl" />
              <div className="mt-4 space-y-2.5 px-1">
                <div className="atelier-skeleton h-2.5 w-20 rounded-full" />
                <div className="atelier-skeleton h-6 w-4/5 rounded-lg" />
                <div className="atelier-skeleton h-3 w-2/3 rounded-full" />
                <div className="flex items-center justify-between pt-2">
                  <div className="flex gap-1.5">
                    <span className="atelier-skeleton h-3.5 w-3.5 rounded-full" />
                    <span className="atelier-skeleton h-3.5 w-3.5 rounded-full" />
                  </div>
                  <div className="atelier-skeleton h-5 w-24 rounded-md" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
