export default function PlatformLoading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Carregando">
      <div className="h-8 w-48 animate-pulse rounded-md bg-surface-2" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="h-24 animate-pulse rounded-lg border border-line bg-surface"
          />
        ))}
      </div>
      <div className="h-56 animate-pulse rounded-lg border border-line bg-surface" />
    </div>
  );
}
